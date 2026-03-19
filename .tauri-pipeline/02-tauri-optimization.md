# Phase 2: Tauri IPC & Optimization

## Assessment
The IPC architecture is well-designed: Channel API for high-frequency streaming, RAF-throttled rendering, spawn_blocking discipline, and Win32 Job Object for process tree cleanup. The main concerns are around sidecar crash recovery, missing timeouts, and a potentially missing capability permission for production builds.

## What's Done Well
- **Channel API** for agent event streaming (correct pattern for high-frequency data)
- **RAF-throttled streaming renders** in ChatView.tsx coalesces chunks into single re-render per frame
- **Task progress batching** via rAF prevents render flooding
- **`useDeferredValue`** for sidebar prevents blocking main chat rendering
- **Win32 Job Object** ensures entire process tree dies with app
- **RAII handle wrapper** prevents handle leaks
- **StrictMode-safe kill** with deferred killAgent and pendingKillRef
- **Three-tier shutdown** (close stdin → terminate job → kill child)
- **Stable callback refs** in ChatView.tsx avoids stale closures
- **Guard against redundant `setTabs`** in useTabManager
- **Memoized context value** in ProjectsContext
- **Session save debouncing** with flush on beforeunload
- **CSP configuration** blocks XSS from external scripts
- **Fine-grained capabilities** with per-command permissions
- **React Compiler** enabled for automatic memoization
- **Lazy loading** for singleton tab pages
- **Cargo release profile** optimized (codegen-units=1, lto=true, opt-level=3, strip=true)

## Findings

### Critical

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H1 | `commands.rs:508,529` | Missing timeouts on oneshot receivers -- hangs forever if sidecar crashes | Wrap with `tokio::time::timeout(Duration::from_secs(15), rx).await` |

### High

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H2 | `sidecar.rs:147,439` | Orphaned oneshot senders on sidecar death -- memory leak + hang | Clear oneshot map when stdout reader exits |
| H3 | `sidecar.rs` (all locks) | Mutex poisoning cascades -- single panic disables all agent comms | Use `.unwrap_or_else(\|e\| e.into_inner())` consistently |
| H4 | `sidecar.rs` | No sidecar health check -- `available` stays true after crash | Mark unavailable when stdout reader exits; emit "sidecar-died" event |
| L2 | `capabilities/default.json` | Missing `allow-agent-ask-response` permission -- may fail in prod | Add permission to capabilities file; test in release build |

### Medium

| ID | File | Issue | Fix |
|----|------|-------|-----|
| M1 | `sidecar.rs:53-144` | Flat `SidecarEvent` struct (20+ fields) is fragile | Consider `#[serde(tag = "evt")]` enum |
| M2 | `sidecar.rs:431` | Unnecessary `.clone()` on event send path | Check exit before send, then move |
| M3 | `sidecar.rs:430-437` | Double mutex lock per event on exit | Hold lock once for both operations |
| M4 | `commands.rs:561` | `read_external_file` blocked-dir list is narrow | Add `.npmrc`, `.kube`, `.docker` |
| M5 | `tauri.conf.json:14` | `withGlobalTauri: true` exposes IPC surface | Set to false; frontend already uses ES imports |
| M6 | Missing `.cargo/config.toml` | No `rust-lld` linker -- 30-60s link stalls | Add config with `linker = "rust-lld.exe"` |
| M7 | `vite.config.ts` | Missing Terser minification | Add `minify: "terser"` for 5-15% smaller JS |
| M8 | `sidecar.rs:233` | Blocking `npm install` during init delays window | Move to background task after window opens |
| M9 | `sidecar.rs:468-473` | Stdin write not atomic (separate write+newline+flush) | Concatenate newline before single write_all |
| M10 | `ChatView.tsx:722` | `messages.some()` O(n) scan on every render | Scan backward; break after last user message |

### Low

| ID | File | Issue | Fix |
|----|------|-------|-----|
| L1 | `main.rs:69,77` | Settings loaded twice during setup | Reuse first `settings` variable |
| L3 | Missing | No window state persistence | Use `tauri-plugin-window-state` |
| L4 | `vite.config.ts` | TanStack Virtual not in manual chunks | Add to `manualChunks` |
| L5 | `watcher.rs:27` | Debounce thread has no explicit exit | Works in practice; document |
| L6 | `ChatView.tsx:762` | `getCurrentWindow()` called redundantly | Cache reference |

## Key Issues for Frontend Context
- M10: `messages.some()` O(n) scan on every render needs optimization
- M5: `withGlobalTauri` exposes IPC -- should disable for security
- M7: Missing Terser minification in Vite config
- L4: TanStack Virtual not split into vendor chunk
- React Compiler is enabled -- agents should account for automatic memoization
- RAF-throttled streaming is already implemented -- avoid redundant optimization suggestions
