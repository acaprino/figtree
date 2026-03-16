use std::fs;
use std::path::PathBuf;

const MARKETPLACE_NAME: &str = "alfio-claude-plugins";

/// Locate the `data/marketplace` directory.
/// Production: next to the exe.  Dev: relative to the crate root.
fn marketplace_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("data").join("marketplace");
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("marketplace")
}

/// Return absolute paths to every plugin directory bundled under data/marketplace/plugins/.
/// These paths are passed to the Agent SDK's `plugins` option so that skills, agents,
/// and commands are available exclusively within Anvil sessions.
pub fn get_plugin_paths() -> Vec<String> {
    let plugins_dir = marketplace_dir().join("plugins");
    if !plugins_dir.is_dir() {
        log_warn!("marketplace: plugins dir not found: {}", plugins_dir.display());
        return Vec::new();
    }

    let mut paths = Vec::new();
    if let Ok(entries) = fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                paths.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    paths.sort();
    log_info!("marketplace: found {} bundled plugins", paths.len());
    paths
}

fn claude_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Enable marketplace plugins in ~/.claude/settings.json so they're also
/// available in standalone Claude Code CLI sessions.
pub fn enable_global() -> Result<(), String> {
    let plugin_paths = get_plugin_paths();
    if plugin_paths.is_empty() {
        return Ok(());
    }

    let manifest_path = marketplace_dir()
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

    for key in &plugin_names {
        enabled_map.insert(key.clone(), serde_json::Value::Bool(true));
    }

    let data = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize settings: {e}"))?;
    fs::write(&settings_path, data)
        .map_err(|e| format!("write settings.json: {e}"))?;
    log_info!("marketplace: enabled {} plugins globally", plugin_names.len());
    Ok(())
}

/// Remove marketplace plugin entries from ~/.claude/settings.json
/// so they're no longer available in standalone Claude Code CLI.
pub fn disable_global() -> Result<(), String> {
    let Some(settings_path) = claude_settings_path() else {
        return Ok(());
    };
    if !settings_path.exists() {
        return Ok(());
    }

    let data = fs::read_to_string(&settings_path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let mut settings: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("parse settings.json: {e}"))?;

    let Some(enabled) = settings.get_mut("enabledPlugins").and_then(|v| v.as_object_mut()) else {
        return Ok(());
    };

    let keys_to_remove: Vec<String> = enabled
        .keys()
        .filter(|k| k.ends_with(&format!("@{MARKETPLACE_NAME}")))
        .cloned()
        .collect();

    if keys_to_remove.is_empty() {
        return Ok(());
    }

    for key in &keys_to_remove {
        enabled.remove(key);
    }

    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize settings: {e}"))?;
    fs::write(&settings_path, out)
        .map_err(|e| format!("write settings.json: {e}"))?;
    log_info!("marketplace: removed {} plugins from global settings", keys_to_remove.len());
    Ok(())
}
