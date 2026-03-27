mod bridges;
mod comfyui;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{create_dir_all, remove_file, write};
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use url::Url;
use uuid::Uuid;

const TRAY_ID: &str = "arkestrator-tray";
const TRAY_MENU_SHOW: &str = "show";
const TRAY_MENU_HIDE: &str = "hide";
const TRAY_MENU_QUIT: &str = "quit";
const BRIDGE_RELAY_HOST: &str = "127.0.0.1";
const BRIDGE_RELAY_START_PORT: u16 = 17800;
const BRIDGE_RELAY_PORT_SPAN: u16 = 20;

#[derive(Clone)]
struct RelayTarget {
    host: String,
    port: u16,
}

struct RelayRuntime {
    target: Arc<RwLock<RelayTarget>>,
    listen_port: u16,
}

#[derive(Clone)]
struct BridgeConfigUrls {
    server_url: String,
    ws_url: String,
    remote_server_url: Option<String>,
    remote_ws_url: Option<String>,
    relay_port: Option<u16>,
}

static BRIDGE_RELAY: OnceLock<Mutex<Option<RelayRuntime>>> = OnceLock::new();

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

fn shared_config_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(".arkestrator").join("config.json"))
}

fn relay_state() -> &'static Mutex<Option<RelayRuntime>> {
    BRIDGE_RELAY.get_or_init(|| Mutex::new(None))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "" | "localhost" | "127.0.0.1" | "::1"
    )
}

fn parse_url(raw: &str) -> Option<Url> {
    Url::parse(raw.trim()).ok()
}

fn copy_stream(mut reader: TcpStream, mut writer: TcpStream) {
    let _ = io::copy(&mut reader, &mut writer);
    let _ = writer.shutdown(Shutdown::Write);
}

fn handle_relay_connection(client: TcpStream, target: RelayTarget) {
    let upstream = match TcpStream::connect((target.host.as_str(), target.port)) {
        Ok(stream) => stream,
        Err(err) => {
            log::warn!(
                "bridge relay: failed to connect to {}:{}: {}",
                target.host,
                target.port,
                err
            );
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };

    let client_reader = match client.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let upstream_reader = match upstream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };

    let a = thread::spawn(move || copy_stream(client_reader, upstream));
    let b = thread::spawn(move || copy_stream(upstream_reader, client));
    let _ = a.join();
    let _ = b.join();
}

