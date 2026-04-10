use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static COMFYUI_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedComfyPath {
    pub path: String,
    pub label: String,
    pub has_main_py: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

fn shared_config_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".arkestrator").join("config.json"))
}

fn read_shared_config_json(path: &PathBuf) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}))
}

fn write_shared_config_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("JSON serialize error: {e}"))?;
    std::fs::write(path, format!("{content}\n"))
        .map_err(|e| format!("Failed to write config: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms).ok();
    }

    Ok(())
}

/// Detect common ComfyUI installation locations across platforms.
#[tauri::command]
pub fn detect_comfyui_paths() -> Vec<DetectedComfyPath> {
    let mut results = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(home) = home_dir() {
        // Prefer subdirectory installs (e.g. ~/AI/ComfyUI) which tend to have proper venvs
        candidates.push(home.join("AI").join("ComfyUI"));
        candidates.push(home.join("ai").join("ComfyUI"));
        candidates.push(home.join("ComfyUI"));
        candidates.push(home.join("comfyui"));
        // Common dev/git checkout locations
        candidates.push(home.join("Documents").join("Github").join("ComfyUI"));
        candidates.push(home.join("Documents").join("github").join("ComfyUI"));

        #[cfg(target_os = "windows")]
        {
            candidates.push(PathBuf::from("C:\\ComfyUI"));
            candidates.push(PathBuf::from("C:\\comfyui"));
            candidates.push(home.join("Desktop").join("ComfyUI"));
            candidates.push(home.join("Documents").join("ComfyUI"));
            // Common portable/installer paths
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                candidates.push(PathBuf::from(&local).join("ComfyUI"));
            }
            if let Ok(programs) = std::env::var("PROGRAMFILES") {
                candidates.push(PathBuf::from(&programs).join("ComfyUI"));
            }
        }

        #[cfg(target_os = "macos")]
        {
            candidates.push(home.join("Applications").join("ComfyUI"));
            candidates.push(PathBuf::from("/Applications/ComfyUI"));
        }

        #[cfg(target_os = "linux")]
        {
            candidates.push(PathBuf::from("/opt/ComfyUI"));
            candidates.push(PathBuf::from("/opt/comfyui"));
        }
    }

    // Also check COMFYUI_DIR env var
    if let Ok(dir) = std::env::var("COMFYUI_DIR") {
        let p = PathBuf::from(&dir);
        if !candidates.contains(&p) {
            candidates.insert(0, p);
        }
    }

    let mut seen = std::collections::HashSet::new();
    for candidate in &candidates {
        let canonical = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if !candidate.is_dir() {
            continue;
        }
        let has_main = candidate.join("main.py").exists();
        let label = if has_main {
            format!("{} (main.py found)", candidate.display())
        } else {
            format!("{} (no main.py)", candidate.display())
        };
        results.push(DetectedComfyPath {
            path: candidate.to_string_lossy().to_string(),
            label,
            has_main_py: has_main,
        });
    }

    results
}

/// Find a suitable python executable on the system.
fn find_python() -> String {
    // Check for python in ComfyUI's own venv first is handled by caller
    // Here we return the best global python
    let candidates = if cfg!(target_os = "windows") {
        vec!["python", "python3", "py"]
    } else {
        vec!["python3", "python"]
    };

    for cmd in &candidates {
        let result = Command::new(cmd)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(status) = result {
            if status.success() {
                return cmd.to_string();
            }
        }
    }

    // Fallback
    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Launch ComfyUI as a background process.
#[tauri::command]
pub fn launch_comfyui(comfyui_path: String, extra_args: Vec<String>) -> Result<String, String> {
    let path = PathBuf::from(&comfyui_path);
    if !path.is_dir() {
        return Err(format!("ComfyUI directory not found: {comfyui_path}"));
    }
    let main_py = path.join("main.py");
    if !main_py.exists() {
        return Err(format!("main.py not found in {comfyui_path}"));
    }

    // Check if already running
    {
        let mut guard = COMFYUI_PROCESS.lock().map_err(|e| format!("Lock error: {e}"))?;
        if let Some(ref mut child) = *guard {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited, clear it
                    *guard = None;
                }
                Ok(None) => {
                    return Err("ComfyUI is already running".to_string());
                }
                Err(_) => {
                    *guard = None;
                }
            }
        }
    }

    // Determine python executable — prefer venv if available
    let venv_python = if cfg!(target_os = "windows") {
        path.join("venv").join("Scripts").join("python.exe")
    } else {
        path.join("venv").join("bin").join("python")
    };
    let python = if venv_python.exists() {
        venv_python.to_string_lossy().to_string()
    } else {
        find_python()
    };

    let mut args = vec!["main.py".to_string()];
    args.extend(extra_args);

    let mut command = Command::new(&python);
    command
        .args(&args)
        .current_dir(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to launch ComfyUI: {err}"))?;

    let pid = child.id();
    {
        let mut guard = COMFYUI_PROCESS.lock().map_err(|e| format!("Lock error: {e}"))?;
        *guard = Some(child);
    }

    Ok(format!("ComfyUI launched (PID {pid})"))
}

