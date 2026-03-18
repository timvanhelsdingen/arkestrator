import { existsSync } from "fs";
import { join } from "path";

export interface SpawnUserSpec {
  username: string;
  preserveEnvironment?: boolean;
}

export interface SpawnWithFallbackOptions extends Parameters<typeof Bun.spawn>[1] {
  runAsUser?: SpawnUserSpec;
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
