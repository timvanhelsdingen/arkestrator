#!/usr/bin/env node
/**
 * Cross-platform full rebuild — runs every workspace's build script in the
 * correct order and copies admin/dist into client/resources/admin-dist so the
 * server serves the freshly-built admin SPA.
 *
 * Usage: pnpm build:all
 *
 * Equivalent to:
 *   pnpm --filter @arkestrator/protocol build
 *   pnpm --filter @arkestrator/admin build
 *   cp -r admin/dist/* client/resources/admin-dist/
 *   pnpm --filter @arkestrator/server build   (if it has one)
 *   pnpm --filter @arkestrator/client build
 *
 * ...but works on Windows cmd too, where `cp -r` does not exist.
 */
import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(__filename));

const steps = [
  {
    label: "Protocol (TypeScript → dist)",
    cmd: "pnpm --filter @arkestrator/protocol build",
  },
  {
    label: "Admin SPA (Vite → admin/dist)",
    cmd: "pnpm --filter @arkestrator/admin build",
  },
  {
    label: "Client Svelte bundle (Vite → client/dist)",
    cmd: "pnpm --filter @arkestrator/client build",
  },
];

for (const step of steps) {
  console.log(`\n▶ ${step.label}`);
  try {
    execSync(step.cmd, { cwd: root, stdio: "inherit" });
  } catch (err) {
    console.error(`\n✖ Failed: ${step.label}`);
    process.exit(1);
  }
}

// Copy admin/dist → client/resources/admin-dist so the running server serves
// the freshly-built admin. This is the step Windows users keep tripping over
// because `cp -r` isn't a thing in cmd.
const src = join(root, "admin", "dist");
const dest = join(root, "client", "resources", "admin-dist");

if (!existsSync(src)) {
  console.error("\n✖ admin/dist/ does not exist after build — aborting copy");
  process.exit(1);
}

console.log(`\n▶ Copying admin/dist → client/resources/admin-dist`);
// Wipe the destination first so renamed/removed files don't stay behind as
// orphans alongside the freshly-built ones.
try {
  rmSync(dest, { recursive: true, force: true });
} catch {
  // Best-effort — if it doesn't exist, mkdirSync below handles it.
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

console.log("\n✓ Full rebuild complete.");
console.log("  Protocol → packages/protocol/dist");
console.log("  Admin    → admin/dist → client/resources/admin-dist");
console.log("  Client   → client/dist");
console.log("\nRestart the server to pick up the new admin bundle.");
