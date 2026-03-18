import { describe, test, expect, beforeEach } from "bun:test";
import { createTestDb, type TestContext } from "./setup";
import {
  checkPromptFilters,
  checkEngineModel,
  checkFilePaths,
  checkCommandScripts,
  getToolRestrictions,
  validateJobSubmission,
} from "../policies/enforcer";
import type { Policy } from "../db/policies.repo";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

/** Helper to create a mock policy object. */
function makePolicy(
  overrides: Partial<Policy> & { type: Policy["type"]; pattern: string },
): Policy {
  return {
    id: "policy-" + Math.random().toString(36).slice(2),
    scope: "global",
    userId: null,
    action: "block",
    description: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("checkPromptFilters", () => {
  test("blocks matching prompt regex", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "rm -rf" }),
    ];
    const violations = checkPromptFilters("please rm -rf /tmp", policies);
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("block");
  });

  test("passes non-matching prompt", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "DROP TABLE" }),
    ];
    const violations = checkPromptFilters("add a health bar", policies);
    expect(violations).toHaveLength(0);
  });

  test("case-insensitive matching", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "delete" }),
    ];
    const violations = checkPromptFilters("DELETE everything", policies);
    expect(violations).toHaveLength(1);
  });

  test("handles invalid regex gracefully", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "[invalid" }),
    ];
    // Should not throw, just skip the invalid pattern
    const violations = checkPromptFilters("test prompt", policies);
    expect(violations).toHaveLength(0);
  });

  test("ignores non-prompt_filter policies", () => {
    const policies = [
      makePolicy({ type: "engine_model", pattern: "codex" }),
    ];
    const violations = checkPromptFilters("anything", policies);
    expect(violations).toHaveLength(0);
  });

  test("warn action reports but does not block", () => {
    const policies = [
      makePolicy({
        type: "prompt_filter",
        pattern: "warning",
        action: "warn",
      }),
    ];
    const violations = checkPromptFilters("this is a warning", policies);
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("warn");
  });
});

describe("checkEngineModel", () => {
  test("blocks matching engine", () => {
    const policies = [
      makePolicy({ type: "engine_model", pattern: "local-oss" }),
    ];
    const violations = checkEngineModel("local-oss", undefined, policies);
    expect(violations).toHaveLength(1);
  });

  test("passes non-matching engine", () => {
    const policies = [
      makePolicy({ type: "engine_model", pattern: "codex" }),
    ];
    const violations = checkEngineModel("claude-code", undefined, policies);
    expect(violations).toHaveLength(0);
  });

  test("blocks matching engine:model", () => {
    const policies = [
      makePolicy({
        type: "engine_model",
        pattern: "claude-code:claude-3-haiku",
      }),
    ];
    const violations = checkEngineModel(
      "claude-code",
      "claude-3-haiku",
      policies,
    );
    expect(violations).toHaveLength(1);
  });

  test("passes different model for same engine", () => {
    const policies = [
      makePolicy({
        type: "engine_model",
        pattern: "claude-code:claude-3-haiku",
      }),
    ];
    const violations = checkEngineModel(
      "claude-code",
      "claude-3-opus",
      policies,
    );
    expect(violations).toHaveLength(0);
  });

  test("case-insensitive matching", () => {
    const policies = [
      makePolicy({ type: "engine_model", pattern: "CLAUDE-CODE" }),
    ];
    const violations = checkEngineModel("claude-code", undefined, policies);
    expect(violations).toHaveLength(1);
  });
});

describe("checkFilePaths", () => {
  test("blocks matching glob pattern", () => {
    const policies = [makePolicy({ type: "file_path", pattern: "*.env" })];
    const violations = checkFilePaths([".env", "config.json"], policies);
    expect(violations).toHaveLength(1);
  });

  test("passes non-matching paths", () => {
    const policies = [makePolicy({ type: "file_path", pattern: "*.env" })];
    const violations = checkFilePaths(["main.ts", "app.js"], policies);
    expect(violations).toHaveLength(0);
  });

  test("matches nested paths", () => {
    const policies = [
      makePolicy({ type: "file_path", pattern: "**/.env*" }),
    ];
    const violations = checkFilePaths(
      ["src/.env.local", "config.json"],
      policies,
    );
    expect(violations).toHaveLength(1);
  });

  test("normalizes backslashes to forward slashes", () => {
    const policies = [
      makePolicy({ type: "file_path", pattern: "**/*.secret" }),
    ];
    const violations = checkFilePaths(["path\\to\\file.secret"], policies);
    expect(violations).toHaveLength(1);
  });
});

