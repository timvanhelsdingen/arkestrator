/**
 * One-time migration: export all existing SQLite skills to SKILL.md files on disk.
 *
 * Idempotent — checks the `skills_export_v1_complete` settings flag and skips
 * individual skills whose SKILL.md already exists on disk.
 */

import { logger } from "../utils/logger.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { SkillEffectivenessRepo } from "../db/skill-effectiveness.repo.js";
import { skillToSkillFile, writeSkillToDisk, skillDirPath } from "./skill-file.js";
import type { SkillEffectivenessMetadata } from "./skill-file.js";
import { stat, copyFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

export interface ExportResult {
  exported: number;
  skipped: number;
  errors: number;
}

export interface ExportOptions {
  coordinatorPlaybooksDir?: string;
  settingsRepo?: SettingsRepo;
  skillEffectivenessRepo?: SkillEffectivenessRepo;
}

/**
 * Export all skills from the SQLite database to SKILL.md files on disk.
 *
 * - Checks `skills_export_v1_complete` flag — if already set, returns early.
 * - Skips skills whose SKILL.md already exists on disk.
 * - Optionally includes effectiveness metadata and copies playbook files.
 */
export async function exportAllSkillsToDisk(
  skillsRepo: SkillsRepo,
  skillsDir: string,
  opts?: ExportOptions,
): Promise<ExportResult> {
  const settingsRepo = opts?.settingsRepo;
  const skillEffectivenessRepo = opts?.skillEffectivenessRepo;
  const coordinatorPlaybooksDir = opts?.coordinatorPlaybooksDir;

  // Idempotent: skip if already completed
  if (settingsRepo?.get("skills_export_v1_complete") === "true") {
    logger.info("skill-export", "Migration already complete, skipping");
    return { exported: 0, skipped: 0, errors: 0 };
  }

  const allSkills = skillsRepo.listAll();
  let exported = 0;
  let skipped = 0;
  let errors = 0;

  for (const skill of allSkills) {
    const dir = skillDirPath(skillsDir, skill.program, skill.slug);
    const skillMdPath = join(dir, "SKILL.md");

    // Skip if SKILL.md already exists on disk
    try {
      const s = await stat(skillMdPath);
      if (s.isFile()) {
        skipped++;
        continue;
      }
    } catch {
      // File doesn't exist — proceed with export
    }

    try {
      // Build effectiveness metadata if repo is available
      let effectiveness: SkillEffectivenessMetadata | undefined;
      if (skillEffectivenessRepo) {
        const stats = skillEffectivenessRepo.getStats(skill.id);
        if (stats.totalUsed > 0) {
          effectiveness = {
            "total-uses": stats.totalUsed,
            "success-rate": Math.round(stats.successRate * 100) / 100,
          };
          // Include last-rated timestamp from most recent record
          const recent = skillEffectivenessRepo.listForSkill(skill.id, 1);
          if (recent.length > 0 && recent[0].jobOutcome) {
            effectiveness["last-rated"] = recent[0].createdAt;
          }
        }
      }

      // Convert and write
      const parsed = skillToSkillFile(skill, effectiveness);
      await writeSkillToDisk(dir, parsed);

      // Copy playbook files to {skillDir}/references/ if applicable
      if (skill.playbooks?.length > 0 && coordinatorPlaybooksDir) {
        const refsDir = join(dir, "references");
        await mkdir(refsDir, { recursive: true });

        for (const playbookPath of skill.playbooks) {
          const srcPath = join(coordinatorPlaybooksDir, playbookPath);
          const destPath = join(refsDir, basename(playbookPath));
          try {
            await copyFile(srcPath, destPath);
          } catch {
            // Source playbook not found — skip gracefully
            logger.debug("skill-export", `Playbook not found, skipping: ${srcPath}`);
          }
        }
      }

      exported++;
    } catch (err) {
      errors++;
      logger.warn("skill-export", `Failed to export skill ${skill.program}/${skill.slug}: ${err}`);
    }
  }

  // Mark migration as complete
  if (settingsRepo) {
    settingsRepo.set("skills_export_v1_complete", "true");
  }

  logger.info(
    "skill-export",
    `Exported ${exported} skills to disk (${skipped} skipped, ${errors} errors)`,
  );

  return { exported, skipped, errors };
}
