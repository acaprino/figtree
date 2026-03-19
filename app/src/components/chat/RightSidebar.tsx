import { memo, useState, useCallback, useMemo } from "react";
import { ScrollArea } from "radix-ui";
import type { AgentTask, ChatMessage, TodoItem } from "../../types";
import { IconBookmark, IconMinimap, IconTodos, IconThinking, IconAgents } from "../Icons";
import BookmarkPanel from "./BookmarkPanel";
import MinimapPanel from "./MinimapPanel";
import TodoPanel from "./TodoPanel";
import ThinkingPanel from "./ThinkingPanel";
import AgentTreePanel from "./AgentTreePanel";
import "./RightSidebar.css";

type SidebarTab = "bookmarks" | "minimap" | "todos" | "thinking" | "agents";

const RS_MIN = 150;
const RS_MAX = 400;

const SIDEBAR_TABS: { id: SidebarTab; icon: React.ReactNode; title: string }[] = [
  { id: "bookmarks", icon: <IconBookmark />, title: "Bookmarks" },
  { id: "minimap", icon: <IconMinimap />, title: "Minimap" },
  { id: "todos", icon: <IconTodos />, title: "Todos" },
  { id: "thinking", icon: <IconThinking />, title: "Thinking" },
  { id: "agents", icon: <IconAgents />, title: "Agents" },
];

interface Props {
  messages: ChatMessage[];
  agentTasks: AgentTask[];
  onScrollToMessage: (msgId: string) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export default memo(function RightSidebar({ messages, agentTasks, onScrollToMessage, scrollContainerRef }: Props) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("bookmarks");

  const todoCount = useMemo(() => {
    const todoMessages = messages.filter((m) => m.role === "todo");
    const latestTodo = todoMessages[todoMessages.length - 1];
    const todos = (latestTodo?.role === "todo" ? latestTodo.todos : []) as TodoItem[];
    return todos.filter((t) => t.status !== "completed").length;
  }, [messages]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--right-sidebar-width")) || 220;

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // inverted: dragging left = wider
      const newWidth = Math.max(RS_MIN, Math.min(RS_MAX, startWidth + delta));
      document.documentElement.style.setProperty("--right-sidebar-width", `${newWidth}px`);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="right-sidebar">
      <div className="right-sidebar__resize" onMouseDown={handleResizeStart} />
      <div className="right-sidebar-tabs" role="tablist" aria-label="Sidebar panels">
        {SIDEBAR_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-label={tab.title}
            className={`right-sidebar-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.title}
          >
            {tab.icon}
            {tab.id === "todos" && todoCount > 0 && (
              <span key={todoCount} className="sidebar-tab-badge">{todoCount}</span>
            )}
          </button>
        ))}
      </div>
      <ScrollArea.Root className="right-sidebar-content">
        <ScrollArea.Viewport className="right-sidebar-viewport">
          {activeTab === "bookmarks" && (
            <BookmarkPanel messages={messages} onScrollToMessage={onScrollToMessage} />
          )}
          {activeTab === "minimap" && scrollContainerRef && (
            <MinimapPanel messages={messages} scrollContainerRef={scrollContainerRef} />
          )}
          {activeTab === "todos" && (
            <TodoPanel messages={messages} />
          )}
          {activeTab === "thinking" && (
            <ThinkingPanel messages={messages} />
          )}
          {activeTab === "agents" && (
            <AgentTreePanel tasks={agentTasks} />
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="scroll-area-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="scroll-area-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
});
