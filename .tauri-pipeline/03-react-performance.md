# Phase 3: React Frontend Performance

## Assessment
The frontend is well-optimized for its scale, with strong patterns already in place: RAF-throttled streaming, stable callback refs, debounced saves, React Compiler enabled, and no external state library overhead. The most impactful remaining issues are an O(n) permission scan on the hottest render path and thinking event handlers that copy the entire messages array on every chunk.

## What's Done Well
- **RAF-throttled streaming** (ChatView.tsx:286-290) -- best-in-class pattern
- **Stable callback refs** (ChatView.tsx:200-211) prevents stale closures
- **Session save debouncing** with beforeunload flush (useTabManager.ts:99-131)
- **Memoized context value** (ProjectsContext.tsx:13-37)
- **markNewOutput guard** (useTabManager.ts:218-224) prevents cascading re-renders
- **Streaming message outside virtual list** (ChatView.tsx:858-863)
- **useDeferredValue for sidebar** (ChatView.tsx:728)
- **PrismLight with individual language imports** (MessageBubble.tsx:4-55)
- **Raw text during streaming** (MessageBubble.tsx:163-165) avoids O(n^2) markdown re-parsing
- **Module-level window caching** (App.tsx:25, TabBar.tsx:7)
- **StrictMode-safe agent lifecycle** (ChatView.tsx:186-188, 516-524)
- **useReducer for session stats** (ChatView.tsx:121-139)
- **Lazy loading for singleton pages** (App.tsx:18-22)
- **No external state management library** -- eliminates common re-render issues

## Findings

### Critical

| ID | File | Issue | Fix |
|----|------|-------|-----|
| C1 | ChatView.tsx:722-725 | `hasUnresolvedPermission` O(n) scan on every messages change -- hottest path | Track unresolved count via ref, increment on add, decrement on resolve |
| C2 | App.tsx:403 | Inline arrow functions wrapping stable callbacks defeat React.memo on SessionBrowser | Pass `handleResumeSession`/`handleForkSession` directly |

### High

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H1 | ChatView.tsx:346-355 | `thinking` event copies entire messages array on every chunk (high frequency) | Apply ref-based accumulation like assistant streaming |
| H2 | SessionBrowser.tsx:81-86 | `filtered` recomputed inside keyboard handler on every keypress | Use filteredRef from render |
| H3 | ToolCard.tsx:13 | `JSON.stringify(input, null, 2)` runs on every render even when collapsed | Move to useMemo or defer to expanded state |
| H4 | MinimapPanel.tsx:104-116 | Full text DOM for all messages -- 200+ nodes with full text | Cap text per message, limit rendered count, or use canvas |
| H5 | NewTabPage.tsx:62-70 | 10 individual useEffect ref-sync calls -- redundant with React Compiler | Remove refs, use values directly (Compiler handles capture) |

### Medium

| ID | File | Issue | Fix |
|----|------|-------|-----|
| M1 | tauri.conf.json:13 | `withGlobalTauri: true` exposes IPC surface | Set to false; app uses ESM imports |
| M2 | vite.config.ts:18-22 | TanStack Virtual and Radix UI not in vendor chunks | Add manual chunks |
| M3 | MessageBubble.tsx:58-90 | `getAnvilTheme()` cache invalidated on every style property change | Debounce via rAF |
| M4 | MessageBubble.tsx:111-155 | `CodeBlock` calls hooks after early return -- violates Rules of Hooks | Move hooks above early return or split into two components |
| M5 | SessionBrowser.tsx:66-86 | `filtered` computed twice (render + keyboard handler) -- can diverge | Use ref from render in handler |
| M6 | ChatView.tsx:225-235 | Scroll event sets state synchronously on every frame | Guard with ref before setState |
| M7 | App.tsx:74-78 | `allPrompts` state change cascades to all ChatView instances | Acceptable as-is; could isolate to dedicated context |
| M8 | vite.config.ts:14 | No `minify: 'terser'` -- esbuild produces slightly larger bundles | Optional; add if build time is not a concern |

### Low

| ID | File | Issue | Fix |
|----|------|-------|-----|
| L1 | ChatView.tsx:37 | Regex created on every UserMessage render | Correct for stateful regex; could use matchAll instead |
| L2 | NewTabPage.tsx:330 | Component wrapped in memo() -- redundant with React Compiler | Remove explicit memo |
| L3 | ThinkingBlock.tsx:16-17 | `text.split("\n")` on every render for line count | Use useMemo or count newlines directly |
| L4 | GsdPrimitives.tsx | Components not memoized | Negligible; React Compiler handles it |
| L5 | Modals | CreateProjectModal/LabelProjectModal lack memo | Negligible; only render when open |
| L6 | themes/index.ts | 18 theme JSONs imported eagerly (~3.6KB total) | Not worth lazy-loading |

## Key Issues for Layout/Polish Context
- C1/H1: The hottest render path is message array mutations during streaming -- layout analysis should avoid adding expensive computations to message rendering
- H4: MinimapPanel DOM scale is problematic -- layout review should consider minimap sizing constraints
- M3: Theme cache invalidation pattern affects code blocks with syntax highlighting
- React Compiler is active -- explicit memo() wrappers are largely redundant
