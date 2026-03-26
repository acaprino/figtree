// Figtree Sidecar — bridges Rust backend with @anthropic-ai/claude-agent-sdk
// Protocol: JSON-lines over stdin (commands) / stdout (events) / stderr (logs)

import {
  query,
  listSessions,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
  AgentInfo,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  HookCallbackMatcher,
  HookJSONOutput,
  HookInput,
  ModelUsage,
  NonNullableUsage,
  SDKRateLimitInfo,
  ListSessionsOptions,
  GetSessionMessagesOptions,
} from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { join } from "path";

// ── Type definitions ────────────────────────────────────────────────

/** Permission mode values accepted by Figtree */
type FigtreePermMode = "plan" | "acceptEdits" | "bypassPermissions";

/** Stored per-session config for interrupt-resume */
interface SessionConfig {
  cwd: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permMode?: string;
  skipPerms?: boolean;
  allowedTools?: string[];
  plugins?: string[];
}

/** Per-session state stored in the sessions Map */
interface Session {
  query?: Query;
  abortController: AbortController;
  inputQueue: (string | null)[];
  pendingPermissions: Map<string, PendingPermission>;
  pendingAskUser: PendingAskUser | null;
  permState: { mode: FigtreePermMode | null };
  _config: SessionConfig;
  _sessionId: string;
  _interrupted: boolean;
  _pushInput: (text: string | null) => void;
}

/** Pending permission callback stored per toolUseId */
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  toolUseId: string;
}

/** Pending AskUserQuestion callback */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void;
  questions: AskUserQuestion[];
  askId: string;
}

/** A question from the AskUserQuestion tool */
interface AskUserQuestion {
  question?: string;
  header?: string;
  options?: { label?: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

/** Per-tab streaming accumulator for batched emit */
interface BatchBuffer {
  text: string;
  thinking: string;
}

/** OAuth token from Claude credentials file */
interface OAuthCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

/** OAuth token result */
interface OAuthToken {
  token: string;
  expiresAt: number;
}

// ── Incoming commands (discriminated union on `cmd`) ────────────────

interface CreateCommand {
  cmd: "create";
  tabId: string;
  cwd?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permMode?: string;
  skipPerms?: boolean;
  allowedTools?: string[];
  plugins?: string[];
  sessionId?: string;
  fork?: boolean;
}

interface SendCommand {
  cmd: "send";
  tabId: string;
  text: string;
}

interface ResumeCommand {
  cmd: "resume";
  tabId: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permMode?: string;
  skipPerms?: boolean;
  allowedTools?: string[];
  plugins?: string[];
}

interface ForkCommand {
  cmd: "fork";
  tabId: string;
  sessionId: string;
  fork?: boolean;
  cwd?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permMode?: string;
  skipPerms?: boolean;
  allowedTools?: string[];
  plugins?: string[];
}

interface InterruptCommand {
  cmd: "interrupt";
  tabId: string;
}

interface KillCommand {
  cmd: "kill";
  tabId: string;
}

interface PermissionResponseCommand {
  cmd: "permission_response";
  tabId: string;
  toolUseId?: string;
  allow: boolean;
  updatedPermissions?: PermissionUpdate[];
}

interface AskUserResponseCommand {
  cmd: "ask_user_response";
  tabId: string;
  answers?: Record<string, string>;
}

interface SetModelCommand {
  cmd: "set_model";
  tabId: string;
  model: string;
}

interface SetPermModeCommand {
  cmd: "set_perm_mode";
  tabId: string;
  permMode: string;
}

interface ListSessionsCommand {
  cmd: "list_sessions";
  tabId: string;
  cwd?: string;
  limit?: number;
  offset?: number;
}

interface GetMessagesCommand {
  cmd: "get_messages";
  tabId: string;
  sessionId: string;
  dir?: string;
  limit?: number;
  offset?: number;
}

interface AutocompleteCommand {
  cmd: "autocomplete";
  tabId: string;
  input: string;
  context?: { role: string; content: string }[];
  seq: number;
}

interface RefreshCommandsCommand {
  cmd: "refreshCommands";
  tabId: string;
  sessionTabId: string;
}

type SidecarCommand =
  | CreateCommand
  | SendCommand
  | ResumeCommand
  | ForkCommand
  | InterruptCommand
  | KillCommand
  | PermissionResponseCommand
  | AskUserResponseCommand
  | SetModelCommand
  | SetPermModeCommand
  | ListSessionsCommand
  | GetMessagesCommand
  | AutocompleteCommand
  | RefreshCommandsCommand;

// ── Outgoing events (discriminated union on `evt`) ──────────────────

interface AssistantEvent {
  evt: "assistant";
  tabId: string;
  text: string;
  streaming: boolean;
}

interface ThinkingEvent {
  evt: "thinking";
  tabId: string;
  text: string;
}

interface ToolUseEvent {
  evt: "tool_use";
  tabId: string;
  tool: string;
  input: unknown;
  toolUseId: string;
}

interface ToolResultEvent {
  evt: "tool_result";
  tabId: string;
  tool: string;
  output: string;
  success: boolean;
}

interface PermissionEvent {
  evt: "permission";
  tabId: string;
  tool: string;
  description: string;
  toolUseId: string;
  permissionSuggestions: PermissionUpdate[];
}

interface AskUserEvent {
  evt: "ask_user";
  tabId: string;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string; preview?: string }[];
    multiSelect: boolean;
  }[];
}

