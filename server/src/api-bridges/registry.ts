import type { ApiBridgeHandler } from "./handler.js";
import type { ApiBridgePresetInfo, McpPresetInfo } from "@arkestrator/protocol";

/** Global registry of preset API bridge handlers (TypeScript implementations). */
const localHandlers = new Map<string, ApiBridgeHandler>();

/** Remote preset metadata (fetched from GitHub / baked-in fallback). */
const remotePresets = new Map<string, ApiBridgePresetInfo>();

/** MCP preset metadata (fetched from GitHub / baked-in fallback). */
const mcpPresets = new Map<string, McpPresetInfo>();

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

// ---------------------------------------------------------------------------
// MCP preset registry
// ---------------------------------------------------------------------------

/** Register the full MCP preset list (called after remote fetch). */
export function registerMcpPresets(presets: McpPresetInfo[]): void {
  mcpPresets.clear();
  for (const p of presets) {
    mcpPresets.set(p.presetId, p);
  }
}

/** List every known MCP preset. */
export function listMcpPresets(): McpPresetInfo[] {
  return Array.from(mcpPresets.values());
}

/** Check whether a preset ID is a known MCP preset. */
export function isKnownMcpPreset(presetId: string): boolean {
  return mcpPresets.has(presetId);
}

/** Look up a specific MCP preset by ID. */
export function getMcpPreset(presetId: string): McpPresetInfo | undefined {
  return mcpPresets.get(presetId);
}
