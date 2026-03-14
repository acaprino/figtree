import { useEffect, useCallback, useMemo, useRef } from "react";
import { SystemPrompt } from "./types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabManager } from "./hooks/useTabManager";
import { ProjectsProvider, useProjectsContext } from "./contexts/ProjectsContext";
import TabBar from "./components/TabBar";
import Terminal from "./components/Terminal";
import NewTabPage from "./components/NewTabPage";
import AboutPage from "./components/AboutPage";
import UsagePage from "./components/UsagePage";
import SystemPromptPage from "./components/SystemPromptPage";
import ErrorBoundary from "./components/ErrorBoundary";
import "./App.css";

// R13: Cache window reference at module level (always same window in Tauri)
const appWindow = getCurrentWindow();

function AppContent() {
  const {
    tabs,
    activeTab,
    activeTabId,
    addTab,
    toggleAboutTab,
    toggleUsageTab,
    toggleSystemPromptTab,
    closeTab,
    updateTab,
    markNewOutput,
    activateTab,
    nextTab,
    prevTab,
  } = useTabManager();

  const { settings, setFilter, updateSettings } = useProjectsContext();
  const themeIdx = settings?.theme_idx ?? 0;
  const fontFamily = settings?.font_family ?? "Cascadia Code";
  const fontSize = settings?.font_size ?? 14;
  const systemPrompt = useMemo(() => {
    const prompts: SystemPrompt[] = settings?.system_prompts ?? [];
    const activeIds: string[] = settings?.active_prompt_ids ?? [];
    return prompts
      .filter((p) => activeIds.includes(p.id))
      .map((p) => p.content)
      .join("\n\n");
  }, [settings?.system_prompts, settings?.active_prompt_ids]);

  const addTabAndResetFilter = useCallback(() => {
    setFilter("");
    return addTab();
  }, [addTab, setFilter]);

  // H2: Memoize terminal count to avoid refiltering on every render
  const terminalCount = useMemo(() => tabs.filter((t) => t.type === "terminal").length, [tabs]);
  useEffect(() => {
    if (activeTab.type === "terminal" && activeTab.projectName) {
      const suffix = terminalCount > 1 ? ` (+${terminalCount - 1} tabs)` : "";
      appWindow.setTitle(`Anvil \u2014 ${activeTab.projectName}${suffix}`);
    } else {
      appWindow.setTitle("Anvil");
    }
  }, [activeTab.type, activeTab.projectName, terminalCount]);

  // Sync font settings to CSS custom properties so GUI inherits them
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-mono", `'${fontFamily}', 'Consolas', monospace`);
    root.style.setProperty("--text-base", `${fontSize}px`);
  }, [fontFamily, fontSize]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        addTabAndResetFilter();
      } else if (e.ctrlKey && e.key === "F4") {
        e.preventDefault();
        closeTab(activeTabId);
      } else if (e.ctrlKey && !e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        nextTab();
      } else if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        prevTab();
      } else if (e.key === "F12") {
        e.preventDefault();
        toggleAboutTab();
      } else if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        toggleUsageTab();
      } else if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        toggleSystemPromptTab();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTabAndResetFilter, toggleAboutTab, toggleUsageTab, toggleSystemPromptTab, closeTab, activeTabId, nextTab, prevTab]);

  const handleLaunch = useCallback(
    (tabId: string, projectPath: string, projectName: string, toolIdx: number, modelIdx: number, effortIdx: number, skipPerms: boolean, autocompact: boolean, temporary?: boolean) => {
      updateTab(tabId, {
        type: "terminal",
        projectPath,
        projectName,
        toolIdx,
        modelIdx,
        effortIdx,
        skipPerms,
        autocompact,
        temporary: temporary || false,
      });
    },
    [updateTab],
  );

  // H1: Use markNewOutput which guards against redundant array creation
  const handleNewOutput = useCallback((tabId: string) => {
    markNewOutput(tabId);
  }, [markNewOutput]);

  const handleExit = useCallback((tabId: string, code: number) => {
    updateTab(tabId, { exitCode: code });
  }, [updateTab]);

  const handleSessionCreated = useCallback((tabId: string, sessionId: string) => {
    updateTab(tabId, { sessionId });
  }, [updateTab]);

  const handleError = useCallback((tabId: string, msg: string) => {
    console.error(`Tab ${tabId} error:`, msg);
  }, []);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const handleSaveToProjects = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab?.projectPath || !tab.temporary) return;
    // Add to single_project_dirs if not already tracked
    const dl = tab.projectPath.toLowerCase();
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;
    const inContainer = currentSettings.project_dirs.some(
      (d) => dl.startsWith(d.toLowerCase() + "\\") || dl.startsWith(d.toLowerCase() + "/"),
    );
    const isSingle = currentSettings.single_project_dirs.some((d) => d.toLowerCase() === dl);
    if (!inContainer && !isSingle) {
      updateSettings({ single_project_dirs: [...currentSettings.single_project_dirs, tab.projectPath] });
    }
    // Remove temp flag
    updateTab(tabId, { temporary: false });
  }, [updateSettings, updateTab]);

  // H4: Memoize resize handlers to avoid creating new arrow functions every render
  const resizeHandlers = useMemo(() => ({
    N:  () => appWindow.startResizeDragging("North"),
    S:  () => appWindow.startResizeDragging("South"),
    E:  () => appWindow.startResizeDragging("East"),
    W:  () => appWindow.startResizeDragging("West"),
    NE: () => appWindow.startResizeDragging("NorthEast"),
    NW: () => appWindow.startResizeDragging("NorthWest"),
    SE: () => appWindow.startResizeDragging("SouthEast"),
    SW: () => appWindow.startResizeDragging("SouthWest"),
  }), []);

  return (
    <div className="app">
      <div className="resize-handle top" onMouseDown={resizeHandlers.N} />
      <div className="resize-handle bottom" onMouseDown={resizeHandlers.S} />
      <div className="resize-handle left" onMouseDown={resizeHandlers.W} />
      <div className="resize-handle right" onMouseDown={resizeHandlers.E} />
      <div className="resize-handle top-left" onMouseDown={resizeHandlers.NW} />
      <div className="resize-handle top-right" onMouseDown={resizeHandlers.NE} />
      <div className="resize-handle bottom-left" onMouseDown={resizeHandlers.SW} />
      <div className="resize-handle bottom-right" onMouseDown={resizeHandlers.SE} />
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={closeTab}
        onAdd={addTabAndResetFilter}
        onSaveToProjects={handleSaveToProjects}
        onToggleAbout={toggleAboutTab}
        onToggleUsage={toggleUsageTab}
      />
      <div className="tab-content">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isTerminal = tab.type === "terminal";

          return (
            <div
              key={tab.id}
              className={`tab-panel ${isActive ? "active" : ""} ${isTerminal ? "terminal-panel" : ""}`}
            >
              {tab.type === "new-tab" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <NewTabPage
                    tabId={tab.id}
                    onLaunch={handleLaunch}
                    onRequestClose={closeTab}
                    onOpenSystemPrompts={toggleSystemPromptTab}
                    isActive={isActive}
                  />
                </ErrorBoundary>
              ) : tab.type === "about" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <AboutPage
                    tabId={tab.id}
                    onRequestClose={closeTab}
                    isActive={isActive}
                  />
                </ErrorBoundary>
              ) : tab.type === "usage" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <UsagePage
                    tabId={tab.id}
                    onRequestClose={closeTab}
                    isActive={isActive}
                  />
                </ErrorBoundary>
              ) : tab.type === "system-prompt" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <SystemPromptPage
                    tabId={tab.id}
                    onRequestClose={closeTab}
                    isActive={isActive}
                  />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Terminal
                    tabId={tab.id}
                    projectPath={tab.projectPath!}
                    toolIdx={tab.toolIdx ?? 0}
                    modelIdx={tab.modelIdx ?? 0}
                    effortIdx={tab.effortIdx ?? 0}
                    skipPerms={tab.skipPerms ?? false}
                    autocompact={tab.autocompact ?? false}
                    systemPrompt={systemPrompt}
                    themeIdx={themeIdx}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    isActive={isActive}
                    onSessionCreated={handleSessionCreated}
                    onNewOutput={handleNewOutput}
                    onExit={handleExit}
                    onError={handleError}
                    onRequestClose={closeTab}
                  />
                </ErrorBoundary>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  return (
    <ProjectsProvider>
      <AppContent />
    </ProjectsProvider>
  );
}

export default App;
