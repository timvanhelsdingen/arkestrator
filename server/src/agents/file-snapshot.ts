import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { watch, existsSync, type FSWatcher } from "node:fs";
import { join, relative } from "node:path";
import type { FileChange } from "@arkestrator/protocol";

const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

/**
 * Collect all file paths under a directory (readdir only — no stat, no content read).
 * Returns a Set of relative paths for quick "existed before?" lookups.
 * This is fast even for large projects since it only lists directory entries.
 */
export async function collectPaths(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  await walkPaths(rootDir, rootDir, paths);
  return paths;
}

async function walkPaths(
  dir: string,
  rootDir: string,
  paths: Set<string>,
) {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (shouldSkip(item.name)) continue;
    const fullPath = join(dir, item.name);

    if (item.isDirectory()) {
      await walkPaths(fullPath, rootDir, paths);
    } else if (item.isFile() || item.isSymbolicLink()) {
      paths.add(relative(rootDir, fullPath).replaceAll("\\", "/"));
    }
  }
}

/**
 * Watches a directory for file changes using OS-level notifications.
 * Much faster than before/after directory scans — the kernel tells us
 * exactly which files changed, so we only read those.
 */
export interface DirWatcher {
  /** Stop watching. Call this after the job process exits. */
  stop(): void;
  /**
   * Get file changes detected during the watch period.
   * Reads content only for files that were actually created or modified.
   * @param beforePaths — Set of paths that existed before the job started
   */
  getChanges(beforePaths: Set<string>): Promise<FileChange[]>;
}

export function startWatching(rootDir: string): DirWatcher {
  const changedPaths = new Set<string>();
  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(rootDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.replaceAll("\\", "/");
      // Skip hidden files/dirs and excluded directories
      const parts = rel.split("/");
      if (parts.some((p) => shouldSkip(p))) return;
      changedPaths.add(rel);
    });
  } catch {
    // fs.watch failed (e.g. unsupported platform) — getChanges returns empty
  }

  return {
    stop() {
      watcher?.close();
      watcher = null;
    },

    async getChanges(beforePaths: Set<string>): Promise<FileChange[]> {
      const changes: FileChange[] = [];
      const candidatePaths = new Set<string>(changedPaths);

      // Safety net for fs.watch edge cases (dropped events, rename bursts):
      // compare before/after path snapshots and include any path deltas.
      const afterPaths = await collectPaths(rootDir);
      for (const rel of afterPaths) {
        if (!beforePaths.has(rel)) candidatePaths.add(rel);
      }
      for (const rel of beforePaths) {
        if (!afterPaths.has(rel)) candidatePaths.add(rel);
      }

      for (const rel of [...candidatePaths].sort()) {
        const fullPath = join(rootDir, rel);
        const exists = existsSync(fullPath);

        if (exists) {
          // File/symlink exists now — serialize in a way that survives binary/symlink edge cases.
          const content = await safeReadPathSnapshot(fullPath);
          if (content !== null) {
            const action = beforePaths.has(rel) ? "modify" : "create";
            changes.push({ path: rel, content, action });
          }
        } else if (beforePaths.has(rel)) {
          // File was deleted
          changes.push({ path: rel, content: "", action: "delete" });
        }
      }

      return changes;
    },
  };
}

async function safeReadPathSnapshot(fullPath: string): Promise<string | null> {
  try {
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) {
      const target = await safeReadLink(fullPath);
      return target
        ? `[symlink] -> ${target}`
        : "[symlink] -> (unresolved)";
    }
    if (!stats.isFile()) return null;
    const buffer = await readFile(fullPath);
    if (isLikelyBinary(buffer)) {
      return `[binary] ${buffer.byteLength} bytes`;
    }
    return buffer.toString("utf-8");
  } catch {
    // Unreadable path (deleted mid-read, permissions, etc.)
    return null;
  }
}

async function safeReadLink(fullPath: string): Promise<string | null> {
  try {
    return await readlink(fullPath);
  } catch {
    return null;
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const max = Math.min(buffer.length, 1024);
  for (let i = 0; i < max; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
