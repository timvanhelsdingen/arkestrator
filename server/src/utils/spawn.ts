import { existsSync } from "fs";
import { join } from "path";

export interface SpawnUserSpec {
  username: string;
  preserveEnvironment?: boolean;
}

export interface SpawnWithFallbackOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: any;
  stdout?: any;
  stderr?: any;
  onExit?: (...args: any[]) => void;
  runAsUser?: SpawnUserSpec;
  [key: string]: any;
}

function hasExplicitExtension(command: string): boolean {
  // Treat paths with an extension as explicit executables/scripts.
  return /\.[^\\/]+$/.test(command);
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function isCommandNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as any).code;
  const message = String((err as any).message ?? "");
  return (
    code === "ENOENT" ||
    message.includes("ENOENT") ||
    message.includes("Executable not found") ||
    message.includes("not found in $PATH")
  );
}

export function getSpawnCandidates(command: string): string[] {
  if (process.platform !== "win32") return [command];
  if (isPathLike(command) || hasExplicitExtension(command)) return [command];
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

/**
 * Search common CLI tool install locations that may not be in the server
 * process's inherited PATH (e.g. when launched as a Tauri sidecar rather
 * than from a user shell).
 */
function findPlatformFallback(command: string): string | null {
  if (isPathLike(command)) return null;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const userProfile = process.env.USERPROFILE ?? "";

    const searchDirs = [
      join(appData, "npm"),
      join(userProfile, "AppData", "Roaming", "npm"),
      join(localAppData, "Programs", command),
      join(localAppData, "pnpm"),
      join(userProfile, ".bun", "bin"),
      join(userProfile, ".local", "bin"),
    ].filter(Boolean);

    const extensions = [".cmd", ".exe", ".bat", ""];
    for (const dir of searchDirs) {
      for (const ext of extensions) {
        const fullPath = join(dir, `${command}${ext}`);
        if (existsSync(fullPath)) return fullPath;
      }
    }
    return null;
  }

  // macOS / Linux: Tauri sidecars inherit a minimal PATH that typically
  // excludes Homebrew, bun, nvm, npm global, pnpm, and cargo bin dirs.
  const home = process.env.HOME ?? "";
  if (!home) return null;

  const searchDirs = [
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".nvm", "current", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".pnpm", "bin"),
    join(home, ".cargo", "bin"),
  ];

  for (const dir of searchDirs) {
    const fullPath = join(dir, command);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

export function spawnWithFallback(
  command: string,
  args: string[],
  options: SpawnWithFallbackOptions,
) {
  const { runAsUser, ...spawnOptions } = options;
  const candidates = getSpawnCandidates(command);
  let lastErr: unknown;

  for (const candidate of candidates) {
    try {
      const proc = Bun.spawn(buildSpawnArgv(candidate, args, runAsUser), spawnOptions);
      return { proc, resolvedCommand: candidate };
    } catch (err) {
      lastErr = err;
      if (!isCommandNotFoundError(err)) {
        throw err;
      }
    }
  }

  // Try common install locations not always in the server's PATH
  // (Tauri sidecars, Docker containers, etc.)
  const fallback = findPlatformFallback(command);
  if (fallback) {
    try {
      const proc = Bun.spawn(buildSpawnArgv(fallback, args, runAsUser), spawnOptions);
      return { proc, resolvedCommand: fallback };
    } catch (err) {
      if (!isCommandNotFoundError(err)) throw err;
      lastErr = err;
    }
  }

  throw lastErr ?? new Error(`Failed to spawn command: ${command}`);
}

function findRunuserCommand(): string | null {
  if (process.platform === "win32") return null;
  const candidates = ["/usr/sbin/runuser", "/usr/bin/runuser"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildSpawnArgv(
  command: string,
  args: string[],
  runAsUser?: SpawnUserSpec,
): string[] {
  if (!runAsUser?.username) return [command, ...args];

  const runuser = findRunuserCommand();
  if (!runuser) return [command, ...args];

  const argv = [runuser, "-u", runAsUser.username];
  if (runAsUser.preserveEnvironment !== false) {
    argv.push("-m");
  }
  argv.push("--", command, ...args);
  return argv;
}

export type ProcessPriorityLevel = "low" | "below_normal" | "normal" | "above_normal" | "high";

/**
 * Apply a process priority level to a running process (best-effort).
 * On Windows: uses wmic. On Unix: uses renice.
 * Returns true if applied, false if failed (never throws).
 */
export async function applyProcessPriority(
  pid: number,
  level: ProcessPriorityLevel,
): Promise<boolean> {
  if (level === "normal") return true; // No-op for normal priority

  try {
    if (process.platform === "win32") {
      // Windows priority classes: idle=64, below_normal=16384, normal=32, above_normal=32768, high=128
      const priorityMap: Record<string, string> = {
        low: "64",           // IDLE
        below_normal: "16384", // BELOW_NORMAL
        above_normal: "32768", // ABOVE_NORMAL
        high: "128",          // HIGH
      };
      const priorityClass = priorityMap[level];
      if (!priorityClass) return false;
      const proc = Bun.spawn(["wmic", "process", "where", `ProcessId=${pid}`, "CALL", "setpriority", priorityClass], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      return proc.exitCode === 0;
    } else {
      // Unix: renice -n <value> -p <pid>
      const niceMap: Record<string, string> = {
        low: "19",          // Lowest priority
        below_normal: "10", // Below normal
        above_normal: "-5", // Above normal (may need root)
        high: "-10",        // High (may need root)
      };
      const niceValue = niceMap[level];
      if (!niceValue) return false;
      const proc = Bun.spawn(["renice", "-n", niceValue, "-p", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }
  } catch {
    return false;
  }
}
