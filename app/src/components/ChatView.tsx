import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, respondPermission, refreshCommands } from "../hooks/useAgentSession";
import { MODELS, EFFORTS } from "../types";
import type { AgentEvent, Attachment, ChatMessage, PermissionSuggestion, SlashCommand, AgentInfoSDK } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { sanitizeInput } from "../utils/sanitizeInput";
import ChatInput from "./chat/ChatInput";
import type { Command } from "./chat/CommandMenu";
import MessageBubble from "./chat/MessageBubble";
import ToolCard from "./chat/ToolCard";
import PermissionCard from "./chat/PermissionCard";
import ThinkingBlock from "./chat/ThinkingBlock";
import ResultBar from "./chat/ResultBar";
import RightSidebar from "./chat/RightSidebar";
import "./ChatView.css";

interface ChatViewProps {
  tabId: string;
  projectPath: string;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
  systemPrompt: string;
  isActive: boolean;
  onSessionCreated: (tabId: string, sessionId: string) => void;
  onNewOutput: (tabId: string) => void;
  onExit: (tabId: string, code: number) => void;
  onError: (tabId: string, msg: string) => void;
  onTaglineChange?: (tabId: string, tagline: string) => void;
  inputStyle?: "chat" | "terminal";
  plugins?: string[];
  resumeSessionId?: string;
  forkSessionId?: string;
}

