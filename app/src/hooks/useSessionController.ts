/**
 * useSessionController — extracts all session lifecycle and interaction logic
 * into a reusable hook so TerminalView can
 * share the same agent plumbing.
 *
 * Sub-hooks:
 * - useStreamingText — streaming text ref management + rAF ticks
 * - useThinkingText — thinking text ref management + rAF ticks
 * - useAgentTasks — agent task lifecycle + rAF-batched progress
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, interruptAgent, respondPermission, respondAskUser, refreshCommands, runClaudeCommand, getAgentMessages, setAgentPermMode, setAgentModel } from "./useAgentSession";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { PERM_MODES, DEFAULT_MODELS, DEFAULT_EFFORTS } from "../types";
import type { AgentEvent, Attachment, ChatMessage, PermissionSuggestion, SlashCommand, AgentInfoSDK, ModelInfoSDK, TeamState, TeamTask } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeInput } from "../utils/sanitizeInput";
import { notifyAttention } from "../utils/notify";
import { pruneMessages, PRUNE_THRESHOLD } from "../utils/pruneMessages";
import type { Command } from "../components/chat/CommandMenu";
import { useStreamingText, useThinkingText } from "./useBufferedText";
import { useAgentTasks } from "./useAgentTasks";
import { TerminalDocument } from "../components/terminal/TerminalDocument";

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

/** Resolve SDK models to a UI-friendly list, falling back to hardcoded defaults. */
function resolveModels(sdkModels: ModelInfoSDK[]): readonly { display: string; id: string }[] {
  if (sdkModels.length === 0) return DEFAULT_MODELS as readonly { display: string; id: string }[];
  return sdkModels.map(m => ({ display: m.displayName, id: m.value }));
}

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
  disabledHooks?: string[];
  apiBaseUrl?: string;
  resumeSessionId?: string;
  forkSessionId?: string;
  agentName?: string;
}

// ── Hook Return ──────────────────────────────────────────────────
export interface SessionController {
  messages: ChatMessage[];
  displayItems: DisplayItem[];
  deferredMessages: ChatMessage[];
  inputState: "idle" | "awaiting_input" | "processing";
  stats: SessionStats;
  agentTasks: import("../types").AgentTask[];
  teamState: TeamState;
  sdkCommands: SlashCommand[];
  sdkAgents: AgentInfoSDK[];
  /** Models reported by SDK — empty until first session connects */
  sdkModels: ModelInfoSDK[];
  /** Derived model list for UI (display + id), from SDK or fallback */
  models: readonly { display: string; id: string }[];
  /** Derived effort list for current model, from SDK or fallback */
  efforts: readonly string[];
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
  // xterm.js document model
  document: TerminalDocument;
  projectPath: string;
}

