#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod logging;

mod tools;
mod commands;
mod marketplace;
mod projects;
mod pty;
mod session;
mod usage_stats;
mod watcher;

use std::sync::Arc;
use tauri::Manager;
use session::SessionRegistry;
use watcher::ProjectWatcher;

fn main() {
    logging::init();

    // Global panic hook: log panics from any thread to the log file.
    // Without this, a panic in a background thread (reaper, PTY reader, etc.)
    // dies silently and can leave the process in an inconsistent state.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown payload".to_string()
        };
        log_error!("PANIC at {location}: {payload}");
    }));

    log_info!("Anvil version: {}", env!("CARGO_PKG_VERSION"));
    log_info!("Data directory: {}", crate::projects::data_dir().display());
    log_info!("Initializing session registry");

    let registry = Arc::new(
        SessionRegistry::new().expect("Failed to create session registry"),
    );

    registry.start_reaper();
    log_info!("Session reaper started");

    let registry_for_cleanup = Arc::clone(&registry);

    log_info!("Starting Tauri application");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.unminimize() {
                    log_warn!("Single-instance: failed to unminimize: {e}");
                }
                if let Err(e) = window.set_focus() {
                    log_warn!("Single-instance: failed to focus: {e}");
                }
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .manage(registry)
        .setup(|app| {
            log_info!("setup: loading initial settings");
            let handle = app.handle().clone();
            let settings = projects::load_settings();
            log_info!("setup: project_dirs={:?}, single_project_dirs={:?}", settings.project_dirs, settings.single_project_dirs);
            let watcher = ProjectWatcher::new(handle);
            watcher.watch_dirs(&settings.project_dirs, &settings.single_project_dirs);
            app.manage(Arc::new(watcher));

            // Sync anvil-toolset marketplace before any session can start.
            // Runs synchronously to avoid race conditions with Claude Code
            // reading/writing settings.json concurrently.
            log_info!("setup: syncing marketplace");
            marketplace::sync_marketplace();

            log_info!("setup: complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_tool,
            commands::write_pty,
            commands::resize_pty,
            commands::kill_session,
            commands::heartbeat,
            commands::active_session_count,
            commands::scan_projects,
            commands::load_settings,
            commands::save_settings,
            commands::load_usage,
            commands::record_usage,
            commands::create_project,
            commands::save_session,
            commands::load_session,
            commands::set_window_corner_preference,
            commands::save_clipboard_image,
            commands::get_token_usage,
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    log_info!("Main window close requested — killing all sessions");
                    registry_for_cleanup.kill_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
