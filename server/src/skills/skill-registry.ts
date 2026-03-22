/**
 * Bridge-repo skill ingestion.
 *
 * Pulls coordinator scripts and skills from the arkestrator-bridges GitHub repo
 * when a bridge connects. Reuses the existing registry cache from routes/skills.ts.
 */

import type { SkillsRepo } from "../db/skills.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Bridge registry types
// ---------------------------------------------------------------------------

/** Per-bridge skill entry in registry.json */
interface BridgeSkillEntry {
  slug: string;
  file: string;
  title: string;
  category?: string;
}

/** Per-bridge entry in the bridges section of registry.json */
interface BridgeRegistryEntry {
  id: string;
  program: string;
  skills?: BridgeSkillEntry[];
}

/** Top-level bridge registry (from arkestrator-bridges/registry.json) */
interface BridgeRegistryData {
  version?: number;
  bridges?: BridgeRegistryEntry[];
}

// ---------------------------------------------------------------------------
// Registry cache (shared across calls, 5-minute TTL)
// ---------------------------------------------------------------------------

const BRIDGE_REGISTRY_URL =
  "https://raw.githubusercontent.com/timvanhelsdingen/arkestrator-bridges/main/registry.json";
const BRIDGE_REGISTRY_CACHE_TTL = 5 * 60 * 1000;

let bridgeRegistryCache: { data: BridgeRegistryData; fetchedAt: number } | null = null;

/**
 * Fetch the bridge registry.json from GitHub.
 * Cached for 5 minutes. Returns an empty structure if fetch fails.
 */
export async function fetchBridgeRegistry(): Promise<BridgeRegistryData> {
  if (bridgeRegistryCache && Date.now() - bridgeRegistryCache.fetchedAt < BRIDGE_REGISTRY_CACHE_TTL) {
    return bridgeRegistryCache.data;
  }
  try {
    const res = await fetch(BRIDGE_REGISTRY_URL);
    if (!res.ok) {
      logger.warn("skill-registry", `Bridge registry fetch failed: ${res.status} ${res.statusText}`);
      return { bridges: [] };
    }
    const data = (await res.json()) as BridgeRegistryData;
    if (!data || !Array.isArray(data.bridges)) {
      return { bridges: [] };
    }
    bridgeRegistryCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err: any) {
    logger.warn("skill-registry", `Failed to fetch bridge registry: ${err?.message}`);
    return { bridges: [] };
  }
}

// ---------------------------------------------------------------------------
// Pull functions
// ---------------------------------------------------------------------------

const BRIDGE_RAW_BASE = "https://raw.githubusercontent.com/timvanhelsdingen/arkestrator-bridges/main";

export interface PullResult {
  pulled: number;
  errors: string[];
}

/**
 * Pull coordinator script and skills from the bridge repo for a specific program.
 *
 * Steps:
 * 1. Check if auto-pull is enabled (setting: auto_pull_bridge_skills, default true).
 * 2. Fetch registry.json and find the bridge entry.
 * 3. Fetch coordinator.md from {program}/coordinator.md if it exists.
 * 4. Fetch any listed skills from the skills field.
 * 5. Upsert all to the skills DB with source='bridge-repo'.
 */
