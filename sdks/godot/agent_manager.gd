@tool
class_name AgentManager
extends RefCounted
## Single-file SDK for submitting Arkestrator jobs from any Godot plugin.
##
## Usage:
##   var am := AgentManager.new()
##   am.submit("add a health bar to the player HUD", func(job): print(job))
##
##   # With options:
##   am.submit("optimize this shader", func(job): print(job), {
##       "priority": "high",
##       "targetWorkerName": "my-workstation",
##   })
##
##   # Check job status:
##   am.get_job("job-uuid-here", func(job): print(job.status))
##
##   # Wait for completion:
##   am.wait("job-uuid-here", func(job): print("Done:", job.status))
##
## Bridge-first mode:
##   If the Arkestrator bridge plugin is active in the editor, the SDK
##   routes through it so the job automatically gets editor context
##   (selected nodes, open scripts, project path). Falls back to REST
##   if the bridge is not running.

const SDK_VERSION := "1.0.0"
const PROTOCOL_VERSION := 1  ## Must match server's PROTOCOL_VERSION

## Emitted when a job is submitted successfully. Payload is the job dict.
signal job_submitted(job: Dictionary)
## Emitted on any API error. Payload is the error message.
signal error(message: String)
## Emitted with the health dict after check_server() completes.
signal server_checked(health: Dictionary)

var _server_url: String = ""
var _api_key: String = ""
var _configured := false


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

## Manually configure server URL and API key.
## If not called, auto-discovers from ~/.arkestrator/config.json
func configure(server_url: String, api_key: String) -> void:
	_server_url = server_url.strip_edges()
	_api_key = api_key.strip_edges()
	_configured = true


func _ensure_config() -> void:
	if _configured:
		return
	var config := _read_shared_config()
	if config.is_empty():
		return

	_api_key = str(config.get("apiKey", ""))
	var ws_url := str(config.get("wsUrl", "ws://localhost:7800/ws"))
	# Convert ws URL to http
	_server_url = ws_url.replace("ws://", "http://").replace("wss://", "https://")
	if _server_url.ends_with("/ws"):
		_server_url = _server_url.substr(0, _server_url.length() - 3)
	_configured = true


func _read_shared_config() -> Dictionary:
	var home := ""
	if OS.has_feature("windows"):
		home = OS.get_environment("USERPROFILE")
	else:
		home = OS.get_environment("HOME")
	if home.is_empty():
		return {}
	for config_dir in [".arkestrator"]:
		var config_path := home.path_join(config_dir).path_join("config.json")
		if not FileAccess.file_exists(config_path):
			continue
		var file := FileAccess.open(config_path, FileAccess.READ)
		if file == null:
			continue
		var text := file.get_as_text()
		file.close()
		var parsed = JSON.parse_string(text)
		if parsed is Dictionary:
			return parsed
	return {}


# ---------------------------------------------------------------------------
# Bridge detection
# ---------------------------------------------------------------------------

func _try_get_bridge() -> Node:
	## Try to find the Arkestrator bridge plugin in the editor.
	## Returns the plugin node if found and connected, null otherwise.
	if not Engine.has_meta("arkestrator_bridge"):
		return null
	var bridge = Engine.get_meta("arkestrator_bridge")
	if bridge == null or not is_instance_valid(bridge):
		Engine.remove_meta("arkestrator_bridge")
		return null
	return bridge


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

## Check server health, version, and capabilities.
## Calls [param callback] with the health Dictionary on success.
## Emits [signal server_checked] with the health dict.
## Emits [signal error] if the server protocol version is newer than the SDK.
func check_server(callback: Callable = Callable()) -> void:
	_ensure_config()
	_http_get("/health", func(health: Dictionary):
		var server_protocol: int = int(health.get("protocolVersion", 0))
		if server_protocol > PROTOCOL_VERSION:
			error.emit(
				"Server protocol version %d is newer than SDK protocol version %d. Please update the SDK."
				% [server_protocol, PROTOCOL_VERSION]
			)
			return
		server_checked.emit(health)
		if callback.is_valid():
			callback.call(health)
	)


## Check whether the server supports a specific capability.
## Calls [param callback] with [code]true[/code] or [code]false[/code].
func has_capability(capability: String, callback: Callable) -> void:
	check_server(func(health: Dictionary):
		var caps: Array = health.get("capabilities", []) as Array
		if callback.is_valid():
			callback.call(caps.has(capability))
	)


