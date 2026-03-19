import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MODELS, EFFORTS, PERM_MODES } from "../types";
import type { DisplayItem } from "../hooks/useSessionController";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fmtTokens } from "../utils/format";
import type { SessionViewProps } from "./SessionViewProps";
import ChatInput from "./chat/ChatInput";
import AskQuestionCard from "./chat/AskQuestionCard";
import RightSidebar from "./chat/RightSidebar";
import TermToolLine from "./terminal/TermToolLine";
import TermToolGroup from "./terminal/TermToolGroup";
import TermPermPrompt from "./terminal/TermPermPrompt";
import TermThinkingLine from "./terminal/TermThinkingLine";
import TermErrorLine from "./terminal/TermErrorLine";
import { IconPlus, IconSidebar } from "./Icons";
import "./TerminalView.css";

/** Render inline markdown bold/italic/code in plain text */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, *italic*, `code`, and plain text segments
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2]) parts.push(<strong key={key++}>{match[2]}</strong>);
    else if (match[3]) parts.push(<em key={key++}>{match[3]}</em>);
    else if (match[4]) parts.push(<code key={key++} className="tv-inline-code">{match[4]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Render assistant text with inline markdown per line */
function AssistantText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="tv-assistant">
      {lines.map((line, i) => (
        <span key={i}>
          {line.includes("**") || line.includes("`") ? renderInlineMarkdown(line) : line}
          {i < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </pre>
  );
}

/** Elapsed timer — ticks every second while visible */
const ElapsedTimer = memo(function ElapsedTimer({ startTime }: { startTime: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  return <span className="tv-elapsed">{elapsed}s</span>;
});

/** Activity spinner — shows sigil + label when agent is working */
const ActivitySpinner = memo(function ActivitySpinner({ label }: { label: string }) {
  const [startTime] = useState(() => Date.now());
  return (
    <div className="tv-activity">
      <span className="tv-activity-sigil">{"\u2026"}</span>
      <span className="tv-activity-label">{label}</span>
      <ElapsedTimer startTime={startTime} />
    </div>
  );
});

export default memo(function TerminalView(props: SessionViewProps) {
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
    droppedFiles, setDroppedFiles, handleDroppedFilesConsumed, handleAttachClick,
  } = ctrl;

  const [isDragging, setIsDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sticky auto-scroll: stay pinned to bottom unless user scrolls up
  const stickyRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const atBottom = scrollHeight - scrollTop - clientHeight < 60;
      if (scrollTop < lastScrollTopRef.current && !atBottom) {
        stickyRef.current = false;
      } else if (atBottom) {
        stickyRef.current = true;
      }
      lastScrollTopRef.current = scrollTop;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // ── Turn collapsing: hide tool/thinking/permission/status noise from previous turns ──
  // A "turn" starts at each user message. Only the last turn shows full detail.
  // Previous turns keep user + assistant messages, everything else is hidden.
  const NOISE_ROLES = new Set(["tool", "tool-group", "thinking", "permission", "result"]);
  const visibleItems = useMemo((): DisplayItem[] => {
    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = displayItems.length - 1; i >= 0; i--) {
      if (displayItems[i].role === "user") { lastUserIdx = i; break; }
    }

    const result: DisplayItem[] = [];
    for (let i = 0; i < displayItems.length; i++) {
      const item = displayItems[i];
      // Always hide status messages (the "[] init" / "[] idle" noise)
      if (item.role === "status") continue;
      // Before the last user message: only show user + assistant + error + separator
      if (i < lastUserIdx && NOISE_ROLES.has(item.role)) continue;
      result.push(item);
    }
    return result;
  }, [displayItems]);

  // Auto-scroll (only when sticky)
  useEffect(() => {
    if (!stickyRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, streamingTick, thinkingTick, messagesEndRef]);

  // Auto-focus textarea when window regains focus
  useEffect(() => {
    if (!isActive) return;
    const handleWindowFocus = () => {
      requestAnimationFrame(() => {
        const textarea = scrollRef.current?.closest(".terminal-view")?.querySelector("textarea");
        textarea?.focus();
      });
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [isActive]);

  // Keyboard shortcuts — Ctrl+C copies selection or interrupts agent
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c") {
      if (window.getSelection()?.toString()) return;
      handleInterrupt();
    } else if (e.ctrlKey && e.key === "b") {
      e.preventDefault();
      if (inputState === "processing") {
        handleBackground();
      } else {
        setSidebarOpen(prev => !prev);
      }
    }
  }, [handleInterrupt, handleBackground, inputState]);

  // Virtualizer
  const displayItemsRef = useRef(visibleItems);
  displayItemsRef.current = visibleItems;

  const virtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 20,
    getItemKey: (index) => visibleItems[index].id,
  });

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
              const textarea = scrollRef.current?.closest(".terminal-view")?.querySelector("textarea");
              textarea?.focus();
            }, 100);
          }).catch((err) => console.debug("[TerminalView] setFocus after drop failed:", err));
        }
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [isActive, setDroppedFiles, messagesEndRef]);

  // Scroll to a message by ID (used by bookmark panel)
  const handleScrollToMessage = useCallback((msgId: string) => {
    const idx = displayItemsRef.current.findIndex(item => item.id === msgId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
  }, [virtualizer]);

  // Click anywhere -> refocus textarea
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
    if (target.closest("button, a, [role='button']")) return;
    const textarea = (e.currentTarget as HTMLElement).querySelector("textarea");
    textarea?.focus();
  }, []);

  return (
    <div
      className="terminal-view"
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      tabIndex={0}
    >
      <div className="tv-main-row">
      <div ref={scrollRef} className="tv-scroll" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && !streamingIdRef.current && !thinkingIdRef.current && inputState === "idle" && (
          <div className="tv-line">
            <ActivitySpinner label="Initializing session..." />
          </div>
        )}
        {/* Virtualized message list */}
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = visibleItems[virtualRow.index];
            const content = (() => {
              if (item.role === "tool-group") {
                return <TermToolGroup tools={item.tools} />;
              }
              const msg = item;
              switch (msg.role) {
                case "user":
                  return <div className="tv-user"><span className="tv-user-prompt">{"\u276F"}</span>{msg.text}</div>;
                case "assistant":
                  return <AssistantText text={msg.text} />;
                case "tool":
                  return <TermToolLine tool={msg.tool} input={msg.input} output={msg.output} success={msg.success} />;
                case "permission":
                  return <TermPermPrompt tool={msg.tool} description={msg.description} suggestions={msg.suggestions} resolved={msg.resolved} allowed={msg.allowed} onRespond={(allow, sugg) => handlePermissionRespond(msg.id, allow, sugg)} />;
                case "ask":
                  return <AskQuestionCard questions={msg.questions} resolved={msg.resolved} answers={msg.answers} onRespond={(answers) => handleAskUserRespond(msg.id, answers)} />;
                case "thinking":
                  if (hideThinking) {
                    if (msg.ended) return null;
                    return <div className="tv-activity"><span className="tv-activity-sigil">{"\u2026"}</span><span className="tv-activity-label">Thinking...</span></div>;
                  }
                  return <TermThinkingLine text={msg.text} ended={msg.ended} />;
                case "result":
                  return null;
                case "error":
                  return <TermErrorLine code={msg.code} message={msg.message} />;
                case "status":
                  return <span className="tv-status">[{msg.model}] {msg.status}</span>;
                case "history-separator":
                  return <div className="tv-sep"><span className="tv-sep-rule" /><span>previous session</span><span className="tv-sep-rule" /></div>;
                default:
                  return null;
              }
            })();
            if (content === null) return (
              <div key={item.id} data-index={virtualRow.index} ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, height: 0, overflow: "hidden" }} />
            );
            return (
              <div
                key={item.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                id={`msg-${item.id}`}
                className={`tv-line${item.id.startsWith("hist-") ? " tv-line--history" : ""}`}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              >
                {content}
              </div>
            );
          })}
        </div>
        {/* Live thinking outside virtualizer */}
        {thinkingIdRef.current && !hideThinking && (
          <div className="tv-line">
            <TermThinkingLine text={thinkingTextRef.current} ended={false} />
          </div>
        )}
        {thinkingIdRef.current && hideThinking && (
          <div className="tv-line">
            <div className="tv-activity"><span className="tv-activity-sigil">{"\u2026"}</span><span className="tv-activity-label">Thinking...</span></div>
          </div>
        )}
        {/* Live streaming outside virtualizer */}
        {streamingIdRef.current && (
          <div className="tv-line">
            <pre className="tv-assistant tv-assistant--streaming">{streamingTextRef.current}</pre>
          </div>
        )}
        {/* Activity spinner when processing — replaces input field */}
        {inputState === "processing" && !streamingIdRef.current && !thinkingIdRef.current && !hasUnresolvedPermission && messages.length > 0 && (
          <div className="tv-line">
            <ActivitySpinner label="Working..." />
          </div>
        )}
        {/* Input — always visible when session is active */}
        {inputState !== "idle" && !hasUnresolvedPermission && (
          <ChatInput
            onSubmit={(...args) => { stickyRef.current = true; handleSubmit(...args); }}
            onCommand={handleCommand}
            processing={inputState === "processing"}
            isActive={isActive}
            inputStyle="terminal"
            sdkCommands={sdkCommands}
            sdkAgents={sdkAgents}
            droppedFiles={droppedFiles}
            onDroppedFilesConsumed={handleDroppedFilesConsumed}
            queueLength={queueLength}
          />
        )}
        <div ref={messagesEndRef} />
      </div>
      {sidebarOpen && (
        <RightSidebar messages={deferredMessages} agentTasks={agentTasks} onScrollToMessage={handleScrollToMessage} scrollContainerRef={scrollRef} />
      )}
      </div>{/* end tv-main-row */}
      {/* Bottom bar */}
      <div className="tv-bottom">
        {backgrounded && <span className="bottom-bg-badge">BG</span>}
        {queueLength > 0 && <span className="bottom-queue-badge">{queueLength} queued</span>}
        <button
          className="bottom-pill tv-bottom-model"
          title="Click to cycle model (F4)"
          onClick={() => onConfigChange?.({ modelIdx: (modelIdx + 1) % MODELS.length })}
        >{MODELS[modelIdx]?.display || "?"}</button>
        <span className="tv-bottom-sep">|</span>
        <button
          className={`bottom-pill tv-bottom-effort tv-bottom-effort--${EFFORTS[effortIdx] || "high"}`}
          title="Click to cycle effort (F2)"
          onClick={() => onConfigChange?.({ effortIdx: (effortIdx + 1) % EFFORTS.length })}
        >{EFFORTS[effortIdx] || "high"}</button>
        <span className="tv-bottom-sep">|</span>
        <button
          className={`bottom-pill tv-bottom-perm tv-bottom-perm--${PERM_MODES[permModeIdx]?.sdk || "plan"}`}
          title="Click to cycle permission mode (Tab)"
          onClick={() => onConfigChange?.({ permModeIdx: (permModeIdx + 1) % PERM_MODES.length })}
        >{PERM_MODES[permModeIdx]?.display || "plan"}</button>
        {stats.cost > 0 && (
          <>
            <span className="tv-bottom-sep">{"\u00b7"}</span>
            <span className="tv-bottom-cost">${stats.cost.toFixed(3)}</span>
            <span className="tv-bottom-sep">{"\u00b7"}</span>
            <span className="tv-bottom-stat">{fmtTokens(stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens)} tok</span>
            <span className="tv-bottom-sep">{"\u00b7"}</span>
            <span className="tv-bottom-stat">{stats.turns}t</span>
            <span className="tv-bottom-sep">{"\u00b7"}</span>
            <span className="tv-bottom-stat">{(stats.durationMs / 1000).toFixed(0)}s</span>
          </>
        )}
        {stats.tokens > 0 && stats.contextWindow > 0 && (() => {
          const pct = Math.min(Math.round((stats.tokens / stats.contextWindow) * 100), 100);
          const level = pct > 80 ? "high" : pct > 50 ? "mid" : "low";
          return (
            <>
              <span className="tv-bottom-sep">{"\u00b7"}</span>
              <span className="tv-ctx" title={`Context: ${(stats.tokens / 1000).toFixed(0)}k / ${(stats.contextWindow / 1000).toFixed(0)}k`}>
                <span className="tv-ctx-label">ctx</span>
                <span className="tv-ctx-bar">
                  <span className={`tv-ctx-fill tv-ctx-fill--${level}`} style={{ width: `${pct}%` }} />
                </span>
                <span className="tv-ctx-pct">{pct}%</span>
              </span>
            </>
          );
        })()}
        {stats.rateLimitUtil > 0 && (
          <>
            <span className="tv-bottom-sep">{"\u00b7"}</span>
            <span className={`tv-bottom-stat${stats.rateLimitUtil > 0.8 ? " tv-bottom-warn" : ""}`} title={`Rate limit: ${Math.round(stats.rateLimitUtil * 100)}%`}>
              quota {Math.round(stats.rateLimitUtil * 100)}%
            </span>
          </>
        )}
        <span className="tv-bottom-spacer" />
        <button className="tv-bottom-btn" title="Attach files" onClick={handleAttachClick}><IconPlus /></button>
        <button
          className={`tv-bottom-btn tv-bottom-sidebar-toggle${sidebarOpen ? " active" : ""}`}
          title={sidebarOpen ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
          aria-label="Toggle right sidebar"
          onClick={() => setSidebarOpen(prev => !prev)}
        >
          <IconSidebar />
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
