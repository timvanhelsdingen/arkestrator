// Register all preset handlers on import
import { registerPreset } from "./registry.js";
import { MeshyHandler } from "./presets/meshy.js";
import { ComfyUiHandler } from "./presets/comfyui.js";

registerPreset(new MeshyHandler());
registerPreset(new ComfyUiHandler());

// Re-export public API
export { getPresetHandler, listPresets, listPresetIds } from "./registry.js";
export { CustomApiBridgeHandler } from "./custom-handler.js";
export { ApiBridgeExecutor } from "./executor.js";
export type { ApiBridgeHandler, ApiBridgeExecContext } from "./handler.js";
