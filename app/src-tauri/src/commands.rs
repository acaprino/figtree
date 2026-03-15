use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::tools;
use crate::projects::{self, ProjectInfo, Settings, UsageData};
use crate::session::{PtyEvent, SessionRegistry};
use crate::sidecar::{AgentEvent, SidecarManager};
use crate::usage_stats::{self, TokenUsageStats};
use crate::watcher::ProjectWatcher;

/// Max system prompt size (100 KB).
const MAX_SYSTEM_PROMPT_LEN: usize = 100_000;

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

/// Write the system prompt to a temp file and return its path.
/// Using a file avoids the Windows CreateProcessW 32K character command-line limit.
fn write_prompt_file(content: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("anvil_prompts");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create prompt temp dir: {e}"))?;

    cleanup_stale_files(&dir, std::time::Duration::from_secs(STALE_FILE_SECS));

    let id = uuid::Uuid::new_v4();
    let path = dir.join(format!("prompt_{id}.txt"));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()))
        .map_err(|e| format!("Failed to write prompt file: {e}"))?;
    log_info!("spawn_tool: wrote system prompt ({} bytes)", content.len());
    Ok(path)
}

/// Quote a single argument for Windows CreateProcessW (CommandLineToArgvW rules).
/// Always wraps in double quotes and escapes embedded `"` and trailing `\`.
fn quote_arg(arg: &str) -> String {
    let mut result = String::with_capacity(arg.len() + 2);
    result.push('"');
    let mut backslashes: usize = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Double backslashes preceding a quote, then escape the quote
                for _ in 0..(2 * backslashes + 1) {
                    result.push('\\');
                }
                result.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    result.push('\\');
                }
                result.push(c);
                backslashes = 0;
            }
        }
    }
    // Double trailing backslashes before the closing quote
    for _ in 0..(2 * backslashes) {
        result.push('\\');
    }
    result.push('"');
    result
}

/// Quote a single argument for a command routed through `cmd.exe /c`.
///
/// cmd.exe does NOT understand `\"` as an escaped quote — it sees `"` as
/// toggling quoted mode, which exposes metacharacters like `&`, `|`, `<`, `>`
/// to interpretation as command separators.
///
/// This function uses `""` (double double-quote) to escape embedded quotes,
/// which both cmd.exe AND CommandLineToArgvW accept as a literal `"`.
/// It also escapes `%` as `%%` to prevent environment variable expansion.
fn quote_arg_cmd(arg: &str) -> String {
    let mut result = String::with_capacity(arg.len() + 4);
    result.push('"');
    for c in arg.chars() {
        match c {
            '"' => result.push_str("\"\""),
            '%' => result.push_str("%%"),
            _ => result.push(c),
        }
    }
    result.push('"');
    result
}

#[tauri::command]
pub async fn spawn_tool(
    registry: State<'_, Arc<SessionRegistry>>,
    project_path: String,
    tool_idx: usize,
    model_idx: usize,
    effort_idx: usize,
    skip_perms: bool,
    autocompact: bool,
    system_prompt: String,
    cols: i16,
    rows: i16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    log_info!("spawn_tool: project={project_path}, tool={tool_idx}, model={model_idx}, effort={effort_idx}, skip_perms={skip_perms}, autocompact={autocompact}, cols={cols}, rows={rows}");

    if projects::is_unc(&project_path) {
        log_error!("spawn_tool: UNC paths not supported: {project_path}");
        return Err("UNC paths are not supported".to_string());
    }
    if !std::path::Path::new(&project_path).is_dir() {
        log_error!("spawn_tool: path is not a directory: {project_path}");
        return Err("Project path does not exist or is not a directory".to_string());
    }

    if cols <= 0 || rows <= 0 || cols > 500 || rows > 200 {
        log_error!("spawn_tool: invalid dimensions {cols}x{rows}");
        return Err("Invalid terminal dimensions".to_string());
    }

    if system_prompt.len() > MAX_SYSTEM_PROMPT_LEN {
        log_error!("spawn_tool: system prompt too large ({} bytes)", system_prompt.len());
        return Err(format!("System prompt too large (max {MAX_SYSTEM_PROMPT_LEN} bytes)"));
    }

    // Write system prompt to a temp file to avoid the 32K char CreateProcessW limit.
    let prompt_file = if !system_prompt.is_empty() {
        Some(write_prompt_file(&system_prompt)?)
    } else {
        None
    };

    let (program, args, env, is_cmd) = match tool_idx {
        0 => {
            let claude_exe = tools::resolve_claude_exe().map_err(|e| {
                log_error!("spawn_tool: failed to resolve claude exe: {e}");
                e
            })?;
            let (p, a, cmd) = tools::build_claude_command(&claude_exe, model_idx, effort_idx, skip_perms, autocompact, prompt_file.as_deref());
            (p, a, tools::claude_env(), cmd)
        }
        1 => {
            let gemini_exe = tools::resolve_gemini_exe().map_err(|e| {
                log_error!("spawn_tool: failed to resolve gemini exe: {e}");
                e
            })?;
            let (p, a, cmd) = tools::build_gemini_command(&gemini_exe);
            (p, a, tools::gemini_env(), cmd)
        }
        _ => {
            log_error!("spawn_tool: invalid tool_idx={tool_idx}");
            return Err(format!("Invalid tool index: {tool_idx}"));
        }
    };

    // Use cmd.exe-safe quoting when routed through a .cmd/.bat shim to prevent
    // metacharacter injection (&, |, <, >, %, etc.).
    let quoter: fn(&str) -> String = if is_cmd { quote_arg_cmd } else { quote_arg };
    let mut cmd_parts = vec![program];
    cmd_parts.extend(args);
    let command_line = cmd_parts
        .iter()
        .enumerate()
        .map(|(i, p)| if i == 0 { p.clone() } else { quoter(p) })
        .collect::<Vec<_>>()
        .join(" ");
    // Log with prompt file path redacted (content is in the temp file, not the command line).
    if prompt_file.is_some() {
        let redacted = command_line
            .find("\"--append-system-prompt\"")
            .map(|pos| format!("{}--append-system-prompt <file>", &command_line[..pos]))
            .unwrap_or_else(|| command_line.clone());
        log_info!("spawn_tool: command={redacted}");
    } else {
        log_info!("spawn_tool: command={command_line}");
    }

    let result = registry.spawn(&command_line, &project_path, &env, cols, rows, on_event);

    // Clean up the temp prompt file now that the process has been created.
    if let Some(ref pf) = prompt_file {
        let _ = std::fs::remove_file(pf);
    }

    match &result {
        Ok(id) => log_info!("spawn_tool: session created id={id}"),
        Err(e) => log_error!("spawn_tool: failed: {e}"),
    }
    result
}

