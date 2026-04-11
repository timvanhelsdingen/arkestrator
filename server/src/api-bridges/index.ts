// Register all preset handlers on import.
// NOTE: ComfyUI is NOT registered here — it runs locally per-worker and is handled
// by the existing headless bridge system (comfyui-headless.ts + health checker).
// Only cloud/server-side API services belong here.
import { registerPreset, registerRemotePresets, registerMcpPresets } from "./registry.js";
import { MeshyHandler } from "./presets/meshy.js";
import {
  fetchRemoteApiPresets,
  clearRemotePresetsCache,
  fetchRemoteMcpPresets,
  clearRemoteMcpPresetsCache,
} from "./remote-presets.js";

registerPreset(new MeshyHandler());

// Kick off remote preset fetches (non-blocking — local handlers are available immediately)
refreshRemotePresets();
refreshRemoteMcpPresets();

/**
 * Refresh remote presets from GitHub (or baked-in fallback).
 * Called on module load and can be triggered by the admin refresh endpoint.
 */
export async function refreshRemotePresets(): Promise<void> {
  try {
    const remotePresets = await fetchRemoteApiPresets();
    registerRemotePresets(remotePresets);
  } catch {
    // Already logged in fetchRemoteApiPresets
  }
}

/** Force-clear cache and re-fetch from GitHub. */
export async function forceRefreshRemotePresets(): Promise<void> {
  clearRemotePresetsCache();
  await refreshRemotePresets();
}

/**
 * Refresh remote MCP presets from GitHub (or baked-in fallback).
 * Called on module load and can be triggered by the admin refresh endpoint.
 */
export async function refreshRemoteMcpPresets(): Promise<void> {
  try {
    const presets = await fetchRemoteMcpPresets();
    registerMcpPresets(presets);
  } catch {
    // Already logged in fetchRemoteMcpPresets
  }
}

/** Force-clear MCP preset cache and re-fetch from GitHub. */
export async function forceRefreshRemoteMcpPresets(): Promise<void> {
  clearRemoteMcpPresetsCache();
  await refreshRemoteMcpPresets();
}

// Re-export public API
export {
  getPresetHandler,
  listPresets,
  listPresetIds,
  isKnownPreset,
  listMcpPresets,
  isKnownMcpPreset,
  getMcpPreset,
} from "./registry.js";
export { CustomApiBridgeHandler } from "./custom-handler.js";
export { McpBridgeHandler } from "./mcp-handler.js";
export { ApiBridgeExecutor } from "./executor.js";
export type { ApiBridgeHandler, ApiBridgeExecContext } from "./handler.js";
