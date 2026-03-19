import { memo, useMemo } from "react";
import type { ChatMessage } from "../../types";

interface Props {
  messages: ChatMessage[];
  onScrollToMessage: (msgId: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default memo(function BookmarkPanel({ messages, onScrollToMessage }: Props) {
  const userMessages = useMemo(() => messages.filter((m) => m.role === "user"), [messages]);

  if (userMessages.length === 0) {
    return <div className="sidebar-empty"><span className="sidebar-empty-icon">{"\u25B8"}</span>No messages yet</div>;
  }

  return (
    <div className="bookmark-panel">
      <div className="bookmark-panel-header">Messages ({userMessages.length})</div>
      {userMessages.map((msg) => (
        <button
          key={msg.id}
          className="bookmark-item"
          onClick={() => onScrollToMessage(msg.id)}
          title={msg.text}
        >
          <span className="bookmark-arrow">{"\u25B8"}</span>
          <span className="bookmark-text">
            {msg.text}
          </span>
          <span className="bookmark-time">{formatTime(msg.timestamp)}</span>
        </button>
      ))}
    </div>
  );
});
