use std::os::windows::process::CommandExt;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::projects::{self, ProjectInfo, Settings, UsageData};
use crate::sidecar::{AgentEvent, SidecarManager};
use crate::usage_stats::{self, TokenUsageStats};
use crate::watcher::ProjectWatcher;

/// Max age for temp files before cleanup (1 hour).
const STALE_FILE_SECS: u64 = 3600;

/// Remove files older than `max_age` from `dir`.
fn cleanup_stale_files(dir: &std::path::Path, max_age: std::time::Duration) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        let cutoff = std::time::SystemTime::now() - max_age;
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.modified().unwrap_or(std::time::UNIX_EPOCH) < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[tauri::command]
pub async fn scan_projects(
    project_dirs: Vec<String>,
    single_project_dirs: Vec<String>,
    labels: std::collections::HashMap<String, String>,
) -> Result<Vec<ProjectInfo>, String> {
    log_info!("scan_projects: dirs={project_dirs:?}, single={single_project_dirs:?}");
    let projs = tokio::task::spawn_blocking(move || projects::scan_projects(&project_dirs, &single_project_dirs, &labels))
        .await
        .map_err(|e| format!("Task failed: {e}"))?;
    log_info!("scan_projects: found {} projects", projs.len());
    Ok(projs)
}

#[tauri::command]
pub async fn load_settings() -> Result<Settings, String> {
    log_info!("load_settings");
    tokio::task::spawn_blocking(|| Ok(projects::load_settings()))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn save_settings(
    watcher: State<'_, Arc<ProjectWatcher>>,
    settings: Settings,
) -> Result<(), String> {
    log_info!("save_settings: dirs={:?}, single={:?}", settings.project_dirs, settings.single_project_dirs);
    let dirs = settings.project_dirs.clone();
    let single_dirs = settings.single_project_dirs.clone();
    tokio::task::spawn_blocking(move || {
        projects::save_settings(&settings).map_err(|e| format!("Failed to save settings: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))??;
    // Update watcher with potentially changed project directories
    watcher.watch_dirs(&dirs, &single_dirs);
    Ok(())
}

#[tauri::command]
pub async fn load_usage() -> Result<UsageData, String> {
    tokio::task::spawn_blocking(|| Ok(projects::load_usage()))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn record_usage(project_path: String) -> Result<(), String> {
    log_info!("record_usage: {project_path}");
    tokio::task::spawn_blocking(move || {
        projects::record_usage(&project_path).map_err(|e| format!("Failed to record usage: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn create_project(
    parent: String,
    name: String,
    git_init: bool,
) -> Result<String, String> {
    log_info!("create_project: parent={parent}, name={name}, git_init={git_init}");
    let result = tokio::task::spawn_blocking(move || projects::create_project(&parent, &name, git_init))
        .await
        .map_err(|e| format!("Task failed: {e}"))?;
    match &result {
        Ok(path) => log_info!("create_project: created at {path}"),
        Err(e) => log_error!("create_project: failed: {e}"),
    }
    result
}

#[tauri::command]
pub async fn save_session(session: serde_json::Value) -> Result<(), String> {
    log_info!("save_session");
    tokio::task::spawn_blocking(move || {
        projects::save_session(&session).map_err(|e| format!("Failed to save session: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub fn set_window_corner_preference(window: tauri::WebviewWindow, retro: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWM_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DEFAULT, DWMWCP_DONOTROUND,
    };
    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(h) = handle.as_raw() else { return };
    let hwnd = HWND(h.hwnd.get() as *mut core::ffi::c_void);
    let preference = if retro { DWMWCP_DONOTROUND } else { DWMWCP_DEFAULT };
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const DWM_WINDOW_CORNER_PREFERENCE as *const core::ffi::c_void,
            core::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
    }
}

#[tauri::command]
pub async fn save_clipboard_image() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Clipboard access failed: {e}"))?;
        let img = clipboard.get_image()
            .map_err(|e| format!("No image in clipboard: {e}"))?;

        let (width, height) = (img.width, img.height);
        log_info!("save_clipboard_image: {width}x{height}");

        const MAX_DIM: usize = 8192;
        if width == 0 || height == 0 || width > MAX_DIM || height > MAX_DIM {
            return Err(format!("Image dimensions {width}x{height} out of range (max {MAX_DIM})"));
        }

        let temp_dir = std::env::temp_dir().join("anvil_clipboard");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;

        cleanup_stale_files(&temp_dir, std::time::Duration::from_secs(STALE_FILE_SECS));

        let id = uuid::Uuid::new_v4();
        let path = temp_dir.join(format!("clipboard_{id}.png"));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Failed to create file: {e}"))?;
        let writer = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(writer, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut png_writer = encoder.write_header()
            .map_err(|e| format!("PNG header error: {e}"))?;
        png_writer.write_image_data(&img.bytes)
            .map_err(|e| format!("PNG write error: {e}"))?;
        let path_str = path.to_string_lossy().to_string();
        log_info!("save_clipboard_image: saved to {path_str}");
        Ok(path_str)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn get_token_usage() -> Result<TokenUsageStats, String> {
    log_info!("get_token_usage: computing 7-day stats");
    tokio::task::spawn_blocking(|| usage_stats::compute_usage(7))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn load_session() -> Result<serde_json::Value, String> {
    log_info!("load_session");
    tokio::task::spawn_blocking(|| Ok(projects::load_session().unwrap_or(serde_json::Value::Null)))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

const MAX_DIR_ENTRIES: usize = 500;

#[tauri::command]
pub async fn list_directory(path: Option<String>) -> Result<Vec<DirEntry>, String> {
    log_info!("list_directory: path={path:?}");
    tokio::task::spawn_blocking(move || {
        // If no path, return Windows drive roots using GetLogicalDrives() WinAPI
        // to avoid blocking on disconnected network/removable drives.
        if path.is_none() {
            let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
            let mut drives = Vec::new();
            for i in 0..26u32 {
                if mask & (1 << i) != 0 {
                    let root = format!("{}:\\", (b'A' + i as u8) as char);
                    drives.push(DirEntry {
                        name: root.clone(),
                        path: root,
                        has_children: true,
                    });
                }
            }
            return Ok(drives);
        }

        let dir = path.unwrap();
        if projects::is_unc(&dir) {
            log_error!("list_directory: UNC paths not supported: {dir}");
            return Err("UNC paths are not supported".to_string());
        }
        if !std::path::Path::new(&dir).is_dir() {
            return Err("Path does not exist or is not a directory".to_string());
        }

        let mut entries = Vec::new();
        let read = std::fs::read_dir(&dir).map_err(|e| {
            log_error!("list_directory: cannot read {dir}: {e}");
            "Unable to read directory".to_string()
        })?;

        for entry in read.flatten() {
            if entries.len() >= MAX_DIR_ENTRIES {
                break;
            }
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skip hidden dirs
            if name.starts_with('.') {
                continue;
            }
            let full = entry.path().to_string_lossy().into_owned();
            // Default true; corrected when children are actually loaded
            entries.push(DirEntry { name, path: full, has_children: true });
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn load_builtin_prompts() -> Result<Vec<crate::prompts::BuiltinPrompt>, String> {
    tokio::task::spawn_blocking(crate::prompts::load_builtin_prompts)
        .await
        .map_err(|e| format!("Task failed: {e}"))
}

#[tauri::command]
pub async fn save_prompt(name: String, description: String, content: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::prompts::save_prompt(&name, &description, &content))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn update_prompt(id: String, name: String, description: String, content: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::prompts::update_prompt(&id, &name, &description, &content))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_prompt(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::prompts::delete_prompt(&id))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

// ── Agent SDK commands ──────────────────────────────────────────────

const ALLOWED_PERM_MODES: &[&str] = &["plan", "acceptEdits", "bypassPermissions"];

/// Validate a permission mode string, falling back to "plan" for unknown values.
fn validate_perm_mode(mode: &str) -> &str {
    if mode.is_empty() || ALLOWED_PERM_MODES.contains(&mode) {
        mode
    } else {
        log_warn!("Invalid perm_mode '{}', falling back to 'plan'", mode);
        "plan"
    }
}

/// Ensure `project_path` is a valid, existing directory — creating it if necessary.
/// Rejects UNC paths and path traversal (`..` components) after canonicalization.
fn ensure_project_dir(project_path: &str) -> Result<(), String> {
    if crate::projects::is_unc(project_path) {
        return Err("UNC paths are not supported".to_string());
    }
    // Reject raw ".." before creating dirs, then verify canonicalized path
    if project_path.contains("..") {
        return Err("Path traversal is not allowed".to_string());
    }
    let dir = std::path::Path::new(project_path);
    if !dir.is_dir() {
        log_warn!("ensure_project_dir: creating missing directory: {project_path}");
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create project directory: {e}"))?;
    }
    // Verify canonicalized path has no traversal components
    let canonical = dir.canonicalize()
        .map_err(|e| format!("Cannot resolve project directory: {e}"))?;
    for component in canonical.components() {
        if let std::path::Component::ParentDir = component {
            return Err("Path traversal is not allowed".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn spawn_agent(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    project_path: String,
    model: String,
    effort: String,
    system_prompt: String,
    perm_mode: String,
    plugins: Vec<String>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available (Node.js not found)".to_string());
    }
    ensure_project_dir(&project_path)?;
    if system_prompt.len() > 100_000 {
        return Err(format!("System prompt too large (max 100000 bytes)"));
    }
    let perm_mode = validate_perm_mode(&perm_mode);
    log_info!("spawn_agent: tab={tab_id}, project={project_path}, model={model}");

    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "create",
        "tabId": tab_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
        "systemPrompt": if system_prompt.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(system_prompt) },
        "permMode": perm_mode,
        "plugins": plugins,
    }))
}

#[tauri::command]
pub fn agent_send(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    sidecar.send_command(&serde_json::json!({
        "cmd": "send",
        "tabId": tab_id,
        "text": text,
    }))
}

#[tauri::command]
pub fn agent_autocomplete(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    input: String,
    context: Vec<serde_json::Value>,
    seq: u32,
) -> Result<(), String> {
    sidecar.send_command(&serde_json::json!({
        "cmd": "autocomplete",
        "tabId": tab_id,
        "input": input,
        "context": context,
        "seq": seq,
    }))
}

#[tauri::command]
pub fn agent_resume(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    session_id: String,
    project_path: String,
    model: String,
    effort: String,
    perm_mode: String,
    plugins: Vec<String>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    ensure_project_dir(&project_path)?;
    let perm_mode = validate_perm_mode(&perm_mode);
    log_info!("agent_resume: tab={tab_id}, session={session_id}");
    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "resume",
        "tabId": tab_id,
        "sessionId": session_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
        "permMode": perm_mode,
        "plugins": plugins,
    }))
}

#[tauri::command]
pub fn agent_fork(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    session_id: String,
    project_path: String,
    model: String,
    effort: String,
    perm_mode: String,
    plugins: Vec<String>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    ensure_project_dir(&project_path)?;
    let perm_mode = validate_perm_mode(&perm_mode);
    log_info!("agent_fork: tab={tab_id}, session={session_id}");
    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "fork",
        "tabId": tab_id,
        "sessionId": session_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
        "permMode": perm_mode,
        "plugins": plugins,
    }))
}

#[tauri::command]
pub fn agent_interrupt(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
) -> Result<(), String> {
    log_info!("agent_interrupt: tab={tab_id}");
    sidecar.send_command(&serde_json::json!({
        "cmd": "interrupt",
        "tabId": tab_id,
    }))
}

#[tauri::command]
pub fn agent_kill(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
) -> Result<(), String> {
    log_info!("agent_kill: tab={tab_id}");
    // Don't unregister channel here — the exit event from the sidecar
    // handles cleanup (sidecar.rs:360). Eagerly unregistering breaks
    // React 18 StrictMode where kill + re-spawn race on the same tabId.
    sidecar.send_command(&serde_json::json!({
        "cmd": "kill",
        "tabId": tab_id,
    }))
}

#[tauri::command]
pub fn agent_permission(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    allow: bool,
    updated_permissions: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut cmd = serde_json::json!({
        "cmd": "permission_response",
        "tabId": tab_id,
        "allow": allow,
    });
    if let Some(perms) = updated_permissions {
        cmd["updatedPermissions"] = perms;
    }
    sidecar.send_command(&cmd)
}

#[tauri::command]
pub fn agent_ask_response(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    sidecar.send_command(&serde_json::json!({
        "cmd": "ask_user_response",
        "tabId": tab_id,
        "answers": answers,
    }))
}

#[tauri::command]
pub fn agent_set_model(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    model: String,
) -> Result<(), String> {
    sidecar.send_command(&serde_json::json!({
        "cmd": "set_model",
        "tabId": tab_id,
        "model": model,
    }))
}

#[tauri::command]
pub async fn list_agent_sessions(
    sidecar: State<'_, Arc<SidecarManager>>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    let key = format!("_sessions_{}", uuid::Uuid::new_v4());
    let rx = sidecar.register_oneshot(&key);
    sidecar.send_command(&serde_json::json!({
        "cmd": "list_sessions",
        "tabId": key,
        "cwd": cwd,
    }))?;

    tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "Sidecar timed out listing sessions".to_string())?
        .map_err(|_| "Sidecar did not respond".to_string())
}

#[tauri::command]
pub async fn get_agent_messages(
    sidecar: State<'_, Arc<SidecarManager>>,
    session_id: String,
    dir: Option<String>,
) -> Result<serde_json::Value, String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    let key = format!("_messages_{}", uuid::Uuid::new_v4());
    let rx = sidecar.register_oneshot(&key);
    sidecar.send_command(&serde_json::json!({
        "cmd": "get_messages",
        "tabId": key,
        "sessionId": session_id,
        "dir": dir,
    }))?;

    tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "Sidecar timed out fetching messages".to_string())?
        .map_err(|_| "Sidecar did not respond".to_string())
}

#[tauri::command]
pub async fn refresh_commands(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    let key = format!("_commands_{}", uuid::Uuid::new_v4());
    let rx = sidecar.register_oneshot(&key);
    sidecar.send_command(&serde_json::json!({
        "cmd": "refreshCommands",
        "tabId": key,
        "sessionTabId": tab_id,
    }))?;

    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Sidecar command refresh timed out".to_string())?
        .map_err(|_| "Sidecar did not respond".to_string())
}

// ── File access commands ────────────────────────────────────────────

const MAX_EXTERNAL_FILE_SIZE: u64 = 1_048_576; // 1 MB

const BLOCKED_DIRS: &[&str] = &[".ssh", ".gnupg", ".claude", ".aws", ".config", ".npmrc", ".kube", ".docker"];

/// Validate an external file path: canonicalize, reject UNC, block sensitive dirs.
fn validate_external_path(path: &str) -> Result<std::path::PathBuf, String> {
    if crate::projects::is_unc(path) {
        return Err("UNC paths are not supported".to_string());
    }
    let p = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {e}"))?;
    // Block sensitive directories
    for component in p.components() {
        if let std::path::Component::Normal(s) = component {
            let s = s.to_string_lossy();
            if BLOCKED_DIRS.iter().any(|b| s.eq_ignore_ascii_case(b)) {
                log_warn!("validate_external_path: blocked sensitive path: {path}");
                return Err("Access to sensitive directories is blocked".to_string());
            }
        }
    }
    Ok(p)
}

/// Read the content of a file from anywhere on the filesystem.
/// Used to inline attached file content into agent messages.
/// Handles UTF-8 and falls back to lossy conversion for other encodings.
#[tauri::command]
pub fn read_external_file(path: String) -> Result<String, String> {
    log_info!("read_external_file: {path}");
    let p = validate_external_path(&path)?;
    if !p.is_file() {
        return Err("File does not exist".to_string());
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("Cannot read file: {e}"))?;
    if meta.len() > MAX_EXTERNAL_FILE_SIZE {
        return Err(format!("File too large ({} bytes, max {})", meta.len(), MAX_EXTERNAL_FILE_SIZE));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Cannot read file: {e}"))?;
    // Try UTF-8 first, then lossy fallback for Windows-1252 etc.
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    })
}

// ── Claude CLI commands ─────────────────────────────────────────────

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CLI_TIMEOUT_SECS: u64 = 30;

/// Find the `claude` CLI executable on the system.
/// Prefers the known APPDATA/npm location over PATH to avoid PATH-hijack risks.
fn find_claude_cli() -> Option<String> {
    // Prefer known safe location first (npm global install)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let npm_global = std::path::PathBuf::from(&appdata)
            .join("npm")
            .join("claude.cmd");
        if npm_global.exists() {
            return Some(npm_global.to_string_lossy().to_string());
        }
    }
    // Fall back to PATH (covers scoop, custom installs, etc.)
    if let Ok(path) = which::which("claude") {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

#[derive(serde::Serialize)]
pub struct CliResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    /// URL extracted from output (for /login — auto-open in browser)
    pub url: Option<String>,
}

/// Run a Claude CLI subcommand (login, logout, status, doctor).
#[tauri::command]
pub async fn run_claude_command(subcommand: String) -> Result<CliResult, String> {
    // Whitelist allowed subcommands
    let allowed = ["login", "logout", "status", "doctor"];
    if !allowed.contains(&subcommand.as_str()) {
        return Err(format!("Command not allowed: {subcommand}"));
    }

    let claude_path = find_claude_cli()
        .ok_or("Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code")?;

    log_info!("run_claude_command: {claude_path} {subcommand}");

    let is_login = subcommand == "login";
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(CLI_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || {
            std::process::Command::new(&claude_path)
                .arg(&subcommand)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .and_then(|child| child.wait_with_output())
                .map_err(|e| format!("Failed to run claude {subcommand}: {e}"))
        }),
    )
    .await
    .map_err(|_| "Claude CLI timed out (30s)".to_string())?
    .map_err(|e| format!("Task failed: {e}"))??;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Extract OAuth URL from login output only (other commands may print unrelated URLs)
    let url = if is_login {
        stdout
            .lines()
            .chain(stderr.lines())
            .find_map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("https://") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };

    log_info!("run_claude_command: exit={}, url={:?}", output.status.success(), url);

    Ok(CliResult {
        success: output.status.success(),
        stdout,
        stderr,
        url,
    })
}

// ── File write command ──────────────────────────────────────────────

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    log_info!("write_text_file: {path}");
    // Validate path: reject UNC, block sensitive dirs (same as read_external_file)
    validate_external_path(&path)?;
    if content.len() as u64 > MAX_EXTERNAL_FILE_SIZE {
        return Err(format!("Content too large ({} bytes, max {})", content.len(), MAX_EXTERNAL_FILE_SIZE));
    }
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, content).map_err(|e| format!("Failed to write file: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

// ── Marketplace commands ────────────────────────────────────────────

#[tauri::command]
pub fn get_marketplace_plugins() -> Vec<String> {
    crate::marketplace::get_plugin_paths()
}

#[tauri::command]
pub fn set_marketplace_global(enabled: bool) -> Result<(), String> {
    if enabled {
        crate::marketplace::enable_global()
    } else {
        crate::marketplace::disable_global()
    }
}
