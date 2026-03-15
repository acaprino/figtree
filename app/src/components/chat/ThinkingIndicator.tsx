import { memo } from "react";

export default memo(function ThinkingIndicator() {
  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </div>
  );
});
