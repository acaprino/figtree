# UX Improvements Implementation Plan

> **For agentic workers:** Use subagent-driven execution (if subagents available) or ai-tooling:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 8 UX improvements identified in the app analysis: diff viewer, session transcript viewer, search within sessions, export sessions, status indicator, undo for destructive actions, onboarding first-run, and project templates.

**Architecture:** Each feature is self-contained and can be shipped independently. Features are ordered by impact and dependency — diff viewer first (highest value, zero new deps), then incremental improvements. No new npm dependencies needed — all features use existing libraries (react-syntax-highlighter for diffs, Tauri dialog for exports) or are pure React.

**Tech Stack:** React 19, TypeScript 5, Tauri 2 (dialog plugin), react-syntax-highlighter (already installed), CSS custom properties.

**Note:** Anvil has no test framework — verification is manual via `cargo tauri dev`.

---

## Chunk 1: Diff Viewer

### Context

When the agent uses Edit or Write tools, the `tool_use` input already contains the diff data:
- **Edit**: `{ file_path, old_string, new_string }` — a perfect unified diff source
- **Write**: `{ file_path, content }` — full file content (show as new file)

Currently ToolCard renders this as raw JSON in a `<pre>` block. We'll add a `DiffView` component that renders a syntax-highlighted unified diff with line-by-line coloring.

The diff viewer is **frontend-only** — no sidecar or Rust changes needed.

### Task 1: Create DiffView component

**Files:**
- Create: `app/src/components/chat/DiffView.tsx`
- Create: `app/src/components/chat/DiffView.css`

- [ ] **Step 1: Create DiffView.tsx**

This component receives Edit/Write tool input and renders a colored diff view.

```tsx
import { memo, useMemo } from "react";
import "./DiffView.css";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface WriteInput {
  file_path: string;
  content: string;
}

interface Props {
  tool: "Edit" | "Write";
  input: EditInput | WriteInput;
}

/** Build unified-diff lines from Edit or Write input. */
function buildDiffLines(tool: string, input: EditInput | WriteInput): string[] {
  const lines: string[] = [];
  const filePath = input.file_path;

  if (tool === "Edit") {
    const { old_string, new_string } = input as EditInput;
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);
    lines.push("@@ @@");
    for (const line of old_string.split("\n")) {
      lines.push(`-${line}`);
    }
    for (const line of new_string.split("\n")) {
      lines.push(`+${line}`);
    }
  } else {
    // Write = new file
    lines.push(`--- /dev/null`);
    lines.push(`+++ b/${filePath}`);
    lines.push("@@ @@");
    for (const line of (input as WriteInput).content.split("\n")) {
      lines.push(`+${line}`);
    }
  }
  return lines;
}

export default memo(function DiffView({ tool, input }: Props) {
  const diffLines = useMemo(() => buildDiffLines(tool, input), [tool, input]);

  return (
    <div className="diff-view">
      <div className="diff-header">{input.file_path}</div>
      <pre className="diff-body">
        {diffLines.map((line, i) => {
          const type = line.startsWith("+++") || line.startsWith("---") ? "meta"
            : line.startsWith("@@") ? "hunk"
            : line.startsWith("+") ? "add"
            : line.startsWith("-") ? "del"
            : "ctx";
          return (
            <div key={i} className={`diff-line diff-${type}`}>
              <span className="diff-gutter">
                {type === "add" ? "+" : type === "del" ? "-" : " "}
              </span>
              <span className="diff-text">{type === "add" || type === "del" ? line.slice(1) : line}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
});
```

- [ ] **Step 2: Create DiffView.css**

```css
/* ── Diff Viewer ────────────────────────────────────────────────── */
.diff-view {
  border-radius: var(--radius-sm);
  overflow: hidden;
  font-size: var(--text-xs);
  font-family: var(--font-mono);
}

.diff-header {
  padding: var(--space-1) var(--space-2);
  color: var(--text-dim);
  font-size: var(--text-xs);
  border-bottom: 1px solid color-mix(in srgb, var(--overlay0) 20%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-body {
  margin: 0;
  padding: 0;
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
}

.diff-body::-webkit-scrollbar { width: 4px; height: 4px; }
.diff-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--overlay0) 30%, transparent);
}

.diff-line {
  display: flex;
  line-height: 1.5;
  padding: 0 var(--space-2);
}

.diff-gutter {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  user-select: none;
  opacity: 0.5;
}

.diff-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
  min-width: 0;
}

.diff-meta { color: var(--text-dim); font-weight: 600; }
.diff-hunk { color: var(--accent); opacity: 0.6; }
.diff-add { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--green); }
.diff-del { background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); }
.diff-ctx { color: var(--text-dim); }
```

