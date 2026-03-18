/**
 * Kill any process listening on the server port (default 7800).
 * Cross-platform: works on Windows, macOS, and Linux.
 * Always exits 0 so it never blocks the dev script.
 * Usage: bun scripts/kill-port.ts [port]
 */

try {
  const port = parseInt(process.argv[2] || "7800", 10);
  const isWindows = process.platform === "win32";

  const pids = await getPidsOnPort(port, isWindows);

  if (pids.length === 0) {
    // Also try killing by name in case netstat missed orphaned processes
    if (isWindows) await killByNameWindows();
    process.exit(0);
  }

  for (const pid of pids) {
    if (isWindows) {
      await killPidWindows(pid);
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await Bun.sleep(200);
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    console.log(`Killed process ${pid} on port ${port}`);
  }

  // Wait until port is actually free (up to 6s)
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(500);
    const remaining = await getPidsOnPort(port, isWindows);
    if (remaining.length === 0) break;

    // Port still bound — try harder on every other check
    if (i % 2 === 1) {
      for (const pid of remaining) {
        if (isWindows) await killPidWindows(pid);
        else try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  }
} catch {
  // Never fail — this is a best-effort cleanup
}

process.exit(0);

/** Kill a PID on Windows: taskkill first, PowerShell Stop-Process as fallback. */
async function killPidWindows(pid: number) {
  // Attempt 1: taskkill (fast, handles process trees)
  const tk = Bun.spawnSync(["cmd.exe", "/c", `taskkill /F /T /PID ${pid}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const tkOut = new TextDecoder().decode(tk.stderr || new Uint8Array());
  if (tk.exitCode === 0) return;

  // Attempt 2: PowerShell Stop-Process (works across user sessions)
  Bun.spawnSync(
    ["powershell", "-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    { stdout: "pipe", stderr: "pipe" },
  );
}

/** Kill orphaned bun/node server processes by name on Windows. */
async function killByNameWindows() {
  // Kill bun processes that are running the server index file
  Bun.spawnSync(
    ["cmd.exe", "/c", `wmic process where "name='bun.exe' and commandline like '%src/index%'" delete`],
    { stdout: "pipe", stderr: "pipe" },
  );
}

async function getPidsOnPort(
  port: number,
  isWindows: boolean,
): Promise<number[]> {
  try {
    const proc = Bun.spawn(
      isWindows
        ? ["netstat", "-ano", "-p", "TCP"]
        : ["lsof", "-ti", `tcp:${port}`],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (isWindows) {
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) pids.add(pid);
        }
      }

      // Also try PowerShell Get-NetTCPConnection for accuracy
      const ps = Bun.spawnSync(
        ["powershell", "-NoProfile", "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const psOut = new TextDecoder().decode(ps.stdout || new Uint8Array()).trim();
      for (const line of psOut.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 0) pids.add(pid);
      }

      return [...pids];
    } else {
      return stdout
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => n > 0);
    }
  } catch {
    return [];
  }
}
