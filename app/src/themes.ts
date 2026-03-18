import { invoke } from "@tauri-apps/api/core";
import { THEMES } from "./types";

export function applyTheme(themeIdx: number): void {
  const theme = THEMES[themeIdx] ?? THEMES[0];
  const c = theme.colors;
  const root = document.documentElement;

  // Colors
  root.style.setProperty("--bg", c.bg);
  root.style.setProperty("--surface", c.surface);
  root.style.setProperty("--mantle", c.mantle);
  root.style.setProperty("--crust", c.crust);
  root.style.setProperty("--text", c.text);
  root.style.setProperty("--text-dim", c.textDim);
  root.style.setProperty("--overlay0", c.overlay0);
  root.style.setProperty("--overlay1", c.overlay1);
  root.style.setProperty("--accent", c.accent);
  root.style.setProperty("--red", c.red);
  root.style.setProperty("--green", c.green);
  root.style.setProperty("--yellow", c.yellow);

  // Terminal font
  if (theme.termFont) {
    root.style.setProperty("--font-mono", `"${theme.termFont}", "Consolas", monospace`);
  } else {
    root.style.removeProperty("--font-mono");
  }

  // Typographic scale — derived from termFontSize (default 14)
  const base = theme.termFontSize || 14;
  root.style.setProperty("--text-2xs", `${base - 3}px`);
  root.style.setProperty("--text-xs", `${base - 2}px`);
  root.style.setProperty("--text-sm", `${base - 1}px`);
  root.style.setProperty("--text-base", `${base}px`);
  root.style.setProperty("--text-md", `${base + 1}px`);
  root.style.setProperty("--text-lg", `${base + 2}px`);
  root.style.setProperty("--text-xl", `${base + 4}px`);

  // UI / chat font
  if (theme.uiFont) {
    root.style.setProperty("--chat-font-family", `"${theme.uiFont}", "Segoe UI", system-ui, sans-serif`);
  } else {
    root.style.removeProperty("--chat-font-family");
  }
  if (theme.uiFontSize) {
    root.style.setProperty("--chat-font-size", `${theme.uiFontSize}px`);
  } else {
    root.style.removeProperty("--chat-font-size");
  }

  // Detect light vs dark from bg luminance
  const isLight = isLightColor(c.bg);
  root.style.colorScheme = isLight ? "light" : "dark";

  const isRetro = !!theme.retro;
  root.classList.toggle("retro", isRetro);
  invoke("set_window_corner_preference", { retro: isRetro }).catch(() => {});
}

function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}