- [ ] **Step 3: Commit DiffView component**

```bash
git add app/src/components/chat/DiffView.tsx app/src/components/chat/DiffView.css
git commit -m "feat: add DiffView component for inline file diff rendering"
```

### Task 2: Integrate DiffView into ToolCard

**Files:**
- Modify: `app/src/components/chat/ToolCard.tsx`

- [ ] **Step 1: Update ToolCard to render DiffView for Edit/Write tools**

In `ToolCard.tsx`, import DiffView and detect when the tool is Edit or Write. When expanded, show DiffView instead of raw JSON for the input. Keep the raw JSON available via a toggle for debugging.

Changes to `ToolCard.tsx`:
1. Import DiffView
2. Detect `isDiffTool` when tool is "Edit" or "Write"
3. When expanded and isDiffTool, render `<DiffView>` instead of `<pre>{inputStr}</pre>`
4. Keep `output` rendering as-is (tool result text)

```tsx
import DiffView from "./DiffView";

// Inside the component, after existing logic:
const isDiffTool = tool === "Edit" || tool === "Write";

// In the Collapsible.Content, replace the input <pre> conditionally:
{isDiffTool
  ? <DiffView tool={tool as "Edit" | "Write"} input={input as any} />
  : <pre className="tool-card-input">{inputStr}</pre>
}
```

- [ ] **Step 2: Verify manually**

Run `cargo tauri dev`, start an agent session, ask it to edit a file. Verify:
- Edit tool shows colored diff (red for removed, green for added)
- Write tool shows all-green (new file)
- Other tools (Bash, Read, Glob, Grep) still show raw JSON
- Collapsed view still shows preview text as before

- [ ] **Step 3: Commit integration**

```bash
git add app/src/components/chat/ToolCard.tsx
git commit -m "feat: render inline diff view for Edit/Write tools in ToolCard"
```

---

## Chunk 2: Session Transcript Viewer

### Context

`SessionBrowser.tsx` has an `onViewSession` callback that currently does nothing (TODO). We need to:
1. Add a Rust command to read a session's JSONL file and parse it into displayable messages
2. Create a read-only `TranscriptView` component
3. Wire it up as a new tab type

### Task 3: Add Rust command to read session transcript

**Files:**
- Modify: `app/src-tauri/src/commands.rs` — add `read_session_transcript` command
- Modify: `app/src-tauri/src/main.rs` — register command

- [ ] **Step 1: Add `read_session_transcript` command**

The command reads a session's JSONL file from `~/.claude/projects/<project>/sessions/<id>.jsonl`, parses each line, and extracts human-readable messages (user prompts, assistant text, tool calls, results).

Return type: `Vec<TranscriptEntry>` where:
```rust
#[derive(Serialize)]
struct TranscriptEntry {
    role: String,       // "user" | "assistant" | "tool" | "result"
    text: String,       // Message content or tool summary
    tool: Option<String>,
    timestamp: Option<u64>,
}
```

Parse the JSONL: each line is a JSON object. Look for:
- `type: "human"` → role: "user", text from `message.content`
- `type: "assistant"` → role: "assistant", text from text blocks in `message.content`
- `type: "tool_use"` blocks → role: "tool", tool name + input summary
- `type: "result"` → role: "result", extract cost/tokens summary

- [ ] **Step 2: Register in main.rs**

Add `commands::read_session_transcript` to the `.invoke_handler(tauri::generate_handler![...])` list.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/main.rs
git commit -m "feat: add read_session_transcript Rust command"
```

### Task 4: Create TranscriptView component

**Files:**
- Create: `app/src/components/TranscriptView.tsx`
- Create: `app/src/components/TranscriptView.css`

- [ ] **Step 1: Create TranscriptView**

A read-only scrollable view that displays session messages. Uses `@tanstack/react-virtual` for performance. Calls `read_session_transcript` on mount.

- [ ] **Step 2: Create TranscriptView.css**

Minimal styling — reuse existing `.msg-bubble`, `.tool-card` classes where possible.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TranscriptView.tsx app/src/components/TranscriptView.css
git commit -m "feat: add TranscriptView component for viewing session transcripts"
```

