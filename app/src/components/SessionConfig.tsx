import { memo, useCallback, useRef, useEffect } from "react";
import { Settings, MODELS, EFFORTS, PERM_MODES } from "../types";
import SegmentedControl from "./SegmentedControl";
import "./SessionConfig.css";

interface SessionConfigProps {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => void;
}

const MODEL_OPTIONS = MODELS.map((m) => ({ label: m.display, value: m.display }));
const EFFORT_OPTIONS = EFFORTS.map((e) => ({ label: e, value: e }));
const PERMS_OPTIONS = PERM_MODES.map((m) => ({ label: m.display, value: m.display }));

export default memo(function SessionConfig({ settings, onUpdate }: SessionConfigProps) {
  const currentModel = MODELS[settings.model_idx]?.display ?? MODELS[0].display;
  const currentEffort = EFFORTS[settings.effort_idx] ?? EFFORTS[0];
  const permsValue = PERM_MODES[settings.perm_mode_idx]?.display ?? PERM_MODES[0].display;

  const handleModelChange = useCallback((idx: number) => {
    onUpdate({ model_idx: idx });
  }, [onUpdate]);

  const handleEffortChange = useCallback((idx: number) => {
    onUpdate({ effort_idx: idx });
  }, [onUpdate]);

  const handlePermsChange = useCallback((idx: number) => {
    onUpdate({ perm_mode_idx: idx });
  }, [onUpdate]);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const handleCompactToggle = useCallback(() => {
    onUpdate({ autocompact: !settingsRef.current.autocompact });
  }, [onUpdate]);

  return (
    <div className="session-config">
      <SegmentedControl
        options={MODEL_OPTIONS}
        value={currentModel}
        onChange={handleModelChange}
        title="Model (F4)"
      />
      <SegmentedControl
        options={EFFORT_OPTIONS}
        value={currentEffort}
        onChange={handleEffortChange}
        title="Effort (F2)"
      />
      <SegmentedControl
        options={PERMS_OPTIONS}
        value={permsValue}
        onChange={handlePermsChange}
        variant="perms"
        title="Mode (Tab)"
      />
      <button
        className={`session-config__toggle ${settings.autocompact ? "active" : ""}`}
        onClick={handleCompactToggle}
        title="Toggle autocompact"
      >
        {settings.autocompact ? "compact: on" : "compact: off"}
      </button>
    </div>
  );
});
