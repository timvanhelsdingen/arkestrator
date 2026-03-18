# Bridge Usage

> **Bridge source code lives in a separate repository:** [arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges)

## What Bridges Are

Bridges are thin plugins inside DCC apps that connect to the Arkestrator server over WebSocket. They are **execution endpoints only** — they do not submit jobs, display dashboards, or manage queues. All prompt submission and job management happens through the desktop client.

Bridges have four responsibilities:

1. **Push editor context** — project path, active scene/file, selected nodes/assets, open scripts. Pushed on connect and every 2-3 seconds when state changes.
2. **Context menu integration** — right-click "Add to Arkestrator Context" pushes items directly to the server for use in job prompts.
3. **Execute commands** — when a job completes in `command` mode, the bridge runs the agent's output scripts inside the DCC app's runtime.
4. **Apply file changes** — when a job completes in `repo` or `sync` mode, the bridge writes/deletes files and reloads the editor.

## Auto-Discovery

Bridges auto-discover the server from `~/.arkestrator/config.json`, written by the desktop client on login. This file contains the server URL, API key, worker name, and machine ID. No manual bridge configuration is needed once the desktop client is logged in.

If the desktop client is connected to a remote server, it starts a localhost relay so same-machine bridges can connect via `127.0.0.1` without needing direct access to the remote host.

## Installing Bridges

### Godot (GDScript Addon)

1. Copy `arkestrator-bridges/godot/addons/arkestrator_bridge/` into your Godot project's `addons/` directory
2. Enable the plugin: **Project > Project Settings > Plugins > Godot Arkestrator Bridge**
3. The bridge panel appears in the editor dock (right side)
4. With auto-connect enabled (default), it connects on plugin load

**Settings** (Editor Settings > `arkestrator_bridge/`):
- Server URL (default: `ws://localhost:7800/ws`)
- Auto-connect on plugin load
- Auto-save scene before file changes
- Auto-reload scene after completion
- Auto-apply file changes
- Auto-execute GDScript commands

**Context menu**: Right-click in Scene Tree, FileSystem dock, Script Editor, or Script Code Editor to "Add to Arkestrator Context". Multi-selections are grouped into one `@N` reference.

**Editor context captured**: Active scene, selected nodes (name, type, path, class, properties), selected/open scripts with source code.

### Blender (Python Addon)

1. Install via **Edit > Preferences > Add-ons > Install** — select the `arkestrator-bridges/blender/arkestrator_bridge/` directory
2. Enable the addon
3. The panel appears in the 3D Viewport N-panel under the "Arkestrator" tab
4. Auto-connects on addon load

**Settings** (Addon Preferences):
- Server URL, auto-connect, auto-save .blend, auto-reload, auto-apply files, auto-execute commands

**Context menu**: Right-click "Add to Arkestrator Context" across Viewport, Outliner, File Browser, Asset Browser, Text Editor, Node Editor, and other surfaces. Menu coverage is discovered at runtime from Blender's `Menu` registry.

**Editor context captured**: Active scene, blend file path, selected objects (with location/rotation/scale, vertex/face counts for meshes), node editor selections, active text blocks, file/asset browser state.

### Houdini (Python Package)

1. Copy the `arkestrator-bridges/houdini/arkestrator_bridge` directory to your Houdini preferences (e.g., `$HOUDINI_USER_PREF_DIR/pythonX.Xlibs/`) or use the `arkestrator_bridge.json` package descriptor
2. Registration happens automatically through multiple startup hooks (pythonrc, ready, uiready, 123/456 scripts)
3. For manual setup: `import arkestrator_bridge; arkestrator_bridge.register()`
4. Also works in headless/hython mode with a thread-based fallback

**Context menu**: Right-click "Add to Arkestrator Context" available via OPmenu (node/network RMB), PARMmenu (parameter RMB), viewport selection menus, pane tab menus, and the global Arkestrator top menu.

**Editor context captured**: Current network, selected nodes (name, type, path), VEX/Python snippets from wrangles and Python SOPs, viewport geometry component selections (points/primitives/edges).

**Commands**: Supports both Python (`exec()`) and HScript (`hou.hscript()`).

**Public API** for third-party Houdini plugins:
```python
bridge = arkestrator_bridge.get_bridge()
if bridge:
    bridge.submit_job("Create a procedural building generator")
    bridge.add_context_item({"type": "node", "name": "geo1", ...})
```

