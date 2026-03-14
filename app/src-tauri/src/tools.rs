use std::path::{Path, PathBuf};

pub const MODELS: &[(&str, &str)] = &[
    ("sonnet", "claude-sonnet-4-6"),
    ("opus", "claude-opus-4-6"),
    ("haiku", "claude-haiku-4-5"),
    ("sonnet [1M]", "claude-sonnet-4-6[1m]"),
    ("opus [1M]", "claude-opus-4-6[1m]"),
];

pub const EFFORTS: &[&str] = &["high", "medium", "low"];

fn is_shim(exe_str: &str) -> bool {
    exe_str.ends_with(".cmd") || exe_str.ends_with(".bat")
}

fn wrap_shim(exe_str: &str, args: Vec<String>) -> (String, Vec<String>) {
    let mut shim_args = vec!["/c".to_string(), format!("\"{}\"", exe_str)];
    shim_args.extend(args);
    ("cmd.exe".to_string(), shim_args)
}

pub fn resolve_claude_exe() -> Result<PathBuf, String> {
    if let Ok(path) = which::which("claude") {
        log_info!("tools: resolved claude via PATH: {}", path.display());
        return Ok(path);
    }

    if let Some(home) = dirs::home_dir() {
        let fallback = home.join(".local").join("bin").join("claude.exe");
        if fallback.exists() {
            log_info!("tools: resolved claude via fallback: {}", fallback.display());
            return Ok(fallback);
        }
        log_debug!("tools: claude fallback not found at {}", fallback.display());
    }

    log_error!("tools: claude executable not found in PATH or fallback locations");
    Err("Claude executable not found. Install with: npm install -g @anthropic-ai/claude-code".to_string())
}

pub fn build_claude_command(
    claude_exe: &Path,
    model_idx: usize,
    effort_idx: usize,
    skip_perms: bool,
    autocompact: bool,
    append_system_prompt: &str,
) -> (String, Vec<String>) {
    let model_id = MODELS
        .get(model_idx)
        .map(|(_, id)| *id)
        .unwrap_or(MODELS[0].1);

    let effort = EFFORTS.get(effort_idx).copied().unwrap_or(EFFORTS[0]);

    let exe_str = claude_exe.to_string_lossy().to_string();

    let mut claude_args = vec![
        "--model".to_string(),
        model_id.to_string(),
        "--effort".to_string(),
        effort.to_string(),
    ];

    if skip_perms {
        claude_args.push("--dangerously-skip-permissions".to_string());
    }

    if autocompact {
        claude_args.push("--autocompact".to_string());
        claude_args.push("80".to_string());
    }

    if !append_system_prompt.is_empty() {
        claude_args.push("--append-system-prompt".to_string());
        claude_args.push(append_system_prompt.to_string());
    }

    let result = if is_shim(&exe_str) {
        log_info!("tools: claude exe is a shim ({exe_str}), wrapping with cmd.exe");
        // Quote the exe path for cmd.exe /c to handle spaces
        wrap_shim(&exe_str, claude_args)
    } else {
        (exe_str, claude_args)
    };
    log_info!("tools: claude command built — model={model_id}, effort={effort}, skip_perms={skip_perms}, autocompact={autocompact}, has_prompt={}", !append_system_prompt.is_empty());
    result
}

pub fn claude_env() -> Vec<(String, String)> {
    vec![
        ("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string(), "64000".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]
}

pub fn resolve_gemini_exe() -> Result<PathBuf, String> {
    if let Ok(path) = which::which("gemini") {
        log_info!("tools: resolved gemini via PATH: {}", path.display());
        return Ok(path);
    }

    if let Some(home) = dirs::home_dir() {
        let fallback = home.join(".local").join("bin").join("gemini.exe");
        if fallback.exists() {
            log_info!("tools: resolved gemini via fallback: {}", fallback.display());
            return Ok(fallback);
        }
        log_debug!("tools: gemini fallback not found at {}", fallback.display());
    }

    log_error!("tools: gemini executable not found in PATH or fallback locations");
    Err("Gemini executable not found. Install with: npm install -g @google/gemini-cli".to_string())
}

pub fn build_gemini_command(gemini_exe: &Path) -> (String, Vec<String>) {
    let exe_str = gemini_exe.to_string_lossy().to_string();

    let result = if is_shim(&exe_str) {
        log_info!("tools: gemini exe is a shim ({exe_str}), wrapping with cmd.exe");
        wrap_shim(&exe_str, vec![])
    } else {
        (exe_str, vec![])
    };
    log_info!("tools: gemini command built");
    result
}

pub fn gemini_env() -> Vec<(String, String)> {
    vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]
}
