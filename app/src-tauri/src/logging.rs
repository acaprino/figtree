use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Maximum number of rotated log files to keep (log, log.1, log.2, log.3).
const MAX_ROTATED: u32 = 3;

/// Maximum log file size before mid-session rotation (10 MB).
const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024;

/// Combined file + path state locked together to prevent TOCTOU races
/// during mid-session rotation (check-rotate-reopen must be atomic).
struct LogState {
    file: Option<File>,
    path: Option<PathBuf>,
}

static LOG: Mutex<LogState> = Mutex::new(LogState { file: None, path: None });

pub fn log_path() -> PathBuf {
    // Place log file next to the executable for easy access.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("anvil.log")))
        .unwrap_or_else(|| std::env::temp_dir().join("anvil.log"))
}

/// Rotate log files: .log → .log.1 → .log.2 → .log.3, deleting the oldest.
/// Uses OsString concatenation to avoid lossy Display conversion on non-UTF-8 paths.
fn rotate(base: &PathBuf) {
    // Delete the oldest rotated file
    let mut oldest: OsString = base.as_os_str().to_os_string();
    oldest.push(format!(".{MAX_ROTATED}"));
    let _ = fs::remove_file(PathBuf::from(&oldest));

    // Shift .N-1 → .N, .N-2 → .N-1, etc.
    for i in (1..MAX_ROTATED).rev() {
        let mut from: OsString = base.as_os_str().to_os_string();
        from.push(format!(".{i}"));
        let mut to: OsString = base.as_os_str().to_os_string();
        to.push(format!(".{}", i + 1));
        let _ = fs::rename(PathBuf::from(&from), PathBuf::from(&to));
    }

    // Current log → .1
    let mut to: OsString = base.as_os_str().to_os_string();
    to.push(".1");
    let _ = fs::rename(base, PathBuf::from(&to));
}

pub fn init() {
    let path = log_path();
    let mut state = LOG.lock().unwrap_or_else(|e| e.into_inner());

    // Ensure the log directory exists (data_local_dir sub-directory may not exist yet).
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }

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
            let _ = writeln!(f, "[{}] === Anvil started ===", timestamp());
            let _ = writeln!(f, "[{}] Log file: {}", timestamp(), path.display());
            state.path = Some(path);
            state.file = Some(f);
        }
        Err(e) => {
            eprintln!("Failed to open log file {}: {e}", path.display());
        }
    }
}

pub fn log(level: &str, msg: &str) {
    // Sanitize newlines so IPC-supplied strings cannot forge additional log lines.
    let msg = msg.replace('\n', "\\n").replace('\r', "\\r");
    let line = format!("[{}] [{level}] {msg}", timestamp());

    // Always print to stderr for dev console
    eprintln!("{line}");

    // Write to file under a single lock for the entire check-rotate-reopen sequence.
    // Holding the lock prevents concurrent threads from observing LOG_FILE = None
    // during rotation or triggering a double rotation.
    let mut state = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut f) = state.file {
        let _ = writeln!(f, "{line}");
        // Only flush on ERROR to avoid per-line FlushFileBuffers syscalls
        if level == "ERROR" {
            let _ = f.flush();
        }

        let should_rotate = f.metadata().map(|m| m.len() >= MAX_LOG_SIZE).unwrap_or(false);
        if should_rotate {
            if let Some(path) = state.path.clone() {
                state.file = None;
                rotate(&path);
                match OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&path)
                {
                    Ok(mut nf) => {
                        let _ = writeln!(nf, "[{}] === Log rotated (size cap) ===", timestamp());
                        state.file = Some(nf);
                    }
                    Err(_) => {
                        state.file = None;
                    }
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

#[cfg(test)]
mod tests {
    use super::days_to_date;

    #[test]
    fn test_epoch() {
        assert_eq!(days_to_date(0), (1970, 1, 1));
    }

    #[test]
    fn test_known_dates() {
        assert_eq!(days_to_date(18262), (2020, 1, 1));
        assert_eq!(days_to_date(18628), (2021, 1, 1));
        assert_eq!(days_to_date(19723), (2023, 12, 31));
    }

    #[test]
    fn test_leap_day() {
        assert_eq!(days_to_date(18321), (2020, 2, 29));
    }
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
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logging::log("WARN", &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::log("DEBUG", &format!($($arg)*))
    };
}
