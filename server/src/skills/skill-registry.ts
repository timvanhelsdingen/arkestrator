/**
 * Bridge-repo skill ingestion.
 *
 * Pulls coordinator scripts and skills from the arkestrator-bridges GitHub repo
 * when a bridge connects. Reuses the existing registry cache from routes/skills.ts.
 */

import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillStore } from "./skill-store.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { logger } from "../utils/logger.js";
import { parseSkillFile, skillFileToSkillFields, writeSkillToDisk, skillDirPath } from "./skill-file.js";

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

/** Base URL for raw content in the arkestrator-bridges GitHub repo. */
export const BRIDGE_RAW_BASE_URL = "https://raw.githubusercontent.com/timvanhelsdingen/arkestrator-bridges/main";

/** URL for the bridge registry.json in the arkestrator-bridges GitHub repo. */
export const BRIDGE_REGISTRY_URL = `${BRIDGE_RAW_BASE_URL}/registry.json`;
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

const BRIDGE_RAW_BASE = BRIDGE_RAW_BASE_URL;

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
  skillStore?: SkillStore,
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

  // 2. Skip network fetch if skills already exist for this program (from a previous pull).
  //    Only re-fetch if force=true or no bridge-repo skills exist yet.
  if (!force) {
    const existingSkills = skillsRepo.listAll({ program: normalized, source: "bridge-repo" });
    if (existingSkills.length > 0) {
      return { pulled: 0, errors: [] };
    }
  }

  // 3. Fetch registry.json
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
          const input = {
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
          };
          if (skillStore) {
            await skillStore.upsertBySlugAndProgram(input);
          } else {
            skillsRepo.upsertBySlugAndProgram(input);
          }
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

        // Only coordinator skills are auto-fetched into prompt.
        // Workflow skills (materials, modeling, etc.) are on-demand via
        // search_skills/get_skill — tracked for effectiveness.
        // Coordinators + verification are always auto-fetched (always relevant for their program).
        // Workflow skills (materials, modeling, etc.) are on-demand.
        const isCoordinator = skillEntry.category === "coordinator" || skillEntry.slug.endsWith("-coordinator");
        const isVerification = skillEntry.slug === "verification" || skillEntry.category === "verification";
        const skillInput = {
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
          autoFetch: isCoordinator || isVerification,
          enabled: true,
        };
        if (skillStore) {
          await skillStore.upsertBySlugAndProgram(skillInput);
        } else {
          skillsRepo.upsertBySlugAndProgram(skillInput);
        }
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
 * Pull skills for connected/installed bridge programs from the bridge registry.
 * Only pulls for programs that are actually in use (passed via connectedPrograms),
 * not every bridge in the registry.
 *
 * @param connectedPrograms - List of bridge program names currently connected/installed.
 *   If omitted or empty, falls back to pulling all registry bridges (legacy behavior).
 */
export async function pullAllBridgeSkills(
  skillsRepo: SkillsRepo,
  settingsRepo?: SettingsRepo,
  connectedPrograms?: string[],
  skillStore?: SkillStore,
): Promise<{ total: number; errors: string[] }> {
  const registry = await fetchBridgeRegistry();
  let total = 0;
  const allErrors: string[] = [];

  if (!registry.bridges || registry.bridges.length === 0) {
    return { total: 0, errors: ["No bridges found in registry"] };
  }

  // Filter to only connected/installed bridges
  const programs = connectedPrograms && connectedPrograms.length > 0
    ? connectedPrograms
    : registry.bridges.map((b) => b.program);

  for (const program of programs) {
    // Only pull if this program exists in the registry
    const inRegistry = registry.bridges.some((b) => b.program === program);
    if (!inRegistry) continue;

    const result = await pullBridgeSkills(program, skillsRepo, settingsRepo, true, skillStore);
    total += result.pulled;
    allErrors.push(...result.errors);
  }

  return { total, errors: allErrors };
}

