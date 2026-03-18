#!/usr/bin/env node
/**
 * Ensures Bun is installed before starting the server.
 * Runs via Node.js (guaranteed available from setup).
 * Installs Bun automatically if missing.
 * Usage: node scripts/ensure-bun.mjs
 */
import { execSync, spawnSync } from "node:child_process";
import { platform } from "node:os";

const isWindows = platform() === "win32";

function hasBun() {
  try {
    const result = spawnSync(isWindows ? "bun.exe" : "bun", ["--version"], {
      stdio: "pipe",
      shell: isWindows,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

if (hasBun()) {
  const result = spawnSync(isWindows ? "bun.exe" : "bun", ["--version"], {
    stdio: "pipe",
    shell: isWindows,
  });
  const version = result.stdout?.toString().trim();
  console.log(`[OK] Bun ${version}`);
  process.exit(0);
}

console.log("[!!] Bun not found — installing...");

try {
  if (isWindows) {
    // Try npm first (most reliable on Windows)
    console.log("    Installing via npm...");
    execSync("npm install -g bun", { stdio: "inherit" });
  } else {
    // Unix: use official installer
    console.log("    Installing via bun.sh...");
    execSync("curl -fsSL https://bun.sh/install | bash", {
      stdio: "inherit",
      shell: "/bin/bash",
    });
    // Add to current PATH
    const home = process.env.HOME || process.env.USERPROFILE;
    process.env.PATH = `${home}/.bun/bin:${process.env.PATH}`;
  }
} catch (err) {
  console.error(`[ERR] Failed to install Bun: ${err.message}`);
  console.error("    Install manually: https://bun.sh");
  process.exit(1);
}

// Verify
if (hasBun()) {
  const result = spawnSync(isWindows ? "bun.exe" : "bun", ["--version"], {
    stdio: "pipe",
    shell: isWindows,
  });
  const version = result.stdout?.toString().trim();
  console.log(`[OK] Bun ${version} installed`);
} else {
  console.error("[ERR] Bun installed but not found in PATH.");
  console.error("    You may need to restart your terminal, then try again.");
  process.exit(1);
}
