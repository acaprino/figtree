// Anvil Sidecar — bridges Rust backend with @anthropic-ai/claude-agent-sdk
// Protocol: JSON-lines over stdin (commands) / stdout (events) / stderr (logs)

import { query, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { join } from "path";

// Active sessions: tabId → { query, abortController, inputQueue, inputResolve, pendingAskUser }
const sessions = new Map();

// Timeout constants (ms)
const PERMISSION_TIMEOUT_MS = 300_000; // 5 minutes
const ASK_USER_TIMEOUT_MS = 600_000;   // 10 minutes — multi-step wizard needs more time

// ── Batched emit ─────────────────────────────────────────────────
// High-frequency streaming chunks (assistant text_delta, thinking_delta) are
// coalesced per-tab over a ~16 ms window and flushed as a single JSON-line,
// drastically reducing serialisation + I/O overhead during streaming.

const BATCH_INTERVAL_MS = 8; // half-frame — keeps IPC low while reducing perceived latency

// Per-tab accumulators: tabId → { text: string, thinking: string }
const _batchBuf = new Map();
let _batchTimer = null;

/** Write buffered text/thinking for a single tab to stdout. */
function _writeBuf(tabId, buf) {
  if (buf.text) {
    process.stdout.write(JSON.stringify({ evt: "assistant", tabId, text: buf.text, streaming: true }) + "\n");
  }
  if (buf.thinking) {
    process.stdout.write(JSON.stringify({ evt: "thinking", tabId, text: buf.thinking }) + "\n");
  }
}

function _flushBatch() {
  _batchTimer = null;
  for (const [tabId, buf] of _batchBuf) {
    _writeBuf(tabId, buf);
  }
  _batchBuf.clear();
}

/** Queue a streaming text chunk for batched emission. */
function emitStreamingText(tabId, text) {
  let buf = _batchBuf.get(tabId);
  if (!buf) { buf = { text: "", thinking: "" }; _batchBuf.set(tabId, buf); }
  buf.text += text;
  if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_INTERVAL_MS);
}

/** Queue a thinking delta for batched emission. */
function emitThinkingDelta(tabId, text) {
  let buf = _batchBuf.get(tabId);
  if (!buf) { buf = { text: "", thinking: "" }; _batchBuf.set(tabId, buf); }
  buf.thinking += text;
  if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_INTERVAL_MS);
}

/** Flush any pending batched chunks for a tab (call before non-streaming events). */
function flushTab(tabId) {
  const buf = _batchBuf.get(tabId);
  if (buf) {
    _writeBuf(tabId, buf);
    _batchBuf.delete(tabId);
  }
}

// Emit a JSON-line event to stdout (non-batched, for control/structural events)
function emit(evt) {
  // Flush any pending batch for this tab before emitting a structural event,
  // so ordering is preserved.
  if (evt.tabId) flushTab(evt.tabId);
  process.stdout.write(JSON.stringify(evt) + "\n");
}

function log(...args) {
  process.stderr.write(`[sidecar] ${args.join(" ")}\n`);
}

// ── Constants ───────────────────────────────────────────────────────

const VALID_PERM_MODES = new Set(["plan", "acceptEdits", "bypassPermissions"]);
const ACCEPT_EDITS_TOOLS = new Set(["Write", "Edit", "Read", "Glob", "Grep"]);

// ── Command handlers ────────────────────────────────────────────────

