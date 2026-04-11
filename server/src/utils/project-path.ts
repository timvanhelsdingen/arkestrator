/**
 * Project-path sanity helpers.
 *
 * Two jobs:
 *  1. `sanitizeLastProjectPath(p)` — reject paths that are too broad to
 *     be legitimate project roots (home dir, system root, drive roots,
 *     etc.) so the `workers.last_project_path` column never remembers a
 *     sentinel that will later get injected as a job's `projectRoot`.
 *  2. `hasProjectMarker(p)` — on top of existsSync, require that the
 *     candidate directory actually looks like a project root (has at
 *     least one recognisable marker file). A bare-but-too-broad
 *     directory — e.g. the user's home dir — will reject even if it
 *     passed the sanitiser.
 *
 * Both helpers guard the same trust boundary as the resolver's
 * `isUnsafeRepoCwd`, but at different layers: the sanitiser stops bad
 * paths from being *persisted*, and the marker check stops bad paths
 * from being *accepted* at resolver time. Defense in depth — if the
 * sanitiser is bypassed (e.g. a migration from a pre-fix DB) the
 * resolver still refuses the path.
 *
 * Lands as part of the 2026-04-11 DB corruption follow-up; see
 * `docs/reports/2026-04-11-db-corruption-postmortem.md`.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve, sep, parse as parsePath } from "node:path";
import { homedir } from "node:os";

/**
 * Project-marker filenames we accept as proof that a directory is an
 * actual project root. The list is intentionally broad — any one of
 * these beats a bare directory:
 *
 * - VCS / language / build: `.git`, `package.json`, `pyproject.toml`,
 *   `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`,
 *   `composer.json`, `CMakeLists.txt`, `Makefile`
 * - DCC project files (filename-is-the-project, so we check dir contents):
 *   `.blend`, `.hip`, `.hiplc`, `.hipnc`, `.ma`, `.mb`, `.max`, `.c4d`,
 *   `.unity`, `.uproject`, `.godot`
 * - Arkestrator's own per-project config: `arkestrator.coordinator.json`,
 *   `arkestrator.coordinator.md`, `.arkestrator/`
 * - Editor workspace descriptors: `.vscode/`, `.idea/`
 */
const MARKER_FILES = [
  ".git",
  ".arkestrator",
  "arkestrator.coordinator.json",
  "arkestrator.coordinator.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "Makefile",
  "project.godot",
  ".vscode",
  ".idea",
];

/** Program-specific project file extensions (directory must contain at least one file with this suffix). */
const MARKER_EXTENSIONS = [
  ".blend",
  ".hip",
  ".hiplc",
  ".hipnc",
  ".ma",
  ".mb",
  ".max",
  ".c4d",
  ".unity",
  ".uproject",
];

function resolveSafe(p: string): string | null {
  if (!p || typeof p !== "string") return null;
  try {
    return resolve(p);
  } catch {
    return null;
  }
}

/**
 * Is `candidate` a path we refuse to persist as a worker's
 * `lastProjectPath`? Returns the reason string on refusal; on
 * acceptance returns `{ ok: true, path }` where `path` is the
 * **trimmed original** (not the absolute/resolved form) so that
 * existing persisted values keep their on-disk representation.
 * Safety checks still run against the resolved form internally.
 */
export function sanitizeLastProjectPath(
  candidate: string | null | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!candidate) return { ok: false, reason: "empty" };
  const trimmed = String(candidate).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const resolved = resolveSafe(trimmed);
  if (!resolved) return { ok: false, reason: `unresolvable path: ${trimmed}` };

  // Reject the user home directory itself.
  const home = resolveSafe(homedir());
  if (home && resolved === home) {
    return { ok: false, reason: `path is the user home directory (${home})` };
  }

  // Reject OS root / drive root.
  const parsed = parsePath(resolved);
  if (parsed.root === resolved) {
    return { ok: false, reason: `path is a filesystem root (${resolved})` };
  }

  // Reject classic top-level "all of <something>" directories on Unix.
  // On Windows `/Users` + `/home` don't exist natively but this is
  // still cheap insurance if the server runs under WSL / Cygwin.
  const badTopLevel = new Set([
    "/Users",
    "/home",
    "/root",
    "/var",
    "/etc",
    "/tmp",
  ]);
  if (badTopLevel.has(resolved)) {
    return { ok: false, reason: `path is a top-level system directory (${resolved})` };
  }

  // On Windows, also reject `C:\Users`, `C:\Program Files`, etc.
  if (parsed.root && parsed.root.match(/^[A-Za-z]:\\$/)) {
    const drive = parsed.root;
    const badWinTopLevel = new Set(
      ["Users", "Program Files", "Program Files (x86)", "ProgramData", "Windows"].map(
        (n) => resolve(drive + n),
      ),
    );
    if (badWinTopLevel.has(resolved)) {
      return { ok: false, reason: `path is a top-level Windows system directory (${resolved})` };
    }
  }

  return { ok: true, path: trimmed };
}

/**
 * Does `dir` contain at least one recognisable project marker file
 * (see MARKER_FILES / MARKER_EXTENSIONS)? Returns true for any real
 * project root. Returns false for a plain directory with no markers,
 * or for a non-existent path.
 *
 * On errors (e.g. permission denied while reading the dir) returns
 * `null` so the caller can decide whether to be strict or lenient.
 * Resolver currently treats null as "safe to accept" — the caller
 * already ran `existsSync` and `isUnsafeRepoCwd` guards, and we
 * don't want a transient EACCES to stop a legitimate job.
 */
export function hasProjectMarker(dir: string): boolean | null {
  if (!dir) return false;
  const resolved = resolveSafe(dir);
  if (!resolved) return false;
  if (!existsSync(resolved)) return false;
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return false;
  } catch {
    return null;
  }

  // Fast path: check for named marker files first (one stat per marker).
  for (const marker of MARKER_FILES) {
    const p = join(resolved, marker);
    if (existsSync(p)) return true;
  }

  // Slower path: scan dir for any DCC project file extension. Only
  // triggered if no named marker matched, so it's O(entries) but
  // usually short-circuits quickly on real projects.
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(resolved);
    for (const name of entries) {
      const lower = name.toLowerCase();
      for (const ext of MARKER_EXTENSIONS) {
        if (lower.endsWith(ext)) return true;
      }
    }
  } catch {
    return null;
  }

  return false;
}

/** Exposed for tests + diagnostics. */
export const MARKER_FILES_FOR_TESTS = MARKER_FILES;
export const MARKER_EXTENSIONS_FOR_TESTS = MARKER_EXTENSIONS;
