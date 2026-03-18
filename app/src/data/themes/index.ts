import type { Theme } from "../../types";

import anvil from "./gandalf.json";
import anvilForge from "./daisyui-retro.json";
import dracula from "./dracula.json";
import tokyoNight from "./tokyo-night.json";
import nord from "./nord.json";
import kanagawa from "./kanagawa.json";
import synthwave from "./synthwave.json";
import matrix from "./matrix.json";
import cyberpunk2077 from "./cyberpunk-2077.json";
import lofi from "./lofi.json";
import paper from "./light-paper.json";
import arctic from "./light-arctic.json";
import sakura from "./light-sakura.json";
import solarizedLight from "./light-solarized.json";

export const THEMES: Theme[] = [
  // Dark
  anvil,
  anvilForge,
  dracula,
  tokyoNight,
  nord,
  kanagawa,
  synthwave,
  matrix,
  cyberpunk2077,
  lofi,
  // Light
  paper,
  arctic,
  sakura,
  solarizedLight,
] as Theme[];
