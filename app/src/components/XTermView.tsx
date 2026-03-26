/**
 * XTermView — xterm.js-based terminal view that replaces TerminalView.
 * Uses a Virtual Document Model (TerminalDocument + TerminalRenderer)
 * to render structured AgentEvents as ANSI-formatted terminal output.
 * InputManager handles all keyboard input directly in xterm.js.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./TerminalView.css";

import { PERM_MODES } from "../types";
import type { SessionViewProps } from "./SessionViewProps";
import type { Theme, Attachment } from "../types";
import { themeColorsToXterm, themeColorsToPalette } from "./terminal/themes";
import { TerminalRenderer } from "./terminal/TerminalRenderer";
import { InputManager } from "./terminal/InputManager";
import type { PermissionBlock } from "./terminal/blocks/PermissionBlock";
import { useThemes } from "../contexts/ThemesContext";
import { useProjectsContext } from "../contexts/ProjectsContext";
import { fmtTokens } from "../utils/format";
import RightSidebar from "./chat/RightSidebar";
import SessionPanel from "./SessionPanel";
import { IconPlus, IconSidebar } from "./Icons";

export default memo(function XTermView(props: SessionViewProps) {
  const {
    modelIdx, effortIdx, permModeIdx, isActive,
    controller: ctrl,
    onConfigChange,
    sessionPanelOpen, onCloseSessionPanel, onResumeSession, onForkSession,
  } = props;

  const {
    deferredMessages,
    inputState, stats, agentTasks,
    thinkingIdRef,
    handleSubmit, handlePermissionRespond, handleAskUserRespond,
    handleInterrupt,
    handleAttachClick,
    queueLength, backgrounded,
    document: termDocument,
    projectPath,
    models, efforts,
  } = ctrl;

  const themes = useThemes();
  const { settings } = useProjectsContext();
  const themeIdx = settings?.theme_idx ?? 1;
  const currentTheme: Theme | undefined = themes[themeIdx] ?? themes[0];

  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ── Refs ──
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const inputManagerRef = useRef<InputManager | null>(null);
  const inputStateRef = useRef(inputState);
  inputStateRef.current = inputState;

  // Stable callback refs to avoid stale closures in InputManager
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const handleInterruptRef = useRef(handleInterrupt);
  handleInterruptRef.current = handleInterrupt;
  const handlePermissionRespondRef = useRef(handlePermissionRespond);
  handlePermissionRespondRef.current = handlePermissionRespond;
  const handleAskUserRespondRef = useRef(handleAskUserRespond);
  handleAskUserRespondRef.current = handleAskUserRespond;

  // ── Initialize xterm.js + Document + Renderer + InputManager ──
  useEffect(() => {
    if (!containerRef.current) return;

    const fontFamily = currentTheme?.termFont
      ? `"${currentTheme.termFont}", "Consolas", monospace`
      : '"Consolas", monospace';
    const fontSize = currentTheme?.termFontSize || 14;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily,
      fontSize,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      theme: currentTheme ? themeColorsToXterm(currentTheme.colors) : undefined,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    // WebGL addon — try/catch for GPU fallback
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      console.warn("XTermView: WebGL addon failed, using canvas renderer");
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Create Renderer using the document from useSessionController (already exists)
    const palette = currentTheme
      ? themeColorsToPalette(currentTheme.colors)
      : { text: "#cdd6f4", textDim: "#6c7086", accent: "#89b4fa", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", surface: "#313244", overlay0: "#6c7086", overlay1: "#7f849c", bg: "#1e1e2e", crust: "#11111b" };

    const renderer = new TerminalRenderer(term, termDocument, palette);
    rendererRef.current = renderer;

    // Create InputManager and link to renderer
    const inputManager = new InputManager(term, palette, {
      onSubmit: (text) => {
        handleSubmitRef.current(text, [] as Attachment[]);
      },
      onInterrupt: () => {
        handleInterruptRef.current();
      },
      onPermissionRespond: (toolUseId, allow, suggestions) => {
        const block = termDocument.findLastUnresolvedPermission();
        if (block) {
          handlePermissionRespondRef.current(block.id, allow, suggestions);
          termDocument.resolvePermission(toolUseId, allow);
        }
      },
      onAskRespond: (answers) => {
        const block = termDocument.findLastUnresolvedAsk();
        if (block) {
          handleAskUserRespondRef.current(block.id, answers);
          termDocument.resolveAsk(answers);
        }
      },
      onAutocomplete: async (input) => {
        try {
          return await invoke<string[]>("autocomplete_files", { cwd: projectPath || "D:\\Projects", input });
        } catch {
          return [];
        }
      },
    });
    inputManagerRef.current = inputManager;
    renderer.setInputManager(inputManager);

    // Listen to document events for mode switching
    const unsub = termDocument.subscribe((event) => {
      if (event.type === "blockAdded") {
        const b = event.block;
        if (b.type === "permission" && !(b as PermissionBlock).resolved) {
          inputManager.enterPermissionMode(
            (b as PermissionBlock).toolUseId,
            (b as PermissionBlock).suggestions,
          );
        } else if (b.type === "ask") {
          const askBlock = b as import("./terminal/blocks/AskBlock").AskBlock;
          if (!askBlock.resolved) {
            inputManager.enterAskMode(askBlock.questions);
          }
        }
      }
    });

    // Resize handler
    term.onResize(({ cols, rows }) => {
      rendererRef.current?.handleResize(cols, rows);
    });

    return () => {
      unsub();
      inputManager.dispose();
      inputManagerRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // Mount once

  // ── Sync inputState -> InputManager mode ──
  useEffect(() => {
    const im = inputManagerRef.current;
    if (!im) return;
    // Don't override permission/ask modes
    if (im.getMode() === "permission" || im.getMode() === "ask") return;

    if (inputState === "awaiting_input") {
      im.setMode("normal");
    } else if (inputState === "processing" || inputState === "idle") {
      // Don't re-enter processing mode — avoids resetting spinner/pause state
      if (im.getMode() !== "processing") {
        im.setMode("processing");
      }
    }
  }, [inputState]);

  // ── Theme updates ──
  useEffect(() => {
    if (!termRef.current || !currentTheme) return;
    termRef.current.options.theme = themeColorsToXterm(currentTheme.colors);
    if (currentTheme.termFont) {
      termRef.current.options.fontFamily = `"${currentTheme.termFont}", "Consolas", monospace`;
    }
    if (currentTheme.termFontSize) {
      termRef.current.options.fontSize = currentTheme.termFontSize;
    }
    const newPalette = themeColorsToPalette(currentTheme.colors);
    if (rendererRef.current) {
      rendererRef.current.updatePalette(newPalette);
      rendererRef.current.fullRedraw();
    }
    if (inputManagerRef.current) {
      inputManagerRef.current.updatePalette(newPalette);
    }
    fitAddonRef.current?.fit();
  }, [currentTheme]);

  // ── Resize handling ──
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;
    const ro = new ResizeObserver(() => fitAddonRef.current?.fit());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Sidebar toggle ──
  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);

  // ── Auto-focus xterm when tab becomes active ──
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

  // ── Keyboard shortcuts (global, not captured by xterm) ──
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, toggleSidebar]);

  return (
    <div className="tv-wrapper">
      <div className="tv-main-row">
        <div
          ref={containerRef}
          className="xterm-container"
          style={{ flex: 1, overflow: "hidden" }}
        />
        {sessionPanelOpen && onCloseSessionPanel && onResumeSession && onForkSession && (
          <SessionPanel
            projectPath={projectPath}
            isOpen={sessionPanelOpen}
            onClose={onCloseSessionPanel}
            onResumeSession={onResumeSession}
            onForkSession={onForkSession}
          />
        )}
        {sidebarOpen && (
          <RightSidebar
            messages={deferredMessages}
            agentTasks={agentTasks}
            onScrollToMessage={() => {/* TODO: Phase 4 - scrollToLine */}}
            scrollContainerRef={{ current: null }}
          />
        )}
      </div>
      {/* Bottom bar */}
      <div className="tv-bottom">
        {backgrounded && <span className="bottom-bg-badge">BG</span>}
        {queueLength > 0 && <span className="bottom-queue-badge">{queueLength} queued</span>}
        <button
          className="bottom-pill tv-bottom-model"
          title="Click to cycle model (F4)"
          onClick={() => onConfigChange?.({ modelIdx: (modelIdx + 1) % models.length })}
        >{models[modelIdx]?.display || "?"}</button>
        <span className="tv-bottom-sep">|</span>
        <button
          className={`bottom-pill tv-bottom-effort tv-bottom-effort--${efforts[effortIdx] || "high"}`}
          title="Click to cycle effort (F2)"
          onClick={() => onConfigChange?.({ effortIdx: (effortIdx + 1) % efforts.length })}
        >{efforts[effortIdx] || "high"}</button>
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
        {thinkingIdRef.current && (
          <span className="tv-bottom-thinking">
            <span className="tv-bottom-thinking-dot" />
            thinking
          </span>
        )}
        <span className="tv-bottom-spacer" />
        <button className="tv-bottom-btn" title="Attach files" onClick={handleAttachClick}><IconPlus /></button>
        <button
          className={`tv-bottom-btn tv-bottom-sidebar-toggle${sidebarOpen ? " active" : ""}`}
          title={sidebarOpen ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
          aria-label="Toggle right sidebar"
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
      </div>
    </div>
  );
});
