import { useEffect, useCallback, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabManager } from "./hooks/useTabManager";
import { ProjectsProvider, useProjectsContext } from "./contexts/ProjectsContext";
import TabBar from "./components/TabBar";
import Terminal from "./components/Terminal";
import NewTabPage from "./components/NewTabPage";
import AboutPage from "./components/AboutPage";
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
    closeTab,
    updateTab,
    markNewOutput,
    activateTab,
    nextTab,
    prevTab,
  } = useTabManager();

  const { settings, setFilter } = useProjectsContext();
  const themeIdx = settings?.theme_idx ?? 0;
  const fontFamily = settings?.font_family ?? "Cascadia Code";
  const fontSize = settings?.font_size ?? 14;

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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTabAndResetFilter, toggleAboutTab, closeTab, activeTabId, nextTab, prevTab]);

  const handleLaunch = useCallback(
    (tabId: string, projectPath: string, projectName: string, toolIdx: number, modelIdx: number, effortIdx: number, skipPerms: boolean, autocompact: boolean) => {
      updateTab(tabId, {
        type: "terminal",
        projectPath,
        projectName,
        toolIdx,
        modelIdx,
        effortIdx,
        skipPerms,
        autocompact,
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
