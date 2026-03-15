import { invoke } from "@tauri-apps/api/core";
import { THEMES } from "./types";

export function applyTheme(themeIdx: number): void {
  const theme = THEMES[themeIdx] ?? THEMES[0];
  const c = theme.colors;
  const root = document.documentElement;

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

  const isRetro = !!theme.retro;
  root.classList.toggle("retro", isRetro);
  invoke("set_window_corner_preference", { retro: isRetro }).catch(() => {});
}