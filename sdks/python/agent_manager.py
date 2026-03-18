"""Arkestrator SDK for Python-based DCC plugins.

Single-file SDK that any Python plugin (Blender, Houdini, Maya, Nuke, etc.)
can import to submit jobs to the Arkestrator server.

Usage:
    import agent_manager

    # Auto-discovers server URL + API key from ~/.arkestrator/config.json
    job = agent_manager.submit("add a health bar to the player HUD")
    print(job["id"], job["status"])

    # With options
    job = agent_manager.submit(
        "optimize this material node tree",
        priority="high",
        target_worker="my-workstation",
    )

    # Poll for completion
    result = agent_manager.wait(job["id"], timeout=300)
    print(result["status"])  # "completed" or "failed"

    # Check status without waiting
    status = agent_manager.get_job(job["id"])

Bridge-first mode:
    If the SDK detects a running bridge in the same process (e.g. the
    Arkestrator Blender addon is active), it routes through the bridge
    so the job automatically gets editor context (selected objects, open
    files, etc.) attached. Falls back to REST if no bridge is available.
"""

__version__ = "1.0.0"
PROTOCOL_VERSION = 1  # Must match server's PROTOCOL_VERSION
MIN_SERVER_VERSION = "0.1.0"

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Config auto-discovery
# ---------------------------------------------------------------------------

_config_cache: Optional[dict] = None


def _load_config() -> dict:
    """Read server URL + API key from shared config paths."""
    global _config_cache
    if _config_cache is not None:
        return _config_cache

    for dir_name in (".arkestrator",):
        config_path = Path.home() / dir_name / "config.json"
        if not config_path.exists():
            continue
        try:
            with open(config_path, "r") as f:
                _config_cache = json.load(f)
                return _config_cache
        except Exception:
            pass

    _config_cache = {}
    return _config_cache


def _get_server_url() -> str:
    """Get the HTTP server URL (not WS)."""
    config = _load_config()
    ws_url = config.get("wsUrl", "ws://localhost:7800/ws")
    # Convert ws:// URL to http://
    url = ws_url.replace("ws://", "http://").replace("wss://", "https://")
    # Strip /ws path
    if url.endswith("/ws"):
        url = url[:-3]
    return url


def _get_api_key() -> str:
    config = _load_config()
    return config.get("apiKey", "")


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only, no requests/httpx dependency)
# ---------------------------------------------------------------------------


def _request(method: str, path: str, body: Optional[dict] = None,
             server_url: Optional[str] = None,
             api_key: Optional[str] = None) -> dict:
    """Make an HTTP request to the Arkestrator server."""
    url = (server_url or _get_server_url()) + path
    key = api_key or _get_api_key()

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode("utf-8")
        except Exception:
            pass
        raise AgentManagerError(
            f"HTTP {e.code}: {error_body or e.reason}",
            status=e.code,
        ) from None
    except urllib.error.URLError as e:
        raise AgentManagerError(
            f"Connection failed: {e.reason}. Is the server running?"
        ) from None


# ---------------------------------------------------------------------------
# Bridge detection (optional, zero-cost if no bridge is loaded)
# ---------------------------------------------------------------------------


def _try_get_bridge():
    """Try to find a running Arkestrator bridge in the current process.

    Returns the bridge module's public API object, or None.
    Works for Blender (checks for loaded addon) and other Python DCCs.
    """
    # Blender
    try:
        import bpy  # noqa: F401
        from arkestrator_bridge import get_bridge  # type: ignore
        bridge = get_bridge()
        if bridge is not None:
            return bridge
    except (ImportError, Exception):
        pass

    # Houdini (future)
    try:
        import hou  # noqa: F401
        from arkestrator_bridge import get_bridge  # type: ignore
        bridge = get_bridge()
        if bridge is not None:
            return bridge
    except (ImportError, Exception):
        pass

    return None


# ---------------------------------------------------------------------------
# Error class
# ---------------------------------------------------------------------------