/// Stop the managed ComfyUI process.
#[tauri::command]
pub fn stop_comfyui() -> Result<String, String> {
    let mut guard = COMFYUI_PROCESS.lock().map_err(|e| format!("Lock error: {e}"))?;
    match guard.take() {
        Some(mut child) => {
            let pid = child.id();
            child.kill().map_err(|e| format!("Failed to kill ComfyUI (PID {pid}): {e}"))?;
            let _ = child.wait();
            Ok(format!("ComfyUI stopped (PID {pid})"))
        }
        None => Ok("ComfyUI is not running".to_string()),
    }
}

/// Check if the managed ComfyUI process is still alive.
#[tauri::command]
pub fn is_comfyui_running() -> bool {
    let mut guard = match COMFYUI_PROCESS.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

/// Check if arkestrator custom nodes are installed in ComfyUI.
#[tauri::command]
pub fn check_comfyui_nodes(comfyui_path: String) -> Result<Value, String> {
    let base = PathBuf::from(&comfyui_path).join("custom_nodes");
    // Check both directory names — zip extracts as arkestrator_bridge, legacy used arkestrator
    let nodes_dir = if base.join("arkestrator_bridge").exists() {
        base.join("arkestrator_bridge")
    } else {
        base.join("arkestrator")
    };

    if !nodes_dir.exists() {
        return Ok(json!({ "installed": false }));
    }

    // Check for __init__.py or manifest to confirm valid installation
    let has_init = nodes_dir.join("__init__.py").exists();
    let has_manifest = nodes_dir.join("manifest.json").exists();

    Ok(json!({
        "installed": has_init || has_manifest,
        "path": nodes_dir.to_string_lossy(),
    }))
}

/// Get/set ComfyUI auto-start preference from shared config.
#[tauri::command]
pub fn get_comfyui_autostart() -> Result<Value, String> {
    let path = shared_config_path()?;
    let config = read_shared_config_json(&path);
    let auto_start = config
        .get("comfyuiAutoStart")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let comfyui_path = config
        .get("comfyuiPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(json!({ "autoStart": auto_start, "comfyuiPath": comfyui_path }))
}

#[tauri::command]
pub fn set_comfyui_autostart(
    auto_start: bool,
    comfyui_path: Option<String>,
) -> Result<(), String> {
    let path = shared_config_path()?;
    let mut config = read_shared_config_json(&path);
    config["comfyuiAutoStart"] = json!(auto_start);
    if let Some(p) = comfyui_path {
        config["comfyuiPath"] = json!(p);
    }
    write_shared_config_json(&path, &config)?;
    Ok(())
}

/// Auto-start ComfyUI if configured. Called during app setup.
pub fn auto_start_comfyui_if_configured() {
    let path = match shared_config_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let config = read_shared_config_json(&path);
    let auto_start = config
        .get("comfyuiAutoStart")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let comfyui_path = config
        .get("comfyuiPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if auto_start && !comfyui_path.is_empty() {
        let dir = PathBuf::from(&comfyui_path);
        if dir.is_dir() && dir.join("main.py").exists() {
            // Launch in a separate thread to not block app startup
            std::thread::spawn(move || {
                // Brief delay to let main window initialize
                std::thread::sleep(std::time::Duration::from_secs(2));
                match launch_comfyui(comfyui_path, vec!["--listen".to_string()]) {
                    Ok(msg) => eprintln!("[arkestrator] ComfyUI auto-start: {msg}"),
                    Err(err) => eprintln!("[arkestrator] ComfyUI auto-start failed: {err}"),
                }
            });
        }
    }
}

/// Clean up ComfyUI process on app exit.
pub fn shutdown_comfyui() {
    if let Ok(mut guard) = COMFYUI_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            eprintln!("[arkestrator] Stopping ComfyUI (PID {pid})...");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
