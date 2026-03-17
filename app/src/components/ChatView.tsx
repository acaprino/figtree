import { memo, useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, respondPermission, respondAskUser, refreshCommands, runClaudeCommand } from "../hooks/useAgentSession";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { MODELS, EFFORTS, PERM_MODES } from "../types";
import type { AgentEvent, AgentTask, Attachment, ChatMessage, PermissionSuggestion, SlashCommand, AgentInfoSDK } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sanitizeInput } from "../utils/sanitizeInput";
import { fmtTokens } from "../utils/format";
import ChatInput from "./chat/ChatInput";
import type { Command } from "./chat/CommandMenu";
import MessageBubble from "./chat/MessageBubble";
import ToolCard from "./chat/ToolCard";
import PermissionCard from "./chat/PermissionCard";
import AskQuestionCard from "./chat/AskQuestionCard";
import ThinkingBlock from "./chat/ThinkingBlock";
import ResultBar from "./chat/ResultBar";
import ErrorCard from "./chat/ErrorCard";
import RightSidebar from "./chat/RightSidebar";
import "./ChatView.css";

/** Patterns for parsing user message attachments */
const FILE_TAG_RE = /<file\s+path="([^"]*)"[^>]*>\n?([\s\S]{0,1048576}?)\n?<\/file>/;
const IMAGE_TAG_RE = /\[Attached image: ([^\]]+)\]/;
const FALLBACK_TAG_RE = /\[Attached: ([^\]]+)\]/;
const ATTACHMENT_RE = new RegExp(
  `(?:${FILE_TAG_RE.source})|(?:${IMAGE_TAG_RE.source})|(?:${FALLBACK_TAG_RE.source})`,
  "g",
);

const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(ATTACHMENT_RE.source, ATTACHMENT_RE.flags);
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const before = text.slice(lastIdx, match.index).trim();
      if (before) parts.push(<span key={key++}>{before}</span>);
    }
    if (match[1] !== undefined) {
      // <file path="..." name="...">content</file>
      const filePath = match[1];
      const content = match[2];
      const filename = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
      parts.push(
        <div key={key++} className="user-file-attachment">
          <div className="user-file-header">
            <span className="user-file-icon">+</span>
            <span className="user-file-name" title={filename}>{filename}</span>
          </div>
          <pre className="user-file-content">{content}</pre>
        </div>
      );
    } else {
      // [Attached image: path] or [Attached: path]
      const filePath = match[3] || match[4];
      const filename = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
      const isImage = match[3] !== undefined;
      parts.push(
        <div key={key++} className="user-file-attachment">
          <div className="user-file-header">
            <span className="user-file-icon">{isImage ? "\u{1F5BC}" : "+"}</span>
            <span className="user-file-name" title={filename}>{filename}</span>
          </div>
        </div>
      );
    }
    lastIdx = match.index + match[0].length;
  }
  const after = text.slice(lastIdx).trim();
  if (after) parts.push(<span key={key++}>{after}</span>);
  return <>{parts}</>;
});

const CopyMessageBtn = memo(function CopyMessageBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="copy-msg-btn" onClick={handleCopy} title="Copy response">
      {copied ? "Copied" : "Copy"}
    </button>
  );
});

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

interface ChatViewProps {
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
  inputStyle?: "chat" | "terminal";
  hideThinking?: boolean;
  plugins?: string[];
  resumeSessionId?: string;
  forkSessionId?: string;
}