class AgentManagerError(Exception):
    """Raised when an Arkestrator API call fails."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def check_server(
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict:
    """Check server health, version, and capabilities.

    Returns the health response dict with keys:
        status, uptime, version, protocolVersion, capabilities.

    Raises AgentManagerError if the server is unreachable or the
    protocol version is incompatible.
    """
    health = _request("GET", "/health", server_url=server_url, api_key=api_key)
    server_protocol = health.get("protocolVersion", 0)
    if server_protocol and server_protocol > PROTOCOL_VERSION:
        raise AgentManagerError(
            f"Server protocol version {server_protocol} is newer than SDK "
            f"protocol version {PROTOCOL_VERSION}. Please update the SDK.",
        )
    return health


def has_capability(
    capability: str,
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> bool:
    """Check whether the server supports a specific capability.

    Example:
        if agent_manager.has_capability("binary_files"):
            # safe to send binaryContent field
    """
    try:
        health = check_server(server_url=server_url, api_key=api_key)
        return capability in health.get("capabilities", [])
    except AgentManagerError:
        return False


def submit(
    prompt: str,
    *,
    priority: str = "normal",
    agent_config_id: Optional[str] = None,
    target_worker: Optional[str] = None,
    project_id: Optional[str] = None,
    depends_on: Optional[list[str]] = None,
    start_paused: bool = False,
    workspace_mode: Optional[str] = None,
    editor_context: Optional[dict] = None,
    files: Optional[list[dict]] = None,
    context_items: Optional[list[dict]] = None,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
    use_bridge: bool = True,
) -> dict:
    """Submit a job to the Arkestrator server.

    Tries to route through the local bridge first (if available and
    use_bridge=True) so that editor context is automatically attached.
    Falls back to REST API.

    Args:
        prompt: The task prompt for the AI agent.
        priority: "low", "normal", "high", or "critical".
        agent_config_id: Specific agent config UUID. If None, server uses default.
        target_worker: Worker name to run the job on.
        project_id: Project UUID for path mapping.
        depends_on: List of job IDs this job depends on.
        start_paused: If True, job starts paused (useful for dependency chains).
        workspace_mode: Force "command", "repo", or "sync" mode.
        editor_context: Override editor context dict. If None and using bridge,
            bridge provides it automatically.
        files: File attachments as [{"path": "...", "content": "..."}].
        context_items: Context items to include with the job.
        server_url: Override server URL (default: auto-discover).
        api_key: Override API key (default: auto-discover).
        use_bridge: If True (default), try bridge-first. Set False to force REST.

    Returns:
        The created job dict (includes "id", "status", etc.).
    """
    # --- Try bridge-first ---
    if use_bridge:
        bridge = _try_get_bridge()
        if bridge is not None:
            try:
                return bridge.submit_job(
                    prompt=prompt,
                    priority=priority,
                    agent_config_id=agent_config_id,
                    target_worker=target_worker,
                    project_id=project_id,
                    depends_on=depends_on,
                    start_paused=start_paused,
                    workspace_mode=workspace_mode,
                    context_items=context_items,
                )
            except Exception:
                pass  # Fall through to REST

    # --- REST fallback ---
    body: dict[str, Any] = {
        "prompt": prompt,
        "priority": priority,
        "editorContext": editor_context or {
            "projectRoot": "",
            "activeFile": "",
            "metadata": {},
        },
        "files": files or [],
    }

    if agent_config_id:
        body["agentConfigId"] = agent_config_id
    if target_worker:
        body["targetWorkerName"] = target_worker
    if project_id:
        body["projectId"] = project_id
    if depends_on:
        body["dependsOn"] = depends_on
    if start_paused:
        body["startPaused"] = True
    if workspace_mode:
        body["preferredMode"] = workspace_mode
    if context_items:
        body["contextItems"] = context_items

    return _request("POST", "/api/jobs", body,
                     server_url=server_url, api_key=api_key)


def get_job(
    job_id: str,
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict:
    """Get the current state of a job.

    Args:
        job_id: The job UUID.

    Returns:
        The full job dict.
    """
    return _request("GET", f"/api/jobs/{job_id}",
                     server_url=server_url, api_key=api_key)


def wait(
    job_id: str,
    *,
    timeout: float = 600,
    poll_interval: float = 2.0,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict:
    """Wait for a job to complete, polling the server.

    Args:
        job_id: The job UUID.
        timeout: Max seconds to wait (default 10 minutes).
        poll_interval: Seconds between status checks.

    Returns:
        The completed job dict.

    Raises:
        AgentManagerError: If timeout is reached.
    """
    deadline = time.monotonic() + timeout
    terminal = {"completed", "failed", "cancelled"}

    while time.monotonic() < deadline:
        job = get_job(job_id, server_url=server_url, api_key=api_key)
        if job.get("status") in terminal:
            return job
        time.sleep(poll_interval)

    raise AgentManagerError(f"Timed out waiting for job {job_id} after {timeout}s")


def cancel(
    job_id: str,
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict:
    """Cancel a running or queued job."""
    return _request("POST", f"/api/jobs/{job_id}/cancel",
                     server_url=server_url, api_key=api_key)


def list_jobs(
    *,
    status: Optional[str] = None,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> list[dict]:
    """List jobs, optionally filtered by status.

    Args:
        status: Comma-separated status filter (e.g. "queued,running").
    """
    path = "/api/jobs"
    if status:
        path += f"?status={status}"
    return _request("GET", path, server_url=server_url, api_key=api_key)


def list_agents(
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> list[dict]:
    """List available agent configurations."""
    return _request("GET", "/api/agent-configs",
                     server_url=server_url, api_key=api_key)


def list_workers(
    *,
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> list[dict]:
    """List known workers and their status."""
    return _request("GET", "/api/workers",
                     server_url=server_url, api_key=api_key)


# ---------------------------------------------------------------------------
# Convenience: configure() for explicit setup
# ---------------------------------------------------------------------------


def configure(
    server_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> None:
    """Override auto-discovered server URL and/or API key.

    Call this once if you don't want to rely on shared config auto-discovery.
    """
    global _config_cache
    if _config_cache is None:
        _config_cache = {}
    if server_url:
        # Store as wsUrl for consistency, _get_server_url() converts
        http = server_url.rstrip("/")
        _config_cache["wsUrl"] = http.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
    if api_key:
        _config_cache["apiKey"] = api_key