## Submit a job to the Arkestrator server.
##
## Tries the local bridge first (if active) so editor context is included
## automatically. Falls back to REST API.
##
## [param prompt] The task prompt for the AI agent.
## [param callback] Called with the created job Dictionary on success.
## [param options] Optional dict with: priority, agentConfigId,
##     targetWorkerName, projectId, dependsOn, startPaused, preferredMode,
##     editorContext, files, contextItems.
## [param use_bridge] If true (default), try bridge-first.
func submit(prompt: String, callback: Callable = Callable(),
			options: Dictionary = {}, use_bridge: bool = true) -> void:
	# --- Try bridge-first ---
	if use_bridge:
		var bridge := _try_get_bridge()
		if bridge != null and bridge.has_method("submit_job"):
			var result = bridge.call("submit_job", prompt, options)
			if result is Dictionary and result.has("id"):
				job_submitted.emit(result)
				if callback.is_valid():
					callback.call(result)
				return

	# --- REST fallback ---
	_ensure_config()

	var body: Dictionary = {
		"prompt": prompt,
		"priority": options.get("priority", "normal"),
		"editorContext": options.get("editorContext", {
			"projectRoot": ProjectSettings.globalize_path("res://"),
			"activeFile": "",
			"metadata": {},
		}),
		"files": options.get("files", []),
	}

	if options.has("agentConfigId"):
		body["agentConfigId"] = options["agentConfigId"]
	if options.has("targetWorkerName"):
		body["targetWorkerName"] = options["targetWorkerName"]
	if options.has("projectId"):
		body["projectId"] = options["projectId"]
	if options.has("dependsOn"):
		body["dependsOn"] = options["dependsOn"]
	if options.get("startPaused", false):
		body["startPaused"] = true
	if options.has("preferredMode"):
		body["preferredMode"] = options["preferredMode"]
	if options.has("contextItems"):
		body["contextItems"] = options["contextItems"]

	_http_post("/api/jobs", body, func(result: Dictionary):
		job_submitted.emit(result)
		if callback.is_valid():
			callback.call(result)
	)


## Get the current state of a job.
func get_job(job_id: String, callback: Callable) -> void:
	_ensure_config()
	_http_get("/api/jobs/%s" % job_id, callback)


## Poll until a job reaches a terminal state (completed/failed/cancelled).
## Calls callback with the final job dict, or emits error on timeout.
func wait(job_id: String, callback: Callable,
		  timeout_sec: float = 600.0, poll_interval: float = 2.0) -> void:
	_ensure_config()
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		error.emit("Cannot wait: no SceneTree available")
		return
	_poll_job(job_id, callback, timeout_sec, poll_interval, Time.get_ticks_msec())


func _poll_job(job_id: String, callback: Callable,
			   timeout_sec: float, interval: float, start_ms: int) -> void:
	var elapsed := (Time.get_ticks_msec() - start_ms) / 1000.0
	if elapsed >= timeout_sec:
		error.emit("Timed out waiting for job %s after %.0fs" % [job_id, timeout_sec])
		return
	get_job(job_id, func(job: Dictionary):
		var status := str(job.get("status", ""))
		if status in ["completed", "failed", "cancelled"]:
			callback.call(job)
		else:
			# Schedule next poll
			var tree := Engine.get_main_loop() as SceneTree
			if tree != null:
				tree.create_timer(interval).timeout.connect(
					func(): _poll_job(job_id, callback, timeout_sec, interval, start_ms)
				)
	)


## Cancel a running or queued job.
func cancel_job(job_id: String, callback: Callable = Callable()) -> void:
	_ensure_config()
	_http_post("/api/jobs/%s/cancel" % job_id, {}, callback)


## List available agent configurations.
func list_agents(callback: Callable) -> void:
	_ensure_config()
	_http_get("/api/agent-configs", callback)


## List known workers.
func list_workers(callback: Callable) -> void:
	_ensure_config()
	_http_get("/api/workers", callback)


# ---------------------------------------------------------------------------
# HTTP helpers (async via HTTPRequest node)
# ---------------------------------------------------------------------------

func _http_get(path: String, callback: Callable) -> void:
	var http := HTTPRequest.new()
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null or tree.root == null:
		error.emit("Cannot make HTTP request: no SceneTree")
		return
	tree.root.add_child(http)
	http.request_completed.connect(func(result: int, code: int, headers: PackedStringArray, body: PackedByteArray):
		http.queue_free()
		if result != HTTPRequest.RESULT_SUCCESS or code < 200 or code >= 300:
			var err_text := body.get_string_from_utf8() if body.size() > 0 else "HTTP %d" % code
			error.emit("GET %s failed: %s" % [path, err_text])
			return
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if callback.is_valid() and parsed != null:
			callback.call(parsed)
	)
	var url := _server_url + path
	var req_headers := PackedStringArray([
		"Authorization: Bearer %s" % _api_key,
		"Content-Type: application/json",
	])
	http.request(url, req_headers, HTTPClient.METHOD_GET)


func _http_post(path: String, body: Dictionary, callback: Callable) -> void:
	var http := HTTPRequest.new()
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null or tree.root == null:
		error.emit("Cannot make HTTP request: no SceneTree")
		return
	tree.root.add_child(http)
	http.request_completed.connect(func(result: int, code: int, headers: PackedStringArray, resp_body: PackedByteArray):
		http.queue_free()
		if result != HTTPRequest.RESULT_SUCCESS or code < 200 or code >= 300:
			var err_text := resp_body.get_string_from_utf8() if resp_body.size() > 0 else "HTTP %d" % code
			error.emit("POST %s failed: %s" % [path, err_text])
			return
		var parsed = JSON.parse_string(resp_body.get_string_from_utf8())
		if callback.is_valid() and parsed != null:
			callback.call(parsed)
	)
	var url := _server_url + path
	var req_headers := PackedStringArray([
		"Authorization: Bearer %s" % _api_key,
		"Content-Type: application/json",
	])
	http.request(url, req_headers, HTTPClient.METHOD_POST, JSON.stringify(body))

