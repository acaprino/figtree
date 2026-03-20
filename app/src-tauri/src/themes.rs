use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub bg: String,
    pub surface: String,
    pub mantle: String,
    pub crust: String,
    pub text: String,
    pub text_dim: String,
    pub overlay0: String,
    pub overlay1: String,
    pub accent: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub cursor: String,
    pub selection: String,
    #[serde(default)]
    pub user_msg_bg: Option<String>,
    #[serde(default)]
    pub user_msg_border: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub name: String,
    #[serde(default)]
    pub order: Option<i32>,
    #[serde(default)]
    pub retro: Option<bool>,
    pub colors: ThemeColors,
    pub term_font: Option<String>,
    pub term_font_size: Option<f64>,
    pub ui_font: Option<String>,
    pub ui_font_size: Option<f64>,
}

/// Locate the `data/themes` directory.
/// Production: next to the exe.  Dev: relative to the crate root.
fn themes_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("data").join("themes");
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    // Dev fallback: data/ lives at the crate root (src-tauri/data/themes/)
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("themes")
}

/// Read all `.json` theme files from the themes directory.
pub fn load_themes() -> Vec<Theme> {
    let dir = themes_dir();
    log_info!("themes: loading from {}", dir.display());

    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            log_error!("themes: failed to read {}: {e}", dir.display());
            return Vec::new();
        }
    };

    let mut themes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                log_warn!("themes: failed to read {}: {e}", path.display());
                continue;
            }
        };
        match serde_json::from_str::<Theme>(&raw) {
            Ok(theme) => themes.push(theme),
            Err(e) => {
                log_warn!("themes: invalid JSON in {}: {e}", path.display());
            }
        }
    }

    // Sort by order field (fallback 999), then by name
    themes.sort_by(|a, b| {
        let oa = a.order.unwrap_or(999);
        let ob = b.order.unwrap_or(999);
        oa.cmp(&ob).then_with(|| a.name.cmp(&b.name))
    });
    log_info!("themes: loaded {} themes", themes.len());
    themes
}
