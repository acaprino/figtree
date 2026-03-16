import { memo, useState, useEffect, useRef, useMemo } from "react";
import type { AgentInfoSDK } from "../../types";

export interface Mention {
  name: string;
  display: string;
}

interface Props {
  filter: string;
  agents?: AgentInfoSDK[];
  onSelect: (mention: Mention) => void;
  onDismiss: () => void;
}

export default memo(function MentionMenu({ filter, agents = [], onSelect, onDismiss }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const options: Mention[] = agents.map((a) => ({
      name: `@${a.name}`,
      display: a.description,
    }));
    const lf = filter.toLowerCase();
    return options.filter(
      (m) => m.name.toLowerCase().includes(lf) || m.display.toLowerCase().includes(lf),
    );
  }, [agents, filter]);

  useEffect(() => { setSelectedIdx(0); }, [filter]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        onSelect(filtered[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [filtered, selectedIdx, onSelect, onDismiss]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (filtered.length === 0) return null;

  return (
    <div className="command-menu" ref={listRef}>
      {filtered.map((m, i) => (
        <div
          key={m.name}
          className={`command-item${i === selectedIdx ? " selected" : ""}`}
          onClick={() => onSelect(m)}
          onMouseEnter={() => setSelectedIdx(i)}
        >
          <span className="command-name">{m.name}</span>
          <span className="command-desc">{m.display}</span>
        </div>
      ))}
    </div>
  );
});
