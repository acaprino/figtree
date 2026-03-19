import { memo } from "react";
import type { AgentTask } from "../../types";
import { fmtTokens, fmtDuration } from "../../utils/format";

interface Props {
  tasks: AgentTask[];
}

const VALID_STATUSES = new Set<AgentTask["status"]>(["running", "completed", "failed", "stopped"]);

const STATUS_LABEL: Record<AgentTask["status"], string> = {
  running: "\u25B6",
  completed: "\u2714",
  failed: "\u2718",
  stopped: "\u25A0",
};

export default memo(function AgentTreePanel({ tasks }: Props) {
  if (tasks.length === 0) {
    return <div className="sidebar-empty"><span className="sidebar-empty-icon">{"\u2B21"}</span>No running agents</div>;
  }

  const running = tasks.filter(t => t.status === "running");
  const finished = tasks.filter(t => t.status !== "running");

  return (
    <div className="agent-tree-panel">
      {running.length > 0 && (
        <div className="agent-tree-section">
          <div className="agent-tree-section-label">Active ({running.length})</div>
          {running.map(task => (
            <AgentTaskRow key={task.taskId} task={task} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <div className="agent-tree-section">
          <div className="agent-tree-section-label">Done ({finished.length})</div>
          {finished.map(task => (
            <AgentTaskRow key={task.taskId} task={task} />
          ))}
        </div>
      )}
    </div>
  );
});

/** Extract a readable agent name from taskType (e.g. "general-purpose" -> "General Purpose") */
function formatAgentName(task: AgentTask): string {
  if (task.taskType) {
    return task.taskType
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  // Fallback: use first ~30 chars of description
  const desc = task.description || "Agent";
  return desc.length > 30 ? desc.slice(0, 30) + "\u2026" : desc;
}

const AgentTaskRow = memo(function AgentTaskRow({ task }: { task: AgentTask }) {
  const isRunning = task.status === "running";
  const safeStatus = VALID_STATUSES.has(task.status) ? task.status : "running";
  const name = formatAgentName(task);

  return (
    <div className={`agent-task agent-task--${safeStatus}`}>
      <div className="agent-task-header">
        <span className="agent-task-icon">{STATUS_LABEL[safeStatus]}</span>
        <span className="agent-task-name" title={task.description}>{name}</span>
        {isRunning && task.lastToolName && (
          <span className="agent-task-tool">{task.lastToolName}</span>
        )}
      </div>
      {task.description && task.taskType && (
        <div className="agent-task-desc">{task.description}</div>
      )}
      {task.summary && (
        <div className="agent-task-summary">{task.summary}</div>
      )}
      <div className="agent-task-stats">
        {task.toolUses > 0 && <span key="tools">{task.toolUses} tools</span>}
        {task.totalTokens > 0 && <span key="tok">{fmtTokens(task.totalTokens)} tok</span>}
        {task.durationMs > 0 && <span key="dur">{fmtDuration(task.durationMs)}</span>}
      </div>
    </div>
  );
});
