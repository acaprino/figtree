import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tab, PERM_MODES } from "../types";

const SESSION_SAVE_DEBOUNCE_MS = 500;

interface SavedTab {
  projectPath: string;
  projectName: string;
  modelIdx: number;
  effortIdx: number;
  permModeIdx: number;
  temporary: boolean;
}

function createNewTab(): Tab {
  return {
    id: crypto.randomUUID(),
    type: "new-tab",
    hasNewOutput: false,
    exitCode: null,
  };
}

function createRestoredTab(saved: SavedTab): Tab {
  return {
    id: crypto.randomUUID(),
    type: "agent",
    projectPath: saved.projectPath,
    projectName: saved.projectName,
    modelIdx: saved.modelIdx,
    effortIdx: saved.effortIdx,
    permModeIdx: saved.permModeIdx,
    temporary: saved.temporary || false,
    hasNewOutput: false,
    exitCode: null,
  };
}

export function useTabManager() {
  const [tabs, setTabs] = useState<Tab[]>([createNewTab()]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // Restore session on mount
  useEffect(() => {
    invoke<any>("load_session").then((session) => {
      if (session && Array.isArray(session.tabs) && session.tabs.length > 0) {
        const restoredTabs = session.tabs
          .filter((s: any) => s && typeof s.projectPath === "string" && s.projectPath.length > 0)
          .map((s: any) => createRestoredTab({
            projectPath: s.projectPath,
            projectName: typeof s.projectName === "string" ? s.projectName : "Terminal",
            modelIdx: typeof s.modelIdx === "number" ? s.modelIdx : 0,
            effortIdx: typeof s.effortIdx === "number" ? s.effortIdx : 0,
            permModeIdx: typeof s.permModeIdx === "number" ? s.permModeIdx : (s.skipPerms === true ? PERM_MODES.findIndex(m => m.sdk === "bypassPermissions") : 0),
            temporary: s.temporary === true,
          }));
        if (restoredTabs.length > 0) {
          const newTab = createNewTab();
          setTabs([...restoredTabs, newTab]);
          setActiveTabId(restoredTabs[0].id);
        }
      }
      setSessionLoaded(true);
    }).catch((err) => {
      console.debug("[tabs] session restore failed:", err);
      setSessionLoaded(true);
    });
  }, []);

  // Derive saveable state so we only persist when session-relevant data changes.
  // Use a stable key derived only from persistence-relevant fields to avoid
  // recalculating on volatile changes like hasNewOutput or exitCode.
  const saveableKey = tabs
    .filter((t) => t.type === "agent" && t.projectPath)
    .map((t) => `${t.projectPath}|${t.projectName ?? "Terminal"}|${t.modelIdx ?? 0}|${t.effortIdx ?? 0}|${t.permModeIdx ?? 0}|${t.temporary ?? false}`)
    .join("\n");

  const saveableState = useMemo(() =>
    JSON.stringify(
      tabs
        .filter((t) => t.type === "agent" && t.projectPath)
        .map((t) => ({
          projectPath: t.projectPath,
          projectName: t.projectName ?? "Terminal",
          modelIdx: t.modelIdx ?? 0,
          effortIdx: t.effortIdx ?? 0,
          permModeIdx: t.permModeIdx ?? 0,
          temporary: t.temporary ?? false,
        })),
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saveableKey],
  );

  // Save session whenever saveable state changes (debounced).
  // Also flush immediately on beforeunload so closing the window persists state.
  const saveTimerRef = useRef<number | null>(null);
  const saveableStateRef = useRef(saveableState);
  saveableStateRef.current = saveableState;
  const sessionLoadedRef = useRef(sessionLoaded);
  sessionLoadedRef.current = sessionLoaded;

  useEffect(() => {
    if (!sessionLoaded) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const terminalTabs: SavedTab[] = JSON.parse(saveableState);
      invoke("save_session", { session: { tabs: terminalTabs } }).catch((e) => console.warn("Failed to save session:", e));
    }, SESSION_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [saveableState, sessionLoaded]);

  // Flush pending save on window close so tab state is never lost
  useEffect(() => {
    const flushSave = () => {
      if (!sessionLoadedRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const terminalTabs: SavedTab[] = JSON.parse(saveableStateRef.current);
      invoke("save_session", { session: { tabs: terminalTabs } }).catch((err) => console.debug("[tabs] beforeunload session save failed:", err));
    };
    window.addEventListener("beforeunload", flushSave);
    return () => window.removeEventListener("beforeunload", flushSave);
  }, []);

  const addTab = useCallback(() => {
    const tab = createNewTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, []);

  // Factory for singleton tab toggles (about, usage, system-prompt).
  // Close if active, activate if background, create if none.
  const toggleSingletonTab = useCallback((tabType: Tab["type"]) => {
    let nextActiveId: string | null = null;
    setTabs((prev) => {
      const existing = prev.find((t) => t.type === tabType);
      if (existing) {
        if (existing.id === activeTabIdRef.current) {
          const next = prev.filter((t) => t.id !== existing.id);
          if (next.length === 0) {
            const newTab = createNewTab();
            nextActiveId = newTab.id;
            return [newTab];
          }
          const idx = prev.findIndex((t) => t.id === existing.id);
          const newIdx = Math.min(idx, next.length - 1);
          nextActiveId = next[newIdx].id;
          return next;
        }
        nextActiveId = existing.id;
        return prev;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        type: tabType,
        hasNewOutput: false,
        exitCode: null,
      };
      nextActiveId = tab.id;
      return [...prev, tab];
    });
    if (nextActiveId) setActiveTabId(nextActiveId);
  }, []);

  const toggleAboutTab = useCallback(() => toggleSingletonTab("about"), [toggleSingletonTab]);
  const toggleUsageTab = useCallback(() => toggleSingletonTab("usage"), [toggleSingletonTab]);
  const toggleSystemPromptTab = useCallback(() => toggleSingletonTab("system-prompt"), [toggleSingletonTab]);
  const toggleSessionsTab = useCallback(() => toggleSingletonTab("sessions"), [toggleSingletonTab]);

  const closeTab = useCallback(
    (tabId: string) => {
      let nextActiveId: string | null = null;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;

        const next = prev.filter((t) => t.id !== tabId);

        if (next.length === 0) {
          // Never auto-close the window — open a new-tab page instead.
          // destroy() bypasses CloseRequested and causes silent shutdown after standby.
          const newTab = createNewTab();
          nextActiveId = newTab.id;
          return [newTab];
        }

        if (tabId === activeTabIdRef.current) {
          const newIdx = Math.min(idx, next.length - 1);
          nextActiveId = next[newIdx].id;
        }

        return next;
      });
      // Set active tab outside the updater to avoid side effects in the
      // state updater (React Strict Mode double-invokes updaters).
      if (nextActiveId) setActiveTabId(nextActiveId);
    },
    [],
  );

  const updateTab = useCallback((tabId: string, updates: Partial<Tab>) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
    );
  }, []);

  // H1: Dedicated callback that guards against redundant array creation
  // when hasNewOutput is already true (high-frequency agent output path).
  const markNewOutput = useCallback((tabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target || target.hasNewOutput) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, hasNewOutput: true } : t);
    });
  }, []);

  // R6: Guard setTabs — skip array recreation if target tab has no new output
  const activateTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      setTabs((prev) => {
        const target = prev.find((t) => t.id === tabId);
        if (!target?.hasNewOutput) return prev;
        return prev.map((t) =>
          t.id === tabId ? { ...t, hasNewOutput: false } : t,
        );
      });
    },
    [],
  );

  // R7: Only update activeTabId; guard setTabs to avoid unnecessary array creation
  const nextTab = useCallback(() => {
    let nextActiveId: string | null = null;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTabIdRef.current);
      const nextIdx = (idx + 1) % prev.length;
      nextActiveId = prev[nextIdx].id;
      if (!prev[nextIdx].hasNewOutput) return prev;
      return prev.map((t) =>
        t.id === nextActiveId ? { ...t, hasNewOutput: false } : t,
      );
    });
    if (nextActiveId) setActiveTabId(nextActiveId);
  }, []);

  const prevTab = useCallback(() => {
    let nextActiveId: string | null = null;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTabIdRef.current);
      const nextIdx = (idx - 1 + prev.length) % prev.length;
      nextActiveId = prev[nextIdx].id;
      if (!prev[nextIdx].hasNewOutput) return prev;
      return prev.map((t) =>
        t.id === nextActiveId ? { ...t, hasNewOutput: false } : t,
      );
    });
    if (nextActiveId) setActiveTabId(nextActiveId);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return {
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
  };
}
