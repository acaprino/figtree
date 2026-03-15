import type { PermissionSuggestion } from "../../types";

interface Props {
  tool: string;
  description: string;
  suggestions?: PermissionSuggestion[];
  resolved?: boolean;
  allowed?: boolean;
  onRespond: (allow: boolean, suggestions?: PermissionSuggestion[]) => void;
}

export default function PermissionCard({ tool, description, suggestions, resolved, allowed, onRespond }: Props) {
  if (resolved) {
    return (
      <div className={`perm-card resolved ${allowed ? "allowed" : "denied"}`}>
        <span className="perm-card-icon">{allowed ? "✓" : "✗"}</span>
        <span className="perm-card-label">{tool}: {description}</span>
      </div>
    );
  }

  return (
    <div className="perm-card pending">
      <div className="perm-card-question">
        Allow <strong>{tool}</strong>: {description}?
      </div>
      <div className="perm-card-actions">
        <button className="perm-btn perm-btn--yes" onClick={() => onRespond(true)}>Yes</button>
        {suggestions && suggestions.length > 0 && (
          <button className="perm-btn perm-btn--session" onClick={() => onRespond(true, suggestions)}>
            Yes, for session
          </button>
        )}
        <button className="perm-btn perm-btn--no" onClick={() => onRespond(false)}>No</button>
      </div>
    </div>
  );
}
