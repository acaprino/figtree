#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod logging;

mod claude;
mod commands;
mod projects;
mod pty;
mod session;

use std::sync::Arc;
use session::SessionRegistry;

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

    log_info!("Initializing session registry");

    let registry = Arc::new(
        SessionRegistry::new().expect("Failed to create session registry"),
    );

    registry.start_reaper();
    log_info!("Session reaper started");

    let registry_for_cleanup = Arc::clone(&registry);

    log_info!("Starting Tauri application");
    tauri::Builder::default()
        .manage(registry)
        .invoke_handler(tauri::generate_handler![
            commands::spawn_claude,
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
            commands::open_in_explorer,
            commands::create_project,
            commands::save_session,
            commands::load_session,
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
