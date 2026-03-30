/**
 * File watcher for SKILL.md files on disk.
 *
 * Watches the skills directory (recursive) and syncs changes back to SQLite.
 * Uses fs.watch with debouncing to avoid rapid re-processing.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { logger } from "../utils/logger.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillIndex } from "./skill-index.js";
import { readSkillFromDisk, skillFileToSkillFields } from "./skill-file.js";

export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private skillsDir: string,
    private skillsRepo: SkillsRepo,
    private skillIndex: SkillIndex | null,
  ) {}

  /** Begin watching the skills directory for SKILL.md changes. */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = watch(this.skillsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Normalise path separators to forward slash for consistent matching
        const normalized = filename.replace(/\\/g, "/");
        if (!normalized.endsWith("SKILL.md")) return;

        // Extract program and slug from {program}/{slug}/SKILL.md
        const parts = normalized.split("/");
        if (parts.length < 3) return; // must be at least program/slug/SKILL.md

        const program = parts[0];
        const slug = parts[1];

        // Sanity: program and slug should be non-empty, no dots-only names
        if (!program || !slug || program === "." || slug === ".") return;

        const key = `${program}/${slug}`;

        // Debounce: clear any pending timer for this skill
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing);

        this.pending.set(
          key,
          setTimeout(() => {
            this.pending.delete(key);
            this.handleChange(program, slug).catch((err) => {
              logger.warn("skill-watcher", ` Error handling change for ${key}: ${err}`);
            });
          }, 500),
        );
      });

      this.watcher.on("error", (err) => {
        logger.warn("skill-watcher", ` Watcher error: ${err}`);
      });

      logger.info("skill-watcher", ` Watching ${this.skillsDir} for SKILL.md changes`);
    } catch (err) {
      logger.warn("skill-watcher", ` Failed to start watcher: ${err}`);
    }
  }

  /** Stop watching and clean up all pending timers. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    logger.info("skill-watcher", "Stopped");
  }

  /** Handle a debounced change for a specific program/slug. */
  private async handleChange(program: string, slug: string): Promise<void> {
    const skillDir = join(this.skillsDir, program, slug);
    const skillMdPath = join(skillDir, "SKILL.md");

    // Check if file still exists (could be a delete event)
    let exists = false;
    try {
      const s = await stat(skillMdPath);
      exists = s.isFile();
    } catch {
      // File doesn't exist — treat as deletion
    }

    if (exists) {
      // Upsert: read, parse, and save to DB
      const parsed = await readSkillFromDisk(skillDir);
      if (!parsed) {
        logger.warn("skill-watcher", ` Failed to parse ${skillMdPath}, skipping`);
        return;
      }

      const fields = skillFileToSkillFields(parsed);
      // Override program from directory structure (source of truth is the path)
      fields.program = program;

      try {
        this.skillsRepo.upsertBySlugAndProgram({
          ...fields,
          sourcePath: skillDir,
        });
        logger.info("skill-watcher", ` Upserted skill ${program}/${slug}`);
      } catch (err) {
        logger.warn("skill-watcher", ` DB upsert failed for ${program}/${slug}: ${err}`);
        return;
      }
    } else {
      // Delete from DB
      const deleted = this.skillsRepo.deleteAny(slug, program);
      if (deleted) {
        logger.info("skill-watcher", ` Deleted skill ${program}/${slug}`);
      }
    }

    // Refresh the in-memory index
    if (this.skillIndex) {
      try {
        this.skillIndex.refresh();
      } catch (err) {
        logger.warn("skill-watcher", ` Index refresh failed: ${err}`);
      }
    }
  }
}
