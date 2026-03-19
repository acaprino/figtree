import { useState, useEffect, useRef, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FolderTree.css";

interface DirEntry {
  name: string;
  path: string;
  has_children: boolean;
}

interface TreeNodeState {
  expanded: boolean;
  children: DirEntry[] | null;
  loading: boolean;
}

const INDENT_PX = 16;
const BASE_INDENT_PX = 4;
const MAX_DEPTH = 20;

/** Build the chain of ancestor paths for a Windows path.
 *  e.g. "D:\Projects\foo" -> ["D:\", "D:\Projects", "D:\Projects\foo"] */
function ancestorPaths(p: string): string[] {
  if (!p) return [];
  const parts: string[] = [];
  const driveMatch = p.match(/^[a-zA-Z]:\\/);
  if (!driveMatch) return [];
  parts.push(driveMatch[0]);
  const rest = p.slice(driveMatch[0].length);
  if (!rest) return parts;
  const segments = rest.split("\\").filter(Boolean);
  let current = driveMatch[0];
  for (const seg of segments) {
    current = current + (current.endsWith("\\") ? "" : "\\") + seg;
    parts.push(current);
  }
  return parts;
}

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  nodes: Record<string, TreeNodeState>;
  selected: string;
  onSelect: (path: string) => void;
  toggleNode: (entry: DirEntry) => void;
  handleKeyDown: (e: React.KeyboardEvent, entry: DirEntry) => void;
}

const TreeNode = memo(function TreeNode({
  entry,
  depth,
  nodes,
  selected,
  onSelect,
  toggleNode,
  handleKeyDown,
}: TreeNodeProps) {
  if (depth >= MAX_DEPTH) return null;
  const node = nodes[entry.path];
  const isExpanded = node?.expanded ?? false;
  const isSelected = selected === entry.path;
  const hasChildren = node?.children ? node.children.length > 0 : entry.has_children;

  return (
    <div>
      <div
        className={`folder-tree-item${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: depth * INDENT_PX + BASE_INDENT_PX }}
        onClick={() => onSelect(entry.path)}
        onDoubleClick={() => {
          if (hasChildren) toggleNode(entry);
        }}
        onKeyDown={(e) => handleKeyDown(e, entry)}
        tabIndex={0}
      >
        <span
          className={`folder-tree-arrow${hasChildren ? "" : " hidden"}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleNode(entry);
          }}
        >
          {isExpanded ? "\u25BE" : "\u25B8"}
        </span>
        <span className="folder-tree-name">{entry.name}</span>
      </div>
      {isExpanded && node?.loading && (
        <div
          className="folder-tree-item loading"
          style={{ paddingLeft: (depth + 1) * INDENT_PX + BASE_INDENT_PX }}
        >
          Loading...
        </div>
      )}
      {isExpanded &&
        node?.children?.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            nodes={nodes}
            selected={selected}
            onSelect={onSelect}
            toggleNode={toggleNode}
            handleKeyDown={handleKeyDown}
          />
        ))}
    </div>
  );
});

const FolderTree = memo(function FolderTree({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [nodes, setNodes] = useState<Record<string, TreeNodeState>>({});
  const [error, setError] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const initialExpandDone = useRef(false);

  useEffect(() => {
    invoke<DirEntry[]>("list_directory", { path: null })
      .then(setRoots)
      .catch((e) => setError(`Failed to load drives: ${e}`));
  }, []);

  // Auto-expand to the initially selected path so the user sees it in the tree
  useEffect(() => {
    if (initialExpandDone.current || roots.length === 0 || !selected) return;
    initialExpandDone.current = true;
    const ancestors = ancestorPaths(selected);
    if (ancestors.length === 0) return;
    (async () => {
      for (const ancestor of ancestors.slice(0, -1)) {
        try {
          const children = await invoke<DirEntry[]>("list_directory", { path: ancestor });
          setNodes((prev) => ({
            ...prev,
            [ancestor]: { expanded: true, children, loading: false },
          }));
        } catch (err) {
          console.debug("[FolderTree] auto-expand failed for ancestor:", ancestor, err);
          break;
        }
      }
    })();
  }, [roots, selected]);

  const toggleNode = useCallback(async (entry: DirEntry) => {
    const existing = nodesRef.current[entry.path];
    if (existing?.expanded) {
      setNodes((prev) => ({
        ...prev,
        [entry.path]: { ...prev[entry.path], expanded: false },
      }));
      return;
    }

    if (existing?.children) {
      setNodes((prev) => ({
        ...prev,
        [entry.path]: { ...prev[entry.path], expanded: true },
      }));
      return;
    }

    setNodes((prev) => ({
      ...prev,
      [entry.path]: { expanded: true, children: null, loading: true },
    }));

    try {
      const children = await invoke<DirEntry[]>("list_directory", {
        path: entry.path,
      });
      setNodes((prev) => ({
        ...prev,
        [entry.path]: { expanded: true, children, loading: false },
      }));
    } catch (e) {
      console.warn("Failed to list directory:", entry.path, e);
      setNodes((prev) => ({
        ...prev,
        [entry.path]: { expanded: true, children: [], loading: false },
      }));
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, entry: DirEntry) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(entry.path);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (entry.has_children && !nodesRef.current[entry.path]?.expanded) toggleNode(entry);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const node = nodesRef.current[entry.path];
        if (node?.expanded) {
          setNodes((prev) => ({
            ...prev,
            [entry.path]: { ...prev[entry.path], expanded: false },
          }));
        }
      }
    },
    [onSelect, toggleNode],
  );

  if (error) {
    return <div className="folder-tree-error">{error}</div>;
  }

  return (
    <div className="folder-tree">
      {roots.map((r) => (
        <TreeNode
          key={r.path}
          entry={r}
          depth={0}
          nodes={nodes}
          selected={selected}
          onSelect={onSelect}
          toggleNode={toggleNode}
          handleKeyDown={handleKeyDown}
        />
      ))}
    </div>
  );
});

export default FolderTree;
