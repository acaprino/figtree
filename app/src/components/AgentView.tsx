import { memo } from "react";
import { useSessionController } from "../hooks/useSessionController";
import type { SessionControllerProps } from "../hooks/useSessionController";
import ChatView from "./ChatView";
import TerminalView from "./TerminalView";

interface AgentViewProps extends SessionControllerProps {
  viewStyle: "terminal" | "chat";
  hideThinking?: boolean;
}

/**
 * Wrapper that owns the session controller so toggling view_style
 * does NOT destroy the active agent session. The controller is
 * instantiated once and passed to whichever view is active.
 */
export default memo(function AgentView({
  viewStyle, hideThinking, ...controllerProps
}: AgentViewProps) {
  const controller = useSessionController(controllerProps);

  const viewProps = {
    tabId: controllerProps.tabId,
    modelIdx: controllerProps.modelIdx,
    effortIdx: controllerProps.effortIdx,
    isActive: controllerProps.isActive,
    hideThinking,
    controller,
  };

  if (viewStyle === "terminal") {
    return <TerminalView {...viewProps} />;
  }

  return <ChatView {...viewProps} />;
});
