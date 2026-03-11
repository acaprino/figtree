use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x08000000;

const DEFAULT_PROJECTS_DIR: &str = r"D:\Projects";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub model_idx: usize,
    #[serde(default)]
    pub effort_idx: usize,
    #[serde(default)]
    pub sort_idx: usize,
    #[serde(default)]
    pub theme_idx: usize,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default)]
    pub skip_perms: bool,
    #[serde(default = "default_project_dirs")]
    pub project_dirs: Vec<String>,
    #[serde(default)]
    pub project_labels: HashMap<String, String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

fn default_font_family() -> String {
    "Cascadia Code".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_project_dirs() -> Vec<String> {
    let dir = std::env::var("CLAUDE_LAUNCHER_PROJECTS_DIR")
        .unwrap_or_else(|_| DEFAULT_PROJECTS_DIR.to_string());
    vec![dir]
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            model_idx: 0,
            effort_idx: 0,
            sort_idx: 0,
            theme_idx: 0,
            font_family: default_font_family(),
            font_size: default_font_size(),
            skip_perms: false,
            project_dirs: default_project_dirs(),
            project_labels: HashMap::new(),
            extra: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub last_used: f64,
    pub count: u64,
}

pub type UsageData = HashMap<String, UsageEntry>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub label: Option<String>,
    pub branch: Option<String>,
    pub is_dirty: bool,
    pub has_claude_md: bool,
}

pub fn data_dir() -> PathBuf {
    let dir = dirs::data_local_dir()
        .map(|p| p.join("claude-launcher"))
        .unwrap_or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        });
    let _ = fs::create_dir_all(&dir);
    dir
}

fn settings_path() -> PathBuf {
    data_dir().join("claude-launcher-settings.json")
}

fn settings_bak_path() -> PathBuf {
    data_dir().join("claude-launcher-settings.json.bak")
}

fn usage_path() -> PathBuf {
    data_dir().join("claude-launcher-usage.json")
}

fn session_path() -> PathBuf {
    data_dir().join("claude-launcher-session.json")
}

pub fn load_session() -> Option<serde_json::Value> {
    let path = session_path();
    let meta = fs::metadata(&path).ok()?;
    if meta.len() > 1_048_576 { return None; } // 1 MB cap
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save_session(session: &serde_json::Value) -> io::Result<()> {
    let data = serde_json::to_string_pretty(session)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    if data.len() > 1_048_576 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Session data too large"));
    }
    let path = session_path();
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &data)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}


pub fn load_settings() -> Settings {
    if let Ok(data) = fs::read_to_string(settings_path()) {
        if let Ok(s) = serde_json::from_str(&data) {
            return s;
        }
    }
    if let Ok(data) = fs::read_to_string(settings_bak_path()) {
        if let Ok(s) = serde_json::from_str(&data) {
            return s;
        }
    }
    Settings::default()
}

pub fn save_settings(settings: &Settings) -> io::Result<()> {
    let path = settings_path();
    let tmp = path.with_extension("json.tmp");
    let bak = settings_bak_path();

    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    fs::write(&tmp, &data)?;

    if path.exists() {
        let _ = fs::copy(&path, &bak);
    }

    fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn load_usage() -> UsageData {
    if let Ok(data) = fs::read_to_string(usage_path()) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        HashMap::new()
    }
}

