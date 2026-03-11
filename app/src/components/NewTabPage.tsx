import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsContext } from "../contexts/ProjectsContext";
import ProjectList from "./ProjectList";
import StatusBar, { StatusBarAction } from "./StatusBar";
import Modal from "./Modal";
import { ProjectInfo, Settings, MODELS, EFFORTS, SORT_ORDERS, THEMES } from "../types";
import "./NewTabPage.css";

interface NewTabPageProps {
  tabId: string;
  onLaunch: (
    tabId: string,
    projectPath: string,
    projectName: string,
    modelIdx: number,
    effortIdx: number,
    skipPerms: boolean,
  ) => void;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

type ModalType = "create-project" | "manage-dirs" | "label-project" | "quick-launch" | "theme-picker" | "font-settings" | null;

export default function NewTabPage({ tabId, onLaunch, onRequestClose, isActive }: NewTabPageProps) {
  const {
    settings,
    projects,
    loading,
    error,
    retry,
    filter,
    setFilter,
    updateSettings,
    recordUsage,
    refresh,
  } = useProjectsContext();

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [activeModal, setActiveModal] = useState<ModalType>(null);

  // R3: Store frequently-changing values in refs for stable keyboard handler
  const projectsRef = useRef(projects);
  const selectedIdxRef = useRef(selectedIdx);
  const filterRef = useRef(filter);
  const launchingRef = useRef(launching);
  const settingsRef = useRef(settings);
  const updateSettingsRef = useRef(updateSettings);
  const onRequestCloseRef = useRef(onRequestClose);
  const recordUsageRef = useRef(recordUsage);
  const activeModalRef = useRef(activeModal);

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);
  useEffect(() => { filterRef.current = filter; }, [filter]);
  useEffect(() => { launchingRef.current = launching; }, [launching]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { updateSettingsRef.current = updateSettings; }, [updateSettings]);
  useEffect(() => { onRequestCloseRef.current = onRequestClose; }, [onRequestClose]);
  useEffect(() => { recordUsageRef.current = recordUsage; }, [recordUsage]);
  useEffect(() => { activeModalRef.current = activeModal; }, [activeModal]);

  useEffect(() => {
    if (selectedIdx >= projects.length && projects.length > 0) {
      setSelectedIdx(projects.length - 1);
    }
  }, [projects.length, selectedIdx]);

  const launchProject = useCallback(
    async (project: ProjectInfo) => {
      const currentSettings = settingsRef.current;
      if (!currentSettings || launchingRef.current) return;
      setLaunching(true);

      await recordUsageRef.current(project.path);

      onLaunch(
        tabId,
        project.path,
        project.label ?? project.name,
        currentSettings.model_idx,
        currentSettings.effort_idx,
        currentSettings.skip_perms,
      );
    },
    [tabId, onLaunch],
  );

  const launchProjectRef = useRef(launchProject);
  useEffect(() => { launchProjectRef.current = launchProject; }, [launchProject]);