fn bind_bridge_relay_listener() -> Result<(TcpListener, u16), String> {
    for offset in 0..BRIDGE_RELAY_PORT_SPAN {
        let port = BRIDGE_RELAY_START_PORT + offset;
        match TcpListener::bind((BRIDGE_RELAY_HOST, port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(_) => continue,
        }
    }

    let listener = TcpListener::bind((BRIDGE_RELAY_HOST, 0))
        .map_err(|e| format!("Failed to bind local bridge relay: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local relay address: {e}"))?
        .port();
    Ok((listener, port))
}

fn ensure_local_bridge_relay(target: RelayTarget) -> Result<u16, String> {
    let state = relay_state();
    let mut guard = state
        .lock()
        .map_err(|_| "Failed to lock bridge relay state".to_string())?;

    if let Some(runtime) = guard.as_ref() {
        if let Ok(mut current) = runtime.target.write() {
            *current = target;
        }
        return Ok(runtime.listen_port);
    }

    let (listener, listen_port) = bind_bridge_relay_listener()?;
    let shared_target = Arc::new(RwLock::new(target));
    let accept_target = Arc::clone(&shared_target);
    thread::spawn(move || {
        for accepted in listener.incoming() {
            match accepted {
                Ok(client) => {
                    let target = match accept_target.read() {
                        Ok(current) => current.clone(),
                        Err(_) => continue,
                    };
                    thread::spawn(move || handle_relay_connection(client, target));
                }
                Err(err) => {
                    log::warn!("bridge relay accept failed: {}", err);
                }
            }
        }
    });

    *guard = Some(RelayRuntime {
        target: shared_target,
        listen_port,
    });

    Ok(listen_port)
}

fn relay_urls_for_target(
    server_url: &str,
    ws_url: &str,
    listen_port: u16,
) -> Option<BridgeConfigUrls> {
    let parsed_server = parse_url(server_url)?;
    let parsed_ws = parse_url(ws_url)?;

    let local_server = format!(
        "http://{}:{}{}",
        BRIDGE_RELAY_HOST,
        listen_port,
        parsed_server.path()
    );
    let local_ws = format!(
        "ws://{}:{}{}",
        BRIDGE_RELAY_HOST,
        listen_port,
        parsed_ws.path()
    );

    Some(BridgeConfigUrls {
        server_url: local_server,
        ws_url: local_ws,
        remote_server_url: Some(server_url.trim().to_string()),
        remote_ws_url: Some(ws_url.trim().to_string()),
        relay_port: Some(listen_port),
    })
}

fn bridge_config_urls(server_url: &str, ws_url: &str) -> BridgeConfigUrls {
    let parsed_server = parse_url(server_url);
    let parsed_ws = parse_url(ws_url);

    let Some(server) = parsed_server else {
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    };
    let Some(ws) = parsed_ws else {
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    };

    let Some(server_host) = server.host_str() else {
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    };
    let Some(ws_host) = ws.host_str() else {
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    };

    let server_port = server.port_or_known_default().unwrap_or(80);
    let ws_port = ws.port_or_known_default().unwrap_or(80);

    if is_loopback_host(server_host) && is_loopback_host(ws_host) {
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    }

    if !server_host.eq_ignore_ascii_case(ws_host) || server_port != ws_port {
        log::warn!(
            "bridge relay skipped because server/ws endpoints differ: {}:{} vs {}:{}",
            server_host,
            server_port,
            ws_host,
            ws_port
        );
        return BridgeConfigUrls {
            server_url: server_url.trim().to_string(),
            ws_url: ws_url.trim().to_string(),
            remote_server_url: None,
            remote_ws_url: None,
            relay_port: None,
        };
    }

    let listen_port = match ensure_local_bridge_relay(RelayTarget {
        host: ws_host.to_string(),
        port: ws_port,
    }) {
        Ok(port) => port,
        Err(err) => {
            log::warn!("bridge relay startup failed: {}", err);
            return BridgeConfigUrls {
                server_url: server_url.trim().to_string(),
                ws_url: ws_url.trim().to_string(),
                remote_server_url: None,
                remote_ws_url: None,
                relay_port: None,
            };
        }
    };

    relay_urls_for_target(server_url, ws_url, listen_port).unwrap_or(BridgeConfigUrls {
        server_url: server_url.trim().to_string(),
        ws_url: ws_url.trim().to_string(),
        remote_server_url: None,
        remote_ws_url: None,
        relay_port: None,
    })
}

fn restore_bridge_relay_from_config(value: &Value) {
    let remote_server_url = value
        .get("remoteServerUrl")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let remote_ws_url = value
        .get("remoteWsUrl")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty());

    let (Some(server_url), Some(ws_url)) = (remote_server_url, remote_ws_url) else {
        return;
    };

    let urls = bridge_config_urls(server_url, ws_url);
    if let Some(port) = urls.relay_port {
        log::info!("restored local bridge relay on port {}", port);
    }
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

#[tauri::command]
fn read_shared_config() -> Result<Value, String> {
    let path = shared_config_path()?;
    Ok(read_shared_config_json(&path))
}

fn is_valid_api_key(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() != 52 || !trimmed.starts_with("ark_") {
        return false;
    }
    trimmed
        .as_bytes()
        .iter()
        .skip(4)
        .all(|b| b.is_ascii_hexdigit())
}

fn load_or_create_machine_id() -> Result<String, String> {
    let path = shared_config_path()?;
    let mut json = read_shared_config_json(&path);
    if let Some(existing) = json.get("machineId").and_then(|v| v.as_str()) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let machine_id = Uuid::new_v4().to_string();
    json["machineId"] = Value::String(machine_id.clone());
    write_shared_config_json(&path, &json)?;
    Ok(machine_id)
}

#[tauri::command]
fn write_shared_config(
    server_url: String,
    ws_url: String,
    api_key: String,
    machine_id: String,
    worker_name: String,
) -> Result<String, String> {
    let path = shared_config_path()?;
    let mut json = read_shared_config_json(&path);
    let bridge_urls = bridge_config_urls(&server_url, &ws_url);
    if !json.is_object() {
        json = json!({});
    }
    let object = json
        .as_object_mut()
        .ok_or_else(|| "Shared config is not a JSON object".to_string())?;
    object.insert(
        "serverUrl".to_string(),
        Value::String(bridge_urls.server_url),
    );
    object.insert("wsUrl".to_string(), Value::String(bridge_urls.ws_url));
    if is_valid_api_key(&api_key) {
        object.insert("apiKey".to_string(), Value::String(api_key.trim().to_string()));
    } else {
        log::warn!("write_shared_config: refusing to overwrite shared apiKey with malformed value");
    }
    object.insert("machineId".to_string(), Value::String(machine_id));
    object.insert("workerName".to_string(), Value::String(worker_name));
    if let Some(remote_server_url) = bridge_urls.remote_server_url {
        object.insert(
            "remoteServerUrl".to_string(),
            Value::String(remote_server_url),
        );
    } else {
        object.remove("remoteServerUrl");
    }
    if let Some(remote_ws_url) = bridge_urls.remote_ws_url {
        object.insert("remoteWsUrl".to_string(), Value::String(remote_ws_url));
    } else {
        object.remove("remoteWsUrl");
    }
    if let Some(relay_port) = bridge_urls.relay_port {
        object.insert("bridgeRelayPort".to_string(), json!(relay_port));
        object.insert("bridgeRelayEnabled".to_string(), Value::Bool(true));
    } else {
        object.remove("bridgeRelayPort");
        object.remove("bridgeRelayEnabled");
    }
    write_shared_config_json(&path, &json)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn ensure_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;

    Ok(data_dir.to_string_lossy().to_string())
}

/// Resolve the Tauri-bundled admin-dist resource directory path.
/// Returns the path string if it exists, or an empty string if not found.
#[tauri::command]
fn resolve_admin_dist_path(app: tauri::AppHandle) -> String {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[admin-dist] failed to get resource dir: {e}");
            return String::new();
        }
    };
    // Tauri v2 rewrites `../` to `_up_/` in bundled resource paths (all platforms).
    // The tauri.conf.json entry `../resources/admin-dist` becomes `_up_/resources/admin-dist`.
    let candidates = [
        resource_dir.join("admin-dist"),
        resource_dir.join("resources/admin-dist"),
        resource_dir.join("_up_/resources/admin-dist"),
    ];
    for candidate in &candidates {
        if candidate.join("index.html").exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    eprintln!(
        "[admin-dist] not found; resource_dir={}, tried {} candidates",
        resource_dir.display(),
        candidates.len()
    );
    String::new()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineIdentity {
    hostname: String,
    os_user: String,
    machine_id: String,
}

fn preferred_machine_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for args in [["--get", "ComputerName"], ["--get", "LocalHostName"]] {
            if let Some(name) = run_command_capture("scutil", &args) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    let env_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if env_name.is_some() {
        return env_name;
    }

    let hostname = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_string();
    if hostname.is_empty() {
        None
    } else {
        Some(hostname)
    }
}

#[tauri::command]
fn get_machine_identity() -> MachineIdentity {
    let hostname = preferred_machine_name().unwrap_or_default();
    let os_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let machine_id = load_or_create_machine_id().unwrap_or_default();
    MachineIdentity {
        hostname,
        os_user,
        machine_id,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHardwareCapability {
    cpu_cores: Option<u32>,
    memory_gb: Option<u32>,
    gpu_renderer: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOllamaModel {
    name: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    digest: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOllamaModelsResponse {
    reachable: bool,
    models: Vec<LocalOllamaModel>,
}

fn first_non_empty_line(raw: &str) -> Option<String> {
    raw.lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn run_command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    // Hide the console window on Windows so spawned processes don't flash a CMD window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_command_capture(program: &str, args: &[&str]) -> Option<String> {
    let stdout = run_command_output(program, args)?;
    first_non_empty_line(&stdout)
}

fn parse_ollama_list_models(raw: &str) -> Vec<LocalOllamaModel> {
    let mut out = Vec::new();
    for line in raw
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
    {
        let mut cols = line.split_whitespace();
        let Some(name) = cols.next() else {
            continue;
        };
        if name.eq_ignore_ascii_case("name") {
            continue;
        }
        out.push(LocalOllamaModel {
            name: name.to_string(),
            size_bytes: None,
            modified_at: None,
            digest: None,
        });
    }
    out
}

#[allow(unused_mut)]
fn ollama_cli_candidates() -> Vec<String> {
    let mut out = vec!["ollama".to_string()];

    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            out.push(format!("{}\\Programs\\Ollama\\ollama.exe", local_app_data));
        }
        out.push(r"C:\Program Files\Ollama\ollama.exe".to_string());
    }

    out
}

#[tauri::command]
fn list_local_ollama_models() -> LocalOllamaModelsResponse {
    for candidate in ollama_cli_candidates() {
        if let Some(stdout) = run_command_output(&candidate, &["list"]) {
            return LocalOllamaModelsResponse {
                reachable: true,
                models: parse_ollama_list_models(&stdout),
            };
        }
    }

    LocalOllamaModelsResponse {
        reachable: false,
        models: Vec::new(),
    }
}

#[tauri::command]
fn pull_local_ollama_model(model: String) -> Result<String, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err("Model name is required".to_string());
    }

    let mut last_error: Option<String> = None;
    for candidate in ollama_cli_candidates() {
        let mut cmd = Command::new(&candidate);
        cmd.args(["pull", trimmed]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    return Ok(if stdout.is_empty() {
                        format!("Pulled model: {trimmed}")
                    } else {
                        stdout
                    });
                }
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_error = Some(stderr);
                } else {
                    last_error = Some(format!("Ollama pull exited with status {}", output.status));
                }
            }
            Err(err) => {
                last_error = Some(format!("{}: {}", candidate, err));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Unable to execute local Ollama pull".to_string()))
}

fn detect_nvidia_gpu_name() -> Option<String> {
    run_command_capture("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"])
        .map(|line| line.split(',').next().unwrap_or("").trim().to_string())
        .filter(|line| !line.is_empty())
}