interface ResultEvent {
  evt: "result";
  tabId: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
  isError: boolean;
  sessionId: string;
  contextWindow: number;
}

interface ErrorEvent {
  evt: "error";
  tabId: string;
  code: string;
  message: string;
}

interface StatusEvent {
  evt: "status";
  tabId: string;
  status: string;
  model?: string;
  sessionId?: string;
  permMode?: string;
}

interface InputRequiredEvent {
  evt: "input_required";
  tabId: string;
}

interface ExitEvent {
  evt: "exit";
  tabId: string;
  code: number;
}

interface InterruptedEvent {
  evt: "interrupted";
  tabId: string;
  sessionId: string;
}

interface ProgressEvent {
  evt: "progress";
  tabId: string;
  message: string;
  tool: string;
}

interface RateLimitDisplayEvent {
  evt: "rateLimit";
  tabId: string;
  utilization: number;
}

interface ReadyEvent {
  evt: "ready";
  tabId: string;
}

interface TodoEvent {
  evt: "todo";
  tabId: string;
  todos: { id: string; title: string; status: string; category?: string }[];
}

interface TaskStartedEvent {
  evt: "task_started";
  tabId: string;
  taskId: string;
  description: string;
  taskType: string;
}

interface TaskProgressEvent {
  evt: "task_progress";
  tabId: string;
  taskId: string;
  description: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName: string;
  summary: string;
}

interface TaskNotificationEvent {
  evt: "task_notification";
  tabId: string;
  taskId: string;
  status: string;
  summary: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

interface CommandsInitEvent {
  evt: "commands_init";
  tabId: string;
  commands: SlashCommand[];
  agents: AgentInfo[];
}

interface CommandsEvent {
  evt: "commands";
  tabId: string;
  commands: SlashCommand[];
  agents: AgentInfo[];
}

interface SessionsEvent {
  evt: "sessions";
  tabId: string;
  list: {
    id: string;
    summary: string;
    lastModified: number;
    cwd: string;
    firstPrompt: string;
    gitBranch: string;
    createdAt: number;
    customTitle: string;
    fileSize: number;
  }[];
}

interface MessagesEvent {
  evt: "messages";
  tabId: string;
  sessionId: string;
  messages: { type: string; uuid: string; message: unknown }[];
}

interface AutocompleteEvent {
  evt: "autocomplete";
  tabId: string;
  suggestions: string[];
  seq: number;
}

type SidecarEvent =
  | AssistantEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionEvent
  | AskUserEvent
  | ResultEvent
  | ErrorEvent
  | StatusEvent
  | InputRequiredEvent
  | ExitEvent
  | InterruptedEvent
  | ProgressEvent
  | RateLimitDisplayEvent
  | ReadyEvent
  | TodoEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | CommandsInitEvent
  | CommandsEvent
  | SessionsEvent
  | MessagesEvent
  | AutocompleteEvent;

// ── Active sessions ─────────────────────────────────────────────────

// Active sessions: tabId → Session
const sessions = new Map<string, Session>();

// Timeout constants (ms)
const PERMISSION_TIMEOUT_MS = 300_000; // 5 minutes
const ASK_USER_TIMEOUT_MS = 600_000;   // 10 minutes — multi-step wizard needs more time

// ── Batched emit ─────────────────────────────────────────────────
// High-frequency streaming chunks (assistant text_delta, thinking_delta) are
// coalesced per-tab over a ~16 ms window and flushed as a single JSON-line,
// drastically reducing serialisation + I/O overhead during streaming.

const BATCH_INTERVAL_MS = 8; // half-frame — keeps IPC low while reducing perceived latency

// Per-tab accumulators: tabId → BatchBuffer
const _batchBuf = new Map<string, BatchBuffer>();
let _batchTimer: ReturnType<typeof setTimeout> | null = null;

/** Write buffered text/thinking for a single tab to stdout. */
function _writeBuf(tabId: string, buf: BatchBuffer): void {
  if (buf.text) {
    process.stdout.write(JSON.stringify({ evt: "assistant", tabId, text: buf.text, streaming: true }) + "\n");
  }
  if (buf.thinking) {
    process.stdout.write(JSON.stringify({ evt: "thinking", tabId, text: buf.thinking }) + "\n");
  }
}

function _flushBatch(): void {
  _batchTimer = null;
  for (const [tabId, buf] of _batchBuf) {
    _writeBuf(tabId, buf);
  }
  _batchBuf.clear();
}

/** Queue a streaming text chunk for batched emission. */
function emitStreamingText(tabId: string, text: string): void {
  let buf = _batchBuf.get(tabId);
  if (!buf) { buf = { text: "", thinking: "" }; _batchBuf.set(tabId, buf); }
  buf.text += text;
  if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_INTERVAL_MS);
}

