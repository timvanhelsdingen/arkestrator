#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const binariesDir = resolve(repoRoot, "client/src-tauri/binaries");
const adminDistDir = resolve(repoRoot, "admin/dist");
const bundledAdminDistDir = resolve(repoRoot, "client/resources/admin-dist");
const legacyBundledAdminDistDir = resolve(repoRoot, "client/src-tauri/resources/admin-dist");

function getTargetTriple() {
  const rustc = platform() === "win32" ? "rustc.exe" : "rustc";
  try {
    const out = spawnSync(rustc, ["--print", "host-tuple"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (out.status === 0 && out.stdout) {
      return out.stdout.trim();
    }
  } catch {}

  const key = `${platform()}-${arch()}`;
  const triples = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };

  const triple = triples[key];
  if (!triple) {
    throw new Error(`Unsupported platform: ${key}`);
  }
  return triple;
}

const triple = getTargetTriple();
const ext = platform() === "win32" ? ".exe" : "";

const expected = [
  resolve(binariesDir, `arkestrator-server-${triple}${ext}`),
];

const missing = expected.filter((file) => !existsSync(file));
if (missing.length === 0) {
  console.log("[ensure-sidecar] Sidecar binaries found");
} else {
  console.log("[ensure-sidecar] Missing sidecar binary; building...");
  try {
    execSync("pnpm --filter @arkestrator/server build:sidecar", {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }

  const stillMissing = expected.filter((file) => !existsSync(file));
  if (stillMissing.length > 0) {
    console.error("[ensure-sidecar] Build completed but expected binaries are still missing:");
    for (const file of stillMissing) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  console.log("[ensure-sidecar] Sidecar binaries ready");
}

if (!existsSync(resolve(adminDistDir, "index.html"))) {
  console.log("[ensure-sidecar] Admin dist missing; building admin...");
  try {
    execSync("pnpm --filter @arkestrator/admin build", {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
}

rmSync(legacyBundledAdminDistDir, { recursive: true, force: true });
rmSync(bundledAdminDistDir, { recursive: true, force: true });
mkdirSync(bundledAdminDistDir, { recursive: true });
cpSync(adminDistDir, bundledAdminDistDir, { recursive: true });
console.log("[ensure-sidecar] Bundled admin dist into client/resources/admin-dist");
