import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MODELS, EFFORTS, PERM_MODES } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { fmtTokens } from "../utils/format";
import { messagesToMarkdown } from "../utils/exportSession";
import type { SessionViewProps } from "./SessionViewProps";
import ChatInput from "./chat/ChatInput";
import type { Command } from "./chat/CommandMenu";
import MessageBubble from "./chat/MessageBubble";
import ToolCard from "./chat/ToolCard";
import ToolGroup from "./chat/ToolGroup";
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

export default memo(function ChatView(props: SessionViewProps) {
  const {
    modelIdx, effortIdx, permModeIdx, isActive,
    hideThinking,
    controller: ctrl,
    onConfigChange,
  } = props;

  const {
    messages, displayItems, deferredMessages,
    inputState, stats, agentTasks, sdkCommands, sdkAgents,
    hasUnresolvedPermission,
    streamingTextRef, streamingIdRef, streamingTick,
    thinkingTextRef, thinkingIdRef, thinkingTick,
    messagesEndRef,
    handleSubmit, handlePermissionRespond, handleAskUserRespond,
    handleCommand, handleInterrupt, handleBackground,
    queueLength, backgrounded,
    droppedFiles, setDroppedFiles, handleDroppedFilesConsumed,
  } = ctrl;

  const [isDragging, setIsDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Search: find matching displayItem indices
  const searchMatches = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const matches: number[] = [];
    displayItems.forEach((item, i) => {
      if (item.role === "tool-group") {
        if (item.tools.some(t => t.tool.toLowerCase().includes(q) || String(t.input).toLowerCase().includes(q) || (t.output || "").toLowerCase().includes(q))) {
          matches.push(i);
        }
      } else if (item.role === "user" || item.role === "assistant") {
        if (item.text.toLowerCase().includes(q)) matches.push(i);
      } else if (item.role === "tool") {
        if (item.tool.toLowerCase().includes(q) || String(item.input).toLowerCase().includes(q) || (item.output || "").toLowerCase().includes(q)) {
          matches.push(i);
        }
      } else if (item.role === "error") {
        if (item.message.toLowerCase().includes(q)) matches.push(i);
      }
    });
    return matches;
  }, [displayItems, searchQuery]);

  // Auto-scroll on new messages or streaming updates
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, streamingTick, thinkingTick, messagesEndRef]);


  // Auto-focus textarea when window regains focus
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

  // Keyboard shortcuts — Ctrl+C copies selection or interrupts agent
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c") {
      if (window.getSelection()?.toString()) return; // let browser copy
      handleInterrupt();
    } else if (e.ctrlKey && e.key === "b") {
      e.preventDefault();
      if (inputState === "processing") {
        handleBackground();
      } else {
        setSidebarOpen(prev => !prev);
      }
    } else if (e.ctrlKey && e.key === "f") {
      e.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      (async () => {
        const path = await save({
          defaultPath: `session-${new Date().toISOString().slice(0, 10)}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (path) {
          const md = messagesToMarkdown(messages, "Session");
          await invoke("write_text_file", { path, content: md });
        }
      })();
    }
  }, [handleInterrupt, handleBackground, inputState, messages]);

  // Wrap handleCommand to intercept /sidebar
  const handleCommandWrapped = useCallback((command: Command) => {
    if (command.name === "/sidebar") {
      setSidebarOpen(prev => !prev);
      return;
    }
    handleCommand(command);
  }, [handleCommand]);

  // Virtualizer
  const displayItemsRef = useRef(displayItems);
  displayItemsRef.current = displayItems;

  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => chatContainerRef.current,
    estimateSize: () => 60,
    overscan: 15,
    getItemKey: (index) => displayItems[index].id,
  });

  // Scroll to message (for sidebar navigation)
  const handleScrollToMessage = useCallback((msgId: string) => {
    const index = displayItemsRef.current.findIndex(item =>
      item.role === "tool-group" ? item.tools.some(t => t.id === msgId) : item.id === msgId
    );
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
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

  // Drag & Drop
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
  }, [isActive, setDroppedFiles, messagesEndRef]);

  // Click anywhere in chat -> refocus textarea
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
    if (target.closest("button, a, [role='button']")) return;
    if (window.getSelection()?.toString()) return;
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
      {searchOpen && (
        <div className="chat-search-bar">
          <input
            ref={searchInputRef}
            className="chat-search-input"
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              } else if (e.key === "Enter" && searchMatches.length > 0) {
                e.preventDefault();
                const next = e.shiftKey
                  ? (searchIdx - 1 + searchMatches.length) % searchMatches.length
                  : (searchIdx + 1) % searchMatches.length;
                setSearchIdx(next);
                virtualizer.scrollToIndex(searchMatches[next], { align: "center", behavior: "smooth" });
              }
            }}
          />
          {searchQuery && (
            <span className="chat-search-count">
              {searchMatches.length > 0 ? `${searchIdx + 1} of ${searchMatches.length}` : "No matches"}
            </span>
          )}
          <button
            className="chat-search-close"
            onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
            aria-label="Close search"
          >
            {"\u2715"}
          </button>
        </div>
      )}
      <div className="chat-messages-inner">
        {messages.length === 0 && !streamingIdRef.current && !thinkingIdRef.current && inputState === "idle" && (
          <div className="chat-msg chat-msg--status">Starting agent...</div>
        )}
        {/* Virtualized message list */}
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = displayItems[virtualRow.index];
            const content = (() => {
              if (item.role === "tool-group") return <ToolGroup tools={item.tools} />;
              const msg = item;
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
                case "history-separator":
                  return <div className="history-separator"><span>previous session</span></div>;
                default:
                  return null;
              }
            })();
            if (content === null) return (
              <div key={item.id} data-index={virtualRow.index} ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, height: 0, overflow: "hidden" }} />
            );
            const roleClass = item.role === "tool-group" ? "tool" : item.role;
            return (
              <div
                key={item.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                id={`msg-${item.id}`}
                className={`chat-msg chat-msg--${roleClass}${item.id.startsWith("hist-") ? " chat-msg--history" : ""}`}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              >
                {content}
              </div>
            );
          })}
        </div>
        {/* Thinking rendered outside virtual list */}
        {thinkingIdRef.current && !hideThinking && (
          <div className="chat-msg chat-msg--thinking" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            <ThinkingBlock text={thinkingTextRef.current} ended={false} />
          </div>
        )}
        {/* Streaming message rendered outside virtual list */}
        {streamingIdRef.current && (
          <div className="chat-msg chat-msg--assistant">
            <MessageBubble text={streamingTextRef.current} streaming={true} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      </div>
      {/* Chat input below scrollable area (fixed) — always visible when session is active */}
      {inputState !== "idle" && !hasUnresolvedPermission && (
        <ChatInput
          onSubmit={handleSubmit}
          onCommand={handleCommandWrapped}
          processing={inputState === "processing"}
          isActive={isActive}
          inputStyle="chat"
          sdkCommands={sdkCommands}
          sdkAgents={sdkAgents}
          droppedFiles={droppedFiles}
          onDroppedFilesConsumed={handleDroppedFilesConsumed}
          queueLength={queueLength}
        />
      )}
      </div>{/* end chat-main-col */}
      {sidebarOpen && (
        <RightSidebar messages={deferredMessages} agentTasks={agentTasks} onScrollToMessage={handleScrollToMessage} scrollContainerRef={chatContainerRef} />
      )}
      </div>{/* end chat-main-row */}
      <div className="chat-bottom-bar">
        <div className="chat-bottom-bar-info">
          <span className={`chat-status-dot${inputState === "processing" ? " active" : inputState === "awaiting_input" ? " idle" : ""}`} title={inputState === "processing" ? "Processing" : inputState === "awaiting_input" ? "Ready" : "Connecting"} />
          {backgrounded && <span className="chat-bottom-bar-bg-badge">BG</span>}
          {queueLength > 0 && <span className="chat-bottom-bar-queue-badge">{queueLength} queued</span>}
          <button
            className="chat-bottom-bar-pill"
            title="Click to cycle model (F4)"
            onClick={() => onConfigChange?.({ modelIdx: (modelIdx + 1) % MODELS.length })}
          >{MODELS[modelIdx]?.display || "?"}</button>
          <span className="chat-bottom-bar-sep">|</span>
          <button
            className={`chat-bottom-bar-pill chat-bottom-bar-effort ${EFFORTS[effortIdx] || "high"}`}
            title="Click to cycle effort (F2)"
            onClick={() => onConfigChange?.({ effortIdx: (effortIdx + 1) % EFFORTS.length })}
          >{EFFORTS[effortIdx] || "high"}</button>
          <span className="chat-bottom-bar-sep">|</span>
          <button
            className={`chat-bottom-bar-pill chat-bottom-bar-perm ${PERM_MODES[permModeIdx]?.sdk || "plan"}`}
            title="Click to cycle permission mode (Tab)"
            onClick={() => onConfigChange?.({ permModeIdx: (permModeIdx + 1) % PERM_MODES.length })}
          >{PERM_MODES[permModeIdx]?.display || "plan"}</button>
        </div>
        <div className="chat-bottom-bar-stats">
          <span className="chat-bottom-bar-cost">${stats.cost.toFixed(3)}</span>
          <span className="chat-bottom-bar-sep">&middot;</span>
          <span className="chat-bottom-bar-stat" title={`In: ${fmtTokens(stats.inputTokens)} · Out: ${fmtTokens(stats.outputTokens)} · Cache R: ${fmtTokens(stats.cacheReadTokens)} · Cache W: ${fmtTokens(stats.cacheWriteTokens)}`}>
            {fmtTokens(stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens)} tok
          </span>
          <span className="chat-bottom-bar-sep">&middot;</span>
          <span className="chat-bottom-bar-stat">{stats.turns}t</span>
          <span className="chat-bottom-bar-sep">&middot;</span>
          <span className="chat-bottom-bar-stat">{(stats.durationMs / 1000).toFixed(0)}s</span>
        </div>
        <div className="chat-bottom-bar-meters">
          <div className="chat-usage-bar" title={stats.contextWindow > 0 ? `Context: ${(stats.tokens / 1000).toFixed(0)}k / ${(stats.contextWindow / 1000).toFixed(0)}k tokens` : "Context window"}>
            <span className="chat-usage-bar-label">ctx</span>
            <div className="chat-usage-bar-track">
              {stats.contextWindow > 0 && (
                <div
                  className={`chat-usage-bar-fill${stats.tokens / stats.contextWindow > 0.8 ? " warn" : ""}`}
                  style={{ width: `${Math.min((stats.tokens / stats.contextWindow) * 100, 100)}%` }}
                />
              )}
            </div>
            <span className="chat-usage-bar-pct">{stats.contextWindow > 0 ? `${Math.round((stats.tokens / stats.contextWindow) * 100)}%` : "—"}</span>
          </div>
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
