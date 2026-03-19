# Tauri Desktop Pipeline Report

## Target
Full Tauri 2 desktop application -- Anvil (Windows-only Claude Code Agent SDK launcher with tabbed interface)

## Executive Summary
Anvil is a well-engineered desktop application with strong fundamentals across all layers. The Rust backend demonstrates thoughtful patterns (Job Object process cleanup, atomic file writes, spawn_blocking discipline), the IPC architecture correctly uses Channel API for streaming, the React frontend has best-in-class streaming optimization (RAF-throttled, ref-based accumulation), and the visual polish is remarkably mature (theme crossfade, retro mode overrides, prefers-reduced-motion). The main risk areas are sidecar crash recovery (no health check, orphaned oneshots, missing timeouts) and a few hot-path performance issues in the React layer.

## Score Summary

| Layer               | Critical | High | Medium | Low |
|---------------------|----------|------|--------|-----|
| Rust Backend        | 0        | 3    | 8      | 6   |
| Tauri IPC           | 1        | 4    | 10     | 6   |
| React Performance   | 2        | 5    | 8      | 6   |
| Layout              | 0        | 3    | 6      | 7   |
| UI Polish           | 0        | 4    | 10     | 10  |
| **Total**           | **3**    | **19**| **42** | **35**|

## Critical & High Priority Issues

### Critical (3)

| Phase | ID | File | Issue |
|-------|----|------|-------|
| Tauri IPC | H1 | `commands.rs:508,529` | Missing timeouts on oneshot receivers -- hangs forever if sidecar crashes |
| React | C1 | `ChatView.tsx:722-725` | `hasUnresolvedPermission` O(n) scan on every messages change (hottest render path) |
| React | C2 | `App.tsx:403` | Inline arrow functions wrapping stable callbacks defeat React.memo on SessionBrowser |

### High (19)

| Phase | ID | File | Issue |
|-------|----|------|-------|
| Rust | H1 | `commands.rs:588` | `read_external_file` clones entire 1MB buffer unnecessarily |
| Rust | H2 | `commands.rs:508,529` | `list_agent_sessions`/`get_agent_messages` oneshots have no timeout |
| Rust | H3 | `sidecar.rs` (all locks) | Mutex `.unwrap()` -- single panic cascades to disable all agent comms |
| Tauri IPC | H2 | `sidecar.rs:147,439` | Orphaned oneshot senders on sidecar death -- memory leak |
| Tauri IPC | H3 | `sidecar.rs` (all locks) | Mutex poisoning cascade (same as Rust H3) |
| Tauri IPC | H4 | `sidecar.rs` | No sidecar health check -- `available` stays true after crash |
| Tauri IPC | L2 | `capabilities/default.json` | Missing `allow-agent-ask-response` permission -- may fail in prod builds |
| React | H1 | `ChatView.tsx:346-355` | Thinking event copies entire messages array on every chunk |
| React | H2 | `SessionBrowser.tsx:81-86` | `filtered` recomputed inside keyboard handler on every keypress |
| React | H3 | `ToolCard.tsx:13` | `JSON.stringify(input, null, 2)` runs on every render even when collapsed |
| React | H4 | `MinimapPanel.tsx:104-116` | Full text DOM for all messages (200+ nodes) |
| React | H5 | `NewTabPage.tsx:62-70` | 10 useEffect ref-sync calls redundant with React Compiler |
| Layout | H1 | `ChatView.css:38-41` | Chat messages not centered -- dead zone on right in wide viewports |
| Layout | H2 | `ProjectList.tsx:55-83` | No virtualization for potentially long project lists |
| Layout | H3 | `App.css:104-112` | Content area can shrink to ~180px when sidebar + session panel open |
| Polish | H1 | `ChatView.css:38-41` | Same as Layout H1 (centering) |
| Polish | H2 | `Modal.css:8-41` | No exit animation for modal -- instant disappear |
| Polish | H3 | `ShortcutsOverlay.css:1-10` | Full-screen overlay appears/disappears instantly |
| Polish | H4 | `SessionPanel.css` | Session panel appears with no entrance animation |

## Medium Priority Issues (42)

### Rust Backend (8)
- M1: SidecarEvent flat struct with 20+ optional fields (fragile, wasteful)
- M2: `load_usage()` reads without USAGE_LOCK
- M3: SidecarManager `shutdown()` double-locks in Drop
- M4: Unnecessary `AgentEvent::clone()` on channel send
- M5: Duplicated `days_to_ymd` algorithm in logging and usage_stats
- M6: `Result<T, String>` error handling throughout (no typed errors)
- M7: UTC date computation vs local-time timestamps (off-by-one near midnight)

### Tauri IPC (10)
- M1: Flat SidecarEvent struct fragile for IPC evolution
- M2: Unnecessary `.clone()` on event send path
- M3: Double mutex lock per event on exit
- M4: `read_external_file` blocked-dir list is narrow
- M5: `withGlobalTauri: true` exposes IPC surface
- M6: No `rust-lld` linker (30-60s link stalls in dev)
- M7: Missing Terser minification
- M8: Blocking `npm install` during sidecar init
- M9: Stdin write not atomic (separate write+newline+flush)
- M10: `messages.some()` O(n) on every render

