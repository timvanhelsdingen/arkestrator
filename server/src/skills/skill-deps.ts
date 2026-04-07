/**
 * Skill dependency resolver — walks `relatedSkills` recursively to produce
 * a flat, deduplicated list of transitive dependencies.
 *
 * Used by export-zip (server-side) and could be reused by other server
 * components that need to resolve skill dependency trees.
 */

import { logger } from "../utils/logger.js";
import type { Skill } from "../db/skills.repo.js";

/**
 * Lookup function signature. Given a slug and a preferred program,
 * returns the matching Skill or null.
 */
export type SkillLookupFn = (slug: string, preferProgram?: string) => Skill | null;

/**
 * Resolve all transitive dependencies for a skill.
 *
 * Returns a flat, deduplicated Skill[] (excluding the root skill itself).
 * Handles circular dependencies via a visited set.
 *
 * Slug resolution strategy when no program is specified in the reference:
 *   1. Same program as the referring skill
 *   2. "global" program
 *   3. First match found (any program)
 */
export function resolveDependencies(
  rootSlug: string,
  rootProgram: string,
  lookupFn: SkillLookupFn,
): Skill[] {
  const visited = new Set<string>();
  const result: Skill[] = [];

  // Mark root as visited so we don't include it in results
  visited.add(key(rootSlug, rootProgram));

  // Look up the root skill to get its relatedSkills
  const root = lookupFn(rootSlug, rootProgram);
  if (!root || !root.relatedSkills?.length) return result;

  for (const depSlug of root.relatedSkills) {
    walkDeps(depSlug, rootProgram, lookupFn, visited, result);
  }

  return result;
}

function walkDeps(
  slug: string,
  preferProgram: string,
  lookupFn: SkillLookupFn,
  visited: Set<string>,
  result: Skill[],
): void {
  // Try to find the skill: prefer same program, then global, then any
  let skill = lookupFn(slug, preferProgram);
  if (!skill) skill = lookupFn(slug, "global");
  if (!skill) skill = lookupFn(slug);

  if (!skill) {
    logger.warn("skill-deps", `Dependency "${slug}" not found — skipping`);
    return;
  }

  const k = key(skill.slug, skill.program);
  if (visited.has(k)) return; // cycle or already included
  visited.add(k);

  // Walk this skill's own dependencies first (depth-first, bottom-up order)
  if (skill.relatedSkills?.length) {
    for (const depSlug of skill.relatedSkills) {
      walkDeps(depSlug, skill.program, lookupFn, visited, result);
    }
  }

  // Add after its own deps (bottom-up ordering for publish)
  result.push(skill);
}

function key(slug: string, program: string): string {
  return `${slug}::${program}`;
}
