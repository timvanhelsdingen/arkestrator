/**
 * Reset local dev state for Arkestrator.
 *
 * Actions:
 * - Kill listeners on default dev ports (7800 server, 5173 client)
 * - Remove server data directory (server/data)
 * - Remove shared bridge config (~/.arkestrator/config.json)
 *
 * Usage:
 *   bun scripts/reset-state.ts
 *   bun scripts/reset-state.ts --dry-run
 */

import { existsSync, readdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ports = [7800, 5173];
const isWindows = process.platform === "win32";
const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log(`[reset] Starting reset${dryRun ? " (dry-run)" : ""}...`);

  for (const port of ports) {
    await killPort(port);
  }

  const dataDir = join(import.meta.dir, "..", "data");
  if (existsSync(dataDir)) {
    let removed = true;
    if (!dryRun) {
      removed = await removeDirBestEffort(dataDir);
      if (!removed) {
        console.log(
          `[reset] Could not fully remove ${dataDir} (locked). Continue after closing file handles/processes.`,
        );
      }
    }
    console.log(
      `[reset] ${
        dryRun ? "Would remove" : removed ? "Removed" : "Skipped (locked)"
      } ${dataDir}`,
    );
  } else {
    console.log(`[reset] No data dir found at ${dataDir}`);
  }

  const sharedConfigPaths = [join(homedir(), ".arkestrator", "config.json")];
  for (const sharedConfigPath of sharedConfigPaths) {
    if (!existsSync(sharedConfigPath)) {
      console.log(`[reset] No shared config found at ${sharedConfigPath}`);
      continue;
    }
    if (!dryRun) {
      unlinkSync(sharedConfigPath);
    }
    console.log(
      `[reset] ${dryRun ? "Would remove" : "Removed"} ${sharedConfigPath}`,
    );
  }

  const sharedDirs = [join(homedir(), ".arkestrator")];
  for (const sharedDir of sharedDirs) {
    if (existsSync(sharedDir)) {
      const entries = readdirSync(sharedDir);
      if (entries.length === 0) {
        if (!dryRun) {
          rmSync(sharedDir, { recursive: true, force: true });
        }
        console.log(
          `[reset] ${dryRun ? "Would remove" : "Removed"} empty dir ${sharedDir}`,
        );
      }
    }
  }

  console.log("[reset] Done.");
}

async function killPort(port: number) {
  const pids = await getPidsOnPort(port);
  if (pids.length === 0) {
    console.log(`[reset] Port ${port} already free`);
    return;
  }

  for (const pid of pids) {
    if (dryRun) {
      console.log(`[reset] Would kill PID ${pid} on port ${port}`);
      continue;
    }

    try {
      if (isWindows) {
        // /T kills the full process tree for watch/dev runners.
        Bun.spawnSync(["cmd.exe", "/c", `taskkill /F /T /PID ${pid}`], {
          stdout: "pipe",
          stderr: "pipe",
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
      console.log(`[reset] Killed PID ${pid} on port ${port}`);
    } catch {
      console.log(`[reset] Failed to kill PID ${pid} on port ${port}`);
    }
  }

  if (dryRun) return;

  for (let i = 0; i < 10; i++) {
    await Bun.sleep(300);
    const remaining = await getPidsOnPort(port);
    if (remaining.length === 0) {
      console.log(`[reset] Port ${port} is free`);
      return;
    }
  }
  console.log(`[reset] Port ${port} still appears busy`);
}

async function removeDirBestEffort(dirPath: string): Promise<boolean> {
  try {
    rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    if (err?.code !== "EBUSY" && err?.code !== "EPERM") {
      console.log(`[reset] Failed to remove ${dirPath}: ${err?.message ?? err}`);
      return false;
    }
  }

  // Windows can keep sqlite/db files locked briefly; retry a few times.
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(400);
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch (err: any) {
      if (i === 5) {
        console.log(`[reset] Remove retry failed for ${dirPath}: ${err?.message ?? err}`);
        return false;
      }
    }
  }

  return false;
}

async function getPidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(
      isWindows
        ? ["netstat", "-ano", "-p", "TCP"]
        : ["lsof", "-ti", `tcp:${port}`],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!isWindows) {
      return stdout
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => n > 0);
    }

    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

await main();
