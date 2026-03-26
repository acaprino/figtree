import type { SessionController } from "../hooks/useSessionController";

/** Props interface for TerminalView (the session rendering component). */
export interface SessionViewProps {
  tabId: string;
  modelIdx: number;
  effortIdx: number;
  permModeIdx: number;
  isActive: boolean;
  hideThinking?: boolean;
  controller: SessionController;
  onConfigChange?: (update: { modelIdx?: number; effortIdx?: number; permModeIdx?: number }) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
  /** Session panel state (passed from App) */
  sessionPanelOpen?: boolean;
  onCloseSessionPanel?: () => void;
  onResumeSession?: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
  onForkSession?: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
}
