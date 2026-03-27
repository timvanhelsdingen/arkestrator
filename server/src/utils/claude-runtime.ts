import { existsSync, readFileSync } from "node:fs";
import type { SpawnUserSpec } from "./spawn.js";

export interface ClaudeRuntimeDecision {
  allowSkipPermissionsFlag: boolean;
  runAsUser?: SpawnUserSpec;
}

interface ClaudeRuntimeDetectionOptions {
  currentUid?: number | undefined;
  /** Explicit user to drop to (overrides auto-detection). */
  dropUser?: string | undefined;
  /** @deprecated Use dropUser instead. Kept for backward-compat in tests. */
  hasBunUser?: boolean | undefined;
  hasRunuser?: boolean | undefined;
  /** Override the list of fallback users tried when dropUser is not set. */
  fallbackUsers?: string[] | undefined;
}

/** Default ordered list of non-root users we try when no explicit dropUser is configured. */
const DEFAULT_FALLBACK_USERS = ["bun", "node", "nobody"];

function getCurrentUid(): number | undefined {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return undefined;
  return getuid();
}

function hasUnixUser(username: string): boolean {
  try {
    const passwd = readFileSync("/etc/passwd", "utf-8");
    return passwd.split(/\r?\n/).some((line) => line.startsWith(`${username}:`));
  } catch {
    return false;
  }
}

function hasRunuserBinary(): boolean {
  return existsSync("/usr/sbin/runuser") || existsSync("/usr/bin/runuser");
}

/**
 * Decide how Claude CLI should be launched.
 *
 * Claude CLI rejects `--dangerously-skip-permissions` when running as
 * root/sudo.  When the server itself runs as root (common in Docker on
 * TrueNAS), we auto-drop the subprocess to a non-root user via `runuser`
 * so that the flag is accepted.
 *
 * Drop-user resolution order:
 * 1. Explicit `dropUser` option (from server settings)
 * 2. Fallback chain: bun → node → nobody
 * 3. If NO suitable user found: still allow the flag but skip runAsUser.
 *    Without `--dangerously-skip-permissions`, claude-code is completely
 *    non-functional in headless mode (stdin is "ignore", permission prompts
 *    hang forever, and bwrap sandbox fails in restricted containers).
 *
 * When running as non-root (or on Windows where getuid is unavailable),
 * the flag is allowed without any privilege change.
 */
export function getClaudeRuntimeDecision(
  options: ClaudeRuntimeDetectionOptions = {},
): ClaudeRuntimeDecision {
  const currentUid = "currentUid" in options ? options.currentUid : getCurrentUid();
  if (currentUid === undefined || currentUid !== 0) {
    return { allowSkipPermissionsFlag: true };
  }

  // Running as root — try to find a non-root user to drop to.
  const hasRunuser = options.hasRunuser ?? hasRunuserBinary();

  // Legacy compat: if hasBunUser was explicitly passed (tests), honour it.
  if (options.hasBunUser !== undefined) {
    if (options.hasBunUser && hasRunuser) {
      return {
        allowSkipPermissionsFlag: true,
        runAsUser: { username: "bun", preserveEnvironment: true },
      };
    }
    // Legacy path: hasBunUser explicitly false — fall through to new logic.
  }

  if (hasRunuser) {
    // Try explicit dropUser first, then fallback chain.
    const candidates = options.dropUser
      ? [options.dropUser]
      : (options.fallbackUsers ?? DEFAULT_FALLBACK_USERS);

    for (const user of candidates) {
      if (hasUnixUser(user)) {
        return {
          allowSkipPermissionsFlag: true,
          runAsUser: { username: user, preserveEnvironment: true },
        };
      }
    }
  }

  // Root without any suitable drop user or without runuser.
  // Still allow the flag — without it, claude-code cannot function at all
  // in headless mode (bwrap fails in restricted containers, permission
  // prompts hang on stdin "ignore").  The subprocess will run as root with
  // --dangerously-skip-permissions; Claude CLI may warn but will proceed.
  return { allowSkipPermissionsFlag: true };
}
