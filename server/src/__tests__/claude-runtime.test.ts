import { describe, expect, test } from "bun:test";
import { getClaudeRuntimeDecision } from "../utils/claude-runtime.js";

describe("getClaudeRuntimeDecision", () => {
  test("allows skip-permissions for normal non-root runs", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 1000,
    })).toEqual({
      allowSkipPermissionsFlag: true,
    });
  });

  test("drops to bun user when running as root with bun user and runuser available", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasBunUser: true,
      hasRunuser: true,
    })).toEqual({
      allowSkipPermissionsFlag: true,
      runAsUser: { username: "bun", preserveEnvironment: true },
    });
  });

  test("disallows skip-permissions when root without bun user", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasBunUser: false,
      hasRunuser: true,
    })).toEqual({
      allowSkipPermissionsFlag: false,
    });
  });

  test("disallows skip-permissions when root without runuser", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasBunUser: true,
      hasRunuser: false,
    })).toEqual({
      allowSkipPermissionsFlag: false,
    });
  });

  test("allows skip-permissions when UID is undefined (Windows)", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: undefined,
    })).toEqual({
      allowSkipPermissionsFlag: true,
    });
  });
});
