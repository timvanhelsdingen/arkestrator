# Plan: Add C++ Module to UE Arkestrator Bridge Plugin

## Context

The Arkestrator Unreal bridge plugin (`arkestrator-bridges/unreal/ArkestratorBridge/`) is currently a content-only Python plugin. The Blueprint Editor's node right-click context menu needs a C++ hook for reliable extension. The Python code already registers on `GraphEditor.GraphNodeContextMenu` via UToolMenus, but C++ gives us dynamic visibility control (hide when disconnected) and more reliable hooking.

The plugin is being converted to an **engine plugin** (installed at `Engine/Plugins/Arkestrator/`), not a project plugin.

## Files to Create

### 1. `Source/ArkestratorBridgeEditor/ArkestratorBridgeEditor.Build.cs`
Module build config. Dependencies: Core, CoreUObject, Engine, Slate, SlateCore, ToolMenus, UnrealEd, PythonScriptPlugin.

### 2. `Source/ArkestratorBridgeEditor/ArkestratorBridgeEditor.h`
Module header. `FArkestratorBridgeEditorModule : IModuleInterface` with:
- `StartupModule()` / `ShutdownModule()`
- `RegisterMenus()` — extends `GraphEditor.GraphNodeContextMenu`
- `IsBridgeConnected()` — checks Python bridge state via `IPythonScriptPlugin::ExecPythonCommandEx`
- `ExecuteAddToContext()` — calls Python `_on_add_to_context()` via `IPythonScriptPlugin::ExecPythonCommand`

### 3. `Source/ArkestratorBridgeEditor/ArkestratorBridgeEditor.cpp`
Module implementation:
- `StartupModule`: Uses `UToolMenus::RegisterStartupCallback` to defer menu registration until ToolMenus is ready
- `RegisterMenus`: Extends `GraphEditor.GraphNodeContextMenu` with a dynamic entry using `AddDynamicEntry`. The entry uses `FIsActionButtonVisible` delegate bound to `IsBridgeConnected()` — **hides the entry entirely when disconnected** (not grayed out)
- `IsBridgeConnected`: Calls Python via `ExecPythonCommandEx` with `EvaluateStatement` mode to run `get_bridge()` and check `.connected`, returns bool from `CommandResult`
- `ExecuteAddToContext`: Calls `ExecPythonCommand("from arkestrator_bridge.context_menu import _on_add_to_context; _on_add_to_context()")`
- `ShutdownModule`: Unregisters callback and owned menus

## Files to Modify

### 4. `ArkestratorBridge.uplugin`
- Add module entry: `{"Name": "ArkestratorBridgeEditor", "Type": "Editor", "LoadingPhase": "Default"}`
- Update description to mention C++ editor hooks

### 5. `Content/Python/arkestrator_bridge/context_menu.py`
- Remove `GraphEditor.GraphContextMenu` and `GraphEditor.GraphNodeContextMenu` from `_MENU_TARGETS` to avoid duplicate entries with the C++ module
- The other 5 menu surfaces (level editor, content browser, tools) stay Python-only

### 6. `unreal/MODULE.md`
- Document the hybrid C++/Python architecture

## Key Design Decisions

- **`AddDynamicEntry` + `FIsActionButtonVisible`**: Re-evaluates on every menu open. Entry is hidden (not grayed) when bridge is disconnected.
- **Python eval for connection check**: Calls `get_bridge()` which returns `None` when disconnected. Lightweight — just reads a module-level variable. Runs only on right-click, not continuously.
- **Module type `Editor`**: Never loads in packaged builds. No runtime overhead.
- **`RegisterStartupCallback`**: Defers registration until ToolMenus is initialized, avoiding load-order issues.
- **Source distribution**: Users get .h/.cpp files. UE compiles against their engine version automatically. Works across 5.4–5.6+ without version-specific code.

## Verification

1. Copy plugin to `Engine/Plugins/Arkestrator/` (UE 5.6 install)
2. Regenerate project files → open project → verify plugin compiles
3. Open Blueprint Editor → right-click a node → verify "Add to Arkestrator Context" is NOT visible (bridge disconnected)
4. Start Arkestrator server → connect bridge → right-click node → verify entry IS visible
5. Click the entry → verify it calls Python and sends context to server
6. Check the other 5 Python menu surfaces still work (level editor actor menu, content browser, etc.)
