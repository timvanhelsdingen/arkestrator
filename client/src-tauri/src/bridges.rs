use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const REGISTRY_CACHE_TTL_SECS: u64 = 300; // 5 minutes
const GITHUB_API_BASE: &str = "https://api.github.com";

// ─── Types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBridge {
    pub id: String,
    pub version: String,
    pub install_path: String,
    pub installed_at: String,
    /// Relative paths (under install_path) of every file extracted during
    /// install. Optional for back-compat with pre-0.1.76 entries — when
    /// absent, uninstall falls back to a recursive "arkestrator" name scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct InstalledBridgesFile {
    installed: Vec<InstalledBridge>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPath {
    pub path: String,
    pub label: String,
}

// ─── Helpers ────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

fn arkestrator_config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".arkestrator"))
}

fn bridges_state_path() -> Result<PathBuf, String> {
    Ok(arkestrator_config_dir()?.join("bridges.json"))
}

fn registry_cache_path() -> Result<PathBuf, String> {
    Ok(arkestrator_config_dir()?.join("registry-cache.json"))
}

fn expand_path(path: &str) -> String {
    let mut result = path.to_string();

    if let Some(home) = home_dir() {
        let home_str = home.to_string_lossy().to_string();
        if result.starts_with("~/") {
            result = format!("{}{}", home_str, &result[1..]);
        }
    }

    // Expand Windows env vars
    #[cfg(target_os = "windows")]
    {
        for var in &["APPDATA", "USERPROFILE", "LOCALAPPDATA", "PROGRAMFILES"] {
            let placeholder = format!("%{}%", var);
            if let Ok(val) = std::env::var(var) {
                if result.contains(&placeholder) {
                    result = result.replace(&placeholder, &val);
                }
            }
        }
    }

    // Normalize separators
    result.replace('\\', "/")
}

fn now_iso() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", duration.as_secs())
}

// ─── Registry ───────────────────────────────────────────────────────────

/// Detect whether the registry uses the v2 format (per-bridge bridge.json manifests).
/// V2 registries have a `registryVersion` field >= 2, or their bridge entries lack
/// a `name` field (they are index-only pointers with just `id` and `dir`).
fn is_v2_registry(registry: &Value) -> bool {
    if let Some(v) = registry.get("registryVersion").and_then(|v| v.as_u64()) {
        return v >= 2;
    }
    // Heuristic: if first bridge entry lacks "name", it's a v2 index entry
    registry
        .get("bridges")
        .and_then(|b| b.as_array())
        .and_then(|a| a.first())
        .map(|first| first.get("name").is_none())
        .unwrap_or(false)
}

