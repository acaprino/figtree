import { memo, useEffect, useRef, useState } from "react";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, respondPermission } from "../hooks/useAgentSession";
import { MODELS, EFFORTS } from "../types";
import type { AgentEvent, ThemeColors, ChatMessage, PermissionSuggestion } from "../types";
import MessageBubble from "./chat/MessageBubble";
import ToolCard from "./chat/ToolCard";
import PermissionCard from "./chat/PermissionCard";
import ThinkingIndicator from "./chat/ThinkingIndicator";
import ResultBar from "./chat/ResultBar";
import "./ChatView.css";

let msgCounter = 0;
const nextId = () => `msg-${++msgCounter}`;

/** Strip non-BMP characters (emoji etc.) that cause issues in agent messages. */
function stripNonBmp(text: string): string {
  return text.replace(/[\uD800-\uDFFF]|[\u{10000}-\u{10FFFF}]/gu, "");
}

interface ChatViewProps {
  tabId: string;
  projectPath: string;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
  systemPrompt: string;
  themeColors: ThemeColors;
  fontFamily: string;
  fontSize: number;
  isActive: boolean;
  onSessionCreated: (tabId: string, sessionId: string) => void;
  onNewOutput: (tabId: string) => void;
  onExit: (tabId: string, code: number) => void;
  onError: (tabId: string, msg: string) => void;
  onRequestClose: (tabId: string) => void;
  onAgentResult?: (tabId: string, event: AgentEvent) => void;
  onTaglineChange?: (tabId: string, tagline: string) => void;
  autocompleteEnabled?: boolean;
  resumeSessionId?: string;
  forkSessionId?: string;
}

