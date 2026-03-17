import { useEffect, useCallback, useMemo, useRef, useState, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SystemPrompt } from "./types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabManager } from "./hooks/useTabManager";
import { ProjectsProvider, useProjectsContext } from "./contexts/ProjectsContext";
import TabBar from "./components/TabBar";
import TitleBar from "./components/TitleBar";
import TabSidebar from "./components/TabSidebar";
import ChatView from "./components/ChatView";
import NewTabPage from "./components/NewTabPage";
import ErrorBoundary from "./components/ErrorBoundary";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import "./components/ShortcutsOverlay.css";
import "./App.css";

// Lazy-load singleton tab pages (rarely opened, reduces initial parse time)
const AboutPage = lazy(() => import("./components/AboutPage"));
const UsagePage = lazy(() => import("./components/UsagePage"));
const SystemPromptPage = lazy(() => import("./components/SystemPromptPage"));
const SessionBrowser = lazy(() => import("./components/SessionBrowser"));
const SessionPanel = lazy(() => import("./components/SessionPanel"));

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
    toggleSessionsTab,
    closeTab,
    updateTab,
    markNewOutput,
    activateTab,
    nextTab,
    prevTab,
  } = useTabManager();

  const { settings, setFilter, updateSettings } = useProjectsContext();

  const fontFamily = settings?.font_family ?? "Cascadia Code";
  const fontSize = settings?.font_size ?? 14;
  const chatFontFamily = settings?.chat_font_family ?? "Segoe UI";
  const chatFontSize = settings?.chat_font_size ?? 14;
  const verticalTabs = settings?.vertical_tabs ?? false;
  const inputStyle = (settings?.input_style ?? "terminal") as "chat" | "terminal";
  const sidebarWidth = settings?.sidebar_width ?? 200;
  const appRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  const setIsResizing = useCallback((resizing: boolean) => {
    isResizingRef.current = resizing;
    appRef.current?.classList.toggle("resizing", resizing);
  }, []);

  const handleResizeWidth = useCallback((width: number) => {
    updateSettings({ sidebar_width: width });
  }, [updateSettings]);

  // Sync sidebar width to CSS custom property (skip during active resize to prevent snap-back)
  useEffect(() => {
    if (verticalTabs && !isResizingRef.current) {
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    }
  }, [verticalTabs, sidebarWidth]);

  // Load prompts from .md files (source of truth) on mount and when settings change
  const [allPrompts, setAllPrompts] = useState<SystemPrompt[]>([]);
  const reloadPrompts = useCallback(() => {
    invoke<SystemPrompt[]>("load_builtin_prompts").then(setAllPrompts).catch(console.error);
  }, []);
  useEffect(() => { reloadPrompts(); }, [reloadPrompts]);

  // Shortcuts overlay
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Load bundled marketplace plugin paths (Anvil-exclusive by default)
  const [pluginPaths, setPluginPaths] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("get_marketplace_plugins").then(setPluginPaths).catch(console.error);
  }, []);

  const systemPrompt = useMemo(() => {
    const activeIds: string[] = settings?.active_prompt_ids ?? [];
    return allPrompts
      .filter((p) => activeIds.includes(p.id))
      .map((p) => p.content)
      .join("\n\n");
  }, [allPrompts, settings?.active_prompt_ids]);

  const addTabAndResetFilter = useCallback(() => {
    setFilter("");
    return addTab();
  }, [addTab, setFilter]);

  // H2: Memoize terminal count to avoid refiltering on every render
  const terminalCount = useMemo(() => tabs.filter((t) => t.type === "agent").length, [tabs]);
  useEffect(() => {
    if (activeTab.type === "agent" && activeTab.projectName) {
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
    root.style.setProperty("--font-chat", `'${chatFontFamily}', 'Segoe UI', system-ui, sans-serif`);
    root.style.setProperty("--text-base", `${fontSize}px`);
    root.style.setProperty("--text-chat", `${chatFontSize}px`);
  }, [fontFamily, chatFontFamily, fontSize, chatFontSize]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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
      } else if (e.ctrlKey && e.shiftKey && e.key === "H") {
        e.preventDefault();
        toggleSessionsTab();
      } else if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        toggleSystemPromptTab();
      } else if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        updateSettings({ session_panel_open: !settingsRef.current?.session_panel_open });
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = e.key === "9" ? tabsRef.current.length - 1 : parseInt(e.key) - 1;
        if (idx >= 0 && idx < tabsRef.current.length) {
          activateTab(tabsRef.current[idx].id);
        }
      } else if (e.key === "F1") {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTabAndResetFilter, toggleAboutTab, toggleUsageTab, toggleSystemPromptTab, toggleSessionsTab, updateSettings, closeTab, activeTabId, nextTab, prevTab]);

  const handleLaunch = useCallback(
    (tabId: string, projectPath: string, projectName: string, modelIdx: number, effortIdx: number, permModeIdx: number, autocompact: boolean, temporary?: boolean) => {
      updateTab(tabId, {
        type: "agent",
        projectPath,
        projectName,
        modelIdx,
        effortIdx,
        permModeIdx,
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
    updateTab(tabId, { agentSessionId: sessionId });
  }, [updateTab]);

  const handleError = useCallback((tabId: string, msg: string) => {
    console.error(`Tab ${tabId} error:`, msg);
  }, []);

  const handleTaglineChange = useCallback((tabId: string, tagline: string) => {
    updateTab(tabId, { tagline });
  }, [updateTab]);

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

  // Session panel
  const sessionPanelOpen = settings?.session_panel_open ?? false;
  const activeProjectPath = activeTab.type === "agent" ? (activeTab.projectPath ?? null) : null;

  const toggleSessionPanel = useCallback(() => {
    updateSettings({ session_panel_open: !settingsRef.current?.session_panel_open });
  }, [updateSettings]);

  const handleSessionAction = useCallback((
    mode: "resume" | "fork", sessionId: string, cwd: string, inNewTab?: boolean,
  ) => {
    const projectName = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "Terminal";
    const modelIdx = settingsRef.current?.model_idx ?? 0;
    const effortIdx = settingsRef.current?.effort_idx ?? 0;
    const autocompact = settingsRef.current?.autocompact ?? false;
    const field = mode === "resume" ? "resumeSessionId" : "forkSessionId";
    const payload = {
      type: "agent" as const, projectPath: cwd, projectName, modelIdx, effortIdx,
      permModeIdx: 0, autocompact, [field]: sessionId,
    };

    if (inNewTab || activeTab.type !== "agent") {
      const tabId = addTab();
      updateTab(tabId, payload);
    } else {
      updateTab(activeTabId, payload);
    }
  }, [activeTab.type, activeTabId, addTab, updateTab]);

  const handleResumeSession = useCallback((sessionId: string, cwd: string, inNewTab?: boolean) => {
    handleSessionAction("resume", sessionId, cwd, inNewTab);
  }, [handleSessionAction]);

  const handleForkSession = useCallback((sessionId: string, cwd: string, inNewTab?: boolean) => {
    handleSessionAction("fork", sessionId, cwd, inNewTab);
  }, [handleSessionAction]);

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

  const appClassName = `app${verticalTabs ? " vertical-tabs" : ""}${sessionPanelOpen ? " session-panel-open" : ""}`;

  return (
    <div ref={appRef} className={appClassName}>
      <div className="resize-handle top" onMouseDown={resizeHandlers.N} />
      <div className="resize-handle bottom" onMouseDown={resizeHandlers.S} />
      <div className="resize-handle left" onMouseDown={resizeHandlers.W} />
      <div className="resize-handle right" onMouseDown={resizeHandlers.E} />
      <div className="resize-handle top-left" onMouseDown={resizeHandlers.NW} />
      <div className="resize-handle top-right" onMouseDown={resizeHandlers.NE} />
      <div className="resize-handle bottom-left" onMouseDown={resizeHandlers.SW} />
      <div className="resize-handle bottom-right" onMouseDown={resizeHandlers.SE} />
      {verticalTabs ? (
        <>
          <TitleBar />
          <TabSidebar
            tabs={tabs}
            activeTabId={activeTabId}
            sidebarWidth={sidebarWidth}
            onActivate={activateTab}
            onClose={closeTab}
            onAdd={addTabAndResetFilter}
            onSaveToProjects={handleSaveToProjects}
            onToggleAbout={toggleAboutTab}
            onToggleUsage={toggleUsageTab}
            onToggleSessions={toggleSessionPanel}
            onResizeWidth={handleResizeWidth}
            onResizing={setIsResizing}
          />
          {sessionPanelOpen && (
            <Suspense fallback={null}>
              <SessionPanel
                projectPath={activeProjectPath}
                isOpen={sessionPanelOpen}
                onClose={toggleSessionPanel}
                onResumeSession={handleResumeSession}
                onForkSession={handleForkSession}
              />
            </Suspense>
          )}
        </>
      ) : (
        <>
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
            onAdd={addTabAndResetFilter}
            onSaveToProjects={handleSaveToProjects}
            onToggleAbout={toggleAboutTab}
            onToggleUsage={toggleUsageTab}
            onToggleSessions={toggleSessionPanel}
          />
          {sessionPanelOpen && (
            <Suspense fallback={null}>
              <SessionPanel
                projectPath={activeProjectPath}
                isOpen={sessionPanelOpen}
                onClose={toggleSessionPanel}
                onResumeSession={handleResumeSession}
                onForkSession={handleForkSession}
              />
            </Suspense>
          )}
        </>
      )}
      <div className="tab-content">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isTerminal = tab.type === "agent";

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
                  <Suspense fallback={null}>
                    <AboutPage
                      tabId={tab.id}
                      onRequestClose={closeTab}
                      isActive={isActive}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "usage" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Suspense fallback={null}>
                    <UsagePage
                      tabId={tab.id}
                      onRequestClose={closeTab}
                      isActive={isActive}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "system-prompt" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Suspense fallback={null}>
                    <SystemPromptPage
                      tabId={tab.id}
                      onRequestClose={closeTab}
                      isActive={isActive}
                      prompts={allPrompts}
                      onPromptsChanged={reloadPrompts}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "sessions" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Suspense fallback={null}>
                    <SessionBrowser
                      tabId={tab.id}
                      isActive={isActive}
                      onRequestClose={closeTab}
                      onResumeSession={handleResumeSession}
                      onForkSession={handleForkSession}
                      onViewSession={(sessionId) => {
                        // TODO: view session transcript
                        console.log("View session", sessionId);
                      }}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "agent" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <ChatView
                    key={`${tab.id}-${tab.resumeSessionId || ""}-${tab.forkSessionId || ""}`}
                    tabId={tab.id}
                    projectPath={tab.projectPath!}
                    modelIdx={tab.modelIdx ?? 0}
                    effortIdx={tab.effortIdx ?? 0}
                    permModeIdx={tab.permModeIdx ?? 0}
                    systemPrompt={systemPrompt}
                    isActive={isActive}
                    onSessionCreated={handleSessionCreated}
                    onNewOutput={handleNewOutput}
                    onExit={handleExit}
                    onError={handleError}
                    onTaglineChange={handleTaglineChange}
                    inputStyle={inputStyle}
                    hideThinking={settings?.hide_thinking}
                    plugins={pluginPaths}
                    resumeSessionId={tab.resumeSessionId}
                    forkSessionId={tab.forkSessionId}
                  />
                </ErrorBoundary>
              ) : (
                null
              )}
            </div>
          );
        })}
      </div>
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
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