### React Performance (8)
- M1: `withGlobalTauri` security concern
- M2: TanStack Virtual and Radix UI not in vendor chunks
- M3: Theme cache invalidated on every style property change
- M4: CodeBlock calls hooks after early return (Rules of Hooks violation)
- M5: `filtered` computed twice in SessionBrowser
- M6: Scroll event sets state synchronously on every frame
- M7: `allPrompts` state change cascades to all ChatView instances
- M8: No Terser minification

### Layout (6)
- M1: ~15 raw pixel values instead of spacing tokens
- M2: Chat bottom bar overflows at narrow widths
- M3: Settings modal compound max-height clips content
- M4: Right sidebar width not persisted
- M5: Static pages lack scroll-to-top on re-entry
- M6: Info strip buttons below 28px touch target

### UI Polish (10)
- M1: Inconsistent transition easing (missing ease-out)
- M2-M3: Raw pixel values and 9px font without token
- M4: Collapsible content (ToolCard, ThinkingBlock) has no animation
- M5: Copy button lacks success feedback animation
- M6: Drag-drop overlay appears instantly
- M7: Switch thumb lacks spring-like motion
- M8: Gear icon dual transform inconsistency
- M9: Session panel close button missing :active/:focus-visible
- M10: Right sidebar tab switch has instant content swap

## What's Done Well

### Rust Backend
- Win32 Job Object for process tree cleanup (RAII wrapper)
- Atomic file writes (tmp+rename) preventing data corruption
- `spawn_blocking` discipline on every blocking operation
- Git timeout + output limit with dedicated reader thread
- Panic isolation via `catch_unwind` in project scanning
- Log sanitization, input validation, NTFS dedup

### Tauri IPC & Architecture
- Channel API for high-frequency agent event streaming
- Three-tier shutdown (close stdin -> terminate job -> kill child)
- StrictMode-safe agent lifecycle with deferred kill
- Fine-grained capabilities with per-command permissions
- Restrictive CSP configuration

### React Frontend
- RAF-throttled streaming (best-in-class pattern)
- Raw text during streaming (avoids O(n^2) markdown re-parsing)
- Stable callback refs preventing stale closures
- `useDeferredValue` for sidebar isolation
- React Compiler enabled for automatic memoization
- No external state library -- zero store-related re-render issues
- `useReducer` for session stats (single dispatch vs 7+ setState)

### Layout
- Coherent design token system (8px grid, color-mix, centralized)
- Dual layout modes (horizontal/vertical tabs) cleanly separated
- Container queries for component-level responsive adaptation
- Custom frameless window with 8-direction resize handles

### UI Polish
- Global prefers-reduced-motion handler
- Theme crossfade on structural containers
- Focus-visible on all interactive elements
- Active press states everywhere (consistent scale)
- Skeleton shimmer with theme-aware gradients
- `@starting-style` for message entrance animations
- Comprehensive retro mode override system

## Recommended Action Plan

### Immediate (Critical -- address before shipping)
1. Add `tokio::time::timeout` to `list_agent_sessions` and `get_agent_messages` oneshot receivers
2. Replace O(n) `hasUnresolvedPermission` scan with counter ref
3. Remove inline arrow wrappers on SessionBrowser callbacks in App.tsx

### Sprint 1 (High -- significant quality improvement)
4. Mark sidecar unavailable when stdout reader exits + clear oneshot map
5. Switch all SidecarManager mutex locks to poisoning-recovery pattern
6. Verify `allow-agent-ask-response` capability in production build
7. Remove unnecessary buffer clone in `read_external_file`
8. Apply ref-based accumulation for thinking events (like assistant streaming)
9. Center chat messages with `margin: 0 auto`
10. Add `min-width: 400px` to content area in vertical-tabs mode
11. Virtualize ProjectList with `useVirtualizer`
12. Add modal exit animations

### Sprint 2 (Medium -- incremental improvements)
13. Add `.cargo/config.toml` with `rust-lld` for faster link times
14. Set `withGlobalTauri: false`
15. Memoize ToolCard JSON.stringify; defer to expanded state
16. Fix CodeBlock conditional hooks (move above early return)
17. Add expand/collapse animations to collapsible content
18. Replace raw pixel values with spacing tokens
19. Add entrance animations to ShortcutsOverlay and SessionPanel
20. Debounce theme cache invalidation in anvilTheme()
21. Add copy button success feedback
22. Persist right sidebar width to settings

### Backlog (Low -- nice to have)
23. Use `.into_owned()` on `Cow<str>` instead of `.to_string()`
24. Extract duplicated date algorithm to shared module
25. Add `--text-2xs: 9px` token
26. Override line-height to 1.5 in chat view
27. Use radius tokens for permission buttons and attachment chips
28. Add skeleton loading states to SessionPanel and UsagePage
29. Add vendor chunks for TanStack Virtual and Radix UI
30. Window state persistence via tauri-plugin-window-state

## Pipeline Metadata
- Review date: 2026-03-17
- Phases completed: 1 (Rust Backend), 2 (Tauri IPC), 3 (React Performance), 4 (Layout), 5 (UI Polish), 6 (Consolidated Report)
- Flags applied: none
- Total findings: 99 (3 Critical, 19 High, 42 Medium, 35 Low)