// ---------------------------------------------------------------------------
// Standard Agent Skills import (agentskills.io)
// ---------------------------------------------------------------------------

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Import standard Agent Skills from a GitHub repo.
 *
 * Supports two directory layouts:
 * 1. Flat: repo contains skill directories at root, each with SKILL.md
 *    e.g. github.com/anthropics/skills → explain-code/SKILL.md
 * 2. Nested: repo has a subdirectory path containing skills
 *    e.g. github.com/org/repo → skills/blender/SKILL.md
 *
 * Uses the GitHub API to list directories, then fetches SKILL.md from each.
 * Standard frontmatter fields are mapped; Arkestrator metadata extensions are
 * preserved if present.
 *
 * @param repoUrl — GitHub repo URL (e.g. "https://github.com/anthropics/skills")
 * @param targetProgram — Program to assign imported skills to (e.g. "global", "blender")
 * @param skillStore — SkillStore for dual-write (DB + disk)
 * @param opts.subPath — Optional subdirectory within the repo
 * @param opts.skillsDir — Skills directory on disk (for SKILL.md writes)
 */
export async function importSkillsFromGitHub(
  repoUrl: string,
  targetProgram: string,
  skillStore: SkillStore,
  opts?: { subPath?: string; skillsDir?: string },
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Parse GitHub URL → owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    return { imported: 0, skipped: 0, errors: ["Invalid GitHub URL"] };
  }
  const [, owner, repo] = match;
  const repoName = repo.replace(/\.git$/, "");
  const subPath = opts?.subPath ?? "";
  const apiPath = subPath ? `${subPath}` : "";

  // Fetch directory listing from GitHub API
  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${apiPath}`;
  let entries: Array<{ name: string; type: string; path: string }>;
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Arkestrator" },
    });
    if (!res.ok) {
      return { imported: 0, skipped: 0, errors: [`GitHub API ${res.status}: ${res.statusText}`] };
    }
    entries = (await res.json()) as any[];
    if (!Array.isArray(entries)) {
      return { imported: 0, skipped: 0, errors: ["GitHub API returned non-array"] };
    }
  } catch (err: any) {
    return { imported: 0, skipped: 0, errors: [`GitHub API error: ${err?.message}`] };
  }

  // Filter to directories (potential skill directories)
  const dirs = entries.filter((e) => e.type === "dir");

  for (const dir of dirs) {
    if (dir.name.startsWith(".")) continue;

    // Try to fetch SKILL.md from this directory
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/main/${dir.path}/SKILL.md`;
    try {
      const res = await fetch(rawUrl);
      if (!res.ok) {
        // No SKILL.md in this directory — skip silently
        skipped++;
        continue;
      }
      const raw = await res.text();
      const parsed = parseSkillFile(raw);
      if (!parsed) {
        errors.push(`Failed to parse SKILL.md in ${dir.name}`);
        continue;
      }

      const fields = skillFileToSkillFields(parsed);

      // Override program to target if not explicitly set in the skill metadata
      if (!parsed.frontmatter.metadata?.program) {
        fields.program = targetProgram;
      }

      // Mark source as registry import
      fields.source = "registry";

      // Don't overwrite user-edited skills
      const existing = skillStore.getAny(fields.slug, fields.program);
      if (existing && existing.source === "user") {
        skipped++;
        continue;
      }

      await skillStore.upsertBySlugAndProgram({
        ...fields,
        sourcePath: rawUrl,
      });
      imported++;
      logger.info("skill-registry", `Imported skill ${fields.slug} from ${owner}/${repoName}`);
    } catch (err: any) {
      errors.push(`Failed to import ${dir.name}: ${err?.message}`);
    }
  }

  if (errors.length > 0) {
    logger.warn("skill-registry", `Import errors from ${repoUrl}: ${errors.join("; ")}`);
  }

  return { imported, skipped, errors };
}