/** Queue a thinking delta for batched emission. */
function emitThinkingDelta(tabId: string, text: string): void {
  let buf = _batchBuf.get(tabId);
  if (!buf) { buf = { text: "", thinking: "" }; _batchBuf.set(tabId, buf); }
  buf.thinking += text;
  if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_INTERVAL_MS);
}

/** Flush any pending batched chunks for a tab (call before non-streaming events). */
function flushTab(tabId: string): void {
  const buf = _batchBuf.get(tabId);
  if (buf) {
    _writeBuf(tabId, buf);
    _batchBuf.delete(tabId);
  }
}

// Emit a JSON-line event to stdout (non-batched, for control/structural events)
function emit(evt: SidecarEvent): void {
  // Flush any pending batch for this tab before emitting a structural event,
  // so ordering is preserved.
  if (evt.tabId) flushTab(evt.tabId);
  process.stdout.write(JSON.stringify(evt) + "\n");
}

function log(...args: unknown[]): void {
  process.stderr.write(`[sidecar] ${args.join(" ")}\n`);
}

// ── Constants ───────────────────────────────────────────────────────

let _askIdCounter = 0;
const VALID_PERM_MODES = new Set<FigtreePermMode>(["plan", "acceptEdits", "bypassPermissions"]);
const ACCEPT_EDITS_TOOLS = new Set<string>(["Write", "Edit", "Read", "Glob", "Grep"]);

// ── Command handlers ────────────────────────────────────────────────

