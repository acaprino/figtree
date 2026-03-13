import { memo, useState, useEffect, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { THEMES } from "../types";
import "./AboutPage.css";

interface AboutPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

// ASCII density ramp: dark → light
const DENSITY = "@%#*+=-:. ";

interface AsciiCell {
  char: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

function imageToAscii(img: HTMLImageElement, cols: number): AsciiCell[][] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  if (cols <= 0 || img.naturalWidth <= 0 || img.naturalHeight <= 0) return [];

  const aspect = 0.5; // monospace chars are ~2x tall as wide
  const cellW = img.naturalWidth / cols;
  const cellH = cellW / aspect;
  const rows = Math.floor(img.naturalHeight / cellH);

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grid: AsciiCell[][] = [];

  for (let row = 0; row < rows; row++) {
    const line: AsciiCell[] = [];
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(col * cellW);
      const y0 = Math.floor(row * cellH);
      const x1 = Math.min(Math.floor((col + 1) * cellW), canvas.width);
      const y1 = Math.min(Math.floor((row + 1) * cellH), canvas.height);

      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * canvas.width + x) * 4;
          rSum += pixels.data[idx];
          gSum += pixels.data[idx + 1];
          bSum += pixels.data[idx + 2];
          aSum += pixels.data[idx + 3];
          count++;
        }
      }

      if (count === 0) {
        line.push({ char: " ", r: 0, g: 0, b: 0, a: 0 });
        continue;
      }

      const r = Math.round(rSum / count);
      const g = Math.round(gSum / count);
      const b = Math.round(bSum / count);
      const a = Math.round(aSum / count);

      // Pick character based on brightness
      const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
      const charIdx = Math.floor((brightness / 255) * (DENSITY.length - 1));
      const char = a < 30 ? " " : DENSITY[charIdx];

      line.push({ char, r, g, b, a });
    }
    grid.push(line);
  }
  return grid;
}

const AsciiLogo = memo(function AsciiLogo({ cols = 60 }: { cols?: number }) {
  const [grid, setGrid] = useState<AsciiCell[][] | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setGrid(imageToAscii(img, cols));
    img.onerror = () => setGrid([]);
    img.src = "/icon.png";
  }, [cols]);

  if (!grid) return <div className="about-logo-wrap"><pre className="about-logo">Loading...</pre></div>;

  return (
    <div className="about-logo-wrap">
      <pre className="about-logo" aria-label="Anvil logo">
        {grid.map((row, ri) => (
          <span key={ri}>
            {row.map((cell, ci) => {
              if (cell.char === " " || cell.a < 30) return cell.char;
              return (
                <span key={ci} style={{ color: `rgb(${cell.r},${cell.g},${cell.b})` }}>
                  {cell.char}
                </span>
              );
            })}
            {ri < grid.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
    </div>
  );
});

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
  AI Code Session Launcher

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