async function handleCreate(cmd) {
  const { tabId, cwd, model, effort, systemPrompt, permMode, skipPerms, allowedTools, plugins } = cmd;

  if (sessions.has(tabId)) {
    // Kill existing session (React 18 StrictMode sends create→create→kill)
    log(`Replacing existing session for tab ${tabId}`);
    handleKill({ tabId }, true); // Silent — don't emit exit (would remove Channel)
  }

  const abortController = new AbortController();

  // Streaming input mode: we create an async iterable that yields user messages
  // on demand. When the SDK needs input (emits result), the frontend sends a
  // "send" command which resolves the pending promise in the queue.
  let inputResolve = null;
  const inputQueue = [];

  async function* inputStream() {
    while (true) {
      // Wait for next user message
      const text = await new Promise((resolve) => {
        if (inputQueue.length > 0) {
          resolve(inputQueue.shift());
        } else {
          inputResolve = resolve;
        }
      });
      if (text === null) return; // Sentinel: session killed
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      };
    }
  }

  // Build options
  const options = {
    abortController,
    cwd: cwd || process.cwd(),
    model: model || undefined,
    effort: effort || "high",
    includePartialMessages: true,
    settingSources: ["user", "project", "local"],
    agentProgressSummaries: true,
  };

  if (systemPrompt) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    };
  }

  // Resolve permission mode from the new permMode string or legacy skipPerms boolean
  // Stored as mutable object so it can be updated mid-session via set_perm_mode command
  const rawPermMode = permMode || (skipPerms ? "bypassPermissions" : null);
  const permState = { mode: rawPermMode && VALID_PERM_MODES.has(rawPermMode) ? rawPermMode : null };

  if (permState.mode === "bypassPermissions") {
    options.permissionMode = "bypassPermissions";
    options.allowDangerouslySkipPermissions = true;
  } else if (permState.mode) {
    options.permissionMode = permState.mode;
  }
  // else: no explicit permissionMode — SDK uses its default

  // Always register canUseTool to route permission decisions through Anvil UI.
  // For bypassPermissions, auto-allow everything without prompting.
  // For acceptEdits, auto-allow file-editing tools and prompt for the rest.
  // For plan/default, prompt for everything.
  options.canUseTool = async (toolName, input, opts) => {
    try {
      // Bypass mode: auto-allow everything
      // updatedInput is required by the SDK's internal Zod schema — omitting it causes ZodError
      // which silently denies ALL tools (the SDK catches the error and treats it as deny)
      if (permState.mode === "bypassPermissions") {
        return { behavior: "allow", updatedInput: {} };
      }

      // AcceptEdits mode: auto-allow file-editing tools
      if (permState.mode === "acceptEdits" && ACCEPT_EDITS_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: {} };
      }

      let description;
      try {
        description = toolName === "Bash"
          ? (input.command || "").slice(0, 200)
          : toolName === "Edit" || toolName === "Write" || toolName === "Read"
            ? (input.file_path || "")
            : JSON.stringify(input).slice(0, 200);
      } catch {
        description = "(unserializable input)";
      }

      emit({
        evt: "permission",
        tabId,
        tool: toolName,
        description: String(description),
        toolUseId: opts.toolUseID,
        permissionSuggestions: opts.suggestions || [],
      });

      // Wait for permission response from frontend (timeout after 5 minutes)
      const result = await new Promise((resolve) => {
        const session = sessions.get(tabId);
        if (!session) {
          resolve({ behavior: "deny", message: "Session not found" });
          return;
        }
        const timeout = setTimeout(() => {
          if (session.pendingPermission?.toolUseId === opts.toolUseID) {
            session.pendingPermission = null;
            resolve({ behavior: "deny", message: "Permission request timed out" });
          }
        }, PERMISSION_TIMEOUT_MS);
        session.pendingPermission = {
          resolve: (val) => { clearTimeout(timeout); resolve(val); },
          toolUseId: opts.toolUseID,
        };
      });
      return result;
    } catch (err) {
      log(`canUseTool error for ${toolName}:`, err.message);
      emit({ evt: "error", tabId, code: "permission_error", message: err.message });
      // Fail closed: errors in the permission gate must deny, not allow
      return { behavior: "deny", message: `Internal error: ${err.message}` };
    }
  };

  if (allowedTools) {
    options.allowedTools = allowedTools;
  }

  if (plugins && plugins.length > 0) {
    options.plugins = plugins.map(p => ({ type: 'local', path: p }));
  }

  // Intercept AskUserQuestion tool to route to Anvil UI
  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [
      ...(options.hooks?.PreToolUse || []),
      {
        matcher: /^AskUserQuestion$/,
        hooks: [async (event) => {
          const session = sessions.get(tabId);
          if (!session) return { behavior: "deny", message: "Session not found" };

          // Extract questions from the tool input
          const questions = event.input?.questions;
          if (!Array.isArray(questions) || questions.length === 0) {
            return { behavior: "deny", message: "No questions provided" };
          }

          // Emit ask_user event to frontend
          emit({
            evt: "ask_user",
            tabId,
            questions: questions.map(q => ({
              question: q.question || "",
              header: q.header || "",
              options: (q.options || []).map(o => ({
                label: o.label || "",
                description: o.description || "",
                preview: o.preview || undefined,
              })),
              multiSelect: !!q.multiSelect,
            })),
          });

          // Wait for user response from frontend (timeout 10 minutes — longer than
          // permission's 5 min because multi-step wizard takes more time)
          const askId = Date.now() + Math.random();
          const result = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              if (session.pendingAskUser?.askId === askId) {
                session.pendingAskUser = null;
                resolve({ behavior: "deny", message: "AskUserQuestion timed out — no user response" });
              }
            }, ASK_USER_TIMEOUT_MS);
            session.pendingAskUser = {
              resolve: (val) => { clearTimeout(timeout); resolve(val); },
              questions,
              askId,
            };
          });
          return result;
        }],
      },
    ],
  };

  // Resume or fork if specified
  if (cmd.sessionId) {
    if (cmd.fork) {
      options.resume = cmd.sessionId;
      options.forkSession = true;
    } else {
      options.resume = cmd.sessionId;
    }
  }

  const session = {
    abortController,
    inputQueue,
    pendingPermission: null,
    pendingAskUser: null,
    permState,
  };

  // Start the query
  const q = query({
    prompt: inputStream(),
    options,
  });
  session.query = q;
  sessions.set(tabId, session);

  // Save config for interrupt-resume
  session._config = { cwd: cwd || process.cwd(), model, effort, systemPrompt, permMode, skipPerms, allowedTools, plugins };
  session._sessionId = "";
  session._interrupted = false;

  session._pushInput = (text) => {
    if (inputResolve) {
      const r = inputResolve;
      inputResolve = null;
      r(text);
    } else {
      inputQueue.push(text);
    }
  };

  // Consume the async generator and emit events
  consumeQuery(tabId, q, session).catch((err) => {
    // Skip if this session was interrupted (handleInterrupt manages lifecycle)
    if (session._interrupted) return;
    // Only report if we're still the active session
    if (sessions.get(tabId) === session) {
      log(`Error in session ${tabId}:`, err.message);
      emit({ evt: "error", tabId, code: "query_error", message: err.message });
      emit({ evt: "exit", tabId, code: 1 });
      sessions.delete(tabId);
    }
  });

  emit({ evt: "status", tabId, status: "started", model: model || "default" });
  // SDK waits for first user message via the input stream — signal the frontend
  emit({ evt: "input_required", tabId });
}

