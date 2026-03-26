use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::*;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    CommandsInit { commands: serde_json::Value, agents: serde_json::Value, models: serde_json::Value },
    TaskStarted { task_id: String, description: String, task_type: String },
    TaskProgress { task_id: String, description: String, total_tokens: u64, tool_uses: u32, duration_ms: u64, last_tool_name: String, summary: String },
    TaskNotification { task_id: String, status: String, summary: String, total_tokens: u64, tool_uses: u32, duration_ms: u64 },
    Interrupted {},
    Error { code: String, message: String },
    Exit { code: i32 },
}

/// Sidecar JSON event from stdout — tagged enum for compile-time field safety.
/// Each variant declares only its expected fields; unknown fields are silently
/// ignored (serde default). Missing required fields cause a deserialization error.
#[derive(Debug, Deserialize)]
#[serde(tag = "evt")]
enum SidecarEvent {
    #[serde(rename = "assistant")]
    Assistant { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] text: String, #[serde(default)] streaming: bool },
    #[serde(rename = "tool_use")]
    ToolUse { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] tool: String, input: Option<serde_json::Value> },
    #[serde(rename = "tool_result")]
    ToolResult { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] tool: String, #[serde(default)] output: String, #[serde(default)] success: bool },
    #[serde(rename = "permission")]
    Permission { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] tool: String, #[serde(default)] description: String, #[serde(rename = "toolUseId", default)] tool_use_id: String, #[serde(rename = "permissionSuggestions")] permission_suggestions: Option<serde_json::Value> },
    #[serde(rename = "ask_user")]
    AskUser { #[serde(rename = "tabId")] tab_id: String, questions: Option<serde_json::Value> },
    #[serde(rename = "input_required")]
    InputRequired { #[serde(rename = "tabId")] tab_id: String },
    #[serde(rename = "thinking")]
    Thinking { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] text: String },
    #[serde(rename = "status")]
    Status { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] status: String, #[serde(default)] model: String, #[serde(rename = "sessionId", default)] session_id: String },
    #[serde(rename = "progress")]
    Progress { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] message: String },
    #[serde(rename = "result")]
    Result {
        #[serde(rename = "tabId")] tab_id: String,
        #[serde(default)] cost: f64,
        #[serde(rename = "inputTokens", default)] input_tokens: u64,
        #[serde(rename = "outputTokens", default)] output_tokens: u64,
        #[serde(rename = "cacheReadTokens", default)] cache_read_tokens: u64,
        #[serde(rename = "cacheWriteTokens", default)] cache_write_tokens: u64,
        #[serde(default)] turns: u32,
        #[serde(rename = "durationMs", default)] duration_ms: u64,
        #[serde(rename = "isError", default)] is_error: bool,
        #[serde(rename = "sessionId", default)] session_id: String,
        #[serde(rename = "contextWindow", default)] context_window: u64,
    },
    #[serde(rename = "todo")]
    Todo { #[serde(rename = "tabId")] tab_id: String, todos: Option<serde_json::Value> },
    #[serde(rename = "rateLimit")]
    RateLimit { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] utilization: f64 },
    #[serde(rename = "commands_init")]
    CommandsInit { #[serde(rename = "tabId")] tab_id: String, commands: Option<serde_json::Value>, agents: Option<serde_json::Value>, models: Option<serde_json::Value> },
    #[serde(rename = "task_started")]
    TaskStarted { #[serde(rename = "tabId")] tab_id: String, #[serde(rename = "taskId", default)] task_id: String, #[serde(default)] description: String, #[serde(rename = "taskType", default)] task_type: String },
    #[serde(rename = "task_progress")]
    TaskProgress { #[serde(rename = "tabId")] tab_id: String, #[serde(rename = "taskId", default)] task_id: String, #[serde(default)] description: String, #[serde(rename = "totalTokens", default)] total_tokens: u64, #[serde(rename = "toolUses", default)] tool_uses: u32, #[serde(rename = "durationMs", default)] duration_ms: u64, #[serde(rename = "lastToolName", default)] last_tool_name: String, #[serde(default)] summary: String },
    #[serde(rename = "task_notification")]
    TaskNotification { #[serde(rename = "tabId")] tab_id: String, #[serde(rename = "taskId", default)] task_id: String, #[serde(default)] status: String, #[serde(default)] summary: String, #[serde(rename = "totalTokens", default)] total_tokens: u64, #[serde(rename = "toolUses", default)] tool_uses: u32, #[serde(rename = "durationMs", default)] duration_ms: u64 },
    #[serde(rename = "interrupted")]
    Interrupted { #[serde(rename = "tabId")] tab_id: String },
    #[serde(rename = "error")]
    Error { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] code: serde_json::Value, #[serde(default)] message: String },
    #[serde(rename = "exit")]
    Exit { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] code: serde_json::Value },
    #[serde(rename = "autocomplete")]
    Autocomplete { #[serde(rename = "tabId")] tab_id: String, #[serde(default)] suggestions: Vec<String>, #[serde(default)] seq: u32 },
    // Oneshot responses (not forwarded to tab channels)
    #[serde(rename = "sessions")]
    Sessions { #[serde(rename = "tabId")] tab_id: String, list: Option<serde_json::Value> },
    #[serde(rename = "messages")]
    Messages { #[serde(rename = "tabId")] tab_id: String, #[serde(rename = "sessionId", default)] session_id: String, messages: Option<serde_json::Value> },
    #[serde(rename = "commands")]
    Commands { #[serde(rename = "tabId")] tab_id: String, commands: Option<serde_json::Value>, agents: Option<serde_json::Value>, models: Option<serde_json::Value> },
    #[serde(rename = "ready")]
    Ready { #[serde(rename = "tabId", default)] tab_id: String },
}

impl SidecarEvent {
    fn tab_id(&self) -> &str {
        match self {
            Self::Assistant { tab_id, .. } | Self::ToolUse { tab_id, .. } | Self::ToolResult { tab_id, .. }
            | Self::Permission { tab_id, .. } | Self::AskUser { tab_id, .. } | Self::InputRequired { tab_id, .. }
            | Self::Thinking { tab_id, .. } | Self::Status { tab_id, .. } | Self::Progress { tab_id, .. }
            | Self::Result { tab_id, .. } | Self::Todo { tab_id, .. } | Self::RateLimit { tab_id, .. }
            | Self::CommandsInit { tab_id, .. } | Self::TaskStarted { tab_id, .. }
            | Self::TaskProgress { tab_id, .. } | Self::TaskNotification { tab_id, .. }
            | Self::Interrupted { tab_id, .. } | Self::Error { tab_id, .. } | Self::Exit { tab_id, .. }
            | Self::Autocomplete { tab_id, .. } | Self::Sessions { tab_id, .. }
            | Self::Messages { tab_id, .. } | Self::Commands { tab_id, .. }
            | Self::Ready { tab_id, .. } => tab_id,
        }
    }
}

type ChannelMap = Arc<RwLock<HashMap<String, Channel<AgentEvent>>>>;
type OneshotMap = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

pub struct SidecarManager {
    stdin: Mutex<Option<std::process::ChildStdin>>,
    channels: ChannelMap,
    oneshots: OneshotMap,
    available: Arc<AtomicBool>,
    /// Generation counter — incremented on each start_sidecar. Old reader threads
    /// only set available=false if their generation matches, preventing stale clobber.
    generation: Arc<AtomicU64>,
    _process: Mutex<Option<Child>>,
    /// Win32 Job Object — kills all child processes when closed.
    _job: Mutex<Option<JobHandle>>,
    /// Cached node path for auto-restart.
    node_path: Mutex<Option<String>>,
    /// Mutual exclusion for restart — prevents concurrent try_restart from double-spawning.
    restart_lock: Mutex<()>,
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
            generation: Arc::new(AtomicU64::new(0)),
            _process: Mutex::new(None),
            _job: Mutex::new(None),
            node_path: Mutex::new(None),
            restart_lock: Mutex::new(()),
        };

        // Try to find node.exe and start the sidecar
        match find_node() {
            Some(node_path) => {
                log_info!("sidecar: found node at {}", node_path);
                *manager.node_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(node_path.clone());

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
            .creation_flags(CREATE_NO_WINDOW)
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
            // CREATE_NO_WINDOW: suppresses console allocation for the sidecar
            // and all its child processes (SDK Bash tool, etc.), preventing the
            // CMD window flash on Windows. ShellExecute / GUI apps still work fine.
            // CREATE_NEW_PROCESS_GROUP omitted — Job Object handles process tree cleanup.
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        // Create a Win32 Job Object so that all child processes (agent SDK
        // subprocesses) are killed when the job is closed / Figtree exits.
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
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = Arc::clone(&self.generation);
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

                    let tab_id = event.tab_id().to_string();

                    // Handle oneshot responses (not forwarded to tab channels)
                    match &event {
                        SidecarEvent::Sessions { list, .. } => {
                            let value = list.clone().unwrap_or(serde_json::Value::Array(vec![]));
                            if let Some(sender) = oneshots.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id) {
                                let _ = sender.send(value);
                            }
                            continue;
                        }
                        SidecarEvent::Messages { session_id, messages, .. } => {
                            let value = serde_json::json!({
                                "sessionId": session_id,
                                "messages": messages.clone().unwrap_or(serde_json::Value::Array(vec![]))
                            });
                            if let Some(sender) = oneshots.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id) {
                                let _ = sender.send(value);
                            }
                            continue;
                        }
                        SidecarEvent::Commands { commands, agents, models, .. } => {
                            let value = serde_json::json!({
                                "commands": commands.clone().unwrap_or(serde_json::Value::Array(vec![])),
                                "agents": agents.clone().unwrap_or(serde_json::Value::Array(vec![])),
                                "models": models.clone().unwrap_or(serde_json::Value::Array(vec![]))
                            });
                            if let Some(sender) = oneshots.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id) {
                                let _ = sender.send(value);
                            }
                            continue;
                        }
                        SidecarEvent::Ready { .. } => {
                            log_info!("sidecar: ready signal received");
                            continue;
                        }
                        _ => {}
                    }

                    // Convert to AgentEvent and send via channel
                    let agent_event = match event {
                        SidecarEvent::Assistant { text, streaming, .. } => {
                            AgentEvent::Assistant { text, streaming }
                        }
                        SidecarEvent::ToolUse { tool, input, .. } => {
                            log_debug!("agent[{}]: tool_use tool={}", tab_id, tool);
                            AgentEvent::ToolUse { tool, input: input.unwrap_or(serde_json::Value::Null) }
                        }
                        SidecarEvent::ToolResult { tool, output, success, .. } => {
                            if !success {
                                log_warn!("agent[{}]: tool_result FAILED tool={} output={}", tab_id, tool, &output[..output.len().min(300)]);
                            } else {
                                log_debug!("agent[{}]: tool_result ok tool={}", tab_id, tool);
                            }
                            AgentEvent::ToolResult { tool, output, success }
                        }
                        SidecarEvent::Permission { tool, description, tool_use_id, permission_suggestions, .. } => {
                            log_info!("agent[{}]: permission request tool={} desc={}", tab_id, tool, &description[..description.len().min(200)]);
                            AgentEvent::Permission { tool, description, tool_use_id, suggestions: permission_suggestions.unwrap_or(serde_json::Value::Array(vec![])) }
                        }
                        SidecarEvent::AskUser { questions, .. } => {
                            AgentEvent::Ask { questions: questions.unwrap_or(serde_json::Value::Array(vec![])) }
                        }
                        SidecarEvent::InputRequired { .. } => AgentEvent::InputRequired {},
                        SidecarEvent::Thinking { text, .. } => AgentEvent::Thinking { text },
                        SidecarEvent::Status { status, model, session_id, .. } => {
                            log_info!("agent[{}]: status={} model={} session={}", tab_id, status, model, session_id);
                            AgentEvent::Status { status, model, session_id }
                        }
                        SidecarEvent::Progress { message, .. } => AgentEvent::Progress { message },
                        SidecarEvent::Result { cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, duration_ms, is_error, session_id, context_window, .. } => {
                            log_info!("agent[{}]: result cost=${:.4} tokens={}in/{}out turns={} {}ms is_error={} session={}",
                                tab_id, cost, input_tokens, output_tokens, turns, duration_ms, is_error, session_id);
                            AgentEvent::Result { cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, duration_ms, is_error, session_id, context_window }
                        }
                        SidecarEvent::Todo { todos, .. } => {
                            AgentEvent::Todo { todos: todos.unwrap_or(serde_json::Value::Array(vec![])) }
                        }
                        SidecarEvent::RateLimit { utilization, .. } => AgentEvent::RateLimit { utilization },
                        SidecarEvent::CommandsInit { commands, agents, models, .. } => {
                            AgentEvent::CommandsInit {
                                commands: commands.unwrap_or(serde_json::Value::Array(vec![])),
                                agents: agents.unwrap_or(serde_json::Value::Array(vec![])),
                                models: models.unwrap_or(serde_json::Value::Array(vec![])),
                            }
                        }
                        SidecarEvent::TaskStarted { task_id, description, task_type, .. } => {
                            AgentEvent::TaskStarted { task_id, description, task_type }
                        }
                        SidecarEvent::TaskProgress { task_id, description, total_tokens, tool_uses, duration_ms, last_tool_name, summary, .. } => {
                            AgentEvent::TaskProgress { task_id, description, total_tokens, tool_uses, duration_ms, last_tool_name, summary }
                        }
                        SidecarEvent::TaskNotification { task_id, status, summary, total_tokens, tool_uses, duration_ms, .. } => {
                            AgentEvent::TaskNotification { task_id, status, summary, total_tokens, tool_uses, duration_ms }
                        }
                        SidecarEvent::Interrupted { .. } => AgentEvent::Interrupted {},
                        SidecarEvent::Error { code, message, .. } => {
                            let code_str = code.as_str().unwrap_or("unknown").to_string();
                            log_error!("agent[{}]: ERROR code={} message={}", tab_id, code_str, &message[..message.len().min(500)]);
                            AgentEvent::Error { code: code_str, message }
                        }
                        SidecarEvent::Exit { code, .. } => {
                            let exit_code = code.as_i64().unwrap_or_else(|| code.as_str().and_then(|s| s.parse().ok()).unwrap_or(-1)) as i32;
                            log_info!("agent[{}]: exit code={}", tab_id, exit_code);
                            AgentEvent::Exit { code: exit_code }
                        }
                        SidecarEvent::Autocomplete { suggestions, seq, .. } => {
                            AgentEvent::Autocomplete { suggestions, seq }
                        }
                        // Oneshot/Ready variants already handled above
                        SidecarEvent::Sessions { .. } | SidecarEvent::Messages { .. } | SidecarEvent::Commands { .. } | SidecarEvent::Ready { .. } => unreachable!(),
                    };

                    // Send to the matching channel.
                    // Hot path (streaming): read-lock only — multiple tabs don't block each other.
                    // Cold path (exit): upgrade to write-lock to remove the channel.
                    let is_exit = matches!(&agent_event, AgentEvent::Exit { .. });
                    if is_exit {
                        let mut guard = channels.write().unwrap_or_else(|e| e.into_inner());
                        if let Some(channel) = guard.get(&tab_id) {
                            let _ = channel.send(agent_event);
                        }
                        guard.remove(&tab_id);
                    } else {
                        let guard = channels.read().unwrap_or_else(|e| e.into_inner());
                        if let Some(channel) = guard.get(&tab_id) {
                            let _ = channel.send(agent_event);
                        }
                    }
                }
                // Sidecar stdout closed — only mark unavailable if we're still the current generation.
                // A newer sidecar may have started via try_restart; don't clobber its available flag.
                if generation.load(Ordering::SeqCst) == my_gen {
                    log_warn!("sidecar: stdout reader thread exiting — marking unavailable");
                    available.store(false, Ordering::SeqCst);
                    oneshots.lock().unwrap_or_else(|e| e.into_inner()).clear();

                    // Notify all active tabs that the sidecar died so they don't freeze as zombies
                    let mut guard = channels.write().unwrap_or_else(|e| e.into_inner());
                    for (tab_id, channel) in guard.drain() {
                        log_warn!("sidecar: notifying tab {} of sidecar death", tab_id);
                        let _ = channel.send(AgentEvent::Error {
                            code: "sidecar_died".to_string(),
                            message: "Sidecar process terminated unexpectedly".to_string(),
                        });
                        let _ = channel.send(AgentEvent::Exit { code: -1 });
                    }
                } else {
                    log_info!("sidecar: old stdout reader thread exiting (superseded by restart)");
                }
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
                        Err(e) => {
                            log_warn!("sidecar stderr read error: {e}");
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn stderr reader: {e}"))?;

        Ok(())
    }

    pub fn available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }

    /// Attempt to restart the sidecar if it died. Returns true if available after attempt.
    pub fn try_restart(&self) -> bool {
        if self.available() {
            return true;
        }
        // Mutual exclusion: prevent concurrent callers from double-spawning
        let _guard = self.restart_lock.lock().unwrap_or_else(|e| e.into_inner());
        // Re-check after acquiring lock — another thread may have restarted already
        if self.available() {
            return true;
        }
        let node_path = self.node_path.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(node_path) = node_path else {
            log_warn!("sidecar: cannot restart — no node path cached");
            return false;
        };
        log_info!("sidecar: attempting restart...");
        // Clean up old process state
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self._process.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self._job.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Drop stale oneshots — they'll never get responses from the dead sidecar
        self.oneshots.lock().unwrap_or_else(|e| e.into_inner()).clear();
        // Notify all active tabs before clearing channels
        {
            let mut guard = self.channels.write().unwrap_or_else(|e| e.into_inner());
            for (tab_id, channel) in guard.drain() {
                log_warn!("sidecar: notifying tab {} of restart", tab_id);
                let _ = channel.send(AgentEvent::Error {
                    code: "sidecar_restarting".to_string(),
                    message: "Sidecar process is restarting".to_string(),
                });
                let _ = channel.send(AgentEvent::Exit { code: -1 });
            }
        }

        // Re-check deps in case node_modules were deleted while running
        if let Err(e) = self.ensure_deps(&node_path) {
            log_error!("sidecar: restart deps check failed: {e}");
            return false;
        }

        match self.start_sidecar(&node_path) {
            Ok(()) => {
                self.available.store(true, Ordering::SeqCst);
                log_info!("sidecar: restart successful");
                true
            }
            Err(e) => {
                log_error!("sidecar: restart failed: {e}");
                false
            }
        }
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
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
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

    // Try %LOCALAPPDATA%\figtree\node\node.exe
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let custom = std::path::PathBuf::from(&local)
            .join("figtree")
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
