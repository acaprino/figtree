export interface SystemPrompt {
  id: string;
  name: string;
  description?: string;
  content: string;
}

export interface Tab {
  id: string;
  type: "new-tab" | "agent" | "about" | "usage" | "system-prompt" | "sessions" | "transcript";
  projectPath?: string;
  projectName?: string;

  modelIdx?: number;
  effortIdx?: number;
  permModeIdx?: number;
  autocompact?: boolean;
  temporary?: boolean;
  agentSessionId?: string;
  hasNewOutput?: boolean;
  exitCode?: number | null;
  tagline?: string;
  /** When set, Terminal will call resumeAgent() instead of spawnAgent(). Consumed on mount. */
  resumeSessionId?: string;
  /** When set, Terminal will call forkAgent() instead of spawnAgent(). Consumed on mount. */
  forkSessionId?: string;
  /** Session ID for transcript viewer tabs. */
  transcriptSessionId?: string;
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

  model_idx: number;
  effort_idx: number;
  sort_idx: number;
  theme_idx: number;
  font_family: string;
  font_size: number;
  chat_font_family?: string;
  chat_font_size?: number;
  perm_mode_idx: number;
  autocompact: boolean;
  active_prompt_ids: string[];
  security_gate: boolean;
  project_dirs: string[];
  single_project_dirs: string[];
  project_labels: Record<string, string>;
  vertical_tabs?: boolean;
  sidebar_width?: number;
  autocomplete_enabled?: boolean;
  session_panel_open?: boolean;
  view_style?: "terminal" | "chat";
  hide_thinking?: boolean;
  marketplace_global?: boolean;
  onboarding_seen?: boolean;
}

export interface UsageEntry {
  last_used: number;
  count: number;
}

export type UsageData = Record<string, UsageEntry>;


export const MODELS = [
  { display: "sonnet", id: "claude-sonnet-4-6" },
  { display: "opus", id: "claude-opus-4-6" },
  { display: "haiku", id: "claude-haiku-4-5" },
  { display: "sonnet [1M]", id: "claude-sonnet-4-6[1m]" },
  { display: "opus [1M]", id: "claude-opus-4-6[1m]" },
] as const;

export const EFFORTS = ["high", "medium", "low"] as const;
export const SORT_ORDERS = ["alpha", "last used", "most used"] as const;

/** Permission modes — cycled via Tab on the project picker. */
export const PERM_MODES = [
  { display: "plan", sdk: "plan" },
  { display: "accept edits", sdk: "acceptEdits" },
  { display: "skip all", sdk: "bypassPermissions" },
] as const;

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
  // user message styling (optional, theme-configurable)
  userMsgBg?: string;
  userMsgBorder?: string;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  retro?: boolean;
  /** Terminal / monospace font */
  termFont?: string;
  termFontSize?: number;
  /** UI / chat font */
  uiFont?: string;
  uiFontSize?: number;
}

// Themes are loaded at runtime from the filesystem via load_themes command

/** Shared tab label logic — used by TabBar and TabSidebar. */
export function getTabLabel(tab: Tab): string {
  const baseName =
    tab.type === "agent"
      ? (tab.projectName ?? "Terminal")
      : tab.type === "about"
        ? "About"
        : tab.type === "usage"
          ? "Usage"
          : tab.type === "system-prompt"
            ? "System Prompts"
            : tab.type === "sessions"
              ? "Sessions"
              : tab.type === "transcript"
                ? "Transcript"
                : "New Tab";
  return tab.tagline ? `${baseName} \u2014 ${tab.tagline}` : baseName;
}

// ── Agent SDK types ─────────────────────────────────────────────────

/** Permission update suggestion from Agent SDK (mirrors PermissionUpdate type). */
export interface PermissionSuggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  destination?: string;
  mode?: string;
  directories?: string[];
}

/** Slash command from Agent SDK (skill invoked via /command syntax). */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** Agent info from Agent SDK (subagent invoked via @agent syntax). */
export interface AgentInfoSDK {
  name: string;
  description: string;
  model?: string;
}

/** A single question in an AskUserQuestion tool call */
export interface AskQuestionItem {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

export type AgentEvent =
  | { type: "assistant"; text: string; streaming: boolean }
  | { type: "toolUse"; tool: string; input: unknown }
  | { type: "toolResult"; tool: string; output: string; success: boolean }
  | { type: "permission"; tool: string; description: string; toolUseId: string; suggestions?: PermissionSuggestion[] }
  | { type: "ask"; questions: AskQuestionItem[] }
  | { type: "inputRequired" }
  | { type: "thinking"; text: string }
  | { type: "status"; status: string; model: string; sessionId: string }
  | { type: "progress"; message: string }
  | { type: "result"; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; durationMs: number; isError: boolean; sessionId: string; contextWindow: number }
  | { type: "todo"; todos: TodoItem[] }
  | { type: "autocomplete"; suggestions: string[]; seq: number }
  | { type: "rateLimit"; utilization: number }
  | { type: "commandsInit"; commands: SlashCommand[]; agents: AgentInfoSDK[] }
  | { type: "taskStarted"; taskId: string; description: string; taskType: string }
  | { type: "taskProgress"; taskId: string; description: string; totalTokens: number; toolUses: number; durationMs: number; lastToolName: string; summary: string }
  | { type: "taskNotification"; taskId: string; status: "completed" | "failed" | "stopped"; summary: string; totalTokens: number; toolUses: number; durationMs: number }
  | { type: "interrupted" }
  | { type: "error"; code: string; message: string }
  | { type: "exit"; code: number };

// ── Chat UI types ─────────────────────────────────────────────────

/** A single message in the chat view. Built from accumulated AgentEvents. */
export type ChatMessage =
  | { id: string; role: "user"; text: string; timestamp: number }
  | { id: string; role: "assistant"; text: string; streaming: boolean; timestamp: number }
  | { id: string; role: "tool"; tool: string; input: unknown; output?: string; success?: boolean; timestamp: number }
  | { id: string; role: "permission"; tool: string; description: string; toolUseId: string; suggestions?: PermissionSuggestion[]; resolved?: boolean; allowed?: boolean; timestamp: number }
  | { id: string; role: "ask"; questions: AskQuestionItem[]; resolved?: boolean; answers?: Record<string, string>; timestamp: number }
  | { id: string; role: "thinking"; text: string; ended?: boolean; timestamp: number }
  | { id: string; role: "result"; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; durationMs: number; isError: boolean; sessionId: string; contextWindow: number; timestamp: number }
  | { id: string; role: "error"; code: string; message: string; timestamp: number }
  | { id: string; role: "status"; status: string; model: string; timestamp: number }
  | { id: string; role: "todo"; todos: TodoItem[]; timestamp: number }
  | { id: string; role: "history-separator"; timestamp: number };

export interface SessionInfo {
  id: string;
  summary: string;
  lastModified: number;
  cwd: string;
  firstPrompt: string;
  gitBranch: string;
  createdAt: number;
  customTitle: string;
  fileSize: number;
}

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  category?: string;
}

export interface AgentTask {
  taskId: string;
  description: string;
  taskType: string;
  status: "running" | "completed" | "failed" | "stopped";
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName: string;
  summary: string;
}

export interface Attachment {
  id: string;
  path: string;
  name: string;
  type: "file" | "image";
  thumbnail?: string;
}
