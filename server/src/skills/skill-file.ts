/**
 * SKILL.md parser and serializer — Agent Skills open standard (agentskills.io).
 *
 * Skills are stored as directories containing a SKILL.md file with YAML
 * frontmatter and markdown body, plus optional supporting files (references,
 * scripts, assets).
 *
 * Standard fields:  name, description
 * Arkestrator extensions stored in metadata: program, category, title, keywords,
 *   source, priority, auto-fetch, enabled, related-skills, effectiveness
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Skill } from "../db/skills.repo.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Standard Agent Skills frontmatter (agentskills.io spec) */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  "allowed-tools"?: string;
}

/** Parsed SKILL.md file */
export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Effectiveness data stored in metadata */
export interface SkillEffectivenessMetadata {
  "total-uses": number;
  "success-rate": number;
  "last-rated"?: string;
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a raw SKILL.md string into frontmatter + body.
 * Returns null if the file has no valid frontmatter.
 */
export function parseSkillFile(raw: string): ParsedSkillFile | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  try {
    const frontmatter = yamlParse(match[1]) as SkillFrontmatter;
    if (!frontmatter || typeof frontmatter !== "object") return null;
    if (!frontmatter.name || typeof frontmatter.name !== "string") return null;
    return { frontmatter, body: match[2].trim() };
  } catch {
    return null;
  }
}

/**
 * Serialize a ParsedSkillFile back to a SKILL.md string.
 */
export function serializeSkillFile(data: ParsedSkillFile): string {
  const yaml = yamlStringify(data.frontmatter, { lineWidth: 0 }).trim();
  return `---\n${yaml}\n---\n\n${data.body}\n`;
}

// ---------------------------------------------------------------------------
// Skill <-> SKILL.md conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Arkestrator Skill DB record to a ParsedSkillFile.
 */
export function skillToSkillFile(skill: Skill, effectiveness?: SkillEffectivenessMetadata): ParsedSkillFile {
  const metadata: Record<string, unknown> = {};

  // Arkestrator extensions
  if (skill.program && skill.program !== "global") metadata.program = skill.program;
  if (skill.category) metadata.category = skill.category;
  if (skill.title && skill.title !== skill.slug) metadata.title = skill.title;
  if (skill.keywords?.length > 0) metadata.keywords = skill.keywords;
  if (skill.source) metadata.source = skill.source;
  if (skill.priority !== 50) metadata.priority = skill.priority;
  if (skill.autoFetch) metadata["auto-fetch"] = true;
  if (!skill.enabled) metadata.enabled = false;
  if (skill.relatedSkills?.length > 0) metadata["related-skills"] = skill.relatedSkills;
  if (skill.playbooks?.length > 0) metadata["playbook-files"] = skill.playbooks;

  // Effectiveness data (optional, portable)
  if (effectiveness) metadata.effectiveness = effectiveness;

  const frontmatter: SkillFrontmatter = {
    name: skill.slug,
    description: skill.description || skill.title || skill.slug,
  };

  if (Object.keys(metadata).length > 0) {
    frontmatter.metadata = metadata;
  }

  return { frontmatter, body: skill.content };
}

/**
 * Convert a ParsedSkillFile to fields compatible with Skill DB record.
 * Does not include id, version, createdAt, updatedAt (those are DB-managed).
 */
export function skillFileToSkillFields(parsed: ParsedSkillFile): {
  slug: string;
  name: string;
  program: string;
  category: string;
  title: string;
  description: string;
  keywords: string[];
  content: string;
  playbooks: string[];
  relatedSkills: string[];
  source: string;
  priority: number;
  autoFetch: boolean;
  enabled: boolean;
} {
  const meta = (parsed.frontmatter.metadata ?? {}) as Record<string, any>;

  return {
    slug: parsed.frontmatter.name,
    name: (meta.title as string) || parsed.frontmatter.name,
    program: (meta.program as string) || "global",
    category: (meta.category as string) || "custom",
    title: (meta.title as string) || parsed.frontmatter.name,
    description: parsed.frontmatter.description || "",
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    content: parsed.body,
    playbooks: Array.isArray(meta["playbook-files"]) ? meta["playbook-files"] : [],
    relatedSkills: Array.isArray(meta["related-skills"]) ? meta["related-skills"] : [],
    source: (meta.source as string) || "user",
    priority: typeof meta.priority === "number" ? meta.priority : 50,
    autoFetch: meta["auto-fetch"] === true,
    enabled: meta.enabled !== false,
  };
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

/**
 * Read a skill from a directory containing SKILL.md.
 * Returns null if no valid SKILL.md found.
 */
export async function readSkillFromDisk(skillDir: string): Promise<ParsedSkillFile | null> {
  try {
    const raw = await readFile(join(skillDir, "SKILL.md"), "utf-8");
    return parseSkillFile(raw);
  } catch {
    return null;
  }
}

/**
 * Write a skill to disk as SKILL.md in the given directory.
 * Creates the directory if it doesn't exist.
 */
export async function writeSkillToDisk(skillDir: string, data: ParsedSkillFile): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  const content = serializeSkillFile(data);
  await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");
}

/**
 * Delete a skill directory from disk.
 */
export async function deleteSkillFromDisk(skillDir: string): Promise<boolean> {
  try {
    await rm(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the disk path for a skill given the base skills directory.
 * Structure: {skillsDir}/{program}/{slug}/
 */
export function skillDirPath(skillsDir: string, program: string, slug: string): string {
  return join(skillsDir, program || "global", slug);
}

/**
 * Scan a skills directory and return all (program, slug) pairs found.
 * Expects structure: {skillsDir}/{program}/{slug}/SKILL.md
 */
export async function listSkillsOnDisk(skillsDir: string): Promise<Array<{ program: string; slug: string; dir: string }>> {
  const results: Array<{ program: string; slug: string; dir: string }> = [];

  let programs: string[];
  try {
    programs = await readdir(skillsDir);
  } catch {
    return results;
  }

  for (const program of programs) {
    if (program.startsWith(".")) continue;
    const programDir = join(skillsDir, program);
    try {
      const s = await stat(programDir);
      if (!s.isDirectory()) continue;
    } catch { continue; }

    let slugs: string[];
    try {
      slugs = await readdir(programDir);
    } catch { continue; }

    for (const slug of slugs) {
      if (slug.startsWith(".")) continue;
      const dir = join(programDir, slug);
      try {
        const s = await stat(join(dir, "SKILL.md"));
        if (s.isFile()) {
          results.push({ program, slug, dir });
        }
      } catch { /* no SKILL.md, skip */ }
    }
  }

  return results;
}
