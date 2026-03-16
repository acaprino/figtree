#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod logging;

mod commands;
mod marketplace;
mod projects;
mod prompts;
mod sidecar;
mod usage_stats;
mod autocomplete;
mod watcher;

use std::sync::Arc;
use tauri::Manager;
use sidecar::SidecarManager;
use watcher::ProjectWatcher;

fn main() {
    logging::init();

    // Global panic hook: log panics from any thread to the log file.
    // Without this, a panic in a background thread
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

    log_info!("Initializing sidecar manager");
    let sidecar_manager = Arc::new(SidecarManager::new());

    let sidecar_for_cleanup = Arc::clone(&sidecar_manager);

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
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar_manager)
        .setup(|app| {
            log_info!("setup: loading initial settings");
            let handle = app.handle().clone();
            let settings = projects::load_settings();
            log_info!("setup: project_dirs={:?}, single_project_dirs={:?}", settings.project_dirs, settings.single_project_dirs);
            let watcher = ProjectWatcher::new(handle);
            watcher.watch_dirs(&settings.project_dirs, &settings.single_project_dirs);
            app.manage(Arc::new(watcher));

            // On startup, if marketplace_global is disabled, clean stale entries
            // from ~/.claude/settings.json (one-time migration from old git-clone approach).
            let startup_settings = projects::load_settings();
            let marketplace_global = startup_settings.extra
                .get("marketplace_global")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !marketplace_global {
                if let Err(e) = marketplace::disable_global() {
                    log_warn!("marketplace: cleanup failed: {e}");
                }
            }

            // Auto-grant clipboard permission to suppress the WebView2 permission dialog.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.with_webview(|webview| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use webview2_com::PermissionRequestedEventHandler;
                    let controller = webview.controller();
                    unsafe {
                        if let Ok(core) = controller.CoreWebView2() {
                            let handler = PermissionRequestedEventHandler::create(
                                Box::new(|_sender, args| {
                                    if let Some(args) = args {
                                        let mut kind = COREWEBVIEW2_PERMISSION_KIND(0);
                                        args.PermissionKind(&mut kind)?;
                                        if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                                        }
                                    }
                                    Ok(())
                                }),
                            );
                            let mut token = 0i64;
                            if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
                                log_warn!("Failed to register clipboard permission handler: {e}");
                            }
                        }
                    }
                }) {
                    log_warn!("Failed to configure WebView2 permission handler: {e}");
                }
            }

            log_info!("setup: complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::list_directory,
            commands::load_builtin_prompts,
            commands::save_prompt,
            commands::update_prompt,
            commands::delete_prompt,
            commands::spawn_agent,
            commands::agent_send,
            commands::agent_resume,
            commands::agent_fork,
            commands::agent_kill,
            commands::agent_permission,
            commands::agent_set_model,
            commands::list_agent_sessions,
            commands::get_agent_messages,
            commands::agent_autocomplete,
            commands::refresh_commands,
            commands::get_marketplace_plugins,
            commands::set_marketplace_global,
            autocomplete::autocomplete_files,
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    log_info!("Main window close requested — shutting down");
                    sidecar_for_cleanup.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
