import { memo, useCallback } from "react";
import { useSessionController } from "../hooks/useSessionController";
import type { SessionControllerProps } from "../hooks/useSessionController";
import XTermView from "./XTermView";

type ConfigUpdate = { modelIdx?: number; effortIdx?: number; permModeIdx?: number };

interface AgentViewProps extends SessionControllerProps {
  hideThinking?: boolean;
  onProcessingChange?: (isProcessing: boolean) => void;
  onConfigChange?: (tabId: string, update: ConfigUpdate) => void;
  sessionPanelOpen?: boolean;
  onCloseSessionPanel?: () => void;
  onResumeSession?: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
  onForkSession?: (sessionId: string, cwd: string, inNewTab?: boolean) => void;
}

/**
 * Wrapper that owns the session controller so re-renders from parent
 * do NOT destroy the active agent session.
 */
export default memo(function AgentView({
  hideThinking, onProcessingChange, onConfigChange,
  sessionPanelOpen, onCloseSessionPanel, onResumeSession, onForkSession,
  ...controllerProps
}: AgentViewProps) {
  const controller = useSessionController(controllerProps);

  const handleConfigChange = useCallback((update: ConfigUpdate) => {
    onConfigChange?.(controllerProps.tabId, update);
  }, [onConfigChange, controllerProps.tabId]);

  return (
    <XTermView
      tabId={controllerProps.tabId}
      modelIdx={controllerProps.modelIdx}
      effortIdx={controllerProps.effortIdx}
      permModeIdx={controllerProps.permModeIdx}
      isActive={controllerProps.isActive}
      hideThinking={hideThinking}
      controller={controller}
      onConfigChange={handleConfigChange}
      onProcessingChange={onProcessingChange}
      sessionPanelOpen={sessionPanelOpen}
      onCloseSessionPanel={onCloseSessionPanel}
      onResumeSession={onResumeSession}
      onForkSession={onForkSession}
    />
  );
});
