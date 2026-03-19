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

  test("allows skip-permissions when UID is undefined (Windows)", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: undefined,
    })).toEqual({
      allowSkipPermissionsFlag: true,
    });
  });

  // --- New: fallback chain & root-without-drop-user ---

  test("tries fallback users when bun is not available", () => {
    // Simulate: bun missing, node exists, runuser available
    const result = getClaudeRuntimeDecision({
      currentUid: 0,
      hasRunuser: true,
      fallbackUsers: ["bun", "node", "nobody"],
      // hasBunUser not set — uses new fallback path
    });
    // Will depend on /etc/passwd — but the code path is tested via dropUser below
    expect(result.allowSkipPermissionsFlag).toBe(true);
  });

  test("uses explicit dropUser when provided", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasRunuser: true,
      dropUser: "customuser",
      // customuser won't exist in /etc/passwd on most machines, so runAsUser won't be set
      // but allowSkipPermissionsFlag must still be true (root fallback)
    })).toMatchObject({
      allowSkipPermissionsFlag: true,
    });
  });

  test("still allows skip-permissions when root without any drop user (headless safety)", () => {
    // This is the critical fix: root + no bun user + no runuser → MUST still allow flag.
    // Without it, claude-code is completely non-functional (bwrap fails, stdin "ignore" hangs).
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasBunUser: false,
      hasRunuser: false,
    })).toEqual({
      allowSkipPermissionsFlag: true,
    });
  });

  test("still allows skip-permissions when root with runuser but no known users", () => {
    expect(getClaudeRuntimeDecision({
      currentUid: 0,
      hasRunuser: true,
      fallbackUsers: [], // empty list — no candidates
    })).toEqual({
      allowSkipPermissionsFlag: true,
    });
  });

  test("root with runuser but no bun user falls through to fallback chain", () => {
    // hasBunUser explicitly false triggers legacy path then falls to new logic
    const result = getClaudeRuntimeDecision({
      currentUid: 0,
      hasBunUser: false,
      hasRunuser: true,
      fallbackUsers: [], // no candidates in fallback
    });
    // Should still allow the flag (root safety net)
    expect(result.allowSkipPermissionsFlag).toBe(true);
  });
});
