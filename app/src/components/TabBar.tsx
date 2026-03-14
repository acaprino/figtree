import { memo, useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tab, MODELS } from "../types";
import "./TabBar.css";

const appWindow = getCurrentWindow();

interface ContextMenu {
  tabId: string;
  x: number;
  y: number;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onSaveToProjects?: (tabId: string) => void;
  onToggleAbout: () => void;
  onToggleUsage: () => void;
}

export default memo(function TabBar({ tabs, activeTabId, onActivate, onClose, onAdd, onSaveToProjects, onToggleAbout, onToggleUsage }: TabBarProps) {
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const closingTimersRef = useRef<Map<string, number>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const handleClose = useCallback((tabId: string) => {
    if (closingTimersRef.current.has(tabId)) return;

    setClosingIds((prev) => new Set(prev).add(tabId));

    const timer = window.setTimeout(() => {
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
      closingTimersRef.current.delete(tabId);
      onClose(tabId);
    }, 150);

    closingTimersRef.current.set(tabId, timer);
  }, [onClose]);

  const handleMinimize = useCallback(() => {
    appWindow.minimize();
  }, []);

  const handleMaximize = useCallback(() => {
    appWindow.toggleMaximize();
  }, []);

  const handleWindowClose = useCallback(() => {
    appWindow.close();
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 80);
    setContextMenu({ tabId, x, y });
  }, []);

  const handleSaveToProjects = useCallback((tabId: string) => {
    onSaveToProjects?.(tabId);
    setContextMenu(null);
  }, [onSaveToProjects]);

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

  return (
    <div className="tab-bar" data-tauri-drag-region>
      <div className="tab-list" role="tablist" data-tauri-drag-region>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isClosing = closingIds.has(tab.id);
          const label =
            tab.type === "terminal"
              ? `${tab.projectName ?? "Terminal"}${tab.modelIdx != null ? ` \u2014 ${MODELS[tab.modelIdx].display}` : ""}`
              : tab.type === "about"
                ? "About"
                : tab.type === "usage"
                  ? "Usage"
                  : tab.type === "system-prompt"
                    ? "System Prompts"
                    : "New Tab";

          return (
            <div
              key={tab.id}
              className={`tab ${isActive ? "active" : ""} ${tab.hasNewOutput ? "has-output" : ""} ${isClosing ? "closing" : ""} ${tab.temporary ? "temporary" : ""}`}
              onClick={() => !isClosing && onActivate(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
            >
              <span className="tab-label" title={tab.temporary ? `${label} (temp)` : label}>{label}</span>
              {tab.exitCode != null && (
                <span className={`tab-exit ${tab.exitCode === 0 ? "ok" : "err"}`}>
                  {tab.exitCode === 0 ? "\u2713" : "\u2717"}
                </span>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(tab.id);
                }}
                title="Close (Ctrl+F4)"
                aria-label={`Close ${label}`}
              >
                {"\u00d7"}
              </button>
            </div>
          );
        })}
      </div>
      <button className="tab-add" onClick={onAdd} title="New Tab (Ctrl+T)" aria-label="New Tab">
        +
      </button>
      <div className="tab-bar-actions">
        <button className="tab-bar-action" onClick={onToggleUsage} title="Usage Stats (Ctrl+U)" aria-label="Usage Stats">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="7" width="2" height="4" rx="0.5" fill="currentColor"/>
            <rect x="5" y="4" width="2" height="7" rx="0.5" fill="currentColor"/>
            <rect x="9" y="1" width="2" height="10" rx="0.5" fill="currentColor"/>
          </svg>
        </button>
        <button className="tab-bar-action" onClick={onToggleAbout} title="About (F12)" aria-label="About">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
            <text x="6" y="9" textAnchor="middle" fill="currentColor" fontSize="8" fontWeight="bold" fontFamily="serif">i</text>
          </svg>
        </button>
      </div>
      {contextMenu && (() => {
        const tab = tabs.find((t) => t.id === contextMenu.tabId);
        if (!tab) return null;
        return (
          <div
            className="tab-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {tab.type === "terminal" && tab.temporary && onSaveToProjects && (
              <button className="context-menu-item" onClick={() => handleSaveToProjects(contextMenu.tabId)}>
                Save to Projects
              </button>
            )}
            <button className="context-menu-item" onClick={() => { handleClose(contextMenu.tabId); setContextMenu(null); }}>
              Close Tab
            </button>
          </div>
        );
      })()}
      <div className="window-controls">
        <button className="win-btn minimize" onClick={handleMinimize} aria-label="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button className="win-btn maximize" onClick={handleMaximize} aria-label="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="win-btn close" onClick={handleWindowClose} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  );
});
