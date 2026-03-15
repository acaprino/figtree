use std::path::Path;

/// Directories to skip when scanning for file path completions.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", ".next", "dist", "build",
    "__pycache__", ".venv", ".tox", ".mypy_cache",
];

/// Check if user input looks like it contains a file path fragment.
/// Returns the path prefix to complete if found, or None.
fn extract_path_prefix(input: &str) -> Option<&str> {
    // Find the last whitespace — the token after it might be a path
    let token = input.rsplit_once(char::is_whitespace)
        .map(|(_, t)| t)
        .unwrap_or(input);

    // Must contain a slash or start with a known dir prefix
    if token.contains('/') || token.contains('\\') {
        return Some(token);
    }

    // Known directory prefixes that indicate path intent
    const PATH_PREFIXES: &[&str] = &[
        "src", "app", "lib", "test", "tests", "docs", "config",
        "scripts", "pkg", "cmd", "internal", "public", "assets",
    ];
    if PATH_PREFIXES.iter().any(|p| token.starts_with(p)) {
        return Some(token);
    }

    None
}

/// Walk a directory recursively up to a depth limit, collecting files
/// whose relative path starts with the given prefix.
fn collect_matches(
    base: &Path,
    current: &Path,
    prefix: &str,
    depth: usize,
    max_depth: usize,
    results: &mut Vec<String>,
    max_results: usize,
) {
    if depth > max_depth || results.len() >= max_results {
        return;
    }

    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if results.len() >= max_results {
            return;
        }

        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip hidden and known noisy directories
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }

        let rel_path = match entry.path().strip_prefix(base) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let rel_lower = rel_path.to_lowercase();
        let prefix_lower = prefix.to_lowercase().replace('\\', "/");

        if rel_lower.starts_with(&prefix_lower) {
            results.push(rel_path.clone());
        }

        // Recurse into directories
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            // Only recurse if this dir could contain matches
            // (the dir path is a prefix of what we're looking for, or vice versa)
            if prefix_lower.starts_with(&rel_lower) || rel_lower.starts_with(&prefix_lower) {
                collect_matches(base, &entry.path(), prefix, depth + 1, max_depth, results, max_results);
            }
        }
    }
}

#[tauri::command]
pub fn autocomplete_files(cwd: String, input: String) -> Result<Vec<String>, String> {
    let prefix = match extract_path_prefix(&input) {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let base = Path::new(&cwd);
    if !base.is_dir() {
        return Ok(vec![]);
    }

    let mut results = Vec::new();
    collect_matches(base, base, prefix, 0, 5, &mut results, 5);

    // Sort: exact prefix matches first, then alphabetical
    let prefix_lower = prefix.to_lowercase().replace('\\', "/");
    results.sort_by(|a, b| {
        let a_exact = a.to_lowercase().starts_with(&prefix_lower);
        let b_exact = b.to_lowercase().starts_with(&prefix_lower);
        b_exact.cmp(&a_exact).then(a.cmp(b))
    });

    Ok(results)
}
