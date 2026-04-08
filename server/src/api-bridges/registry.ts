import type { ApiBridgeHandler } from "./handler.js";
import type { ApiBridgePresetInfo } from "@arkestrator/protocol";

/** Global registry of preset API bridge handlers. */
const presets = new Map<string, ApiBridgeHandler>();

/** Register a preset handler. Called at module load time. */
export function registerPreset(handler: ApiBridgeHandler): void {
  presets.set(handler.presetId, handler);
}

/** Look up a preset handler by ID. */
export function getPresetHandler(presetId: string): ApiBridgeHandler | undefined {
  return presets.get(presetId);
}

/** List all registered preset handlers with their metadata. */
export function listPresets(): ApiBridgePresetInfo[] {
  return Array.from(presets.values()).map((h) => ({
    presetId: h.presetId,
    displayName: h.displayName,
    defaultBaseUrl: h.defaultBaseUrl,
    actions: h.getActions(),
  }));
}

/** Get all registered preset IDs. */
export function listPresetIds(): string[] {
  return Array.from(presets.keys());
}