/// Fetch a single bridge's manifest (bridge.json) from the repo.
async fn fetch_bridge_manifest(
    client: &reqwest::Client,
    repo: &str,
    dir: &str,
) -> Result<Value, String> {
    let url = format!(
        "https://raw.githubusercontent.com/{}/main/{}/bridge.json",
        repo, dir
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "Arkestrator-Client")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch {}/bridge.json: {e}", dir))?;
    if !resp.status().is_success() {
        return Err(format!("{}/bridge.json returned {}", dir, resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read {}/bridge.json: {e}", dir))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}/bridge.json: {e}", dir))
}

#[tauri::command]
pub async fn fetch_bridge_registry(repo: String, force_refresh: Option<bool>) -> Result<Value, String> {
    // Check cache first (skip if force refresh)
    if !force_refresh.unwrap_or(false) {
    if let Ok(cache_path) = registry_cache_path() {
        if let Ok(metadata) = fs::metadata(&cache_path) {
            if let Ok(modified) = metadata.modified() {
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if age.as_secs() < REGISTRY_CACHE_TTL_SECS {
                    if let Ok(cached) = fs::read_to_string(&cache_path) {
                        if let Ok(value) = serde_json::from_str::<Value>(&cached) {
                            return Ok(value);
                        }
                    }
                }
            }
        }
    }
    } // end cache check

    let client = reqwest::Client::new();
    let repo_trimmed = repo.trim();

    // Fetch registry.json from raw GitHub content (same approach as the server)
    let raw_url = format!(
        "https://raw.githubusercontent.com/{}/main/registry.json",
        repo_trimmed
    );
    let registry_text = client
        .get(&raw_url)
        .header("User-Agent", "Arkestrator-Client")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch registry: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read registry: {e}"))?;

    let registry: Value = serde_json::from_str(&registry_text)
        .map_err(|e| format!("Failed to parse registry JSON: {e}"))?;

    // Detect registry format: v2 has a registryVersion field and bridge entries
    // are just index pointers ({ id, dir }) — full metadata lives in per-bridge
    // bridge.json files that we fetch in parallel.
    let registry = if is_v2_registry(&registry) {
        let entries: Vec<(String, String)> = registry
            .get("bridges")
            .and_then(|b| b.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        let id = e.get("id")?.as_str()?.to_string();
                        let dir = e
                            .get("dir")
                            .and_then(|d| d.as_str())
                            .unwrap_or(e.get("id")?.as_str()?)
                            .to_string();
                        Some((id, dir))
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Fetch all bridge.json files in parallel
        let futs: Vec<_> = entries
            .iter()
            .map(|(_, dir)| fetch_bridge_manifest(&client, repo_trimmed, dir))
            .collect();
        let results = join_all(futs).await;

        let mut bridges_array = Vec::new();
        for (i, result) in results.into_iter().enumerate() {
            match result {
                Ok(manifest) => bridges_array.push(manifest),
                Err(e) => eprintln!(
                    "[bridges] Warning: skipping bridge {}: {}",
                    entries[i].0, e
                ),
            }
        }
        json!({ "registryVersion": 2, "bridges": bridges_array })
    } else {
        registry
    };

    // Fetch releases to find download URLs for each bridge's asset zip
    let releases_url = format!(
        "{}/repos/{}/releases?per_page=20",
        GITHUB_API_BASE,
        repo_trimmed
    );
    let releases: Vec<Value> = match client
        .get(&releases_url)
        .header("User-Agent", "Arkestrator-Client")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(resp) => resp.json().await.unwrap_or_default(),
        Err(_) => vec![],
    };

    // Inject release info into the registry
    let mut result = registry.clone();
    if let Some(obj) = result.as_object_mut() {
        // Use the latest release tag if available
        if let Some(latest) = releases.first() {
            obj.insert(
                "releaseTag".to_string(),
                latest.get("tag_name").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "releaseUrl".to_string(),
                latest.get("html_url").cloned().unwrap_or(Value::Null),
            );
        }

        // For each bridge, scan releases (newest first) to find the latest
        // release that contains that bridge's asset zip
        if let Some(bridges) = obj.get_mut("bridges").and_then(|b| b.as_array_mut()) {
            for bridge in bridges.iter_mut() {
                if let Some(asset_pattern) = bridge.get("asset").and_then(|a| a.as_str()) {
                    let pattern = asset_pattern.to_string();

                    // Scan releases newest-first to find the latest with this bridge's asset
                    'release_scan: for rel in &releases {
                        let tag = rel
                            .get("tag_name")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        let version = tag.strip_prefix('v').unwrap_or(tag);
                        let expected_asset = pattern.replace("{version}", version);

                        if let Some(rel_assets) =
                            rel.get("assets").and_then(|a| a.as_array())
                        {
                            if let Some(asset) = rel_assets.iter().find(|a| {
                                a.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|n| n == expected_asset)
                                    .unwrap_or(false)
                            }) {
                                if let Some(url) = asset.get("browser_download_url") {
                                    if let Some(b) = bridge.as_object_mut() {
                                        b.insert("downloadUrl".to_string(), url.clone());
                                        b.insert(
                                            "version".to_string(),
                                            Value::String(version.to_string()),
                                        );
                                    }
                                }
                                break 'release_scan;
                            }
                        }
                    }
                }
            }
        }
    }

    // Cache it
    if let Ok(cache_path) = registry_cache_path() {
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            &cache_path,
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        );
    }

    Ok(result)
}

// ─── Download & Install ─────────────────────────────────────────────────

