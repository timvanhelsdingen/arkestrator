# Bridge Development Guide

## Goal

Arkestrator is program-agnostic. A "bridge" is a thin adapter that lets any host program participate in orchestration. If your program can open a WebSocket, run scripts, and read/write files, you can build a bridge for it.

**Bridges are execution endpoints only.** They do NOT submit jobs, display dashboards, or manage queues. All job management is handled by the desktop client. The bridge's job is to push context and execute results.

## Bridge Responsibilities

A bridge does five things:

1. **Connect and authenticate** to the server WebSocket as `type=bridge`
2. **Push editor context** (project path, active scene/file, selections) continuously
3. **Provide a context menu** so users can add items to the AI's context via right-click
4. **Execute commands** received from `bridge_command` and `job_complete` messages
5. **Apply file changes** for `repo`/`sync` mode job results

## Connection

### WebSocket Handshake

Connect to `ws://<server>/ws` (or `wss://` for TLS) with these query parameters:

| Param | Required | Description |
|---|---|---|
| `type` | Yes | Always `bridge` |
| `key` | Yes | API key (from `~/.arkestrator/config.json`) |
| `name` | No | Display name (e.g., project name) |
| `program` | Yes | Stable lowercase identifier: `maya`, `nuke`, `substance`, etc. |
| `programVersion` | Yes | Host app version string (e.g., `4.6.0`) |
| `bridgeVersion` | Yes | Bridge plugin version (e.g., `1.0.0`) |
| `protocolVersion` | No | Protocol version string |
| `projectPath` | Yes | Current project path in the DCC app |
| `workerName` | No | Machine name for worker tracking |
| `machineId` | No | Persistent UUID for machine identity |
| `osUser` | No | OS user running the bridge |

Authentication is via the WebSocket subprotocol: `arkestrator.auth.<API_KEY>`.

### Auto-Discovery

Bridges should read `~/.arkestrator/config.json` for connection details:

```json
{
  "serverUrl": "http://localhost:7800",
  "wsUrl": "ws://localhost:7800/ws",
  "apiKey": "am_...",
  "workerName": "my-workstation",
  "machineId": "550e8400-..."
}
```

This file is written by the desktop client on login. Monitor it for changes while connected — if the API key, server URL, or identity changes, reconnect with the new values.

### Reconnection

Implement exponential backoff reconnection:
- Base delay: 3 seconds
- Max delay: 30 seconds
- Only reset backoff if the connection was stable for >10 seconds
- On reconnect, re-read `~/.arkestrator/config.json` for updated credentials
- If the followed URL is a localhost relay that's dead, try the `remoteWsUrl` from config as fallback

## Message Envelope

All WebSocket messages use this JSON structure:

```json
{
  "type": "message_type",
  "id": "uuid-v4",
  "payload": { ... }
}
```

## Messages Your Bridge Should Send

### `bridge_editor_context` — Push Editor State

Send on connect and every 2-3 seconds when state changes. Use hash-based dedup to avoid sending unchanged state.

```json
{
  "type": "bridge_editor_context",
  "id": "ctx-1",
  "payload": {
    "editorContext": {
      "projectRoot": "/path/to/project",
      "activeFile": "scenes/main.scene",
      "metadata": {
        "bridge_type": "mytool",
        "active_scene": "main.scene",
        "selected_nodes": [
          { "name": "Player", "type": "CharacterBody3D", "path": "/root/World/Player" }
        ]
      }
    },
    "files": [
      { "path": "scripts/player.gd", "content": "extends CharacterBody3D\n..." }
    ]
  }
}
```

The `files` array should include the content of currently open/selected scripts.

### `bridge_context_clear` — Reset Context

Send on connect to clear stale context from previous sessions:

```json
{
  "type": "bridge_context_clear",
  "id": "clear-1",
  "payload": {}
}
```

### `bridge_context_item_add` — User Adds Context

Send when the user right-clicks "Add to Arkestrator Context":

```json
{
  "type": "bridge_context_item_add",
  "id": "item-1",
  "payload": {
    "item": {
      "index": 1,
      "type": "node",
      "name": "Player",
      "path": "/root/World/Player",
      "content": "Extended node info, properties, scripts...",
      "metadata": {
        "class": "CharacterBody3D",
        "properties": { "position": "(0, 0, 0)" }
      }
    }
  }
}
```

Maintain an incrementing `index` counter per connection (reset on reconnect). For multi-selections, group items into a single context item where appropriate.

### `bridge_command_result` — Report Command Results

After executing a received command:

```json
{
  "type": "bridge_command_result",
  "id": "result-1",
  "payload": {
    "senderId": "<from bridge_command>",
    "correlationId": "<from bridge_command>",
    "success": true,
    "executed": 2,
    "failed": 0,
    "skipped": 1,
    "errors": []
  }
}
```

## Messages Your Bridge Should Handle

### `job_complete` — Job Results

