# React Performance Review -- 2026-03-16

Full React audit - 40 components - 3 state management files

## Product Brief Context

Tauri 2 desktop app (Windows-only, WebView2/Chromium). No SSR, no server components, no routing. Performance-critical path: streaming agent output to chat view at 10+ chunks/sec. Bundle served locally (no network latency).

## Scores

| Category | Score |
|----------|-------|
| Re-render Control | 6/10 |
| State Management | 7/10 |
| Bundle Optimization | 4/10 |
| Cleanup & Lifecycle | 8/10 |
| **Overall** | **6/10** |

Critical: 1 | High: 4 | Medium: 4 | Low: 3

## Files Audited

- `App.tsx`, `ChatView.tsx`, `NewTabPage.tsx`
- `useTabManager.ts`, `useProjects.ts`, `useAgentSession.ts`
- `ProjectsContext.tsx`, `types.ts`
- `ChatInput.tsx`, `MessageBubble.tsx`, `ToolCard.tsx`
- `MinimapPanel.tsx`, `RightSidebar.tsx`
- `vite.config.ts`

---

## Critical & High Issues

### Bundle Optimization

#### `MessageBubble.tsx` -- react-syntax-highlighter ships all ~180 Prism grammars (~500KB)
- **Severity**: Critical
- **Rule**: `bundle-conditional`
- **Issue**: `react-syntax-highlighter` imports the full Prism build with all language grammars. This single library dominates the 1MB+ JS bundle. A Claude Code desktop app realistically needs <20 languages.
- **Fix**: Use the light build with explicit language registration, or split into a separate chunk:

```tsx
// Option A: Light build (recommended, -400KB)
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import js from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";

SyntaxHighlighter.registerLanguage("javascript", js);
SyntaxHighlighter.registerLanguage("typescript", ts);
// ... register each language
```

```ts
// Option B: Split into separate chunk (vite.config.ts)
manualChunks: {
  "vendor-react": ["react", "react-dom"],
  "vendor-markdown": ["react-markdown", "remark-gfm"],
  "vendor-syntax": ["react-syntax-highlighter"],
},
```
- [ ] Fixed

---

### Re-render Control

#### `ChatView.tsx:127-135` -- 15 independent useState calls for session stats
- **Severity**: High
- **Issue**: Each `result` event triggers 7 separate `setState` calls (lines 308-317) for cost, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns, durationMs. Channel callbacks from Tauri may not be batched by React, causing up to 7 re-renders per event.
- **Fix**: Consolidate into `useReducer`:

```tsx
interface SessionStats {
  tokens: number; contextWindow: number; cost: number;
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
  turns: number; durationMs: number; rateLimitUtil: number;
}

const initialStats: SessionStats = {
  tokens: 0, contextWindow: 0, cost: 0,
  inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
  turns: 0, durationMs: 0, rateLimitUtil: 0,
};

type StatsAction =
  | { type: "result"; event: Extract<AgentEvent, { type: "result" }> }
  | { type: "rateLimit"; utilization: number };

function statsReducer(state: SessionStats, action: StatsAction): SessionStats {
  switch (action.type) {
    case "result": {
      const e = action.event;
      return {
        ...state,
        tokens: state.tokens + (e.inputTokens || 0) + (e.outputTokens || 0),
        contextWindow: e.contextWindow > 0 ? e.contextWindow : state.contextWindow,
        cost: state.cost + (e.cost || 0),
        inputTokens: state.inputTokens + (e.inputTokens || 0),
        outputTokens: state.outputTokens + (e.outputTokens || 0),
        cacheReadTokens: state.cacheReadTokens + (e.cacheReadTokens || 0),
        cacheWriteTokens: state.cacheWriteTokens + (e.cacheWriteTokens || 0),
        turns: state.turns + (e.turns || 0),
        durationMs: state.durationMs + (e.durationMs || 0),
      };
    }
    case "rateLimit":
      return { ...state, rateLimitUtil: action.utilization };
  }
}

const [stats, dispatchStats] = useReducer(statsReducer, initialStats);
```
- [ ] Fixed

#### `ChatView.tsx:241-249` -- Streaming text copies entire messages array per chunk
- **Severity**: High
- **Issue**: Every streaming text chunk (10+/sec) triggers `setMessages(prev => { const next = [...prev]; ... })`. With 200+ messages, this is O(n) array copy at high frequency.
- **Fix**: Extract streaming text into a ref + dedicated component with RAF-throttled updates. Only touch the messages array on stream start/end:

```tsx
const streamingTextRef = useRef("");
const [streamingId, setStreamingId] = useState<string | null>(null);

// In handler: just update ref, schedule RAF
streamingTextRef.current += event.text;
// StreamingBubble reads from ref via RAF, no messages array copy
```
- [ ] Fixed

#### `ChatView.tsx` -- Message list not virtualized
- **Severity**: High
- **Issue**: All messages render to DOM simultaneously. Long sessions (500+ messages with markdown, code blocks, tool cards) create thousands of DOM nodes, degrading scroll performance.
- **Fix**: Use `@tanstack/react-virtual` with variable-height measurement. Consider implementing only after profiling confirms frame drops above 200 messages.
- [ ] Fixed

### Build Configuration

