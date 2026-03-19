# Phase 1: Rust Backend Review

## Assessment
The Rust backend is well-structured (~1,700 lines across 10 files). It demonstrates thoughtful engineering: Win32 Job Object for process tree cleanup, trailing-edge debounce for filesystem watching, atomic file writes with tmp+rename, and proper `spawn_blocking` for all blocking I/O in async commands.

## What's Done Well
- **Process tree cleanup** (`sidecar.rs:519-545`): Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + RAII `JobHandle` wrapper
- **Atomic file writes** (`projects.rs:179-184, 209-226`): Write-to-tmp then rename prevents data corruption
- **spawn_blocking discipline** (`commands.rs` throughout): Every blocking I/O correctly offloaded
- **Git timeout + output limit** (`projects.rs:302-376`): Dedicated reader thread with `recv_timeout` and byte limit
- **Panic isolation** (`projects.rs:452-457`): `catch_unwind` around individual project scans
- **Log sanitization** (`logging.rs:88`): Newlines escaped to prevent log injection
- **Input validation** (`projects.rs:485-515`): Path traversal, Windows reserved names, hidden dirs
- **NTFS case-insensitive dedup** (`projects.rs:420-425`)
- **Single-instance plugin** (`main.rs:51-61`) with window focus restoration
- **All 5 unsafe blocks** are properly encapsulated with correct Win32 API usage

## Findings

### Critical
None found.

### High

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H1 | `commands.rs:588` | `read_external_file` clones entire file buffer (up to 1MB) unnecessarily before UTF-8 check | Use `String::from_utf8(bytes)` consuming the vec, then `.into_bytes()` on error for lossy fallback |
| H2 | `commands.rs:508, 529` | `list_agent_sessions` and `get_agent_messages` await oneshot with no timeout -- hangs forever if sidecar crashes | Wrap with `tokio::time::timeout(Duration::from_secs(30), rx).await` |
| H3 | `sidecar.rs:298,307,356,430,436,466,489,500,507` | Mutex `.unwrap()` on locks -- if stdout reader thread panics, all subsequent calls crash the app | Use `.unwrap_or_else(\|e\| e.into_inner())` consistently, or switch to `parking_lot::Mutex` |

### Medium

| ID | File | Issue | Fix |
|----|------|-------|-----|
| M1 | `sidecar.rs:53-144` | `SidecarEvent` is a flat struct with 20+ optional fields; every parse allocates all fields | Consider `#[serde(tag = "evt")]` enum for type safety and efficiency |
| M2 | `projects.rs:279, 257` | `load_usage()` reads without `USAGE_LOCK`; could see stale data during concurrent `record_usage` | Acceptable given atomic rename, but worth a comment |
| M3 | `sidecar.rs:494-510` | `shutdown()` re-acquires all locks in `Drop` redundantly | Add `AtomicBool` shutdown flag |
| M4 | `sidecar.rs:431` | `AgentEvent::clone()` on channel send when only one receiver exists | Remove `.clone()` -- event is consumed after send |
| M5 | `logging.rs:152-165`, `usage_stats.rs:366-379` | Duplicated `days_to_ymd`/`days_to_date` implementations | Extract to shared utility module |
| M6 | All modules | `Result<T, String>` error handling loses type info | Consider `thiserror` enum (low priority) |
| M7 | `usage_stats.rs:355-364` | UTC date computation vs potentially local-time Claude Code timestamps | Could cause off-by-one day filtering near midnight |

### Low

| ID | File | Issue | Fix |
|----|------|-------|-----|
| L1 | Multiple files | `to_string_lossy().to_string()` allocates even for valid UTF-8 | Use `.into_owned()` on the `Cow` |
| L3 | `sidecar.rs:548-577` | `find_node()` returns `String` instead of `PathBuf` | Return `Option<PathBuf>` for idiomatic API |
| L5 | Multiple files | Duplicated error message string literals | Extract to constants or error enum |
| L6 | `projects.rs:442-465` | Manual chunked thread pool instead of `rayon` | Negligible impact for typical project counts |

## Key Issues for Phase 2 Context
- H2: Missing timeouts on oneshot receivers means hung IPC calls if sidecar dies
- H3: Mutex poisoning in sidecar.rs could cascade into app crash
- M1: SidecarEvent flat struct is tightly coupled to sidecar.js JSON format -- fragile for IPC evolution
- M4: Unnecessary cloning on the IPC event path
