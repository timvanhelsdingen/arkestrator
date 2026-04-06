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

/**
 * Extract file paths mentioned in a script/command string.
 * Catches Windows paths (D:\foo\bar.ext), Unix paths (/home/...), and quoted paths.
 */
export function extractFilePathsFromScript(script: string): string[] {
  const paths: string[] = [];
  // Windows absolute paths: D:\foo\bar.png, D:/foo/bar.png
  const winRe = /[A-Za-z]:[\\\/][\w\\\/.\-\s]+\.\w+/g;
  // Unix absolute paths: /home/user/file.ext, /tmp/file.ext etc.
  const unixRe = /\/(?:home|tmp|var|opt|usr|mnt|media|root)\/[\w\/.\-\s]+\.\w+/g;
  let m;
  while ((m = winRe.exec(script)) !== null) paths.push(m[0].trim());
  while ((m = unixRe.exec(script)) !== null) paths.push(m[0].trim());
  return paths;
}

/** Check a script/command string for file paths that violate file_path policies */
export function checkScriptFilePaths(
  script: string,
  policies: Policy[],
): PolicyViolation[] {
  const paths = extractFilePathsFromScript(script);
  if (paths.length === 0) return [];
  return checkFilePaths(paths, policies);
}

/** Get blocked tool names from tool policies */
export function getToolRestrictions(policies: Policy[]): string[] {
  return policies
    .filter((p) => p.type === "tool" && p.action === "block")
    .map((p) => p.pattern);
}

/** Check if the number of running jobs exceeds concurrent_limit policies */
export function checkConcurrentLimit(
  runningJobCount: number,
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const limits = policies.filter((p) => p.type === "concurrent_limit");

  for (const policy of limits) {
    const limit = parseInt(policy.pattern, 10);
    if (isNaN(limit) || limit < 0) continue;
    if (runningJobCount >= limit) {
      violations.push({
        policyId: policy.id,
        type: policy.type,
        pattern: policy.pattern,
        action: policy.action,
        description: policy.description,
        message: `Concurrent job limit reached: ${runningJobCount}/${limit}${policy.description ? ` (${policy.description})` : ""}`,
      });
    }
  }

  return violations;
}

/** Resolve the most restrictive process priority from process_priority policies.
 *  Returns a priority level string or null if no policy applies. */
export type ProcessPriorityLevel = "low" | "below_normal" | "normal" | "above_normal" | "high";

const PRIORITY_ORDER: ProcessPriorityLevel[] = ["low", "below_normal", "normal", "above_normal", "high"];

export function resolveProcessPriority(policies: Policy[]): ProcessPriorityLevel | null {
  const priorityPolicies = policies.filter((p) => p.type === "process_priority");
  if (priorityPolicies.length === 0) return null;

  let lowestIdx = PRIORITY_ORDER.length;
  for (const policy of priorityPolicies) {
    const idx = PRIORITY_ORDER.indexOf(policy.pattern as ProcessPriorityLevel);
    if (idx >= 0 && idx < lowestIdx) {
      lowestIdx = idx;
    }
  }

  return lowestIdx < PRIORITY_ORDER.length ? PRIORITY_ORDER[lowestIdx] : null;
}

/** Check token usage against token_budget policies.
 *  Pattern format: "input:500000" | "output:100000" | "total:600000" */
export function checkTokenBudget(
  usedInputTokens: number,
  usedOutputTokens: number,
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const budgets = policies.filter((p) => p.type === "token_budget");

  for (const policy of budgets) {
    const [kind, limitStr] = policy.pattern.split(":");
    const limit = parseInt(limitStr, 10);
    if (isNaN(limit)) continue;

    let used = 0;
    let label = "";
    if (kind === "input") {
      used = usedInputTokens;
      label = "input tokens";
    } else if (kind === "output") {
      used = usedOutputTokens;
      label = "output tokens";
    } else if (kind === "total") {
      used = usedInputTokens + usedOutputTokens;
      label = "total tokens";
    } else {
      continue;
    }

    if (used >= limit) {
      violations.push({
        policyId: policy.id,
        type: policy.type,
        pattern: policy.pattern,
        action: policy.action,
        description: policy.description,
        message: `Token budget exceeded: ${used.toLocaleString()} ${label} used (limit: ${limit.toLocaleString()})${policy.description ? ` (${policy.description})` : ""}`,
      });
    }
  }

  return violations;
}

/** Check cost against cost_budget policies.
 *  Pattern is the max cost in USD, e.g. "5.00" */
export function checkCostBudget(
  usedCostUsd: number,
  policies: Policy[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const budgets = policies.filter((p) => p.type === "cost_budget");

  for (const policy of budgets) {
    const limit = parseFloat(policy.pattern);
    if (isNaN(limit)) continue;

    if (usedCostUsd >= limit) {
      violations.push({
        policyId: policy.id,
        type: policy.type,
        pattern: policy.pattern,
        action: policy.action,
        description: policy.description,
        message: `Cost budget exceeded: $${usedCostUsd.toFixed(2)} used (limit: $${limit.toFixed(2)})${policy.description ? ` (${policy.description})` : ""}`,
      });
    }
  }

  return violations;
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
