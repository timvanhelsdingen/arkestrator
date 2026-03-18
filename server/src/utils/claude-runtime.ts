import { existsSync, readFileSync } from "node:fs";
import type { SpawnUserSpec } from "./spawn.js";

export interface ClaudeRuntimeDecision {
  allowSkipPermissionsFlag: boolean;
  runAsUser?: SpawnUserSpec;
}

interface ClaudeRuntimeDetectionOptions {
  currentUid?: number | undefined;
  hasBunUser?: boolean | undefined;
  hasRunuser?: boolean | undefined;
}

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
 * TrueNAS), we auto-drop the subprocess to the `bun` user via `runuser`
 * so that the flag is accepted.
 *
 * When running as non-root (or on Windows where getuid is unavailable),
 * the flag is allowed without any privilege change.
 */
export function getClaudeRuntimeDecision(
  options: ClaudeRuntimeDetectionOptions = {},
): ClaudeRuntimeDecision {
  const currentUid = options.currentUid ?? getCurrentUid();
  if (currentUid === undefined || currentUid !== 0) {
    return { allowSkipPermissionsFlag: true };
  }

  // Running as root — try to drop to `bun` user so skip-permissions works.
  const hasBunUser = options.hasBunUser ?? hasUnixUser("bun");
  const hasRunuser = options.hasRunuser ?? hasRunuserBinary();
  if (hasBunUser && hasRunuser) {
    return {
      allowSkipPermissionsFlag: true,
      runAsUser: { username: "bun", preserveEnvironment: true },
    };
  }

  // Root without bun user or runuser — cannot use the flag.
  return { allowSkipPermissionsFlag: false };
}
