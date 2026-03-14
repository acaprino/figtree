use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// Per-1M token pricing: (input, output, cache_creation, cache_read)
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    if model.contains("opus") {
        (15.0, 75.0, 1.5, 18.75)
    } else if model.contains("haiku") {
        (0.8, 4.0, 0.08, 1.0)
    } else {
        // sonnet and anything else
        (3.0, 15.0, 0.3, 3.75)
    }
}

fn model_display(model: &str) -> &'static str {
    if model.contains("opus") {
        "opus"
    } else if model.contains("haiku") {
        "haiku"
    } else {
        "sonnet"
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DayStats {
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStats {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TotalStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub sessions: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageStats {
    pub days: Vec<DayStats>,
    pub models: Vec<ModelStats>,
    pub totals: TotalStats,
}

struct Accum {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    messages: u64,
    cost: f64,
}

impl Accum {
    fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            messages: 0,
            cost: 0.0,
        }
    }
}

fn compute_cost(model: &str, input: u64, output: u64, cache_create: u64, cache_read: u64) -> f64 {
    let (pi, po, pc, pr) = pricing(model);
    (input as f64 * pi + output as f64 * po + cache_create as f64 * pc + cache_read as f64 * pr)
        / 1_000_000.0
}

pub fn compute_usage(days_back: u64) -> Result<TokenUsageStats, String> {
    let start = std::time::Instant::now();
    log_info!("usage_stats: computing usage for last {days_back} days");
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.is_dir() {
        log_info!("usage_stats: no projects dir at {}, returning empty", projects_dir.display());
        return Ok(empty_stats());
    }

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(days_back * 86400))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    // Date string for cutoff (YYYY-MM-DD) for filtering
    let cutoff_date = system_time_to_date(cutoff);

    let mut jsonl_files: Vec<PathBuf> = Vec::new();
    collect_jsonl_files(&projects_dir, &mut jsonl_files, 0, 2, cutoff);
    log_info!("usage_stats: found {} jsonl files to process", jsonl_files.len());

    let mut day_map: HashMap<String, Accum> = HashMap::new();
    let mut model_map: HashMap<String, Accum> = HashMap::new();
    let mut session_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for path in &jsonl_files {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            // Fast-path: skip lines that aren't assistant messages
            if !line.contains("\"type\":\"assistant\"") {
                continue;
            }

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if parsed.get("type").and_then(|v| v.as_str()) != Some("assistant") {
                continue;
            }

            let msg = match parsed.get("message") {
                Some(m) => m,
                None => continue,
            };

            let model_raw = match msg.get("model").and_then(|v| v.as_str()) {
                Some(m) => m,
                None => continue,
            };

            let usage = match msg.get("usage") {
                Some(u) => u,
                None => continue,
            };

            // Extract date from timestamp
            let date = match parsed.get("timestamp").and_then(|v| v.as_str()) {
                Some(ts) if ts.len() >= 10 => &ts[..10],
                _ => continue,
            };

            // Filter by date range
            if date < cutoff_date.as_str() {
                continue;
            }

            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let cache_create = usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_read = usage
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            let cost = compute_cost(model_raw, input, output, cache_create, cache_read);
            let model_key = model_display(model_raw).to_string();

            // Track session
            if let Some(sid) = parsed.get("sessionId").and_then(|v| v.as_str()) {
                session_ids.insert(sid.to_string());
            }

            // Accumulate by day
            let day = day_map.entry(date.to_string()).or_insert_with(Accum::new);
            day.input_tokens += input;
            day.output_tokens += output;
            day.cache_creation_tokens += cache_create;
            day.cache_read_tokens += cache_read;
            day.messages += 1;
            day.cost += cost;

            // Accumulate by model
            let mdl = model_map.entry(model_key).or_insert_with(Accum::new);
            mdl.input_tokens += input;
            mdl.output_tokens += output;
            mdl.cache_creation_tokens += cache_create;
            mdl.cache_read_tokens += cache_read;
            mdl.messages += 1;
            mdl.cost += cost;
        }
    }

    // Build sorted day stats
    let mut days: Vec<DayStats> = day_map
        .into_iter()
        .map(|(date, a)| DayStats {
            date,
            input_tokens: a.input_tokens,
            output_tokens: a.output_tokens,
            cache_creation_tokens: a.cache_creation_tokens,
            cache_read_tokens: a.cache_read_tokens,
            messages: a.messages,
            cost: a.cost,
        })
        .collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));

    // Build sorted model stats
    let mut models: Vec<ModelStats> = model_map
        .into_iter()
        .map(|(model, a)| ModelStats {
            model,
            input_tokens: a.input_tokens,
            output_tokens: a.output_tokens,
            cache_creation_tokens: a.cache_creation_tokens,
            cache_read_tokens: a.cache_read_tokens,
            messages: a.messages,
            cost: a.cost,
        })
        .collect();
    models.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    // Compute totals
    let totals = TotalStats {
        input_tokens: days.iter().map(|d| d.input_tokens).sum(),
        output_tokens: days.iter().map(|d| d.output_tokens).sum(),
        cache_creation_tokens: days.iter().map(|d| d.cache_creation_tokens).sum(),
        cache_read_tokens: days.iter().map(|d| d.cache_read_tokens).sum(),
        messages: days.iter().map(|d| d.messages).sum(),
        sessions: session_ids.len() as u64,
        cost: days.iter().map(|d| d.cost).sum(),
    };

    log_info!(
        "usage_stats: done in {:.0}ms — {} days, {} models, {} messages, {} sessions, ${:.2}",
        start.elapsed().as_secs_f64() * 1000.0,
        days.len(),
        models.len(),
        totals.messages,
        totals.sessions,
        totals.cost,
    );

    Ok(TokenUsageStats {
        days,
        models,
        totals,
    })
}

fn collect_jsonl_files(
    dir: &std::path::Path,
    out: &mut Vec<PathBuf>,
    depth: usize,
    max_depth: usize,
    cutoff: SystemTime,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && depth < max_depth {
            collect_jsonl_files(&path, out, depth + 1, max_depth, cutoff);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            // Filter by mtime
            if let Ok(meta) = path.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if mtime >= cutoff {
                        out.push(path);
                    }
                }
            }
        }
    }
}

fn system_time_to_date(t: SystemTime) -> String {
    let dur = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Simple date calculation
    let days = secs / 86400;
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
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

fn empty_stats() -> TokenUsageStats {
    TokenUsageStats {
        days: vec![],
        models: vec![],
        totals: TotalStats {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            messages: 0,
            sessions: 0,
            cost: 0.0,
        },
    }
}
