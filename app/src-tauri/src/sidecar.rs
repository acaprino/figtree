use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::*;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Events emitted by the sidecar, forwarded to the frontend via Tauri IPC.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    Assistant { text: String, streaming: bool },
    ToolUse { tool: String, input: serde_json::Value },
    ToolResult { tool: String, output: String, success: bool },
    Permission { tool: String, description: String, tool_use_id: String, suggestions: serde_json::Value },
    Ask { questions: serde_json::Value },
    InputRequired {},
    Thinking { text: String },
    Status { status: String, model: String, session_id: String },
    Progress { message: String },
    Result {
        cost: f64,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        turns: u32,
        duration_ms: u64,
        is_error: bool,
        session_id: String,
        context_window: u64,
    },
    Todo { todos: serde_json::Value },
    Autocomplete { suggestions: Vec<String>, seq: u32 },
    RateLimit { utilization: f64 },
    CommandsInit { commands: serde_json::Value, agents: serde_json::Value },
    TaskStarted { task_id: String, description: String, task_type: String },
    TaskProgress { task_id: String, description: String, total_tokens: u64, tool_uses: u32, duration_ms: u64, last_tool_name: String, summary: String },
    TaskNotification { task_id: String, status: String, summary: String, total_tokens: u64, tool_uses: u32, duration_ms: u64 },
    Interrupted {},
    Error { code: String, message: String },
    Exit { code: i32 },
}

/// Sidecar JSON event from stdout (deserialized).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEvent {
    evt: String,
    #[serde(default)]
    tab_id: String,
    // Optional fields — different events use different subsets
    #[serde(default)]
    text: String,
    #[serde(default)]
    streaming: bool,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    input: Option<serde_json::Value>,
    #[serde(default)]
    output: String,
    #[serde(default)]
    success: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    permission_suggestions: Option<serde_json::Value>,
    // For ask_user events
    #[serde(default)]
    questions: Option<serde_json::Value>,
    #[serde(default)]
    tool_use_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: serde_json::Value,
    #[serde(default)]
    cost: f64,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_write_tokens: u64,
    #[serde(default)]
    turns: u32,
    #[serde(default)]
    duration_ms: u64,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    context_window: u64,
    // For list_sessions response
    #[serde(default)]
    list: Option<serde_json::Value>,
    // For get_messages response
    #[serde(default)]
    messages: Option<serde_json::Value>,
    // For todo events
    #[serde(default)]
    todos: Option<serde_json::Value>,
    // For autocomplete response
    #[serde(default)]
    suggestions: Option<Vec<String>>,
    #[serde(default)]
    seq: u32,
    // For rate limit events
    #[serde(default)]
    utilization: f64,
    // For commands/agents responses
    #[serde(default)]
    commands: Option<serde_json::Value>,
    #[serde(default)]
    agents: Option<serde_json::Value>,
    // For task events (subagent tracking)
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    task_type: String,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    tool_uses: u32,
    #[serde(default)]
    last_tool_name: String,
    #[serde(default)]
    summary: String,
}

type ChannelMap = Arc<RwLock<HashMap<String, Channel<AgentEvent>>>>;
type OneshotMap = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

pub struct SidecarManager {
    stdin: Mutex<Option<std::process::ChildStdin>>,
    channels: ChannelMap,
    oneshots: OneshotMap,
    available: Arc<AtomicBool>,
    _process: Mutex<Option<Child>>,
    /// Win32 Job Object — kills all child processes when closed.
    _job: Mutex<Option<JobHandle>>,
}