When a job completes, the server sends results for your bridge to apply:

```json
{
  "type": "job_complete",
  "id": "...",
  "payload": {
    "jobId": "...",
    "success": true,
    "workspaceMode": "command",
    "files": [...],
    "commands": [
      { "language": "python", "script": "...", "description": "Create a cube" }
    ],
    "error": null
  }
}
```

Based on `workspaceMode`:
- **`command`**: Execute the commands in `commands` inside the DCC app runtime
- **`repo`/`sync`**: Apply file changes from `files` to disk, then reload the editor

### `bridge_command` — Cross-Bridge Commands

Another bridge or the server sends commands to execute:

```json
{
  "type": "bridge_command",
  "id": "...",
  "payload": {
    "senderId": "...",
    "commands": [
      { "language": "python", "script": "import bpy; ...", "description": "Add object" }
    ],
    "correlationId": "..."
  }
}
```

Execute the commands and respond with `bridge_command_result`.

### `error` — Server Error

```json
{
  "type": "error",
  "id": "...",
  "payload": { "code": "...", "message": "..." }
}
```

## Recommended Module Structure

Split your bridge into focused modules:

| Module | Responsibility |
|---|---|
| `ws_client` | WebSocket connect/reconnect, message parsing, envelope dispatch |
| `context_provider` | Gather active project/file/selection/metadata from the editor |
| `command_executor` | Language-specific command execution (filter by supported languages) |
| `file_applier` | Create/modify/delete files safely with path traversal protection |
| `context_menu` | Right-click "Add to Arkestrator Context" menu integration |
| `ui_integration` | Settings panel, status indicator, connect/disconnect button |

This mirrors the structure of all existing bridges and keeps maintenance simple.

## Command Execution

### Language Filtering

Only execute commands in languages your bridge supports. Skip unsupported languages with an error message in the result. Examples:

- Godot bridge: `gdscript`, `gd`
- Blender bridge: `python`, `py`
- Houdini bridge: `python`, `py`, `hscript`
- ComfyUI bridge: `python`, `py`, `workflow`, `comfyui`
- Unity bridge: `unity_json`, `json`
- Unreal bridge: `python`, `py`, `ue_console`, `console`

### Execution Pattern

```
for each command:
  if language not supported → skip, record error
  try:
    compile and execute script in DCC runtime
    record success
  catch:
    record failure with error message/traceback
return { executed, failed, skipped, errors }
```

## File Application

### Safety Rules

**Always enforce:**
- Normalize paths (resolve `.` and `..` components)
- Verify resolved paths stay within the project root
- Reject any path that escapes the root (log warning, skip file)
- Create parent directories as needed
- Support binary files via base64 encoding (`encoding: "base64"`, `binaryContent` field)

### File Change Format

```json
{
  "type": "create",
  "path": "scripts/player.gd",
  "content": "extends CharacterBody3D\n..."
}
```

Types: `create`, `modify`, `delete`. For binary files, use `binaryContent` (base64) + `encoding: "base64"` instead of `content`.

## Settings

Bridges should expose these user-configurable settings:

| Setting | Default | Purpose |
|---|---|---|
| Server URL | `ws://localhost:7800/ws` | Server WebSocket endpoint |
| Auto-connect | `true` | Connect on plugin/addon load |
| Auto-apply files | `true` | Apply file changes automatically |
| Auto-execute commands | `true` | Execute commands automatically |

API key, worker name, and machine ID should come from `~/.arkestrator/config.json` — not manual user input.

## Development Checklist

1. Read config from `~/.arkestrator/config.json`
2. Implement WebSocket connect/reconnect with exponential backoff
3. Implement message envelope parser and typed dispatch
4. Send `bridge_context_clear` on connect
5. Send `bridge_editor_context` on connect and periodically (2-3s, hash dedup)
6. Implement `bridge_context_item_add` via right-click context menu
7. Handle `bridge_command` → execute → respond with `bridge_command_result`
8. Handle `job_complete` → apply files or execute commands based on `workspaceMode`
9. Implement file application with path traversal protection
10. Add status indicator and settings UI in the host app
11. Test against a live server with an end-to-end job

## Testing

Before release, verify:

- Bridge appears in the Workers page in the desktop client
- Bridge appears in `/api/workers` API response
- Editor context updates are visible in the client's context panel
- Context items appear when right-clicking "Add to Arkestrator Context"
- Command execution returns correct success/failure results
- File changes are applied correctly (create, modify, delete)
- Binary files (images, etc.) are handled via base64
- Reconnection works after server restart
- Worker name and machine ID remain stable across reconnects
- Shared config hot-reload works (change API key, bridge reconnects)

## Program IDs

Use stable lowercase identifiers for `program`:

- Good: `maya`, `nuke`, `substance`, `customcad`
- Avoid: versioned IDs like `maya2026`

Version details belong in `programVersion`, not in `program`.
