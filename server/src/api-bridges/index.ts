// Register all preset handlers on import.
// NOTE: ComfyUI is NOT registered here — it runs locally per-worker and is handled
// by the existing headless bridge system (comfyui-headless.ts + health checker).
// Only cloud/server-side API services belong here.
import { registerPreset, registerRemotePresets } from "./registry.js";
import { MeshyHandler } from "./presets/meshy.js";
import { fetchRemoteApiPresets, clearRemotePresetsCache } from "./remote-presets.js";

registerPreset(new MeshyHandler());

// Kick off remote preset fetch (non-blocking — local handlers are available immediately)
refreshRemotePresets();

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

// Re-export public API
export { getPresetHandler, listPresets, listPresetIds, isKnownPreset } from "./registry.js";
export { CustomApiBridgeHandler } from "./custom-handler.js";
export { ApiBridgeExecutor } from "./executor.js";
export type { ApiBridgeHandler, ApiBridgeExecContext } from "./handler.js";
