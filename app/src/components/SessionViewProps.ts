import type { SessionController } from "../hooks/useSessionController";

/** Shared props interface for ChatView and TerminalView. */
export interface SessionViewProps {
  tabId: string;
  modelIdx: number;
  effortIdx: number;
  isActive: boolean;
  hideThinking?: boolean;
  controller: SessionController;
}
