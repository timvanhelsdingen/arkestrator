import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { logger } from "../utils/logger.js";

const MIGRATION_KEY = "skills_migration_v1_complete";

interface PlaybookTask {
  id: string;
  title: string;
  description?: string;
  instruction: string;
  keywords?: string[];
  regex?: string[];
  examples?: string[];
}

interface PlaybookManifest {
  version: number;
  program: string;
  description?: string;
  tasks: PlaybookTask[];
}

interface TrainingRecord {
  id: string;
  title?: string;
  summary?: string;
  prompt?: string;
  outcome?: string;
  qualityRating?: "good" | "average" | "bad";
  keywords?: string[];
  quarantined?: boolean;
}

interface TrainingIndex {
  version: number;
  records: TrainingRecord[];
}

/**
 * One-time migration of disk-based coordinator data into the skills table.
 * Runs at startup; skipped if the migration flag is already set.
 * Uses upsertBySlugAndProgram for idempotency.
 */
export function migrateSkillsFromDisk(opts: {
  skillsRepo: SkillsRepo;
  settingsRepo: SettingsRepo;
  coordinatorScriptsDir: string;
  coordinatorPlaybooksDir: string;
}): void {
  if (opts.settingsRepo.get(MIGRATION_KEY) === "true") return;

  logger.info("skills-migration", "Starting one-time skill migration from disk...");

  let migratedCount = 0;

  // 1. Migrate coordinator scripts (*.md files)
  migratedCount += migrateCoordinatorScripts(opts.skillsRepo, opts.coordinatorScriptsDir);

  // 2. Migrate playbook tasks
  migratedCount += migratePlaybooks(opts.skillsRepo, opts.coordinatorPlaybooksDir);

  // 3. Migrate training records
  migratedCount += migrateTrainingRecords(opts.skillsRepo, opts.coordinatorPlaybooksDir);

  // Mark as complete
  opts.settingsRepo.set(MIGRATION_KEY, "true");
  logger.info("skills-migration", `Skill migration complete. Migrated ${migratedCount} skill(s).`);
}

function migrateCoordinatorScripts(skillsRepo: SkillsRepo, dir: string): number {
  if (!existsSync(dir)) return 0;

  let count = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;

      const filePath = join(dir, file);
      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        const name = basename(file, ".md");
        const isGlobal = name === "global";
        const program = isGlobal ? "global" : name;
        const category = isGlobal ? "coordinator" : "bridge";
        const slug = `${program}-coordinator`;

        skillsRepo.upsertBySlugAndProgram({
          name: slug,
          slug,
          program,
          category,
          title: `${program.charAt(0).toUpperCase() + program.slice(1)} Coordinator Script`,
          description: `Coordinator script for ${program}`,
          content,
          source: "coordinator",
          sourcePath: filePath,
          priority: isGlobal ? 90 : 70,
          autoFetch: true,
          enabled: true,
        });
        count++;
      } catch (err) {
        logger.warn("skills-migration", `Failed to migrate coordinator script ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.warn("skills-migration", `Failed to read coordinator scripts dir ${dir}: ${err}`);
  }

  if (count > 0) {
    logger.info("skills-migration", `Migrated ${count} coordinator script(s)`);
  }
  return count;
}

function migratePlaybooks(skillsRepo: SkillsRepo, dir: string): number {
  if (!existsSync(dir)) return 0;

  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

      const program = entry.name;
      const programDir = join(dir, program);
      const manifestPath = join(programDir, "playbook.json");

      if (!existsSync(manifestPath)) continue;

      try {
        const manifestRaw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestRaw) as PlaybookManifest;

        if (!manifest.tasks || !Array.isArray(manifest.tasks)) continue;

        for (const task of manifest.tasks) {
          try {
            // Read the instruction file content
            let instructionContent = "";
            if (task.instruction) {
              const instructionPath = join(programDir, task.instruction);
              if (existsSync(instructionPath)) {
                instructionContent = readFileSync(instructionPath, "utf-8").trim();
              }
            }

            const slug = `playbook-${program}-${task.id}`;
            skillsRepo.upsertBySlugAndProgram({
              name: slug,
              slug,
              program,
              category: "playbook",
              title: task.title || task.id,
              description: task.description || "",
              keywords: task.keywords || [],
              content: instructionContent || task.description || "",
              source: "playbook",
              sourcePath: task.instruction ? join(programDir, task.instruction) : null,
              priority: 50,
              autoFetch: false,
              enabled: true,
            });
            count++;
          } catch (err) {
            logger.warn("skills-migration", `Failed to migrate playbook task ${task.id} for ${program}: ${err}`);
          }
        }
      } catch (err) {
        logger.warn("skills-migration", `Failed to parse playbook manifest for ${program}: ${err}`);
      }
    }
  } catch (err) {
    logger.warn("skills-migration", `Failed to read playbooks dir ${dir}: ${err}`);
  }

  if (count > 0) {
    logger.info("skills-migration", `Migrated ${count} playbook task(s)`);
  }
  return count;
}

function migrateTrainingRecords(skillsRepo: SkillsRepo, dir: string): number {
  if (!existsSync(dir)) return 0;

  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

      const program = entry.name;
      const indexPath = join(dir, program, ".arkestrator", "training-index-v2.json");

      if (!existsSync(indexPath)) continue;

      try {
        const indexRaw = readFileSync(indexPath, "utf-8");
        const index = JSON.parse(indexRaw) as TrainingIndex;

        if (!index.records || !Array.isArray(index.records)) continue;

        for (const record of index.records) {
          try {
            // Skip quarantined records
            if (record.quarantined) continue;

            // Build content from available fields
            const contentParts: string[] = [];
            if (record.summary) contentParts.push(`## Summary\n${record.summary}`);
            if (record.prompt) contentParts.push(`## Prompt\n${record.prompt}`);
            if (record.outcome) contentParts.push(`## Outcome\n${record.outcome}`);
            const content = contentParts.join("\n\n");

            if (!content.trim()) continue;

            const slug = `training-${program}-${record.id}`;
            skillsRepo.upsertBySlugAndProgram({
              name: slug,
              slug,
              program,
              category: "training",
              title: record.title || `Training: ${record.id}`,
              description: record.summary || "",
              keywords: record.keywords || [],
              content,
              source: "training",
              sourcePath: indexPath,
              priority: 30,
              autoFetch: false,
              enabled: true,
            });
            count++;
          } catch (err) {
            logger.warn("skills-migration", `Failed to migrate training record ${record.id} for ${program}: ${err}`);
          }
        }
      } catch (err) {
        logger.warn("skills-migration", `Failed to parse training index for ${program}: ${err}`);
      }
    }
  } catch (err) {
    logger.warn("skills-migration", `Failed to read playbooks dir for training: ${err}`);
  }

  if (count > 0) {
    logger.info("skills-migration", `Migrated ${count} training record(s)`);
  }
  return count;
}