pub fn save_usage(usage: &UsageData) -> io::Result<()> {
    let path = usage_path();
    let tmp = path.with_extension("json.tmp");

    let data = serde_json::to_string_pretty(usage)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    fs::write(&tmp, &data)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Static mutex to serialize load-modify-save cycles in record_usage,
/// preventing TOCTOU races when multiple tabs launch simultaneously.
static USAGE_LOCK: Mutex<()> = Mutex::new(());

pub fn record_usage(project_path: &str) -> io::Result<()> {
    let _guard = USAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let mut usage = load_usage();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();

    let entry = usage
        .entry(project_path.to_string())
        .or_insert(UsageEntry {
            last_used: 0.0,
            count: 0,
        });
    entry.last_used = now;
    entry.count += 1;

    save_usage(&usage)
}

/// Maximum bytes to read from git stdout before giving up.
/// This prevents OOM when a repo has massive untracked/dirty output.
const GIT_OUTPUT_LIMIT: usize = 512 * 1024; // 512 KB

/// Maximum time to wait for a git command before killing it.
/// Prevents a hung git (e.g., on an unresponsive network share) from blocking
/// the entire project scan.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn scan_one_project(path: &str, label: Option<&String>) -> Option<ProjectInfo> {
    let p = Path::new(path);
    if !p.is_dir() {
        return None;
    }

    let name = p.file_name()?.to_string_lossy().to_string();
    let has_claude_md = p.join("CLAUDE.md").exists();

    let (branch, is_dirty) = match Command::new("git")
        .args(["status", "--branch", "--porcelain=v2"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Read stdout in a dedicated thread so we can enforce a timeout.
            // BufReader::lines() blocks on ReadFile; if git hangs (e.g., on a
            // network share), we'd block the scan thread forever without this.
            let stdout_pipe = child.stdout.take();
            let (tx, rx) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let Some(stdout) = stdout_pipe else {
                    let _ = tx.send((None, false));
                    return;
                };
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(stdout);
                let mut branch: Option<String> = None;
                let mut dirty = false;
                let mut total_bytes: usize = 0;

                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    total_bytes += line.len() + 1;
                    if line.starts_with("# branch.head ") {
                        branch = Some(line.trim_start_matches("# branch.head ").to_string());
                    } else if !line.starts_with('#') && !line.is_empty() {
                        dirty = true;
                    }
                    if (branch.is_some() && dirty) || total_bytes > GIT_OUTPUT_LIMIT {
                        break;
                    }
                }
                let _ = tx.send((branch, dirty));
            });

            // Wait for the reader with a timeout. If git hangs, kill it
            // and the broken pipe will unblock the reader thread.
            let result = rx.recv_timeout(GIT_TIMEOUT).unwrap_or((None, false));

            let _ = child.kill();
            let _ = child.wait();
            result
        }
        _ => (None, false),
    };

    Some(ProjectInfo {
        path: path.to_string(),
        name,
        label: label.cloned(),
        branch,
        is_dirty,
        has_claude_md,
    })
}

pub fn scan_projects(project_dirs: &[String], labels: &HashMap<String, String>) -> Vec<ProjectInfo> {
    use std::sync::mpsc;

    // Collect all subdirectories from each parent dir
    let mut all_paths: Vec<String> = Vec::new();
    for parent in project_dirs {
        let parent_path = Path::new(parent);
        if !parent_path.is_dir() {
            continue;
        }
        match fs::read_dir(parent_path) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        // Skip hidden directories (starting with '.')
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with('.') {
                                continue;
                            }
                        }
                        all_paths.push(path.to_string_lossy().to_string());
                    }
                }
            }
            Err(_) => continue,
        }
    }

    let (tx, rx) = mpsc::channel();

    // Process in chunks of 4 to avoid exhausting Windows pipe handles.
    for chunk in all_paths.chunks(4) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|dir| {
                let dir = dir.clone();
                let label = labels.get(&dir).cloned();
                let tx = tx.clone();
                thread::spawn(move || {
                    // catch_unwind: a single problematic project must not
                    // abort the entire scan. Panic is logged by the global hook.
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if let Some(info) = scan_one_project(&dir, label.as_ref()) {
                            let _ = tx.send(info);
                        }
                    }));
                    let _ = result; // ignore panic — already logged
                })
            })
            .collect();

        for handle in handles {
            let _ = handle.join();
        }
    }

    drop(tx);
    rx.iter().collect()
}

static ANSI_RE: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(r"\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07)").unwrap()
});

pub fn safe_str(s: &str) -> String {
    ANSI_RE.replace_all(s, "").to_string()
}

pub fn is_unc(path: &str) -> bool {
    path.starts_with(r"\\")
}

pub fn create_project(parent: &str, name: &str, git_init: bool) -> Result<String, String> {
    if is_unc(parent) {
        return Err("UNC paths are not supported".to_string());
    }

    let sanitized = safe_str(name);
    if sanitized.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }

    // C1: Direct name validation instead of canonicalize-based check.
    // Reject names containing path separators or parent-directory traversal.
    if sanitized.contains('/') || sanitized.contains('\\') || sanitized.contains("..") {
        return Err("Invalid project name".to_string());
    }

    let project_path = Path::new(parent).join(&sanitized);

    fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create directory: {e}"))?;

    if git_init {
        Command::new("git")
            .args(["init"])
            .current_dir(&project_path)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("git init failed: {e}"))?;
    }

    Ok(project_path.to_string_lossy().to_string())
}
