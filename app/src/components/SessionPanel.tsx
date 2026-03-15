import { memo, useState, useEffect, useCallback, useRef } from "react";
import { listAgentSessions } from "../hooks/useAgentSession";
import type { SessionInfo } from "../types";
import "./SessionPanel.css";

interface SessionPanelProps {
  projectPath: string | null;
  isOpen: boolean;
  onClose: () => void;
  onResumeSession: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
  onForkSession: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
}

interface ContextMenu {
  sessionId: string;
  cwd: string;
  x: number;
  y: number;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Shared filter predicate — used by both render and keyboard handler. */
function matchesFilter(s: SessionInfo, q: string): boolean {
  return (
    s.summary.toLowerCase().includes(q) ||
    (s.firstPrompt || "").toLowerCase().includes(q) ||
    (s.customTitle || "").toLowerCase().includes(q)
  );
}

function SessionPanel({ projectPath, isOpen, onClose, onResumeSession, onForkSession }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIdxRef = useRef(selectedIdx);
  const filterRef = useRef(filter);

  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);
  useEffect(() => { filterRef.current = filter; }, [filter]);

  // Fetch sessions when panel opens or project changes
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setFilter("");
    setSelectedIdx(0);
    listAgentSessions(projectPath || undefined)
      .then((list) => {
        const sorted = [...list].sort((a, b) => b.lastModified - a.lastModified);
        setSessions(sorted);
      })
      .catch((e) => { console.error("Session fetch failed:", e); setSessions([]); })
      .finally(() => setLoading(false));
  }, [isOpen, projectPath]);

  const filtered = filter
    ? sessions.filter((s) => matchesFilter(s, filter.toLowerCase()))
    : sessions;

  // Keyboard handler — uses capture phase so it fires before Terminal's handler
  // when the panel is focused (SessionBrowser uses bubble phase because it's a
  // full-page tab that doesn't coexist with Terminal).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== panelRef.current) return;

    const idx = selectedIdxRef.current;
    const fl = filterRef.current;
    const list = fl
      ? sessions.filter((s) => matchesFilter(s, fl.toLowerCase()))
      : sessions;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(Math.max(0, idx - 1));
        break;
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(Math.min(list.length - 1, idx + 1));
        break;
      case "Home":
        e.preventDefault();
        setSelectedIdx(0);
        break;
      case "End":
        e.preventDefault();
        setSelectedIdx(Math.max(0, list.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (list[idx]) {
          onResumeSession(list[idx].id, list[idx].cwd, e.ctrlKey);
        }
        break;
      case "f":
      case "F":
        // "f" is reserved for fork action, cannot be used in filter
        if (!e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          if (list[idx]) {
            onForkSession(list[idx].id, list[idx].cwd, false);
          }
        } else if (e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          if (list[idx]) {
            onForkSession(list[idx].id, list[idx].cwd, true);
          }
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (fl) {
          setFilter("");
        } else {
          onClose();
        }
        break;
      case "Backspace":
        e.preventDefault();
        setFilter((prev) => prev.slice(0, -1));
        setSelectedIdx(0);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== "f" && e.key !== "F") {
          e.preventDefault();
          setFilter((prev) => prev + e.key);
          setSelectedIdx(0);
        }
        break;
    }
  }, [isOpen, sessions, onResumeSession, onForkSession, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleKeyDown]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(".session-item.selected");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Focus panel when opened
  useEffect(() => {
    if (isOpen && panelRef.current) {
      panelRef.current.focus();
    }
  }, [isOpen]);

  // Close context menu on click outside or Escape
  const contextMenuOpen = contextMenu != null;
  useEffect(() => {
    if (!contextMenuOpen) return;
    const close = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenuOpen]);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string, cwd: string) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 120);
    setContextMenu({ sessionId, cwd, x, y });
  }, []);

  if (!isOpen) return null;

  return (
    <div className="session-panel" ref={panelRef} tabIndex={-1}>
      <div className="session-panel__header">
        <span className="session-panel__title">Sessions</span>
        <button className="session-panel__close" onClick={onClose} title="Close (Ctrl+Shift+S)" aria-label="Close sessions panel">
          {"\u00d7"}
        </button>
      </div>

      {filter && (
        <div className="session-panel__filter">
          <span className="session-panel__filter-icon">/</span>
          <span>{filter}</span>
        </div>
      )}

      <div className="session-panel__list" ref={listRef}>
        {!projectPath ? (
          <div className="session-panel__empty">Select an agent tab</div>
        ) : loading ? (
          <div className="session-panel__empty">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="session-panel__empty">No sessions found</div>
        ) : (
          filtered.map((session, i) => {
            const isSelected = i === selectedIdx;
            const title = session.customTitle || session.summary || "Untitled";
            const prompt = session.firstPrompt || "";

            return (
              <div
                key={session.id}
                className={`session-item ${isSelected ? "selected" : ""}`}
                onClick={(e) => onResumeSession(session.id, session.cwd, e.ctrlKey)}
                onContextMenu={(e) => handleContextMenu(e, session.id, session.cwd)}
              >
                <div className="session-item__top">
                  <span className="session-item__title" title={title}>{title}</span>
                  <span className="session-item__date">{relativeTime(session.lastModified)}</span>
                </div>
                {prompt && (
                  <div className="session-item__prompt" title={prompt}>{prompt}</div>
                )}
                <div className="session-item__actions">
                  <button
                    className="session-item__action"
                    onClick={(e) => { e.stopPropagation(); onResumeSession(session.id, session.cwd); }}
                    title="Resume"
                    aria-label="Resume session"
                  >
                    {"\u25b6"}
                  </button>
                  <button
                    className="session-item__action"
                    onClick={(e) => { e.stopPropagation(); onForkSession(session.id, session.cwd); }}
                    title="Fork"
                    aria-label="Fork session"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <line x1="5" y1="1" x2="5" y2="9" stroke="currentColor" strokeWidth="1.2"/>
                      <line x1="5" y1="5" x2="9" y2="2" stroke="currentColor" strokeWidth="1.2"/>
                    </svg>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="session-panel__footer">
        [Enter] Resume  [F] Fork  [Esc] Close
      </div>

      {contextMenu && (
        <div
          className="session-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => { onResumeSession(contextMenu.sessionId, contextMenu.cwd); setContextMenu(null); }}>
            Resume
          </button>
          <button className="context-menu-item" onClick={() => { onForkSession(contextMenu.sessionId, contextMenu.cwd); setContextMenu(null); }}>
            Fork
          </button>
          <button className="context-menu-item" onClick={() => { onResumeSession(contextMenu.sessionId, contextMenu.cwd, true); setContextMenu(null); }}>
            Resume in New Tab
          </button>
          <button className="context-menu-item" onClick={() => { onForkSession(contextMenu.sessionId, contextMenu.cwd, true); setContextMenu(null); }}>
            Fork in New Tab
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(SessionPanel);
