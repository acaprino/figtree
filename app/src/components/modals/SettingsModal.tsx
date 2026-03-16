import { memo, useState, useEffect, useRef, useCallback } from "react";
import { Settings, THEMES, SORT_ORDERS } from "../../types";
import SegmentedControl from "../SegmentedControl";
import Modal from "../Modal";
import "./SettingsModal.css";

type DirMode = "container" | "single";
type DirEntry = { path: string; mode: DirMode };

const FONT_OPTIONS = [
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Courier New",
  "Lucida Console",
];

const CHAT_FONT_OPTIONS = [
  "Segoe UI",
  "Inter",
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Lucida Console",
];

const SORT_OPTIONS = SORT_ORDERS.map((s) => ({ label: s, value: s }));
const TAB_LAYOUT_OPTIONS = [
  { label: "Horizontal", value: "horizontal" },
  { label: "Vertical", value: "vertical" },
];
const INPUT_STYLE_OPTIONS = [
  { label: "Chat", value: "chat" },
  { label: "Terminal", value: "terminal" },
];

interface SettingsModalProps {
  settings: Settings;
  onClose: () => void;
  onUpdate: (updates: Partial<Settings>) => void;
}

export default memo(function SettingsModal({ settings, onClose, onUpdate }: SettingsModalProps) {
  const handleSortChange = useCallback((idx: number) => {
    onUpdate({ sort_idx: idx });
  }, [onUpdate]);
  const handleTabLayoutChange = useCallback((idx: number) => {
    onUpdate({ vertical_tabs: idx === 1 });
  }, [onUpdate]);
  const handleInputStyleChange = useCallback((idx: number) => {
    onUpdate({ input_style: idx === 0 ? "chat" : "terminal" });
  }, [onUpdate]);
  // Font state (local until explicit conceptual grouping, but we apply live)
  const [fontFamily, setFontFamily] = useState(settings.font_family || "Cascadia Code");
  const [fontSize, setFontSize] = useState(settings.font_size || 14);
  const [chatFontFamily, setChatFontFamily] = useState(settings.chat_font_family || "Segoe UI");
  const [chatFontSize, setChatFontSize] = useState(settings.chat_font_size || 14);

  // Directory state (needs explicit save)
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([
    ...settings.project_dirs.map((p) => ({ path: p, mode: "container" as DirMode })),
    ...settings.single_project_dirs.map((p) => ({ path: p, mode: "single" as DirMode })),
  ]);
  const [newDirPath, setNewDirPath] = useState("");
  const [newDirMode, setNewDirMode] = useState<DirMode>("container");
  const [dirsDirty, setDirsDirty] = useState(false);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // Apply font changes live — skip mount (initial values match settings)
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    onUpdateRef.current({ font_family: fontFamily, font_size: fontSize, chat_font_family: chatFontFamily, chat_font_size: chatFontSize });
  }, [fontFamily, fontSize, chatFontFamily, chatFontSize]);

  const addDir = () => {
    const trimmed = newDirPath.trim();
    if (!trimmed || dirEntries.some((e) => e.path === trimmed)) return;
    if (trimmed.startsWith("\\\\")) return;
    setDirEntries([...dirEntries, { path: trimmed, mode: newDirMode }]);
    setNewDirPath("");
    setDirsDirty(true);
  };

  const removeDir = (idx: number) => {
    if (dirEntries.length <= 1) return;
    setDirEntries(dirEntries.filter((_, i) => i !== idx));
    setDirsDirty(true);
  };

  const toggleDirMode = (idx: number) => {
    setDirEntries(dirEntries.map((e, i) =>
      i === idx ? { ...e, mode: e.mode === "container" ? "single" : "container" } : e
    ));
    setDirsDirty(true);
  };

  const saveDirs = () => {
    if (dirEntries.length === 0) return;
    onUpdate({
      project_dirs: dirEntries.filter((e) => e.mode === "container").map((e) => e.path),
      single_project_dirs: dirEntries.filter((e) => e.mode === "single").map((e) => e.path),
    });
    setDirsDirty(false);
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="settings-content">
        {/* Appearance */}
        <div className="settings-section">
          <h3 className="settings-section__title">Appearance</h3>
          <div className="theme-grid">
            {THEMES.map((theme, idx) => (
              <button
                key={theme.name}
                className={`theme-preview ${idx === settings.theme_idx ? "active" : ""}`}
                onClick={() => onUpdate({ theme_idx: idx })}
                title={theme.name}
              >
                <div className="theme-preview-colors" style={{ background: theme.colors.bg }}>
                  <div className="theme-swatch-row">
                    <span style={{ color: theme.colors.text }}>abc</span>
                    <span style={{ color: theme.colors.accent }}>fn</span>
                    <span style={{ color: theme.colors.green }}>ok</span>
                    <span style={{ color: theme.colors.red }}>err</span>
                    <span style={{ color: theme.colors.yellow }}>warn</span>
                  </div>
                  <div className="theme-swatch-bar">
                    <span style={{ background: theme.colors.surface }}></span>
                    <span style={{ background: theme.colors.accent }}></span>
                    <span style={{ background: theme.colors.green }}></span>
                    <span style={{ background: theme.colors.red }}></span>
                    <span style={{ background: theme.colors.yellow }}></span>
                  </div>
                </div>
                <div className="theme-preview-name">{theme.name}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Font */}
        <div className="settings-section">
          <h3 className="settings-section__title">Terminal Font</h3>
          <p className="modal-hint" style={{ marginTop: 0, marginBottom: "var(--space-2)" }}>Used in terminal/xterm sessions</p>
          <div className="font-settings-row">
            <div className="modal-field">
              <label htmlFor="font-family">Family</label>
              <select
                id="font-family"
                className="modal-input"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="modal-field">
              <label htmlFor="font-size">Size ({fontSize}px)</label>
              <input
                id="font-size"
                type="range"
                min="10"
                max="24"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="modal-input"
              />
            </div>
          </div>
          <div className="font-preview" style={{
            fontFamily: `'${fontFamily}', 'Consolas', monospace`,
            fontSize: `${fontSize}px`,
          }}>
            The quick brown fox jumps over the lazy dog<br/>
            {"0123456789 !@#$%^&*() {}[]|\\/<>"}
          </div>
        </div>

        {/* Chat Font */}
        <div className="settings-section">
          <h3 className="settings-section__title">Chat Font</h3>
          <p className="modal-hint" style={{ marginTop: 0, marginBottom: "var(--space-2)" }}>Used in chat-style message views</p>
          <div className="font-settings-row">
            <div className="modal-field">
              <label htmlFor="chat-font-family">Family</label>
              <select
                id="chat-font-family"
                className="modal-input"
                value={chatFontFamily}
                onChange={(e) => setChatFontFamily(e.target.value)}
              >
                {CHAT_FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="modal-field">
              <label htmlFor="chat-font-size">Size ({chatFontSize}px)</label>
              <input
                id="chat-font-size"
                type="range"
                min="10"
                max="24"
                value={chatFontSize}
                onChange={(e) => setChatFontSize(Number(e.target.value))}
                className="modal-input"
              />
            </div>
          </div>
          <div className="font-preview" style={{
            fontFamily: `'${chatFontFamily}', 'Segoe UI', system-ui, sans-serif`,
            fontSize: `${chatFontSize}px`,
          }}>
            The quick brown fox jumps over the lazy dog<br/>
            {"0123456789 !@#$%^&*() {}[]|\\/<>"}
          </div>
        </div>

        {/* Directories */}
        <div className="settings-section">
          <h3 className="settings-section__title">Directories</h3>
          <p className="modal-hint" style={{ marginTop: 0, marginBottom: "var(--space-2)" }}>Changes require save to take effect</p>
          <ul className="dir-list">
            {dirEntries.map((entry, i) => (
              <li key={entry.path} className="dir-item">
                <button
                  className={`dir-mode-badge ${entry.mode}`}
                  onClick={() => toggleDirMode(i)}
                  title="Click to toggle: container (subdirs are projects) / single project"
                >
                  {entry.mode === "container" ? "container" : "project"}
                </button>
                <span className="dir-path" title={entry.path}>{entry.path}</span>
                {dirEntries.length > 1 && (
                  <button className="remove-btn" onClick={() => removeDir(i)} title="Remove">
                    {"\u00d7"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="add-dir-row">
            <input
              ref={dirInputRef}
              className="modal-input"
              value={newDirPath}
              onChange={(e) => setNewDirPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addDir(); }}
              placeholder="D:\Projects\other"
            />
            <select
              className="modal-input add-dir-mode-select"
              value={newDirMode}
              onChange={(e) => setNewDirMode(e.target.value as DirMode)}
            >
              <option value="container">Container</option>
              <option value="single">Single project</option>
            </select>
            <button className="modal-btn" onClick={addDir}>Add</button>
          </div>
          <p className="modal-hint">
            Container: each subdirectory is a project. Single project: the folder itself is a project.
          </p>
          {dirsDirty && (
            <div className="modal-buttons" style={{ marginTop: "var(--space-2)" }}>
              <button className="modal-btn primary" onClick={saveDirs}>Save &amp; Rescan</button>
            </div>
          )}
        </div>

        {/* Behavior */}
        <div className="settings-section">
          <h3 className="settings-section__title">Behavior</h3>
          <div className="settings-toggle-row">
            <span>Input style</span>
            <SegmentedControl
              options={INPUT_STYLE_OPTIONS}
              value={settings.input_style ?? "terminal"}
              onChange={handleInputStyleChange}
              title="Input style"
            />
          </div>
          <div className="settings-toggle-row">
            <span>Tab layout</span>
            <SegmentedControl
              options={TAB_LAYOUT_OPTIONS}
              value={settings.vertical_tabs ? "vertical" : "horizontal"}
              onChange={handleTabLayoutChange}
              title="Tab layout"
            />
          </div>
          <div className="settings-toggle-row">
            <span>Sort order</span>
            <SegmentedControl
              options={SORT_OPTIONS}
              value={SORT_ORDERS[settings.sort_idx] ?? SORT_ORDERS[0]}
              onChange={handleSortChange}
              title="Sort order (F3)"
            />
          </div>
          <div className="settings-toggle-row">
            <span>Security gate</span>
            <button
              className={`settings-toggle-btn ${settings.security_gate ? "active" : ""}`}
              onClick={() => onUpdate({ security_gate: !settings.security_gate })}
            >
              {settings.security_gate ? "ON" : "off"}
            </button>
          </div>
          <div className="settings-toggle-row">
            <span>Autocomplete</span>
            <button
              className={`settings-toggle-btn ${settings.autocomplete_enabled !== false ? "active" : ""}`}
              onClick={() => onUpdate({ autocomplete_enabled: !(settings.autocomplete_enabled !== false) })}
            >
              {settings.autocomplete_enabled !== false ? "ON" : "off"}
            </button>
          </div>
        </div>
      </div>

      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
});
