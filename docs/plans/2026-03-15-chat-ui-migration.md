# Chat UI Migration — Replace xterm.js with React Chat Interface

> **For agentic workers:** Use subagent-driven execution (if subagents available) or ai-tooling:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the xterm.js terminal renderer with a React-based chat UI that renders Agent SDK events as structured components (message bubbles, tool cards, permission dialogs).

**Architecture:** Agent events flow unchanged from sidecar → Rust → Tauri Channel → React. Instead of converting events to ANSI strings and writing to xterm, a new `ChatView` component renders each event as a React component. Input uses a standard `<textarea>`. Permissions use inline card components. xterm.js and all its addons are removed entirely.

**Tech Stack:** React 19, `react-markdown` + `remark-gfm` (markdown), `ansi-to-react` (Bash output), existing CSS design tokens.

---

## Scope

This plan covers:
1. New ChatView component replacing Terminal
2. Message components for each AgentEvent type
3. Input system (textarea + autocomplete)
4. Permission cards (inline, not overlay)
5. Removal of xterm.js, ansiRenderer, Minimap, BookmarkList
6. Updated App.tsx wiring

Out of scope: session resume/fork UI, usage tab, system prompt tab, settings (these don't depend on xterm).

## File Structure

### New files
- `app/src/components/ChatView.tsx` — Main chat container (replaces Terminal.tsx)
- `app/src/components/ChatView.css` — Styles for chat layout
- `app/src/components/chat/MessageBubble.tsx` — Assistant text + markdown rendering
- `app/src/components/chat/ToolCard.tsx` — Tool use + tool result display
- `app/src/components/chat/PermissionCard.tsx` — Interactive permission prompt
- `app/src/components/chat/ChatInput.tsx` — User input textarea with autocomplete
- `app/src/components/chat/ThinkingIndicator.tsx` — Animated thinking/spinner
- `app/src/components/chat/ResultBar.tsx` — Turn result stats (cost, tokens, duration)

### Modified files
- `app/src/App.tsx` — Replace `<Terminal>` with `<ChatView>`
- `app/src/types.ts` — Add `ChatMessage` type for accumulated event state
- `app/package.json` — Add `react-markdown`, `remark-gfm`, `ansi-to-react`; remove xterm deps

### Removed files
- `app/src/components/Terminal.tsx` — Replaced by ChatView
- `app/src/components/Terminal.css` — Replaced by ChatView.css
- `app/src/components/Minimap.tsx` — Not needed (chat scrolls naturally)
- `app/src/components/BookmarkList.tsx` — Replaced by message list (click to scroll)
- `app/src/ansiRenderer.ts` — Not needed (events rendered as React components)

### Unchanged files
- `sidecar/sidecar.js` — No changes (events already structured)
- `app/src-tauri/src/sidecar.rs` — No changes (event types unchanged)
- `app/src/hooks/useAgentSession.ts` — No changes (API stays the same)
- `app/src/hooks/useAutocomplete.ts` — Minor: remove xterm dependency, use textarea position
- `app/src/themes.ts` — Remove `getXtermTheme()`, keep `THEMES` and `applyTheme()`

---

## Chunk 1: Foundation — ChatView Container + Message Types

### Task 1: Install dependencies

**Files:**
- Modify: `app/package.json`

- [ ] **Step 1: Install npm packages**

```bash
cd app && npm install react-markdown remark-gfm ansi-to-react
```

- [ ] **Step 2: Verify installation**

```bash
cd app && node -e "require('react-markdown'); require('remark-gfm'); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "feat: add react-markdown, remark-gfm, ansi-to-react for chat UI"
```

### Task 2: Define ChatMessage type

**Files:**
- Modify: `app/src/types.ts`

The chat accumulates events into messages. Each turn produces a sequence:
thinking → assistant text (streaming) → tool uses → tool results → result stats.

- [ ] **Step 1: Add ChatMessage types to types.ts**

```typescript
// ── Chat UI types ─────────────────────────────────────────────────

/** A single message in the chat view. Built from accumulated AgentEvents. */
export type ChatMessage =
  | { id: string; role: "user"; text: string; timestamp: number }
  | { id: string; role: "assistant"; text: string; streaming: boolean; timestamp: number }
  | { id: string; role: "tool"; tool: string; input: unknown; output?: string; success?: boolean; timestamp: number }
  | { id: string; role: "permission"; tool: string; description: string; suggestions?: PermissionSuggestion[]; resolved?: boolean; allowed?: boolean; timestamp: number }
  | { id: string; role: "thinking"; text: string; timestamp: number }
  | { id: string; role: "result"; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; durationMs: number; isError: boolean; sessionId: string; timestamp: number }
  | { id: string; role: "error"; code: string; message: string; timestamp: number }
  | { id: string; role: "status"; status: string; model: string; timestamp: number };
```

- [ ] **Step 2: Commit**

```bash
git add app/src/types.ts
git commit -m "feat: add ChatMessage types for chat UI"
```

### Task 3: Create ChatView container component

**Files:**
- Create: `app/src/components/ChatView.tsx`
- Create: `app/src/components/ChatView.css`

ChatView is the direct replacement for Terminal. Same props interface (minus xterm-specific ones), same event handling, but renders React components instead of ANSI.

- [ ] **Step 1: Create ChatView.tsx skeleton**

```tsx
import { memo, useEffect, useRef, useState, useCallback } from "react";
import { spawnAgent, resumeAgent, forkAgent, sendAgentMessage, killAgent, respondPermission } from "../hooks/useAgentSession";
import { MODELS, EFFORTS } from "../types";
import type { AgentEvent, ThemeColors, ChatMessage, PermissionSuggestion } from "../types";
import "./ChatView.css";

// Generate unique message IDs
let msgCounter = 0;
const nextId = () => `msg-${++msgCounter}`;

interface ChatViewProps {
  tabId: string;
  projectPath: string;
  modelIdx: number;
  effortIdx: number;
  skipPerms: boolean;
  systemPrompt: string;
  themeColors: ThemeColors;
  fontFamily: string;
  fontSize: number;
  isActive: boolean;
  onSessionCreated: (tabId: string, sessionId: string) => void;
  onNewOutput: (tabId: string) => void;
  onExit: (tabId: string, code: number) => void;
  onError: (tabId: string, msg: string) => void;
  onRequestClose: (tabId: string) => void;
  onAgentResult?: (tabId: string, event: AgentEvent) => void;
  onTaglineChange?: (tabId: string, tagline: string) => void;
  autocompleteEnabled?: boolean;
  resumeSessionId?: string;
  forkSessionId?: string;
}

export default memo(function ChatView({
  tabId, projectPath, modelIdx, effortIdx, skipPerms, systemPrompt,
  themeColors, fontFamily, fontSize, isActive,
  onSessionCreated, onNewOutput, onExit, onError, onRequestClose,
  onAgentResult, onTaglineChange, autocompleteEnabled,
  resumeSessionId, forkSessionId,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputState, setInputState] = useState<"idle" | "awaiting_input" | "processing" | "awaiting_permission">("idle");
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const exitedRef = useRef(false);
  const agentStartedRef = useRef(false);

  // Callback refs to avoid stale closures
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  const onNewOutputRef = useRef(onNewOutput);
  onNewOutputRef.current = onNewOutput;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onAgentResultRef = useRef(onAgentResult);
  onAgentResultRef.current = onAgentResult;
  const onTaglineChangeRef = useRef(onTaglineChange);
  onTaglineChangeRef.current = onTaglineChange;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when becoming active or when input state changes
  useEffect(() => {
    if (isActive && inputState === "awaiting_input") {
      inputRef.current?.focus();
    }
  }, [isActive, inputState]);

  // TODO: Task 5 — Agent lifecycle (spawn, event handler)
  // TODO: Task 6 — Input submission
  // TODO: Task 7+ — Message rendering components

  return (
    <div className="chat-view" style={{ fontFamily: `'${fontFamily}', 'Consolas', monospace`, fontSize }}>
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
            {/* TODO: render by role */}
            <pre>{JSON.stringify(msg, null, 2)}</pre>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      {inputState === "awaiting_input" && (
        <div className="chat-input-bar">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // TODO: submit
              }
            }}
            placeholder="Type a message..."
            rows={1}
          />
        </div>
      )}
      {inputState === "processing" && (
        <div className="chat-thinking">Thinking...</div>
      )}
    </div>
  );
});
```

- [ ] **Step 2: Create ChatView.css with base layout**

```css
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.chat-messages::-webkit-scrollbar {
  width: 8px;
}
.chat-messages::-webkit-scrollbar-thumb {
  background: var(--overlay0);
  border-radius: var(--radius-sm);
}
.chat-messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-msg { line-height: 1.5; }

.chat-msg--user {
  align-self: flex-end;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  max-width: 80%;
}

.chat-msg--assistant {
  max-width: 90%;
}

.chat-msg--tool {
  font-size: var(--text-sm);
}

.chat-input-bar {
  border-top: 1px solid color-mix(in srgb, var(--overlay0) 40%, transparent);
  padding: var(--space-2) var(--space-3);
}

.chat-input {
  width: 100%;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  color: var(--text);
  border: 1px solid var(--overlay0);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  font-family: inherit;
  font-size: inherit;
  resize: none;
  outline: none;
}
.chat-input:focus {
  border-color: var(--accent);
}

.chat-thinking {
  padding: var(--space-2) var(--space-4);
  color: var(--text-dim);
  font-size: var(--text-sm);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ChatView.tsx app/src/components/ChatView.css
git commit -m "feat: ChatView skeleton — container, message list, input bar"
```

### Task 4: Wire ChatView into App.tsx (parallel with Terminal)

**Files:**
- Modify: `app/src/App.tsx`

Keep Terminal.tsx as fallback. Add a setting or prop to switch between Terminal and ChatView. This allows incremental testing.

- [ ] **Step 1: Import ChatView in App.tsx**

Add import alongside Terminal:
```tsx
import ChatView from "./components/ChatView";
```

- [ ] **Step 2: Replace Terminal with ChatView for agent tabs**

In the tab rendering section (where `<Terminal>` is used), replace with `<ChatView>` using same props. Remove `themeIdx` prop (ChatView uses CSS variables directly). Keep Terminal import for now as dead code.

- [ ] **Step 3: Verify app loads without errors**

Run `dev.bat`, open a new tab. Should see the JSON-rendered chat skeleton.

- [ ] **Step 4: Commit**

```bash
git add app/src/App.tsx
git commit -m "feat: wire ChatView into App.tsx replacing Terminal"
```

---

## Chunk 2: Agent Lifecycle + Event Processing

### Task 5: Implement agent spawn and event handler in ChatView

**Files:**
- Modify: `app/src/components/ChatView.tsx`

The event handler converts AgentEvent → ChatMessage and appends to state. Streaming assistant text updates the last assistant message in-place.

- [ ] **Step 1: Add agent spawn in useEffect**

Inside the main useEffect (runs once on mount), spawn the agent and handle events. Use the same pattern as Terminal.tsx but convert events to ChatMessage objects instead of ANSI.

Key patterns:
- `assistant` streaming → update last message's text (don't create new message per delta)
- `toolUse` → create tool message, update when `toolResult` arrives (match by tool name or keep pending ref)
- `permission` → create permission message (rendered as interactive card)
- `inputRequired` → transition to awaiting_input state
- `result` → create result message with stats

