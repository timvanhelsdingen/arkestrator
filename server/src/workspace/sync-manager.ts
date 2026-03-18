import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type { FileAttachment } from "@arkestrator/protocol";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

interface SyncEntry {
  dir: string;
  createdAt: number;
  completed: boolean;
}

export class SyncManager {
  private activeSyncs = new Map<string, SyncEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: Config) {}

  start() {
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      this.config.syncCleanupIntervalMs,
    );
    logger.info(
      "sync",
      `Sync manager started (TTL: ${this.config.syncTtlMs}ms, cleanup interval: ${this.config.syncCleanupIntervalMs}ms)`,
    );
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    logger.info("sync", "Sync manager stopped");
  }

  async createSyncDir(jobId: string): Promise<string> {
    if (!isSafeSyncJobId(jobId)) {
      throw new Error(`Invalid sync job ID: ${jobId}`);
    }
    const dir = join(this.config.syncTempDir, jobId);
    await mkdir(dir, { recursive: true });
    this.activeSyncs.set(jobId, {
      dir,
      createdAt: Date.now(),
      completed: false,
    });
    logger.info("sync", `Created sync dir for job ${jobId}: ${dir}`);
    return dir;
  }

  async writeFiles(jobId: string, files: FileAttachment[]): Promise<void> {
    const entry = this.activeSyncs.get(jobId);
    if (!entry) {
      throw new Error(`No sync dir for job ${jobId}`);
    }

    // Check total size against configured limit
    const maxBytes = this.config.syncMaxSizeMb * 1024 * 1024;
    let totalSize = 0;
    for (const file of files) {
      totalSize += Buffer.byteLength(file.content, "utf-8");
    }
    if (totalSize > maxBytes) {
      throw new Error(
        `Sync files total ${(totalSize / 1024 / 1024).toFixed(1)} MB, exceeds limit of ${this.config.syncMaxSizeMb} MB`,
      );
    }

    for (const file of files) {
      const inputPath = String(file.path ?? "").trim();
      if (!inputPath) {
        throw new Error("File path must be a non-empty relative path");
      }
      if (isPotentiallyAbsolutePath(inputPath)) {
        throw new Error(`Absolute paths are not allowed in sync uploads: ${inputPath}`);
      }

      const fullPath = resolve(entry.dir, inputPath);
      // Prevent path traversal and cross-drive/UNC escapes.
      const rel = relative(entry.dir, fullPath);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes sync directory: ${inputPath}`);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf-8");
    }

    logger.info(
      "sync",
      `Wrote ${files.length} file(s) to sync dir for job ${jobId}`,
    );
  }

  getSyncDir(jobId: string): string | null {
    const entry = this.activeSyncs.get(jobId);
    return entry?.dir ?? null;
  }

  markComplete(jobId: string) {
    const entry = this.activeSyncs.get(jobId);
    if (entry) {
      entry.completed = true;
      logger.info("sync", `Marked sync dir complete for job ${jobId}`);
    }
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [jobId, entry] of this.activeSyncs) {
      const age = now - entry.createdAt;
      if (entry.completed && age > this.config.syncTtlMs) {
        expired.push(jobId);
      } else if (!entry.completed && age > this.config.syncTtlMs * 2) {
        // Clean up stale incomplete entries (e.g. from crashed jobs)
        expired.push(jobId);
        logger.warn("sync", `Cleaning stale incomplete sync dir for job ${jobId} (age: ${Math.round(age / 1000)}s)`);
      }
    }

    for (const jobId of expired) {
      const entry = this.activeSyncs.get(jobId)!;
      try {
        await rm(entry.dir, { recursive: true, force: true });
        logger.info("sync", `Cleaned up sync dir for job ${jobId}`);
      } catch (err) {
        logger.error(
          "sync",
          `Failed to clean up sync dir for job ${jobId}: ${err}`,
        );
      }
      this.activeSyncs.delete(jobId);
    }

    if (expired.length > 0) {
      logger.info("sync", `Cleaned up ${expired.length} expired sync dir(s)`);
    }
  }
}

function isPotentiallyAbsolutePath(path: string): boolean {
  if (isAbsolute(path)) return true;
  // Windows drive-letter absolute paths that may bypass isAbsolute depending on platform.
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true;
  // UNC/device paths (\\server\share, \\?\C:\..., //server/share)
  if (path.startsWith("\\\\") || path.startsWith("//")) return true;
  return false;
}

function isSafeSyncJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(jobId);
}