async function consumeQuery(tabId, q, sessionRef) {
  // Track whether we've streamed text for the current turn — if so, skip
  // re-emitting the complete assistant message (which would duplicate it).
  let hasStreamedText = false;

  try {
    for await (const msg of q) {
      const session = sessions.get(tabId);
      if (!session || session !== sessionRef) break; // Different session replaced us

      switch (msg.type) {
        case "assistant": {
          // BetaMessage has content blocks — but if we already streamed them
          // via stream_event deltas, skip text blocks to avoid duplication.
          const content = msg.message?.content || [];
          for (const block of content) {
            if (block.type === "text") {
              if (!hasStreamedText) {
                emit({ evt: "assistant", tabId, text: block.text, streaming: false });
              }
            } else if (block.type === "tool_use") {
              emit({
                evt: "tool_use",
                tabId,
                tool: block.name,
                input: block.input,
                toolUseId: block.id,
              });
              // Intercept TodoWrite to forward structured todo events
              if (block.name === "TodoWrite") {
                try {
                  const todoInput = typeof block.input === "string" ? JSON.parse(block.input) : block.input;
                  if (todoInput.todos) {
                    const mapped = todoInput.todos.map((t, i) => ({
                      id: `todo-${i}`,
                      title: t.content || t.title || "",
                      status: t.status,
                      category: t.activeForm || t.category || undefined,
                    }));
                    emit({ evt: "todo", tabId, todos: mapped });
                  }
                } catch (err) { log("DEBUG: TodoWrite parse error:", err.message); }
              }
            } else if (block.type === "thinking") {
              if (!hasStreamedText) {
                emit({ evt: "thinking", tabId, text: block.thinking || "" });
              }
            }
          }
          // Reset streaming flag after complete message
          hasStreamedText = false;
          // Check for errors
          if (msg.error) {
            emit({ evt: "error", tabId, code: msg.error, message: msg.error_message || msg.error });
          }
          break;
        }

        case "stream_event": {
          // Partial streaming events
          const event = msg.event;
          if (event?.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
              hasStreamedText = true;
              emitStreamingText(tabId, delta.text);
            } else if (delta?.type === "thinking_delta") {
              hasStreamedText = true;
              emitThinkingDelta(tabId, delta.thinking || "");
            }
          }
          break;
        }

        case "user": {
          // User message replay (during resume) — skip or emit as context
          break;
        }

        case "result": {
          // Extract usage safely — SDK may nest under .usage or use top-level fields
          const usage = msg.usage || {};
          const safeNum = (v) => (typeof v === "number" && !Number.isNaN(v)) ? v : 0;
          // Extract context window from modelUsage (Record<string, ModelUsage>)
          const modelUsage = msg.modelUsage || {};
          const firstModel = Object.values(modelUsage)[0];
          const contextWindow = safeNum(firstModel?.contextWindow);
          emit({
            evt: "result",
            tabId,
            cost: safeNum(msg.total_cost_usd),
            inputTokens: safeNum(usage.input_tokens),
            outputTokens: safeNum(usage.output_tokens),
            cacheReadTokens: safeNum(usage.cache_read_input_tokens),
            cacheWriteTokens: safeNum(usage.cache_creation_input_tokens),
            turns: safeNum(msg.num_turns),
            durationMs: safeNum(msg.duration_ms),
            isError: msg.is_error || false,
            sessionId: msg.session_id || "",
            contextWindow,
          });
          // After result, SDK waits for next input
          emit({ evt: "input_required", tabId });
          break;
        }

        case "system": {
          if (msg.subtype === "init") {
            const sid = msg.session_id || msg.data?.session_id || "";
            if (sid) {
              session._sessionId = sid;
              emit({ evt: "status", tabId, status: "init", model: "", sessionId: sid });
            }
            // Fetch available commands and agents from the SDK
            try {
              const [commands, agents] = await Promise.all([
                q.supportedCommands(),
                q.supportedAgents(),
              ]);
              emit({ evt: "commands_init", tabId, commands, agents });
            } catch (err) {
              log(`Failed to fetch commands/agents for ${tabId}:`, err.message);
            }
          } else if (msg.subtype === "status") {
            emit({ evt: "status", tabId, status: msg.status || "idle", model: "" });
          } else if (msg.subtype === "task_started") {
            emit({
              evt: "task_started",
              tabId,
              taskId: msg.task_id,
              description: msg.description || "",
              taskType: msg.task_type || "",
            });
          } else if (msg.subtype === "task_progress") {
            const usage = msg.usage || {};
            emit({
              evt: "task_progress",
              tabId,
              taskId: msg.task_id,
              description: msg.description || "",
              totalTokens: usage.total_tokens || 0,
              toolUses: usage.tool_uses || 0,
              durationMs: usage.duration_ms || 0,
              lastToolName: msg.last_tool_name || "",
              summary: msg.summary || "",
            });
          } else if (msg.subtype === "task_notification") {
            const usage = msg.usage || {};
            emit({
              evt: "task_notification",
              tabId,
              taskId: msg.task_id,
              status: msg.status || "completed",
              summary: msg.summary || "",
              totalTokens: usage.total_tokens || 0,
              toolUses: usage.tool_uses || 0,
              durationMs: usage.duration_ms || 0,
            });
          }
          break;
        }

        case "tool_progress": {
          emit({
            evt: "progress",
            tabId,
            message: `${msg.tool_name}: ${msg.elapsed_time_seconds}s`,
            tool: msg.tool_name,
          });
          break;
        }

        case "tool_use_summary": {
          emit({
            evt: "tool_result",
            tabId,
            tool: "summary",
            output: msg.summary,
            success: true,
          });
          break;
        }

        case "rate_limit_event": {
          const info = msg.rate_limit_info;
          if (info.status === "rejected") {
            emit({
              evt: "error",
              tabId,
              code: "rate_limit",
              message: `Rate limited. Resets at ${info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown"}`,
            });
          } else {
            emit({
              evt: "rateLimit",
              tabId,
              utilization: info.utilization || 0,
            });
          }
          break;
        }

        default:
          // Log unhandled message types for debugging
          log(`Unhandled message type: ${msg.type}`);
          break;
      }
    }
  } finally {
    // Query finished — only clean up if WE are still the active session.
    // A replacement session (from StrictMode re-mount) may have taken over.
    // Skip cleanup if this session was interrupted (handleInterrupt manages lifecycle)
    if (sessionRef._interrupted) return;
    const current = sessions.get(tabId);
    if (current && current === sessionRef) {
      sessions.delete(tabId);
      emit({ evt: "exit", tabId, code: 0 });
    }
  }
}

