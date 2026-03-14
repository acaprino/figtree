use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const REPO_URL: &str = "https://github.com/acaprino/anvil-toolset.git";
const MARKETPLACE_NAME: &str = "alfio-claude-plugins";

fn marketplace_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join(".claude")
            .join("plugins")
            .join("marketplaces")
            .join(MARKETPLACE_NAME)
    })
}

fn claude_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Install or update the anvil-toolset marketplace, then enable its plugins.
/// Designed to run in a background thread — errors are logged, never fatal.
pub fn sync_marketplace() {
    let Some(mp_dir) = marketplace_dir() else {
        log_error!("marketplace: cannot determine home dir");
        return;
    };

    if mp_dir.join(".git").is_dir() {
        // Already cloned — pull latest
        log_info!("marketplace: updating {MARKETPLACE_NAME}");
        let result = Command::new("git")
            .args(["pull", "--ff-only", "--quiet"])
            .current_dir(&mp_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match result {
            Ok(out) if out.status.success() => {
                log_info!("marketplace: updated successfully");
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log_error!("marketplace: git pull failed: {stderr}");
            }
            Err(e) => log_error!("marketplace: git pull error: {e}"),
        }
    } else {
        // Not installed — clone
        log_info!("marketplace: installing {MARKETPLACE_NAME}");
        if let Some(parent) = mp_dir.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let result = Command::new("git")
            .args(["clone", "--depth", "1", "--quiet", REPO_URL, &mp_dir.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match result {
            Ok(out) if out.status.success() => {
                log_info!("marketplace: cloned successfully");
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log_error!("marketplace: git clone failed: {stderr}");
                return;
            }
            Err(e) => {
                log_error!("marketplace: git clone error: {e}");
                return;
            }
        }
    }

    // Enable plugins in Claude Code settings
    if let Err(e) = enable_plugins(&mp_dir) {
        log_error!("marketplace: failed to enable plugins: {e}");
    }
}

fn enable_plugins(mp_dir: &PathBuf) -> Result<(), String> {
    let manifest_path = mp_dir
        .join(".claude-plugin")
        .join("marketplace.json");

    let manifest_str = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read marketplace.json: {e}"))?;

    let manifest: serde_json::Value = serde_json::from_str(&manifest_str)
        .map_err(|e| format!("parse marketplace.json: {e}"))?;

    let plugin_names: Vec<String> = manifest
        .get("plugins")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                .map(|name| format!("{name}@{MARKETPLACE_NAME}"))
                .collect()
        })
        .unwrap_or_default();

    if plugin_names.is_empty() {
        return Ok(());
    }

    let Some(settings_path) = claude_settings_path() else {
        return Err("cannot determine claude settings path".to_string());
    };

    // Read existing Claude Code settings
    let mut settings: serde_json::Value = if settings_path.exists() {
        let data = fs::read_to_string(&settings_path)
            .map_err(|e| format!("read settings.json: {e}"))?;
        serde_json::from_str(&data)
            .map_err(|e| format!("parse settings.json: {e}"))?
    } else {
        serde_json::json!({})
    };

    let enabled = settings
        .as_object_mut()
        .ok_or("settings is not an object")?
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));

    let enabled_map = enabled
        .as_object_mut()
        .ok_or("enabledPlugins is not an object")?;

    let mut changed = false;
    for key in &plugin_names {
        if !enabled_map.contains_key(key) {
            enabled_map.insert(key.clone(), serde_json::Value::Bool(true));
            changed = true;
        }
    }

    if changed {
        let data = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("serialize settings: {e}"))?;
        fs::write(&settings_path, data)
            .map_err(|e| format!("write settings.json: {e}"))?;
        log_info!("marketplace: enabled {} new plugins", plugin_names.len());
    } else {
        log_info!("marketplace: all plugins already enabled");
    }

    Ok(())
}
