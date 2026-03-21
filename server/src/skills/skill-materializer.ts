/**
 * Skill Materializer — returns all enabled skills from the DB.
 *
 * All skill sources (coordinator scripts, playbooks, training records,
 * built-in bridge skills) are now seeded into the DB at startup.
 * This function simply reads them back.
 */

import type { Skill } from "../db/skills.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";

/** Configuration for the materializer. */
export interface SkillMaterializerConfig {
  skillsRepo: SkillsRepo;
}

/**
 * Materialize all enabled skills from the DB into a flat Skill[].
 * Runs synchronously — intended for startup and periodic refresh.
 */
export function materializeSkills(config: SkillMaterializerConfig): Skill[] {
  return config.skillsRepo.listAll({ enabled: true });
}