#[tauri::command]
pub async fn download_and_install_bridge(
    download_url: String,
    install_path: String,
) -> Result<Vec<String>, String> {
    let expanded = expand_path(&install_path);
    let dest = PathBuf::from(&expanded);

    // Download the bridge zip
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .header("User-Agent", "Arkestrator-Client")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {e}"))?;

    // Extract zip to install path
    let cursor = io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip: {e}"))?;

    // Ensure parent directory exists
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }

    // Only remove the destination if it's a bridge-specific directory (contains
    // "arkestrator" in the final path component). Shared directories like
    // Houdini's `packages/` must NOT be wiped — we extract on top instead.
    if dest.exists() {
        let is_bridge_owned = dest
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase().contains("arkestrator"))
            .unwrap_or(false);
        if is_bridge_owned {
            fs::remove_dir_all(&dest)
                .map_err(|e| format!("Failed to remove existing installation: {e}"))?;
        }
    }

    // Detect the common top-level prefix in the zip so we can strip it.
    // Many GitHub release zips wrap everything under a single root folder
    // (e.g. "arkestrator-godot-bridge-0.1.51/") which doesn't match the
    // user's chosen install path. We strip that prefix and extract directly
    // into `dest`.
    let common_prefix = {
        let mut prefix: Option<PathBuf> = None;
        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry: {e}"))?;
            let entry_path = match file.enclosed_name() {
                Some(p) => p.to_path_buf(),
                None => continue,
            };
            let first_component = entry_path
                .components()
                .next()
                .map(|c| PathBuf::from(c.as_os_str()));
            match (&prefix, first_component) {
                (None, Some(comp)) => prefix = Some(comp),
                (Some(existing), Some(comp)) if *existing != comp => {
                    // Multiple top-level entries — no common prefix to strip
                    prefix = None;
                    break;
                }
                _ => {}
            }
        }
        // Only strip if the prefix is a directory (has children), not a single file
        prefix.filter(|_p| {
            (0..archive.len()).any(|i| {
                archive.by_index(i).ok().and_then(|f| f.enclosed_name().map(|n| n.to_path_buf())).map(|n| n.components().count() > 1).unwrap_or(false)
            })
        })
    };

    // Extract files — strip common prefix and place directly into dest.
    // Track every file (not directory) we extract so uninstall can remove
    // exactly what was installed, even when living in a shared directory
    // alongside unrelated user files.
    let mut installed_files: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let entry_path = file
            .enclosed_name()
            .ok_or("Invalid zip entry name")?
            .to_path_buf();

        // Strip common top-level prefix if present
        let relative = if let Some(ref prefix) = common_prefix {
            match entry_path.strip_prefix(prefix) {
                Ok(stripped) => stripped.to_path_buf(),
                Err(_) => entry_path.clone(),
            }
        } else {
            entry_path.clone()
        };

        // Skip empty relative paths (the prefix directory itself)
        if relative.as_os_str().is_empty() {
            continue;
        }

        let out_path = dest.join(&relative);

        if file.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!("Failed to create dir {}: {e}", parent.display())
                })?;
            }
            let mut outfile = fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create file {}: {e}", out_path.display()))?;
            io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to write file {}: {e}", out_path.display()))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(mode));
                }
            }

            installed_files.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }

    Ok(installed_files)
}

// ─── Program Detection ──────────────────────────────────────────────────

#[tauri::command]
pub fn detect_program_paths(hints: Vec<String>) -> Vec<DetectedPath> {
    let mut results = Vec::new();

    for hint in &hints {
        let expanded = expand_path(hint);

        if expanded.contains('*') {
            // Glob pattern
            if let Ok(paths) = glob::glob(&expanded) {
                for entry in paths.flatten() {
                    if entry.is_dir() {
                        let label = entry
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        results.push(DetectedPath {
                            path: entry.to_string_lossy().to_string(),
                            label,
                        });
                    }
                }
            }
        } else {
            // Direct path — check if it exists and list subdirectories (version dirs)
            let base = PathBuf::from(&expanded);
            if base.is_dir() {
                let mut found_version_dirs = false;
                if let Ok(entries) = fs::read_dir(&base) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            // Filter to likely version directories (start with digit or contain .)
                            if name.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
                                || name.contains('.')
                            {
                                found_version_dirs = true;
                                results.push(DetectedPath {
                                    path: path.to_string_lossy().to_string(),
                                    label: name,
                                });
                            }
                        }
                    }
                }
                // If no version-like subdirectories found, the base path itself
                // is the installation (e.g., Fusion user config dir)
                if !found_version_dirs {
                    let label = base
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| expanded.clone());
                    results.push(DetectedPath {
                        path: base.to_string_lossy().to_string(),
                        label,
                    });
                }
            }
        }
    }

    // Sort by label descending (newest versions first)
    results.sort_by(|a, b| b.label.cmp(&a.label));
    results
}

