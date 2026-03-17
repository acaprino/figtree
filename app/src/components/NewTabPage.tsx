import { useState, useEffect, useCallback, useRef, memo } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useProjectsContext } from "../contexts/ProjectsContext";
import ProjectList from "./ProjectList";
import SessionConfig from "./SessionConfig";
import InfoStrip from "./InfoStrip";
import CreateProjectModal from "./modals/CreateProjectModal";
import LabelProjectModal from "./modals/LabelProjectModal";
import QuickLaunchModal from "./modals/QuickLaunchModal";
import SettingsModal from "./modals/SettingsModal";
import { ProjectInfo, MODELS, EFFORTS, SORT_ORDERS, PERM_MODES } from "../types";
import "./NewTabPage.css";

interface NewTabPageProps {
  tabId: string;
  onLaunch: (
    tabId: string,
    projectPath: string,
    projectName: string,
    modelIdx: number,
    effortIdx: number,
    permModeIdx: number,
    autocompact: boolean,
    temporary?: boolean,
  ) => void;
  onRequestClose: (tabId: string) => void;
  onOpenSystemPrompts: () => void;
  isActive: boolean;
}

type ModalType = "create-project" | "label-project" | "quick-launch" | "settings" | null;

function NewTabPage({ tabId, onLaunch, onRequestClose, onOpenSystemPrompts, isActive }: NewTabPageProps) {
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
        currentSettings.perm_mode_idx,
        currentSettings.autocompact,
      );
    },
    [tabId, onLaunch],
  );

  const launchProjectRef = useRef(launchProject);
  useEffect(() => { launchProjectRef.current = launchProject; }, [launchProject]);

  // Keyboard handler — reduced shortcut set
  const hasSettings = settings != null;
  useEffect(() => {
    if (!isActive || !hasSettings) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModalRef.current) return;

      // Ctrl shortcuts
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setActiveModal("settings");
        return;
      }
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
            perm_mode_idx: (currentSettings.perm_mode_idx + 1) % PERM_MODES.length,
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
          updateSettingsRef.current({
            model_idx: (currentSettings.model_idx + 1) % MODELS.length,
          });
          break;
        case "F5":
          e.preventDefault();
          setActiveModal("create-project");
          break;
        case "F6":
          e.preventDefault();
          if (currentProjects[selectedIdxRef.current]) {
            const p = currentProjects[selectedIdxRef.current].path;
            if (/^[a-zA-Z]:\\/.test(p) && !p.startsWith("\\\\")) {
              open(p).catch((e) => console.warn("shell open failed:", e));
            }
          }
          break;
        case "F8":
          e.preventDefault();
          if (currentProjects[selectedIdxRef.current]) {
            setActiveModal("label-project");
          }
          break;
        case "F10":
          e.preventDefault();
          setActiveModal("quick-launch");
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

  const openSettings = useCallback(() => setActiveModal("settings"), []);

  if (!settings) {
    return (
      <div className="new-tab-page">
        <div className="project-list-loading">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.12 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="new-tab-page">
        <div className="error-state">
          <div className="error-icon" aria-hidden="true">&#9888;</div>
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
      <SessionConfig settings={settings} onUpdate={updateSettings} />
      <ProjectList
        projects={projects}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
        onActivate={launchProject}
        loading={loading}
        launchingIdx={launching ? selectedIdx : undefined}
      />
      <InfoStrip
        filter={filter}
        projectCount={projects.length}
        onOpenSettings={openSettings}
        onOpenSystemPrompts={onOpenSystemPrompts}
        onQuickLaunch={() => setActiveModal("quick-launch")}
      />

      {activeModal === "create-project" && (
        <CreateProjectModal
          defaultDir={settings.project_dirs[0] ?? ""}
          onClose={() => setActiveModal(null)}
          onCreated={refresh}
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
            if (addToProjects) {
              const dl = dirPath.toLowerCase();
              const inContainer = settings.project_dirs.some(
                (d) => dl.startsWith(d.toLowerCase() + "\\") || dl.startsWith(d.toLowerCase() + "/"),
              );
              const isSingle = settings.single_project_dirs.some((d) => d.toLowerCase() === dl);
              if (!inContainer && !isSingle) {
                updateSettings({ single_project_dirs: [...settings.single_project_dirs, dirPath] });
              }
            }
            const name = dirPath.split(/[\\/]/).pop() ?? "Terminal";
            setActiveModal(null);
            onLaunch(tabId, dirPath, name, settings.model_idx, settings.effort_idx, settings.perm_mode_idx, settings.autocompact, !addToProjects);
          }}
        />
      )}
      {activeModal === "settings" && (
        <SettingsModal
          settings={settings}
          onClose={() => setActiveModal(null)}
          onUpdate={updateSettings}
        />
      )}
    </div>
  );
}

export default memo(NewTabPage);
