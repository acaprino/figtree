import { memo, useEffect, useMemo, useRef, useCallback } from "react";
import type { ChatMessage } from "../../types";

interface Props {
  messages: ChatMessage[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function roleColor(role: string): string {
  switch (role) {
    case "user": return "var(--accent)";
    case "assistant": return "var(--text-dim)";
    case "tool": return "var(--yellow)";
    case "permission": return "var(--yellow)";
    case "thinking": return "var(--overlay0)";
    case "result": return "var(--green)";
    case "error": return "var(--red)";
    default: return "var(--overlay0)";
  }
}

function extractText(msg: ChatMessage): string {
  if (msg.role === "user") return msg.text;
  if (msg.role === "assistant") return msg.text;
  if (msg.role === "thinking") return msg.text;
  if (msg.role === "tool") return `$ ${msg.tool}`;
  if (msg.role === "error") return `error: ${msg.message}`;
  if (msg.role === "result") return "───";
  if (msg.role === "status") return `[${msg.status}]`;
  return "";
}

export default memo(function MinimapPanel({ messages, scrollContainerRef }: Props) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  // Sync viewport indicator with scroll position
  const syncViewport = useCallback(() => {
    const container = scrollContainerRef.current;
    const minimap = minimapRef.current;
    const viewport = viewportRef.current;
    if (!container || !minimap || !viewport) return;

    const scrollRatio = container.scrollTop / (container.scrollHeight || 1);
    const visibleRatio = container.clientHeight / (container.scrollHeight || 1);
    const minimapHeight = minimap.scrollHeight;

    viewport.style.top = `${scrollRatio * minimapHeight}px`;
    viewport.style.height = `${Math.max(visibleRatio * minimapHeight, 12)}px`;
  }, [scrollContainerRef]);

  // Listen to scroll events
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    syncViewport();
    container.addEventListener("scroll", syncViewport, { passive: true });
    return () => container.removeEventListener("scroll", syncViewport);
  }, [scrollContainerRef, syncViewport, messages]);

  // Click to scroll
  const handleClick = useCallback((e: React.MouseEvent) => {
    const minimap = minimapRef.current;
    const container = scrollContainerRef.current;
    if (!minimap || !container) return;

    const rect = minimap.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / (minimap.scrollHeight || 1);
    container.scrollTop = clickRatio * container.scrollHeight - container.clientHeight / 2;
  }, [scrollContainerRef]);

  // Drag viewport
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;

    const minimap = minimapRef.current;
    const container = scrollContainerRef.current;
    if (!minimap || !container) return;

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const rect = minimap.getBoundingClientRect();
      const ratio = (ev.clientY - rect.top) / (minimap.scrollHeight || 1);
      container.scrollTop = ratio * container.scrollHeight - container.clientHeight / 2;
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [scrollContainerRef]);

  const filtered = useMemo(() => {
    const items = messages.filter(m => m.role !== "status");
    // Limit to last 200 messages and cap text length for DOM performance
    return items.slice(-200);
  }, [messages]);

  if (filtered.length === 0) {
    return <div className="sidebar-empty"><span className="sidebar-empty-icon">{"\u2592"}</span>No messages yet</div>;
  }

  return (
    <div className="minimap-panel-sublime" ref={minimapRef} onClick={handleClick}>
      <div className="minimap-viewport" ref={viewportRef} onMouseDown={handleMouseDown} />
      {filtered.map((msg) => {
        const text = extractText(msg);
        if (!text) return null;
        return (
          <div
            key={msg.id}
            className="minimap-text-block"
            style={{ color: roleColor(msg.role) }}
          >
            {text.length > 80 ? text.slice(0, 80) : text}
          </div>
        );
      })}
    </div>
  );
});
