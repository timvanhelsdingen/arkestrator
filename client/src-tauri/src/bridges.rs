use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
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

#[tauri::command]
pub async fn fetch_bridge_registry(repo: String) -> Result<Value, String> {
    // Check cache first
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

    // Fetch from GitHub releases API
    let url = format!(
        "{}/repos/{}/releases/latest",
        GITHUB_API_BASE,
        repo.trim()
    );

    let client = reqwest::Client::new();
    let release: Value = client
        .get(&url)
        .header("User-Agent", "Arkestrator-Client")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {e}"))?;

    // Find registry.json asset
    let assets = release
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("No assets in release")?;

    let registry_asset = assets
        .iter()
        .find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n == "registry.json")
                .unwrap_or(false)
        })
        .ok_or("registry.json not found in release assets")?;

    let download_url = registry_asset
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .ok_or("No download URL for registry.json")?;

    let registry_text = client
        .get(download_url)
        .header("User-Agent", "Arkestrator-Client")
        .send()
        .await
        .map_err(|e| format!("Failed to download registry: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read registry: {e}"))?;

    let registry: Value = serde_json::from_str(&registry_text)
        .map_err(|e| format!("Failed to parse registry JSON: {e}"))?;

    // Inject release info into the registry
    let mut result = registry.clone();
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "releaseTag".to_string(),
            release
                .get("tag_name")
                .cloned()
                .unwrap_or(Value::Null),
        );
        obj.insert(
            "releaseUrl".to_string(),
            release
                .get("html_url")
                .cloned()
                .unwrap_or(Value::Null),
        );

        // Inject download URLs for each bridge asset
        if let Some(bridges) = obj.get_mut("bridges").and_then(|b| b.as_array_mut()) {
            for bridge in bridges.iter_mut() {
                if let Some(asset_pattern) = bridge.get("asset").and_then(|a| a.as_str()) {
                    let bridge_version = bridge
                        .get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let asset_name = asset_pattern.replace("{version}", bridge_version);

                    if let Some(asset) = assets.iter().find(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n == asset_name)
                            .unwrap_or(false)
                    }) {
                        if let Some(url) = asset.get("browser_download_url") {
                            bridge
                                .as_object_mut()
                                .map(|b| b.insert("downloadUrl".to_string(), url.clone()));
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
) -> Result<(), String> {
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

    // Remove existing installation if present
    if dest.exists() {
        fs::remove_dir_all(&dest)
            .map_err(|e| format!("Failed to remove existing installation: {e}"))?;
    }

    // Extract files
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let entry_path = file
            .enclosed_name()
            .ok_or("Invalid zip entry name")?
            .to_path_buf();

        let out_path = dest.parent().unwrap_or(Path::new(".")).join(&entry_path);

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
        }
    }

    Ok(())
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
                if let Ok(entries) = fs::read_dir(&base) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            // Filter to likely version directories (start with digit or contain .)
                            if name.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
                                || name.contains('.')
                            {
                                results.push(DetectedPath {
                                    path: path.to_string_lossy().to_string(),
                                    label: name,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by label descending (newest versions first)
    results.sort_by(|a, b| b.label.cmp(&a.label));
    results
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
) -> Result<(), String> {
    let path = bridges_state_path()?;
    let mut state: InstalledBridgesFile = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(InstalledBridgesFile {
            installed: Vec::new(),
        });

    // Remove existing entry for this bridge
    state.installed.retain(|b| b.id != bridge_id);

    // Add new entry
    state.installed.push(InstalledBridge {
        id: bridge_id,
        version,
        install_path: expand_path(&install_path),
        installed_at: now_iso(),
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

#[tauri::command]
pub fn uninstall_bridge(bridge_id: String, install_path: String) -> Result<(), String> {
    let expanded = expand_path(&install_path);
    let target = PathBuf::from(&expanded);

    // Remove bridge files
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove {}: {e}", target.display()))?;
    }

    // Remove from tracking
    let state_path = bridges_state_path()?;
    if let Ok(raw) = fs::read_to_string(&state_path) {
        if let Ok(mut state) = serde_json::from_str::<InstalledBridgesFile>(&raw) {
            state.installed.retain(|b| b.id != bridge_id);
            let content = serde_json::to_string_pretty(&state)
                .map_err(|e| format!("JSON error: {e}"))?;
            let _ = fs::write(&state_path, format!("{content}\n"));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    let expanded = expand_path(&path);
    PathBuf::from(&expanded).exists()
}