export default memo(function ChatView({
  tabId, projectPath, modelIdx, effortIdx, skipPerms, systemPrompt,
  themeColors: _themeColors, fontFamily, fontSize, isActive,
  onSessionCreated, onNewOutput, onExit, onError, onRequestClose: _onRequestClose,
  onAgentResult, onTaglineChange,
  resumeSessionId, forkSessionId,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputState] = useState<"idle" | "awaiting_input" | "processing">("idle");
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
  const tabIdRef = useRef(tabId);

  // Callback refs to avoid stale closures in useEffect
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  const onNewOutputRef = useRef(onNewOutput);
  onNewOutputRef.current = onNewOutput;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onAgentResultRef = useRef(onAgentResult);
  onAgentResultRef.current = onAgentResult;
  const onTaglineChangeRef = useRef(onTaglineChange);
  onTaglineChangeRef.current = onTaglineChange;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when active + awaiting input
  useEffect(() => {
    if (isActive && inputState === "awaiting_input") {
      inputRef.current?.focus();
    }
  }, [isActive, inputState]);

  // ── Agent lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const modelId = MODELS[modelIdx]?.id || "";
    const effortId = EFFORTS[effortIdx] || "high";

    // Mutable ref for streaming assistant text accumulation
    let streamingMsgId: string | null = null;
    let streamingText = "";

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
          setMessages(prev => {
            const existing = prev.findIndex(m => m.id === id);
            const msg: ChatMessage = { id, role: "assistant", text, streaming: true, timestamp: Date.now() };
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = msg;
              return next;
            }
            return [...prev, msg];
          });
        } else {
          // Complete message — finalize streaming or add new
          if (streamingMsgId) {
            const id = streamingMsgId;
            const text = streamingText;
            streamingMsgId = null;
            streamingText = "";
            setMessages(prev => prev.map(m => m.id === id ? { ...m, text, streaming: false } as ChatMessage : m));
          } else {
            setMessages(prev => [...prev, { id: nextId(), role: "assistant", text: event.text, streaming: false, timestamp: Date.now() }]);
          }
        }
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "toolUse") {
        // Finalize any streaming assistant text
        if (streamingMsgId) {
          const id = streamingMsgId;
          setMessages(prev => prev.map(m => m.id === id ? { ...m, streaming: false } as ChatMessage : m));
          streamingMsgId = null;
          streamingText = "";
        }
        setMessages(prev => [...prev, { id: nextId(), role: "tool", tool: event.tool, input: event.input, timestamp: Date.now() }]);
        const inp = event.input as Record<string, string> | undefined;
        const detail = event.tool === "Bash" ? (inp?.command || "").slice(0, 40)
          : event.tool === "Edit" || event.tool === "Write" || event.tool === "Read"
            ? (inp?.file_path || "").split(/[/\\]/).pop() || ""
            : "";
        onTaglineChangeRef.current?.(tabIdRef.current, detail ? `${event.tool}: ${detail}` : event.tool);
      } else if (event.type === "toolResult") {
        // Update the most recent tool message with output
        setMessages(prev => {
          const idx = [...prev].reverse().findIndex(m => m.role === "tool" && !("output" in m && m.output));
          if (idx >= 0) {
            const realIdx = prev.length - 1 - idx;
            const next = [...prev];
            const m = next[realIdx];
            if (m.role === "tool") {
              next[realIdx] = { ...m, output: event.output, success: event.success };
            }
            return next;
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
        setInputState("awaiting_input");
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "thinking") {
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
        // Remove thinking messages, add result
        setMessages(prev => [
          ...prev.filter(m => m.role !== "thinking"),
          { id: nextId(), role: "result", ...event, timestamp: Date.now() },
        ]);
        onAgentResultRef.current?.(tabIdRef.current, event);
        onTaglineChangeRef.current?.(tabIdRef.current, "");
      } else if (event.type === "error") {
        setMessages(prev => [...prev, { id: nextId(), role: "error", code: event.code, message: event.message, timestamp: Date.now() }]);
      } else if (event.type === "exit") {
        exitedRef.current = true;
        onExitRef.current(tabIdRef.current, event.code);
      } else if (event.type === "status") {
        if (event.status && event.status !== "null") {
          setMessages(prev => [...prev, { id: nextId(), role: "status", status: event.status, model: event.model, timestamp: Date.now() }]);
        }
      }

      if (!isActiveRef.current) {
        onNewOutputRef.current(tabIdRef.current);
      }
    };

    const launchPromise = resumeSessionId
      ? resumeAgent(tabId, resumeSessionId, projectPath, modelId, effortId, handleAgentEvent)
      : forkSessionId
        ? forkAgent(tabId, forkSessionId, projectPath, modelId, effortId, handleAgentEvent)
        : spawnAgent(tabId, projectPath, modelId, effortId, stripNonBmp(systemPrompt), skipPerms, handleAgentEvent);

    launchPromise
      .then(() => {
        if (cancelled) { killAgent(tabId).catch(() => {}); return; }
        agentStartedRef.current = true;
        onSessionCreatedRef.current(tabIdRef.current, tabId);
      })
      .catch((err) => {
        if (cancelled) return;
        onErrorRef.current(tabIdRef.current, String(err));
      });

    return () => {
      cancelled = true;
      if (agentStartedRef.current) killAgent(tabIdRef.current).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Input submission ────────────────────────────────────────────
  const handleSubmit = () => {
    const text = inputText.trim();
    if (!text || !agentStartedRef.current) return;
    setMessages(prev => [...prev, { id: nextId(), role: "user", text, timestamp: Date.now() }]);
    setInputText("");
    setInputState("processing");
    sendAgentMessage(tabId, text).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "send", message: String(err), timestamp: Date.now() }]);
    });
  };

  // ── Permission response ─────────────────────────────────────────
  const handlePermissionRespond = (msgId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId && m.role === "permission" ? { ...m, resolved: true, allowed: allow } : m
    ));
    respondPermission(tabId, allow, suggestions).catch((err) => {
      setMessages(prev => [...prev, { id: nextId(), role: "error", code: "permission", message: String(err), timestamp: Date.now() }]);
    });
  };

  // ── Keyboard: Ctrl+C to interrupt ───────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c" && inputState === "processing") {
      killAgent(tabId).catch(() => {});
    }
  };

  return (
    <div className="chat-view" style={{ fontFamily: `'${fontFamily}', 'Consolas', monospace`, fontSize }} onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="chat-messages">
        {messages.length === 0 && inputState === "idle" && (
          <div className="chat-msg chat-msg--status">Starting agent...</div>
        )}
        {messages.map((msg) => {
          switch (msg.role) {
            case "user":
              return <div key={msg.id} className="chat-msg chat-msg--user">{msg.text}</div>;
            case "assistant":
              return <div key={msg.id} className="chat-msg chat-msg--assistant"><MessageBubble text={msg.text} streaming={msg.streaming} /></div>;
            case "tool":
              return <div key={msg.id} className="chat-msg chat-msg--tool"><ToolCard tool={msg.tool} input={msg.input} output={msg.output} success={msg.success} /></div>;
            case "permission":
              return <div key={msg.id} className="chat-msg chat-msg--permission"><PermissionCard tool={msg.tool} description={msg.description} suggestions={msg.suggestions} resolved={msg.resolved} allowed={msg.allowed} onRespond={(allow, sugg) => handlePermissionRespond(msg.id, allow, sugg)} /></div>;
            case "thinking":
              return <div key={msg.id} className="chat-msg chat-msg--thinking"><ThinkingIndicator /></div>;
            case "result":
              return <div key={msg.id} className="chat-msg chat-msg--result"><ResultBar cost={msg.cost} inputTokens={msg.inputTokens} outputTokens={msg.outputTokens} cacheReadTokens={msg.cacheReadTokens} turns={msg.turns} durationMs={msg.durationMs} /></div>;
            case "error":
              return <div key={msg.id} className="chat-msg chat-msg--error">{msg.code === "rate_limit" ? "⏳" : "⚠"} {msg.message}</div>;
            case "status":
              return <div key={msg.id} className="chat-msg chat-msg--status">[{msg.model}] {msg.status}</div>;
            default:
              return null;
          }
        })}
        <div ref={messagesEndRef} />
      </div>
      {inputState === "awaiting_input" && (
        <div className="chat-input-bar">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Type a message..."
            rows={1}
            autoFocus
          />
        </div>
      )}
      {inputState === "processing" && !messages.some(m => m.role === "permission" && !m.resolved) && (
        <div className="chat-thinking-bar"><ThinkingIndicator /></div>
      )}
    </div>
  );
});
