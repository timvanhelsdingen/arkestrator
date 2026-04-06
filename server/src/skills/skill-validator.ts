/**
 * Skill validation and dry-run/preview utilities.
 *
 * Validates skill definitions for common issues:
 * - Invalid regex patterns in keywords
 * - Empty content
 * - Missing required fields
 * - Related skills referencing non-existent skills
 */

import type { Skill } from "../db/skills.repo.js";

export interface ValidationIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Related skill slugs that were stripped because they don't exist. */
  strippedRelatedSkills?: string[];
}

/** Resolver function that checks whether a skill slug exists. */
export type SkillExistsResolver = (slug: string) => boolean;

/**
 * Validate a skill definition for common issues.
 *
 * If `skillExists` is provided, validates that all relatedSkills references
 * point to existing skills. Invalid references are reported as warnings and
 * listed in `strippedRelatedSkills` so callers can remove them before saving.
 */
export function validateSkill(
  skill: Partial<Skill>,
  skillExists?: SkillExistsResolver,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const strippedRelatedSkills: string[] = [];

  // Check content
  const content = String(skill.content ?? "").trim();
  if (!content) {
    issues.push({ field: "content", severity: "error", message: "Skill content is empty" });
  } else if (content.length < 10) {
    issues.push({ field: "content", severity: "warning", message: "Skill content is very short (< 10 chars)" });
  }

  // Check title
  if (!String(skill.title ?? "").trim()) {
    issues.push({ field: "title", severity: "error", message: "Skill title is empty" });
  }

  // Check slug
  if (!String(skill.slug ?? "").trim()) {
    issues.push({ field: "slug", severity: "error", message: "Skill slug is empty" });
  }

  // Check category
  if (!String(skill.category ?? "").trim()) {
    issues.push({ field: "category", severity: "warning", message: "Skill category is empty" });
  }

  // Validate regex patterns in keywords
  const keywords = Array.isArray(skill.keywords) ? skill.keywords : [];
  for (const keyword of keywords) {
    const kw = String(keyword ?? "").trim();
    if (!kw) continue;
    // Check if it looks like a regex pattern (contains regex metacharacters)
    if (/[\\^$.*+?()[\]{}|]/.test(kw)) {
      try {
        new RegExp(kw, "i");
      } catch (err: any) {
        issues.push({
          field: "keywords",
          severity: "error",
          message: `Invalid regex pattern "${kw}": ${err?.message ?? "syntax error"}`,
        });
      }
    }
  }

  // Check for contradictory instructions
  const contentLower = content.toLowerCase();
  const contradictions = [
    { pair: ["always use", "never use"], desc: "always/never contradiction" },
    { pair: ["must include", "must not include"], desc: "include/exclude contradiction" },
    { pair: ["enable", "disable"], desc: "enable/disable in same sentence" },
  ];
  for (const { pair, desc } of contradictions) {
    if (pair.every((p) => contentLower.includes(p))) {
      issues.push({
        field: "content",
        severity: "warning",
        message: `Possible ${desc} detected — review content for clarity`,
      });
    }
  }

  // Validate related skills references exist
  if (skillExists) {
    const related = Array.isArray(skill.relatedSkills) ? skill.relatedSkills : [];
    for (const ref of related) {
      const slug = String(ref ?? "").trim();
      if (!slug) continue;
      if (!skillExists(slug)) {
        strippedRelatedSkills.push(slug);
        issues.push({
          field: "relatedSkills",
          severity: "warning",
          message: `Related skill "${slug}" does not exist and will be removed`,
        });
      }
    }
  }

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    issues,
    strippedRelatedSkills: strippedRelatedSkills.length > 0 ? strippedRelatedSkills : undefined,
  };
}

/**
 * Preview what a skill would inject into a job's orchestrator prompt.
 * Mirrors the injection logic in spawner.ts.
 */
export function previewSkillInjection(
  skill: Skill,
  jobProgram?: string,
): { injected: boolean; preview: string; reason: string } {
  const sp = skill.program.trim().toLowerCase();
  const jp = (jobProgram ?? "").trim().toLowerCase();

  // Check if skill matches the job program
  const isGlobal = !sp || sp === "global";
  const matchesProgram = jp && sp === jp;

  if (!isGlobal && !matchesProgram) {
    return {
      injected: false,
      preview: "",
      reason: `Skill program "${skill.program}" does not match job program "${jobProgram ?? "(none)"}". Only global skills or program-matched skills are injected.`,
    };
  }

  if (!skill.enabled) {
    return {
      injected: false,
      preview: "",
      reason: "Skill is disabled.",
    };
  }

  // Build the injection preview (mirrors spawner.ts lines 1451-1475)
  const lines: string[] = [];
  lines.push(`### ${skill.title} [${skill.program}]`);
  if (skill.description) lines.push(skill.description);
  lines.push("");
  lines.push(skill.content);

  return {
    injected: true,
    preview: lines.join("\n"),
    reason: isGlobal ? "Global skill — injected for all programs." : `Matches job program "${jp}".`,
  };
}
