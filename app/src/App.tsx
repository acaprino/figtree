import { useEffect, useCallback, useMemo, useRef, useState, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SystemPrompt } from "./types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabManager } from "./hooks/useTabManager";
import { sanitizeFontName } from "./themes";
import { ProjectsProvider, useProjectsContext } from "./contexts/ProjectsContext";
import TabBar from "./components/TabBar";
import TitleBar from "./components/TitleBar";
import TabSidebar from "./components/TabSidebar";
import AgentView from "./components/AgentView";
import NewTabPage from "./components/NewTabPage";
import ErrorBoundary from "./components/ErrorBoundary";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import OnboardingOverlay from "./components/OnboardingOverlay";
import "./components/ShortcutsOverlay.css";
import "./App.css";

// Lazy-load singleton tab pages (rarely opened, reduces initial parse time)
const AboutPage = lazy(() => import("./components/AboutPage"));
const UsagePage = lazy(() => import("./components/UsagePage"));
const SystemPromptPage = lazy(() => import("./components/SystemPromptPage"));
const SessionBrowser = lazy(() => import("./components/SessionBrowser"));
const SettingsPage = lazy(() => import("./components/SettingsPage"));
const SessionPanel = lazy(() => import("./components/SessionPanel"));
const TranscriptView = lazy(() => import("./components/TranscriptView"));

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
    toggleSettingsTab,
    closeTab,
    updateTab,
    markProcessing,
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

  // Close confirmation for running agent tabs
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const safeCloseTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === "agent" && tab.exitCode == null && !settingsRef.current?.skip_close_confirm) {
      setPendingCloseTabId(tabId);
    } else {
      closeTab(tabId);
    }
  }, [closeTab]);

  // Load bundled marketplace plugin paths (Figtree-exclusive by default)
  const [allPluginPaths, setAllPluginPaths] = useState<string[]>([]);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);
  useEffect(() => {
    invoke<string[]>("get_marketplace_plugins")
      .then((paths) => { setAllPluginPaths(paths); setPluginsLoaded(true); })
      .catch((e) => { console.error(e); setPluginsLoaded(true); });
  }, []);
  const pluginPaths = useMemo(() => {
    const disabled = settings?.disabled_plugins ?? [];
    if (disabled.length === 0) return allPluginPaths;
    return allPluginPaths.filter((p) => {
      const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
      return !disabled.includes(name);
    });
  }, [allPluginPaths, settings?.disabled_plugins]);

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
      appWindow.setTitle(`Figtree \u2014 ${activeTab.projectName}${suffix}`);
    } else {
      appWindow.setTitle("Figtree");
    }
  }, [activeTab.type, activeTab.projectName, terminalCount]);

  // Sync font settings to CSS custom properties so GUI inherits them
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-mono", `'${sanitizeFontName(fontFamily)}', 'Consolas', monospace`);
    root.style.setProperty("--font-chat", `'${sanitizeFontName(chatFontFamily)}', 'Segoe UI', system-ui, sans-serif`);
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
        safeCloseTab(activeTabId);
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
      } else if (e.key === "," && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleSettingsTab();
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
  }, [addTabAndResetFilter, toggleAboutTab, toggleUsageTab, toggleSystemPromptTab, toggleSessionsTab, toggleSettingsTab, updateSettings, safeCloseTab, activeTabId, nextTab, prevTab]);

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
    updateTab(tabId, { exitCode: 1 });
  }, [updateTab]);

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

  const handleConfigChange = useCallback((tabId: string, update: { modelIdx?: number; effortIdx?: number; permModeIdx?: number }) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab || tab.type !== "agent") return;
    // Perm mode changes are synced to sidecar live — no remount needed
    const needsRestart = update.modelIdx !== undefined || update.effortIdx !== undefined;
    if (needsRestart) {
      const sessionId = tab.agentSessionId;
      updateTab(tabId, {
        ...update,
        // Resume the same session so conversation history is preserved
        resumeSessionId: sessionId || undefined,
      });
    } else {
      updateTab(tabId, update);
    }
  }, [updateTab]);

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
      permModeIdx: settingsRef.current?.perm_mode_idx ?? 0, autocompact, [field]: sessionId,
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
            onClose={safeCloseTab}
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
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={safeCloseTab}
          onAdd={addTabAndResetFilter}
          onSaveToProjects={handleSaveToProjects}
          onToggleAbout={toggleAboutTab}
          onToggleUsage={toggleUsageTab}
          onToggleSessions={toggleSessionPanel}
        />
      )}
      <div className="main-row">
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
                    onOpenSettings={toggleSettingsTab}
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
                        const newId = addTab();
                        updateTab(newId, { type: "transcript", transcriptSessionId: sessionId });
                      }}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "settings" && settings ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Suspense fallback={null}>
                    <SettingsPage
                      tabId={tab.id}
                      onRequestClose={closeTab}
                      isActive={isActive}
                      settings={settings}
                      onUpdate={updateSettings}
                      allPluginPaths={allPluginPaths}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "transcript" ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Suspense fallback={null}>
                    <TranscriptView
                      sessionId={tab.transcriptSessionId!}
                      tabId={tab.id}
                      isActive={isActive}
                      onRequestClose={closeTab}
                    />
                  </Suspense>
                </ErrorBoundary>
              ) : tab.type === "agent" && pluginsLoaded ? (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <AgentView
                    key={`${tab.id}-${tab.modelIdx ?? 0}-${tab.effortIdx ?? 0}-${tab.resumeSessionId || ""}-${tab.forkSessionId || ""}`}
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
                    hideThinking={settings?.hide_thinking}
                    onProcessingChange={(p: boolean) => markProcessing(tab.id, p)}
                    plugins={pluginPaths}
                    disabledHooks={settings?.disabled_hooks ?? []}
                    resumeSessionId={tab.resumeSessionId}
                    forkSessionId={tab.forkSessionId}
                    onConfigChange={handleConfigChange}
                    sessionPanelOpen={sessionPanelOpen}
                    onCloseSessionPanel={toggleSessionPanel}
                    onResumeSession={handleResumeSession}
                    onForkSession={handleForkSession}
                  />
                </ErrorBoundary>
              ) : (
                null
              )}
            </div>
          );
        })}
      </div>
      </div>
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      {settings && !settings.onboarding_seen && (
        <OnboardingOverlay onDismiss={() => updateSettings({ onboarding_seen: true })} />
      )}
      {pendingCloseTabId && (
        <div className="confirm-overlay" onClick={() => setPendingCloseTabId(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-text">Agent is still running. Close tab and kill agent?</div>
            <label className="confirm-checkbox">
              <input type="checkbox" id="skip-close-confirm" />
              <span>Don’t ask again</span>
            </label>
            <div className="confirm-actions">
              <button className="confirm-btn confirm-btn-danger" onClick={() => { const skip = (document.getElementById("skip-close-confirm") as HTMLInputElement)?.checked; if (skip) updateSettings({ skip_close_confirm: true }); closeTab(pendingCloseTabId); setPendingCloseTabId(null); }}>Close tab</button>
              <button className="confirm-btn" onClick={() => setPendingCloseTabId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