  // R3: Stable keyboard handler - only re-attaches when isActive or settings availability changes
  const hasSettings = settings != null;
  useEffect(() => {
    if (!isActive || !hasSettings) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle keys when a modal is open
      if (activeModalRef.current) return;
      if (e.ctrlKey) return;

      const currentProjects = projectsRef.current;
      const currentSettings = settingsRef.current;
      if (!currentSettings) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedIdx((prev) => Math.max(0, prev - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIdx((prev) => Math.min(currentProjects.length - 1, prev + 1));
          break;
        case "PageUp":
          e.preventDefault();
          setSelectedIdx((prev) => Math.max(0, prev - 10));
          break;
        case "PageDown":
          e.preventDefault();
          setSelectedIdx((prev) => Math.min(currentProjects.length - 1, prev + 10));
          break;
        case "Home":
          e.preventDefault();
          setSelectedIdx(0);
          break;
        case "End":
          e.preventDefault();
          setSelectedIdx(currentProjects.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          if (currentProjects[selectedIdxRef.current]) {
            launchProjectRef.current(currentProjects[selectedIdxRef.current]);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (filterRef.current) {
            setFilter("");
          } else {
            onRequestCloseRef.current(tabId);
          }
          break;
        case "Tab":
          e.preventDefault();
          updateSettingsRef.current({
            model_idx: (currentSettings.model_idx + 1) % MODELS.length,
          });
          break;
        case "F2":
          e.preventDefault();
          updateSettingsRef.current({
            effort_idx: (currentSettings.effort_idx + 1) % EFFORTS.length,
          });
          break;
        case "F3":
          e.preventDefault();
          updateSettingsRef.current({
            sort_idx: (currentSettings.sort_idx + 1) % SORT_ORDERS.length,
          });
          break;
        case "F4":
          e.preventDefault();
          updateSettingsRef.current({ skip_perms: !currentSettings.skip_perms });
          break;
        case "F5":
          e.preventDefault();
          setActiveModal("create-project");
          break;
        case "F6":
          e.preventDefault();
          if (currentProjects[selectedIdxRef.current]) {
            invoke("open_in_explorer", { path: currentProjects[selectedIdxRef.current].path }).catch(() => {});
          }
          break;
        case "F7":
          e.preventDefault();
          setActiveModal("manage-dirs");
          break;
        case "F8":
          e.preventDefault();
          if (currentProjects[selectedIdxRef.current]) {
            setActiveModal("label-project");
          }
          break;
        case "F9":
          e.preventDefault();
          setActiveModal("theme-picker");
          break;
        case "F10":
          e.preventDefault();
          setActiveModal("quick-launch");
          break;
        case "F11":
          e.preventDefault();
          setActiveModal("font-settings");
          break;
        case "Backspace":
          e.preventDefault();
          setFilter((prev) => prev.slice(0, -1));
          setSelectedIdx(0);
          break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            setFilter((prev) => prev + e.key);
            setSelectedIdx(0);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, hasSettings, tabId, setFilter]);

  const handleStatusAction = useCallback((action: StatusBarAction) => {
    if (action === "label-project" && !projectsRef.current[selectedIdxRef.current]) return;
    setActiveModal(action as ModalType);
  }, []);

  if (!settings) {
    return <div className="new-tab-page">Loading...</div>;
  }

  if (error) {
    return (
      <div className="new-tab-page">
        <div className="error-state">
          <div className="error-icon">&#9888;</div>
          <div className="error-title">Failed to load projects</div>
          <div className="error-message">{error}</div>
          <button className="retry-button" onClick={retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const selectedProject = projects[selectedIdx] ?? null;

  return (
    <div className="new-tab-page">
      <div className="new-tab-header">
        <h2>Claude Launcher</h2>
        <span className="shortcut-hints">
          <span><kbd>Tab</kbd> model</span>
          <span><kbd>F2</kbd> effort</span>
          <span><kbd>F3</kbd> sort</span>
          <span><kbd>F4</kbd> perms</span>
          <span><kbd>F5</kbd> new</span>
          <span><kbd>F6</kbd> open</span>
          <span><kbd>F7</kbd> dirs</span>
          <span><kbd>F8</kbd> label</span>
          <span><kbd>F9</kbd> theme</span>
          <span><kbd>F10</kbd> quick</span>
          <span><kbd>F11</kbd> font</span>
        </span>
      </div>
      <ProjectList
        projects={projects}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
        onActivate={launchProject}
        loading={loading}
        launchingIdx={launching ? selectedIdx : undefined}
      />
      <StatusBar
        settings={settings}
        filter={filter}
        onUpdate={updateSettings}
        onAction={handleStatusAction}
      />

      {activeModal === "create-project" && (
        <CreateProjectModal
          projectDirs={settings.project_dirs}
          onClose={() => setActiveModal(null)}
          onCreated={refresh}
        />
      )}
      {activeModal === "manage-dirs" && (
        <ManageDirsModal
          dirs={settings.project_dirs}
          onClose={() => setActiveModal(null)}
          onSave={(dirs) => {
            updateSettings({ project_dirs: dirs });
            setActiveModal(null);
          }}
        />
      )}
      {activeModal === "label-project" && selectedProject && (
        <LabelProjectModal
          project={selectedProject}
          currentLabel={selectedProject.label}
          onClose={() => setActiveModal(null)}
          onSave={(label) => {
            const newLabels = { ...settings.project_labels };
            if (label) {
              newLabels[selectedProject.path] = label;
            } else {
              delete newLabels[selectedProject.path];
            }
            updateSettings({ project_labels: newLabels });
            setActiveModal(null);
          }}
        />
      )}
      {activeModal === "quick-launch" && (
        <QuickLaunchModal
          onClose={() => setActiveModal(null)}
          onLaunch={(dirPath, addToProjects) => {
            if (addToProjects && !settings.project_dirs.some((d) => dirPath.startsWith(d))) {
              const parent = dirPath.replace(/[\\/][^\\/]+$/, "");
              if (parent && !settings.project_dirs.includes(parent)) {
                updateSettings({ project_dirs: [...settings.project_dirs, parent] });
              }
            }
            const name = dirPath.split(/[\\/]/).pop() ?? "Terminal";
            setActiveModal(null);
            onLaunch(tabId, dirPath, name, settings.model_idx, settings.effort_idx, settings.skip_perms);
          }}
        />
      )}
      {activeModal === "theme-picker" && (
        <ThemePickerModal
          currentIdx={settings.theme_idx}
          onClose={() => setActiveModal(null)}
          onSelect={(idx) => {
            updateSettings({ theme_idx: idx });
            setActiveModal(null);
          }}
        />
      )}
      {activeModal === "font-settings" && (
        <FontSettingsModal
          settings={settings}
          onClose={() => setActiveModal(null)}
          onSave={(updates) => {
            updateSettings(updates);
            setActiveModal(null);
          }}
        />
      )}
    </div>
  );
}

// --- Create Project Modal ---

function CreateProjectModal({
  projectDirs,
  onClose,
  onCreated,
}: {
  projectDirs: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState(projectDirs[0] ?? "");
  const [gitInit, setGitInit] = useState(true);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) { setErr("Name cannot be empty"); return; }
    setCreating(true);
    setErr("");
    try {
      await invoke("create_project", { parent: parentDir, name: name.trim(), gitInit });
      onCreated();
      onClose();
    } catch (e) {
      setErr(String(e));
      setCreating(false);
    }
  };

  return (
    <Modal title="Create Project" onClose={onClose}>
      <div className="modal-field">
        <label>Project name</label>
        <input
          ref={inputRef}
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          placeholder="my-project"
        />
      </div>
      {projectDirs.length > 1 && (
        <div className="modal-field">
          <label>Parent directory</label>
          <select
            className="modal-input"
            value={parentDir}
            onChange={(e) => setParentDir(e.target.value)}
          >
            {projectDirs.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      )}
      <div className="modal-checkbox">
        <input
          type="checkbox"
          id="git-init"
          checked={gitInit}
          onChange={(e) => setGitInit(e.target.checked)}
        />
        <label htmlFor="git-init">Initialize git repository</label>
      </div>
      {err && <div className="modal-error">{err}</div>}
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </button>
      </div>
    </Modal>
  );
}

// --- Manage Directories Modal ---

function ManageDirsModal({
  dirs,
  onClose,
  onSave,
}: {
  dirs: string[];
  onClose: () => void;
  onSave: (dirs: string[]) => void;
}) {
  const [localDirs, setLocalDirs] = useState([...dirs]);
  const [newDir, setNewDir] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const addDir = () => {
    const trimmed = newDir.trim();
    if (!trimmed || localDirs.includes(trimmed)) return;
    setLocalDirs([...localDirs, trimmed]);
    setNewDir("");
  };

  const removeDir = (idx: number) => {
    if (localDirs.length <= 1) return; // Keep at least one
    setLocalDirs(localDirs.filter((_, i) => i !== idx));
  };

  return (
    <Modal title="Manage Project Directories" onClose={onClose}>
      <ul className="dir-list">
        {localDirs.map((d, i) => (
          <li key={d} className="dir-item">
            <span className="dir-path" title={d}>{d}</span>
            {localDirs.length > 1 && (
              <button className="remove-btn" onClick={() => removeDir(i)} title="Remove">
                {"\u00d7"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="add-dir-row">
        <input
          ref={inputRef}
          className="modal-input"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addDir(); }}
          placeholder="D:\Projects\other"
        />
        <button className="modal-btn" onClick={addDir}>Add</button>
      </div>
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={() => onSave(localDirs)}>Save</button>
      </div>
    </Modal>
  );
}

// --- Label Project Modal ---

function LabelProjectModal({
  project,
  currentLabel,
  onClose,
  onSave,
}: {
  project: ProjectInfo;
  currentLabel: string | null;
  onClose: () => void;
  onSave: (label: string) => void;
}) {
  const [label, setLabel] = useState(currentLabel ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = () => {
    onSave(label.trim());
  };

  return (
    <Modal title={`Label: ${project.name}`} onClose={onClose}>
      <div className="modal-field">
        <label>Display label (leave empty to use folder name)</label>
        <input
          ref={inputRef}
          className="modal-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder={project.name}
        />
      </div>
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={handleSave}>Save</button>
      </div>
    </Modal>
  );
}

// --- Quick Launch Modal ---

function QuickLaunchModal({
  onClose,
  onLaunch,
}: {
  onClose: () => void;
  onLaunch: (dirPath: string, addToProjects: boolean) => void;
}) {
  const [dirPath, setDirPath] = useState("");
  const [addToProjects, setAddToProjects] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleLaunch = () => {
    const trimmed = dirPath.trim();
    if (!trimmed) return;
    onLaunch(trimmed, addToProjects);
  };

  return (
    <Modal title="Quick Launch" onClose={onClose}>
      <div className="modal-field">
        <label>Project directory path</label>
        <input
          ref={inputRef}
          className="modal-input"
          value={dirPath}
          onChange={(e) => setDirPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLaunch(); }}
          placeholder="D:\Projects\my-project"
        />
      </div>
      <div className="modal-checkbox">
        <input
          type="checkbox"
          id="add-to-projects"
          checked={addToProjects}
          onChange={(e) => setAddToProjects(e.target.checked)}
        />
        <label htmlFor="add-to-projects">Add parent directory to project list</label>
      </div>
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={handleLaunch}>Launch</button>
      </div>
    </Modal>
  );
}

// --- Theme Picker Modal ---

function ThemePickerModal({
  currentIdx,
  onClose,
  onSelect,
}: {
  currentIdx: number;
  onClose: () => void;
  onSelect: (idx: number) => void;
}) {
  return (
    <Modal title="Select Theme" onClose={onClose}>
      <div className="theme-grid">
        {THEMES.map((theme, idx) => (
          <button
            key={theme.name}
            className={`theme-preview ${idx === currentIdx ? "active" : ""}`}
            onClick={() => onSelect(idx)}
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
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// --- Font Settings Modal ---

const FONT_OPTIONS = [
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Courier New",
  "Lucida Console",
];

function FontSettingsModal({
  settings,
  onClose,
  onSave,
}: {
  settings: Settings;
  onClose: () => void;
  onSave: (updates: Partial<Settings>) => void;
}) {
  const [fontFamily, setFontFamily] = useState(settings.font_family || "Cascadia Code");
  const [fontSize, setFontSize] = useState(settings.font_size || 14);

  return (
    <Modal title="Font Settings" onClose={onClose}>
      <div className="modal-field">
        <label>Font family</label>
        <select
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
        <label>Font size ({fontSize}px)</label>
        <input
          type="range"
          min="10"
          max="24"
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="modal-input"
        />
      </div>
      <div className="font-preview" style={{
        fontFamily: `'${fontFamily}', 'Consolas', monospace`,
        fontSize: `${fontSize}px`,
        background: "var(--surface)",
        padding: "var(--space-3)",
        borderRadius: "var(--radius-sm)",
        color: "var(--text)",
        marginBottom: "var(--space-3)",
      }}>
        The quick brown fox jumps over the lazy dog<br/>
        {"0123456789 !@#$%^&*() {}[]|\\/<>"}
      </div>
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={() => onSave({ font_family: fontFamily, font_size: fontSize })}>
          Save
        </button>
      </div>
    </Modal>
  );
}