// ─── Headless Program Detection ────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHeadlessProgram {
    pub program: String,
    pub executable: String,
    pub args_template: Vec<String>,
    pub language: String,
    pub version: Option<String>,
}

/// Detect executable files matching glob hints (unlike detect_program_paths which finds dirs).
fn detect_executable_paths(hints: &[String]) -> Vec<DetectedPath> {
    let mut results = Vec::new();

    for hint in hints {
        let expanded = expand_path(hint);

        if expanded.contains('*') {
            if let Ok(paths) = glob::glob(&expanded) {
                for entry in paths.flatten() {
                    if entry.is_file() {
                        let label = entry
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        results.push(DetectedPath {
                            path: entry.to_string_lossy().to_string(),
                            label,
                        });
                    }
                }
            }
        } else {
            let path = PathBuf::from(&expanded);
            if path.is_file() {
                let label = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                results.push(DetectedPath {
                    path: path.to_string_lossy().to_string(),
                    label,
                });
            }
        }
    }

    // Sort by path descending so higher version numbers come first
    results.sort_by(|a, b| b.path.cmp(&a.path));
    results
}

/// Extract a version-like string from a path (e.g. "21.0.512" from "Houdini 21.0.512").
fn extract_version_from_path(path: &str) -> Option<String> {
    // Match patterns like "21.0.512", "4.4", "2022.3.48f1"
    let mut best: Option<String> = None;
    for segment in path.split(&['/', '\\', ' '][..]) {
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Check if segment starts with a digit and contains a dot
        if trimmed.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
            && trimmed.contains('.')
        {
            best = Some(trimmed.to_string());
        }
    }
    best
}

#[tauri::command]
pub async fn detect_headless_programs(repo: String) -> Result<Vec<DetectedHeadlessProgram>, String> {
    // Reuse cached registry (no force refresh — auto-detection is best-effort)
    let registry = fetch_bridge_registry(repo, None).await?;

    let bridges = registry
        .get("bridges")
        .and_then(|b| b.as_array())
        .ok_or("No bridges array in registry")?;

    let platform_key = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };

    let mut results: Vec<DetectedHeadlessProgram> = Vec::new();

    for bridge in bridges {
        let headless = match bridge.get("headless") {
            Some(h) if h.is_object() => h,
            _ => continue,
        };

        let program = bridge
            .get("program")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        if program.is_empty() {
            continue;
        }

        let args_template: Vec<String> = headless
            .get("argsTemplate")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let language = headless
            .get("language")
            .and_then(|l| l.as_str())
            .unwrap_or("python")
            .to_string();

        // Get platform-specific detection hints
        let hints: Vec<String> = headless
            .get("detect")
            .and_then(|d| d.get(platform_key))
            .and_then(|h| h.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        if hints.is_empty() {
            continue;
        }

        let detected = detect_executable_paths(&hints);

        if let Some(best) = detected.first() {
            let version = extract_version_from_path(&best.path);
            results.push(DetectedHeadlessProgram {
                program,
                executable: best.path.clone(),
                args_template,
                language,
                version,
            });
        }
    }

    Ok(results)
}

// ─── Installed Bridges Tracking ─────────────────────────────────────────

#[tauri::command]
pub fn get_installed_bridges() -> Value {
    let path = match bridges_state_path() {
        Ok(p) => p,
        Err(_) => return json!({ "installed": [] }),
    };

    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "installed": [] }))
}

