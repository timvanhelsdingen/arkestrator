#!/usr/bin/env node
/**
 * Updates the version across ALL Arkestrator packages in one shot.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.2.0
 *
 * Files updated:
 *   - package.json (root)
 *   - server/package.json
 *   - client/package.json
 *   - packages/protocol/package.json
 *   - admin/package.json
 *   - extensions/vscode/package.json
 *   - client/src-tauri/Cargo.toml
 *   - client/src-tauri/tauri.conf.json
 *   - bridges/registry.json (official bridges only)
 *   - bridges/godot/addons/arkestrator_bridge/plugin.cfg
 *   - bridges/blender/arkestrator_bridge/blender_manifest.toml
 *   - bridges/unreal/ArkestratorBridge/ArkestratorBridge.uplugin
 *
 * After running this script:
 *   git add -A
 *   git commit -m "chore: bump version to <version>"
 *   git tag v<version>
 *   git push origin main --tags   # triggers release CI
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <version>");
  console.error("  e.g. node scripts/bump-version.mjs 0.2.0");
  console.error("  e.g. node scripts/bump-version.mjs 1.0.0-beta.1");
  process.exit(1);
}

console.log(`Bumping all packages to ${version}\n`);

// --- JSON files (package.json) ---
const jsonFiles = [
  "package.json",
  "server/package.json",
  "client/package.json",
  "packages/protocol/package.json",
  "admin/package.json",
  "extensions/vscode/package.json",
];

for (const file of jsonFiles) {
  const path = join(root, file);
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const old = pkg.version ?? "(none)";
    pkg.version = version;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  ✓ ${file}  ${old} → ${version}`);
  } catch (err) {
    console.warn(`  ⚠ ${file}  skipped (${err.code ?? err.message})`);
  }
}

// --- Cargo.toml ---
const cargoPath = join(root, "client/src-tauri/Cargo.toml");
try {
  let cargo = readFileSync(cargoPath, "utf8");
  cargo = cargo.replace(
    /^(version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  writeFileSync(cargoPath, cargo);
  console.log(`  ✓ client/src-tauri/Cargo.toml → ${version}`);
} catch (err) {
  console.warn(`  ⚠ Cargo.toml  skipped (${err.code ?? err.message})`);
}

// --- tauri.conf.json ---
const tauriConfPath = join(root, "client/src-tauri/tauri.conf.json");
try {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  conf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + "\n");
  console.log(`  ✓ client/src-tauri/tauri.conf.json → ${version}`);
} catch (err) {
  console.warn(`  ⚠ tauri.conf.json  skipped (${err.code ?? err.message})`);
}

// --- Bridge versions are now managed in the separate arkestrator-bridges repo ---

console.log(`\n✅ All files updated to ${version}`);
console.log(`\n  Note: Bridge versions are managed separately in arkestrator-bridges repo.`);
console.log(`\nNext steps:`);
console.log(`  git add -A`);
console.log(`  git commit -m "chore: bump version to ${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin main --tags`);
