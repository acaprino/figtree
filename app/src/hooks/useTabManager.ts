import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tab } from "../types";

const SESSION_SAVE_DEBOUNCE_MS = 500;

interface SavedTab {
  projectPath: string;
  projectName: string;
  toolIdx: number;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
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
    type: "terminal",
    projectPath: saved.projectPath,
    projectName: saved.projectName,
    toolIdx: saved.toolIdx,
    modelIdx: saved.modelIdx,
    effortIdx: saved.effortIdx,
    skipPerms: saved.skipPerms,
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
            toolIdx: typeof s.toolIdx === "number" ? s.toolIdx : 0,
            modelIdx: typeof s.modelIdx === "number" ? s.modelIdx : 0,
            effortIdx: typeof s.effortIdx === "number" ? s.effortIdx : 0,
            skipPerms: s.skipPerms === true,
          }));
        if (restoredTabs.length > 0) {
          const newTab = createNewTab();
          setTabs([...restoredTabs, newTab]);
          setActiveTabId(restoredTabs[0].id);
        }
      }
      setSessionLoaded(true);
    }).catch(() => {
      setSessionLoaded(true);
    });
  }, []);

  // Derive saveable state so we only persist when session-relevant data changes.
  // Use a stable key derived only from persistence-relevant fields to avoid
  // recalculating on volatile changes like hasNewOutput or exitCode.
  const saveableKey = tabs
    .filter((t) => t.type === "terminal" && t.projectPath)
    .map((t) => `${t.projectPath}|${t.projectName ?? "Terminal"}|${t.toolIdx ?? 0}|${t.modelIdx ?? 0}|${t.effortIdx ?? 0}|${t.skipPerms ?? false}`)
    .join("\n");

  const saveableState = useMemo(() =>
    JSON.stringify(
      tabs
        .filter((t) => t.type === "terminal" && t.projectPath)
        .map((t) => ({
          projectPath: t.projectPath,
          projectName: t.projectName ?? "Terminal",
          toolIdx: t.toolIdx ?? 0,
          modelIdx: t.modelIdx ?? 0,
          effortIdx: t.effortIdx ?? 0,
          skipPerms: t.skipPerms ?? false,
        })),
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saveableKey],
  );

  // Save session whenever saveable state changes (debounced)
  const saveTimerRef = useRef<number | null>(null);
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

  const addTab = useCallback(() => {
    const tab = createNewTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, []);

  // Factory for singleton tab toggles (about, usage, system-prompt).
  // Close if active, activate if background, create if none.
  const toggleSingletonTab = useCallback((tabType: Tab["type"]) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.type === tabType);
      if (existing) {
        if (existing.id === activeTabIdRef.current) {
          const next = prev.filter((t) => t.id !== existing.id);
          if (next.length === 0) {
            const newTab = createNewTab();
            setActiveTabId(newTab.id);
            return [newTab];
          }
          const idx = prev.findIndex((t) => t.id === existing.id);
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
          return next;
        }
        setActiveTabId(existing.id);
        return prev;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        type: tabType,
        hasNewOutput: false,
        exitCode: null,
      };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const toggleAboutTab = useCallback(() => toggleSingletonTab("about"), [toggleSingletonTab]);
  const toggleUsageTab = useCallback(() => toggleSingletonTab("usage"), [toggleSingletonTab]);
  const toggleSystemPromptTab = useCallback(() => toggleSingletonTab("system-prompt"), [toggleSingletonTab]);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;

        const next = prev.filter((t) => t.id !== tabId);

        if (next.length === 0) {
          // Never auto-close the window — open a new-tab page instead.
          // destroy() bypasses CloseRequested and causes silent shutdown after standby.
          const newTab = createNewTab();
          setActiveTabId(newTab.id);
          return [newTab];
        }

        if (tabId === activeTabIdRef.current) {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
        }

        return next;
      });
    },
    [],
  );

  const updateTab = useCallback((tabId: string, updates: Partial<Tab>) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
    );
  }, []);

  // H1: Dedicated callback that guards against redundant array creation
  // when hasNewOutput is already true (high-frequency PTY output path).
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
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTabIdRef.current);
      const nextIdx = (idx + 1) % prev.length;
      const nextId = prev[nextIdx].id;
      setActiveTabId(nextId);
      if (!prev[nextIdx].hasNewOutput) return prev;
      return prev.map((t) =>
        t.id === nextId ? { ...t, hasNewOutput: false } : t,
      );
    });
  }, []);

  const prevTab = useCallback(() => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTabIdRef.current);
      const nextIdx = (idx - 1 + prev.length) % prev.length;
      const nextId = prev[nextIdx].id;
      setActiveTabId(nextId);
      if (!prev[nextIdx].hasNewOutput) return prev;
      return prev.map((t) =>
        t.id === nextId ? { ...t, hasNewOutput: false } : t,
      );
    });
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
    closeTab,
    updateTab,
    markNewOutput,
    activateTab,
    nextTab,
    prevTab,
  };
}
