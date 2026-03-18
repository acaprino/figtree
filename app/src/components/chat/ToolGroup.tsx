import { memo, useState, useCallback } from "react";
import ToolCard from "./ToolCard";
import type { ChatMessage } from "../../types";

type ToolMessage = Extract<ChatMessage, { role: "tool" }>;

interface Props {
  tools: ToolMessage[];
}

export default memo(function ToolGroup({ tools }: Props) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(v => !v), []);

  // Count occurrences of each tool name
  const counts = new Map<string, number>();
  let allDone = true;
  let anyFailed = false;
  for (const t of tools) {
    counts.set(t.tool, (counts.get(t.tool) || 0) + 1);
    if (t.success === undefined) allDone = false;
    if (t.success === false) anyFailed = true;
  }

  const statusChar = !allDone ? "\u25CB" : anyFailed ? "\u2717" : "\u2713";
  const statusClass = !allDone ? "pending" : anyFailed ? "fail" : "ok";

  if (expanded) {
    return (
      <div className="tool-group">
        <button className="tool-group-header" onClick={toggle}>
          <span className="tool-card-icon">$</span>
          {Array.from(counts).map(([name, count]) => (
            <span key={name} className="tool-group-badge">
              {name} <span className="tool-group-count">&times;{count}</span>
            </span>
          ))}
          <span className="tool-group-spacer" />
          <span className={`tool-card-status ${statusClass}`}>{statusChar}</span>
          <span className="tool-card-toggle">{"\u25BE"}</span>
        </button>
        {tools.map(t => (
          <div key={t.id} className="chat-msg--tool">
            <ToolCard tool={t.tool} input={t.input} output={t.output} success={t.success} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="tool-group">
      <button className="tool-group-header" onClick={toggle}>
        <span className="tool-card-icon">$</span>
        {Array.from(counts).map(([name, count]) => (
          <span key={name} className="tool-group-badge">
            {name} <span className="tool-group-count">&times;{count}</span>
          </span>
        ))}
        <span className="tool-group-spacer" />
        <span className={`tool-card-status ${statusClass}`}>{statusChar}</span>
        <span className="tool-card-toggle">{"\u25B8"}</span>
      </button>
    </div>
  );
});