async function handleCreate(cmd: CreateCommand | ResumeCommand | ForkCommand): Promise<void> {
  const { tabId, cwd, model, effort, systemPrompt, permMode, skipPerms, allowedTools, plugins } = cmd;

  if (sessions.has(tabId)) {
    // Kill existing session (React 18 StrictMode sends create→create→kill)
    log(`Replacing existing session for tab ${tabId}`);
    handleKill({ cmd: "kill", tabId }, true); // Silent — don't emit exit (would remove Channel)
  }

  const abortController = new AbortController();

  // Streaming input mode: we create an async iterable that yields user messages
  // on demand. When the SDK needs input (emits result), the frontend sends a
  // "send" command which resolves the pending promise in the queue.
  let inputResolve: ((text: string | null) => void) | null = null;
  const inputQueue: (string | null)[] = [];

  async function* inputStream(): AsyncGenerator<SDKUserMessage, void, unknown> {
    while (true) {
      // Wait for next user message
      const text: string | null = await new Promise<string | null>((resolve) => {
        if (inputQueue.length > 0) {
          resolve(inputQueue.shift()!);
        } else {
          inputResolve = resolve;
        }
      });
      if (text === null) return; // Sentinel: session killed
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    }
  }

  // Build options
  const options: Options = {
    abortController,
    cwd: cwd || process.cwd(),
    model: model || undefined,
    effort: (effort as Options["effort"]) || "high",
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
  const permState: { mode: FigtreePermMode | null } = {
    mode: rawPermMode && VALID_PERM_MODES.has(rawPermMode as FigtreePermMode) ? rawPermMode as FigtreePermMode : null,
  };

  if (permState.mode === "bypassPermissions") {
    options.permissionMode = "bypassPermissions";
    options.allowDangerouslySkipPermissions = true;
  } else if (permState.mode) {
    options.permissionMode = permState.mode as PermissionMode;
  }
  // else: no explicit permissionMode — SDK uses its default

  // Always register canUseTool to route permission decisions through Figtree UI.
  // For bypassPermissions, auto-allow everything without prompting.
  // For acceptEdits, auto-allow file-editing tools and prompt for the rest.
  // For plan/default, prompt for everything.
  const canUseTool: CanUseTool = async (toolName, input, opts) => {
    try {
      log(`canUseTool: tool=${toolName} mode=${permState.mode} toolUseId=${opts.toolUseID}`);
      // Bypass mode: auto-allow everything
      // updatedInput is required by the SDK's internal Zod schema — omitting it causes ZodError
      // which silently denies ALL tools (the SDK catches the error and treats it as deny)
      if (permState.mode === "bypassPermissions") {
        log(`canUseTool: auto-allow (bypass) tool=${toolName}`);
        return { behavior: "allow", updatedInput: {} };
      }

      // AcceptEdits mode: auto-allow file-editing tools
      if (permState.mode === "acceptEdits" && ACCEPT_EDITS_TOOLS.has(toolName)) {
        log(`canUseTool: auto-allow (acceptEdits) tool=${toolName}`);
        return { behavior: "allow", updatedInput: {} };
      }

      let description: string;
      try {
        description = toolName === "Bash"
          ? ((input as Record<string, unknown>).command as string || "").slice(0, 200)
          : toolName === "Edit" || toolName === "Write" || toolName === "Read"
            ? ((input as Record<string, unknown>).file_path as string || "")
            : JSON.stringify(input).slice(0, 200);
      } catch (err) {
        log("DEBUG: JSON.stringify failed for tool input:", (err as Error).message);
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
      log(`canUseTool: waiting for user permission tool=${toolName} toolUseId=${opts.toolUseID}`);
      const result: PermissionResult = await new Promise<PermissionResult>((resolve) => {
        const session = sessions.get(tabId);
        if (!session) {
          resolve({ behavior: "deny", message: "Session not found" });
          return;
        }
        const timeout = setTimeout(() => {
          if (session.pendingPermissions?.has(opts.toolUseID)) {
            session.pendingPermissions.delete(opts.toolUseID);
            resolve({ behavior: "deny", message: "Permission request timed out" });
          }
        }, PERMISSION_TIMEOUT_MS);
        if (!session.pendingPermissions) session.pendingPermissions = new Map();
        session.pendingPermissions.set(opts.toolUseID, {
          resolve: (val: PermissionResult) => { clearTimeout(timeout); resolve(val); },
          toolUseId: opts.toolUseID,
        });
      });
      log(`canUseTool: result tool=${toolName} behavior=${result.behavior}`);
      return result;
    } catch (err) {
      const error = err as Error & { issues?: unknown; errors?: unknown };
      log(`canUseTool error for ${toolName}: ${error.message}\n${error.stack}`);
      if (error.name === "ZodError" || error.message?.includes("Zod")) {
        log(`canUseTool ZodError details: ${JSON.stringify(error.issues || error.errors || error, null, 2)}`);
      }
      emit({ evt: "error", tabId, code: "permission_error", message: `Permission check failed for ${toolName}` });
      // Fail closed: errors in the permission gate must deny, not allow
      return { behavior: "deny", message: `Internal error: ${error.message}` };
    }
  };
  options.canUseTool = canUseTool;

  if (allowedTools) {
    options.allowedTools = allowedTools;
  }

  if (plugins && plugins.length > 0) {
    options.plugins = plugins.map(p => ({ type: 'local' as const, path: p }));
  }

  // Intercept AskUserQuestion tool to route to Figtree UI
  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [
      ...(options.hooks?.PreToolUse || []),
      {
        matcher: /^AskUserQuestion$/ as unknown as string,
        hooks: [async (event: HookInput): Promise<HookJSONOutput> => {
          const session = sessions.get(tabId);
          if (!session) return { decision: "block", reason: "Session not found" };

          // Extract questions from the tool input
          const toolInput = (event as { tool_input?: { questions?: AskUserQuestion[] } }).tool_input;
          const questions = toolInput?.questions;
          if (!Array.isArray(questions) || questions.length === 0) {
            return { decision: "block", reason: "No questions provided" };
          }

          // Emit ask_user event to frontend
          emit({
            evt: "ask_user",
            tabId,
            questions: questions.map((q: AskUserQuestion) => ({
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
          const askId = `ask-${Date.now()}-${++_askIdCounter}`;
          const result: PermissionResult = await new Promise<PermissionResult>((resolve) => {
            const timeout = setTimeout(() => {
              if (session.pendingAskUser?.askId === askId) {
                session.pendingAskUser = null;
                resolve({ behavior: "deny", message: "AskUserQuestion timed out — no user response" });
              }
            }, ASK_USER_TIMEOUT_MS);
            session.pendingAskUser = {
              resolve: (val: PermissionResult) => { clearTimeout(timeout); resolve(val); },
              questions,
              askId,
            };
          });
          // Map PermissionResult to HookJSONOutput
          if (result.behavior === "allow") {
            return { decision: "approve" };
          }
          return { decision: "block", reason: result.behavior === "deny" ? result.message : "Denied" };
        }],
      } as HookCallbackMatcher,
    ],
  };

  // Resume or fork if specified
  if (cmd.sessionId) {
    if ("fork" in cmd && cmd.fork) {
      options.resume = cmd.sessionId;
      options.forkSession = true;
    } else {
      options.resume = cmd.sessionId;
    }
  }

  const session: Session = {
    abortController,
    inputQueue,
    pendingPermissions: new Map(),
    pendingAskUser: null,
    permState,
    _config: { cwd: cwd || process.cwd(), model, effort, systemPrompt, permMode, skipPerms, allowedTools, plugins },
    _sessionId: "",
    _interrupted: false,
    _pushInput: () => {}, // placeholder, set below
  };

  // Start the query
  const q = query({
    prompt: inputStream(),
    options,
  });
  session.query = q;
  sessions.set(tabId, session);

  session._pushInput = (text: string | null) => {
    if (inputResolve) {
      const r = inputResolve;
      inputResolve = null;
      r(text);
    } else {
      inputQueue.push(text);
    }
  };

  // Consume the async generator and emit events
  consumeQuery(tabId, q, session).catch((err: unknown) => {
    const error = err as Error & { issues?: unknown; errors?: unknown };
    // Skip if this session was interrupted (handleInterrupt manages lifecycle)
    if (session._interrupted) return;
    // Only report if we're still the active session
    if (sessions.get(tabId) === session) {
      log(`Error in session ${tabId}: ${error.message}\n${error.stack}`);
      if (error.name === "ZodError" || error.message?.includes("Zod")) {
        log(`Session ZodError details: ${JSON.stringify(error.issues || error.errors || error, null, 2)}`);
      }
      emit({ evt: "error", tabId, code: "query_error", message: error.message });
      emit({ evt: "exit", tabId, code: 1 });
      sessions.delete(tabId);
    }
  });

  emit({ evt: "status", tabId, status: "started", model: model || "default" });
  // SDK waits for first user message via the input stream — signal the frontend
  emit({ evt: "input_required", tabId });
}

async function consumeQuery(tabId: string, q: Query, sessionRef: Session): Promise<void> {
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
                  const todoInput = typeof block.input === "string" ? JSON.parse(block.input) : block.input as Record<string, unknown>;
                  if (todoInput.todos) {
                    const todos = todoInput.todos as { content?: string; title?: string; status: string; activeForm?: string; category?: string }[];
                    const mapped = todos.map((t, i) => ({
                      id: `todo-${i}`,
                      title: t.content || t.title || "",
                      status: t.status,
                      category: t.activeForm || t.category || undefined,
                    }));
                    emit({ evt: "todo", tabId, todos: mapped });
                  }
                } catch (err) { log("DEBUG: TodoWrite parse error:", (err as Error).message); }
              }
            } else if (block.type === "thinking") {
              if (!hasStreamedText) {
                emit({ evt: "thinking", tabId, text: block.thinking || "" });
              }
            }
          }
          // Reset streaming flag after complete message
          hasStreamedText = false;
          // Check for errors (skip rate_limit — already handled by rate_limit_event)
          if (msg.error && msg.error !== "rate_limit") {
            const FRIENDLY: Record<string, string> = {
              authentication_failed: "Authentication failed",
              billing_error: "Billing error",
              invalid_request: "Invalid request",
              server_error: "Server error",
              max_output_tokens: "Max output tokens reached",
            };
            emit({ evt: "error", tabId, code: msg.error, message: FRIENDLY[msg.error] || msg.error });
          }
          break;
        }

        case "stream_event": {
          // Partial streaming events
          const event = msg.event;
          if (event?.type === "content_block_delta") {
            const delta = (event as { delta?: { type?: string; text?: string; thinking?: string } }).delta;
            if (delta?.type === "text_delta") {
              hasStreamedText = true;
              emitStreamingText(tabId, delta.text || "");
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
          const usage = msg.usage || {} as Partial<NonNullableUsage>;
          const safeNum = (v: unknown): number => (typeof v === "number" && !Number.isNaN(v)) ? v : 0;
          // Extract context window from modelUsage (Record<string, ModelUsage>)
          const modelUsage: Record<string, ModelUsage> = msg.modelUsage || {};
          const firstModel: ModelUsage | undefined = Object.values(modelUsage)[0];
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
            const initMsg = msg as SDKMessage & { type: "system"; subtype: "init"; session_id?: string; data?: { session_id?: string } };
            const sid = initMsg.session_id || initMsg.data?.session_id || "";
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
              log(`Failed to fetch commands/agents for ${tabId}:`, (err as Error).message);
            }
          } else if (msg.subtype === "status") {
            const statusMsg = msg as SDKMessage & { type: "system"; subtype: "status"; status?: string };
            emit({ evt: "status", tabId, status: statusMsg.status || "idle", model: "" });
          } else if (msg.subtype === "task_started") {
            const taskMsg = msg as SDKMessage & { type: "system"; subtype: "task_started"; task_id: string; description?: string; task_type?: string };
            emit({
              evt: "task_started",
              tabId,
              taskId: taskMsg.task_id,
              description: taskMsg.description || "",
              taskType: taskMsg.task_type || "",
            });
          } else if (msg.subtype === "task_progress") {
            const taskMsg = msg as SDKMessage & { type: "system"; subtype: "task_progress"; task_id: string; description?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }; last_tool_name?: string; summary?: string };
            const usage = taskMsg.usage || {};
            emit({
              evt: "task_progress",
              tabId,
              taskId: taskMsg.task_id,
              description: taskMsg.description || "",
              totalTokens: usage.total_tokens || 0,
              toolUses: usage.tool_uses || 0,
              durationMs: usage.duration_ms || 0,
              lastToolName: taskMsg.last_tool_name || "",
              summary: taskMsg.summary || "",
            });
          } else if (msg.subtype === "task_notification") {
            const taskMsg = msg as SDKMessage & { type: "system"; subtype: "task_notification"; task_id: string; status?: string; summary?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } };
            const usage = taskMsg.usage || { total_tokens: 0, tool_uses: 0, duration_ms: 0 };
            emit({
              evt: "task_notification",
              tabId,
              taskId: taskMsg.task_id,
              status: taskMsg.status || "completed",
              summary: taskMsg.summary || "",
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
          const info: SDKRateLimitInfo | undefined = msg.rate_limit_info;
          if (!info) break;
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
          log(`Unhandled message type: ${(msg as SDKMessage).type}`);
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
      autocompleteTimestamps.delete(tabId);
      emit({ evt: "exit", tabId, code: 0 });
    }
  }
}

function handleSend(cmd: SendCommand): void {
  const session = sessions.get(cmd.tabId);
  if (!session) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  session._pushInput(cmd.text);
}

function handleKill(cmd: KillCommand, silent: boolean = false): void {
  const session = sessions.get(cmd.tabId);
  if (!session) return;

  // Flush any batched streaming data before tearing down
  flushTab(cmd.tabId);

  // Signal kill to input stream
  session._pushInput(null);
  session.abortController.abort();

  // Resolve all pending permissions
  if (session.pendingPermissions?.size > 0) {
    for (const [, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Session killed" });
    }
    session.pendingPermissions.clear();
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

function handlePermissionResponse(cmd: PermissionResponseCommand): void {
  const session = sessions.get(cmd.tabId);
  if (!session?.pendingPermissions || session.pendingPermissions.size === 0) {
    log(`No pending permission for tab ${cmd.tabId}`);
    return;
  }

  // Require toolUseId to prevent approving the wrong tool
  if (!cmd.toolUseId) {
    log(`Permission response missing toolUseId for tab ${cmd.tabId} -- rejecting`);
    return;
  }

  const pending = session.pendingPermissions.get(cmd.toolUseId);
  if (!pending) {
    log(`Permission response toolUseId not found: ${cmd.toolUseId} (pending: ${[...session.pendingPermissions.keys()].join(", ")})`);
    return;
  }

  session.pendingPermissions.delete(cmd.toolUseId);
  const { resolve } = pending;

  if (cmd.allow) {
    // updatedInput is required by the SDK's internal Zod schema — omitting it causes ZodError
    const result: PermissionResult = { behavior: "allow", updatedInput: {} };
    if (Array.isArray(cmd.updatedPermissions) && cmd.updatedPermissions.length > 0) {
      result.updatedPermissions = cmd.updatedPermissions;
    }
    resolve(result);
  } else {
    resolve({ behavior: "deny", message: "Denied by user" });
  }
}

function handleAskUserResponse(cmd: AskUserResponseCommand): void {
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
    message: `User answered the questions via Figtree UI:\n${answerLines.join("\n")}`,
  });
}

// Guard against re-entrant interrupts (rapid Ctrl+C)
const _interruptingTabs = new Set<string>();

async function handleInterrupt(cmd: InterruptCommand): Promise<void> {
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
    const config = session._config;

    // Mark session as interrupted so consumeQuery won't emit spurious exit
    session._interrupted = true;

    // Flush any pending batched streaming data
    flushTab(tabId);

    // Abort the current query
    session._pushInput(null);
    session.abortController.abort();

    // Resolve all pending permissions or askUser
    if (session.pendingPermissions?.size > 0) {
      for (const [, pending] of session.pendingPermissions) {
        pending.resolve({ behavior: "deny", message: "Interrupted" });
      }
      session.pendingPermissions.clear();
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
      const safePerm = VALID_PERM_MODES.has(config.permMode as FigtreePermMode) ? config.permMode : "plan";
      await handleCreate({ cmd: "create", tabId, sessionId, ...config, permMode: safePerm });
    }
  } finally {
    _interruptingTabs.delete(tabId);
  }
}

async function handleSetModel(cmd: SetModelCommand): Promise<void> {
  const session = sessions.get(cmd.tabId);
  if (!session?.query) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  if (typeof cmd.model !== "string" || !/^[a-zA-Z0-9._\-[\]]{1,100}$/.test(cmd.model)) {
    emit({ evt: "error", tabId: cmd.tabId, code: "set_model_error", message: "Invalid model identifier" });
    return;
  }
  try {
    await session.query.setModel(cmd.model);
    emit({ evt: "status", tabId: cmd.tabId, status: "model_changed", model: cmd.model });
  } catch (err) {
    emit({ evt: "error", tabId: cmd.tabId, code: "set_model_error", message: (err as Error).message });
  }
}

function handleSetPermMode(cmd: SetPermModeCommand): void {
  const session = sessions.get(cmd.tabId);
  if (!session?.permState) {
    emit({ evt: "error", tabId: cmd.tabId, code: "not_found", message: "Session not found" });
    return;
  }
  const newMode: FigtreePermMode = VALID_PERM_MODES.has(cmd.permMode as FigtreePermMode) ? cmd.permMode as FigtreePermMode : "plan";
  session.permState.mode = newMode;
  if (session._config) session._config.permMode = newMode;
  emit({ evt: "status", tabId: cmd.tabId, status: "perm_mode_changed", permMode: newMode });
}

async function handleRefreshCommands(cmd: RefreshCommandsCommand): Promise<void> {
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
    log(`refreshCommands error for ${sessionTabId}:`, (err as Error).message);
    emit({ evt: "commands", tabId: cmd.tabId, commands: [], agents: [] });
  }
}

