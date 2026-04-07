/**
 * App version — read once from package.json at startup.
 * Shared across the server (health routes, skill versioning, etc.).
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

function loadServerVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(dir, "../../package.json"), "utf-8"),
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = loadServerVersion();
