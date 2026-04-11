/**
 * Remote API bridge preset discovery.
 *
 * Fetches available API bridge presets from the arkestrator-bridges GitHub repo.
 * Falls back to a baked-in snapshot when GitHub is unreachable.
 */

import type { ApiBridgePresetInfo, McpPresetInfo, McpConfig } from "@arkestrator/protocol";
import { BRIDGE_RAW_BASE_URL, BRIDGE_REGISTRY_URL } from "../skills/skill-registry.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types for bridge registry / bridge.json
// ---------------------------------------------------------------------------

interface RegistryEntry {
  id: string;
  dir?: string;
}

interface BridgeManifest {
  id: string;
  name: string;
  description?: string;
  type?: string;
  defaultBaseUrl?: string;
  authType?: string;
  /** MCP-only: category for UI grouping */
  category?: string;
  /** MCP-only: default MCP server config */
  mcpConfig?: McpConfig;
  /** MCP-only: human-readable setup instructions */
  setupNote?: string;
  /** MCP-only: homepage / docs URL */
  homepage?: string;
}

// ---------------------------------------------------------------------------
// Cache (5-minute TTL, same as skill registry)
// ---------------------------------------------------------------------------

const CACHE_TTL = 5 * 60 * 1000;

let cache: { presets: ApiBridgePresetInfo[]; fetchedAt: number } | null = null;
let mcpCache: { presets: McpPresetInfo[]; fetchedAt: number } | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get remote API bridge presets. Uses cache if fresh, otherwise fetches from
 * GitHub and falls back to the baked-in list.
 */
export async function fetchRemoteApiPresets(): Promise<ApiBridgePresetInfo[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.presets;
  }

  try {
    const presets = await fetchFromGitHub();
    cache = { presets, fetchedAt: Date.now() };
    logger.info("remote-presets", `Fetched ${presets.length} remote API bridge presets from GitHub`);
    return presets;
  } catch (err: any) {
    logger.warn("remote-presets", `GitHub fetch failed, using baked-in fallback: ${err.message}`);
    const fallback = loadBakedPresets();
    // Cache the fallback too so we don't hammer GitHub on repeated failures
    cache = { presets: fallback, fetchedAt: Date.now() };
    return fallback;
  }
}

/** Force-clear the cache so next call re-fetches from GitHub. */
export function clearRemotePresetsCache(): void {
  cache = null;
}

/**
 * Get remote MCP bridge presets. Uses cache if fresh, otherwise fetches from
 * GitHub and falls back to the baked-in list.
 */
export async function fetchRemoteMcpPresets(): Promise<McpPresetInfo[]> {
  if (mcpCache && Date.now() - mcpCache.fetchedAt < CACHE_TTL) {
    return mcpCache.presets;
  }

  try {
    const manifests = await fetchManifestsFromGitHub();
    const remote = manifests
      .filter((m) => m.type === "mcp" && m.mcpConfig)
      .map<McpPresetInfo>((m) => ({
        presetId: m.id,
        displayName: m.name,
        description: m.description,
        category: m.category,
        mcpConfig: m.mcpConfig!,
        setupNote: m.setupNote,
        homepage: m.homepage,
      }));

    // Merge with baked fallback so curated presets are always available even if
    // the upstream registry only ships a subset.
    const merged = mergeMcpPresets(loadBakedMcpPresets(), remote);
    mcpCache = { presets: merged, fetchedAt: Date.now() };
    logger.info(
      "remote-presets",
      `Loaded ${merged.length} MCP presets (${remote.length} remote, ${merged.length - remote.length} baked-only)`,
    );
    return merged;
  } catch (err: any) {
    logger.warn(
      "remote-presets",
      `GitHub fetch failed for MCP presets, using baked-in fallback: ${err.message}`,
    );
    const fallback = loadBakedMcpPresets();
    mcpCache = { presets: fallback, fetchedAt: Date.now() };
    return fallback;
  }
}

/** Force-clear the MCP preset cache so next call re-fetches from GitHub. */
export function clearRemoteMcpPresetsCache(): void {
  mcpCache = null;
}

/** Merge two MCP preset lists, with entries from `override` taking precedence by presetId. */
function mergeMcpPresets(base: McpPresetInfo[], override: McpPresetInfo[]): McpPresetInfo[] {
  const map = new Map<string, McpPresetInfo>();
  for (const p of base) map.set(p.presetId, p);
  for (const p of override) map.set(p.presetId, p);
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// GitHub fetcher
// ---------------------------------------------------------------------------

async function fetchFromGitHub(): Promise<ApiBridgePresetInfo[]> {
  const manifests = await fetchManifestsFromGitHub();
  return manifests
    .filter((m) => m.type === "api")
    .map<ApiBridgePresetInfo>((manifest) => ({
      presetId: manifest.id,
      displayName: manifest.name,
      defaultBaseUrl: manifest.defaultBaseUrl ?? "",
      authType: (manifest.authType as any) ?? undefined,
      description: manifest.description,
      actions: [],
      hasHandler: false,
    }));
}

/**
 * Walk the bridge registry on GitHub and return every manifest that loaded
 * successfully. Callers filter by `manifest.type` (e.g. "api" or "mcp").
 */
async function fetchManifestsFromGitHub(): Promise<BridgeManifest[]> {
  const res = await fetch(BRIDGE_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);

  const raw = (await res.json()) as any;
  const entries: RegistryEntry[] = raw.bridges ?? [];

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const dir = entry.dir ?? entry.id;
      const r = await fetch(`${BRIDGE_RAW_BASE_URL}/${dir}/bridge.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`${r.status} for ${dir}`);
      return (await r.json()) as BridgeManifest;
    }),
  );

  const manifests: BridgeManifest[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      logger.debug("remote-presets", `Failed to fetch bridge manifest: ${r.reason}`);
      continue;
    }
    manifests.push(r.value);
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Baked-in fallback
// ---------------------------------------------------------------------------

function loadBakedPresets(): ApiBridgePresetInfo[] {
  try {
    // Use require for synchronous JSON loading (Bun supports this)
    const baked = require("./presets/baked-presets.json") as Array<{
      presetId: string;
      displayName: string;
      defaultBaseUrl: string;
      authType?: string;
      description?: string;
    }>;
    return baked.map((b) => ({
      presetId: b.presetId,
      displayName: b.displayName,
      defaultBaseUrl: b.defaultBaseUrl,
      authType: (b.authType as any) ?? undefined,
      description: b.description,
      actions: [],
      hasHandler: false,
    }));
  } catch {
    logger.warn("remote-presets", "Baked presets file not found or invalid");
    return [];
  }
}

function loadBakedMcpPresets(): McpPresetInfo[] {
  try {
    const baked = require("./presets/baked-mcp-presets.json") as Array<McpPresetInfo>;
    return baked;
  } catch {
    logger.warn("remote-presets", "Baked MCP presets file not found or invalid");
    return [];
  }
}
