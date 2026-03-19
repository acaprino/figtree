import type { SessionController } from "../hooks/useSessionController";

/** Shared props interface for ChatView and TerminalView. */
export interface SessionViewProps {
  tabId: string;
  modelIdx: number;
  effortIdx: number;
  permModeIdx: number;
  isActive: boolean;
  hideThinking?: boolean;
  controller: SessionController;
  onConfigChange?: (update: { modelIdx?: number; effortIdx?: number; permModeIdx?: number }) => void;
}
