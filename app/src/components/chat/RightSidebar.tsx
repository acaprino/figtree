import { memo, useState } from "react";
import type { ChatMessage } from "../../types";
import BookmarkPanel from "./BookmarkPanel";
import MinimapPanel from "./MinimapPanel";
import TodoPanel from "./TodoPanel";
import ThinkingPanel from "./ThinkingPanel";
import "./RightSidebar.css";

type SidebarTab = "bookmarks" | "minimap" | "todos" | "thinking";

interface Props {
  messages: ChatMessage[];
  onScrollToMessage: (msgId: string) => void;
}

export default memo(function RightSidebar({ messages, onScrollToMessage }: Props) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("bookmarks");

  const tabs: { id: SidebarTab; icon: string; title: string }[] = [
    { id: "bookmarks", icon: "bm", title: "Bookmarks" },
    { id: "minimap", icon: "mm", title: "Minimap" },
    { id: "todos", icon: "td", title: "Todos" },
    { id: "thinking", icon: "th", title: "Thinking" },
  ];

  return (
    <div className="right-sidebar">
      <div className="right-sidebar-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`right-sidebar-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.title}
          >
            {tab.icon}
          </button>
        ))}
      </div>
      <div className="right-sidebar-content">
        {activeTab === "bookmarks" && (
          <BookmarkPanel messages={messages} onScrollToMessage={onScrollToMessage} />
        )}
        {activeTab === "minimap" && (
          <MinimapPanel messages={messages} onScrollToMessage={onScrollToMessage} />
        )}
        {activeTab === "todos" && (
          <TodoPanel messages={messages} />
        )}
        {activeTab === "thinking" && (
          <ThinkingPanel messages={messages} />
        )}
      </div>
    </div>
  );
});