function handleSend(cmd) {
  const session = sessions.get(cmd.tabId);
  if (!session) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  session._pushInput(cmd.text);
}

function handleKill(cmd, silent = false) {
  const session = sessions.get(cmd.tabId);
  if (!session) return;

  // Flush any batched streaming data before tearing down
  flushTab(cmd.tabId);

  // Signal kill to input stream
  session._pushInput(null);
  session.abortController.abort();

  // Resolve any pending permission
  if (session.pendingPermission) {
    session.pendingPermission.resolve({ behavior: "deny", message: "Session killed" });
    session.pendingPermission = null;
  }
  // Resolve any pending AskUserQuestion
  if (session.pendingAskUser) {
    session.pendingAskUser.resolve({ behavior: "deny", message: "Session killed" });
    session.pendingAskUser = null;
  }

  session.query?.close();
  sessions.delete(cmd.tabId);
  autocompleteTimestamps.delete(cmd.tabId);
  // Silent mode: don't emit exit (used when replacing a session in handleCreate,
  // because the exit event would cause Rust to remove the Channel).
  if (!silent) emit({ evt: "exit", tabId: cmd.tabId, code: -1 });
}

function handlePermissionResponse(cmd) {
  const session = sessions.get(cmd.tabId);
  if (!session?.pendingPermission) {
    log(`No pending permission for tab ${cmd.tabId}`);
    return;
  }

  const { resolve } = session.pendingPermission;
  session.pendingPermission = null;

  if (cmd.allow) {
    // updatedInput is required by the SDK's internal Zod schema — omitting it causes ZodError
    const result = { behavior: "allow", updatedInput: {} };
    if (Array.isArray(cmd.updatedPermissions) && cmd.updatedPermissions.length > 0) {
      result.updatedPermissions = cmd.updatedPermissions;
    }
    resolve(result);
  } else {
    resolve({ behavior: "deny", message: "Denied by user" });
  }
}

