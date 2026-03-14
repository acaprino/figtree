use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use uuid::Uuid;
use win32job::Job;

use crate::pty::PtySession;

const MAX_SESSIONS: usize = 10;
const OUTPUT_BATCH_MS: u64 = 16;
const MAX_WRITE_SIZE: usize = 65536;

/// Heartbeat timeout: 60s gives 12x safety margin over the 5s heartbeat interval.
/// The frontend sends an immediate heartbeat on wake from standby (visibilitychange),
/// so this timeout only needs to cover frontend crashes, not standby duration.
const HEARTBEAT_TIMEOUT_SECS: u64 = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyEvent {
    Output { data: String }, // UTF-8 text (lossy-converted from PTY output)
    Exit { code: i32 },
}

struct SessionEntry {
    pty: Arc<PtySession>,
    last_heartbeat: Instant,
}

pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    _job: Job,
}

/// Return the number of trailing bytes that form an incomplete UTF-8 sequence.
/// This lets us hold them back and prepend them to the next read, avoiding
/// replacement characters at chunk boundaries.
fn incomplete_utf8_tail(buf: &[u8]) -> usize {
    // An incomplete sequence can be at most 3 bytes (the start of a 4-byte char).
    // Walk backwards from the end looking for a leading byte.
    let len = buf.len();
    // Check up to the last 3 bytes
    let check_len = len.min(3);
    for i in 1..=check_len {
        let b = buf[len - i];
        if b & 0x80 == 0 {
            // ASCII byte — no incomplete sequence
            return 0;
        }
        if b & 0xC0 == 0xC0 {
            // This is a leading byte. Determine expected sequence length.
            let expected = if b & 0xF8 == 0xF0 {
                4
            } else if b & 0xF0 == 0xE0 {
                3
            } else if b & 0xE0 == 0xC0 {
                2
            } else {
                // Invalid leading byte — treat as complete to avoid holding forever
                return 0;
            };
            if i < expected {
                // We have fewer bytes than the sequence needs — incomplete
                return i;
            }
            // Sequence is complete
            return 0;
        }
        // 0x80..0xBF is a continuation byte — keep scanning for the lead byte
    }
    // All checked bytes are continuation bytes with no lead — give up, treat as complete
    0
}

