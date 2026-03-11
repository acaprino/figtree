use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Maximum number of rotated log files to keep (log, log.1, log.2, log.3).
const MAX_ROTATED: u32 = 3;

/// Maximum log file size before mid-session rotation (10 MB).
const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024;

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Returns the directory containing the running executable.
/// Falls back to current working directory if the exe path cannot be determined.
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn log_path() -> PathBuf {
    exe_dir().join("claude-launcher.log")
}

/// Rotate log files: .log → .log.1 → .log.2 → .log.3, deleting the oldest.
fn rotate(base: &PathBuf) {
    // Delete the oldest rotated file
    let oldest = PathBuf::from(format!("{}.{MAX_ROTATED}", base.display()));
    let _ = fs::remove_file(&oldest);

    // Shift .N-1 → .N, .N-2 → .N-1, etc.
    for i in (1..MAX_ROTATED).rev() {
        let from = PathBuf::from(format!("{}.{i}", base.display()));
        let to = PathBuf::from(format!("{}.{}", base.display(), i + 1));
        let _ = fs::rename(&from, &to);
    }

    // Current log → .1
    let to = PathBuf::from(format!("{}.1", base.display()));
    let _ = fs::rename(base, &to);
}

pub fn init() {
    let path = log_path();

    // Rotate previous logs before opening a new one
    if path.exists() {
        rotate(&path);
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path);

    match file {
        Ok(mut f) => {
            let _ = writeln!(f, "[{}] === Claude Launcher started ===", timestamp());
            let _ = writeln!(f, "[{}] Log file: {}", timestamp(), path.display());
            *LOG_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
            *LOG_FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
        }
        Err(e) => {
            eprintln!("Failed to open log file {}: {e}", path.display());
        }
    }
}

pub fn log(level: &str, msg: &str) {
    let line = format!("[{}] [{level}] {msg}", timestamp());

    // Always print to stderr for dev console
    eprintln!("{line}");

    // Also write to file
    let should_rotate = {
        let mut guard = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut f) = *guard {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
            f.metadata().map(|m| m.len() >= MAX_LOG_SIZE).unwrap_or(false)
        } else {
            false
        }
    };

    // Mid-session rotation outside the LOG_FILE lock to avoid deadlock.
    if should_rotate {
        let path = LOG_PATH.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = path {
            // Close the current file before rotating
            *LOG_FILE.lock().unwrap_or_else(|e| e.into_inner()) = None;
            rotate(&path);
            let new_file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path);
            let mut guard = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
            match new_file {
                Ok(mut nf) => {
                    let _ = writeln!(nf, "[{}] === Log rotated (size cap) ===", timestamp());
                    *guard = Some(nf);
                }
                Err(_) => {
                    *guard = None;
                }
            }
        }
    }
}

fn timestamp() -> String {
    use std::time::SystemTime;

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();

    let total_secs = now.as_secs();
    let millis = now.subsec_millis();

    // Date from epoch
    let days = total_secs / 86400;
    let (year, month, day) = days_to_date(days);

    // Time of day (UTC)
    let secs_in_day = total_secs % 86400;
    let hours = secs_in_day / 3600;
    let minutes = (secs_in_day % 3600) / 60;
    let seconds = secs_in_day % 60;

    format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}:{seconds:02}.{millis:03}")
}

fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Civil date from days since 1970-01-01 (Algorithm from Howard Hinnant)
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logging::log("INFO", &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logging::log("ERROR", &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::log("DEBUG", &format!($($arg)*))
    };
}
