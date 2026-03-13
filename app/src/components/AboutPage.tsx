import { memo, useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { THEMES } from "../types";
import "./AboutPage.css";

interface AboutPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

const LOGO = `
                        ██████
                      ███▓▓▓██
                     ███▓▓▓▓██
                   ███▓▓▓▓▓▓████████████████████████
                  ███▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██▓▓▓▓███
                  ██▓▓▓▓▓▓▓▓█▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▒▒▒▒▒▓██
                  ██▓██▓▓▓▓▓█▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▒▒▒▒▒▓██
                  ██▓██▓▓▓▓▓██████████████████████████
                  ██▓██▓▓▓▓▓██
                  ██▓██▓▓▓▓▓██
             ███████▓▓▓▓▓▓▓▓███████
               ██████████████████
              ████            ████
            ███████████████████████████████
            █▓▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▓██
    █████████▓▓███████████████████████▓▓▓█████████
    ███▓▓▓▓▓█▓▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▓▓▓▓▓▓██
    ███▓▓▓▓▓█▓▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▓▓▓▓▓▓██
    ███▓▓▓▓▓█▓▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▓▓▓▓▓▓██
    ███▓▓▓▓▓█▓▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█▓▓▓▓▓▓██
     ████████▓▓██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓██▓█████
          ███▓▒▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓████
            █▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
            ███████████████████████████████
                 ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
                 ████████████████████
                 ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
                 ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
            ███████████████████████████████
            ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓███
            ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
            ███████████████████████████████
`.trimStart();

function buildAppInfo(version: string) {
  const themeCount = THEMES.length;
  return `\
  ╔══════════════════════════════════════════╗
  ║              A N V I L                   ║
  ║     Claude Code Session Launcher         ║
  ╠══════════════════════════════════════════╣
  ║                                          ║
  ║  Version    ${version.padEnd(28)}║
  ║  Platform   Windows (Tauri 2)            ║
  ║  Frontend   React 19 + TypeScript        ║
  ║  Backend    Rust + Tauri 2               ║
  ║  Terminal   xterm.js + WebGL             ║
  ║                                          ║
  ╠══════════════════════════════════════════╣
  ║  Shortcuts                               ║
  ║  ────────                                ║
  ║  Ctrl+T       New tab                    ║
  ║  Ctrl+F4      Close tab                  ║
  ║  Ctrl+Tab     Next / prev tab            ║
  ║  Enter        Launch project             ║
  ║  F1           Cycle tool                 ║
  ║  Tab          Cycle model                ║
  ║  F2           Cycle effort               ║
  ║  F3           Cycle sort                 ║
  ║  F4           Toggle skip-perms          ║
  ║  F5           Create project             ║
  ║  F6           Open in Explorer           ║
  ║  F7           Manage directories         ║
  ║  F8           Label project              ║
  ║  F9           Theme picker               ║
  ║  F10          Quick launch               ║
  ║  F11          Font settings              ║
  ║  F12          About (toggle)             ║
  ║                                          ║
  ╠══════════════════════════════════════════╣
  ║  Tools: claude, gemini                   ║
  ║  Models: sonnet, opus, haiku, 1M ctx     ║
  ║  Themes: ${String(themeCount).padEnd(2)} dark themes${" ".repeat(19)}║
  ╚══════════════════════════════════════════╝`;
}

function AboutPage({ tabId, onRequestClose, isActive }: AboutPageProps) {
  const [version, setVersion] = useState("...");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onRequestClose(tabId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, tabId, onRequestClose]);

  return (
    <div className="about-page">
      <div className="about-terminal">
        <pre className="about-logo">{LOGO}</pre>
        <pre className="about-info">{buildAppInfo(version)}</pre>
        <div className="about-footer">
          Press <kbd>Esc</kbd> or <kbd>F12</kbd> to close
        </div>
      </div>
    </div>
  );
}

export default memo(AboutPage);
