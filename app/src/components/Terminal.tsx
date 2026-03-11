import { memo, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { spawnClaude, writePty, resizePty, sendHeartbeat, killSession } from "../hooks/usePty";
import { getXtermTheme } from "../themes";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

interface TerminalProps {
  tabId: string;
  projectPath: string;
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

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // Gracefully fall back to canvas renderer on GPU context loss.
        // This prevents a single tab's WebGL issue from affecting others.
        try { webglAddon.dispose(); } catch { /* already disposed */ }
      });
      xterm.loadAddon(webglAddon);
    } catch {
      // Canvas renderer fallback — WebGL not available or failed to init
    }

    xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;
      if (event.ctrlKey && !event.shiftKey && event.key === "t") return false;
      if (event.ctrlKey && event.key === "F4") return false;
      if (event.ctrlKey && event.key === "Tab") return false;
      return true;
    });

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
    const fitAndResize = () => {
      fitAddon.fit();
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        if (sessionIdRef.current) {
          resizePty(sessionIdRef.current, cols, rows).catch(() => {});
        }
      }
    };
    fitAndResizeRef.current = fitAndResize;

    const observer = new ResizeObserver(() => { fitAndResize(); });
    observer.observe(containerRef.current);

    // Defer fit + spawn to next frame so the container has its final layout.
    // Use cancellation flag to prevent orphaned PTY if component unmounts before rAF fires.
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      fitAndResize();
      const cols = xterm.cols;
      const rows = xterm.rows;

      spawnClaude(
        projectPath,
        modelIdx,
        effortIdx,
        skipPerms,
        cols,
        rows,
        (data: Uint8Array) => {
          xtermRef.current?.write(data);
          if (!isActiveRef.current) {
            onNewOutputRef.current(tabIdRef.current);
          }
        },
        (code: number) => {
          exitedRef.current = true;
          xtermRef.current?.write(
            `\r\n\x1b[90m[Claude exited with code ${code}. Press any key to close tab]\x1b[0m`,
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
          fitAndResize(); // catch resize events lost during spawn
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

    // File drag-and-drop: write dropped paths into PTY
    // Only allow safe Windows path characters to prevent shell injection
    const SAFE_WIN_PATH = /^[a-zA-Z]:\\[\w\s.\-\\()[\]{}@#$%^+=~,]+$/;
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
      clearInterval(heartbeatInterval);
      unlistenDragDrop?.();
      observer.disconnect();
      if (sessionIdRef.current) {
        killSession(sessionIdRef.current).catch(() => {});
      }
      if (channelRef.current) {
        channelRef.current.onmessage = () => {};
      }
      xterm.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isActive && fitAndResizeRef.current) {
      fitAndResizeRef.current();
      xtermRef.current?.focus();
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