export async function pullBridgeSkills(
  program: string,
  skillsRepo: SkillsRepo,
  settingsRepo?: SettingsRepo,
  force?: boolean,
): Promise<PullResult> {
  const normalized = program.trim().toLowerCase();
  let pulled = 0;
  const errors: string[] = [];

  // 1. Check if auto-pull is enabled
  if (!force) {
    const autoPull = settingsRepo?.get("auto_pull_bridge_skills") !== "false"; // default true
    if (!autoPull) {
      return { pulled: 0, errors: [] };
    }
  }

  // 2. Fetch registry.json
  const registry = await fetchBridgeRegistry();
  const bridge = registry.bridges?.find((b) => b.program === normalized);

  // 3. Try to fetch coordinator.md regardless of registry entry
  const baseUrl = `${BRIDGE_RAW_BASE}/${normalized}`;
  try {
    const coordinatorRes = await fetch(`${baseUrl}/coordinator.md`);
    if (coordinatorRes.ok) {
      const content = await coordinatorRes.text();
      if (content.trim()) {
        // Don't overwrite user-edited skills
        const existing = skillsRepo.getAny?.(`${normalized}-coordinator`, normalized);
        if (!existing || existing.source !== "user") {
          skillsRepo.upsertBySlugAndProgram({
            name: `${normalized}-coordinator`,
            slug: `${normalized}-coordinator`,
            program: normalized,
            category: "bridge",
            title: `${normalized.charAt(0).toUpperCase() + normalized.slice(1)} Coordinator`,
            description: `Coordinator script for ${normalized} (from bridge repo)`,
            keywords: [normalized, "coordinator", "bridge"],
            content,
            source: "bridge-repo",
            priority: 70,
            autoFetch: true,
            enabled: true,
          });
          pulled++;
          logger.info("skill-registry", `Pulled coordinator for ${normalized} from bridge repo`);
        }
      }
    }
  } catch (err: any) {
    errors.push(`Failed to fetch coordinator.md for ${normalized}: ${err?.message}`);
  }

  // 4. Fetch skills listed in registry
  if (bridge?.skills && bridge.skills.length > 0) {
    for (const skillEntry of bridge.skills) {
      try {
        const skillUrl = `${BRIDGE_RAW_BASE}/${skillEntry.file}`;
        const skillRes = await fetch(skillUrl);
        if (!skillRes.ok) {
          errors.push(`Failed to fetch skill ${skillEntry.slug}: ${skillRes.status} ${skillRes.statusText}`);
          continue;
        }
        const content = await skillRes.text();
        if (!content.trim()) continue;

        // Don't overwrite user-edited skills
        const existing = skillsRepo.getAny?.(skillEntry.slug, normalized);
        if (existing && existing.source === "user") continue;

        skillsRepo.upsertBySlugAndProgram({
          name: skillEntry.slug,
          slug: skillEntry.slug,
          program: normalized,
          category: skillEntry.category ?? "bridge",
          title: skillEntry.title,
          description: `${skillEntry.title} (from bridge repo)`,
          keywords: [normalized, "bridge", skillEntry.slug],
          content,
          source: "bridge-repo",
          priority: 50,
          autoFetch: true,
          enabled: true,
        });
        pulled++;
        logger.info("skill-registry", `Pulled skill ${skillEntry.slug} for ${normalized}`);
      } catch (err: any) {
        errors.push(`Failed to fetch skill ${skillEntry.slug} for ${normalized}: ${err?.message}`);
      }
    }
  } else if (!bridge) {
    // No bridge entry in registry — not an error, just nothing to pull
    logger.debug("skill-registry", `No bridge entry for "${normalized}" in registry`);
  }

  if (errors.length > 0) {
    logger.warn("skill-registry", `Errors pulling skills for ${normalized}: ${errors.join("; ")}`);
  }

  return { pulled, errors };
}

/**
 * Pull skills for all known programs from the bridge registry.
 * Used by the "pull-all" admin endpoint.
 */
export async function pullAllBridgeSkills(
  skillsRepo: SkillsRepo,
  settingsRepo?: SettingsRepo,
): Promise<{ total: number; errors: string[] }> {
  const registry = await fetchBridgeRegistry();
  let total = 0;
  const allErrors: string[] = [];

  if (!registry.bridges || registry.bridges.length === 0) {
    return { total: 0, errors: ["No bridges found in registry"] };
  }

  for (const bridge of registry.bridges) {
    const result = await pullBridgeSkills(bridge.program, skillsRepo, settingsRepo, true);
    total += result.pulled;
    allErrors.push(...result.errors);
  }

  return { total, errors: allErrors };
}