function handleAskUserResponse(cmd) {
  const session = sessions.get(cmd.tabId);
  if (!session?.pendingAskUser) {
    log(`No pending AskUserQuestion for tab ${cmd.tabId}`);
    return;
  }

  const { resolve, questions } = session.pendingAskUser;
  session.pendingAskUser = null;

  const answers = cmd.answers || {};

  // Format the answers as a human-readable summary for Claude
  const answerLines = questions.map((q, i) => {
    const answer = (answers[String(i)] || "(no answer)").replace(/[\r\n]/g, " ");
    const header = (q.header || "").replace(/[\r\n]/g, " ");
    return `${header}: ${answer}`;
  });

  // Deny the tool (prevents SDK from trying TUI rendering) and inject a system message
  // with the user's answers so Claude sees them as if the tool succeeded.
  resolve({
    behavior: "deny",
    message: `User answered the questions via Anvil UI:\n${answerLines.join("\n")}`,
  });
}

// Guard against re-entrant interrupts (rapid Ctrl+C)
const _interruptingTabs = new Set();

async function handleInterrupt(cmd) {
  const tabId = cmd.tabId;
  if (_interruptingTabs.has(tabId)) return;

  const session = sessions.get(tabId);
  if (!session) {
    log(`No session to interrupt for tab ${tabId}`);
    return;
  }

  _interruptingTabs.add(tabId);
  try {
    const sessionId = session._sessionId || "";
    const config = session._config || {};

    // Mark session as interrupted so consumeQuery won't emit spurious exit
    session._interrupted = true;

    // Flush any pending batched streaming data
    flushTab(tabId);

    // Abort the current query
    session._pushInput(null);
    session.abortController.abort();

    // Resolve any pending permission or askUser
    if (session.pendingPermission) {
      session.pendingPermission.resolve({ behavior: "deny", message: "Interrupted" });
      session.pendingPermission = null;
    }
    if (session.pendingAskUser) {
      session.pendingAskUser.resolve({ behavior: "deny", message: "Interrupted" });
      session.pendingAskUser = null;
    }

    session.query?.close();
    sessions.delete(tabId);
    autocompleteTimestamps.delete(tabId);

    emit({ evt: "interrupted", tabId, sessionId });

    // Resume same session with validated config
    if (sessionId) {
      const safePerm = VALID_PERM_MODES.has(config.permMode) ? config.permMode : "plan";
      await handleCreate({ tabId, sessionId, ...config, permMode: safePerm });
    }
  } finally {
    _interruptingTabs.delete(tabId);
  }
}