#[tauri::command]
pub fn save_bridge_installation(
    bridge_id: String,
    version: String,
    install_path: String,
    install_type: Option<String>,
    files: Option<Vec<String>>,
) -> Result<(), String> {
    let path = bridges_state_path()?;
    let mut state: InstalledBridgesFile = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(InstalledBridgesFile {
            installed: Vec::new(),
        });

    let expanded = expand_path(&install_path);

    // For project-based bridges, keep multiple installations (one per project).
    // Remove only the entry with the same id AND path (re-install / update).
    // For other types, remove any existing entry for this bridge id.
    if install_type.as_deref() == Some("project") {
        state.installed.retain(|b| !(b.id == bridge_id && b.install_path == expanded));
    } else {
        state.installed.retain(|b| b.id != bridge_id);
    }

    // Add new entry
    state.installed.push(InstalledBridge {
        id: bridge_id,
        version,
        install_path: expanded,
        installed_at: now_iso(),
        files,
    });

    // Write
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(&state).map_err(|e| format!("JSON error: {e}"))?;
    fs::write(&path, format!("{content}\n")).map_err(|e| format!("Write error: {e}"))?;

    Ok(())
}

/// Recursively remove any filesystem entry whose path contains "arkestrator"
/// (case-insensitive) in any component. Used as a fallback for pre-0.1.76
/// installs that don't have a tracked file list.
fn recursive_remove_arkestrator(dir: &std::path::Path) -> u32 {
    let mut removed = 0u32;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.contains("arkestrator") {
            if p.is_dir() {
                if fs::remove_dir_all(&p).is_ok() {
                    removed += 1;
                }
            } else if fs::remove_file(&p).is_ok() {
                removed += 1;
            }
            continue;
        }
        if p.is_dir() {
            removed += recursive_remove_arkestrator(&p);
        }
    }
    removed
}

/// Remove empty ancestor directories up to (but not including) `stop_at`.
fn prune_empty_dirs(mut dir: PathBuf, stop_at: &std::path::Path) {
    while dir.starts_with(stop_at) && dir != stop_at {
        match fs::read_dir(&dir) {
            Ok(mut it) => {
                if it.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if fs::remove_dir(&dir).is_err() {
            return;
        }
        if !dir.pop() {
            return;
        }
    }
}

#[tauri::command]
pub fn uninstall_bridge(bridge_id: String, install_path: String) -> Result<(), String> {
    let expanded = expand_path(&install_path);
    let target = PathBuf::from(&expanded);

    // Look up the tracking entry first — we need its `files` list (if any)
    // to know exactly what to remove from shared directories.
    let state_path = bridges_state_path()?;
    let mut state: InstalledBridgesFile = fs::read_to_string(&state_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(InstalledBridgesFile { installed: Vec::new() });

    let tracked = state
        .installed
        .iter()
        .find(|b| b.id == bridge_id && b.install_path == expanded)
        .cloned();

    if target.exists() {
        let is_bridge_owned = target
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase().contains("arkestrator"))
            .unwrap_or(false);

        if is_bridge_owned {
            // Bridge-owned directory: delete it entirely.
            if let Err(e) = fs::remove_dir_all(&target) {
                eprintln!("[bridges] uninstall: failed to remove {}: {e}", target.display());
            }
        } else if let Some(files) = tracked.as_ref().and_then(|t| t.files.as_ref()) {
            // Shared directory with a tracked file list: remove exactly those
            // files, then prune any now-empty ancestor dirs up to target.
            for rel in files {
                let p = target.join(rel);
                if p.exists() {
                    let _ = fs::remove_file(&p);
                }
                if let Some(parent) = p.parent() {
                    prune_empty_dirs(parent.to_path_buf(), &target);
                }
            }
        } else {
            // Fallback for old installs without a tracked file list:
            // recursively scan for any path component containing "arkestrator".
            let removed = recursive_remove_arkestrator(&target);
            if removed == 0 {
                eprintln!(
                    "[bridges] uninstall: no arkestrator files found under {}",
                    target.display()
                );
            }
        }
    }

    // Always remove the tracking entry, even if filesystem cleanup was a
    // no-op. Leaving a stale entry means the UI gets stuck showing a bridge
    // as "installed" with no way to uninstall it.
    state
        .installed
        .retain(|b| !(b.id == bridge_id && b.install_path == expanded));
    let content = serde_json::to_string_pretty(&state).map_err(|e| format!("JSON error: {e}"))?;
    let _ = fs::write(&state_path, format!("{content}\n"));

    Ok(())
}

#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    let expanded = expand_path(&path);
    PathBuf::from(&expanded).exists()
}