export function useSessionController(props: SessionControllerProps): SessionController {
  const {
    tabId, projectPath, modelIdx, effortIdx, permModeIdx, systemPrompt,
    isActive, onSessionCreated, onNewOutput, onExit, onError, onTaglineChange,
    plugins = [], disabledHooks = [], apiBaseUrl = "", resumeSessionId, forkSessionId, agentName,
  } = props;

  const disabledHooksRef = useRef(disabledHooks);
  disabledHooksRef.current = disabledHooks;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputStateRaw] = useState<"idle" | "awaiting_input" | "processing">("idle");
  const [stats, dispatchStats] = useReducer(statsReducer, INITIAL_STATS);
  const [sdkCommands, setSdkCommands] = useState<SlashCommand[]>([]);
  const [sdkAgents, setSdkAgents] = useState<AgentInfoSDK[]>([]);
  const [sdkModels, setSdkModels] = useState<ModelInfoSDK[]>([]);
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [backgrounded, setBackgrounded] = useState(false);
  const inputStateRef = useRef(inputState);
  const setInputState = useCallback((s: "idle" | "awaiting_input" | "processing") => {
    inputStateRef.current = s;
    setInputStateRaw(s);
  }, []);
  const messagesRef = useRef<ChatMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
  const sessionIdReportedRef = useRef(false);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const idCounterRef = useRef(0);
  const nextId = () => `msg-${tabId}-${++idCounterRef.current}`;

  // xterm.js TerminalDocument — created here so it exists before spawnAgent sends events
  const [document] = useState(() => new TerminalDocument());

  // Sub-hooks
  const streaming = useStreamingText();
  const thinking = useThinkingText();
  const agentTasksHook = useAgentTasks();
  const [teamState, setTeamState] = useState<TeamState>({ active: false, members: [], tasks: [], messages: [] });

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
  const sdkModelsRef = useRef(sdkModels);
  sdkModelsRef.current = sdkModels;

  // ── Agent lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    const pendingKill = _pendingKills.get(tabId);
    if (pendingKill) {
      clearTimeout(pendingKill);
      _pendingKills.delete(tabId);
    }
    setMessages([]);
    setInputState("idle");
    setTeamState({ active: false, members: [], tasks: [], messages: [] });
    let cancelled = false;

    // Use SDK models/efforts if available, fallback to hardcoded defaults
    const effectiveModels = resolveModels(sdkModelsRef.current);
    const clampedModelIdx = Math.min(modelIdx, effectiveModels.length - 1);
    const modelId = clampedModelIdx >= 0 ? effectiveModels[clampedModelIdx].id : "";
    const effectiveEfforts = sdkModelsRef.current.length > 0
      ? (() => { const m = sdkModels.find(s => s.value === modelId); return m?.supportedEffortLevels?.length ? m.supportedEffortLevels : DEFAULT_EFFORTS; })()
      : DEFAULT_EFFORTS;
    const effortId = effectiveEfforts[effortIdx] || "high";
    const permMode = PERM_MODES[permModeIdx]?.sdk || "plan";
    permModeIdxRef.current = permModeIdx;

    const finalizeStreaming = () => streaming.finalize(setMessages);
    const finalizeThinking = () => thinking.finalize(setMessages);

    const handleAgentEvent = (event: AgentEvent) => {
      if (cancelled) return;

      if (event.type === "assistant") {
        if (event.streaming) {
          if (thinking.idRef.current) finalizeThinking();
          streaming.append(event.text, nextId());
        } else {
          if (streaming.idRef.current) {
            finalizeStreaming();
          } else {
            setMessages(prev => [...prev, { id: nextId(), role: "assistant", text: event.text, streaming: false, timestamp: Date.now() }]);
          }
        }
        document.handleAssistant(event.text, event.streaming);
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "toolUse") {
        finalizeStreaming();
        finalizeThinking();
        setMessages(prev => [...prev, { id: nextId(), role: "tool", tool: event.tool, input: event.input, timestamp: Date.now() }]);
        document.handleToolUse(event.tool, event.input, (event as Record<string, unknown>).toolUseId as string | undefined);
        const inp = event.input as Record<string, string> | undefined;
        const detail = event.tool === "Bash" ? (inp?.command || "").slice(0, 40)
          : event.tool === "Edit" || event.tool === "Write" || event.tool === "Read"
            ? (inp?.file_path || "").split(/[/\\]/).pop() || ""
            : "";
        onTaglineChangeRef.current?.(tabIdRef.current, detail ? `${event.tool}: ${detail}` : event.tool);
        if (event.tool === "Agent") {
          const prompt = inp?.prompt || inp?.task || "";
          const desc = prompt ? prompt.slice(0, 120) : "Subagent";
          const taskType = inp?.subagent_type || "agent";
          agentTasksHook.startTask(`agent-${Date.now()}`, desc, taskType);
        }
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
        document.handleToolResult(event.tool, event.output, event.success, (event as Record<string, unknown>).toolUseId as string | undefined);
        if (event.tool === "Agent") {
          const output = typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "");
          // Find last running agent task
          let runningTaskId = "";
          const currentTasks = agentTasksHook.tasksRef.current;
          for (let i = currentTasks.length - 1; i >= 0; i--) {
            if (currentTasks[i].status === "running" && currentTasks[i].taskId.startsWith("agent-")) { runningTaskId = currentTasks[i].taskId; break; }
          }
          if (runningTaskId) {
            agentTasksHook.completeTask(runningTaskId, event.success, output.slice(0, 100));
          }
        }
      } else if (event.type === "permission") {
        if (PERM_MODES[permModeIdxRef.current]?.sdk === "bypassPermissions") {
          respondPermission(tabId, true, event.toolUseId).catch((err) => console.debug("[session] auto-approve permission failed:", err));
          setMessages(prev => [...prev, {
            id: nextId(), role: "permission", tool: event.tool, description: event.description,
            toolUseId: event.toolUseId, suggestions: event.suggestions, timestamp: Date.now(), resolved: true, allowed: true,
          }]);
          return;
        }
        setMessages(prev => [...prev, {
          id: nextId(), role: "permission", tool: event.tool, description: event.description,
          toolUseId: event.toolUseId, suggestions: event.suggestions, timestamp: Date.now(),
        }]);
        setInputState("processing");
        document.handlePermission(event.tool, event.description, event.toolUseId, event.suggestions);
        onTaglineChangeRef.current?.(tabIdRef.current, `Permission: ${event.tool}`);
        notifyAttention("Permission Required", `${event.tool}: ${event.description || "Tool needs approval"}`, !isActiveRef.current).catch((err) => console.debug("[session] permission notification failed:", err));
      } else if (event.type === "ask") {
        finalizeStreaming();
        finalizeThinking();
        setMessages(prev => [...prev, { id: nextId(), role: "ask", questions: event.questions, timestamp: Date.now() }]);
        document.handleAsk(event.questions);
        setInputState("processing");
        onTaglineChangeRef.current?.(tabIdRef.current, "Question");
        notifyAttention("Question", "Claude is asking a question", !isActiveRef.current).catch((err) => console.debug("[session] ask notification failed:", err));
        requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
      } else if (event.type === "inputRequired") {
        finalizeStreaming();
        finalizeThinking();
        if (messageQueueRef.current.length > 0) {
          const next = messageQueueRef.current.shift()!;
          setQueueLength(messageQueueRef.current.length);
          sendAgentMessage(tabId, next).catch((err) => console.debug("[session] queue drain send failed:", err));
          setInputState("processing");
        } else {
          setInputState("awaiting_input");
          setBackgrounded(false);
          notifyAttention("Input Required", "Claude is waiting for your input", !isActiveRef.current).catch((err) => console.debug("[session] input notification failed:", err));
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "thinking") {
        thinking.append(event.text, nextId());
        document.handleThinking(event.text);
        onTaglineChangeRef.current?.(tabIdRef.current, "Thinking...");
      } else if (event.type === "result") {
        finalizeStreaming();
        finalizeThinking();
        if (!sessionIdReportedRef.current && event.sessionId) {
          sessionIdReportedRef.current = true;
          onSessionCreatedRef.current(tabIdRef.current, event.sessionId);
        }
        dispatchStats({
          type: "result",
          inputTokens: event.inputTokens || 0, outputTokens: event.outputTokens || 0,
          cacheReadTokens: event.cacheReadTokens || 0, cacheWriteTokens: event.cacheWriteTokens || 0,
          cost: event.cost || 0, turns: event.turns || 0,
          durationMs: event.durationMs || 0, contextWindow: event.contextWindow || 0,
        });
        setMessages(prev => [
          ...prev.map(m => m.role === "thinking" && !m.ended ? { ...m, ended: true } as ChatMessage : m),
          { id: nextId(), role: "result", ...event, timestamp: Date.now() },
        ]);
        document.handleResult(
          event.cost || 0, event.inputTokens || 0, event.outputTokens || 0,
          event.cacheReadTokens || 0, event.cacheWriteTokens || 0,
          event.turns || 0, event.durationMs || 0, event.sessionId || "",
        );
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
        document.handleError(event.code, event.message);
      } else if (event.type === "interrupted") {
        finalizeStreaming();
        finalizeThinking();
        messageQueueRef.current = [];
        setQueueLength(0);
        setBackgrounded(false);
        respondedIdsRef.current.clear();
        setMessages(prev => [...prev, { id: nextId(), role: "status", status: "Interrupted", model: "", timestamp: Date.now() }]);
        document.handleInterrupted();
        agentTasksHook.stopAll();
      } else if (event.type === "exit") {
        finalizeStreaming();
        finalizeThinking();
        exitedRef.current = true;
        if (refreshIntervalRef.current) {
          clearInterval(refreshIntervalRef.current);
          refreshIntervalRef.current = null;
        }
        // Mark any unresolved permission/ask cards as dead so UI doesn't show stale interactive cards
        setMessages(prev => prev.map(m =>
          (m.role === "permission" || m.role === "ask") && !m.resolved
            ? { ...m, resolved: true, allowed: false } as typeof m
            : m
        ));
        onExitRef.current(tabIdRef.current, event.code);
      } else if (event.type === "progress") {
        onTaglineChangeRef.current?.(tabIdRef.current, event.message);
        document.handleProgress(event.tool, event.message);
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
        document.handleTodo(event.todos);
      } else if (event.type === "taskStarted") {
        agentTasksHook.onTaskStarted(event.taskId, event.description, event.taskType);
        setTeamState(prev => {
          const newTask: TeamTask = { id: event.taskId, description: event.description, assignee: event.taskId, status: "in_progress" };
          const memberExists = prev.members.some(m => m.agentId === event.taskId);
          const newMembers = memberExists ? prev.members.map(m =>
            m.agentId === event.taskId ? { ...m, status: "working" as const } : m
          ) : [...prev.members, { agentId: event.taskId, name: event.taskType || event.description?.slice(0, 40) || event.taskId, role: "teammate" as const, status: "working" as const }];
          const newTasks = [...prev.tasks, newTask];
          // Only mark team as active when there are 2+ concurrent members (real team).
          // A single subagent (Agent tool) stays in Tasks sidebar only.
          const workingCount = newMembers.filter(m => m.status === "working").length;
          return { active: workingCount >= 2, members: newMembers, tasks: newTasks, messages: prev.messages };
        });
      } else if (event.type === "taskProgress") {
        agentTasksHook.onTaskProgress(event.taskId, event.description, event.totalTokens, event.toolUses, event.durationMs, event.lastToolName, event.summary);
        setTeamState(prev => {
          const newDesc = event.summary || undefined;
          const taskChanged = newDesc && prev.tasks.some(t => t.id === event.taskId && t.description !== newDesc);
          const memberChanged = prev.members.some(m => m.agentId === event.taskId && m.status !== "working");
          if (!taskChanged && !memberChanged) return prev; // bail out — no re-render
          return {
            ...prev,
            tasks: taskChanged ? prev.tasks.map(t => t.id === event.taskId ? { ...t, description: newDesc! } : t) : prev.tasks,
            members: memberChanged ? prev.members.map(m => m.agentId === event.taskId ? { ...m, status: "working" as const } : m) : prev.members,
          };
        });
      } else if (event.type === "taskNotification") {
        agentTasksHook.onTaskNotification(event.taskId, event.status, event.summary, event.totalTokens, event.toolUses, event.durationMs);
        setTeamState(prev => {
          const taskStatus = event.status === "completed" ? "completed" as const : event.status === "failed" || event.status === "stopped" ? "completed" as const : "pending" as const;
          const memberStatus = event.status === "completed" ? "idle" as const : "disconnected" as const;
          const newMsgs = [...prev.messages, { from: event.taskId, to: "lead", content: event.summary, timestamp: Date.now() }];
          if (newMsgs.length > 100) newMsgs.splice(0, newMsgs.length - 100);
          const updated = {
            ...prev,
            tasks: prev.tasks.map(t => t.id === event.taskId ? { ...t, status: taskStatus, description: event.summary || t.description } : t),
            members: prev.members.map(m => m.agentId === event.taskId ? { ...m, status: memberStatus } : m),
            messages: newMsgs,
          };
          const allDone = updated.members.every(m => m.status === "idle" || m.status === "disconnected");
          if (allDone && updated.members.length > 0) updated.active = false;
          return updated;
        });
      } else if (event.type === "rateLimit") {
        dispatchStats({ type: "rateLimit", utilization: event.utilization });
      } else if (event.type === "commandsInit") {
        setSdkCommands(event.commands);
        setSdkAgents(event.agents);
        if (event.models?.length) setSdkModels(event.models);
      } else if (event.type === "status") {
        if (event.status === "init" && event.sessionId) {
          sessionIdReportedRef.current = true;
          onSessionCreatedRef.current(tabIdRef.current, event.sessionId);
        }
        if (event.status && event.status !== "null" && event.status !== "started") {
          setMessages(prev => [...prev, { id: nextId(), role: "status", status: event.status, model: event.model, timestamp: Date.now() }]);
        }
        document.handleStatus(event.status, event.model);
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
          if (Array.isArray(sdkMsgs) && sdkMsgs.length) {
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
        ? resumeAgent(tabId, resumeSessionId, projectPath, modelId, effortId, permMode, plugins, disabledHooksRef.current, apiBaseUrl, handleAgentEvent)
        : forkSessionId
          ? forkAgent(tabId, forkSessionId, projectPath, modelId, effortId, permMode, plugins, disabledHooksRef.current, apiBaseUrl, handleAgentEvent)
          : spawnAgent(tabId, projectPath, modelId, effortId, sanitizeInput(systemPrompt), permMode, plugins, disabledHooksRef.current, apiBaseUrl, agentName || "", handleAgentEvent);

      launchPromise
        .then((channel) => {
          channelRef = channel;
          if (cancelled) return;
          agentStartedRef.current = true;
          refreshIntervalRef.current = setInterval(() => {
            refreshCommands(tabId).then((data) => {
              setSdkCommands(data.commands || []);
              setSdkAgents(data.agents || []);
            }).catch((err) => console.debug("[session] refreshCommands failed:", err));
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
      streaming.cleanup();
      thinking.cleanup();
      agentTasksHook.cleanup();
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      const tid = tabIdRef.current;
      const killTimer = setTimeout(() => {
        _pendingKills.delete(tid);
        killAgent(tid).catch((err) => console.debug("[session] deferred kill failed:", err));
      }, 50);
      _pendingKills.set(tid, killTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync permission mode changes to sidecar without remount ────
  const permModeIdxRef = useRef(permModeIdx);
  useEffect(() => {
    if (permModeIdx === permModeIdxRef.current) return;
    permModeIdxRef.current = permModeIdx;
    if (!agentStartedRef.current) return;
    const permMode = PERM_MODES[permModeIdx]?.sdk || "plan";
    setAgentPermMode(tabId, permMode).catch((err) => console.debug("[session] setAgentPermMode failed:", err));
  }, [permModeIdx, tabId]);

  // ── Sync model changes to sidecar without remount ──────────────
  // Guard on resolved model ID (not index) so the effect fires when
  // sdkModels arrives and remaps what an index means.
  const lastModelIdRef = useRef("");
  useEffect(() => {
    const effectiveModels = resolveModels(sdkModels);
    const clampedIdx = Math.min(modelIdx, effectiveModels.length - 1);
    const newModelId = clampedIdx >= 0 ? effectiveModels[clampedIdx].id : "";
    if (newModelId === lastModelIdRef.current) return;
    lastModelIdRef.current = newModelId;
    if (!agentStartedRef.current || !newModelId) return;
    setAgentModel(tabId, newModelId).catch((err) => console.debug("[session] setAgentModel failed:", err));
  }, [modelIdx, tabId, sdkModels]);

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
          } catch (err) {
            console.debug("[session] failed to read attached file:", a.path, err);
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
    document.handleUserMessage(fullText);

    if (inputStateRef.current === "awaiting_input") {
      setInputState("processing");
      sendAgentMessage(tabId, sanitized).catch((err) => {
        setMessages(prev => [...prev, { id: `msg-${tabId}-${++idCounterRef.current}`, role: "error", code: "send", message: String(err), timestamp: Date.now() }]);
      });
    } else {
      messageQueueRef.current.push(sanitized);
      setQueueLength(messageQueueRef.current.length);
      setBackgrounded(true);
    }
  }, [tabId]);

  // ── Permission response ─────────────────────────────────────────
  const respondedIdsRef = useRef(new Set<string>());
  const handlePermissionRespond = useCallback((msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => {
    // Read toolUseId from ref synchronously — not inside setState updater
    const permMsg = messagesRef.current.find(m => m.id === msgId && m.role === "permission");
    const toolUseId = permMsg?.role === "permission" ? permMsg.toolUseId : "";
    // Dedup on toolUseId (not msgId) — XTermView block IDs differ from ChatMessage IDs
    const dedupKey = toolUseId || msgId;
    if (respondedIdsRef.current.has(dedupKey)) return;
    respondedIdsRef.current.add(dedupKey);
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "permission" ? { ...m, resolved: true, allowed: allow } : m
    ));
    respondPermission(tabId, allow, toolUseId, suggestions).catch((err) => {
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
        const dedupKey = msg.toolUseId || msg.id;
        if (respondedIdsRef.current.has(dedupKey)) return prev;
        respondedIdsRef.current.add(dedupKey);
        const sugg = key === "a" ? msg.suggestions : undefined;
        const permMsgId = msg.id;
        const permToolUseId = msg.toolUseId;
        queueMicrotask(() => respondPermission(tabId, allow, permToolUseId, sugg).catch((err) => {
          console.debug("[session] keyboard permission response failed:", err);
          respondedIdsRef.current.delete(dedupKey);
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
        window.dispatchEvent(new CustomEvent("ccgui:open-settings"));
        break;
      case "/sessions":
        window.dispatchEvent(new CustomEvent("ccgui:open-sessions"));
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
            } catch (err) {
              console.debug("[session] shellOpen failed:", err);
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
    interruptAgent(tabId).catch((err) => {
      console.debug("[session] interrupt failed, falling back to kill:", err);
      killAgent(tabId).catch((err2) => console.debug("[session] fallback kill also failed:", err2));
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
    } catch (err) { console.debug("[session] file dialog cancelled or failed:", err); }
  }, []);

  // ── Message pruning for long sessions ──────────────────────────
  useEffect(() => {
    if (messages.length > PRUNE_THRESHOLD) {
      setMessages(prev => pruneMessages(prev));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // ── Sync messages ref for synchronous reads ────────────────────
  messagesRef.current = messages;

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

  // Derive UI-friendly model/effort lists from SDK data or fallback to hardcoded defaults
  const models = useMemo(() => resolveModels(sdkModels), [sdkModels]);

  const efforts = useMemo(() => {
    if (sdkModels.length === 0) return DEFAULT_EFFORTS;
    // Derive effort levels from the currently selected model (or union of all models)
    const currentModel = sdkModels.find(m => m.value === (models[modelIdx]?.id || ""));
    if (currentModel?.supportedEffortLevels?.length) return currentModel.supportedEffortLevels;
    // Union of all supported effort levels across models
    const allEfforts = new Set<string>();
    for (const m of sdkModels) {
      for (const e of m.supportedEffortLevels || []) allEfforts.add(e);
    }
    return allEfforts.size > 0 ? [...allEfforts] : (DEFAULT_EFFORTS as readonly string[]);
  }, [sdkModels, models, modelIdx]);

  return {
    messages, displayItems, deferredMessages,
    inputState, stats, agentTasks: agentTasksHook.tasks, teamState, sdkCommands, sdkAgents, sdkModels,
    models, efforts, hasUnresolvedPermission,
    queueLength, backgrounded,
    streamingTextRef: streaming.textRef, streamingIdRef: streaming.idRef, streamingTick: streaming.tick,
    thinkingTextRef: thinking.textRef, thinkingIdRef: thinking.idRef, thinkingTick: thinking.tick,
    messagesEndRef,
    handleSubmit, handlePermissionRespond, handleAskUserRespond,
    handleCommand, handleInterrupt, handleBackground,
    droppedFiles, setDroppedFiles, handleDroppedFilesConsumed, handleAttachClick,
    document,
    projectPath,
  };
}
