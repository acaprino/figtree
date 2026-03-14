import { memo, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { spawnClaude, writePty, resizePty, sendHeartbeat, killSession, saveClipboardImage } from "../hooks/usePty";
import { getXtermTheme } from "../themes";
import Minimap from "./Minimap";
import BookmarkList from "./BookmarkList";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

/** Single regex matching any cursor-repositioning escape sequence:
 *  ESC 7/8 (DEC save/restore), CSI s/u (ANSI save/restore), CSI row;colH (CUP).
 *  One pass replaces six sequential string scans on every PTY data chunk. */
const CURSOR_MOVE_RE = /\x1b[78]|\x1b\[[su]|\x1b\[\d+;\d*H/;
const ESC_CURSOR_HIDE = "\x1b[?25l";
const ESC_CURSOR_SHOW = "\x1b[?25h";
const MAX_BOOKMARK_TEXT = 200;

/** Banner stripping constants — Claude's startup box has top/bottom borders
 *  plus a separator line, each containing runs of ─ (U+2500). */
const BANNER_DASHES = "\u2500\u2500\u2500\u2500\u2500";
const BANNER_DASH_THRESHOLD = 3;
const BANNER_BUF_MAX = 8192;
/** How long (ms) to strip cursor-repositioned status bar output after the
 *  banner is consumed. Prevents Claude's status from overwriting the Anvil logo. */
const BANNER_COOLDOWN_MS = 2000;
/** How long (ms) after a resize to ignore buffer shrinkage — reflow (line
 *  unwrapping) reduces buffer.active.length without content being cleared. */
const RESIZE_REFLOW_MS = 500;

/** Replace common non-ASCII characters with ASCII equivalents and strip control chars.
 *  This prevents encoding issues when pasting text from editors, web pages, or Word docs. */
function sanitizePastedText(text: string): string {
  return text
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
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    // Strip lone surrogates — defense against non-standard clipboard sources (e.g. Tauri plugin IPC)
    .replace(/[\uD800-\uDFFF]/g, "");
}

interface TerminalProps {
  tabId: string;
  projectPath: string;
  toolIdx: number;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
  autocompact: boolean;
  systemPrompt: string;
  themeIdx: number;
  fontFamily: string;
  fontSize: number;
  isActive: boolean;
  onSessionCreated: (tabId: string, sessionId: string) => void;
  onNewOutput: (tabId: string) => void;
  onExit: (tabId: string, code: number) => void;
  onError: (tabId: string, msg: string) => void;
  onRequestClose: (tabId: string) => void;
}

export default memo(function Terminal({
  tabId,
  projectPath,
  toolIdx,
  modelIdx,
  effortIdx,
  skipPerms,
  autocompact,
  systemPrompt,
  themeIdx,
  fontFamily,
  fontSize,
  isActive,
  onSessionCreated,
  onNewOutput,
  onExit,
  onError,
  onRequestClose,
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
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

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
          const msg = err instanceof Error ? err.message : String(err);
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

      // Write the Anvil ASCII logo into the terminal before spawning so it
      // appears instantly — the hook-based approach only injects into Claude's
      // system context and is never visible to the user.
      xterm.write(
        "\x1b[38;2;139;110;72m        ___\r\n" +
        "       / _ \\\r\n" +
        "      | |_) |\r\n" +
        "       \\___/\x1b[0m\r\n" +
        "\x1b[38;2;108;130;145m    \u2554\u2550\u2550\u2550\u2567\u2550\u2550\u2550\u2557\r\n" +
        "    \u2551       \u2551\r\n" +
        "    \u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563\r\n" +
        "    \u2551       \u2551\r\n" +
        "    \u255a\u2550\u2550\u2564\u2550\u2564\u2550\u2550\u255d\r\n" +
        "   \u2550\u2550\u2550\u2550\u2567\u2550\u2567\u2550\u2550\u2550\u2550\x1b[0m\r\n" +
        "\r\n" +
        "\x1b[38;2;180;190;200m   \u2554\u2550\u2557 \u2566\u2557\u2566 \u2566  \u2566 \u2566 \u2566\r\n" +
        "   \u2560\u2550\u2563 \u2551\u2551\u2551 \u255a\u2557\u2554\u255d \u2551 \u2551\r\n" +
        "   \u2569 \u2569 \u255d\u255a\u255d  \u255a\u255d  \u2569 \u2569\u2550\u255d\x1b[0m\r\n" +
        "\x1b[2m   AI Code Session Launcher\x1b[0m\r\n\r\n"
      );

      // For Claude (toolIdx 0), buffer initial output to strip the built-in
      // banner (▐▛███▜▌ block chars) — Anvil shows its own logo instead.
      let bannerBuf = toolIdx === 0 ? "" : null;
      // After banner is stripped, briefly suppress cursor-repositioned output
      // to prevent Claude's status bar from overwriting the Anvil logo.
      let bannerCooldownEnd = 0;
      // Debounced cursor show — hide during all output, show only after idle.
      // Prevents the cursor from flickering at intermediate write positions.

      spawnClaude(
        projectPath,
        toolIdx,
        modelIdx,
        effortIdx,
        skipPerms,
        autocompact,
        systemPrompt,
        cols,
        rows,
        (data: string) => {
          if (bannerBuf !== null) {
            bannerBuf += data;
            // Count ───── occurrences: Claude's status box has top border
            // (╭───╮), bottom border (╰───╯), and a separator line — 3 total.
            // Wait for all 3 so lastIndexOf reliably finds the separator,
            // not a box border that would keep the status text.
            let dashCount = 0;
            let searchFrom = 0;
            while (dashCount < BANNER_DASH_THRESHOLD) {
              const pos = bannerBuf.indexOf(BANNER_DASHES, searchFrom);
              if (pos === -1) break;
              dashCount++;
              searchFrom = pos + 5;
            }
            if (dashCount >= BANNER_DASH_THRESHOLD || bannerBuf.length > BANNER_BUF_MAX) {
              const idx = bannerBuf.lastIndexOf(BANNER_DASHES);
              if (idx !== -1) {
                // Skip past the separator line itself
                const nlAfter = bannerBuf.indexOf("\n", idx);
                const rest = nlAfter !== -1 ? bannerBuf.slice(nlAfter + 1) : "";
                bannerBuf = null;
                bannerCooldownEnd = Date.now() + BANNER_COOLDOWN_MS;
                // Filter rest through same cooldown logic — it may contain
                // CUP-positioned status bar output that would overwrite the logo.
                if (rest && !CURSOR_MOVE_RE.test(rest)) {
                  xtermRef.current?.write(rest);
                }
              } else {
                // Bail — write everything as-is
                const buf = bannerBuf;
                bannerBuf = null;
                xtermRef.current?.write(buf);
              }
            }
            return;
          }
          // During post-banner cooldown, strip cursor-repositioned sequences
          // (Claude's status bar drawing) from data chunks. Non-cursor output
          // (prompt) passes through and ends the cooldown early.
          if (bannerCooldownEnd) {
            if (Date.now() >= bannerCooldownEnd) {
              bannerCooldownEnd = 0;
            } else if (CURSOR_MOVE_RE.test(data)) {
              // Strip cursor-positioning and all ANSI sequences, then check if
              // any printable text remains. If not, this is pure status bar
              // repositioning — drop it to prevent logo overlap. If printable
              // content exists (e.g. the prompt), end cooldown and write it all.
              const printable = data.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\[[\?]?[0-9;]*[a-zA-Z]|[78])/g, "");
              if (!printable.trim()) return;
              bannerCooldownEnd = 0;
            } else {
              bannerCooldownEnd = 0;
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
          bannerCooldownEnd = 0;
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
          xtermRef.current?.write(`\r\n\x1b[91mError: ${err}\x1b[0m`);
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
        killSession(sessionIdRef.current).catch(() => {});
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