### Task 5: Wire transcript into tab system

**Files:**
- Modify: `app/src/types.ts` — add `"transcript"` to Tab type union
- Modify: `app/src/components/ChatView.tsx` or `App.tsx` — render TranscriptView for transcript tabs
- Modify: `app/src/components/SessionBrowser.tsx` — wire `onViewSession` to open transcript tab

- [ ] **Step 1: Add transcript tab type**

In `types.ts`, add `"transcript"` to the Tab `type` union and add `transcriptSessionId?: string` field.

- [ ] **Step 2: Wire SessionBrowser to open transcript tabs**

When user clicks "View" on a session, create a new tab of type `"transcript"` with the session ID.

- [ ] **Step 3: Render TranscriptView in App.tsx**

In the tab content switch, add case for `"transcript"` that renders `<TranscriptView sessionId={tab.transcriptSessionId} />`.

- [ ] **Step 4: Commit**

```bash
git add app/src/types.ts app/src/components/SessionBrowser.tsx app/src/App.tsx
git commit -m "feat: wire session transcript viewer into tab system"
```

---

## Chunk 3: Search Within Sessions

### Task 6: Add search bar to ChatView

**Files:**
- Modify: `app/src/components/ChatView.tsx` — add search state, Ctrl+F handler, filter/highlight logic
- Modify: `app/src/components/ChatView.css` — search bar styling

- [ ] **Step 1: Add search state and Ctrl+F handler**

Add a `searchQuery` state, a floating search bar that appears on Ctrl+F, and filter `displayItems` to highlight matches. Use `scrollToIndex` on the virtualizer to jump between matches.

Key behavior:
- Ctrl+F toggles search bar (auto-focus input)
- Esc closes search bar
- Enter/Shift+Enter navigates between matches
- Match count shown ("3 of 12")
- Matches highlighted with `<mark>` in MessageBubble and ToolCard text

- [ ] **Step 2: Add search bar CSS**

Floating bar at top of chat area, similar to browser Ctrl+F.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ChatView.tsx app/src/components/ChatView.css
git commit -m "feat: add Ctrl+F search within chat sessions"
```

---

## Chunk 4: Export Sessions

### Task 7: Add export session to markdown

**Files:**
- Create: `app/src/utils/exportSession.ts` — format messages to markdown
- Modify: `app/src/components/ChatView.tsx` — add export button/shortcut

- [ ] **Step 1: Create exportSession.ts**

```typescript
export function messagesToMarkdown(messages: ChatMessage[], projectName: string): string {
  // Format each message:
  // - user: > **User:** text
  // - assistant: text (already markdown)
  // - tool: **Tool: name** + code block with input
  // - result: --- stats line
  // Header with project name, date, model
}
```

- [ ] **Step 2: Add export trigger in ChatView**

Add a Ctrl+Shift+E shortcut. Use `@tauri-apps/plugin-dialog` `save()` to pick destination. Write via Tauri `fs` or `invoke`.

- [ ] **Step 3: Commit**

```bash
git add app/src/utils/exportSession.ts app/src/components/ChatView.tsx
git commit -m "feat: add Ctrl+Shift+E session export to markdown"
```

---

## Chunk 5: Status Indicator, Undo Confirmations, Onboarding, Project Templates

### Task 8: Status indicator in InfoStrip

**Files:**
- Modify: `app/src/components/InfoStrip.tsx` — show connection/auth dot

- [ ] **Step 1: Add status indicator**

The InfoStrip already shows model/cost/tokens. Add a colored dot (green = connected, yellow = connecting, red = error) based on the session state from useSessionController.

States derived from existing data:
- No session → gray dot
- Session active, no error → green dot
- Rate limited → yellow dot
- Error received → red dot

- [ ] **Step 2: Commit**

```bash
git add app/src/components/InfoStrip.tsx
git commit -m "feat: add connection status indicator to InfoStrip"
```

### Task 9: Confirmation dialog for destructive actions

**Files:**
- Modify: `app/src/components/SystemPromptPage.tsx` — confirm before delete
- Modify: `app/src/hooks/useTabManager.ts` — confirm before closing active agent tab

- [ ] **Step 1: Add delete confirmation to SystemPromptPage**

Before calling `deletePrompt()`, show a simple confirm modal: "Delete prompt '{name}'? This cannot be undone."

Use existing `<Modal>` component pattern from the codebase.

- [ ] **Step 2: Add close confirmation for active agent tabs**

When closing a tab with a running agent (no `exitCode`), show confirmation: "Agent is still running. Close tab and kill agent?"

- [ ] **Step 3: Commit**

```bash
git add app/src/components/SystemPromptPage.tsx app/src/hooks/useTabManager.ts
git commit -m "feat: add confirmation dialogs for destructive actions"
```

### Task 10: First-run onboarding overlay

**Files:**
- Create: `app/src/components/OnboardingOverlay.tsx`
- Create: `app/src/components/OnboardingOverlay.css`
- Modify: `app/src/App.tsx` — show on first run
- Modify: `app/src/types.ts` — add `onboarding_seen` to Settings

- [ ] **Step 1: Create OnboardingOverlay**

A modal overlay with 3-4 slides:
1. "Welcome to Anvil" — what it does
2. "Keyboard-first" — key shortcuts (Tab, F2-F4, Enter, Ctrl+T)
3. "Choose your style" — theme picker preview
4. "Ready" — dismiss

Use existing modal animation patterns. Set `onboarding_seen: true` in settings on dismiss.

- [ ] **Step 2: Wire into App.tsx**

Show `<OnboardingOverlay>` when `settings.onboarding_seen` is falsy. On dismiss, update settings.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/OnboardingOverlay.tsx app/src/components/OnboardingOverlay.css app/src/App.tsx app/src/types.ts
git commit -m "feat: add first-run onboarding overlay"
```