export default memo(function ChatView({
  tabId, projectPath, modelIdx, effortIdx, permModeIdx, systemPrompt,
  isActive,
  onSessionCreated, onNewOutput, onExit, onError, onTaglineChange,
  inputStyle = "terminal", hideThinking, plugins = [], resumeSessionId, forkSessionId,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputState] = useState<"idle" | "awaiting_input" | "processing">("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showMiniInput, setShowMiniInput] = useState(false);
  const [stats, dispatchStats] = useReducer(statsReducer, INITIAL_STATS);
  const [sdkCommands, setSdkCommands] = useState<SlashCommand[]>([]);
  const [sdkAgents, setSdkAgents] = useState<AgentInfoSDK[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const agentTasksRef = useRef<AgentTask[]>([]);
  const taskFlushRafRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  // StrictMode kill-cancellation: cleanup sets true, re-mount sets false.
  // Deferred kill only fires if still true (real unmount, not StrictMode).
  const pendingKillRef = useRef(false);
  const idCounterRef = useRef(0);
  const nextId = () => `msg-${tabId}-${++idCounterRef.current}`;

  // Streaming text extraction: keep streaming text in refs to avoid O(n) array copy per chunk.
  // Only touch messages array on stream start (placeholder) and end (finalize).
  const streamingTextRef = useRef("");
  const streamingIdRef = useRef<string | null>(null);
  const [streamingTick, setStreamingTick] = useState(0);
  const rafIdRef = useRef(0);

  // Thinking text — same ref+rAF pattern as streaming to avoid O(n) array copy per delta.
  const thinkingTextRef = useRef("");
  const thinkingIdRef = useRef<string | null>(null);
  const thinkingRafRef = useRef(0);
  const [thinkingTick, setThinkingTick] = useState(0);

  // Callback refs to avoid stale closures in useEffect
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

  // Auto-scroll on new messages or streaming updates — only if user is near the bottom
  const chatContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, streamingTick, thinkingTick]);

  // Track scroll position for terminal mode floating mini-input
  useEffect(() => {
    if (inputStyle !== "terminal") return;
    const el = chatContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowMiniInput(dist > 200);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [inputStyle]);

  // Auto-focus textarea when the window regains focus (alt-tab back to Anvil)
  useEffect(() => {
    if (!isActive) return;
    const handleWindowFocus = () => {
      requestAnimationFrame(() => {
        const textarea = chatContainerRef.current?.closest(".chat-view")?.querySelector("textarea");
        textarea?.focus();
      });
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [isActive]);

  // ── Agent lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    pendingKillRef.current = false; // Cancel any deferred kill from StrictMode cleanup
    setMessages([]);               // Clear stale messages from previous StrictMode mount
    setInputState("idle");
    let cancelled = false;

    const modelId = MODELS[modelIdx]?.id || "";
    const effortId = EFFORTS[effortIdx] || "high";
    const permMode = PERM_MODES[permModeIdx]?.sdk || "plan";

    // Extracted helper: finalize any pending streaming message.
    // Streaming text lives in component-level refs to avoid O(n) array copies per chunk.
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

    // Finalize thinking: commit accumulated thinking text into the messages array.
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
          // Accumulate streaming text in refs — NO messages array copy per chunk.
          if (!streamingIdRef.current) {
            streamingIdRef.current = nextId();
            streamingTextRef.current = event.text;
          } else {
            streamingTextRef.current += event.text;
          }
          // RAF-throttle re-renders: coalesce multiple chunks per frame
          if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = 0;
              setStreamingTick(t => t + 1);
            });
          }
        } else {
          // Complete message — finalize streaming or add new
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
        // Update the most recent matching tool message with output (scan backward without copy)
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
        setMessages(prev => [...prev, {
          id: nextId(), role: "permission", tool: event.tool, description: event.description,
          suggestions: event.suggestions, timestamp: Date.now(),
        }]);
        setInputState("processing"); // Block input during permission
        onTaglineChangeRef.current?.(tabIdRef.current, `Permission: ${event.tool}`);
      } else if (event.type === "ask") {
        finalizeStreaming();
        finalizeThinking();
        setMessages(prev => [...prev, {
          id: nextId(), role: "ask", questions: event.questions,
          timestamp: Date.now(),
        }]);
        setInputState("processing");
        onTaglineChangeRef.current?.(tabIdRef.current, "Question");
        // Auto-scroll so the interactive card is visible
        queueMicrotask(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
      } else if (event.type === "inputRequired") {
        finalizeStreaming();
        finalizeThinking();
        setInputState("awaiting_input");
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "thinking") {
        finalizeStreaming();
        // Accumulate thinking deltas in refs — same pattern as streaming text.
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
        // Accumulate session stats in a single dispatch (1 re-render instead of 7+)
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
        // Mark thinking messages as ended (collapsed), add result
        setMessages(prev => [
          ...prev.map(m => m.role === "thinking" && !m.ended ? { ...m, ended: true } as ChatMessage : m),
          { id: nextId(), role: "result", ...event, timestamp: Date.now() },
        ]);
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "error") {
        setMessages(prev => {
          // Deduplicate rate limit errors — scan backward past transient messages
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
      } else if (event.type === "exit") {
        exitedRef.current = true;
        if (refreshIntervalRef.current) {
          clearInterval(refreshIntervalRef.current);
          refreshIntervalRef.current = null;
        }
        onExitRef.current(tabIdRef.current, event.code);
      } else if (event.type === "progress") {
        // Tool progress — show as transient status
        onTaglineChangeRef.current?.(tabIdRef.current, event.message);
      } else if (event.type === "todo") {
        // Update or create todo list message
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
        // Duplicate guard: skip if taskId already tracked
        if (!agentTasksRef.current.some(t => t.taskId === event.taskId)) {
          const newTask: AgentTask = {
            taskId: event.taskId, description: event.description, taskType: event.taskType,
            status: "running", totalTokens: 0, toolUses: 0, durationMs: 0, lastToolName: "", summary: "",
          };
          agentTasksRef.current = [...agentTasksRef.current, newTask];
          setAgentTasks(agentTasksRef.current);
        }
      } else if (event.type === "taskProgress") {
        // Batch progress updates via rAF to avoid flooding re-renders
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
        // autocomplete: not implemented yet for chat UI
        // status: only show non-null statuses
        if (event.type === "status" && event.status && event.status !== "null" && event.status !== "started") {
          setMessages(prev => [...prev, { id: nextId(), role: "status", status: event.status, model: event.model, timestamp: Date.now() }]);
        }
      }

      if (!isActiveRef.current) {
        onNewOutputRef.current(tabIdRef.current);
      }
    };

    let channelRef: { onmessage: ((event: AgentEvent) => void) | null } | null = null;

    const launchPromise = resumeSessionId
      ? resumeAgent(tabId, resumeSessionId, projectPath, modelId, effortId, plugins, handleAgentEvent)
      : forkSessionId
        ? forkAgent(tabId, forkSessionId, projectPath, modelId, effortId, plugins, handleAgentEvent)
        : spawnAgent(tabId, projectPath, modelId, effortId, sanitizeInput(systemPrompt), permMode, plugins, handleAgentEvent);

    launchPromise
      .then((channel) => {
        channelRef = channel;
        // Don't kill here if cancelled — the deferred kill in cleanup handles it.
        // Killing here would race with the re-mount's spawn in StrictMode.
        if (cancelled) return;
        agentStartedRef.current = true;
        onSessionCreatedRef.current(tabIdRef.current, tabId);
        // Start periodic refresh of commands/agents (every 60s)
        refreshIntervalRef.current = setInterval(() => {
          refreshCommands(tabId).then((data) => {
            setSdkCommands(data.commands || []);
            setSdkAgents(data.agents || []);
          }).catch(() => {
            // Keep last known lists on failure
          });
        }, 60_000);
      })
      .catch((err) => {
        if (cancelled) return;
        onErrorRef.current(tabIdRef.current, String(err));
      });

    return () => {
      cancelled = true;
      // Null out channel handler to prevent stale events from StrictMode's first mount
      if (channelRef) channelRef.onmessage = null;
      // Clear streaming state
      streamingIdRef.current = null;
      streamingTextRef.current = "";
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      // Clear thinking state
      thinkingIdRef.current = null;
      thinkingTextRef.current = "";
      cancelAnimationFrame(thinkingRafRef.current);
      thinkingRafRef.current = 0;
      // Clear agent task state
      cancelAnimationFrame(taskFlushRafRef.current);
      taskFlushRafRef.current = 0;
      agentTasksRef.current = [];
      // Clear commands/agents refresh interval
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      // Defer kill so StrictMode re-mount can cancel it.
      // pendingKillRef persists across mounts — re-mount sets it to false.
      pendingKillRef.current = true;
      const tid = tabIdRef.current;
      setTimeout(() => {
        if (pendingKillRef.current) {
          killAgent(tid).catch(() => {});
        }
      }, 50);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Input submission ────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSubmit = useCallback(async (text: string, attachments: Attachment[]) => {
    if (!agentStartedRef.current) return;
    // Block input immediately to prevent double-submit during file reads
    setInputState("processing");

    // Read file content for attachments outside the project directory
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
            const safePath = a.path.replace(/"/g, "&quot;");
            const safeName = filename.replace(/"/g, "&quot;");
            parts.push(`<file path="${safePath}" name="${safeName}">\n${content}\n</file>`);
          } catch {
            parts.push(`[Attached: ${a.path}]`);
          }
        }
      }
      const attachPrefix = parts.join("\n");
      fullText = attachPrefix + (text ? "\n\n" + text : "");
    }
    if (!fullText.trim()) {
      setInputState("awaiting_input");
      return;
    }
    // Guard: agent may have been killed during file reads
    if (!agentStartedRef.current || exitedRef.current) {
      setInputState("awaiting_input");
      return;
    }
    setMessages(prev => [...prev, { id: nextId(), role: "user", text: fullText, timestamp: Date.now() }]);
    sendAgentMessage(tabId, fullText).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "send", message: String(err), timestamp: Date.now() }]);
    });
  }, [tabId]);

  // ── Permission response ─────────────────────────────────────────
  const respondedIdsRef = useRef(new Set<string>());
  const handlePermissionRespond = useCallback((msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => {
    // Guard against double-click race
    if (respondedIdsRef.current.has(msgId)) return;
    respondedIdsRef.current.add(msgId);
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "permission" ? { ...m, resolved: true, allowed: allow } : m
    ));
    respondPermission(tabId, allow, suggestions).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "permission", message: String(err), timestamp: Date.now() }]);
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
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "ask_user", message: String(err), timestamp: Date.now() }]);
    });
  }, [tabId]);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c") {
      killAgent(tabId).catch(() => {});
    } else if (e.ctrlKey && e.key === "b") {
      e.preventDefault();
      setSidebarOpen(prev => !prev);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Permission keyboard shortcuts: Y=allow, N=deny, A=allow+session
  // Window-level listener so it works even when textarea is disabled/unfocused
  useEffect(() => {
    if (!isActive) return;
    const handlePermissionKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key !== "y" && key !== "n" && key !== "a") return;
      const allow = key !== "n";
      // Find and respond to latest unresolved permission (side effect outside updater)
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
        // Schedule IPC outside React's updater cycle
        queueMicrotask(() => respondPermission(tabId, allow, sugg).catch(() => {}));
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
      // SDK skill — send as slash command text to agent
      sendAgentMessage(tabId, command.name).catch(console.error);
      setInputState("processing");
      return;
    }
    // Local commands
    switch (command.name) {
      case "/clear":
        setMessages([]);
        // Also clear SDK conversation history so Claude doesn't see old messages
        sendAgentMessage(tabId, "/clear").catch(console.error);
        break;
      case "/sidebar":
        setSidebarOpen((prev) => !prev);
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
        const sub = command.name.slice(1); // remove leading /
        setMessages(prev => [...prev, { id: nextId(), role: "status", status: `Running claude ${sub}...`, model: "", timestamp: Date.now() }]);
        runClaudeCommand(sub).then(async (result) => {
          const output = (result.stdout || result.stderr || "").trim();
          if (output) {
            setMessages(prev => [...prev, { id: nextId(), role: "status", status: output, model: "", timestamp: Date.now() }]);
          }
          // Auto-open browser for login URL
          if (result.url) {
            try {
              await shellOpen(result.url);
              setMessages(prev => [...prev, { id: nextId(), role: "status", status: "Browser opened for authentication", model: "", timestamp: Date.now() }]);
            } catch {
              setMessages(prev => [...prev, { id: nextId(), role: "status", status: `Open this URL: ${result.url}`, model: "", timestamp: Date.now() }]);
            }
          }
          if (!result.success && !output) {
            setMessages(prev => [...prev, { id: nextId(), role: "error", code: sub, message: `claude ${sub} failed`, timestamp: Date.now() }]);
          }
        }).catch((err) => {
          setMessages(prev => [...prev, { id: nextId(), role: "error", code: sub, message: String(err), timestamp: Date.now() }]);
        });
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // ── Stable callbacks for ChatInput memo ─────────────────────────
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

  // ── Derived state (O(1) — scan backward from last user message) ──
  const hasUnresolvedPermission = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ((m.role === "permission" || m.role === "ask") && !m.resolved) return true;
      if (m.role === "user") break;
    }
    return false;
  }, [messages]);

  // ── Deferred messages for sidebar (skip re-renders during streaming)
  const deferredMessages = useDeferredValue(messages);

  // ── Virtualizer for message list ──────────────────────────────
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => chatContainerRef.current,
    estimateSize: () => 60,
    overscan: 15,
    getItemKey: (index) => messages[index].id,
  });

  // ── Scroll to message (for sidebar navigation) ─────────────────
  const handleScrollToMessage = useCallback((msgId: string) => {
    const index = messagesRef.current.findIndex(m => m.id === msgId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    // Wait for virtualizer to render the target element, then highlight
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${msgId}`);
        if (el) {
          el.classList.add("msg-highlight");
          setTimeout(() => el.classList.remove("msg-highlight"), 1000);
        }
      });
    });
  }, [virtualizer]);

  // ── Drag & Drop (Tauri native — provides full file paths) ──────
  useEffect(() => {
    if (!isActive) return;
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragging(true);
      } else if (event.payload.type === "leave") {
        setIsDragging(false);
      } else if (event.payload.type === "drop") {
        setIsDragging(false);
        const paths = event.payload.paths.map(p => String(p));
        if (paths.length > 0) {
          setDroppedFiles(paths);
          messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
          getCurrentWindow().setFocus().then(() => {
            setTimeout(() => {
              const textarea = chatContainerRef.current?.closest(".chat-view")?.querySelector("textarea");
              textarea?.focus();
            }, 100);
          }).catch(() => {});
        }
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [isActive]);

  // Click anywhere in chat → refocus textarea (unless clicking another input)
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
    if (target.closest("button, a, [role='button']")) return;
    const textarea = (e.currentTarget as HTMLElement).querySelector("textarea");
    textarea?.focus();
  }, []);

  return (
    <div
      className="chat-view"
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      tabIndex={0}
    >
      <div className="chat-main-row">
      <div className="chat-main-col">
      <div ref={chatContainerRef} className="chat-messages" role="log" aria-live="polite" aria-label="Conversation">
      <div className="chat-messages-inner">
        {messages.length === 0 && !streamingIdRef.current && !thinkingIdRef.current && inputState === "idle" && (
          <div className="chat-msg chat-msg--status">Starting agent...</div>
        )}
        {/* Virtualized message list */}
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const content = (() => {
              switch (msg.role) {
                case "user":
                  return <UserMessage text={msg.text} />;
                case "assistant":
                  return <><MessageBubble text={msg.text} streaming={msg.streaming} />{!msg.streaming && <CopyMessageBtn text={msg.text} />}</>;
                case "tool":
                  return <ToolCard tool={msg.tool} input={msg.input} output={msg.output} success={msg.success} />;
                case "permission":
                  return <PermissionCard tool={msg.tool} description={msg.description} suggestions={msg.suggestions} resolved={msg.resolved} allowed={msg.allowed} onRespond={(allow, sugg) => handlePermissionRespond(msg.id, allow, sugg)} />;
                case "ask":
                  return <AskQuestionCard questions={msg.questions} resolved={msg.resolved} answers={msg.answers} onRespond={(answers) => handleAskUserRespond(msg.id, answers)} />;
                case "thinking":
                  if (hideThinking) {
                    if (msg.ended) return null;
                    return <div className="thinking-spinner"><span className="thinking-spinner-dot" /><span className="thinking-spinner-label">thinking...</span></div>;
                  }
                  return <ThinkingBlock text={msg.text} ended={msg.ended} />;
                case "result":
                  return <ResultBar cost={msg.cost} inputTokens={msg.inputTokens} outputTokens={msg.outputTokens} cacheReadTokens={msg.cacheReadTokens} turns={msg.turns} durationMs={msg.durationMs} />;
                case "error":
                  return <ErrorCard code={msg.code} message={msg.message} />;
                case "status":
                  return <>[{msg.model}] {msg.status}</>;
                default:
                  return null;
              }
            })();
            if (content === null) return (
              <div key={msg.id} data-index={virtualRow.index} ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, height: 0, overflow: "hidden" }} />
            );
            return (
              <div
                key={msg.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                id={`msg-${msg.id}`}
                className={`chat-msg chat-msg--${msg.role}`}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              >
                {content}
              </div>
            );
          })}
        </div>
        {/* Thinking rendered outside virtual list — avoids O(n) array copy per delta */}
        {thinkingIdRef.current && !hideThinking && (
          <div className="chat-msg chat-msg--thinking">
            <ThinkingBlock text={thinkingTextRef.current} ended={false} />
          </div>
        )}
        {/* Streaming message rendered outside virtual list — avoids O(n) array copy per chunk */}
        {streamingIdRef.current && (
          <div className="chat-msg chat-msg--assistant">
            <MessageBubble text={streamingTextRef.current} streaming={true} />
          </div>
        )}
        {/* Terminal mode: input inside scrollable area */}
        {inputStyle === "terminal" && inputState === "awaiting_input" && (
          <ChatInput
            onSubmit={handleSubmit}
            onCommand={handleCommand}
            disabled={false}
            processing={false}
            isActive={isActive}
            inputStyle="terminal"
            sdkCommands={sdkCommands}
            sdkAgents={sdkAgents}
            droppedFiles={droppedFiles}
            onDroppedFilesConsumed={handleDroppedFilesConsumed}
          />
        )}
        {inputStyle === "terminal" && inputState === "processing" && !hasUnresolvedPermission && (
          <ChatInput
            onSubmit={handleSubmit}
            onCommand={handleCommand}
            disabled={true}
            processing={true}
            isActive={isActive}
            inputStyle="terminal"
            sdkCommands={sdkCommands}
            sdkAgents={sdkAgents}
            droppedFiles={droppedFiles}
            onDroppedFilesConsumed={handleDroppedFilesConsumed}
          />
        )}
        <div ref={messagesEndRef} />
      </div>
      </div>
      {/* Chat mode: input below scrollable area (fixed) */}
      {inputStyle !== "terminal" && inputState === "awaiting_input" && (
        <ChatInput
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          disabled={false}
          processing={false}
          isActive={isActive}
          inputStyle="chat"
          sdkCommands={sdkCommands}
          sdkAgents={sdkAgents}
          droppedFiles={droppedFiles}
          onDroppedFilesConsumed={handleDroppedFilesConsumed}
        />
      )}
      {inputStyle !== "terminal" && inputState === "processing" && !hasUnresolvedPermission && (
        <ChatInput
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          disabled={true}
          processing={true}
          isActive={isActive}
          inputStyle="chat"
          sdkCommands={sdkCommands}
          sdkAgents={sdkAgents}
          droppedFiles={droppedFiles}
          onDroppedFilesConsumed={handleDroppedFilesConsumed}
        />
      )}
      {/* Floating mini-input for terminal mode when scrolled up */}
      {inputStyle === "terminal" && showMiniInput && inputState === "awaiting_input" && (
        <div className="chat-mini-input" onClick={() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
          setShowMiniInput(false);
        }}>
          <span className="chat-mini-input-hint">Scroll down to input</span>
        </div>
      )}
      </div>{/* end chat-main-col */}
      {sidebarOpen && (
        <RightSidebar messages={deferredMessages} agentTasks={agentTasks} onScrollToMessage={handleScrollToMessage} scrollContainerRef={chatContainerRef} />
      )}
      </div>{/* end chat-main-row */}
      <div className="chat-bottom-bar">
        <div className="chat-bottom-bar-info">
          <span className="chat-bottom-bar-model">{MODELS[modelIdx]?.display || "?"}</span>
          <span className="chat-bottom-bar-sep">|</span>
          <span className={`chat-bottom-bar-effort ${EFFORTS[effortIdx] || "high"}`}>{EFFORTS[effortIdx] || "high"}</span>
        </div>
        {stats.cost > 0 && (
          <div className="chat-bottom-bar-stats">
            <span className="chat-bottom-bar-cost">${stats.cost.toFixed(3)}</span>
            <span className="chat-bottom-bar-sep">&middot;</span>
            <span className="chat-bottom-bar-stat" title={`In: ${fmtTokens(stats.inputTokens)} · Out: ${fmtTokens(stats.outputTokens)} · Cache R: ${fmtTokens(stats.cacheReadTokens)} · Cache W: ${fmtTokens(stats.cacheWriteTokens)}`}>
              {fmtTokens(stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens)} tok
            </span>
            <span className="chat-bottom-bar-sep">&middot;</span>
            <span className="chat-bottom-bar-stat">{stats.turns} turn{stats.turns !== 1 ? "s" : ""}</span>
            <span className="chat-bottom-bar-sep">&middot;</span>
            <span className="chat-bottom-bar-stat">{(stats.durationMs / 1000).toFixed(0)}s</span>
          </div>
        )}
        <div className="chat-bottom-bar-meters">
          {stats.tokens > 0 && stats.contextWindow > 0 && (
            <div className="chat-usage-bar" title={`Context: ${(stats.tokens / 1000).toFixed(0)}k / ${(stats.contextWindow / 1000).toFixed(0)}k tokens`}>
              <span className="chat-usage-bar-label">context</span>
              <div className="chat-usage-bar-track">
                <div
                  className={`chat-usage-bar-fill${stats.tokens / stats.contextWindow > 0.8 ? " warn" : ""}`}
                  style={{ width: `${Math.min((stats.tokens / stats.contextWindow) * 100, 100)}%` }}
                />
              </div>
              <span className="chat-usage-bar-pct">{Math.round((stats.tokens / stats.contextWindow) * 100)}%</span>
            </div>
          )}
          {stats.rateLimitUtil > 0 && (
            <div className="chat-usage-bar" title={`Rate limit: ${Math.round(stats.rateLimitUtil * 100)}%`}>
              <span className="chat-usage-bar-label">quota</span>
              <div className="chat-usage-bar-track">
                <div
                  className={`chat-usage-bar-fill${stats.rateLimitUtil > 0.8 ? " warn" : ""}`}
                  style={{ width: `${Math.min(stats.rateLimitUtil * 100, 100)}%` }}
                />
              </div>
              <span className="chat-usage-bar-pct">{Math.round(stats.rateLimitUtil * 100)}%</span>
            </div>
          )}
        </div>
        {inputStyle === "terminal" && (
          <button
            className="chat-bottom-bar-attach"
            title="Attach files"
            aria-label="Attach files"
            onClick={handleAttachClick}
          >
            +
          </button>
        )}
        <button
          className={`chat-bottom-bar-sidebar-toggle${sidebarOpen ? " active" : ""}`}
          title={sidebarOpen ? "Hide sidebar (Ctrl+Shift+S)" : "Show sidebar (Ctrl+Shift+S)"}
          aria-label="Toggle right sidebar"
          onClick={() => setSidebarOpen(prev => !prev)}
        >
          &#9776;
        </button>
      </div>
      {isDragging && (
        <div className="chat-drop-overlay">
          <span className="chat-drop-overlay-text">Drop files here</span>
        </div>
      )}
    </div>
  );
});
