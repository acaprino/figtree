import { memo, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { spawnAgent, sendAgentMessage, killAgent, respondPermission, saveClipboardImage } from "../hooks/useAgentSession";
import { useAutocomplete } from "../hooks/useAutocomplete";
import { renderAgentEvent } from "../ansiRenderer";
import { getXtermTheme } from "../themes";
import { MODELS, EFFORTS } from "../types";
import type { AgentEvent, ThemeColors } from "../types";
import Minimap from "./Minimap";
import BookmarkList from "./BookmarkList";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

const ESC_CURSOR_HIDE = "\x1b[?25l";
const ESC_CURSOR_SHOW = "\x1b[?25h";
const MAX_BOOKMARK_TEXT = 200;

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
 *  that become surrogate pairs in UTF-16.  Also strips lone surrogates directly. */
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
  projectPath: string;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
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
  onTaglineChange?: (tabId: string, tagline: string) => void;
  autocompleteEnabled?: boolean;
}

export default memo(function Terminal({
  tabId,
  projectPath,
  modelIdx,
  effortIdx,
  skipPerms,
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
  onTaglineChange,
  autocompleteEnabled,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const [xtermReady, setXtermReady] = useState<XTerm | null>(null);
  const bookmarksRef = useRef(new Map<number, string>());
  const prevBufferLenRef = useRef(0);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);
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
  const onTaglineChangeRef = useRef(onTaglineChange);
  // Agent mode state machine: idle → awaiting_input → processing → awaiting_permission
  const agentInputStateRef = useRef<"idle" | "awaiting_input" | "processing" | "awaiting_permission">("idle");
  const agentInputBufRef = useRef("");
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const responseBookmarkedRef = useRef(false);
  const themeColorsRef = useRef(themeColors);

  const autocomplete = useAutocomplete(
    xtermRef,
    tabIdRef,
    agentInputBufRef,
    projectPath,
    autocompleteEnabled !== false,
    0, // toolIdx — always Claude
  );
  const autocompleteRef = useRef(autocomplete);
  autocompleteRef.current = autocomplete;

  useEffect(() => {
    themeColorsRef.current = themeColors;
  }, [themeColors]);

  useEffect(() => {
    onAgentResultRef.current = onAgentResult;
  }, [onAgentResult]);

  useEffect(() => {
    onTaglineChangeRef.current = onTaglineChange;
  }, [onTaglineChange]);

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

    // Agent input helper — appends text to the input buffer and echoes to
    // the terminal. Returns true when in awaiting_input state (text accepted).
    const MAX_AGENT_INPUT = 65536; // 64KB cap
    const tryAgentWrite = (text: string): boolean => {
      if (agentInputStateRef.current !== "awaiting_input") return false;
      if (agentInputBufRef.current.length + text.length > MAX_AGENT_INPUT) return false;
      agentInputBufRef.current += text;
      xtermRef.current?.write(text);
      return true;
    };

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
        if (!agentStartedRef.current) return;
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
            tryAgentWrite(sanitized);
            return;
          }
        }
        // Fallback: try clipboard image — save as PNG temp file and paste the path
        try {
          const path = await saveClipboardImage();
          const quoted = `"${path}"`;
          tryAgentWrite(quoted);
        } catch (err) {
          console.warn("Clipboard paste failed:", err);
          xtermRef.current?.write("\x07"); // bell
          const msg = (err instanceof Error ? err.message : String(err)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
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
      // otherwise let Ctrl+C propagate to the agent (handled in onData).
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
      // Autocomplete: Tab cycles, Right Arrow accepts, Esc dismisses
      if (agentInputStateRef.current === "awaiting_input") {
        const ac = autocompleteRef.current;
        const hasGhost = ac.hasSuggestionRef.current;
        if (event.key === "Tab" && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          if (hasGhost) {
            event.preventDefault();
            ac.cycle();
            return false;
          }
        }
        if (event.key === "ArrowRight" && !event.ctrlKey && !event.shiftKey) {
          if (hasGhost) {
            event.preventDefault();
            const accepted = ac.accept();
            if (accepted) {
              agentInputBufRef.current += accepted;
              xtermRef.current?.write(accepted);
            }
            return false;
          }
        }
        if (event.key === "Escape") {
          if (hasGhost) {
            event.preventDefault();
            ac.dismiss();
            return false;
          }
        }
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
      if (!agentStartedRef.current) return;

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
          autocompleteRef.current.dismiss();
          // Send the buffered input
          const text = agentInputBufRef.current;
          agentInputBufRef.current = "";
          xterm.write("\r\n");
          if (text) {
            // Bookmark the user's prompt at the current line
            const promptLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
            const label = text.length > MAX_BOOKMARK_TEXT ? text.slice(0, MAX_BOOKMARK_TEXT) + "…" : text;
            bookmarksRef.current.set(promptLine, `❯ ${label}`);
            responseBookmarkedRef.current = false;

            agentInputStateRef.current = "processing";
            xterm.write(ESC_CURSOR_HIDE);
            startSpinner("Thinking...");
            onTaglineChangeRef.current?.(tabIdRef.current, "Thinking...");
            sendAgentMessage(tabIdRef.current, text).catch(() => {});
          }
        } else if (data === "\x7f" || data === "\b") {
          autocompleteRef.current.dismiss();
          // Backspace
          if (agentInputBufRef.current.length > 0) {
            agentInputBufRef.current = agentInputBufRef.current.slice(0, -1);
            xterm.write("\b \b");
            autocompleteRef.current.onInputChange();
          }
        } else if (data === "\x03") {
          autocompleteRef.current.dismiss();
          // Ctrl+C — clear input
          agentInputBufRef.current = "";
          xterm.write("^C\r\n");
          // Re-show prompt
          const rendered = renderAgentEvent({ type: "inputRequired" }, themeColorsRef.current, xterm.cols);
          xterm.write(rendered);
        } else if (data.length === 1 && data >= " ") {
          autocompleteRef.current.dismiss();
          // Regular character
          agentInputBufRef.current += data;
          xterm.write(data);
          autocompleteRef.current.onInputChange();
        } else if (data.length > 1 && !data.startsWith("\x1b")) {
          autocompleteRef.current.dismiss();
          // Pasted text (multi-char, non-escape)
          agentInputBufRef.current += data;
          xterm.write(data);
          autocompleteRef.current.onInputChange();
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
      }
    });

    // ── Animated spinner for agent processing state ─────────
    const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIdx = 0;
    let spinnerActive = false;

    const startSpinner = (label: string) => {
      stopSpinner();
      spinnerIdx = 0;
      spinnerActive = true;
      xterm.write(`\x1b[2m${SPINNER_FRAMES[0]} ${label}\x1b[0m`);
      spinnerTimerRef.current = setInterval(() => {
        spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
        xterm.write(`\r\x1b[2K\x1b[2m${SPINNER_FRAMES[spinnerIdx]} ${label}\x1b[0m`);
      }, 80);
    };

    const stopSpinner = () => {
      if (spinnerTimerRef.current) {
        clearInterval(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      if (spinnerActive) {
        spinnerActive = false;
        // Clear spinner line and move cursor up to the prompt line.
        // The next content (streaming text or result) typically starts with
        // \r\n or \n, which brings the cursor back down — so the response
        // appears immediately below the prompt with no blank gap.
        xterm.write("\r\x1b[2K\x1b[A");
      }
    };

    xtermRef.current = xterm;
    setXtermReady(xterm);

    const fitAndResize = () => {
      lastResizeTimeRef.current = Date.now();
      fitAddon.fit();
    };
    fitAndResizeRef.current = fitAndResize;

    // Cancellation flag — checked in async callbacks to prevent post-disposal access
    let cancelled = false;

    // Throttle ResizeObserver to one fit per frame
    const observer = new ResizeObserver(() => {
      if (resizeRafRef.current) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        if (cancelled) return;
        autocompleteRef.current.dismiss();
        lastResizeTimeRef.current = Date.now();
        fitAddon.fit();
      });
    });
    observer.observe(containerRef.current);

    // Defer fit + spawn to next frame so the container has its final layout.
    // Use cancellation flag to prevent orphaned agent if component unmounts before rAF fires.
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      fitAndResize();

      // Show logo directly
      xterm.write(ESC_CURSOR_HIDE + ANSI_LOGO + "\r\n\r\n");

      const modelId = MODELS[modelIdx]?.id || "";
      const effortId = EFFORTS[effortIdx] || "high";

      const handleAgentEvent = (event: AgentEvent) => {
        if (cancelled) return;

        if (event.type === "autocomplete") {
          autocompleteRef.current.handleResponse(event.suggestions, event.seq);
          return; // Don't render autocomplete events as terminal output
        }

        // Stop spinner before rendering new content (except for thinking deltas)
        if (event.type !== "thinking" && event.type !== "progress" && event.type !== "status") {
          stopSpinner();
        }

        // Bookmark the start of Claude's response (first assistant chunk per turn)
        if (event.type === "assistant" && !responseBookmarkedRef.current) {
          responseBookmarkedRef.current = true;
          const responseLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
          // Use first line of response text as preview
          const preview = event.text.split(/\r?\n/)[0].slice(0, MAX_BOOKMARK_TEXT) || "Response";
          bookmarksRef.current.set(responseLine, `◆ ${preview}`);
        }

        const rendered = renderAgentEvent(event, themeColorsRef.current, xterm.cols);
        if (rendered) xterm.write(rendered);

        if (event.type === "inputRequired") {
          stopSpinner();
          agentInputStateRef.current = "awaiting_input";
          agentInputBufRef.current = "";
          xterm.write(ESC_CURSOR_SHOW);
          onTaglineChangeRef.current?.(tabIdRef.current, "");
        } else if (event.type === "permission") {
          stopSpinner();
          agentInputStateRef.current = "awaiting_permission";
          onTaglineChangeRef.current?.(tabIdRef.current, `Permission: ${event.tool}`);
        } else if (event.type === "toolUse") {
          const inp = event.input as Record<string, string> | undefined;
          const detail = event.tool === "Bash" ? (inp?.command || "").slice(0, 40)
            : event.tool === "Edit" || event.tool === "Write" || event.tool === "Read"
              ? (inp?.file_path || "").split(/[/\\]/).pop() || ""
              : "";
          onTaglineChangeRef.current?.(tabIdRef.current, detail ? `${event.tool}: ${detail}` : event.tool);
        } else if (event.type === "thinking") {
          // Start/keep animated spinner for thinking — the static rendered text
          // from ansiRenderer is overwritten by the spinner animation
          if (!spinnerTimerRef.current) {
            startSpinner("Thinking...");
          }
          onTaglineChangeRef.current?.(tabIdRef.current, "Thinking...");
        } else if (event.type === "result") {
          stopSpinner();
          onAgentResultRef.current?.(tabIdRef.current, event);
          onTaglineChangeRef.current?.(tabIdRef.current, "");
        } else if (event.type === "exit") {
          stopSpinner();
          exitedRef.current = true;
          onExitRef.current(tabIdRef.current, event.code);
          onTaglineChangeRef.current?.(tabIdRef.current, "");
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
        .then(() => {
          if (cancelled) {
            killAgent(tabId).catch(() => {});
            return;
          }
          agentStartedRef.current = true;
          onSessionCreatedRef.current(tabIdRef.current, tabId);
        })
        .catch((err) => {
          if (cancelled) return;
          onErrorRef.current(tabIdRef.current, String(err));
          xterm.write(`\r\n\x1b[91mError: ${String(err).replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x1b[0m`);
        });
    });

    // Periodic WebGL health check — if a context loss event fired, dispose the
    // addon and force canvas fallback.
    const webglHealthInterval = setInterval(() => {
      if (cancelled) return;
      if (currentWebgl && webglContextLost) {
        disposeWebgl("periodic health check: context lost");
      }
    }, 5000);

    // On wake from standby, recover WebGL and refresh the terminal.
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
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // File drag-and-drop: insert dropped paths into agent input
    let unlistenDragDrop: (() => void) | null = null;
    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type !== "drop") return;
      if (exitedRef.current || !agentStartedRef.current || !isActiveRef.current) return;
      if (event.payload.paths.length === 0) return;
      const paths = event.payload.paths
        .map((p) => (p.includes(" ") ? `"${p}"` : p))
        .join(" ");
      tryAgentWrite(paths + " ");
    }).then((unlisten) => {
      if (cancelled) { unlisten(); return; }
      unlistenDragDrop = unlisten;
    }).catch(() => {});

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(resizeRafRef.current);
      clearInterval(webglHealthInterval);
      if (spinnerTimerRef.current) {
        clearInterval(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      containerRef.current?.removeEventListener("paste", handleNativePaste, true);
      unlistenDragDrop?.();
      observer.disconnect();
      autocompleteRef.current.cleanup();
      if (agentStartedRef.current) {
        killAgent(tabIdRef.current).catch(() => {});
      }
      try { currentWebgl?.dispose(); } catch { /* ok */ }
      currentWebgl = null;
      setXtermReady(null);
      // Detach from DOM before dispose to prevent xterm.js RenderService race
      // where syncScrollArea fires after the render service is torn down
      xterm.element?.remove();
      try { xterm.dispose(); } catch (e) { console.debug("xterm dispose:", e); }
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
        // second fit() in the same frame.
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