### Task 11: Project templates

**Files:**
- Create: `app/src/data/projectTemplates.ts` — template definitions
- Modify: `app/src/components/modals/CreateProjectModal.tsx` — template picker
- Modify: `app/src/types.ts` — ProjectTemplate interface

- [ ] **Step 1: Define project templates**

```typescript
export interface ProjectTemplate {
  name: string;
  description: string;
  systemPrompt: string;
  model: number;    // index into MODELS
  effort: number;   // index into EFFORTS
  permMode: number; // index into PERM_MODES
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { name: "Code Review", description: "Review code for bugs and improvements", systemPrompt: "You are a senior code reviewer...", model: 1, effort: 0, permMode: 0 },
  { name: "Bug Fix", description: "Debug and fix issues", systemPrompt: "Focus on finding and fixing the reported bug...", model: 0, effort: 0, permMode: 1 },
  { name: "New Feature", description: "Implement a new feature", systemPrompt: "You are building a new feature...", model: 0, effort: 0, permMode: 1 },
  { name: "Refactor", description: "Improve code structure", systemPrompt: "Refactor the codebase for clarity...", model: 0, effort: 1, permMode: 0 },
];
```

- [ ] **Step 2: Add template picker to CreateProjectModal**

Show template cards before the directory picker. Selecting a template pre-fills model/effort/permMode and creates a system prompt.

- [ ] **Step 3: Commit**

```bash
git add app/src/data/projectTemplates.ts app/src/components/modals/CreateProjectModal.tsx app/src/types.ts
git commit -m "feat: add project templates for common workflows"
```

---

## Verification Checklist

After all tasks are complete, verify manually with `cargo tauri dev`:

- [ ] Edit/Write tools show colored diff view (red/green lines)
- [ ] Other tools (Bash, Read, Glob) still show raw JSON
- [ ] Session Browser "View" opens a transcript tab with readable messages
- [ ] Ctrl+F opens search bar in chat, matches highlighted, Enter navigates
- [ ] Ctrl+Shift+E exports session to markdown file
- [ ] InfoStrip shows colored status dot
- [ ] Deleting a system prompt shows confirmation dialog
- [ ] Closing active agent tab shows confirmation dialog
- [ ] First launch shows onboarding overlay
- [ ] Create Project modal shows template options
