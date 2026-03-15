import { memo, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { spawnClaude, writePty, resizePty, sendHeartbeat, killSession, saveClipboardImage } from "../hooks/usePty";
import { spawnAgent, sendAgentMessage, killAgent, respondPermission } from "../hooks/useAgentSession";
import { renderAgentEvent } from "../ansiRenderer";
import { getXtermTheme } from "../themes";
import type { AgentEvent, ThemeColors } from "../types";
import Minimap from "./Minimap";
import BookmarkList from "./BookmarkList";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

const ESC_CURSOR_HIDE = "\x1b[?25l";
const ESC_CURSOR_SHOW = "\x1b[?25h";
const MAX_BOOKMARK_TEXT = 200;

/** Detect the horizontal separator line (─────) that marks the end of
 *  Claude's startup banner. Everything before it is the logo/version block;
 *  everything from it onward is the interactive TUI. */
const BANNER_END_RE = /\n(?:\x1b\[[0-9;?]*[a-zA-Z])*─/;
const BANNER_BUF_MAX = 8192;
/** How long (ms) after a resize to ignore buffer shrinkage — reflow (line
 *  unwrapping) reduces buffer.active.length without content being cleared. */
const RESIZE_REFLOW_MS = 500;

/** Anvil ASCII art logo — 15 lines, generated from icon.png via convertico.com.
 *  Colors match the icon: dark brown hammer head, orange handle, steel anvil,
 *  blue-gray base. */
const LOGO_COLORS = {
  HEAD: "\x1b[38;2;90;60;30m",    // dark brown — hammer head
  HANDLE: "\x1b[38;2;210;160;70m", // orange — hammer handle
  OUTLINE: "\x1b[38;2;50;50;50m",  // near-black — outlines
  STEEL: "\x1b[38;2;120;135;155m", // steel gray — anvil body
  LIGHT: "\x1b[38;2;160;175;190m", // lighter — anvil highlights (▒)
  BLUE: "\x1b[38;2;90;140;170m",   // blue accent — base
  R: "\x1b[0m",
};
const ANSI_LOGO_PARTS = [
  `${LOGO_COLORS.OUTLINE}           ${LOGO_COLORS.HEAD}████`,
  `${LOGO_COLORS.OUTLINE}         ${LOGO_COLORS.HEAD}███▓▓${LOGO_COLORS.OUTLINE}█${LOGO_COLORS.HANDLE}████████████${LOGO_COLORS.OUTLINE}███`,
  `${LOGO_COLORS.OUTLINE}         ${LOGO_COLORS.HEAD}█▓▓▓▓${LOGO_COLORS.OUTLINE}█${LOGO_COLORS.HANDLE}▒▒▒▒▒▒▒▒▓▒▒▓${LOGO_COLORS.OUTLINE}██`,
  `${LOGO_COLORS.OUTLINE}         ${LOGO_COLORS.HEAD}███▓▓${LOGO_COLORS.OUTLINE}██████████████`,
  `${LOGO_COLORS.OUTLINE}      ██████${LOGO_COLORS.STEEL}▓▓${LOGO_COLORS.OUTLINE}████`,
  `${LOGO_COLORS.OUTLINE}      ████████████`,
  `${LOGO_COLORS.OUTLINE}     █████████████████`,
  `${LOGO_COLORS.OUTLINE} ███${LOGO_COLORS.STEEL}▓██▓▓▓▓▓▓▓▓▓▓▓▓▓▓█▓▓${LOGO_COLORS.OUTLINE}██`,
  `${LOGO_COLORS.OUTLINE} ██${LOGO_COLORS.STEEL}▓▓▓▓▓▓${LOGO_COLORS.LIGHT}▒▒▒▒▒▒▒▒▒▒▒${LOGO_COLORS.STEEL}▓▓▓▓${LOGO_COLORS.OUTLINE}██`,
  `${LOGO_COLORS.OUTLINE}  █████${LOGO_COLORS.STEEL}▓▓${LOGO_COLORS.LIGHT}▒▒▒▒▒▒▒▒▒▒▒${LOGO_COLORS.STEEL}▓█▓${LOGO_COLORS.OUTLINE}███`,
  `${LOGO_COLORS.OUTLINE}     ██${LOGO_COLORS.STEEL}▓▓▓▓▓▓▓▓▓▓▓▓▓▓${LOGO_COLORS.OUTLINE}██`,
  `${LOGO_COLORS.OUTLINE}        ██${LOGO_COLORS.STEEL}▓▓▓▓▓▓▓▓${LOGO_COLORS.OUTLINE}█`,
  `${LOGO_COLORS.OUTLINE}        ██${LOGO_COLORS.STEEL}▓▓▓▓▓▓▓▓${LOGO_COLORS.OUTLINE}█`,
  `${LOGO_COLORS.OUTLINE}     ${LOGO_COLORS.BLUE}█████████████████`,
  `${LOGO_COLORS.OUTLINE}     ${LOGO_COLORS.BLUE}██▓▓▓▓▓▓▓▓▓▓▓▓▓██`,
];
/** "ANVIL" ASCII art text — 5 lines, displayed to the right of the logo, vertically centered.
 *  Each letter has a fixed column width: A=7, N=8, V=8, I=4, L=8, with 2-space gaps.
 *  Total width = 43 chars per line. */
const S = LOGO_COLORS.STEEL;
//                    A(7)  __N(8)____  __V(8)____  __I(4)  __L(8)____
const ANSI_TEXT_LINES = [
  `${S} █████   ██    ██  ██    ██  ████  ██      `,
  `${S}██   ██  ███   ██  ██    ██   ██   ██      `,
  `${S}███████  ██ ██ ██   ██  ██    ██   ██      `,
  `${S}██   ██  ██  ████    ████     ██   ██      `,
  `${S}██   ██  ██    ██     ██     ████  ████████`,
];
// Center 5 text lines within 15 logo lines (start at line 5).
// Use ANSI absolute column positioning (\x1b[<col>G) so the text always
// starts at the same column regardless of the logo line's visible width.
const TEXT_COL = 34; // column where "ANVIL" text starts (1-based)
const TEXT_START = 5;
const ANSI_LOGO = ANSI_LOGO_PARTS.map((line, i) => {
  const ti = i - TEXT_START;
  return ti >= 0 && ti < ANSI_TEXT_LINES.length ? line + `\x1b[${TEXT_COL}G` + ANSI_TEXT_LINES[ti] : line;
}).join("\r\n") + LOGO_COLORS.R;

/** Strip characters outside the Basic Multilingual Plane (emoji, supplementary chars)
 *  that become surrogate pairs in UTF-16.  On Windows, passing these through command-line
 *  arguments or ConPTY can corrupt them into lone surrogates, causing "invalid high
 *  surrogate" JSON errors from the Claude API.  Also strips lone surrogates directly. */
function stripNonBmpAndSurrogates(text: string): string {
  // IMPORTANT: the 'u' flag is required — without it \u{10000}-\u{10FFFF} won't match
  // supplementary plane codepoints and surrogate pairs won't be handled atomically.
  // eslint-disable-next-line no-misleading-character-class
  return text.replace(/[\uD800-\uDFFF]|[\u{10000}-\u{10FFFF}]/gu, "");
}

/** Replace common non-ASCII characters with ASCII equivalents and strip control chars.
 *  This prevents encoding issues when pasting text from editors, web pages, or Word docs. */
function sanitizePastedText(text: string): string {
  const cleaned = text
    // Curly/smart quotes → straight quotes
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    // Dashes → hyphen/double-hyphen
    .replace(/\u2014/g, "--")  // em dash
    .replace(/[\u2013\u2012\u2015]/g, "-")  // en dash, figure dash, horizontal bar
    // Ellipsis → three dots
    .replace(/\u2026/g, "...")
    // Spaces → normal space
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F]/g, " ")
    // Zero-width chars → remove
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    // Bullets/arrows
    .replace(/\u2022/g, "*")
    .replace(/[\u2192\u279C\u2794\u27A1]/g, "->")
    .replace(/[\u2190\u2B05]/g, "<-")
    .replace(/[\u2191\u2B06]/g, "^")
    .replace(/[\u2193\u2B07]/g, "v")
    // Box-drawing heavy lines → ASCII equivalents
    .replace(/[\u2501\u2509\u250B\u254D\u254F\u2578\u257A\u257C\u257E]/g, "-")
    .replace(/[\u2503\u250A\u2507\u254E\u2550\u2579\u257B\u257D\u257F]/g, "|")
    .replace(/[\u250F\u2513\u2517\u251B\u2523\u252B\u2533\u253B\u254B]/g, "+")
    // Box-drawing light lines → ASCII equivalents
    .replace(/[\u2500\u2504\u2508\u254C]/g, "-")
    .replace(/[\u2502\u2506\u250A\u254E]/g, "|")
    .replace(/[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C]/g, "+")
    // Box-drawing double lines → ASCII equivalents
    .replace(/[\u2550]/g, "=")
    .replace(/[\u2551]/g, "|")
    .replace(/[\u2552-\u256C]/g, "+")
    // Block elements → ASCII
    .replace(/[\u2580-\u2588]/g, "#")
    .replace(/[\u2589-\u258F]/g, "|")
    .replace(/[\u2590-\u259F]/g, ".")
    // Checkmarks/crosses
    .replace(/[\u2713\u2714\u2705]/g, "[x]")
    .replace(/[\u2717\u2718\u274C]/g, "[!]")
    // Common symbols
    .replace(/\u00B7/g, ".")           // middle dot
    .replace(/[\u25CF\u25CB\u25A0\u25A1]/g, "*")  // circles/squares → bullet
    .replace(/\u00A9/g, "(c)")
    .replace(/\u00AE/g, "(R)")
    .replace(/\u2122/g, "(TM)")
    // Strip ANSI escape sequences that may be in clipboard text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC sequences
    // Strip control characters (keep \t, \n, \r)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  return stripNonBmpAndSurrogates(cleaned);
}