impl SessionRegistry {
    pub fn new() -> Result<Self, String> {
        let job = Job::create().map_err(|e| format!("Failed to create Job Object: {e}"))?;
        let mut info = job
            .query_extended_limit_info()
            .map_err(|e| format!("Failed to query job info: {e}"))?;
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&mut info)
            .map_err(|e| format!("Failed to set job info: {e}"))?;
        job.assign_current_process()
            .map_err(|e| format!("Failed to assign process to job: {e}"))?;

        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            _job: job,
        })
    }

    pub fn spawn(
        &self,
        command: &str,
        working_dir: &str,
        env: &[(String, String)],
        cols: i16,
        rows: i16,
        on_event: Channel<PtyEvent>,
    ) -> Result<String, String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let current = sessions.len();
        log_info!("session: spawn requested, working_dir={working_dir}, active={current}/{MAX_SESSIONS}");
        if current >= MAX_SESSIONS {
            log_error!("session: spawn rejected — max sessions reached ({MAX_SESSIONS})");
            return Err(format!("Maximum {MAX_SESSIONS} concurrent sessions reached"));
        }

        let pty = PtySession::spawn(command, working_dir, env, cols, rows)
            .map_err(|e| {
                log_error!("session: PTY spawn failed: {e}");
                format!("Failed to spawn PTY: {e}")
            })?;
        let pty = Arc::new(pty);

        let session_id = Uuid::new_v4().to_string();
        log_info!("session: created id={session_id}, pid={}", pty.pid);

        // Shared flag ensures only one of {reader-panic path, exit-watcher} sends Exit.
        // Without this, a reader panic sends Exit{-1} and the exit watcher also fires,
        // producing two Exit events and two updateTab calls with conflicting codes.
        let exit_sent = Arc::new(AtomicBool::new(false));

        // Output reader thread with batching and UTF-8 boundary handling.
        //
        // Shutdown mechanism: when a session is killed via kill(), TerminateProcess
        // is called on the child process AND ClosePseudoConsole breaks the pipe,
        // causing ReadFile to return an error, which exits this loop. The
        // Arc<PtySession> held by this thread is then dropped, allowing
        // PtySession::drop to run and close all remaining handles once no other
        // references exist.
        let pty_reader = Arc::clone(&pty);
        let channel = on_event.clone();
        let reader_sid = session_id.clone();
        let reader_exit_sent = Arc::clone(&exit_sent);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let buf_size = 16384;
                let mut buf = [0u8; 16384];
                let mut accum: Vec<u8> = Vec::with_capacity(32768);
                let mut last_flush = Instant::now();
                // Remainder buffer for incomplete UTF-8 sequences at chunk boundaries.
                // Holds at most 3 bytes (the start of a 2/3/4-byte sequence).
                let mut utf8_remainder: Vec<u8> = Vec::with_capacity(4);
                loop {
                    match pty_reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            accum.extend_from_slice(&buf[..n]);
                            let elapsed = last_flush.elapsed() >= Duration::from_millis(OUTPUT_BATCH_MS);
                            let full = accum.len() >= 32768;
                            // Flush if: batch timer expired, buffer is full, or we got
                            // a partial read (less than buffer size) indicating the
                            // process is idle and we should display output promptly.
                            let partial = n < buf_size;
                            if elapsed || full || partial {
                                // Prepend any leftover bytes from the previous flush
                                if !utf8_remainder.is_empty() {
                                    let mut combined = std::mem::take(&mut utf8_remainder);
                                    combined.append(&mut accum);
                                    accum = combined;
                                }

                                // Check for an incomplete UTF-8 sequence at the tail
                                let tail = incomplete_utf8_tail(&accum);
                                if tail > 0 && tail < accum.len() {
                                    let split_at = accum.len() - tail;
                                    utf8_remainder.extend_from_slice(&accum[split_at..]);
                                    accum.truncate(split_at);
                                }

                                let data = String::from_utf8_lossy(&std::mem::take(&mut accum)).into_owned();
                                if channel.send(PtyEvent::Output { data }).is_err() {
                                    break;
                                }
                                last_flush = Instant::now();
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Flush any remaining data (including utf8_remainder)
                if !utf8_remainder.is_empty() {
                    accum.splice(0..0, utf8_remainder.drain(..));
                }
                if !accum.is_empty() {
                    let data = String::from_utf8_lossy(&accum).into_owned();
                    let _ = channel.send(PtyEvent::Output { data });
                }
            }));
            if result.is_err() {
                eprintln!("PTY reader thread panicked for session {reader_sid}");
                // Only send Exit if the exit watcher hasn't already done so.
                if !reader_exit_sent.swap(true, Ordering::SeqCst) {
                    let _ = channel.send(PtyEvent::Exit { code: -1 });
                }
            }
        });

        // Exit watcher thread
        let pty_waiter = Arc::clone(&pty);
        let exit_channel = on_event;
        let waiter_sid = session_id.clone();
        let waiter_exit_sent = Arc::clone(&exit_sent);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                pty_waiter.wait_for_exit().unwrap_or(-1)
            }));
            let panicked = result.is_err();
            let code = result.unwrap_or(-1);
            log_info!("session: process exited id={waiter_sid}, code={code}");
            // Only send Exit if the reader-panic path hasn't already done so.
            if !waiter_exit_sent.swap(true, Ordering::SeqCst) {
                let _ = exit_channel.send(PtyEvent::Exit { code });
            }
            if panicked {
                eprintln!("PTY exit-watcher thread panicked for session {waiter_sid}");
            }
        });

        sessions.insert(
            session_id.clone(),
            SessionEntry {
                pty,
                last_heartbeat: Instant::now(),
            },
        );

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_WRITE_SIZE {
            return Err(format!("Write size {} exceeds max {MAX_WRITE_SIZE}", data.len()));
        }
        // Clone the Arc under the lock, then drop the lock before doing I/O.
        // The per-session Mutex<HANDLE> inside PtySession serializes writes.
        let pty = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session {session_id} not found"))?;
            Arc::clone(&entry.pty)
        };
        pty.write(data).map_err(|e| format!("Write failed: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: i16, rows: i16) -> Result<(), String> {
        // Clone the Arc under the lock, then drop the lock before doing I/O.
        let pty = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session {session_id} not found"))?;
            Arc::clone(&entry.pty)
        };
        pty.resize(cols, rows).map_err(|e| format!("Resize failed: {e}"))
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let pty = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let remaining = sessions.len().saturating_sub(1);
            log_info!("session: kill requested id={session_id}, remaining={remaining}");
            sessions
                .remove(session_id)
                .map(|entry| entry.pty)
        };
        match pty {
            Some(pty) => {
                pty.kill();
                Ok(())
            }
            None => {
                log_warn!("session: kill target not found id={session_id}");
                Err(format!("Session {session_id} not found"))
            }
        }
    }

    pub fn heartbeat(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = sessions.get_mut(session_id) {
            entry.last_heartbeat = Instant::now();
            Ok(())
        } else {
            Err(format!("Session {session_id} not found"))
        }
    }

    pub fn active_count(&self) -> usize {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn kill_all(&self) {
        // Drain all sessions under the lock, then kill outside the lock.
        let entries: Vec<Arc<PtySession>> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            log_info!("session: kill_all — draining {} sessions", sessions.len());
            sessions.drain().map(|(_, entry)| entry.pty).collect()
        };
        for pty in &entries {
            pty.kill();
        }
        log_info!("session: kill_all — killed {} sessions", entries.len());
    }

    pub fn start_reaper(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        thread::spawn(move || {
            let mut last_check = Instant::now();
            loop {
                thread::sleep(Duration::from_secs(10));
                // catch_unwind ensures the reaper never dies from a panic.
                // If one iteration panics, we log and continue the next cycle.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let elapsed_since_last = last_check.elapsed();
                    last_check = Instant::now();

                    // If significantly more time passed than the 10s sleep interval,
                    // the system was in standby/hibernate. Instant::elapsed() counts
                    // sleep time on Windows, but JS heartbeat timers are frozen during
                    // standby — so all sessions would appear stale. Reset heartbeats
                    // to give the frontend time to reconnect via visibilitychange.
                    {
                        let mut sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if elapsed_since_last > Duration::from_secs(30) {
                            log_info!(
                                "reaper: standby detected ({}s since last check), resetting {} heartbeats",
                                elapsed_since_last.as_secs(),
                                sessions.len()
                            );
                            let now = Instant::now();
                            for entry in sessions.values_mut() {
                                entry.last_heartbeat = now;
                            }
                            return;
                        }

                        // Two-phase reap: collect stale IDs under the lock, then kill outside.
                        // This avoids holding the registry mutex while calling kill(), which
                        // does blocking Win32 calls (TerminateProcess, ClosePseudoConsole).
                    }

                    // Phase 1: collect stale session IDs and their Arcs under the lock
                    let stale: Vec<(String, Arc<PtySession>)> = {
                        let mut sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        let stale_ids: Vec<String> = sessions
                            .iter()
                            .filter(|(_, entry)| {
                                entry.last_heartbeat.elapsed() > Duration::from_secs(HEARTBEAT_TIMEOUT_SECS)
                            })
                            .map(|(id, _)| id.clone())
                            .collect();
                        stale_ids
                            .into_iter()
                            .filter_map(|id| {
                                sessions.remove(&id).map(|entry| (id, entry.pty))
                            })
                            .collect()
                    };

                    // Phase 2: kill outside the lock
                    for (id, pty) in stale {
                        log_info!("reaper: killing stale session {id} (heartbeat timeout)");
                        pty.kill();
                    }
                }));
                if result.is_err() {
                    // Panic was already logged by the global panic hook.
                    // Continue reaping — this thread must not die.
                    eprintln!("Session reaper panicked — continuing");
                }
            }
        });
    }
}