async function handleListSessions(cmd: ListSessionsCommand): Promise<void> {
  try {
    const options: ListSessionsOptions = {};
    if (cmd.cwd) options.dir = cmd.cwd;
    if (cmd.limit) options.limit = cmd.limit;
    if (cmd.offset) options.offset = cmd.offset;

    const sessionList: SDKSessionInfo[] = await listSessions(options);
    emit({
      evt: "sessions",
      tabId: cmd.tabId,
      list: sessionList.map((s) => ({
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
    emit({ evt: "error", tabId: cmd.tabId, code: "list_error", message: (err as Error).message });
  }
}

async function handleGetMessages(cmd: GetMessagesCommand): Promise<void> {
  try {
    const options: GetSessionMessagesOptions = {};
    if (cmd.dir) options.dir = cmd.dir;
    if (cmd.limit) options.limit = cmd.limit;
    if (cmd.offset) options.offset = cmd.offset;

    const messages: SessionMessage[] = await getSessionMessages(cmd.sessionId, options);
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
    emit({ evt: "error", tabId: cmd.tabId, code: "messages_error", message: (err as Error).message });
  }
}

// ── Autocomplete handler ────────────────────────────────────────────

const AUTOCOMPLETE_MODEL = "claude-haiku-4-5-20251001";
const AUTOCOMPLETE_TIMEOUT_MS = 5000;

let anthropicClient: Anthropic | null = null;
let anthropicClientExpiresAt = 0; // 0 = no expiry (API key), else ms timestamp

/** Read OAuth access token from Claude's credentials file. */
function readClaudeOAuthToken(): OAuthToken | null {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const credPath = join(home, ".claude", ".credentials.json");
    const creds: OAuthCredentials = JSON.parse(readFileSync(credPath, "utf-8"));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken && oauth.expiresAt && oauth.expiresAt > Date.now()) {
      return { token: oauth.accessToken, expiresAt: oauth.expiresAt };
    }
  } catch (err) {
    log("DEBUG: OAuth credentials read failed:", (err as Error).message);
  }
  return null;
}

function getAnthropicClient(): Anthropic | null {
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
const autocompleteTimestamps = new Map<string, number[]>(); // tabId → timestamp[]

function isRateLimited(tabId: string): boolean {
  const now = Date.now();
  const timestamps = autocompleteTimestamps.get(tabId) || [];
  // Remove timestamps older than 60s
  const recent = timestamps.filter((t) => now - t < 60000);
  autocompleteTimestamps.set(tabId, recent);
  return recent.length >= 10;
}

function recordAutocompleteCall(tabId: string): void {
  const timestamps = autocompleteTimestamps.get(tabId) || [];
  timestamps.push(Date.now());
  autocompleteTimestamps.set(tabId, timestamps);
}

async function handleAutocomplete(cmd: AutocompleteCommand): Promise<void> {
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

    const messages: { role: "user" | "assistant"; content: string }[] = [];
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
    // output_config is a newer API feature; cast to bypass SDK type lag
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
    } as Parameters<typeof client.messages.create>[0], { signal: controller.signal });
    clearTimeout(timer);

    // Parse the structured output
    const responseMsg = response as Anthropic.Message;
    const text = responseMsg.content.find(b => b.type === "text")?.text || "{}";
    let suggestions: string[];
    try {
      const parsed = JSON.parse(text) as { completions?: unknown };
      suggestions = Array.isArray(parsed.completions) ? (parsed.completions as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3) : [];
    } catch (err) {
      log("DEBUG: autocomplete JSON parse failed:", (err as Error).message);
      suggestions = [];
    }

    emit({ evt: "autocomplete", tabId, suggestions, seq });
  } catch (err) {
    log(`Autocomplete error for ${tabId}:`, (err as Error).message);
    emit({ evt: "autocomplete", tabId, suggestions: [], seq });
  }
}

// ── Main loop: read JSON-lines from stdin ───────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line: string) => {
  let cmd: SidecarCommand;
  try {
    cmd = JSON.parse(line) as SidecarCommand;
  } catch (err) {
    log("Invalid JSON:", line, "error:", (err as Error).message);
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
        (cmd as ForkCommand).fork = true;
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
        log("Unknown command:", (cmd as { cmd: string }).cmd);
        break;
    }
  } catch (err) {
    log(`Error handling ${cmd.cmd}:`, (err as Error).message);
    if ("tabId" in cmd && cmd.tabId) {
      emit({ evt: "error", tabId: cmd.tabId, code: "handler_error", message: (err as Error).message });
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

process.on("uncaughtException", (err: Error & { issues?: unknown; errors?: unknown }) => {
  log(`uncaughtException: ${err.message}\n${err.stack}`);
  if (err.name === "ZodError" || err.message?.includes("Zod")) {
    log(`ZodError details (non-fatal): ${JSON.stringify(err.issues || err.errors || err, null, 2)}`);
    return; // ZodErrors are non-fatal SDK schema issues — safe to continue
  }
  // Unknown exceptions may corrupt shared state — exit for clean restart via try_restart
  log("Exiting due to unrecoverable exception");
  process.exit(1);
});

let unhandledRejectionCount = 0;
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  log(`unhandledRejection: ${msg}`);
  unhandledRejectionCount++;
  if (unhandledRejectionCount > 5) {
    log("Too many unhandled rejections — exiting for clean restart via try_restart");
    process.exit(1);
  }
});

log("Figtree sidecar started");
emit({ evt: "ready", tabId: "_control" });
