import { memo, useState, useEffect, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { THEMES } from "../types";
import { Banner, Box, Sep } from "./GsdPrimitives";
import AsciiLogo from "./AsciiLogo";
import "./GsdLayout.css";
import "./AboutPage.css";

interface AboutPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

function buildAboutBox(version: string) {
  return `  A N V I L
  AI Code Session Launcher

  Version    ${version}
  Platform   Windows (Tauri 2)
  Frontend   React 19 + TypeScript
  Backend    Rust + Tauri 2
  Display    React Chat UI`;
}

function buildStatusBox() {
  const themeCount = THEMES.length;
  return `  Tools     ✓ claude
  Models    ✓ sonnet  ✓ opus  ✓ haiku  ✓ 1M context
  Themes    ${themeCount} dark themes available
  Effort    high / medium / low
  Sort      alpha / last used / most used`;
}

const SHORTCUTS_NAV = `  Ctrl+T        New tab
  Ctrl+F4       Close tab
  Ctrl+Tab      Next / prev tab
  Enter         Launch project`;

const SHORTCUTS_SETTINGS = `  Tab           Cycle model
  F2            Cycle effort
  F3            Cycle sort
  F4            Toggle skip-perms`;

const SHORTCUTS_ACTIONS = `  F5            Create project
  F6            Open in Explorer
  F7            Manage directories
  F8            Label project
  F9            Theme picker
  F10           Quick launch
  F11           Font settings
  F12           About (toggle)
  Ctrl+U        Token usage`;

function AboutPage({ tabId, onRequestClose, isActive }: AboutPageProps) {
  const [version, setVersion] = useState("...");
  const aboutBox = useMemo(() => buildAboutBox(version), [version]);
  const statusBox = useMemo(() => buildStatusBox(), []);

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
    <div className="static-page">
      <div className="static-page-inner">
        <AsciiLogo cols={55} />

        <Banner title="ABOUT" />
        <Box>{aboutBox}</Box>

        <Banner title="SHORTCUTS" />
        <pre className="gsd-text">{SHORTCUTS_NAV}</pre>
        <Sep />
        <pre className="gsd-text">{SHORTCUTS_SETTINGS}</pre>
        <Sep />
        <pre className="gsd-text">{SHORTCUTS_ACTIONS}</pre>

        <Banner title="STATUS" />
        <Box>{statusBox}</Box>

        <div className="gsd-footer">
          <Sep />
          <div className="gsd-footer-text">Press Esc or F12 to close</div>
          <Sep />
        </div>
      </div>
    </div>
  );
}

export default memo(AboutPage);
