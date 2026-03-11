import { useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabManager } from "./hooks/useTabManager";
import { ProjectsProvider, useProjectsContext } from "./contexts/ProjectsContext";
import TabBar from "./components/TabBar";
import Terminal from "./components/Terminal";
import NewTabPage from "./components/NewTabPage";
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
    closeTab,
    updateTab,
    activateTab,
    nextTab,
    prevTab,
  } = useTabManager();

  const { settings } = useProjectsContext();
  const themeIdx = settings?.theme_idx ?? 0;
  const fontFamily = settings?.font_family ?? "Cascadia Code";
  const fontSize = settings?.font_size ?? 14;

  // Update window title
  useEffect(() => {
    const terminalCount = tabs.filter((t) => t.type === "terminal").length;

    if (activeTab.type === "terminal" && activeTab.projectName) {
      const suffix = terminalCount > 1 ? ` (+${terminalCount - 1} tabs)` : "";
      appWindow.setTitle(`Claude Launcher \u2014 ${activeTab.projectName}${suffix}`);
    } else {
      appWindow.setTitle("Claude Launcher");
    }
  }, [activeTab, tabs]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        addTab();
      } else if (e.ctrlKey && e.key === "F4") {
        e.preventDefault();
        closeTab(activeTabId);
      } else if (e.ctrlKey && !e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        nextTab();
      } else if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        prevTab();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTab, closeTab, activeTabId, nextTab, prevTab]);

  const handleLaunch = useCallback(
    (tabId: string, projectPath: string, projectName: string, modelIdx: number, effortIdx: number, skipPerms: boolean) => {
      updateTab(tabId, {
        type: "terminal",
        projectPath,
        projectName,
        modelIdx,
        effortIdx,
        skipPerms,
      });
    },
    [updateTab],
  );

  // Stable callbacks for Terminal — avoids re-creating closures every render
  const handleNewOutput = useCallback((tabId: string) => {
    updateTab(tabId, { hasNewOutput: true });
  }, [updateTab]);

  const handleExit = useCallback((tabId: string, code: number) => {
    updateTab(tabId, { exitCode: code });
  }, [updateTab]);

  const handleSessionCreated = useCallback((tabId: string, sessionId: string) => {
    updateTab(tabId, { sessionId });
  }, [updateTab]);

  const handleError = useCallback((tabId: string, msg: string) => {
    console.error(`Tab ${tabId} error:`, msg);
  }, []);

  const startResize = useCallback((direction: "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest") => {
    appWindow.startResizeDragging(direction);
  }, []);

  return (
    <div className="app">
      <div className="resize-handle top" onMouseDown={() => startResize("North")} />
      <div className="resize-handle bottom" onMouseDown={() => startResize("South")} />
      <div className="resize-handle left" onMouseDown={() => startResize("West")} />
      <div className="resize-handle right" onMouseDown={() => startResize("East")} />
      <div className="resize-handle top-left" onMouseDown={() => startResize("NorthWest")} />
      <div className="resize-handle top-right" onMouseDown={() => startResize("NorthEast")} />
      <div className="resize-handle bottom-left" onMouseDown={() => startResize("SouthWest")} />
      <div className="resize-handle bottom-right" onMouseDown={() => startResize("SouthEast")} />
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={closeTab}
        onAdd={addTab}
      />
      <div className="tab-content">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isTerminal = tab.type === "terminal";

          return (
            <div
              key={tab.id}
              className={`tab-panel ${isActive ? "active" : ""} ${isTerminal ? "terminal-panel" : ""}`}
              style={isTerminal ? { display: isActive ? "flex" : "none", opacity: 1, visibility: "visible" } : undefined}
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
              ) : (
                <ErrorBoundary tabId={tab.id} onClose={closeTab}>
                  <Terminal
                    tabId={tab.id}
                    projectPath={tab.projectPath!}
                    modelIdx={tab.modelIdx!}
                    effortIdx={tab.effortIdx ?? 0}
                    skipPerms={tab.skipPerms ?? false}
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
