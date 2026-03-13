use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::tools;
use crate::projects::{self, ProjectInfo, Settings, UsageData};
use crate::session::{PtyEvent, SessionRegistry};

#[tauri::command]
pub async fn spawn_tool(
    registry: State<'_, Arc<SessionRegistry>>,
    project_path: String,
    tool_idx: usize,
    model_idx: usize,
    effort_idx: usize,
    skip_perms: bool,
    cols: i16,
    rows: i16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    log_info!("spawn_tool: project={project_path}, tool={tool_idx}, model={model_idx}, effort={effort_idx}, skip_perms={skip_perms}, cols={cols}, rows={rows}");

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

    let (program, args, env) = match tool_idx {
        0 => {
            let claude_exe = tools::resolve_claude_exe().map_err(|e| {
                log_error!("spawn_tool: failed to resolve claude exe: {e}");
                e
            })?;
            let (p, a) = tools::build_claude_command(&claude_exe, model_idx, effort_idx, skip_perms);
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
        .map(|p| if p.contains(' ') && !p.starts_with('"') { format!("\"{}\"", p) } else { p.clone() })
        .collect::<Vec<_>>()
        .join(" ");
    log_info!("spawn_tool: command_line={command_line}");

    let result = registry.spawn(&command_line, &project_path, &env, cols, rows, on_event);
    match &result {
        Ok(id) => log_info!("spawn_tool: session created id={id}"),
        Err(e) => log_error!("spawn_tool: failed: {e}"),
    }
    result
}

#[tauri::command]
pub async fn write_pty(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    registry.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub async fn resize_pty(
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
pub async fn kill_session(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    log_info!("kill_session: {session_id}");
    registry.kill(&session_id)
}

#[tauri::command]
pub async fn heartbeat(
    registry: State<'_, Arc<SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    registry.heartbeat(&session_id)
}

#[tauri::command]
pub async fn active_session_count(
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
pub async fn save_settings(settings: Settings) -> Result<(), String> {
    log_info!("save_settings: dirs={:?}, single={:?}", settings.project_dirs, settings.single_project_dirs);
    tokio::task::spawn_blocking(move || {
        projects::save_settings(&settings).map_err(|e| format!("Failed to save settings: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
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
pub async fn load_session() -> Result<serde_json::Value, String> {
    log_info!("load_session");
    tokio::task::spawn_blocking(|| Ok(projects::load_session().unwrap_or(serde_json::Value::Null)))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}
