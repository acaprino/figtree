import { memo, useState, useEffect, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { THEMES } from "../types";
import "./AboutPage.css";

interface AboutPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

const LOGO = `\
                          @@@@@@
                         @@#**#@@
                        @@****#@@
                      @@@*****#@@
                     @@#******#@@@@@@@@@@@@@@@@@@@@@@@@@@@
                    @@#*******#@*=================%@-----#@@
                    @@#*%*****#@+=================%@------@@
                    @@##@#****#@+=================%@-----%@@
                    @@##@#****#@@@@@@@@@@@@@@@@@@@@@@@@@@@
                    @@##@#****#@@
                    @@##@#****#@@
               @@@@@@@#*******#@@@@@@@
                  @@ @@@@@@@@@@@ @@
                @@@               @@@
             @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
             @@++++++++++++++++++++++++++++++@@
      @@@@@@@@@++@@@@@@@@@@@@@@@@@@@@@@@@@@++@@
     @@******@@++@*++++++++++++++++++++++++++@@#####%@@
     @@*+++++@@++@*++++++++++++++++++++++++++@@+++++*@@
     @@*+++++@@++@*++++++++++++++++++++++++++@@+++++*@@
     @@*+++++@@++@*++++++++++++++++++++++++++@@+++++*@@
     @@@**+++@@++@*++++++++++++++++++++++++++@@++++*#@@
       @@@@@%@@++@*++++++++++++++++++++++++++@@*@@@@@
            @@@++@+++++++++++++++++++++++++++@@@@
             @@++++++++++++++++++++++++++++++@@
             @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                   @@++++++++++++++++++@@
                   @@@@@@@@@@@@@@@@@@@@@@
                   @@##################@@
                   @@##################@@
                   @@##################@@
             @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
             @@+++++++++++++++++++++++++++++*@@
             @@+++++++++++++++++++++++++++++*@@
             @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@`;

function Banner({ title }: { title: string }) {
  return (
    <div className="gsd-banner">
      <div className="gsd-banner-bar" />
      <div className="gsd-banner-title">ANVIL ► {title}</div>
      <div className="gsd-banner-bar" />
    </div>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <div className="gsd-box"><pre>{children}</pre></div>;
}

function Sep() {
  return <div className="gsd-sep" />;
}

function buildAboutBox(version: string) {
  return `  A N V I L
  Claude Code Session Launcher

  Version    ${version}
  Platform   Windows (Tauri 2)
  Frontend   React 19 + TypeScript
  Backend    Rust + Tauri 2
  Terminal   xterm.js + WebGL`;
}

function buildStatusBox() {
  const themeCount = THEMES.length;
  return `  Tools     ✓ claude  ✓ gemini
  Models    ✓ sonnet  ✓ opus  ✓ haiku  ✓ 1M context
  Themes    ${themeCount} dark themes available
  Effort    high / medium / low
  Sort      alpha / last used / most used`;
}

const SHORTCUTS_NAV = `  Ctrl+T        New tab
  Ctrl+F4       Close tab
  Ctrl+Tab      Next / prev tab
  Enter         Launch project`;

const SHORTCUTS_SETTINGS = `  F1            Cycle tool
  Tab           Cycle model
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
  F12           About (toggle)`;

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
    <div className="about-page">
      <div className="about-terminal">
        <pre className="about-logo">{LOGO}</pre>

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