async function handleSetModel(cmd) {
  const session = sessions.get(cmd.tabId);
  if (!session?.query) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  try {
    await session.query.setModel(cmd.model);
    emit({ evt: "status", tabId: cmd.tabId, status: "model_changed", model: cmd.model });
  } catch (err) {
    emit({ evt: "error", tabId: cmd.tabId, code: "set_model_error", message: err.message });
  }
}

function handleSetPermMode(cmd) {
  const session = sessions.get(cmd.tabId);
  if (!session?.permState) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  const newMode = VALID_PERM_MODES.has(cmd.permMode) ? cmd.permMode : "plan";
  session.permState.mode = newMode;
  if (session._config) session._config.permMode = newMode;
  emit({ evt: "status", tabId: cmd.tabId, status: "perm_mode_changed", permMode: newMode });
}

async function handleRefreshCommands(cmd) {
  const sessionTabId = cmd.sessionTabId;
  const session = sessions.get(sessionTabId);
  if (!session?.query) {
    emit({ evt: "commands", tabId: cmd.tabId, commands: [], agents: [] });
    return;
  }
  try {
    const [commands, agents] = await Promise.all([
      session.query.supportedCommands(),
      session.query.supportedAgents(),
    ]);
    emit({ evt: "commands", tabId: cmd.tabId, commands, agents });
  } catch (err) {
    log(`refreshCommands error for ${sessionTabId}:`, err.message);
    emit({ evt: "commands", tabId: cmd.tabId, commands: [], agents: [] });
  }
}