#[tauri::command]
pub fn write_pty(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    registry.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_pty(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    cols: i16,
    rows: i16,
) -> Result<(), String> {
    if cols <= 0 || rows <= 0 || cols > 500 || rows > 200 {
        log_error!("resize_pty: invalid dimensions {cols}x{rows}");
        return Err("Invalid terminal dimensions".to_string());
    }
    log_info!("resize_pty: session={session_id}, cols={cols}, rows={rows}");
    registry.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn kill_session(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    log_info!("kill_session: {session_id}");
    registry.kill(&session_id)
}

#[tauri::command]
pub fn heartbeat(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    registry.heartbeat(&session_id)
}

#[tauri::command]
pub fn active_session_count(
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<usize, String> {
    Ok(registry.active_count())
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

// ── Agent SDK commands ──────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SidecarStatus {
    pub available: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn sidecar_available(
    sidecar: State<'_, Arc<SidecarManager>>,
) -> SidecarStatus {
    SidecarStatus {
        available: sidecar.available(),
        reason: sidecar.unavailable_reason(),
    }
}

#[tauri::command]
pub fn spawn_agent(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    project_path: String,
    model: String,
    effort: String,
    system_prompt: String,
    skip_perms: bool,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available (Node.js not found)".to_string());
    }
    log_info!("spawn_agent: tab={tab_id}, project={project_path}, model={model}");

    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "create",
        "tabId": tab_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
        "systemPrompt": if system_prompt.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(system_prompt) },
        "skipPerms": skip_perms,
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
pub fn agent_resume(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
    session_id: String,
    project_path: String,
    model: String,
    effort: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    log_info!("agent_resume: tab={tab_id}, session={session_id}");
    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "resume",
        "tabId": tab_id,
        "sessionId": session_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
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
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !sidecar.available() {
        return Err("Agent SDK not available".to_string());
    }
    log_info!("agent_fork: tab={tab_id}, session={session_id}");
    sidecar.register_channel(&tab_id, on_event);
    sidecar.send_command(&serde_json::json!({
        "cmd": "fork",
        "tabId": tab_id,
        "sessionId": session_id,
        "cwd": project_path,
        "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
        "effort": effort,
    }))
}

#[tauri::command]
pub fn agent_kill(
    sidecar: State<'_, Arc<SidecarManager>>,
    tab_id: String,
) -> Result<(), String> {
    log_info!("agent_kill: tab={tab_id}");
    sidecar.unregister_channel(&tab_id);
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
) -> Result<(), String> {
    sidecar.send_command(&serde_json::json!({
        "cmd": "permission_response",
        "tabId": tab_id,
        "allow": allow,
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

    rx.await.map_err(|_| "Sidecar did not respond".to_string())
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

    rx.await.map_err(|_| "Sidecar did not respond".to_string())
}
