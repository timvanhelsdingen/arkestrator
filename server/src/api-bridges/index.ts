// Register all preset handlers on import.
// NOTE: ComfyUI is NOT registered here — it runs locally per-worker and is handled
// by the existing headless bridge system (comfyui-headless.ts + health checker).
// Only cloud/server-side API services belong here.
import { registerPreset } from "./registry.js";
import { MeshyHandler } from "./presets/meshy.js";

registerPreset(new MeshyHandler());

// Re-export public API
export { getPresetHandler, listPresets, listPresetIds } from "./registry.js";
export { CustomApiBridgeHandler } from "./custom-handler.js";
export { ApiBridgeExecutor } from "./executor.js";
export type { ApiBridgeHandler, ApiBridgeExecContext } from "./handler.js";
