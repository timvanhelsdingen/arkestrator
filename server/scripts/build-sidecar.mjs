#!/usr/bin/env node
/**
 * Compiles the server into a standalone Bun binary for use as a Tauri sidecar.
 * Outputs to client/src-tauri/binaries/ with the correct platform triple naming.
 *
 * Usage: node scripts/build-sidecar.mjs
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverDir = resolve(__dirname, "..");
const binariesDir = resolve(serverDir, "../client/src-tauri/binaries");

/** Get the Rust target triple for the current platform */
function getTargetTriple() {
  // Try rustc first (most accurate)
  try {
    const cmd = platform() === "win32" ? "rustc.exe" : "rustc";
    const result = spawnSync(cmd, ["--print", "host-tuple"], {
      stdio: "pipe",
    });
    if (result.status === 0) {
      return result.stdout.toString().trim();
    }
  } catch {}

  // Fallback: manual detection
  const p = platform();
  const a = arch();

  const map = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };

  const key = `${p}-${a}`;
  const triple = map[key];
  if (!triple) {
    console.error(`[ERR] Unsupported platform: ${key}`);
    process.exit(1);
  }
  return triple;
}

const triple = getTargetTriple();
const isWindows = platform() === "win32";
const ext = isWindows ? ".exe" : "";
const outName = `arkestrator-server-${triple}${ext}`;
const outPath = join(binariesDir, outName);

console.log(`[1/3] Target: ${triple}`);
console.log(`[2/3] Compiling server...`);

// Ensure output directory exists
if (!existsSync(binariesDir)) {
  mkdirSync(binariesDir, { recursive: true });
}

// Resolve bun path — check PATH first, then common install locations
function findBun() {
  const candidates = isWindows
    ? ["bun.exe", `${process.env.USERPROFILE}\\.bun\\bin\\bun.exe`]
    : [
        "bun",
        `${process.env.HOME}/.bun/bin/bun`,
        "/usr/local/bin/bun",
        "/opt/homebrew/bin/bun",
      ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "pipe" });
      return candidate;
    } catch {}
  }
  console.error("[ERR] bun not found. Install it from https://bun.sh");
  process.exit(1);
}

// Compile with Bun
try {
  const bunCmd = findBun();
  execSync(
    `${bunCmd} build --compile src/index.ts --outfile "${outPath}"`,
    {
      cwd: serverDir,
      stdio: "inherit",
    },
  );
} catch (err) {
  console.error(`[ERR] Compilation failed`);
  process.exit(1);
}

console.log(`[3/3] Output: ${outPath}`);
console.log(`[OK] Sidecar binary ready`);
