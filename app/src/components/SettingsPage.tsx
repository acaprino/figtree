import { memo, useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "radix-ui";
import { Settings, SORT_ORDERS } from "../types";
import { sanitizeFontName } from "../themes";
import { useThemes } from "../contexts/ThemesContext";
import SegmentedControl from "./SegmentedControl";
import "./SettingsPage.css";

type DirMode = "container" | "single";
type DirEntry = { path: string; mode: DirMode };

type SettingsTab = "themes" | "fonts" | "projects" | "behavior" | "advanced";

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

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "themes", label: "Themes" },
  { id: "fonts", label: "Fonts" },
  { id: "projects", label: "Projects" },
  { id: "behavior", label: "Behavior" },
  { id: "advanced", label: "Advanced" },
];

interface SettingsPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => void;
  allPluginPaths: string[];
}

export default memo(function SettingsPage({ tabId, onRequestClose, isActive, settings, onUpdate, allPluginPaths }: SettingsPageProps) {
  const THEMES = useThemes();
  const [activeTab, setActiveTab] = useState<SettingsTab>("themes");

  // Close tab on Esc
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onRequestClose(tabId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, tabId, onRequestClose]);

  const handleSortChange = useCallback((idx: number) => {
    onUpdate({ sort_idx: idx });
  }, [onUpdate]);
  const handleTabLayoutChange = useCallback((idx: number) => {
    onUpdate({ vertical_tabs: idx === 1 });
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

  // Ref for disabled_plugins so rapid toggles always read the freshest value
  const disabledPluginsRef = useRef(settings.disabled_plugins ?? []);
  disabledPluginsRef.current = settings.disabled_plugins ?? [];

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
    <div className="settings-page">
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="Settings categories">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`settings-nav-item${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {activeTab === "themes" && (
                    <div className="settings-panel" key="themes">
                      <h3 className="settings-section__title">Themes</h3>
                  <div className="theme-grid">
                    {THEMES.map((theme, idx) => (
                      <button
                    key={theme.name}
                    className={`theme-preview ${idx === settings.theme_idx ? "active" : ""}`}
                    onClick={() => onUpdate({ theme_idx: idx })}
                    title={theme.name}
                      >
                    <div className="theme-preview-colors" style={{
                      background: theme.colors.bg,
                      fontFamily: theme.termFont ? `"${theme.termFont}", monospace` : undefined,
                      fontSize: theme.termFontSize ? `${theme.termFontSize}px` : undefined,
                    }}>
                      <div className="theme-swatch-row">
                    <span style={{ color: theme.colors.text }}>text</span>
                    <span style={{ color: theme.colors.accent }}>accent</span>
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
                    <div className="theme-preview-name" style={{ background: theme.colors.surface, color: theme.colors.text }}>{theme.name}</div>
                      </button>
                    ))}
                  </div>
        </div>

          )}

          {activeTab === "fonts" && (
                    <div className="settings-panel" key="fonts">
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
                    fontFamily: `'${sanitizeFontName(fontFamily)}', 'Consolas', monospace`,
                    fontSize: `${fontSize}px`,
                  }}>
                    {"fn main() {"}<br/>
                    {'    let result = fetch_data().await?;'}<br/>
                    {'    println!("{result:?}");'}<br/>
                    {"}"}<br/>
                    {"// 0O Il1| {}()[]<>"}
                  </div>

                      <h3 className="settings-section__title" style={{ marginTop: "var(--space-6)" }}>Chat Font</h3>
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
                    fontFamily: `'${sanitizeFontName(chatFontFamily)}', 'Segoe UI', system-ui, sans-serif`,
                    fontSize: `${chatFontSize}px`,
                  }}>
                    The quick brown fox jumps over the lazy dog.<br/>
                    {"0123456789 — \"quoted\" — 'apostrophe'"}
                  </div>
        </div>

          )}

          {activeTab === "projects" && (
                    <div className="settings-panel" key="projects">
                      <h3 className="settings-section__title">Project Directories</h3>
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

          )}

          {activeTab === "behavior" && (
                    <div className="settings-panel" key="behavior">
                      <h3 className="settings-section__title">Behavior</h3>
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
                    <Switch.Root
                      className="settings-switch"
                      checked={settings.security_gate}
                      onCheckedChange={(checked) => onUpdate({ security_gate: checked })}
                    >
                      <Switch.Thumb className="settings-switch-thumb" />
                    </Switch.Root>
                  </div>
                  <div className="settings-toggle-row">
                    <span>Autocomplete</span>
                    <Switch.Root
                      className="settings-switch"
                      checked={settings.autocomplete_enabled !== false}
                      onCheckedChange={(checked) => onUpdate({ autocomplete_enabled: checked })}
                    >
                      <Switch.Thumb className="settings-switch-thumb" />
                    </Switch.Root>
                  </div>
                  <div className="settings-toggle-row">
                    <span>Hide thinking</span>
                    <Switch.Root
                      className="settings-switch"
                      checked={settings.hide_thinking ?? false}
                      onCheckedChange={(checked) => onUpdate({ hide_thinking: checked })}
                    >
                      <Switch.Thumb className="settings-switch-thumb" />
                    </Switch.Root>
                  </div>
                  <div className="settings-toggle-row">
                    <span>Marketplace (global CLI)</span>
                    <Switch.Root
                      className="settings-switch"
                      checked={settings.marketplace_global ?? false}
                      onCheckedChange={(checked) => {
                    onUpdate({ marketplace_global: checked });
                    invoke("set_marketplace_global", { enabled: checked }).catch(console.error);
                      }}
                    >
                      <Switch.Thumb className="settings-switch-thumb" />
                    </Switch.Root>
                  </div>
                  <p className="modal-hint">When ON, anvil-toolset plugins are also available in standalone Claude Code CLI sessions.</p>
        </div>
          )}

          {activeTab === "advanced" && (
                    <div className="settings-panel" key="advanced">
                      <h3 className="settings-section__title">Plugins</h3>
                  <p className="modal-hint" style={{ marginTop: 0, marginBottom: "var(--space-3)" }}>
                    Toggle plugins on/off. Disabling a plugin also disables its hooks. Changes apply to new sessions.
                  </p>
                  <div className="plugin-list">
                    {allPluginPaths.length === 0 ? (
                      <p className="modal-hint">No plugins found.</p>
                    ) : (
                      allPluginPaths.map((pluginPath) => {
                        const name = pluginPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
                        const disabled = settings.disabled_plugins ?? [];
                        const isEnabled = !disabled.includes(name);
                        return (
                          <div key={name} className="plugin-row">
                            <span className="plugin-name">{name}</span>
                            <Switch.Root
                              className="settings-switch"
                              checked={isEnabled}
                              onCheckedChange={(checked) => {
                                const prev = disabledPluginsRef.current;
                                const next = checked
                                  ? prev.filter((n) => n !== name)
                                  : [...prev, name];
                                disabledPluginsRef.current = next;
                                onUpdate({ disabled_plugins: next });
                              }}
                            >
                              <Switch.Thumb className="settings-switch-thumb" />
                            </Switch.Root>
                          </div>
                        );
                      })
                    )}
                  </div>
        </div>
          )}
        </div>
      </div>

    </div>
  );
});