async function handleListSessions(cmd) {
  try {
    const options = {};
    if (cmd.cwd) options.dir = cmd.cwd;
    if (cmd.limit) options.limit = cmd.limit;
    if (cmd.offset) options.offset = cmd.offset;

    const sessions = await listSessions(options);
    emit({
      evt: "sessions",
      tabId: cmd.tabId,
      list: sessions.map((s) => ({
        id: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        cwd: s.cwd || "",
        firstPrompt: s.firstPrompt || "",
        gitBranch: s.gitBranch || "",
        createdAt: s.createdAt || s.lastModified,
        customTitle: s.customTitle || "",
        fileSize: s.fileSize || 0,
      })),
    });
  } catch (err) {
    emit({ evt: "error", tabId: cmd.tabId, code: "list_error", message: err.message });
  }
}

async function handleGetMessages(cmd) {
  try {
    const options = {};
    if (cmd.dir) options.dir = cmd.dir;
    if (cmd.limit) options.limit = cmd.limit;
    if (cmd.offset) options.offset = cmd.offset;

    const messages = await getSessionMessages(cmd.sessionId, options);
    emit({
      evt: "messages",
      tabId: cmd.tabId,
      sessionId: cmd.sessionId,
      messages: messages.map((m) => ({
        type: m.type,
        uuid: m.uuid,
        message: m.message,
      })),
    });
  } catch (err) {
    emit({ evt: "error", tabId: cmd.tabId, code: "messages_error", message: err.message });
  }
}

// ── Autocomplete handler ────────────────────────────────────────────

const AUTOCOMPLETE_MODEL = "claude-haiku-4-5-20251001";
const AUTOCOMPLETE_TIMEOUT_MS = 5000;

let anthropicClient = null;
let anthropicClientExpiresAt = 0; // 0 = no expiry (API key), else ms timestamp

/** Read OAuth access token from Claude's credentials file. */
function readClaudeOAuthToken() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const credPath = join(home, ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken && oauth.expiresAt > Date.now()) {
      return { token: oauth.accessToken, expiresAt: oauth.expiresAt };
    }
  } catch (err) {
    log("DEBUG: OAuth credentials read failed:", err.message);
  }
  return null;
}

function getAnthropicClient() {
  // If cached and not expired, return it
  if (anthropicClient && (anthropicClientExpiresAt === 0 || anthropicClientExpiresAt > Date.now())) {
    return anthropicClient;
  }

  // Reset expired client
  anthropicClient = null;
  anthropicClientExpiresAt = 0;

  // Try env var first (never expires)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    anthropicClient = new Anthropic({ apiKey });
    return anthropicClient;
  }

  // Try Claude OAuth token
  const oauth = readClaudeOAuthToken();
  if (oauth) {
    anthropicClient = new Anthropic({ authToken: oauth.token });
    anthropicClientExpiresAt = oauth.expiresAt;
    return anthropicClient;
  }

  return null;
}

// Rate limiting: max 10 calls per minute per session
const autocompleteTimestamps = new Map(); // tabId → timestamp[]

function isRateLimited(tabId) {
  const now = Date.now();
  const timestamps = autocompleteTimestamps.get(tabId) || [];
  // Remove timestamps older than 60s
  const recent = timestamps.filter((t) => now - t < 60000);
  autocompleteTimestamps.set(tabId, recent);
  return recent.length >= 10;
}

function recordAutocompleteCall(tabId) {
  const timestamps = autocompleteTimestamps.get(tabId) || [];
  timestamps.push(Date.now());
  autocompleteTimestamps.set(tabId, timestamps);
}

