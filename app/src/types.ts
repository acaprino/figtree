export interface Tab {
  id: string;
  type: "new-tab" | "terminal" | "about";
  projectPath?: string;
  projectName?: string;
  toolIdx?: number;
  modelIdx?: number;
  effortIdx?: number;
  skipPerms?: boolean;
  sessionId?: string;
  hasNewOutput?: boolean;
  exitCode?: number | null;
}

export interface ProjectInfo {
  path: string;
  name: string;
  label: string | null;
  branch: string | null;
  isDirty: boolean;
  hasClaudeMd: boolean;
}

export interface Settings {
  version?: number;
  tool_idx: number;
  model_idx: number;
  effort_idx: number;
  sort_idx: number;
  theme_idx: number;
  font_family: string;
  font_size: number;
  skip_perms: boolean;
  project_dirs: string[];
  single_project_dirs: string[];
  project_labels: Record<string, string>;
}

export interface UsageEntry {
  last_used: number;
  count: number;
}

export type UsageData = Record<string, UsageEntry>;

export const TOOLS = ["claude", "gemini"] as const;

export const MODELS = [
  { display: "sonnet", id: "claude-sonnet-4-6" },
  { display: "opus", id: "claude-opus-4-6" },
  { display: "haiku", id: "claude-haiku-4-5" },
  { display: "sonnet [1M]", id: "claude-sonnet-4-6[1m]" },
  { display: "opus [1M]", id: "claude-opus-4-6[1m]" },
] as const;

export const EFFORTS = ["high", "medium", "low"] as const;
export const SORT_ORDERS = ["alpha", "last used", "most used"] as const;

export interface ThemeColors {
  bg: string;
  surface: string;
  mantle: string;
  crust: string;
  text: string;
  textDim: string;
  overlay0: string;
  overlay1: string;
  accent: string;
  red: string;
  green: string;
  yellow: string;
  // xterm-specific
  cursor: string;
  selection: string;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  retro?: boolean;
}

export const THEMES: Theme[] = [
  {
    name: "Catppuccin Mocha",
    colors: {
      bg: "#1e1e2e", surface: "#313244", mantle: "#181825", crust: "#11111b",
      text: "#cdd6f4", textDim: "#838799", overlay0: "#73768a", overlay1: "#7b7f94",
      accent: "#89b4fa", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      cursor: "#f5e0dc", selection: "#45475a",
    },
  },
  {
    name: "Dracula",
    colors: {
      bg: "#282a36", surface: "#44475a", mantle: "#21222c", crust: "#191a21",
      text: "#f8f8f2", textDim: "#8490b8", overlay0: "#7080ad", overlay1: "#7a88b8",
      accent: "#bd93f9", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      cursor: "#f8f8f2", selection: "#44475a",
    },
  },
  {
    name: "One Dark",
    colors: {
      bg: "#282c34", surface: "#3e4451", mantle: "#21252b", crust: "#1b1d23",
      text: "#abb2bf", textDim: "#8e949f", overlay0: "#6b7280", overlay1: "#7d8491",
      accent: "#61afef", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      cursor: "#528bff", selection: "#3e4451",
    },
  },
  {
    name: "Nord",
    colors: {
      bg: "#2e3440", surface: "#404859", mantle: "#272c36", crust: "#20242d",
      text: "#d8dee9", textDim: "#939db1", overlay0: "#6a7590", overlay1: "#7b869e",
      accent: "#88c0d0", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      cursor: "#d8dee9", selection: "#434c5e",
    },
  },
  {
    name: "Solarized Dark",
    colors: {
      bg: "#002b36", surface: "#094352", mantle: "#001f27", crust: "#00161e",
      text: "#839496", textDim: "#78929a", overlay0: "#5f7980", overlay1: "#6b858d",
      accent: "#268bd2", red: "#dc322f", green: "#859900", yellow: "#b58900",
      cursor: "#839496", selection: "#073642",
    },
  },
  {
    name: "Gruvbox Dark",
    colors: {
      bg: "#282828", surface: "#403c3a", mantle: "#1d2021", crust: "#141617",
      text: "#ebdbb2", textDim: "#a89984", overlay0: "#857867", overlay1: "#928374",
      accent: "#83a598", red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f",
      cursor: "#ebdbb2", selection: "#3c3836",
    },
  },
  {
    name: "Tokyo Night",
    colors: {
      bg: "#1a1b26", surface: "#2d3248", mantle: "#16161e", crust: "#101014",
      text: "#c0caf5", textDim: "#7982ab", overlay0: "#606a95", overlay1: "#6e78a4",
      accent: "#7aa2f7", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      cursor: "#c0caf5", selection: "#283457",
    },
  },
  {
    name: "Monokai",
    colors: {
      bg: "#272822", surface: "#3e3d32", mantle: "#1e1f1c", crust: "#161713",
      text: "#f8f8f2", textDim: "#938e78", overlay0: "#7e7963", overlay1: "#89846d",
      accent: "#66d9ef", red: "#f92672", green: "#a6e22e", yellow: "#e6db74",
      cursor: "#f8f8f0", selection: "#49483e",
    },
  },
  {
    name: "Anvil Forge [retro]",
    retro: true,
    colors: {
      bg: "#2a2420", surface: "#3d342c", mantle: "#221d18", crust: "#1a1510",
      text: "#e8d5b5", textDim: "#b8a890", overlay0: "#7a6e60", overlay1: "#8a7e6e",
      accent: "#e8943a", red: "#f06845", green: "#9cc068", yellow: "#e8c43a",
      cursor: "#f0a848", selection: "#4a3e32",
    },
  },
  {
    name: "Guybrush [retro]",
    retro: true,
    colors: {
      bg: "#1c2230", surface: "#2c3548", mantle: "#151a26", crust: "#10141e",
      text: "#dcd0b8", textDim: "#a09888", overlay0: "#657080", overlay1: "#738090",
      accent: "#4ac8b0", red: "#e86050", green: "#6abe60", yellow: "#e8c850",
      cursor: "#e0d0a8", selection: "#3a4460",
    },
  },
];