### Unreal Engine 5 (Python Plugin)

1. Copy `arkestrator-bridges/unreal/ArkestratorBridge/` to your UE5 engine's Plugins directory
2. Enable **PythonScriptPlugin** in Edit > Plugins > Scripting
3. Enable **Arkestrator Bridge** in Edit > Plugins > Editor
4. Restart the editor
5. No C++ compilation required — content-only Python plugin

**Context menu**: "Add to Arkestrator Context" in level viewport, content browser, asset browser, and Tools menu.

**Editor context captured**: Active level, selected actors (with class, path, location), selected assets, selected folders, material nodes, engine version, actor count.

**Commands**: Python (`exec()`) and UE Console commands (`unreal.SystemLibrary.execute_console_command()`).

### Unity (C# Plugin)

1. Copy `arkestrator-bridges/unity/ArkestratorBridge/` into your Unity project's `Assets/` directory, or run:
   ```powershell
   .\scripts\install-unity-bridge.ps1 -UnityProjectPath "C:\Path\To\UnityProject"
   ```
2. The bridge auto-connects on editor load

**Context menu**: "Add to Arkestrator Context" in hierarchy, project, assets, and inspector context menus.

**Editor context captured**: Active scene, selected GameObjects (with components), selected assets, project structure.

**Commands**: JSON-based Unity editor actions (create/delete objects, set position, open scene, etc.).

### ComfyUI (Standalone Python Bridge)

Unlike other bridges, the ComfyUI bridge runs as a separate process that connects ComfyUI's HTTP API to the Arkestrator server.

```bash
python -m arkestrator_bridge
python -m arkestrator_bridge --comfyui-url http://localhost:8188
python -m arkestrator_bridge --server-url ws://myserver:7800/ws --api-key am_xxx
```

**Commands**: Workflow JSON submission (queues a ComfyUI workflow, polls for results, collects output artifacts) and Python execution.

**Context captured**: Available node categories and counts, system stats (VRAM, GPU), queue state.

## How Bridges Interact with Workspace Modes

The behavior a bridge sees depends on the workspace mode the server chose for the job:

### Command Mode
The agent outputs executable scripts. The bridge receives a `job_complete` message with `commands` containing the scripts. If auto-execute is enabled, the bridge runs them inside the DCC app's runtime (GDScript for Godot, Python for Blender/Houdini, etc.).

### Repo Mode
The agent edits files directly on the server's filesystem (same machine as the bridge). The bridge receives a `job_complete` message and optionally reloads the active scene to pick up changes.

### Sync Mode
Files were edited in a temp directory on the server. The bridge receives the file changes in the `job_complete` message and applies them to the local project.

## Cross-Bridge Commands

Bridges can receive commands from other bridges through the server. For example, an AI agent working with Blender might send GDScript to a Godot bridge on the same or different machine.

Each bridge handles `bridge_command` messages and responds with `bridge_command_result`. This is controlled by the auto-execute setting — if disabled, the bridge skips execution and reports back.

## Connection Details

- **WebSocket endpoint**: `/ws` with query params for identity (type, program, programVersion, bridgeVersion, projectPath, workerName, machineId)
- **Authentication**: API key via `~/.arkestrator/config.json` (or manual entry)
- **Reconnect**: Exponential backoff from 3s to 30s, automatic on disconnect
- **Context push**: Every 2-3 seconds, only when state changes (hash-based dedup)
- **Stale detection**: 180s without frames triggers reconnect
- **Handshake retry**: Up to 2 attempts with 0.5s delay for transient failures
- **Shared config hot-reload**: Bridges re-read `~/.arkestrator/config.json` while reconnecting and auto-update credentials/identity if it changes
- **Remote relay fallback**: If the desktop client's localhost relay dies, bridges try the remote server URL directly

## Path Safety

All bridges enforce path traversal protection:
- Paths are normalized (`.` and `..` resolved)
- Results must stay within the project root directory
- Attempts to escape the root are logged and skipped
- Binary files are supported via base64 encoding

## Building a New Bridge

Any program that can open a WebSocket and run scripts can become a bridge. See the [Bridge Development Guide](bridge-development.md) for the full protocol reference, message formats, and implementation checklist.