/// RAII wrapper for a Win32 Job Object handle.
struct JobHandle(HANDLE);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); }
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        let manager = Self {
            stdin: Mutex::new(None),
            channels: Arc::new(RwLock::new(HashMap::new())),
            oneshots: Arc::new(Mutex::new(HashMap::new())),
            available: Arc::new(AtomicBool::new(false)),
            _process: Mutex::new(None),
            _job: Mutex::new(None),
        };

        // Try to find node.exe and start the sidecar
        match find_node() {
            Some(node_path) => {
                log_info!("sidecar: found node at {}", node_path);

                // Ensure sidecar dependencies are installed
                if let Err(e) = manager.ensure_deps(&node_path) {
                    log_error!("sidecar: failed to install dependencies: {e}");
                    return manager;
                }

                match manager.start_sidecar(&node_path) {
                    Ok(()) => {
                        manager.available.store(true, Ordering::SeqCst);
                        log_info!("sidecar: started successfully");
                    }
                    Err(e) => {
                        log_error!("sidecar: failed to start: {e}");
                    }
                }
            }
            None => {
                log_warn!("sidecar: node.exe not found — agent SDK unavailable");
            }
        }

        manager
    }

    /// Ensure sidecar node_modules are installed. Runs `npm install` if missing.
    fn ensure_deps(&self, node_path: &str) -> Result<(), String> {
        let sidecar_dir = self.resolve_sidecar_dir()?;
        let node_modules = sidecar_dir.join("node_modules");

        if node_modules.exists() {
            log_info!("sidecar: node_modules already present");
            return Ok(());
        }

        log_info!("sidecar: node_modules missing, running npm install in {}", sidecar_dir.display());

        // Find npm — it's usually alongside node
        let node_dir = std::path::Path::new(node_path)
            .parent()
            .ok_or("Cannot determine node directory")?;
        let npm_cmd = if node_dir.join("npm.cmd").exists() {
            node_dir.join("npm.cmd").to_string_lossy().to_string()
        } else if which::which("npm").is_ok() {
            "npm".to_string()
        } else {
            return Err("npm not found — cannot install sidecar dependencies".to_string());
        };

        let output = Command::new(&npm_cmd)
            .args(["install", "--production"])
            .current_dir(&sidecar_dir)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Failed to run npm install: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm install failed: {stderr}"));
        }

        log_info!("sidecar: npm install completed successfully");
        Ok(())
    }

    /// Resolve the sidecar directory (contains package.json and sidecar.js).
    fn resolve_sidecar_dir(&self) -> Result<std::path::PathBuf, String> {
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("Cannot determine exe path: {e}"))?
            .parent()
            .ok_or("Cannot determine exe dir")?
            .to_path_buf();

        // Production: sidecar/ next to exe
        if exe_dir.join("sidecar").join("package.json").exists() {
            return Ok(exe_dir.join("sidecar"));
        }

        // Dev mode: go up from target/debug/ to project root
        let dev_path = exe_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.join("sidecar"));

        match dev_path {
            Some(p) if p.join("package.json").exists() => Ok(p),
            _ => Err("sidecar directory not found".to_string()),
        }
    }

    fn start_sidecar(&self, node_path: &str) -> Result<(), String> {
        let sidecar_dir = self.resolve_sidecar_dir()?;
        let sidecar_path = sidecar_dir.join("sidecar.js");
        if !sidecar_path.exists() {
            return Err("sidecar.js not found".to_string());
        }
        log_info!("sidecar: script at {}", sidecar_path.display());

        let mut child = Command::new(node_path)
            .arg(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        // Create a Win32 Job Object so that all child processes (agent SDK
        // subprocesses) are killed when the job is closed / Anvil exits.
        match create_job_for_child(&child) {
            Ok(job) => {
                log_info!("sidecar: process assigned to job object");
                *self._job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job);
            }
            Err(e) => log_warn!("sidecar: failed to create job object: {e}"),
        }

        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;
        let stdin = child.stdin.take().ok_or("No stdin")?;

        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = Some(stdin);
        *self._process.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

        // Stdout reader thread: parse JSON-lines and route to channels
        let channels = Arc::clone(&self.channels);
        let oneshots = Arc::clone(&self.oneshots);
        let available = Arc::clone(&self.available);
        thread::Builder::new()
            .name("sidecar-stdout".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line: String = match line {
                        Ok(l) => l,
                        Err(e) => {
                            log_error!("sidecar stdout read error: {e}");
                            break;
                        }
                    };

                    if line.is_empty() {
                        continue;
                    }

                    let event: SidecarEvent = match serde_json::from_str(&line) {
                        Ok(e) => e,
                        Err(e) => {
                            log_warn!("sidecar: malformed JSON: {e} — line: {}", &line[..line.len().min(200)]);
                            continue;
                        }
                    };

                    let tab_id = &event.tab_id;

                    // Handle oneshot responses (list_sessions, get_messages, commands)
                    if event.evt == "sessions" || event.evt == "messages" || event.evt == "commands" {
                        let value = if event.evt == "sessions" {
                            event.list.unwrap_or(serde_json::Value::Array(vec![]))
                        } else if event.evt == "messages" {
                            serde_json::json!({
                                "sessionId": event.session_id,
                                "messages": event.messages.unwrap_or(serde_json::Value::Array(vec![]))
                            })
                        } else {
                            serde_json::json!({
                                "commands": event.commands.unwrap_or(serde_json::Value::Array(vec![])),
                                "agents": event.agents.unwrap_or(serde_json::Value::Array(vec![]))
                            })
                        };

                        if let Some(sender) = oneshots.lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id) {
                            let _ = sender.send(value);
                        }
                        continue;
                    }

                    // Convert to AgentEvent and send via channel
                    let agent_event = match event.evt.as_str() {
                        "assistant" => AgentEvent::Assistant { text: event.text, streaming: event.streaming },
                        "tool_use" => AgentEvent::ToolUse { tool: event.tool, input: event.input.unwrap_or(serde_json::Value::Null) },
                        "tool_result" => AgentEvent::ToolResult { tool: event.tool, output: event.output, success: event.success },
                        "permission" => AgentEvent::Permission { tool: event.tool, description: event.description, tool_use_id: event.tool_use_id, suggestions: event.permission_suggestions.unwrap_or(serde_json::Value::Array(vec![])) },
                        "ask_user" => AgentEvent::Ask { questions: event.questions.unwrap_or(serde_json::Value::Array(vec![])) },
                        "input_required" => AgentEvent::InputRequired {},
                        "thinking" => AgentEvent::Thinking { text: event.text },
                        "status" => AgentEvent::Status { status: event.status, model: event.model, session_id: event.session_id },
                        "progress" => AgentEvent::Progress { message: event.message },
                        "result" => AgentEvent::Result {
                            cost: event.cost,
                            input_tokens: event.input_tokens,
                            output_tokens: event.output_tokens,
                            cache_read_tokens: event.cache_read_tokens,
                            cache_write_tokens: event.cache_write_tokens,
                            turns: event.turns,
                            duration_ms: event.duration_ms,
                            is_error: event.is_error,
                            session_id: event.session_id,
                            context_window: event.context_window,
                        },
                        "todo" => AgentEvent::Todo { todos: event.todos.unwrap_or(serde_json::Value::Array(vec![])) },
                        "rateLimit" => AgentEvent::RateLimit { utilization: event.utilization },
                        "commands_init" => AgentEvent::CommandsInit {
                            commands: event.commands.unwrap_or(serde_json::Value::Array(vec![])),
                            agents: event.agents.unwrap_or(serde_json::Value::Array(vec![])),
                        },
                        "task_started" => AgentEvent::TaskStarted {
                            task_id: event.task_id,
                            description: event.description,
                            task_type: event.task_type,
                        },
                        "task_progress" => AgentEvent::TaskProgress {
                            task_id: event.task_id,
                            description: event.description,
                            total_tokens: event.total_tokens,
                            tool_uses: event.tool_uses,
                            duration_ms: event.duration_ms,
                            last_tool_name: event.last_tool_name,
                            summary: event.summary,
                        },
                        "task_notification" => AgentEvent::TaskNotification {
                            task_id: event.task_id,
                            status: event.status,
                            summary: event.summary,
                            total_tokens: event.total_tokens,
                            tool_uses: event.tool_uses,
                            duration_ms: event.duration_ms,
                        },
                        "interrupted" => AgentEvent::Interrupted {},
                        "error" => AgentEvent::Error { code: event.code.as_str().unwrap_or("unknown").to_string(), message: event.message },
                        "exit" => AgentEvent::Exit { code: event.code.as_i64().unwrap_or_else(|| event.code.as_str().and_then(|s| s.parse().ok()).unwrap_or(-1)) as i32 },
                        "autocomplete" => AgentEvent::Autocomplete {
                            suggestions: event.suggestions.unwrap_or_default(),
                            seq: event.seq,
                        },
                        "ready" => {
                            log_info!("sidecar: ready signal received");
                            continue;
                        }
                        other => {
                            log_warn!("sidecar: unknown event type: {other}");
                            continue;
                        }
                    };

                    // Send to the matching channel.
                    // Hot path (streaming): read-lock only — multiple tabs don't block each other.
                    // Cold path (exit): upgrade to write-lock to remove the channel.
                    let is_exit = matches!(&agent_event, AgentEvent::Exit { .. });
                    if is_exit {
                        let mut guard = channels.write().unwrap_or_else(|e| e.into_inner());
                        if let Some(channel) = guard.get(tab_id) {
                            let _ = channel.send(agent_event);
                        }
                        guard.remove(tab_id);
                    } else {
                        let guard = channels.read().unwrap_or_else(|e| e.into_inner());
                        if let Some(channel) = guard.get(tab_id) {
                            let _ = channel.send(agent_event);
                        }
                    }
                }
                // Sidecar stdout closed — mark unavailable and drop all pending oneshots
                log_warn!("sidecar: stdout reader thread exiting — marking unavailable");
                available.store(false, Ordering::SeqCst);
                oneshots.lock().unwrap_or_else(|e| e.into_inner()).clear();
            })
            .map_err(|e| format!("Failed to spawn stdout reader: {e}"))?;

        // Stderr reader thread: log everything
        thread::Builder::new()
            .name("sidecar-stderr".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => log_info!("sidecar stderr: {l}"),
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn stderr reader: {e}"))?;

        Ok(())
    }

    pub fn available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }

    /// Send a JSON command to the sidecar.
    pub fn send_command(&self, cmd: &serde_json::Value) -> Result<(), String> {
        let mut stdin_guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = stdin_guard.as_mut().ok_or("Sidecar not running")?;
        let mut line = serde_json::to_string(cmd).map_err(|e| format!("JSON error: {e}"))?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to sidecar: {e}"))
    }

    /// Register a channel for a tab, so events get routed to it.
    pub fn register_channel(&self, tab_id: &str, channel: Channel<AgentEvent>) {
        self.channels.write().unwrap_or_else(|e| e.into_inner()).insert(tab_id.to_string(), channel);
    }

    /// Register a oneshot for receiving a single response (list_sessions, get_messages).
    pub fn register_oneshot(&self, key: &str) -> tokio::sync::oneshot::Receiver<serde_json::Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.oneshots.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), tx);
        rx
    }

    /// Kill all sessions and shut down the sidecar.
    pub fn shutdown(&self) {
        // Skip if already marked unavailable (prevents redundant shutdown in Drop)
        if !self.available.swap(false, Ordering::SeqCst) {
            return;
        }
        log_info!("sidecar: shutting down");
        // Close stdin — this triggers the sidecar's rl.on('close') handler
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Terminate the job object first — this kills the sidecar AND all its
        // child processes (agent SDK subprocesses) in one shot.
        if let Some(job) = self._job.lock().unwrap_or_else(|e| e.into_inner()).take() {
            log_info!("sidecar: terminating job object (kills process tree)");
            unsafe {
                let _ = TerminateJobObject(job.0, 1);
            }
        }
        // Fallback: kill the direct child if still running
        if let Some(ref mut child) = *self._process.lock().unwrap_or_else(|e| e.into_inner()) {
            let _ = child.kill();
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Create a Win32 Job Object configured to kill all processes on close,
/// and assign the given child process to it.
fn create_job_for_child(child: &Child) -> Result<JobHandle, String> {
    unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null())
            .map_err(|e| format!("CreateJobObjectW: {e}"))?;

        // Configure: kill all processes when the job handle is closed
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| format!("SetInformationJobObject: {e}"))?;

        // Assign the child process to the job
        let raw_handle = child.as_raw_handle();
        let process_handle = HANDLE(raw_handle);
        AssignProcessToJobObject(job, process_handle)
            .map_err(|e| format!("AssignProcessToJobObject: {e}"))?;

        Ok(JobHandle(job))
    }
}

/// Find node.exe on PATH or in known locations.
fn find_node() -> Option<String> {
    // Try PATH first
    if let Ok(path) = which::which("node") {
        return Some(path.to_string_lossy().to_string());
    }

    // Try %LOCALAPPDATA%\anvil\node\node.exe
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let custom = std::path::PathBuf::from(&local)
            .join("anvil")
            .join("node")
            .join("node.exe");
        if custom.exists() {
            return Some(custom.to_string_lossy().to_string());
        }
    }

    // Try common install locations
    let program_files = std::env::var("ProgramFiles").unwrap_or_default();
    if !program_files.is_empty() {
        let node = std::path::PathBuf::from(&program_files)
            .join("nodejs")
            .join("node.exe");
        if node.exists() {
            return Some(node.to_string_lossy().to_string());
        }
    }

    None
}
