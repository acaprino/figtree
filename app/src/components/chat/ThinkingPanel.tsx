import { memo, useMemo, useState } from "react";
import { Collapsible } from "radix-ui";
import type { ChatMessage } from "../../types";

interface Props {
  messages: ChatMessage[];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export default memo(function ThinkingPanel({ messages }: Props) {
  const thinkingMessages = useMemo(() => messages.filter((m) => m.role === "thinking"), [messages]);

  if (thinkingMessages.length === 0) {
    return <div className="sidebar-empty"><span className="sidebar-empty-icon">{"\u2726"}</span>No thinking blocks yet</div>;
  }

  return (
    <div className="thinking-history-panel">
      {thinkingMessages.map((msg, i) => (
        <ThinkingEntry key={msg.id} msg={msg} defaultExpanded={i === thinkingMessages.length - 1} />
      ))}
    </div>
  );
});

const ThinkingEntry = memo(function ThinkingEntry({ msg, defaultExpanded }: { msg: ChatMessage; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (msg.role !== "thinking") return null;

  const lineCount = msg.text.split("\n").length;
  const preview = msg.text.slice(0, 80).replace(/\n/g, " ");

  return (
    <Collapsible.Root className="thinking-entry" open={expanded} onOpenChange={setExpanded}>
      <Collapsible.Trigger className="thinking-entry-header">
        <span className="thinking-entry-time">{formatTime(msg.timestamp)}</span>
        <span className="thinking-entry-preview">
          {expanded ? `${lineCount} lines` : (preview.length < msg.text.length ? preview + "..." : preview)}
        </span>
        <span className="thinking-entry-toggle">{expanded ? "\u25BE" : "\u25B8"}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <pre className="thinking-entry-body">{msg.text}</pre>
      </Collapsible.Content>
    </Collapsible.Root>
  );
});
