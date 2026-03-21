/**
 * Skill Materializer — converts existing data sources into Skill[] for indexing.
 *
 * Reads from:
 * - Coordinator scripts on disk (*.md files)
 * - Custom skills from the DB (via SkillsRepo)
 * - Playbook task manifests (via collectPlaybooks)
 * - Training repository records (via loadTrainingRepositoryIndex)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import type { Skill } from "../db/skills.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { CoordinatorPlaybookManifest } from "../agents/coordinator-playbooks.js";
import {
  loadTrainingRepositoryIndex,
  type TrainingRepositoryIndex,
} from "../agents/training-repository.js";

/** Configuration for the materializer. */
export interface SkillMaterializerConfig {
  /** Path to coordinator scripts directory (e.g. data/coordinator-scripts). */
  coordinatorScriptsDir: string;
  /** Path to coordinator playbooks directory (e.g. data/coordinator-playbooks). */
  coordinatorPlaybooksDir: string;
  /** Path to coordinator imports directory (used by training repo). */
  coordinatorImportsDir: string;
  /** Known programs (bridge programs discovered at runtime). */
  knownPrograms: string[];
  /** Optional playbook source paths. */
  playbookSourcePaths?: string[];
  /** Custom skills repo instance. */
  skillsRepo: SkillsRepo;
}

/**
 * Materialize all skills from disk and DB into a flat Skill[].
 * Runs synchronously — intended for startup and periodic refresh.
 */
export function materializeSkills(config: SkillMaterializerConfig): Skill[] {
  const skills: Skill[] = [];
  const now = new Date().toISOString();

  // 1. Coordinator scripts from disk
  skills.push(...materializeCoordinatorScripts(config.coordinatorScriptsDir, now));

  // 2. Custom skills from DB
  skills.push(...config.skillsRepo.list());

  // 3. Playbook tasks from manifests
  skills.push(...materializePlaybooks(config.coordinatorPlaybooksDir, config.knownPrograms, config.playbookSourcePaths ?? [], now));

  // 4. Training records
  skills.push(...materializeTrainingRecords(config.coordinatorPlaybooksDir, config.knownPrograms, now));

  return skills;
}

/**
 * Read *.md files from the coordinator scripts directory.
 * global.md -> category 'coordinator', others -> category 'bridge'.
 * Skips hidden/hash files.
 */
function materializeCoordinatorScripts(dir: string, now: string): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip hidden files and hash files
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    const name = basename(entry, extname(entry));

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const isGlobal = name === "global";
    const category = isGlobal ? "coordinator" : "bridge";
    const program = isGlobal ? "global" : name;
    const slug = `${program}-${category}`;

    // Extract title from first heading or use filename
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : `${name} coordinator script`;

    // Extract keywords from content (simple: first few meaningful words)
    const keywords = extractKeywords(content);

    skills.push({
      id: `script:${slug}`,
      name,
      slug,
      program,
      category,
      title,
      description: isGlobal
        ? "Global coordinator instructions for all programs"
        : `Coordinator instructions for ${name}`,
      keywords,
      content,
      source: "coordinator-script",
      sourcePath: filePath,
      priority: isGlobal ? 90 : 70,
      autoFetch: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return skills;
}

/**
 * Read playbook manifests from the playbooks directory.
 * Each task in a playbook becomes a separate skill.
 */
function materializePlaybooks(
  playbooksDir: string,
  programs: string[],
  playbookSourcePaths: string[],
  now: string,
): Skill[] {
  if (!existsSync(playbooksDir)) return [];

  const skills: Skill[] = [];

  for (const program of programs) {
    const manifestPath = join(playbooksDir, program, "playbook.json");
    const manifest = loadPlaybookManifest(manifestPath);
    if (!manifest) continue;

    for (const task of manifest.tasks) {
      const slug = `playbook-${program}-${task.id}`;
      skills.push({
        id: `playbook:${slug}`,
        name: task.id,
        slug,
        program,
        category: "playbook",
        title: task.title,
        description: task.description ?? "",
        keywords: task.keywords ?? [],
        content: task.instruction,
        source: "playbook",
        sourcePath: manifestPath,
        priority: 50,
        autoFetch: false,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Also check external playbook source paths
  for (const sourcePath of playbookSourcePaths) {
    if (!sourcePath.trim() || !existsSync(sourcePath.trim())) continue;

    for (const program of programs) {
      const candidates = [
        join(sourcePath.trim(), program, "playbook.json"),
        join(sourcePath.trim(), `${program}.playbook.json`),
        join(sourcePath.trim(), `${program}.json`),
      ];

      for (const candidate of candidates) {
        const manifest = loadPlaybookManifest(candidate);
        if (!manifest) continue;

        for (const task of manifest.tasks) {
          const slug = `playbook-${program}-${task.id}`;
          // Skip if already added (primary takes precedence)
          if (skills.some((s) => s.slug === slug && s.program === program)) continue;

          skills.push({
            id: `playbook:${slug}`,
            name: task.id,
            slug,
            program,
            category: "playbook",
            title: task.title,
            description: task.description ?? "",
            keywords: task.keywords ?? [],
            content: task.instruction,
            source: "playbook",
            sourcePath: candidate,
            priority: 45,
            autoFetch: false,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }

  return skills;
}

/**
 * Read training repository indexes for known programs.
 * Each training record becomes a skill.
 */
function materializeTrainingRecords(
  playbooksDir: string,
  programs: string[],
  now: string,
): Skill[] {
  const skills: Skill[] = [];

  for (const program of programs) {
    let index: TrainingRepositoryIndex;
    try {
      index = loadTrainingRepositoryIndex({ dir: playbooksDir, program });
    } catch {
      continue;
    }

    if (!index || index.records.length === 0) continue;

    for (const record of index.records) {
      if (record.quarantined) continue;

      const slug = `training-${record.id}`;
      const content = [
        record.summary,
        record.prompt ? `\nPrompt: ${record.prompt}` : "",
        record.outcome ? `\nOutcome: ${record.outcome}` : "",
      ].join("");

      skills.push({
        id: `training:${record.id}`,
        name: record.id,
        slug,
        program: record.program || program,
        category: "training",
        title: record.title,
        description: record.summary,
        keywords: record.keywords ?? [],
        content,
        source: "training",
        sourcePath: record.sourcePath,
        priority: qualityToPriority(record.qualityRating),
        autoFetch: false,
        enabled: true,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      });
    }
  }

  return skills;
}

/** Load and validate a playbook manifest from a JSON file path. */
function loadPlaybookManifest(path: string): CoordinatorPlaybookManifest | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CoordinatorPlaybookManifest;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Convert training quality rating to a priority number. */
function qualityToPriority(rating: string): number {
  if (rating === "good") return 60;
  if (rating === "average") return 40;
  return 25;
}

/** Extract simple keywords from content text. */
function extractKeywords(content: string): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  // Deduplicate and take top keywords
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 30) break;
  }
  return out;
}