#### `vite.config.ts` -- React Compiler not configured
- **Severity**: High
- **Issue**: `babel-plugin-react-compiler` not installed. All memoization across 40+ components is manual (`React.memo`, `useCallback`, `useMemo`). The Compiler could auto-optimize 30-40% of memoization surface.
- **Fix**:
```bash
npm install -D babel-plugin-react-compiler
```
```ts
// vite.config.ts
plugins: [
  react({
    babel: { plugins: ["babel-plugin-react-compiler"] },
  }),
],
```
- [ ] Fixed

---

## Medium & Low Issues

### Context

#### `ProjectsContext.tsx:13` -- useMemo returns projectsData identity directly
- **Severity**: Medium
- **Issue**: `useMemo(() => projectsData, [...])` returns the hook's return object, which is a new identity every render. The dependency check works correctly, but the returned value isn't a new stable object -- it's just the same `projectsData` reference.
- **Fix**: Construct a new object inside useMemo:
```tsx
const value = useMemo(() => ({
  settings: projectsData.settings,
  projects: projectsData.projects,
  // ... spread each field
}), [projectsData.settings, projectsData.projects, ...]);
```
- [ ] Fixed

### Re-render Control

#### `RightSidebar.tsx:43-48` -- tabs array with JSX icons recreated every render
- **Severity**: Medium
- **Issue**: Array containing SVG JSX elements is created inline, producing new references on every render.
- **Fix**: Hoist to module-level constant.
- [ ] Fixed

#### `MinimapPanel.tsx:99`, `BookmarkPanel.tsx`, `TodoPanel.tsx`, `ThinkingPanel.tsx` -- .filter() without useMemo
- **Severity**: Medium
- **Issue**: Each sidebar panel calls `.filter()` in the render body without memoization. While they receive `deferredMessages`, the filter still runs on every render.
- **Fix**: Wrap in `useMemo(() => messages.filter(...), [messages])`.
- [ ] Fixed

#### `ChatView.tsx:784-795` -- Inline async handler in bottom bar attach button
- **Severity**: Medium
- **Issue**: Inline `async () => { ... open(...) ... }` recreated on every render inside a `memo` component.
- **Fix**: Extract to a `useCallback`.
- [ ] Fixed

### Bundle

#### `App.tsx:1-20` -- Singleton tab pages eagerly imported
- **Severity**: Low
- **Issue**: `AboutPage`, `UsagePage`, `SystemPromptPage`, `SessionBrowser` are eagerly imported but rarely opened.
- **Fix**: Use `React.lazy()`. Minimal impact for desktop (local files), but reduces initial parse time.
- [ ] Fixed

### Re-renders

#### `MessageBubble.tsx:110-115` -- components and remarkPlugins objects recreated
- **Severity**: Low
- **Issue**: `components={{ a: SafeLink, code: CodeBlock }}` and `remarkPlugins={[remarkGfm]}` create new references on every render, causing ReactMarkdown to re-process its component map.
- **Fix**: Hoist to module-level constants:
```tsx
const MD_COMPONENTS = { a: SafeLink, code: CodeBlock as never };
const MD_PLUGINS = [remarkGfm];
```
- [ ] Fixed

### Cleanup

#### `ChatView.tsx:85,484` -- setTimeout without cleanup
- **Severity**: Low
- **Issue**: `CopyMessageBtn` and `handleScrollToMessage` use `setTimeout` without cleanup. If unmounted before timeout fires, this sets state on unmounted component.
- **Fix**: Add `clearTimeout` in `useEffect` cleanup or use a ref guard.
- [ ] Fixed

---

## What's Working Well

- **Streaming text bypass** -- MessageBubble renders raw text during streaming, avoiding O(n^2) markdown re-parsing per chunk
- **`useDeferredValue` for sidebar** -- Correctly defers sidebar re-renders during high-frequency streaming
- **Callback refs pattern** -- ChatView uses refs for callback props to avoid stale closures in the agent lifecycle useEffect
- **StrictMode-safe agent kill** -- `pendingKillRef` + deferred `setTimeout` correctly handles React StrictMode double-mount
- **`hasNewOutput` guard** -- `markNewOutput` only creates a new tabs array when the flag actually changes, not per chunk
- **Syntax theme caching** -- MutationObserver invalidation on `document.documentElement` style changes
- **Consistent `React.memo`** -- All 40 components wrapped
- **Passive scroll listeners** -- `{ passive: true }` throughout
- **`queueMicrotask` for IPC** -- Permission handler schedules Tauri IPC outside React's state updater
- **Channel cleanup** -- `channel.onmessage = null` on unmount prevents stale events
- **No external state library** -- Pure useState/useContext keeps bundle lean and avoids selector issues

---

## Action Plan

1. [ ] **Split react-syntax-highlighter** -- Use light build or separate chunk (-400-600KB)
2. [ ] **Consolidate session stats** -- Replace 15 useState with useReducer (-6 re-renders/event)
3. [ ] **Add React Compiler** -- `babel-plugin-react-compiler` for auto-memoization
4. [ ] **Extract streaming text** -- Ref + RAF-throttled component, stop copying messages array per chunk
5. [ ] **Hoist MD_COMPONENTS/MD_PLUGINS** -- Module-level constants (2-minute fix)
6. [ ] **Add useMemo to sidebar filters** -- Wrap `.filter()` calls in sidebar panels
7. [ ] **Lazy-load singleton pages** -- `React.lazy()` for About, Usage, SystemPrompt, Sessions
8. [ ] **Fix ProjectsContext value identity** -- Construct new object in useMemo
