use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use tauri::ipc::Channel;
use uuid::Uuid;
use win32job::Job;

use crate::pty::PtySession;

const MAX_SESSIONS: usize = 10;
const OUTPUT_BATCH_MS: u64 = 16;
const MAX_WRITE_SIZE: usize = 65536;

/// Heartbeat timeout: 60s gives 12× safety margin over the 5s heartbeat interval.
/// Previously 30s (only 6×), which risked reaping live sessions under main-thread load.
const HEARTBEAT_TIMEOUT_SECS: u64 = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyEvent {
    Output { data: String }, // base64-encoded binary data
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
        if sessions.len() >= MAX_SESSIONS {
            return Err(format!("Maximum {MAX_SESSIONS} concurrent sessions reached"));
        }

        let pty = PtySession::spawn(command, working_dir, env, cols, rows)
            .map_err(|e| format!("Failed to spawn PTY: {e}"))?;
        let pty = Arc::new(pty);

        let session_id = Uuid::new_v4().to_string();

        // Shared flag ensures only one of {reader-panic path, exit-watcher} sends Exit.
        // Without this, a reader panic sends Exit{-1} and the exit watcher also fires,
        // producing two Exit events and two updateTab calls with conflicting codes.
        let exit_sent = Arc::new(AtomicBool::new(false));

        // Output reader thread with batching.
        //
        // Shutdown mechanism: when a session is killed via kill(), TerminateProcess
        // is called on the child process. This breaks the pipe, causing ReadFile to
        // return an error, which exits this loop. The Arc<PtySession> held by this
        // thread is then dropped, allowing PtySession::drop to run and close all
        // remaining handles once no other references exist.
        let pty_reader = Arc::clone(&pty);
        let channel = on_event.clone();
        let reader_sid = session_id.clone();
        let reader_exit_sent = Arc::clone(&exit_sent);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let buf_size = 4096;
                let mut buf = [0u8; 4096];
                let mut accum: Vec<u8> = Vec::with_capacity(8192);
                let mut last_flush = Instant::now();
                loop {
                    match pty_reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            accum.extend_from_slice(&buf[..n]);
                            let elapsed = last_flush.elapsed() >= Duration::from_millis(OUTPUT_BATCH_MS);
                            let full = accum.len() >= 8192;
                            // Flush if: batch timer expired, buffer is full, or we got
                            // a partial read (less than buffer size) indicating the
                            // process is idle and we should display output promptly.
                            let partial = n < buf_size;
                            if elapsed || full || partial {
                                let data = STANDARD.encode(&std::mem::take(&mut accum));
                                if channel.send(PtyEvent::Output { data }).is_err() {
                                    break;
                                }
                                last_flush = Instant::now();
                            }
                        }
                        Err(_) => break,
                    }
                }
                if !accum.is_empty() {
                    let data = STANDARD.encode(&accum);
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
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        entry.pty.write(data).map_err(|e| format!("Write failed: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: i16, rows: i16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        entry.pty.resize(cols, rows).map_err(|e| format!("Resize failed: {e}"))
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = sessions.remove(session_id) {
            entry.pty.kill();
            Ok(())
        } else {
            Err(format!("Session {session_id} not found"))
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
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for (_, entry) in sessions.drain() {
            entry.pty.kill();
        }
    }

    pub fn start_reaper(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(10));
                // catch_unwind ensures the reaper never dies from a panic.
                // If one iteration panics, we log and continue the next cycle.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    let stale: Vec<String> = sessions
                        .iter()
                        .filter(|(_, entry)| {
                            entry.last_heartbeat.elapsed() > Duration::from_secs(HEARTBEAT_TIMEOUT_SECS)
                        })
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in stale {
                        if let Some(entry) = sessions.remove(&id) {
                            entry.pty.kill();
                        }
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
