use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::tools;
use crate::projects::{self, ProjectInfo, Settings, UsageData};
use crate::session::{PtyEvent, SessionRegistry};
use crate::usage_stats::{self, TokenUsageStats};
use crate::watcher::ProjectWatcher;

/// Max system prompt size (100 KB) — prevents CreateProcessW command-line overflow.
const MAX_SYSTEM_PROMPT_LEN: usize = 100_000;

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

    let (program, args, env) = match tool_idx {
        0 => {
            let claude_exe = tools::resolve_claude_exe().map_err(|e| {
                log_error!("spawn_tool: failed to resolve claude exe: {e}");
                e
            })?;
            let (p, a) = tools::build_claude_command(&claude_exe, model_idx, effort_idx, skip_perms, autocompact, &system_prompt);
            (p, a, tools::claude_env())
        }
        1 => {
            let gemini_exe = tools::resolve_gemini_exe().map_err(|e| {
                log_error!("spawn_tool: failed to resolve gemini exe: {e}");
                e
            })?;
            let (p, a) = tools::build_gemini_command(&gemini_exe);
            (p, a, tools::gemini_env())
        }
        _ => {
            log_error!("spawn_tool: invalid tool_idx={tool_idx}");
            return Err(format!("Invalid tool index: {tool_idx}"));
        }
    };

    let mut cmd_parts = vec![program];
    cmd_parts.extend(args);
    let command_line = cmd_parts
        .iter()
        .enumerate()
        .map(|(i, p)| if i == 0 { p.clone() } else { quote_arg(p) })
        .collect::<Vec<_>>()
        .join(" ");
    // Log the command used to launch the session.  Redact --append-system-prompt
    // value (the next quoted argument) since it can be large and contain user content.
    let log_cmd: std::borrow::Cow<str> = if let Some(flag_pos) = command_line.find("--append-system-prompt") {
        let after_flag = flag_pos + "--append-system-prompt".len();
        // Skip whitespace, then skip the quoted argument value to preserve trailing flags
        let rest = &command_line[after_flag..];
        let trimmed = rest.trim_start();
        let skip_ws = rest.len() - trimmed.len();
        let value_end = if trimmed.starts_with('"') {
            // Find closing quote (respecting escaped quotes from quote_arg)
            let mut i = 1;
            let bytes = trimmed.as_bytes();
            while i < bytes.len() {
                if bytes[i] == b'\\' { i += 2; continue; }
                if bytes[i] == b'"' { i += 1; break; }
                i += 1;
            }
            after_flag + skip_ws + i
        } else {
            // Unquoted: ends at next whitespace
            after_flag + skip_ws + trimmed.find(' ').unwrap_or(trimmed.len())
        };
        std::borrow::Cow::Owned(format!(
            "{}--append-system-prompt <redacted>{}",
            &command_line[..flag_pos],
            &command_line[value_end..],
        ))
    } else {
        std::borrow::Cow::Borrowed(&command_line)
    };
    log_info!("spawn_tool: command={log_cmd}");

    let result = registry.spawn(&command_line, &project_path, &env, cols, rows, on_event);
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

        // Clean up files older than 1 hour
        if let Ok(entries) = std::fs::read_dir(&temp_dir) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.modified().unwrap_or(std::time::UNIX_EPOCH) < cutoff {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }

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
