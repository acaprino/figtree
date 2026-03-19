import { open as shellOpen } from "@tauri-apps/plugin-shell";

// Match Windows absolute paths (D:\..., D:/...) only — no relative paths (too many false positives)
// Excludes colons from the character class to prevent NTFS ADS matches
const PATH_RE = /(?:[A-Za-z]:[/\\])[\w./\\@-]+/g;

// Block executable/script extensions from being opened via shellOpen
const DANGEROUS_EXT = /\.(exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|msi|scr|pif|hta|cpl|inf|reg|lnk)$/i;

// Block paths with traversal components
const HAS_TRAVERSAL = /(?:^|[/\\])\.\.[/\\]/;

function handlePathClick(e: React.MouseEvent, path: string) {
  e.preventDefault();
  e.stopPropagation();
  if (DANGEROUS_EXT.test(path)) {
    console.warn("[linkify] blocked opening executable path:", path);
    return;
  }
  if (HAS_TRAVERSAL.test(path)) {
    console.warn("[linkify] blocked path with traversal:", path);
    return;
  }
  shellOpen(path).catch((err) => console.debug("[linkify] open failed:", err));
}

/** Split text into segments, wrapping file paths in clickable spans */
export function linkifyPaths(text: string, keyPrefix = ""): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(PATH_RE.source, "g"); // fresh instance per call
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const path = match[0];
    parts.push(
      <span
        key={`${keyPrefix}p${match.index}`}
        className="tv-path-link"
        title={`Open ${path}`}
        onClick={(e) => handlePathClick(e, path)}
      >
        {path}
      </span>
    );
    last = match.index + match[0].length;
  }
  if (last === 0) return [text]; // no paths found — return original string
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
