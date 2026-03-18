import type { Policy } from "../db/policies.repo.js";
import { minimatch } from "minimatch";
import { logger } from "../utils/logger.js";

export interface PolicyViolation {
  policyId: string;
  type: Policy["type"];
  pattern: string;
  action: Policy["action"];
  description: string | null;
  message: string;
}

/** Check prompt content against prompt_filter policies (case-insensitive regex) */
export function checkPromptFilters(
  prompt: string,
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const filters = policies.filter((p) => p.type === "prompt_filter");

  for (const policy of filters) {
    try {
      const regex = new RegExp(policy.pattern, "i");
      if (regex.test(prompt)) {
        violations.push({
          policyId: policy.id,
          type: policy.type,
          pattern: policy.pattern,
          action: policy.action,
          description: policy.description,
          message: `Prompt matches blocked pattern: "${policy.pattern}"${policy.description ? ` (${policy.description})` : ""}`,
        });
      }
    } catch (err) {
      logger.warn("enforcer", `Invalid regex pattern in policy ${policy.id}: "${policy.pattern}" — ${err}`);
    }
  }

  return violations;
}

/** Check command scripts against command_filter policies (case-insensitive regex) */
export function checkCommandScripts(
  commands: { language: string; script: string }[],
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const filters = policies.filter((p) => p.type === "command_filter");

  for (const policy of filters) {
    try {
      const regex = new RegExp(policy.pattern, "i");
      for (const cmd of commands) {
        if (regex.test(cmd.script)) {
          violations.push({
            policyId: policy.id,
            type: policy.type,
            pattern: policy.pattern,
            action: policy.action,
            description: policy.description,
            message: `Command script matches blocked pattern: "${policy.pattern}"${policy.description ? ` (${policy.description})` : ""}`,
          });
          break; // One violation per policy is enough
        }
      }
    } catch (err) {
      logger.warn("enforcer", `Invalid regex pattern in policy ${policy.id}: "${policy.pattern}" — ${err}`);
    }
  }

  return violations;
}

/** Check engine/model against engine_model policies */
export function checkEngineModel(
  engine: string,
  model: string | undefined,
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const restrictions = policies.filter((p) => p.type === "engine_model");

  for (const policy of restrictions) {
    const pattern = policy.pattern.toLowerCase();
    // Pattern formats: "engine" or "engine:model"
    if (pattern.includes(":")) {
      const [eng, mod] = pattern.split(":", 2);
      if (
        engine.toLowerCase() === eng &&
        model?.toLowerCase() === mod
      ) {
        violations.push({
          policyId: policy.id,
          type: policy.type,
          pattern: policy.pattern,
          action: policy.action,
          description: policy.description,
          message: `Engine/model "${engine}:${model}" is blocked${policy.description ? ` (${policy.description})` : ""}`,
        });
      }
    } else {
      if (engine.toLowerCase() === pattern) {
        violations.push({
          policyId: policy.id,
          type: policy.type,
          pattern: policy.pattern,
          action: policy.action,
          description: policy.description,
          message: `Engine "${engine}" is blocked${policy.description ? ` (${policy.description})` : ""}`,
        });
      }
    }
  }

  return violations;
}

/** Check file paths against file_path policies (glob matching) */
export function checkFilePaths(
  paths: string[],
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const fileRules = policies.filter((p) => p.type === "file_path");

  for (const policy of fileRules) {
    for (const filePath of paths) {
      // Normalize to forward slashes for consistent matching
      const normalized = filePath.replace(/\\/g, "/");
      if (minimatch(normalized, policy.pattern, { dot: true })) {
        violations.push({
          policyId: policy.id,
          type: policy.type,
          pattern: policy.pattern,
          action: policy.action,
          description: policy.description,
          message: `File "${filePath}" matches blocked pattern "${policy.pattern}"${policy.description ? ` (${policy.description})` : ""}`,
        });
        break; // One violation per policy is enough
      }
    }
  }

  return violations;
}

/** Get blocked tool names from tool policies */
export function getToolRestrictions(policies: Policy[]): string[] {
  return policies
    .filter((p) => p.type === "tool" && p.action === "block")
    .map((p) => p.pattern);
}

/** Master check for job submission: runs prompt + engine/model checks */
export function validateJobSubmission(
  prompt: string,
  engine: string,
  model: string | undefined,
  policies: Policy[],
): {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: PolicyViolation[];
} {
  const allViolations = [
    ...checkPromptFilters(prompt, policies),
    ...checkEngineModel(engine, model, policies),
  ];

  const violations = allViolations.filter((v) => v.action === "block");
  const warnings = allViolations.filter((v) => v.action === "warn");

  return {
    allowed: violations.length === 0,
    violations,
    warnings,
  };
}
