import type { ApiBridgeHandler } from "./handler.js";
import type { ApiBridgePresetInfo } from "@arkestrator/protocol";

/** Global registry of preset API bridge handlers (TypeScript implementations). */
const localHandlers = new Map<string, ApiBridgeHandler>();

/** Remote preset metadata (fetched from GitHub / baked-in fallback). */
const remotePresets = new Map<string, ApiBridgePresetInfo>();

/** Register a local TypeScript handler. Called at module load time. */
export function registerPreset(handler: ApiBridgeHandler): void {
  localHandlers.set(handler.presetId, handler);
}

/** Register remote preset metadata (from GitHub or baked-in fallback). */
export function registerRemotePresets(presets: ApiBridgePresetInfo[]): void {
  remotePresets.clear();
  for (const p of presets) {
    remotePresets.set(p.presetId, p);
  }
}

/** Look up a local TypeScript handler by ID. */
export function getPresetHandler(presetId: string): ApiBridgeHandler | undefined {
  return localHandlers.get(presetId);
}

/** Check if a preset ID is known (either local handler or remote metadata). */
export function isKnownPreset(presetId: string): boolean {
  return localHandlers.has(presetId) || remotePresets.has(presetId);
}

/**
 * List all known presets, merging local handlers with remote metadata.
 * Local handlers take precedence — their actions and metadata override remote.
 */
export function listPresets(): ApiBridgePresetInfo[] {
  const merged = new Map<string, ApiBridgePresetInfo>();

  // Start with remote presets as base
  for (const [id, remote] of remotePresets) {
    merged.set(id, remote);
  }

  // Override with local handlers (they have full action schemas)
  for (const [id, handler] of localHandlers) {
    const remote = remotePresets.get(id);
    merged.set(id, {
      presetId: handler.presetId,
      displayName: handler.displayName,
      defaultBaseUrl: handler.defaultBaseUrl,
      description: remote?.description,
      actions: handler.getActions(),
      hasHandler: true,
    });
  }

  return Array.from(merged.values());
}

/** Get all known preset IDs. */
export function listPresetIds(): string[] {
  const ids = new Set<string>();
  for (const id of localHandlers.keys()) ids.add(id);
  for (const id of remotePresets.keys()) ids.add(id);
  return Array.from(ids);
}