fn detect_gpu_renderer() -> Option<String> {
    if let Some(name) = detect_nvidia_gpu_name() {
        return Some(name);
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(name) = run_command_capture(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | Select-Object -First 1",
            ],
        ) {
            return Some(name);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(line) = run_command_capture(
            "sh",
            &["-lc", "lspci | grep -E 'VGA|3D|Display' | head -n 1"],
        ) {
            return Some(line);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("system_profiler")
            .arg("SPDisplaysDataType")
            .output()
            .ok()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("Chipset Model:") {
                    let value = rest.trim();
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }

    None
}

fn detect_cpu_cores() -> Option<u32> {
    std::thread::available_parallelism()
        .ok()
        .map(|count| count.get() as u32)
}

fn detect_memory_gb() -> Option<u32> {
    let mut system = System::new();
    system.refresh_memory();
    let raw_total = system.total_memory();
    if raw_total == 0 {
        return None;
    }

    // sysinfo may report bytes (newer) or KiB (older). Normalize heuristically.
    let total_bytes = if raw_total < 128 * 1024 * 1024 {
        raw_total.saturating_mul(1024)
    } else {
        raw_total
    };
    let gb = ((total_bytes as f64) / (1024_f64 * 1024_f64 * 1024_f64)).round();
    if !gb.is_finite() || gb <= 0.0 {
        return None;
    }
    Some(gb as u32)
}

#[tauri::command]
fn get_local_hardware_capability() -> LocalHardwareCapability {
    LocalHardwareCapability {
        cpu_cores: detect_cpu_cores(),
        memory_gb: detect_memory_gb(),
        gpu_renderer: detect_gpu_renderer(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessCommandInput {
    script: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessProgramConfigInput {
    executable: String,
    args_template: Vec<String>,
    language: String,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum WorkerHeadlessExecutionInput {
    Commands {
        config: HeadlessProgramConfigInput,
        commands: Vec<HeadlessCommandInput>,
    },
    RawArgs {
        executable: String,
        args: Vec<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerHeadlessRunInput {
    program: String,
    project_path: Option<String>,
    timeout_ms: Option<u64>,
    execution: WorkerHeadlessExecutionInput,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerHeadlessRunResult {
    success: bool,
    executed: u32,
    failed: u32,
    skipped: u32,
    errors: Vec<String>,
    stdout: Option<String>,
    stderr: Option<String>,
    exit_code: Option<i32>,
    program: String,
    headless: bool,
}

fn normalize_headless_script(language: &str, script: &str) -> String {
    if !language.eq_ignore_ascii_case("gdscript") {
        return script.to_string();
    }

    let trimmed = script.trim();
    if trimmed.is_empty() {
        return script.to_string();
    }

    if trimmed.contains("extends ")
        || trimmed.contains("class_name ")
        || trimmed.contains("func _init(")
    {
        return script.to_string();
    }

    let indented = script
        .replace("\r\n", "\n")
        .lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("extends SceneTree\n\nfunc _init():\n{indented}\n    quit()\n")
}

fn run_local_process_with_timeout(
    executable: &str,
    args: &[String],
    project_path: Option<&str>,
    timeout_ms: u64,
) -> Result<(std::process::Output, bool), String> {
    let mut command = Command::new(executable);
    command.args(args);
    if let Some(path) = project_path.filter(|value| !value.trim().is_empty()) {
        let p = std::path::Path::new(path);
        // Only use as cwd if the path is an existing directory.
        // If it's a file, use its parent directory instead.
        // If it doesn't exist at all, skip setting cwd (use process default).
        if p.is_dir() {
            command.current_dir(path);
        } else if p.is_file() {
            if let Some(parent) = p.parent() {
                command.current_dir(parent);
            }
        }
        // else: path doesn't exist, skip — let the OS use the default cwd
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to spawn {executable}: {err}"))?;

    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.max(1_000));
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|err| format!("Failed to collect output from {executable}: {err}"))?;
                return Ok((output, false));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .map_err(|err| format!("Timed out and failed to collect output from {executable}: {err}"))?;
                    return Ok((output, true));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("Failed while waiting for {executable}: {err}"));
            }
        }
    }
}

#[tauri::command]
fn run_worker_headless(input: WorkerHeadlessRunInput) -> Result<WorkerHeadlessRunResult, String> {
    let program = input.program.trim().to_string();
    if program.is_empty() {
        return Err("Program is required".to_string());
    }

    let timeout_ms = input.timeout_ms.unwrap_or(60_000).clamp(1_000, 300_000);
    let project_path = input
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match input.execution {
        WorkerHeadlessExecutionInput::RawArgs { executable, args } => {
            let trimmed_exec = executable.trim();
            if trimmed_exec.is_empty() {
                return Err("Executable is required".to_string());
            }
            let (output, timed_out) =
                run_local_process_with_timeout(trimmed_exec, &args, project_path, timeout_ms)?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let mut errors = Vec::new();
            if timed_out {
                errors.push(format!("Timed out after {timeout_ms}ms"));
            }
            let success = output.status.success() && !timed_out;
            if !success && errors.is_empty() {
                errors.push(if !stderr.is_empty() {
                    stderr.clone()
                } else {
                    format!("Process exited with status {}", output.status)
                });
            }
            return Ok(WorkerHeadlessRunResult {
                success,
                executed: if success { 1 } else { 0 },
                failed: if success { 0 } else { 1 },
                skipped: 0,
                errors,
                stdout: if stdout.is_empty() { None } else { Some(stdout) },
                stderr: if stderr.is_empty() { None } else { Some(stderr) },
                exit_code: output.status.code(),
                program,
                headless: true,
            });
        }
        WorkerHeadlessExecutionInput::Commands { config, commands } => {
            if commands.is_empty() {
                return Err("At least one command is required".to_string());
            }

            let raw_script = commands
                .iter()
                .map(|command| command.script.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let combined_script = normalize_headless_script(&config.language, &raw_script);
            let needs_temp_file = config
                .args_template
                .iter()
                .any(|arg| arg.contains("{{SCRIPT_FILE}}"));

            let mut temp_file_path: Option<PathBuf> = None;
            if needs_temp_file {
                let temp_dir = std::env::temp_dir().join("arkestrator-headless");
                create_dir_all(&temp_dir)
                    .map_err(|err| format!("Failed to create temp dir {}: {err}", temp_dir.display()))?;
                let ext = if config.language.eq_ignore_ascii_case("gdscript") {
                    "gd"
                } else {
                    "py"
                };
                let temp_path = temp_dir.join(format!("headless-{}.{}", Uuid::new_v4(), ext));
                write(&temp_path, combined_script.as_bytes())
                    .map_err(|err| format!("Failed to write temp script {}: {err}", temp_path.display()))?;
                temp_file_path = Some(temp_path);
            }

            let project_placeholder = project_path.unwrap_or_default();
            let temp_file_string = temp_file_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default();
            let args = config
                .args_template
                .iter()
                .map(|arg| {
                    arg.replace("{{SCRIPT}}", &combined_script)
                        .replace("{{SCRIPT_FILE}}", &temp_file_string)
                        .replace("{{PROJECT_PATH}}", project_placeholder)
                })
                .collect::<Vec<_>>();

            let exec_result =
                run_local_process_with_timeout(&config.executable, &args, project_path, timeout_ms);

            if let Some(path) = temp_file_path {
                let _ = remove_file(path);
            }

            let (output, timed_out) = exec_result?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let mut errors = Vec::new();
            if timed_out {
                errors.push(format!("Timed out after {timeout_ms}ms"));
            }
            let success = output.status.success() && !timed_out;
            if !success && errors.is_empty() {
                errors.push(if !stderr.is_empty() {
                    stderr.clone()
                } else {
                    format!("Process exited with status {}", output.status)
                });
            }
            return Ok(WorkerHeadlessRunResult {
                success,
                executed: if success { commands.len() as u32 } else { 0 },
                failed: if success { 0 } else { commands.len() as u32 },
                skipped: 0,
                errors,
                stdout: if stdout.is_empty() { None } else { Some(stdout) },
                stderr: if stderr.is_empty() { None } else { Some(stderr) },
                exit_code: output.status.code(),
                program,
                headless: true,
            });
        }
    }
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.request_restart();
}

// --- Filesystem Commands ---
// These enable the client to act as a file delivery endpoint for cross-machine
// asset transfer (e.g., Blender exports on Machine A → Godot imports on Machine B).

#[derive(Deserialize)]
struct FileChangeInput {
    path: String,
    content: Option<String>,
    #[serde(rename = "binaryContent")]
    binary_content: Option<String>,
    encoding: Option<String>,
    action: String,
}

#[tauri::command]
fn fs_apply_file_changes(changes: Vec<FileChangeInput>) -> Result<Vec<String>, String> {
    use base64::Engine;
    let mut applied = Vec::new();
    for change in &changes {
        let path = std::path::Path::new(&change.path);
        match change.action.as_str() {
            "create" | "modify" => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent dir for {}: {e}", change.path))?;
                }
                if let Some(b64) = &change.binary_content {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|e| format!("Base64 decode failed for {}: {e}", change.path))?;
                    std::fs::write(path, &bytes)
                        .map_err(|e| format!("Failed to write binary {}: {e}", change.path))?;
                } else if change.encoding.as_deref() == Some("base64") {
                    let text = change.content.as_deref().unwrap_or("");
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(text)
                        .map_err(|e| format!("Base64 decode failed for {}: {e}", change.path))?;
                    std::fs::write(path, &bytes)
                        .map_err(|e| format!("Failed to write binary {}: {e}", change.path))?;
                } else {
                    let text = change.content.as_deref().unwrap_or("");
                    std::fs::write(path, text)
                        .map_err(|e| format!("Failed to write {}: {e}", change.path))?;
                }
                applied.push(change.path.clone());
            }
            "delete" => {
                if path.exists() {
                    if path.is_dir() {
                        std::fs::remove_dir_all(path)
                            .map_err(|e| format!("Failed to delete dir {}: {e}", change.path))?;
                    } else {
                        std::fs::remove_file(path)
                            .map_err(|e| format!("Failed to delete {}: {e}", change.path))?;
                    }
                    applied.push(change.path.clone());
                }
            }
            _ => {
                return Err(format!("Unknown action '{}' for path {}", change.action, change.path));
            }
        }
    }
    Ok(applied)
}

#[tauri::command]
fn fs_create_directory(path: String, recursive: bool) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if recursive {
        std::fs::create_dir_all(p)
    } else {
        std::fs::create_dir(p)
    }
    .map_err(|e| format!("Failed to create directory {}: {e}", path))
}

#[tauri::command]
fn fs_write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir for {}: {e}", path))?;
    }
    if encoding.as_deref() == Some("base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&content)
            .map_err(|e| format!("Base64 decode failed for {}: {e}", path))?;
        std::fs::write(p, &bytes)
            .map_err(|e| format!("Failed to write binary {}: {e}", path))
    } else {
        std::fs::write(p, &content)
            .map_err(|e| format!("Failed to write {}: {e}", path))
    }
}

