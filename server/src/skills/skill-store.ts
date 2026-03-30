/**
 * SkillStore — facade that wraps SkillsRepo (SQLite) + disk I/O (SKILL.md).
 *
 * Every mutation writes to both SQLite AND disk. Reads go through SQLite
 * (which is the indexed, searchable cache). Disk is the source of truth.
 *
 * This is the ONLY place that should call skillsRepo mutation methods
 * from outside the skills subsystem. All other code should use SkillStore.
 */

import { logger } from "../utils/logger.js";
import type { SkillsRepo, Skill, CreateSkillInput, UpdateSkillInput } from "../db/skills.repo.js";
import type { SkillIndex } from "./skill-index.js";
import {
  skillToSkillFile,
  writeSkillToDisk,
  deleteSkillFromDisk,
  skillDirPath,
} from "./skill-file.js";

export interface SkillStoreConfig {
  /** Root directory for SKILL.md files on disk */
  skillsDir: string;
  /** Directory where playbook artifacts currently live (for co-location migration) */
  coordinatorPlaybooksDir?: string;
}

export class SkillStore {
  constructor(
    private skillsRepo: SkillsRepo,
    private skillIndex: SkillIndex | null,
    private config: SkillStoreConfig,
  ) {}

  /**
   * Create a new skill. Writes to SQLite first, then persists to disk.
   */
  async create(input: CreateSkillInput, source?: string): Promise<Skill> {
    const skill = this.skillsRepo.create(input, source);
    await this.writeToDiskSafe(skill);
    this.refreshIndex();
    return skill;
  }

  /**
   * Update an existing skill. Writes to SQLite first, then persists to disk.
   */
  async update(slug: string, updates: UpdateSkillInput, program?: string): Promise<Skill | null> {
    const skill = this.skillsRepo.update(slug, updates, program);
    if (skill) {
      await this.writeToDiskSafe(skill);
      this.refreshIndex();
    }
    return skill;
  }

  /**
   * Delete a skill from both SQLite and disk.
   */
  async delete(slug: string, program?: string): Promise<boolean> {
    // Read the skill first to get program for disk path
    const existing = this.skillsRepo.get(slug, program);
    const deleted = this.skillsRepo.delete(slug, program);
    if (deleted && existing) {
      const dir = skillDirPath(this.config.skillsDir, existing.program, existing.slug);
      await deleteSkillFromDisk(dir).catch(() => {});
      this.refreshIndex();
    }
    return deleted;
  }

  /**
   * Delete by slug+program regardless of source.
   */
  async deleteAny(slug: string, program: string): Promise<boolean> {
    const deleted = this.skillsRepo.deleteAny(slug, program);
    if (deleted) {
      const dir = skillDirPath(this.config.skillsDir, program, slug);
      await deleteSkillFromDisk(dir).catch(() => {});
      this.refreshIndex();
    }
    return deleted;
  }

  /**
   * Upsert by slug+program composite key.
   */
  async upsertBySlugAndProgram(input: CreateSkillInput): Promise<Skill> {
    const skill = this.skillsRepo.upsertBySlugAndProgram(input);
    await this.writeToDiskSafe(skill);
    this.refreshIndex();
    return skill;
  }

  /**
   * Bulk delete by source, then remove SKILL.md files for deleted skills.
   */
  async deleteBySource(source: string, program?: string): Promise<number> {
    // Get skills that will be deleted so we can remove their files
    const toDelete = this.skillsRepo.listBySource(source)
      .filter(s => !program || s.program === program);
    const count = this.skillsRepo.deleteBySource(source, program);
    // Remove files for deleted skills
    for (const skill of toDelete) {
      const dir = skillDirPath(this.config.skillsDir, skill.program, skill.slug);
      await deleteSkillFromDisk(dir).catch(() => {});
    }
    if (count > 0) this.refreshIndex();
    return count;
  }

  // -----------------------------------------------------------------------
  // Read-through (delegate to repo — these don't need disk I/O)
  // -----------------------------------------------------------------------

  get(slug: string, program?: string): Skill | null {
    return this.skillsRepo.get(slug, program);
  }

  getAny(slug: string, program: string): Skill | null {
    return this.skillsRepo.getAny(slug, program);
  }

  list(opts?: { program?: string; category?: string }): Skill[] {
    return this.skillsRepo.list(opts);
  }

  listAll(opts?: { enabled?: boolean; category?: string; program?: string; source?: string }): Skill[] {
    return this.skillsRepo.listAll(opts);
  }

  listBySource(source: string): Skill[] {
    return this.skillsRepo.listBySource(source);
  }

  listVersions(skillId: string) {
    return this.skillsRepo.listVersions(skillId);
  }

  rollback(skillId: string, version: number) {
    return this.skillsRepo.rollback(skillId, version);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async writeToDiskSafe(skill: Skill): Promise<void> {
    try {
      const dir = skillDirPath(this.config.skillsDir, skill.program, skill.slug);
      const parsed = skillToSkillFile(skill);
      await writeSkillToDisk(dir, parsed);
    } catch (err) {
      // Disk write failure is non-fatal — SQLite is still the working cache
      logger.warn("skill-store", `Failed to write SKILL.md for ${skill.slug}: ${err}`);
    }
  }

  private refreshIndex(): void {
    try {
      this.skillIndex?.refresh();
    } catch { /* non-fatal */ }
  }
}
