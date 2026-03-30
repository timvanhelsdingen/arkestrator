/**
 * Rebuild the SQLite skills index from SKILL.md files on disk.
 *
 * Disk is the source of truth: skills found on disk are upserted into the DB,
 * and DB skills not present on disk are removed.
 */

import { logger } from "../utils/logger.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import { listSkillsOnDisk, readSkillFromDisk, skillFileToSkillFields } from "./skill-file.js";

export interface RebuildResult {
  loaded: number;
  skipped: number;
  removed: number;
}

/**
 * Scan all SKILL.md files under `skillsDir`, upsert them into the DB,
 * and remove any DB skills that no longer exist on disk.
 */
export async function rebuildSkillsIndexFromDisk(
  skillsDir: string,
  skillsRepo: SkillsRepo,
): Promise<RebuildResult> {
  const entries = await listSkillsOnDisk(skillsDir);
  const diskKeys = new Set<string>();

  let loaded = 0;
  let skipped = 0;

  for (const entry of entries) {
    const key = `${entry.program}/${entry.slug}`;

    const parsed = await readSkillFromDisk(entry.dir);
    if (!parsed) {
      logger.warn("skill-loader", `Failed to parse SKILL.md in ${entry.dir}, skipping`);
      skipped++;
      continue;
    }

    diskKeys.add(key);

    try {
      const fields = skillFileToSkillFields(parsed);
      skillsRepo.upsertBySlugAndProgram({
        slug: fields.slug,
        name: fields.name,
        program: fields.program,
        category: fields.category,
        title: fields.title,
        description: fields.description,
        keywords: fields.keywords,
        content: fields.content,
        playbooks: fields.playbooks,
        relatedSkills: fields.relatedSkills,
        source: fields.source,
        priority: fields.priority,
        autoFetch: fields.autoFetch,
        enabled: fields.enabled,
      });
      loaded++;
    } catch (err) {
      logger.warn("skill-loader", `Failed to upsert skill ${key}: ${err}`);
      skipped++;
    }
  }

  // Remove DB skills not found on disk — disk is source of truth
  let removed = 0;
  const allDbSkills = skillsRepo.listAll();
  for (const dbSkill of allDbSkills) {
    const key = `${dbSkill.program}/${dbSkill.slug}`;
    if (!diskKeys.has(key)) {
      skillsRepo.deleteAny(dbSkill.slug, dbSkill.program);
      removed++;
    }
  }

  logger.info(
    "skill-loader",
    `Rebuilt index: ${loaded} loaded, ${skipped} skipped, ${removed} removed`,
  );

  return { loaded, skipped, removed };
}