async function handleAutocomplete(cmd) {
  const { tabId, input, context, seq } = cmd;

  // Check rate limit
  if (isRateLimited(tabId)) {
    emit({ evt: "autocomplete", tabId, suggestions: [], seq });
    return;
  }

  recordAutocompleteCall(tabId);

  try {
    const client = getAnthropicClient();
    if (!client) {
      emit({ evt: "autocomplete", tabId, suggestions: [], seq });
      return;
    }

    const messages = [];
    // Add conversation context (last 2-3 messages)
    if (Array.isArray(context)) {
      for (const msg of context.slice(-3)) {
        messages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: String(msg.content).slice(0, 500),
        });
      }
    }
    // Add the partial input as the final user message
    messages.push({
      role: "user",
      content: `Complete this partial input: "${input}"`,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTOCOMPLETE_TIMEOUT_MS);
    const response = await client.messages.create({
      model: AUTOCOMPLETE_MODEL,
      max_tokens: 150,
      system: "You are an autocomplete engine for a coding assistant. Given the user's partial input and recent conversation context, suggest 3 short completions of what they might be typing. Each completion is the text that comes AFTER what they already typed. Be concise.",
      messages,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              completions: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["completions"],
            additionalProperties: false,
          },
        },
      },
    }, { signal: controller.signal });
    clearTimeout(timer);

    // Parse the structured output
    const text = response.content.find(b => b.type === "text")?.text || "{}";
    let suggestions;
    try {
      const parsed = JSON.parse(text);
      suggestions = Array.isArray(parsed.completions) ? parsed.completions.filter(s => typeof s === "string").slice(0, 3) : [];
    } catch (err) {
      log("DEBUG: autocomplete JSON parse failed:", err.message);
      suggestions = [];
    }

    emit({ evt: "autocomplete", tabId, suggestions, seq });
  } catch (err) {
    log(`Autocomplete error for ${tabId}:`, err.message);
    emit({ evt: "autocomplete", tabId, suggestions: [], seq });
  }
}

// ── Main loop: read JSON-lines from stdin ───────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (err) {
    log("Invalid JSON:", line, "error:", err.message);
    return;
  }

  try {
    switch (cmd.cmd) {
      case "create":
        await handleCreate(cmd);
        break;
      case "send":
        handleSend(cmd);
        break;
      case "resume":
        await handleCreate(cmd);
        break;
      case "fork":
        cmd.fork = true;
        await handleCreate(cmd);
        break;
      case "interrupt":
        await handleInterrupt(cmd);
        break;
      case "kill":
        handleKill(cmd);
        break;
      case "permission_response":
        handlePermissionResponse(cmd);
        break;
      case "ask_user_response":
        handleAskUserResponse(cmd);
        break;
      case "set_model":
        await handleSetModel(cmd);
        break;
      case "set_perm_mode":
        handleSetPermMode(cmd);
        break;
      case "list_sessions":
        await handleListSessions(cmd);
        break;
      case "get_messages":
        await handleGetMessages(cmd);
        break;
      case "autocomplete":
        await handleAutocomplete(cmd);
        break;
      case "refreshCommands":
        await handleRefreshCommands(cmd);
        break;
      default:
        log("Unknown command:", cmd.cmd);
        break;
    }
  } catch (err) {
    log(`Error handling ${cmd.cmd}:`, err.message);
    if (cmd.tabId) {
      emit({ evt: "error", tabId: cmd.tabId, code: "handler_error", message: err.message });
    }
  }
});

rl.on("close", () => {
  log("stdin closed, shutting down");
  // Flush any pending batched streaming data
  if (_batchTimer) { clearTimeout(_batchTimer); _batchTimer = null; }
  _flushBatch();
  // Kill all active sessions
  for (const [tabId, session] of sessions) {
    session._pushInput(null);
    session.abortController.abort();
    session.query?.close();
  }
  sessions.clear();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("Uncaught exception:", err.message, err.stack);
});

process.on("unhandledRejection", (err) => {
  log("Unhandled rejection:", err);
});

log("Anvil sidecar started");
emit({ evt: "ready", tabId: "_control" });
