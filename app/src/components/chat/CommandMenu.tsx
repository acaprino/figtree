import { memo, useState, useEffect, useRef, useMemo } from "react";
import type { SlashCommand } from "../../types";

export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
  source: "local" | "skill";
}

const LOCAL_COMMANDS: Command[] = [
  { name: "/clear", description: "Clear chat messages", source: "local" },
  { name: "/compact", description: "Summarize conversation", source: "local" },
  { name: "/sidebar", description: "Toggle right sidebar", source: "local" },
  { name: "/theme", description: "Change theme", source: "local" },
  { name: "/sessions", description: "Browse sessions", source: "local" },
  { name: "/help", description: "Show help", source: "local" },
];

/** Names of local commands, for collision filtering. */
const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((c) => c.name));

interface Props {
  filter: string;
  sdkCommands?: SlashCommand[];
  onSelect: (command: Command) => void;
  onDismiss: () => void;
}

export default memo(function CommandMenu({ filter, sdkCommands = [], onSelect, onDismiss }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState(240);

  const lowerFilter = filter.toLowerCase();

  // Memoize merged + filtered lists to stabilize useEffect deps
  const { filteredLocal, filteredSdk, selectableItems } = useMemo(() => {
    const sdkMapped: Command[] = sdkCommands
      .filter((c) => !LOCAL_NAMES.has("/" + c.name))
      .reduce<Command[]>((acc, c) => {
        const name = "/" + c.name;
        if (!acc.some((x) => x.name === name)) {
          acc.push({ name, description: c.description, argumentHint: c.argumentHint || undefined, source: "skill" });
        }
        return acc;
      }, []);

    const local = LOCAL_COMMANDS.filter(
      (c) => c.name.toLowerCase().includes(lowerFilter) || c.description.toLowerCase().includes(lowerFilter),
    );
    const sdk = sdkMapped.filter(
      (c) => c.name.toLowerCase().includes(lowerFilter) || c.description.toLowerCase().includes(lowerFilter),
    );

    return { filteredLocal: local, filteredSdk: sdk, selectableItems: [...local, ...sdk] };
  }, [sdkCommands, lowerFilter]);

  useEffect(() => { setSelectedIdx(0); }, [filter]);

  // Clamp max-height so the menu never overflows the viewport top
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    // Available space above the wrapper, minus some padding
    const available = parentRect.top - 8;
    setMaxH(Math.max(120, Math.min(available, 400)));
  }, [selectableItems.length]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, selectableItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && selectableItems.length > 0) {
        e.preventDefault();
        onSelect(selectableItems[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [selectableItems, selectedIdx, onSelect, onDismiss]);

  useEffect(() => {
    const el = listRef.current?.querySelector(".command-item.selected") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (selectableItems.length === 0) return null;

  // SDK items start at this offset in selectableItems
  const sdkOffset = filteredLocal.length;

  return (
    <div className="command-menu" ref={listRef} style={{ maxHeight: maxH }} role="listbox" aria-label="Commands">
      {filteredLocal.length > 0 && (
        <>
          <div className="command-section-header">
            <span className="rule" />
            <span>Anvil</span>
            <span className="rule" />
          </div>
          {filteredLocal.map((cmd, i) => (
            <div
              key={cmd.name}
              className={`command-item${i === selectedIdx ? " selected" : ""}`}
              role="option"
              aria-selected={i === selectedIdx}
              onClick={() => onSelect(cmd)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className="command-item-indicator">&gt;</span>
              <span className="command-name">{cmd.name}</span>
              <span className="command-desc">{cmd.description}</span>
            </div>
          ))}
        </>
      )}
      {filteredSdk.length > 0 && (
        <>
          <div className="command-section-header">
            <span className="rule" />
            <span>Skills</span>
            <span className="rule" />
          </div>
          {filteredSdk.map((cmd, i) => {
            const idx = sdkOffset + i;
            return (
              <div
                key={cmd.name}
                className={`command-item${idx === selectedIdx ? " selected" : ""}`}
                role="option"
                aria-selected={idx === selectedIdx}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="command-item-indicator">&gt;</span>
                <span className="command-name">{cmd.name}</span>
                <span className="command-desc">
                  {cmd.description}
                  {cmd.argumentHint && <span className="command-arg-hint"> {cmd.argumentHint}</span>}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
});