- [ ] **Step 2: Add input submission handler**

When user presses Enter:
1. Create user ChatMessage with input text
2. Clear input, transition to "processing"
3. Call `sendAgentMessage(tabId, text)`

- [ ] **Step 3: Test end-to-end flow**

Run `dev.bat`, type a prompt. Should see raw JSON messages appear for each event. Permission events should appear (non-interactive for now).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/ChatView.tsx
git commit -m "feat: ChatView agent lifecycle — spawn, events, input"
```

---

## Chunk 3: Message Rendering Components

### Task 6: MessageBubble — assistant text with markdown

**Files:**
- Create: `app/src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Create MessageBubble component**

Uses `react-markdown` with `remark-gfm` for GitHub-flavored markdown. Code blocks get syntax highlighting via CSS (no heavy lib like Prism — just monospace + background).

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  streaming?: boolean;
}

export default function MessageBubble({ text, streaming }: Props) {
  return (
    <div className={`msg-bubble${streaming ? " streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: Style markdown output**

CSS for `.msg-bubble` — handle code blocks, lists, tables, links using theme tokens.

- [ ] **Step 3: Wire into ChatView**

Replace the `<pre>` JSON fallback for `role === "assistant"` with `<MessageBubble>`.

- [ ] **Step 4: Commit**

### Task 7: ToolCard — tool use + result

**Files:**
- Create: `app/src/components/chat/ToolCard.tsx`

Collapsible card showing tool name, input (JSON), output, success/fail icon.

- [ ] **Step 1: Create ToolCard component**

- [ ] **Step 2: Wire into ChatView for `role === "tool"` messages**

- [ ] **Step 3: Commit**

### Task 8: PermissionCard — interactive inline permission

**Files:**
- Create: `app/src/components/chat/PermissionCard.tsx`

This is the key improvement — permissions are inline cards with clickable buttons, not overlays or cursor manipulation.

- [ ] **Step 1: Create PermissionCard component**

```tsx
interface Props {
  tool: string;
  description: string;
  suggestions?: PermissionSuggestion[];
  resolved?: boolean;
  allowed?: boolean;
  onRespond: (allow: boolean, suggestions?: PermissionSuggestion[]) => void;
}

export default function PermissionCard({ tool, description, suggestions, resolved, allowed, onRespond }: Props) {
  if (resolved) {
    return (
      <div className={`perm-card resolved ${allowed ? "allowed" : "denied"}`}>
        {allowed ? "✓" : "✗"} {tool}: {description}
      </div>
    );
  }
  return (
    <div className="perm-card pending">
      <div className="perm-card-question">Allow <strong>{tool}</strong>: {description}?</div>
      <div className="perm-card-actions">
        <button onClick={() => onRespond(true)}>Yes</button>
        {suggestions && suggestions.length > 0 && (
          <button onClick={() => onRespond(true, suggestions)}>Yes, for session</button>
        )}
        <button onClick={() => onRespond(false)}>No</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into ChatView — update message state on respond**

When user clicks a button, call `respondPermission()` and update the ChatMessage to `resolved: true`.

- [ ] **Step 3: Style with theme tokens**

- [ ] **Step 4: Commit**

### Task 9: ThinkingIndicator + ResultBar

**Files:**
- Create: `app/src/components/chat/ThinkingIndicator.tsx`
- Create: `app/src/components/chat/ResultBar.tsx`

- [ ] **Step 1: Create ThinkingIndicator** — animated dots/pulse

- [ ] **Step 2: Create ResultBar** — cost, tokens, turns, duration in a dim line

- [ ] **Step 3: Wire into ChatView**

- [ ] **Step 4: Commit**

---

## Chunk 4: Cleanup — Remove xterm.js

### Task 10: Remove Terminal.tsx and xterm dependencies

**Files:**
- Remove: `app/src/components/Terminal.tsx`
- Remove: `app/src/components/Terminal.css`
- Remove: `app/src/components/Minimap.tsx`
- Remove: `app/src/components/BookmarkList.tsx`
- Remove: `app/src/ansiRenderer.ts`
- Modify: `app/src/themes.ts` — remove `getXtermTheme()`
- Modify: `app/package.json` — remove xterm deps

- [ ] **Step 1: Remove dead files**

```bash
rm app/src/components/Terminal.tsx app/src/components/Terminal.css
rm app/src/components/Minimap.tsx app/src/components/BookmarkList.tsx
rm app/src/ansiRenderer.ts
```

- [ ] **Step 2: Remove xterm imports from App.tsx**

- [ ] **Step 3: Remove xterm packages**

```bash
cd app && npm uninstall @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @xterm/addon-unicode11
```

- [ ] **Step 4: Clean up themes.ts**

Remove `getXtermTheme()` function and xterm-related exports.

- [ ] **Step 5: Verify build passes**

```bash
cd app && npx tsc --noEmit && npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove xterm.js, Terminal, Minimap, BookmarkList, ansiRenderer"
```

### Task 11: Update useAutocomplete for textarea

**Files:**
- Modify: `app/src/hooks/useAutocomplete.ts`

The autocomplete hook currently depends on xterm cursor position for ghost text. For ChatView, it should work with the textarea instead.

- [ ] **Step 1: Refactor useAutocomplete to accept textarea ref instead of xterm ref**

- [ ] **Step 2: Ghost text rendered as overlay on textarea (CSS positioned)**

- [ ] **Step 3: Commit**

---

## Chunk 5: Polish + Keyboard Shortcuts

### Task 12: Keyboard shortcuts in ChatView

**Files:**
- Modify: `app/src/components/ChatView.tsx`

Port the essential shortcuts from Terminal.tsx:
- Ctrl+C: copy selection (or interrupt agent if processing)
- Ctrl+V: paste into input
- Escape: clear input

- [ ] **Step 1: Add keyboard handler**

- [ ] **Step 2: Commit**

### Task 13: Bash output ANSI rendering

**Files:**
- Modify: `app/src/components/chat/ToolCard.tsx`

Bash tool results may contain ANSI escape sequences. Use `ansi-to-react` to render them as colored HTML.

- [ ] **Step 1: Add ANSI rendering for Bash tool results**

- [ ] **Step 2: Commit**

### Task 14: Final cleanup and testing

- [ ] **Step 1: Remove debug logging from sidecar.js**
- [ ] **Step 2: Update CLAUDE.md with new architecture**
- [ ] **Step 3: Manual test: prompt → tool use → permission → result → multi-turn**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: chat UI migration complete — xterm.js replaced with React chat"
```
