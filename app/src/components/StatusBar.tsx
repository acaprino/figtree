import { memo } from "react";
import { Settings, TOOLS, MODELS, EFFORTS, SORT_ORDERS, THEMES } from "../types";
import "./StatusBar.css";

export type StatusBarAction = "create-project" | "manage-dirs" | "label-project" | "quick-launch" | "theme-picker" | "font-settings";

interface StatusBarProps {
  settings: Settings;
  filter: string;
  onUpdate: (updates: Partial<Settings>) => void;
  onAction?: (action: StatusBarAction) => void;
}

export default memo(function StatusBar({ settings, filter, onUpdate, onAction }: StatusBarProps) {
  const tool = TOOLS[settings.tool_idx] ?? TOOLS[0];
  const isClaude = settings.tool_idx === 0;
  const model = MODELS[settings.model_idx]?.display ?? MODELS[0].display;
  const effort = EFFORTS[settings.effort_idx] ?? EFFORTS[0];
  const sort = SORT_ORDERS[settings.sort_idx] ?? SORT_ORDERS[0];
  const theme = THEMES[settings.theme_idx]?.name ?? THEMES[0].name;

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <div className="status-left">
        {filter && <span className="status-filter">Filter: {filter}</span>}
        <button
          className="status-btn"
          onClick={() => onAction?.("create-project")}
          title="Create project (F5)"
        >
          + New
        </button>
        <button
          className="status-btn"
          onClick={() => onAction?.("manage-dirs")}
          title="Manage directories (F7)"
        >
          Dirs
        </button>
        <button
          className="status-btn"
          onClick={() => onAction?.("label-project")}
          title="Label project (F8)"
        >
          Label
        </button>
        <button
          className="status-btn"
          onClick={() => onAction?.("quick-launch")}
          title="Quick launch (F10)"
        >
          Quick
        </button>
      </div>
      <div className="status-right">
        <button
          className="status-btn"
          onClick={() => onUpdate({ tool_idx: (settings.tool_idx + 1) % TOOLS.length })}
          title="Click or F1 to cycle tool"
        >
          Tool: <strong>{tool}</strong>
        </button>
        {isClaude && (
          <button
            className="status-btn"
            onClick={() => onUpdate({ model_idx: (settings.model_idx + 1) % MODELS.length })}
            title="Click or Tab to cycle model"
          >
            Model: <strong>{model}</strong>
          </button>
        )}
        {isClaude && (
          <button
            className="status-btn"
            onClick={() => onUpdate({ effort_idx: (settings.effort_idx + 1) % EFFORTS.length })}
            title="Click or F2 to cycle effort"
          >
            Effort: <strong>{effort}</strong>
          </button>
        )}
        <button
          className="status-btn"
          onClick={() => onUpdate({ sort_idx: (settings.sort_idx + 1) % SORT_ORDERS.length })}
          title="Click or F3 to cycle sort"
        >
          Sort: <strong>{sort}</strong>
        </button>
        {isClaude && (
          <button
            className={`status-btn perms ${settings.skip_perms ? "on" : "off"}`}
            onClick={() => onUpdate({ skip_perms: !settings.skip_perms })}
            title="Click or F4 to toggle permissions"
          >
            Perms: <strong>{settings.skip_perms ? "SKIP" : "safe"}</strong>
          </button>
        )}
        <button
          className={`status-btn perms ${settings.security_gate ? "on" : "off"}`}
          onClick={() => onUpdate({ security_gate: !settings.security_gate })}
          title="Toggle security gate (blocks hardcoded secrets)"
        >
          Guard: <strong>{settings.security_gate ? "ON" : "off"}</strong>
        </button>
        <button
          className="status-btn"
          onClick={() => onAction?.("theme-picker")}
          title="Select theme (F9)"
        >
          Theme: <strong>{theme}</strong>
        </button>
        <button
          className="status-btn"
          onClick={() => onAction?.("font-settings")}
          title="Font settings (F11)"
        >
          Font
        </button>
      </div>
    </div>
  );
});
