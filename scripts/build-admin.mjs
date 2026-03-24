#!/usr/bin/env node
/**
 * Cross-platform script to build the admin SPA and copy output to
 * client/resources/admin-dist/ in one step.
 *
 * Usage: node scripts/build-admin.mjs
 */
import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(__filename));

console.log("Building admin SPA...");
execSync("pnpm --filter @arkestrator/admin build", { cwd: root, stdio: "inherit" });

const src = join(root, "admin", "dist");
const dest = join(root, "client", "resources", "admin-dist");

if (!existsSync(src)) {
  console.error("Error: admin/dist/ does not exist after build");
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied admin/dist/ -> client/resources/admin-dist/`);
console.log("Done.");