#[tauri::command]
fn fs_read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn fs_delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p)
            .map_err(|e| format!("Failed to delete dir {}: {e}", path))
    } else {
        std::fs::remove_file(p)
            .map_err(|e| format!("Failed to delete {}: {e}", path))
    }
}

#[tauri::command]
fn fs_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Resolve the user's full login shell PATH by spawning their default shell
/// with the login flag. This captures PATH entries added by .zprofile,
/// .bash_profile, .profile, nvm, Homebrew, etc.
#[cfg(not(target_os = "windows"))]
fn resolve_user_shell_path() -> String {
    // Determine the user's default shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let result = Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match result {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix WebKit GPU compositing crash on Wayland
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    // On macOS/Linux, GUI apps launched from Finder/desktop inherit a minimal
    // PATH from launchd that excludes Homebrew, nvm, npm global, pnpm, bun,
    // cargo, and other user-installed tool directories. Resolve the user's
    // actual login shell PATH so the sidecar (and its spawned CLI agents like
    // claude, codex, gemini) can find everything the user has installed.
    #[cfg(not(target_os = "windows"))]
    {
        let shell_path = resolve_user_shell_path();
        if !shell_path.is_empty() {
            std::env::set_var("PATH", &shell_path);
            log::info!("Resolved user shell PATH ({} entries)", shell_path.split(':').count());
        } else if let Ok(home) = std::env::var("HOME") {
            // Fallback: manually prepend common tool directories
            let current = std::env::var("PATH").unwrap_or_default();
            let extra_dirs = [
                format!("{}/.bun/bin", home),
                format!("{}/.cargo/bin", home),
                "/opt/homebrew/bin".to_string(),
                "/usr/local/bin".to_string(),
                format!("{}/.local/bin", home),
                format!("{}/.nvm/current/bin", home),
                format!("{}/.npm-global/bin", home),
                format!("{}/.pnpm", home),
            ];
            let mut new_path = current.clone();
            for dir in &extra_dirs {
                if !current.split(':').any(|p| p == dir.as_str()) {
                    new_path = format!("{}:{}", dir, new_path);
                }
            }
            std::env::set_var("PATH", new_path);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_shared_config,
            write_shared_config,
            ensure_app_data_dir,
            resolve_admin_dist_path,
            get_machine_identity,
            get_local_hardware_capability,
            list_local_ollama_models,
            pull_local_ollama_model,
            run_worker_headless,
            restart_app,
            fs_apply_file_changes,
            fs_create_directory,
            fs_write_file,
            fs_read_file_base64,
            fs_delete_path,
            fs_exists,
            bridges::fetch_bridge_registry,
            bridges::download_and_install_bridge,
            bridges::detect_program_paths,
            bridges::get_installed_bridges,
            bridges::save_bridge_installation,
            bridges::uninstall_bridge,
            bridges::check_path_exists,
            comfyui::detect_comfyui_paths,
            comfyui::launch_comfyui,
            comfyui::stop_comfyui,
            comfyui::is_comfyui_running,
            comfyui::check_comfyui_nodes,
            comfyui::get_comfyui_autostart,
            comfyui::set_comfyui_autostart
        ])
        .setup(|app| {
            if let Ok(path) = shared_config_path() {
                let existing = read_shared_config_json(&path);
                restore_bridge_relay_from_config(&existing);
            }

            let tray_menu = MenuBuilder::new(app)
                .item(&MenuItemBuilder::with_id(TRAY_MENU_SHOW, "Show Arkestrator").build(app)?)
                .item(&MenuItemBuilder::with_id(TRAY_MENU_HIDE, "Hide Arkestrator").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id(TRAY_MENU_QUIT, "Quit").build(app)?)
                .build()?;

            let tray_icon = app.default_window_icon().cloned()
                .expect("default window icon must be set in tauri.conf.json");

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_icon)
                .icon_as_template(true) // macOS: use template rendering (monochrome in menu bar)
                .menu(&tray_menu)
                .tooltip("Arkestrator")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(&tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    TRAY_MENU_SHOW => show_main_window(app),
                    TRAY_MENU_HIDE => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    TRAY_MENU_QUIT => {
                        comfyui::shutdown_comfyui();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Auto-start ComfyUI if configured
            comfyui::auto_start_comfyui_if_configured();

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