interface TerminalProps {
  tabId: string;
  tabType: "terminal" | "agent";
  projectPath: string;
  toolIdx: number;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
  autocompact: boolean;
  systemPrompt: string;
  themeIdx: number;
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
}

export default memo(function Terminal({
  tabId,
  tabType,
  projectPath,
  toolIdx,
  modelIdx,
  effortIdx,
  skipPerms,
  autocompact,
  systemPrompt,
  themeIdx,
  themeColors,
  fontFamily,
  fontSize,
  isActive,
  onSessionCreated,
  onNewOutput,
  onExit,
  onError,
  onRequestClose,
  onAgentResult,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const [xtermReady, setXtermReady] = useState<XTerm | null>(null);
  const bookmarksRef = useRef(new Map<number, string>());
  const lastBookmarkLineRef = useRef(-1);
  const prevBufferLenRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const channelRef = useRef<any>(null);
  const resizeRafRef = useRef(0);
  const lastResizeTimeRef = useRef(0);
  const tabIdRef = useRef(tabId);
  const isActiveRef = useRef(isActive);
  const onRequestCloseRef = useRef(onRequestClose);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const onNewOutputRef = useRef(onNewOutput);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);
  const pasteInFlightRef = useRef(false);
  const onAgentResultRef = useRef(onAgentResult);
  // Agent mode state machine: idle → awaiting_input → processing → awaiting_permission
  const agentInputStateRef = useRef<"idle" | "awaiting_input" | "processing" | "awaiting_permission">("idle");
  const agentInputBufRef = useRef("");
  const themeColorsRef = useRef(themeColors);

  useEffect(() => {
    themeColorsRef.current = themeColors;
  }, [themeColors]);

  useEffect(() => {
    onAgentResultRef.current = onAgentResult;
  }, [onAgentResult]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    onSessionCreatedRef.current = onSessionCreated;
  }, [onSessionCreated]);

  useEffect(() => {
    onNewOutputRef.current = onNewOutput;
  }, [onNewOutput]);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: fontSize || 14,
      fontFamily: fontFamily ? `'${fontFamily}', 'Consolas', monospace` : "'Cascadia Code', 'Consolas', monospace",
      theme: getXtermTheme(themeIdx),
      allowProposedApi: true, // Required by Unicode11Addon
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

    const unicode11 = new Unicode11Addon();
    xterm.loadAddon(unicode11);
    xterm.unicode.activeVersion = "11";

    // Track WebGL addon for recovery after context loss (e.g. system standby,
    // GPU driver reset, context eviction with many tabs open).
    // Retry cap prevents futile reloads on hardware without WebGL support.
    let currentWebgl: WebglAddon | null = null;
    let webglFailures = 0;
    const MAX_WEBGL_RETRIES = 3;
    // Cooldown prevents rapid-fire reload attempts when GPU is unstable
    let lastWebglAttempt = 0;
    const WEBGL_COOLDOWN_MS = 2000;
    // Flag set by event handlers when WebGL context is lost — avoids
    // probing canvas contexts directly (which can interfere with renderers).
    let webglContextLost = false;

    /** Refresh the terminal viewport without disrupting the user's scroll position. */
    const safeRefresh = () => {
      const viewport = xterm.buffer.active.viewportY;
      xterm.refresh(0, xterm.rows - 1);
      // Restore scroll position if the refresh moved it
      if (xterm.buffer.active.viewportY !== viewport) {
        xterm.scrollToLine(viewport);
      }
    };

    /** Dispose the current WebGL addon safely and force a canvas re-render.
     *  Idempotent — only counts as one failure per actual disposal. */
    const disposeWebgl = (reason: string) => {
      if (!currentWebgl) return;
      if (import.meta.env.DEV) console.debug(`[Terminal ${tabId}] WebGL disposed: ${reason}`);
      try { currentWebgl.dispose(); } catch { /* already disposed */ }
      currentWebgl = null;
      webglContextLost = true;
      webglFailures++;
      if (!cancelled) safeRefresh();
    };

    const loadWebgl = () => {
      if (currentWebgl || webglFailures >= MAX_WEBGL_RETRIES) return;
      const now = Date.now();
      if (now - lastWebglAttempt < WEBGL_COOLDOWN_MS) return;
      lastWebglAttempt = now;

      let addon: WebglAddon | null = null;
      try {
        addon = new WebglAddon();
        addon.onContextLoss(() => {
          disposeWebgl("onContextLoss");
        });
        xterm.loadAddon(addon);
        currentWebgl = addon;
        webglFailures = 0;
        webglContextLost = false;

        // Listen directly on the WebGL canvas for context loss — backup for
        // cases where the addon's onContextLoss doesn't fire (driver bugs,
        // context eviction with many tabs, etc.)
        requestAnimationFrame(() => {
          if (cancelled || !currentWebgl) return;
          const canvases = containerRef.current?.querySelectorAll("canvas");
          canvases?.forEach((canvas) => {
            canvas.addEventListener("webglcontextlost", () => {
              disposeWebgl("canvas webglcontextlost event");
            }, { once: true });
          });
        });
      } catch {
        try { addon?.dispose(); } catch { /* ok */ }
        currentWebgl = null;
        webglFailures++;
      }
    };
    loadWebgl();

    // Shared paste logic used by both Ctrl+V and right-click → Paste.
    // Guard against double-fire: Ctrl+V keydown + native paste event can both trigger.
    const doPaste = async () => {
      if (pasteInFlightRef.current) return;
      pasteInFlightRef.current = true;
      try {
        if (exitedRef.current) {
          onRequestCloseRef.current(tabIdRef.current);
          return;
        }
        if (!sessionIdRef.current) return;
        // Try text first — Tauri plugin, then navigator.clipboard fallback
        let text: string | null = null;
        try {
          text = await readText();
        } catch (textErr) {
          console.debug("Tauri clipboard readText failed, trying navigator.clipboard:", textErr);
          try {
            text = await navigator.clipboard.readText();
          } catch {
            console.debug("navigator.clipboard also failed");
          }
        }
        if (text) {
          const sanitized = sanitizePastedText(text);
          if (sanitized) {
            const sid = sessionIdRef.current;
            if (!sid) return;
            const bracketed = `\x1b[200~${sanitized}\x1b[201~`;
            await writePty(sid, bracketed);
            return;
          }
        }
        // Fallback: try clipboard image — save as PNG temp file and paste the path
        try {
          const path = await saveClipboardImage();
          const sid = sessionIdRef.current;
          if (!sid) return;
          const quoted = path.includes(" ") ? `"${path}"` : path;
          const bracketed = `\x1b[200~${quoted}\x1b[201~`;
          await writePty(sid, bracketed);
        } catch (err) {
          console.warn("Clipboard paste failed:", err);
          xtermRef.current?.write("\x07"); // bell
          const msg = (err instanceof Error ? err.message : String(err)).replace(/\x1b/g, "");
          xtermRef.current?.write(`\r\n\x1b[33m[paste failed: ${msg}]\x1b[0m`);
        }
      } finally {
        pasteInFlightRef.current = false;
      }
    };

    xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;
      if (event.ctrlKey && !event.shiftKey && event.key === "t") return false;
      if (event.ctrlKey && event.key === "F4") return false;
      if (event.ctrlKey && event.key === "Tab") return false;
      // Handle Ctrl+C copy — if text is selected, copy to clipboard;
      // otherwise let it pass through as SIGINT to the PTY.
      if (event.ctrlKey && !event.shiftKey && event.key === "c") {
        const selection = xterm.getSelection();
        if (selection) {
          event.preventDefault();
          writeText(selection).catch((err) => {
            console.warn("Clipboard copy failed:", err);
          });
          xterm.clearSelection();
          return false;
        }
        return true;
      }
      // Handle Ctrl+V paste explicitly — WebView2 doesn't reliably forward
      // the native paste event to xterm's internal textarea.
      if (event.ctrlKey && !event.shiftKey && event.key === "v") {
        if (event.repeat) return false;
        event.preventDefault();
        doPaste();
        return false;
      }
      return true;
    });

    // Intercept native paste events (right-click → Paste, Ctrl+V browser-level).
    // We handle paste ourselves via clipboard APIs so xterm's built-in handler
    // doesn't produce duplicates or miss image content.
    const handleNativePaste = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      doPaste();
    };
    containerRef.current.addEventListener("paste", handleNativePaste, true);

    xterm.onData((data) => {
      if (exitedRef.current) {
        onRequestCloseRef.current(tabIdRef.current);
        return;
      }
      if (!sessionIdRef.current) return;

      // ── Agent mode input handling ──
      if (tabType === "agent") {
        const state = agentInputStateRef.current;

        if (state === "awaiting_permission") {
          // Only accept Y/y/N/n/Enter
          if (data === "Y" || data === "y" || data === "\r") {
            xterm.write("Y\r\n");
            respondPermission(tabIdRef.current, true).catch(() => {});
            agentInputStateRef.current = "processing";
          } else if (data === "N" || data === "n") {
            xterm.write("N\r\n");
            respondPermission(tabIdRef.current, false).catch(() => {});
            agentInputStateRef.current = "processing";
          }
          return;
        }

        if (state === "awaiting_input") {
          if (data === "\r") {
            // Send the buffered input
            const text = agentInputBufRef.current;
            agentInputBufRef.current = "";
            xterm.write("\r\n");
            if (text) {
              agentInputStateRef.current = "processing";
              xterm.write(ESC_CURSOR_HIDE);
              sendAgentMessage(tabIdRef.current, text).catch(() => {});
            }
          } else if (data === "\x7f" || data === "\b") {
            // Backspace
            if (agentInputBufRef.current.length > 0) {
              agentInputBufRef.current = agentInputBufRef.current.slice(0, -1);
              xterm.write("\b \b");
            }
          } else if (data === "\x03") {
            // Ctrl+C — clear input
            agentInputBufRef.current = "";
            xterm.write("^C\r\n");
            // Re-show prompt
            const rendered = renderAgentEvent({ type: "inputRequired" }, themeColorsRef.current, xterm.cols);
            xterm.write(rendered);
          } else if (data.length === 1 && data >= " ") {
            // Regular character
            agentInputBufRef.current += data;
            xterm.write(data);
          } else if (data.length > 1 && !data.startsWith("\x1b")) {
            // Pasted text (multi-char, non-escape)
            agentInputBufRef.current += data;
            xterm.write(data);
          }
          return;
        }

        if (state === "processing") {
          if (data === "\x03") {
            // Ctrl+C during processing — interrupt
            killAgent(tabIdRef.current).catch(() => {});
          }
          return;
        }

        // idle — ignore input until SDK is ready
        return;
      }

      // ── PTY mode input handling ──
      // Bookmark: when user presses Enter, record the buffer line as a prompt bookmark.
      // Debounce: skip if same line as last bookmark (rapid Enter presses, empty confirms).
      if (data === "\r") {
        const line = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
        if (line !== lastBookmarkLineRef.current) {
          const lineContent = xterm.buffer.active.getLine(line);
          const text = lineContent?.translateToString(true).trim() ?? "";
          if (text.length > 0) {
            lastBookmarkLineRef.current = line;
            const bm = bookmarksRef.current;
            // Prune bookmarks outside current buffer range
            const minLine = xterm.buffer.active.baseY;
            if (bm.size > 1500) {
              const stale = [...bm.keys()].filter(b => b < minLine);
              stale.forEach(b => bm.delete(b));
            }
            // Cap at 2000 — strip leading prompt chars (›, ❯, >)
            if (bm.size < 2000) bm.set(line, text.replace(/^[›❯>\s]+/, "").slice(0, MAX_BOOKMARK_TEXT));
          }
        }
      }
      writePty(sessionIdRef.current, data).catch(() => {});
    });

    // Clear all bookmarks when the buffer shrinks significantly (e.g. /clear,
    // /compact in Claude Code). After a compact, all previous line positions
    // are invalid — partial pruning would leave stale bookmarks pointing to
    // wrong content.
    // Guard: skip during/after resize — terminal width changes cause line
    // reflow (unwrapping) that shrinks buffer.active.length without any
    // actual content being cleared.
    xterm.onWriteParsed(() => {
      const bufLen = xterm.buffer.active.length;
      const prevLen = prevBufferLenRef.current;
      prevBufferLenRef.current = bufLen;
      if (prevLen > 0 && bufLen < prevLen - xterm.rows) {
        // Ignore buffer shrinkage within RESIZE_REFLOW_MS of a resize — reflow, not clear
        if (Date.now() - lastResizeTimeRef.current < RESIZE_REFLOW_MS) return;
        const bm = bookmarksRef.current;
        if (bm.size === 0) return;
        bm.clear();
        lastBookmarkLineRef.current = -1;
      }
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    setXtermReady(xterm);

    let lastCols = 0;
    let lastRows = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let cursorShowTimer: ReturnType<typeof setTimeout> | undefined;
    const CURSOR_IDLE_MS = 80;

    const syncPtySize = (debounce: boolean) => {
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        // Agent tabs don't have a PTY to resize
        if (tabType === "agent") return;
        if (sessionIdRef.current) {
          if (debounce) {
            // Capture session ID now — session may change within the 80ms window.
            const capturedSid = sessionIdRef.current;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (sessionIdRef.current === capturedSid) {
                resizePty(capturedSid, cols, rows).catch(() => {});
              }
            }, 80);
          } else {
            resizePty(sessionIdRef.current, cols, rows).catch(() => {});
          }
        }
      }
    };

    const fitAndResize = () => {
      lastResizeTimeRef.current = Date.now();
      fitAddon.fit();
      syncPtySize(false);
    };
    fitAndResizeRef.current = fitAndResize;

    // Cancellation flag — checked in async callbacks to prevent post-disposal access
    let cancelled = false;

    // Throttle ResizeObserver to one fit per frame + debounce PTY resize
    const observer = new ResizeObserver(() => {
      if (resizeRafRef.current) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        if (cancelled) return;
        lastResizeTimeRef.current = Date.now();
        fitAddon.fit();
        syncPtySize(true);
      });
    });
    observer.observe(containerRef.current);

    // Defer fit + spawn to next frame so the container has its final layout.
    // Use cancellation flag to prevent orphaned PTY if component unmounts before rAF fires.
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      fitAndResize();
      const cols = xterm.cols;
      const rows = xterm.rows;

      // ── Agent mode branch ────────────────────────────────────
      if (tabType === "agent") {
        // Show logo directly
        xterm.write(ESC_CURSOR_HIDE + ANSI_LOGO + "\r\n\r\n");

        const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-6[1m]", "claude-opus-4-6[1m]"];
        const EFFORTS = ["high", "medium", "low"];
        const modelId = MODELS[modelIdx] || "";
        const effortId = EFFORTS[effortIdx] || "high";

        const handleAgentEvent = (event: AgentEvent) => {
          if (cancelled) return;
          const rendered = renderAgentEvent(event, themeColorsRef.current, xterm.cols);
          if (rendered) xterm.write(rendered);

          if (event.type === "inputRequired") {
            agentInputStateRef.current = "awaiting_input";
            agentInputBufRef.current = "";
            xterm.write(ESC_CURSOR_SHOW);
          } else if (event.type === "permission") {
            agentInputStateRef.current = "awaiting_permission";
          } else if (event.type === "result") {
            onAgentResultRef.current?.(tabIdRef.current, event);
          } else if (event.type === "exit") {
            exitedRef.current = true;
            onExitRef.current(tabIdRef.current, event.code);
          }

          if (!isActiveRef.current) {
            onNewOutputRef.current(tabIdRef.current);
          }
        };

        spawnAgent(
          tabId,
          projectPath,
          modelId,
          effortId,
          stripNonBmpAndSurrogates(systemPrompt),
          skipPerms,
          handleAgentEvent,
        )
          .then((channel) => {
            if (cancelled) {
              killAgent(tabId).catch(() => {});
              return;
            }
            sessionIdRef.current = tabId; // Use tabId as session key for agent mode
            channelRef.current = channel;
            onSessionCreatedRef.current(tabIdRef.current, tabId);
          })
          .catch((err) => {
            if (cancelled) return;
            onErrorRef.current(tabIdRef.current, String(err));
            xterm.write(`\r\n\x1b[91mError: ${String(err).replace(/\x1b/g, "")}\x1b[0m`);
          });

        // Early return — skip PTY spawn
        return;
      }

      // ── PTY mode (terminal tabs) ─────────────────────────────
      // For Claude (toolIdx 0), buffer initial output until we detect the
      // horizontal separator (─────). Replace Claude's block-char logo with
      // the Anvil ASCII logo, keep everything else (separator, prompt, status).
      // No CUP offset or PTY row reduction — Claude uses the full terminal.
      // The logo acts as a startup splash that gets overwritten when Claude
      // redraws (e.g. on resize or when output fills the screen).
      let bannerBuf: string | null = toolIdx === 0 ? "" : null;
      /** Detect screen clear (ESC[2J/3J) for banner re-interception on resize. */
      const hasScreenClear = (s: string): number => {
        let maxEnd = -1;
        for (const seq of ["\x1b[2J", "\x1b[3J"]) {
          const i = s.lastIndexOf(seq);
          if (i !== -1) maxEnd = Math.max(maxEnd, i + seq.length);
        }
        return maxEnd;
      };

      spawnClaude(
        projectPath,
        toolIdx,
        modelIdx,
        effortIdx,
        skipPerms,
        autocompact,
        stripNonBmpAndSurrogates(systemPrompt),
        cols,
        rows,
        (data: string) => {
          if (bannerBuf !== null) {
            bannerBuf += data;
            const endMatch = BANNER_END_RE.exec(bannerBuf);
            if (endMatch || bannerBuf.length > BANNER_BUF_MAX) {
              const rest = endMatch
                ? bannerBuf.slice(endMatch.index + 1) // keep from \n onward (the ─── line)
                : bannerBuf; // fallback: write everything
              bannerBuf = null;
              xtermRef.current?.write(ESC_CURSOR_HIDE + ANSI_LOGO + "\r\n" + rest);
            }
            return;
          }
          // On screen clear (resize redraw), Claude redraws its banner.
          // Re-activate banner buffering to replace it with our logo again.
          if (toolIdx === 0) {
            const clearEnd = hasScreenClear(data);
            if (clearEnd !== -1) {
              const pre = data.slice(0, clearEnd);
              xtermRef.current?.write(pre);
              bannerBuf = data.slice(clearEnd);
              return;
            }
          }
          // Hide cursor during ALL output, not just cursor-repositioning
          // sequences. Rapid writes cause the cursor to flash at intermediate
          // positions ("ghost caret" flickering through the text). A debounced
          // show ensures the cursor only appears once output settles.
          clearTimeout(cursorShowTimer);
          const lastHide = data.lastIndexOf(ESC_CURSOR_HIDE);
          const lastShow = data.lastIndexOf(ESC_CURSOR_SHOW);
          const endsWithHide = lastHide > lastShow;
          xtermRef.current?.write(ESC_CURSOR_HIDE + data);
          if (!endsWithHide) {
            cursorShowTimer = setTimeout(() => {
              xtermRef.current?.write(ESC_CURSOR_SHOW);
            }, CURSOR_IDLE_MS);
          }
          if (!isActiveRef.current) {
            onNewOutputRef.current(tabIdRef.current);
          }
        },
        (code: number) => {
          exitedRef.current = true;
          xtermRef.current?.write(
            `\r\n\x1b[90m[Process exited with code ${code}. Press any key to close tab]\x1b[0m`,
          );
          onExitRef.current(tabIdRef.current, code);
        },
      )
        .then(({ sessionId, channel }) => {
          if (cancelled) {
            // Component unmounted while spawn was in flight — kill orphan
            killSession(sessionId).catch(() => {});
            return;
          }
          sessionIdRef.current = sessionId;
          channelRef.current = channel;
          onSessionCreatedRef.current(tabIdRef.current, sessionId);
          // Reset tracking to spawn-time values so fitAndResize detects
          // the delta if the terminal resized while spawn was in flight.
          // Without this, a resize during spawn is recorded in lastCols/lastRows
          // but never sent (sessionId was null), and the post-spawn fit sees
          // no change and skips the PTY resize — leaving the PTY at stale dims.
          lastCols = cols;
          lastRows = rows;
          fitAndResize();
        })
        .catch((err) => {
          if (cancelled) return;
          onErrorRef.current(tabIdRef.current, String(err));
          xtermRef.current?.write(`\r\n\x1b[91mError: ${String(err).replace(/\x1b/g, "")}\x1b[0m`);
        });
    });

    const heartbeatInterval = setInterval(() => {
      if (cancelled) return;
      if (sessionIdRef.current && !exitedRef.current) {
        sendHeartbeat(sessionIdRef.current).catch(() => {});
      }
      // If a context loss event fired between heartbeats, dispose the addon
      // now and force canvas fallback. The webglContextLost flag is set by
      // onContextLoss / webglcontextlost handlers even if disposeWebgl was
      // already called (idempotent), so this is a safety net.
      if (currentWebgl && webglContextLost) {
        disposeWebgl("periodic health check: context lost");
      }
    }, 5000);

    // On wake from standby, send an immediate heartbeat so the reaper doesn't
    // time out sessions that are still alive but missed beats during sleep.
    // If the heartbeat fails, the session was already reaped — surface exit to user.
    const handleVisibilityChange = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        // After wake from standby, WebGL context is almost certainly lost.
        // Dispose broken addon if a context loss event was flagged.
        if (currentWebgl && webglContextLost) {
          disposeWebgl("visibility: context lost during standby");
        }

        // Try to restore WebGL, or force canvas re-render as fallback
        if (!currentWebgl) {
          loadWebgl();
        }

        // Always force a refresh after wake — even if WebGL looks alive,
        // glyph textures may be corrupted after GPU power state changes
        requestAnimationFrame(() => {
          if (!cancelled) safeRefresh();
        });

        if (sessionIdRef.current && !exitedRef.current) {
          sendHeartbeat(sessionIdRef.current).catch(() => {
            if (!exitedRef.current) {
              exitedRef.current = true;
              xtermRef.current?.write(
                `\r\n\x1b[90m[Session lost during standby. Press any key to close tab]\x1b[0m`,
              );
              onExitRef.current(tabIdRef.current, -1);
            }
          });
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // File drag-and-drop: write dropped paths into PTY
    // Only allow safe Windows path characters to prevent shell injection
    // Only allow alphanumeric, whitespace, common punctuation — exclude cmd.exe
    // metacharacters (%, ^, !, &, |) that would expand or inject when written to a PTY.
    const SAFE_WIN_PATH = /^[a-zA-Z]:\\[\w\s.\-\\()]+$/;
    let unlistenDragDrop: (() => void) | null = null;
    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type !== "drop") return;
      if (exitedRef.current || !sessionIdRef.current || !isActiveRef.current) return;
      const safePaths = event.payload.paths.filter((p) => SAFE_WIN_PATH.test(p));
      if (safePaths.length === 0) return;
      const paths = safePaths
        .map((p) => (p.includes(" ") ? `"${p}"` : p))
        .join(" ");
      writePty(sessionIdRef.current, paths + " ").catch(() => {});
    }).then((unlisten) => {
      if (cancelled) { unlisten(); return; }
      unlistenDragDrop = unlisten;
    }).catch(() => {});

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(resizeRafRef.current);
      clearTimeout(resizeTimer);
      clearTimeout(cursorShowTimer);
      clearInterval(heartbeatInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      containerRef.current?.removeEventListener("paste", handleNativePaste, true);
      unlistenDragDrop?.();
      observer.disconnect();
      if (sessionIdRef.current) {
        if (tabType === "agent") {
          killAgent(sessionIdRef.current).catch(() => {});
        } else {
          killSession(sessionIdRef.current).catch(() => {});
        }
      }
      if (channelRef.current) {
        channelRef.current.onmessage = () => {};
      }
      try { currentWebgl?.dispose(); } catch { /* ok */ }
      currentWebgl = null;
      setXtermReady(null);
      xterm.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isActive) {
      // Defer fit to next frame so the browser has reflowed after
      // visibility:hidden -> visible. Without this, fitAddon.fit() reads
      // stale container dimensions and computes incorrect column counts.
      const fitRafId = requestAnimationFrame(() => {
        if (!xtermRef.current) return;
        // Cancel any pending ResizeObserver rAF to avoid a redundant
        // second fit() + PTY resize in the same frame.
        if (resizeRafRef.current) {
          cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = 0;
        }
        fitAndResizeRef.current?.();
        // Force a full content refresh on every tab switch. This catches
        // cases where WebGL context was evicted while the tab was inactive
        // (GPU reclaims contexts for inactive canvases) or glyph textures
        // were silently corrupted. Cheap operation — just redraws existing buffer.
        // Preserve scroll position — refresh redraws the buffer without moving viewport
        const vp = xtermRef.current.buffer.active.viewportY;
        xtermRef.current.refresh(0, xtermRef.current.rows - 1);
        if (xtermRef.current.buffer.active.viewportY !== vp) {
          xtermRef.current.scrollToLine(vp);
        }
        xtermRef.current.focus();
      });
      return () => cancelAnimationFrame(fitRafId);
    }
  }, [isActive]);

  // Update xterm theme when theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getXtermTheme(themeIdx);
    }
  }, [themeIdx]);

  // Update font when font settings change
  useEffect(() => {
    if (xtermRef.current) {
      if (fontSize) xtermRef.current.options.fontSize = fontSize;
      if (fontFamily) xtermRef.current.options.fontFamily = `'${fontFamily}', 'Consolas', monospace`;
      fitAndResizeRef.current?.();
    }
  }, [fontFamily, fontSize]);

  return (
    <div className="terminal-wrapper">
      <div ref={containerRef} className="terminal-container" />
      <BookmarkList xterm={xtermReady} isActive={isActive} bookmarksRef={bookmarksRef} />
      <Minimap xterm={xtermReady} isActive={isActive} bookmarksRef={bookmarksRef} />
    </div>
  );
});
