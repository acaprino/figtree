import { memo, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { spawnClaude, writePty, resizePty, sendHeartbeat, killSession, saveClipboardImage } from "../hooks/usePty";
import { getXtermTheme } from "../themes";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

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
    .replace(/\u2192/g, "->")
    .replace(/\u2190/g, "<-")
    // Strip control characters (keep \t, \n, \r)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

interface TerminalProps {
  tabId: string;
  projectPath: string;
  toolIdx: number;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
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
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const channelRef = useRef<any>(null);
  const resizeRafRef = useRef(0);
  const tabIdRef = useRef(tabId);
  const isActiveRef = useRef(isActive);
  const onRequestCloseRef = useRef(onRequestClose);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const onNewOutputRef = useRef(onNewOutput);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);

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
      fontSize: fontSize || 14,
      fontFamily: fontFamily ? `'${fontFamily}', 'Consolas', monospace` : "'Cascadia Code', 'Consolas', monospace",
      theme: getXtermTheme(themeIdx),
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

    // Track WebGL addon for recovery after context loss (e.g. system standby).
    // Retry cap prevents futile reloads on hardware without WebGL support.
    let currentWebgl: WebglAddon | null = null;
    let webglFailures = 0;
    const MAX_WEBGL_RETRIES = 3;

    const loadWebgl = () => {
      if (currentWebgl || webglFailures >= MAX_WEBGL_RETRIES) return;
      let addon: WebglAddon | null = null;
      try {
        addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Dispose broken WebGL and force canvas re-render so text is readable
          try { addon!.dispose(); } catch { /* already disposed */ }
          currentWebgl = null;
          webglFailures++;
          if (!cancelled) xterm.refresh(0, xterm.rows - 1);
        });
        xterm.loadAddon(addon);
        currentWebgl = addon;
        webglFailures = 0;
      } catch {
        try { addon?.dispose(); } catch { /* ok */ }
        currentWebgl = null;
        webglFailures++;
      }
    };
    loadWebgl();

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
        (async () => {
          if (exitedRef.current) {
            onRequestCloseRef.current(tabIdRef.current);
            return;
          }
          if (!sessionIdRef.current) return;
          // Try text first
          try {
            const text = await readText();
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
          } catch (textErr) {
            console.debug("Clipboard text unavailable, trying image:", textErr);
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
          }
        })();
        return false;
      }
      return true;
    });

    // Block the native paste event from reaching xterm's internal textarea.
    // Without this, Ctrl+V triggers both our custom handler (readText → writePty)
    // AND xterm's built-in paste handler (via onData), causing duplicate/garbled pastes.
    const blockNativePaste = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    containerRef.current.addEventListener("paste", blockNativePaste, true);

    xterm.onData((data) => {
      if (exitedRef.current) {
        onRequestCloseRef.current(tabIdRef.current);
        return;
      }
      if (!sessionIdRef.current) return;
      writePty(sessionIdRef.current, data).catch(() => {});
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    let lastCols = 0;
    let lastRows = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

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

      spawnClaude(
        projectPath,
        toolIdx,
        modelIdx,
        effortIdx,
        skipPerms,
        cols,
        rows,
        (data: string) => {
          xtermRef.current?.write(data);
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
          xtermRef.current?.write(`\r\n\x1b[91mError: ${err}\x1b[0m`);
        });
    });

    const heartbeatInterval = setInterval(() => {
      if (sessionIdRef.current && !exitedRef.current) {
        sendHeartbeat(sessionIdRef.current).catch(() => {});
      }
    }, 5000);

    // On wake from standby, send an immediate heartbeat so the reaper doesn't
    // time out sessions that are still alive but missed beats during sleep.
    // If the heartbeat fails, the session was already reaped — surface exit to user.
    const handleVisibilityChange = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        // After wake from standby, WebGL context may be silently lost.
        // Attempt to reload WebGL; if it fails, force a canvas re-render
        // so terminal text remains readable.
        if (!currentWebgl) {
          loadWebgl();
          if (!currentWebgl) {
            // WebGL still unavailable — ensure canvas renderer is up to date
            xterm.refresh(0, xterm.rows - 1);
          }
        }
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
      clearInterval(heartbeatInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      containerRef.current?.removeEventListener("paste", blockNativePaste, true);
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

  return <div ref={containerRef} className="terminal-container" />;
});