export default memo(function ChatView({
  tabId, projectPath, modelIdx, effortIdx, skipPerms, systemPrompt,
  isActive,
  onSessionCreated, onNewOutput, onExit, onError, onTaglineChange,
  inputStyle = "terminal", plugins = [], resumeSessionId, forkSessionId,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputState] = useState<"idle" | "awaiting_input" | "processing">("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showMiniInput, setShowMiniInput] = useState(false);
  const [rateLimitUtil, setRateLimitUtil] = useState(0);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [contextWindow, setContextWindow] = useState(0);
  const [sdkCommands, setSdkCommands] = useState<SlashCommand[]>([]);
  const [sdkAgents, setSdkAgents] = useState<AgentInfoSDK[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tabIdRef = useRef(tabId);
  const dragCounterRef = useRef(0);
  // StrictMode kill-cancellation: cleanup sets true, re-mount sets false.
  // Deferred kill only fires if still true (real unmount, not StrictMode).
  const pendingKillRef = useRef(false);
  const idCounterRef = useRef(0);
  const nextId = () => `msg-${tabId}-${++idCounterRef.current}`;

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

  // Auto-scroll on new messages — only if user is near the bottom
  const chatContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages]);

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

  // ── Agent lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    pendingKillRef.current = false; // Cancel any deferred kill from StrictMode cleanup
    setMessages([]);               // Clear stale messages from previous StrictMode mount
    setInputState("idle");
    let cancelled = false;

    const modelId = MODELS[modelIdx]?.id || "";
    const effortId = EFFORTS[effortIdx] || "high";

    // Mutable ref for streaming assistant text accumulation
    let streamingMsgId: string | null = null;
    let streamingText = "";

    // Extracted helper: finalize any pending streaming message
    const finalizeStreaming = () => {
      if (!streamingMsgId) return;
      const id = streamingMsgId;
      const finalText = streamingText;
      streamingMsgId = null;
      streamingText = "";
      setMessages(prev => prev.map(m => m.id === id ? { ...m, text: finalText, streaming: false } as ChatMessage : m));
    };

    const handleAgentEvent = (event: AgentEvent) => {
      if (cancelled) return;

      if (event.type === "assistant") {
        if (event.streaming) {
          // Accumulate streaming text into one message
          if (!streamingMsgId) {
            streamingMsgId = nextId();
            streamingText = event.text;
          } else {
            streamingText += event.text;
          }
          const id = streamingMsgId;
          const text = streamingText;
          // Streaming message is always the last — update in-place or append
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.id === id) {
              const next = [...prev];
              next[next.length - 1] = { ...last, text, streaming: true } as ChatMessage;
              return next;
            }
            return [...prev, { id, role: "assistant", text, streaming: true, timestamp: Date.now() }];
          });
        } else {
          // Complete message — finalize streaming or add new
          if (streamingMsgId) {
            finalizeStreaming();
          } else {
            setMessages(prev => [...prev, { id: nextId(), role: "assistant", text: event.text, streaming: false, timestamp: Date.now() }]);
          }
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "toolUse") {
        finalizeStreaming();
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
      } else if (event.type === "inputRequired") {
        finalizeStreaming();
        setInputState("awaiting_input");
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "thinking") {
        finalizeStreaming();
        // Show or update thinking message
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === "thinking") {
            const next = [...prev];
            next[next.length - 1] = { ...last, text: last.text + event.text };
            return next;
          }
          return [...prev, { id: nextId(), role: "thinking", text: event.text, timestamp: Date.now() }];
        });
        onTaglineChangeRef.current?.(tabIdRef.current, "Thinking...");
      } else if (event.type === "result") {
        finalizeStreaming();
        // Accumulate session token count for context bar
        setSessionTokens(prev => prev + (event.inputTokens || 0) + (event.outputTokens || 0));
        if (event.contextWindow > 0) setContextWindow(event.contextWindow);
        // Mark thinking messages as ended (collapsed), add result
        setMessages(prev => [
          ...prev.map(m => m.role === "thinking" && !m.ended ? { ...m, ended: true } as ChatMessage : m),
          { id: nextId(), role: "result", ...event, timestamp: Date.now() },
        ]);
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "error") {
        setMessages(prev => [...prev, { id: nextId(), role: "error", code: event.code, message: event.message, timestamp: Date.now() }]);
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
      } else if (event.type === "rateLimit") {
        setRateLimitUtil(event.utilization);
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

    const launchPromise = resumeSessionId
      ? resumeAgent(tabId, resumeSessionId, projectPath, modelId, effortId, plugins, handleAgentEvent)
      : forkSessionId
        ? forkAgent(tabId, forkSessionId, projectPath, modelId, effortId, plugins, handleAgentEvent)
        : spawnAgent(tabId, projectPath, modelId, effortId, sanitizeInput(systemPrompt), skipPerms, plugins, handleAgentEvent);

    launchPromise
      .then(() => {
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
  const handleSubmit = (text: string, attachments: Attachment[]) => {
    if (!agentStartedRef.current) return;
    // Build message with attachment paths prepended
    let fullText = text;
    if (attachments.length > 0) {
      const attachPrefix = attachments.map(a => `[Attached: ${a.path}]`).join("\n");
      fullText = attachPrefix + (text ? "\n\n" + text : "");
    }
    if (!fullText.trim()) return;
    setMessages(prev => [...prev, { id: nextId(), role: "user", text: fullText, timestamp: Date.now() }]);
    setInputState("processing");
    sendAgentMessage(tabId, fullText).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "send", message: String(err), timestamp: Date.now() }]);
    });
  };

  // ── Permission response ─────────────────────────────────────────
  const respondedIdsRef = useRef(new Set<string>());
  const handlePermissionRespond = (msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => {
    // Guard against double-click race
    if (respondedIdsRef.current.has(msgId)) return;
    respondedIdsRef.current.add(msgId);
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "permission" ? { ...m, resolved: true, allowed: allow } : m
    ));
    respondPermission(tabId, allow, suggestions).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "permission", message: String(err), timestamp: Date.now() }]);
    });
  };

  // ── Scroll to message (for sidebar navigation) ─────────────────
  const handleScrollToMessage = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      setTimeout(() => el.classList.remove("msg-highlight"), 1000);
    }
  };

  // ── Keyboard: Ctrl+C to interrupt, Ctrl+B toggle sidebar ──────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c" && inputState === "processing") {
      killAgent(tabId).catch(() => {});
    }
    if (e.ctrlKey && e.key === "b") {
      e.preventDefault();
      setSidebarOpen(prev => !prev);
    }
  };

  // ── Slash commands ─────────────────────────────────────────────
  const handleCommand = (command: Command) => {
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
    }
  };

  // ── Stable callbacks for ChatInput memo ─────────────────────────
  const handleDroppedFilesConsumed = useCallback(() => setDroppedFiles([]), []);

  // ── Derived state (O(1) in render) ────────────────────────────
  const hasUnresolvedPermission = useMemo(
    () => messages.some(m => m.role === "permission" && !m.resolved),
    [messages],
  );

  // ── Deferred messages for sidebar (skip re-renders during streaming)
  const deferredMessages = useDeferredValue(messages);

  // ── Drag & Drop ─────────────────────────────────────────────────
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const paths = files.map(f => (f as File & { path?: string }).path || f.name);
      setDroppedFiles(paths);
    }
  };

  return (
    <div
      className="chat-view"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="chat-main-row">
      <div className="chat-main-col">
      <div ref={chatContainerRef} className="chat-messages" role="log" aria-live="polite" aria-label="Conversation">
      <div className="chat-messages-inner">
        {messages.length === 0 && inputState === "idle" && (
          <div className="chat-msg chat-msg--status">Starting agent...</div>
        )}
        {messages.map((msg) => {
          switch (msg.role) {
            case "user":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--user">{msg.text}</div>;
            case "assistant":
              return (
                <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--assistant">
                  <MessageBubble text={msg.text} streaming={msg.streaming} />
                </div>
              );
            case "tool":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--tool"><ToolCard tool={msg.tool} input={msg.input} output={msg.output} success={msg.success} /></div>;
            case "permission":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--permission"><PermissionCard tool={msg.tool} description={msg.description} suggestions={msg.suggestions} resolved={msg.resolved} allowed={msg.allowed} onRespond={(allow, sugg) => handlePermissionRespond(msg.id, allow, sugg)} /></div>;
            case "thinking":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--thinking"><ThinkingBlock text={msg.text} ended={msg.ended} /></div>;
            case "result":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--result"><ResultBar cost={msg.cost} inputTokens={msg.inputTokens} outputTokens={msg.outputTokens} cacheReadTokens={msg.cacheReadTokens} turns={msg.turns} durationMs={msg.durationMs} /></div>;
            case "error":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--error"><strong>error:</strong> {msg.message}</div>;
            case "status":
              return <div key={msg.id} id={`msg-${msg.id}`} className="chat-msg chat-msg--status">[{msg.model}] {msg.status}</div>;
            default:
              return null;
          }
        })}
        {/* Terminal mode: input inside scrollable area (both awaiting and processing) */}
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
          onDroppedFilesConsumed={() => setDroppedFiles([])}
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
          onDroppedFilesConsumed={() => setDroppedFiles([])}
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
        <RightSidebar messages={deferredMessages} onScrollToMessage={handleScrollToMessage} />
      )}
      </div>{/* end chat-main-row */}
      <div className="chat-bottom-bar">
        <div className="chat-bottom-bar-info">
          <span className="chat-bottom-bar-model">{MODELS[modelIdx]?.display || "?"}</span>
          <span className="chat-bottom-bar-sep">|</span>
          <span className={`chat-bottom-bar-effort ${EFFORTS[effortIdx] || "high"}`}>{EFFORTS[effortIdx] || "high"}</span>
        </div>
        <div className="chat-bottom-bar-meters">
          {sessionTokens > 0 && contextWindow > 0 && (
            <div className="chat-usage-bar" title={`Context: ${(sessionTokens / 1000).toFixed(0)}k / ${(contextWindow / 1000).toFixed(0)}k tokens`}>
              <span className="chat-usage-bar-label">context</span>
              <div className="chat-usage-bar-track">
                <div
                  className={`chat-usage-bar-fill${sessionTokens / contextWindow > 0.8 ? " warn" : ""}`}
                  style={{ width: `${Math.min((sessionTokens / contextWindow) * 100, 100)}%` }}
                />
              </div>
              <span className="chat-usage-bar-pct">{Math.round((sessionTokens / contextWindow) * 100)}%</span>
            </div>
          )}
          {rateLimitUtil > 0 && (
            <div className="chat-usage-bar" title={`Rate limit: ${Math.round(rateLimitUtil * 100)}%`}>
              <span className="chat-usage-bar-label">quota</span>
              <div className="chat-usage-bar-track">
                <div
                  className={`chat-usage-bar-fill${rateLimitUtil > 0.8 ? " warn" : ""}`}
                  style={{ width: `${Math.min(rateLimitUtil * 100, 100)}%` }}
                />
              </div>
              <span className="chat-usage-bar-pct">{Math.round(rateLimitUtil * 100)}%</span>
            </div>
          )}
        </div>
        {inputStyle === "terminal" && (
          <button
            className="chat-bottom-bar-attach"
            title="Attach files"
            aria-label="Attach files"
            onClick={async () => {
              try {
                const result = await open({ multiple: true });
                if (result) {
                  const paths = Array.isArray(result) ? result : [result];
                  setDroppedFiles(paths);
                }
              } catch { /* cancelled */ }
            }}
          >
            +
          </button>
        )}
      </div>
      {isDragging && (
        <div className="chat-drop-overlay">
          <span className="chat-drop-overlay-text">Drop files here</span>
        </div>
      )}
    </div>
  );
});