describe("checkCommandScripts", () => {
  test("blocks matching command script", () => {
    const policies = [
      makePolicy({ type: "command_filter", pattern: "os\\.system" }),
    ];
    const commands = [
      { language: "python", script: 'os.system("rm -rf /")' },
    ];
    const violations = checkCommandScripts(commands, policies);
    expect(violations).toHaveLength(1);
  });

  test("passes non-matching scripts", () => {
    const policies = [
      makePolicy({ type: "command_filter", pattern: "os\\.system" }),
    ];
    const commands = [
      { language: "python", script: "print('hello')" },
    ];
    const violations = checkCommandScripts(commands, policies);
    expect(violations).toHaveLength(0);
  });

  test("case-insensitive matching", () => {
    const policies = [
      makePolicy({ type: "command_filter", pattern: "EVAL" }),
    ];
    const commands = [
      { language: "gdscript", script: "eval(user_input)" },
    ];
    const violations = checkCommandScripts(commands, policies);
    expect(violations).toHaveLength(1);
  });
});

describe("getToolRestrictions", () => {
  test("extracts blocked tool names", () => {
    const policies = [
      makePolicy({ type: "tool", pattern: "Bash", action: "block" }),
      makePolicy({ type: "tool", pattern: "Write", action: "block" }),
      makePolicy({ type: "tool", pattern: "Read", action: "warn" }),
    ];
    const restrictions = getToolRestrictions(policies);
    expect(restrictions).toContain("Bash");
    expect(restrictions).toContain("Write");
    expect(restrictions).not.toContain("Read"); // warn, not block
  });

  test("returns empty array with no tool policies", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "test" }),
    ];
    const restrictions = getToolRestrictions(policies);
    expect(restrictions).toHaveLength(0);
  });
});

describe("validateJobSubmission", () => {
  test("allows clean submission", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "dangerous" }),
      makePolicy({ type: "engine_model", pattern: "local-oss" }),
    ];
    const result = validateJobSubmission(
      "add a health bar",
      "claude-code",
      undefined,
      policies,
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("blocks on prompt violation", () => {
    const policies = [
      makePolicy({ type: "prompt_filter", pattern: "dangerous" }),
    ];
    const result = validateJobSubmission(
      "do something dangerous",
      "claude-code",
      undefined,
      policies,
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  test("blocks on engine violation", () => {
    const policies = [
      makePolicy({ type: "engine_model", pattern: "local-oss" }),
    ];
    const result = validateJobSubmission(
      "innocent prompt",
      "local-oss",
      undefined,
      policies,
    );
    expect(result.allowed).toBe(false);
  });

  test("separates warnings from violations", () => {
    const policies = [
      makePolicy({
        type: "prompt_filter",
        pattern: "flagged",
        action: "warn",
      }),
      makePolicy({
        type: "prompt_filter",
        pattern: "blocked",
        action: "block",
      }),
    ];
    const result = validateJobSubmission(
      "this is flagged and blocked",
      "claude-code",
      undefined,
      policies,
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("Policy CRUD via repo", () => {
  test("creates and retrieves a policy", () => {
    const policy = ctx.policiesRepo.create({
      scope: "global",
      type: "prompt_filter",
      pattern: "test",
    });
    expect(policy.id).toBeTruthy();
    expect(policy.type).toBe("prompt_filter");
    expect(policy.enabled).toBe(true);

    const found = ctx.policiesRepo.getById(policy.id);
    expect(found).toBeTruthy();
    expect(found!.pattern).toBe("test");
  });

  test("getEffectiveForUser returns enabled global policies", () => {
    ctx.policiesRepo.create({
      scope: "global",
      type: "prompt_filter",
      pattern: "blocked",
    });

    const effective = ctx.policiesRepo.getEffectiveForUser(null);
    expect(effective.length).toBeGreaterThanOrEqual(1);
    expect(effective.some((p) => p.pattern === "blocked")).toBe(true);
  });

  test("toggling a policy disables it", () => {
    const policy = ctx.policiesRepo.create({
      scope: "global",
      type: "prompt_filter",
      pattern: "test",
    });

    ctx.policiesRepo.toggle(policy.id, false);
    const updated = ctx.policiesRepo.getById(policy.id);
    expect(updated!.enabled).toBe(false);

    // Disabled policies should not appear in effective
    const effective = ctx.policiesRepo.getEffectiveForUser(null);
    expect(effective.some((p) => p.id === policy.id)).toBe(false);
  });
});
