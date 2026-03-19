/**
 * useSessionController — extracts all session lifecycle and interaction logic
 * from ChatView into a reusable hook, so both ChatView and TerminalView can
 * share the same agent plumbing.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, interruptAgent, respondPermission, respondAskUser, refreshCommands, runClaudeCommand, getAgentMessages } from "./useAgentSession";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { MODELS, EFFORTS, PERM_MODES } from "../types";
import type { AgentEvent, AgentTask, Attachment, ChatMessage, PermissionSuggestion, SlashCommand, AgentInfoSDK } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeInput } from "../utils/sanitizeInput";
import { notifyAttention } from "../utils/notify";
import type { Command } from "../components/chat/CommandMenu";

// ── Session stats reducer ─────────────────────────────────────────
interface SessionStats {
  tokens: number;
  contextWindow: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
  rateLimitUtil: number;
}

const INITIAL_STATS: SessionStats = {
  tokens: 0, contextWindow: 0, cost: 0,
  inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
  turns: 0, durationMs: 0, rateLimitUtil: 0,
};

type StatsAction =
  | { type: "result"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number; turns: number; durationMs: number; contextWindow: number }
  | { type: "rateLimit"; utilization: number };

function statsReducer(state: SessionStats, action: StatsAction): SessionStats {
  switch (action.type) {
    case "result":
      return {
        ...state,
        tokens: state.tokens + (action.inputTokens || 0) + (action.outputTokens || 0),
        contextWindow: action.contextWindow > 0 ? action.contextWindow : state.contextWindow,
        cost: state.cost + (action.cost || 0),
        inputTokens: state.inputTokens + (action.inputTokens || 0),
        outputTokens: state.outputTokens + (action.outputTokens || 0),
        cacheReadTokens: state.cacheReadTokens + (action.cacheReadTokens || 0),
        cacheWriteTokens: state.cacheWriteTokens + (action.cacheWriteTokens || 0),
        turns: state.turns + (action.turns || 0),
        durationMs: state.durationMs + (action.durationMs || 0),
      };
    case "rateLimit":
      return { ...state, rateLimitUtil: action.utilization };
  }
}

// ── Tool grouping types ──────────────────────────────────────────
type ToolGroupItem = { role: "tool-group"; id: string; timestamp: number; tools: Extract<ChatMessage, { role: "tool" }>[] };
export type DisplayItem = ChatMessage | ToolGroupItem;

// ── Module-level deferred kill tracker ────────────────────────────
// Invariant: only one session controller per tabId may exist at a time.
// This map coordinates deferred kills across mount/unmount cycles
// (StrictMode double-mount and navigation remounts).
const _pendingKills = new Map<string, ReturnType<typeof setTimeout>>();

// ── Hook Props ───────────────────────────────────────────────────
export interface SessionControllerProps {
  tabId: string;
  projectPath: string;
  modelIdx: number;
  effortIdx: number;
  permModeIdx: number;
  systemPrompt: string;
  isActive: boolean;
  onSessionCreated: (tabId: string, sessionId: string) => void;
  onNewOutput: (tabId: string) => void;
  onExit: (tabId: string, code: number) => void;
  onError: (tabId: string, msg: string) => void;
  onTaglineChange?: (tabId: string, tagline: string) => void;
  plugins?: string[];
  resumeSessionId?: string;
  forkSessionId?: string;
}

// ── Hook Return ──────────────────────────────────────────────────
export interface SessionController {
  messages: ChatMessage[];
  displayItems: DisplayItem[];
  deferredMessages: ChatMessage[];
  inputState: "idle" | "awaiting_input" | "processing";
  stats: SessionStats;
  agentTasks: AgentTask[];
  sdkCommands: SlashCommand[];
  sdkAgents: AgentInfoSDK[];
  hasUnresolvedPermission: boolean;
  // Streaming/thinking refs (read-only) + ticks for rendering outside virtualizer
  streamingTextRef: React.RefObject<string>;
  streamingIdRef: React.RefObject<string | null>;
  streamingTick: number;
  thinkingTextRef: React.RefObject<string>;
  thinkingIdRef: React.RefObject<string | null>;
  thinkingTick: number;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  // Actions
  queueLength: number;
  backgrounded: boolean;
  handleSubmit: (text: string, attachments: Attachment[]) => Promise<void>;
  handlePermissionRespond: (msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => void;
  handleAskUserRespond: (msgId: string, answers: Record<string, string>) => void;
  handleCommand: (command: Command) => void;
  handleInterrupt: () => void;
  handleBackground: () => void;
  // File attachment
  droppedFiles: string[];
  setDroppedFiles: React.Dispatch<React.SetStateAction<string[]>>;
  handleDroppedFilesConsumed: () => void;
  handleAttachClick: () => Promise<void>;
}

export function useSessionController(props: SessionControllerProps): SessionController {
  const {
    tabId, projectPath, modelIdx, effortIdx, permModeIdx, systemPrompt,
    isActive, onSessionCreated, onNewOutput, onExit, onError, onTaglineChange,
    plugins = [], resumeSessionId, forkSessionId,
  } = props;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputStateRaw] = useState<"idle" | "awaiting_input" | "processing">("idle");
  const [stats, dispatchStats] = useReducer(statsReducer, INITIAL_STATS);
  const [sdkCommands, setSdkCommands] = useState<SlashCommand[]>([]);
  const [sdkAgents, setSdkAgents] = useState<AgentInfoSDK[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [backgrounded, setBackgrounded] = useState(false);
  const inputStateRef = useRef(inputState);
  const setInputState = useCallback((s: "idle" | "awaiting_input" | "processing") => {
    inputStateRef.current = s;
    setInputStateRaw(s);
  }, []);
  const agentTasksRef = useRef<AgentTask[]>([]);
  const taskFlushRafRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const idCounterRef = useRef(0);
  const nextId = () => `msg-${tabId}-${++idCounterRef.current}`;

  // Streaming text refs
  const streamingTextRef = useRef("");
  const streamingIdRef = useRef<string | null>(null);
  const [streamingTick, setStreamingTick] = useState(0);
  const rafIdRef = useRef(0);

  // Thinking text refs
  const thinkingTextRef = useRef("");
  const thinkingIdRef = useRef<string | null>(null);
  const thinkingRafRef = useRef(0);
  const [thinkingTick, setThinkingTick] = useState(0);

  // Callback refs to avoid stale closures
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  const onNewOutputRef = useRef(onNewOutput);
  onNewOutputRef.current = onNewOutput;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTaglineChangeRef = useRef(onTaglineChange);
  onTaglineChangeRef.current = onTaglineChange;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // ── Agent lifecycle ─────────────────────────────────────────────
  // Contract: this effect runs once on mount. Config values (modelIdx, effortIdx,
  // permModeIdx, systemPrompt, plugins, resumeSessionId, forkSessionId) are captured
  // at mount time only. The parent MUST use a React key that changes when these values
  // change (e.g., `key={tabId}-${resumeSessionId}-${forkSessionId}`) to force a
  // full remount with fresh values. Callback props are indirected through refs above.
  useEffect(() => {
    const pendingKill = _pendingKills.get(tabId);
    if (pendingKill) {
      clearTimeout(pendingKill);
      _pendingKills.delete(tabId);
    }
    setMessages([]);
    setInputState("idle");
    let cancelled = false;

    const modelId = MODELS[modelIdx]?.id || "";
    const effortId = EFFORTS[effortIdx] || "high";
    const permMode = PERM_MODES[permModeIdx]?.sdk || "plan";

    const finalizeStreaming = () => {
      if (!streamingIdRef.current) return;
      const id = streamingIdRef.current;
      const text = streamingTextRef.current;
      streamingIdRef.current = null;
      streamingTextRef.current = "";
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      setMessages(prev => [...prev, { id, role: "assistant", text, streaming: false, timestamp: Date.now() }]);
    };

    const finalizeThinking = () => {
      if (!thinkingIdRef.current) return;
      const id = thinkingIdRef.current;
      const text = thinkingTextRef.current;
      thinkingIdRef.current = null;
      thinkingTextRef.current = "";
      cancelAnimationFrame(thinkingRafRef.current);
      thinkingRafRef.current = 0;
      setMessages(prev => [...prev, { id, role: "thinking", text, timestamp: Date.now() }]);
    };

    const handleAgentEvent = (event: AgentEvent) => {
      if (cancelled) return;

      if (event.type === "assistant") {
        if (event.streaming) {
          // If thinking was active, finalize it before appending more text
          if (thinkingIdRef.current) finalizeThinking();
          if (!streamingIdRef.current) {
            streamingIdRef.current = nextId();
            streamingTextRef.current = event.text;
          } else {
            streamingTextRef.current += event.text;
          }
          if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = 0;
              setStreamingTick(t => t + 1);
            });
          }
        } else {
          if (streamingIdRef.current) {
            finalizeStreaming();
          } else {
            setMessages(prev => [...prev, { id: nextId(), role: "assistant", text: event.text, streaming: false, timestamp: Date.now() }]);
          }
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "toolUse") {
        finalizeStreaming();
        finalizeThinking();
        setMessages(prev => [...prev, { id: nextId(), role: "tool", tool: event.tool, input: event.input, timestamp: Date.now() }]);
        const inp = event.input as Record<string, string> | undefined;
        const detail = event.tool === "Bash" ? (inp?.command || "").slice(0, 40)
          : event.tool === "Edit" || event.tool === "Write" || event.tool === "Read"
            ? (inp?.file_path || "").split(/[/\\]/).pop() || ""
            : "";
        onTaglineChangeRef.current?.(tabIdRef.current, detail ? `${event.tool}: ${detail}` : event.tool);
      } else if (event.type === "toolResult") {
        setMessages(prev => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === "tool" && m.tool === event.tool && m.output === undefined) {
              const next = [...prev];
              next[i] = { ...m, output: event.output, success: event.success };
              return next;
            }
          }
          return prev;
        });
      } else if (event.type === "permission") {
        // In bypass mode, auto-approve any permission the SDK still emits
        if (permMode === "bypassPermissions") {
          respondPermission(tabId, true).catch(() => {});
          setMessages(prev => [...prev, {
            id: nextId(), role: "permission", tool: event.tool, description: event.description,
            suggestions: event.suggestions, timestamp: Date.now(), resolved: true, allowed: true,
          }]);
          return;
        }
        setMessages(prev => [...prev, {
          id: nextId(), role: "permission", tool: event.tool, description: event.description,
          suggestions: event.suggestions, timestamp: Date.now(),
        }]);
        setInputState("processing");
        onTaglineChangeRef.current?.(tabIdRef.current, `Permission: ${event.tool}`);
        notifyAttention("Permission Required", `${event.tool}: ${event.description || "Tool needs approval"}`, !isActiveRef.current).catch(() => {});
      } else if (event.type === "ask") {
        finalizeStreaming();
        finalizeThinking();
        setMessages(prev => [...prev, {
          id: nextId(), role: "ask", questions: event.questions,
          timestamp: Date.now(),
        }]);
        setInputState("processing");
        onTaglineChangeRef.current?.(tabIdRef.current, "Question");
        notifyAttention("Question", "Claude is asking a question", !isActiveRef.current).catch(() => {});
        queueMicrotask(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
      } else if (event.type === "inputRequired") {
        finalizeStreaming();
        finalizeThinking();
        // Drain message queue: if there are queued messages, send the next one
        if (messageQueueRef.current.length > 0) {
          const next = messageQueueRef.current.shift()!;
          setQueueLength(messageQueueRef.current.length);
          sendAgentMessage(tabId, next).catch(() => {});
          setInputState("processing");
        } else {
          setInputState("awaiting_input");
          setBackgrounded(false);
          notifyAttention("Input Required", "Claude is waiting for your input", !isActiveRef.current).catch(() => {});
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "thinking") {
        // Don't finalize streaming text here — text and thinking can interleave
        // within the same assistant turn. Finalizing would split one message into
        // two separate bubbles with a thinking block between them.
        if (!thinkingIdRef.current) {
          thinkingIdRef.current = nextId();
          thinkingTextRef.current = event.text;
        } else {
          thinkingTextRef.current += event.text;
        }
        if (!thinkingRafRef.current) {
          thinkingRafRef.current = requestAnimationFrame(() => {
            thinkingRafRef.current = 0;
            setThinkingTick(t => t + 1);
          });
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "Thinking...");
      } else if (event.type === "result") {
        finalizeStreaming();
        finalizeThinking();
        dispatchStats({
          type: "result",
          inputTokens: event.inputTokens || 0,
          outputTokens: event.outputTokens || 0,
          cacheReadTokens: event.cacheReadTokens || 0,
          cacheWriteTokens: event.cacheWriteTokens || 0,
          cost: event.cost || 0,
          turns: event.turns || 0,
          durationMs: event.durationMs || 0,
          contextWindow: event.contextWindow || 0,
        });
        setMessages(prev => [
          ...prev.map(m => m.role === "thinking" && !m.ended ? { ...m, ended: true } as ChatMessage : m),
          { id: nextId(), role: "result", ...event, timestamp: Date.now() },
        ]);
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "error") {
        setMessages(prev => {
          if (event.code === "rate_limit") {
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m.role === "error" && m.code === "rate_limit") {
                const next = [...prev];
                next[i] = { ...m, message: event.message, timestamp: Date.now() };
                return next;
              }
              if (m.role !== "error" && m.role !== "tool" && m.role !== "thinking" && m.role !== "status") break;
            }
          }
          return [...prev, { id: nextId(), role: "error", code: event.code, message: event.message, timestamp: Date.now() }];
        });
      } else if (event.type === "interrupted") {
        finalizeStreaming();
        finalizeThinking();
        // Clear queue and background state — interrupted session starts fresh
        messageQueueRef.current = [];
        setQueueLength(0);
        setBackgrounded(false);
        // Interrupted — session will be resumed by sidecar, just update UI
        setMessages(prev => [...prev, { id: nextId(), role: "status", status: "Interrupted", model: "", timestamp: Date.now() }]);
        // Don't change inputState — the resumed session will emit input_required or start processing
      } else if (event.type === "exit") {
        finalizeStreaming();
        finalizeThinking();
        exitedRef.current = true;
        if (refreshIntervalRef.current) {
          clearInterval(refreshIntervalRef.current);
          refreshIntervalRef.current = null;
        }
        onExitRef.current(tabIdRef.current, event.code);
      } else if (event.type === "progress") {
        onTaglineChangeRef.current?.(tabIdRef.current, event.message);
      } else if (event.type === "todo") {
        setMessages(prev => {
          const existing = prev.findIndex(m => m.role === "todo");
          if (existing >= 0) {
            const next = [...prev];
            next[existing] = { ...next[existing], todos: event.todos, timestamp: Date.now() } as ChatMessage;
            return next;
          }
          return [...prev, { id: nextId(), role: "todo", todos: event.todos, timestamp: Date.now() }];
        });
      } else if (event.type === "taskStarted") {
        if (!agentTasksRef.current.some(t => t.taskId === event.taskId)) {
          const newTask: AgentTask = {
            taskId: event.taskId, description: event.description, taskType: event.taskType,
            status: "running", totalTokens: 0, toolUses: 0, durationMs: 0, lastToolName: "", summary: "",
          };
          agentTasksRef.current = [...agentTasksRef.current, newTask];
          setAgentTasks(agentTasksRef.current);
        }
      } else if (event.type === "taskProgress") {
        agentTasksRef.current = agentTasksRef.current.map(t => t.taskId === event.taskId ? {
          ...t, description: event.description || t.description,
          totalTokens: event.totalTokens, toolUses: event.toolUses,
          durationMs: event.durationMs, lastToolName: event.lastToolName,
          summary: event.summary || t.summary,
        } : t);
        if (!taskFlushRafRef.current) {
          taskFlushRafRef.current = requestAnimationFrame(() => {
            taskFlushRafRef.current = 0;
            setAgentTasks(agentTasksRef.current);
          });
        }
      } else if (event.type === "taskNotification") {
        const validStatuses = new Set<AgentTask["status"]>(["completed", "failed", "stopped"]);
        const status = validStatuses.has(event.status) ? event.status : "stopped";
        agentTasksRef.current = agentTasksRef.current.map(t => t.taskId === event.taskId ? {
          ...t, status,
          summary: event.summary || t.summary,
          totalTokens: event.totalTokens,
          toolUses: event.toolUses,
          durationMs: event.durationMs,
        } : t);
        setAgentTasks(agentTasksRef.current);
      } else if (event.type === "rateLimit") {
        dispatchStats({ type: "rateLimit", utilization: event.utilization });
      } else if (event.type === "commandsInit") {
        setSdkCommands(event.commands);
        setSdkAgents(event.agents);
      } else if (event.type === "autocomplete" || event.type === "status") {
        if (event.type === "status" && event.status && event.status !== "null" && event.status !== "started") {
          setMessages(prev => [...prev, { id: nextId(), role: "status", status: event.status, model: event.model, timestamp: Date.now() }]);
        }
      }

      if (!isActiveRef.current) {
        onNewOutputRef.current(tabIdRef.current);
      }
    };

    const historySessionId = resumeSessionId || forkSessionId;
    let channelRef: { onmessage: ((event: AgentEvent) => void) | null } | null = null;

    (async () => {
      if (historySessionId) {
        try {
          const data = await getAgentMessages(historySessionId, projectPath);
          if (cancelled) return;
          const sdkMsgs = (data as Record<string, unknown>)?.messages;
          if (!Array.isArray(sdkMsgs) || !sdkMsgs.length) { /* no history */ }
          else {
            const historyMsgs: ChatMessage[] = [];
            for (const m of sdkMsgs) {
              const role = m?.message?.role;
              const content = m?.message?.content;
              if (!content) continue;
              if (role === "user") {
                const text = typeof content === "string" ? content : (Array.isArray(content) ? content.filter((b: Record<string, unknown>) => b.type === "text").map((b: Record<string, unknown>) => b.text).join("\n") : "");
                if (text) historyMsgs.push({ id: `hist-${tabId}-${historyMsgs.length}`, role: "user", text, timestamp: 0 });
              } else if (role === "assistant") {
                const blocks = Array.isArray(content) ? content : [];
                for (const block of blocks) {
                  if (block.type === "text" && block.text) {
                    historyMsgs.push({ id: `hist-${tabId}-${historyMsgs.length}`, role: "assistant", text: block.text, streaming: false, timestamp: 0 });
                  } else if (block.type === "tool_use" && block.name) {
                    historyMsgs.push({ id: `hist-${tabId}-${historyMsgs.length}`, role: "tool", tool: block.name, input: block.input, timestamp: 0 });
                  }
                }
              }
            }
            if (historyMsgs.length > 0) {
              historyMsgs.push({ id: `hist-sep-${tabId}`, role: "history-separator", timestamp: 0 });
              setMessages(historyMsgs);
            }
          }
        } catch (err) {
          console.warn("History load failed:", err);
        }
      }
      if (cancelled) return;

      const launchPromise = resumeSessionId
        ? resumeAgent(tabId, resumeSessionId, projectPath, modelId, effortId, permMode, plugins, handleAgentEvent)
        : forkSessionId
          ? forkAgent(tabId, forkSessionId, projectPath, modelId, effortId, permMode, plugins, handleAgentEvent)
          : spawnAgent(tabId, projectPath, modelId, effortId, sanitizeInput(systemPrompt), permMode, plugins, handleAgentEvent);

      launchPromise
        .then((channel) => {
          channelRef = channel;
          if (cancelled) return;
          agentStartedRef.current = true;
          onSessionCreatedRef.current(tabIdRef.current, tabId);
          refreshIntervalRef.current = setInterval(() => {
            refreshCommands(tabId).then((data) => {
              setSdkCommands(data.commands || []);
              setSdkAgents(data.agents || []);
            }).catch(() => {});
          }, 60_000);
        })
        .catch((err) => {
          if (cancelled) return;
          const msg = String(err);
          setMessages(prev => [...prev, { id: nextId(), role: "error", code: "spawn", message: msg, timestamp: Date.now() }]);
          exitedRef.current = true;
          onErrorRef.current(tabIdRef.current, msg);
        });
    })();

    return () => {
      cancelled = true;
      if (channelRef) channelRef.onmessage = null;
      streamingIdRef.current = null;
      streamingTextRef.current = "";
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      thinkingIdRef.current = null;
      thinkingTextRef.current = "";
      cancelAnimationFrame(thinkingRafRef.current);
      thinkingRafRef.current = 0;
      cancelAnimationFrame(taskFlushRafRef.current);
      taskFlushRafRef.current = 0;
      agentTasksRef.current = [];
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      const tid = tabIdRef.current;
      const killTimer = setTimeout(() => {
        _pendingKills.delete(tid);
        killAgent(tid).catch(() => {});
      }, 50);
      _pendingKills.set(tid, killTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Input submission ────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSubmit = useCallback(async (text: string, attachments: Attachment[]) => {
    if (!agentStartedRef.current) return;

    const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    let fullText = text;
    if (attachments.length > 0) {
      const parts: string[] = [];
      for (const a of attachments) {
        if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(a.path)) {
          parts.push(`[Attached image: ${a.path}]`);
        } else {
          try {
            const content = await invoke<string>("read_external_file", { path: a.path });
            const filename = a.path.replace(/\\/g, "/").split("/").pop() || a.path;
            parts.push(`<file path="${escXml(a.path)}" name="${escXml(filename)}">\n${escXml(content)}\n</file>`);
          } catch {
            parts.push(`[Attached: ${a.path}]`);
          }
        }
      }
      const attachPrefix = parts.join("\n");
      fullText = attachPrefix + (text ? "\n\n" + text : "");
    }
    if (!fullText.trim()) return;
    if (!agentStartedRef.current || exitedRef.current) return;

    const sanitized = sanitizeInput(fullText);
    setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "user", text: fullText, timestamp: Date.now() }]);

    if (inputStateRef.current === "awaiting_input") {
      // Normal send — transition to processing
      setInputState("processing");
      sendAgentMessage(tabId, sanitized).catch((err) => {
        setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: "send", message: String(err), timestamp: Date.now() }]);
      });
    } else {
      // Already processing — queue locally, will be sent when inputRequired fires
      messageQueueRef.current.push(sanitized);
      setQueueLength(messageQueueRef.current.length);
      // Typing during processing implies backgrounding
      setBackgrounded(true);
    }
  }, [tabId]);

  // ── Permission response ─────────────────────────────────────────
  const respondedIdsRef = useRef(new Set<string>());
  const handlePermissionRespond = useCallback((msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => {
    if (respondedIdsRef.current.has(msgId)) return;
    respondedIdsRef.current.add(msgId);
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "permission" ? { ...m, resolved: true, allowed: allow } : m
    ));
    respondPermission(tabId, allow, suggestions).catch((err) => {
      setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: "permission", message: String(err), timestamp: Date.now() }]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // ── AskUserQuestion response ────────────────────────────────────
  const handleAskUserRespond = useCallback((msgId: string, answers: Record<string, string>) => {
    if (respondedIdsRef.current.has(msgId)) return;
    respondedIdsRef.current.add(msgId);
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "ask" ? { ...m, resolved: true, answers } : m
    ));
    respondAskUser(tabId, answers).catch((err) => {
      setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: "ask_user", message: String(err), timestamp: Date.now() }]);
    });
  }, [tabId]);

  // ── Permission keyboard shortcuts ──────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const handlePermissionKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key !== "y" && key !== "n" && key !== "a") return;
      const allow = key !== "n";
      setMessages(prev => {
        let idx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i];
          if (m.role === "permission" && !m.resolved) { idx = i; break; }
        }
        if (idx < 0) return prev;
        const msg = prev[idx];
        if (msg.role !== "permission") return prev;
        if (respondedIdsRef.current.has(msg.id)) return prev;
        respondedIdsRef.current.add(msg.id);
        const sugg = key === "a" ? msg.suggestions : undefined;
        const permMsgId = msg.id;
        queueMicrotask(() => respondPermission(tabId, allow, sugg).catch(() => {
          // Revert on failure so the user can retry
          respondedIdsRef.current.delete(permMsgId);
          setMessages(p => p.map(m => m.id === permMsgId && m.role === "permission" ? { ...m, resolved: false, allowed: undefined } as typeof m : m));
        }));
        const next = [...prev];
        next[idx] = { ...msg, resolved: true, allowed: allow };
        return next;
      });
    };
    window.addEventListener("keydown", handlePermissionKey);
    return () => window.removeEventListener("keydown", handlePermissionKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, tabId]);

  // ── Slash commands ─────────────────────────────────────────────
  const handleCommand = useCallback((command: Command) => {
    if (command.source === "skill") {
      sendAgentMessage(tabId, command.name).catch(console.error);
      setInputState("processing");
      return;
    }
    switch (command.name) {
      case "/clear":
        setMessages([]);
        sendAgentMessage(tabId, "/clear").catch(console.error);
        break;
      case "/compact":
      case "/help":
        sendAgentMessage(tabId, command.name).catch(console.error);
        setInputState("processing");
        break;
      case "/theme":
        window.dispatchEvent(new CustomEvent("anvil:open-settings"));
        break;
      case "/sessions":
        window.dispatchEvent(new CustomEvent("anvil:open-sessions"));
        break;
      case "/login":
      case "/logout":
      case "/status":
      case "/doctor": {
        const sub = command.name.slice(1);
        setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "status", status: `Running claude ${sub}...`, model: "", timestamp: Date.now() }]);
        runClaudeCommand(sub).then(async (result) => {
          const output = (result.stdout || result.stderr || "").trim();
          if (output) {
            setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "status", status: output, model: "", timestamp: Date.now() }]);
          }
          if (result.url) {
            try {
              await shellOpen(result.url);
              setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "status", status: "Browser opened for authentication", model: "", timestamp: Date.now() }]);
            } catch {
              setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "status", status: `Open this URL: ${result.url}`, model: "", timestamp: Date.now() }]);
            }
          }
          if (!result.success && !output) {
            setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: sub, message: `claude ${sub} failed`, timestamp: Date.now() }]);
          }
        }).catch((err) => {
          setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: sub, message: String(err), timestamp: Date.now() }]);
        });
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // ── Interrupt ──────────────────────────────────────────────────
  const handleInterrupt = useCallback(() => {
    if (inputStateRef.current === "awaiting_input") return;
    if (exitedRef.current) return;
    interruptAgent(tabId).catch(() => {
      // Fallback to hard kill if interrupt fails
      killAgent(tabId).catch(() => {});
    });
  }, [tabId]);

  // ── Background ────────────────────────────────────────────────
  const handleBackground = useCallback(() => {
    setBackgrounded(true);
  }, []);

  // ── File attachment ────────────────────────────────────────────
  const handleDroppedFilesConsumed = useCallback(() => setDroppedFiles([]), []);
  const handleAttachClick = useCallback(async () => {
    try {
      const result = await open({ multiple: true });
      if (result) {
        const paths = Array.isArray(result) ? result : [result];
        setDroppedFiles(paths);
      }
    } catch { /* cancelled */ }
  }, []);

  // ── Derived state ──────────────────────────────────────────────
  const hasUnresolvedPermission = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ((m.role === "permission" || m.role === "ask") && !m.resolved) return true;
      if (m.role === "user") break;
    }
    return false;
  }, [messages]);

  const deferredMessages = useDeferredValue(messages);

  // ── Group consecutive tool messages ──────────────────────────────
  const displayItems = useMemo((): DisplayItem[] => {
    const result: DisplayItem[] = [];
    let toolRun: Extract<ChatMessage, { role: "tool" }>[] = [];
    const flush = () => {
      if (toolRun.length === 1) result.push(toolRun[0]);
      else if (toolRun.length > 1) result.push({ role: "tool-group", id: toolRun[0].id, timestamp: toolRun[0].timestamp, tools: toolRun });
      toolRun = [];
    };
    for (const msg of messages) {
      if (msg.role === "tool") {
        toolRun.push(msg);
      } else {
        flush();
        result.push(msg);
      }
    }
    flush();
    return result;
  }, [messages]);

  return {
    messages, displayItems, deferredMessages,
    inputState, stats, agentTasks, sdkCommands, sdkAgents,
    hasUnresolvedPermission,
    queueLength, backgrounded,
    streamingTextRef, streamingIdRef, streamingTick,
    thinkingTextRef, thinkingIdRef, thinkingTick,
    messagesEndRef,
    handleSubmit, handlePermissionRespond, handleAskUserRespond,
    handleCommand, handleInterrupt, handleBackground,
    droppedFiles, setDroppedFiles, handleDroppedFilesConsumed, handleAttachClick,
  };
}
