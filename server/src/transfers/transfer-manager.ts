import { mkdir, readFile, writeFile, rm, stat, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface TransferFileMeta {
  path: string;
  size: number;
  uploaded: boolean;
  sha256?: string;
}

export interface TransferMeta {
  transferId: string;
  files: TransferFileMeta[];
  target: string;
  targetType: "program" | "id" | "worker";
  targetWorkerName?: string;
  projectPath?: string;
  source?: string;
  createdAt: string;
  expiresAt: string;
  creatorPrincipal: string;
}

export interface CreateTransferOpts {
  files: Array<{ path: string; size: number }>;
  target: string;
  targetType?: "program" | "id" | "worker";
  targetWorkerName?: string;
  projectPath?: string;
  source?: string;
  creatorPrincipal: string;
}

export class TransferManager {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: Config) {}

  start() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    logger.info(
      "transfer",
      `Transfer manager started (TTL: ${this.config.transferTtlMs}ms, max: ${this.config.transferMaxSizeMb}MB)`,
    );
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    logger.info("transfer", "Transfer manager stopped");
  }

  async createTransfer(opts: CreateTransferOpts): Promise<TransferMeta> {
    const totalBytes = opts.files.reduce((sum, f) => sum + f.size, 0);
    const maxBytes = this.config.transferMaxSizeMb * 1024 * 1024;
    if (totalBytes > maxBytes) {
      throw new Error(
        `Transfer total ${(totalBytes / 1024 / 1024).toFixed(1)} MB exceeds limit of ${this.config.transferMaxSizeMb} MB`,
      );
    }

    const transferId = crypto.randomUUID();
    const dir = join(this.config.transferTempDir, transferId);
    await mkdir(dir, { recursive: true });

    const now = new Date();
    const meta: TransferMeta = {
      transferId,
      files: opts.files.map((f) => ({
        path: f.path,
        size: f.size,
        uploaded: false,
      })),
      target: opts.target,
      targetType: opts.targetType ?? "program",
      targetWorkerName: opts.targetWorkerName,
      projectPath: opts.projectPath,
      source: opts.source,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.transferTtlMs).toISOString(),
      creatorPrincipal: opts.creatorPrincipal,
    };

    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    logger.info("transfer", `Created transfer ${transferId}: ${opts.files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
    return meta;
  }

  async getMeta(transferId: string): Promise<TransferMeta | null> {
    const metaPath = join(this.config.transferTempDir, transferId, "meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as TransferMeta;
    } catch {
      return null;
    }
  }

  private async saveMeta(transferId: string, meta: TransferMeta): Promise<void> {
    const metaPath = join(this.config.transferTempDir, transferId, "meta.json");
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  /**
   * Stream a file upload to disk. Uses Bun.file().writer() for zero-copy streaming.
   * Supports resume via rangeStart — appends from the given byte offset.
   */
  async writeFileStream(
    transferId: string,
    fileIndex: number,
    body: ReadableStream<Uint8Array>,
    rangeStart = 0,
  ): Promise<{ bytesWritten: number }> {
    const dir = join(this.config.transferTempDir, transferId);
    const partialPath = join(dir, `${fileIndex}.bin.partial`);

    // If resuming, verify partial file exists and offset matches
    if (rangeStart > 0) {
      try {
        const st = await stat(partialPath);
        if (st.size !== rangeStart) {
          throw new Error(
            `Resume offset mismatch: expected ${st.size} bytes on disk, got Content-Range start ${rangeStart}`,
          );
        }
      } catch (err: any) {
        if (err.code === "ENOENT") {
          throw new Error("Cannot resume upload: no partial file exists");
        }
        throw err;
      }
    }

    const file = Bun.file(partialPath);
    const writer = file.writer();
    let bytesWritten = rangeStart;

    try {
      for await (const chunk of body) {
        writer.write(chunk);
        bytesWritten += chunk.byteLength;
      }
      await writer.end();
    } catch (err) {
      // Flush what we have so far for resume
      try { await writer.end(); } catch { /* ignore */ }
      throw err;
    }

    return { bytesWritten };
  }

  /**
   * Finalize an uploaded file: rename .partial → .bin, compute SHA-256, update meta.
   * Returns whether all files in the transfer are now complete.
   */
  async finalizeFile(
    transferId: string,
    fileIndex: number,
  ): Promise<{ allComplete: boolean; sha256: string }> {
    const dir = join(this.config.transferTempDir, transferId);
    const partialPath = join(dir, `${fileIndex}.bin.partial`);
    const finalPath = join(dir, `${fileIndex}.bin`);

    // Compute SHA-256
    const fileContent = Bun.file(partialPath);
    const hasher = new Bun.CryptoHasher("sha256");
    const stream = fileContent.stream();
    for await (const chunk of stream) {
      hasher.update(chunk);
    }
    const sha256 = hasher.digest("hex");

    // Rename partial → final
    await rename(partialPath, finalPath);

    // Update meta
    const meta = await this.getMeta(transferId);
    if (!meta) throw new Error(`Transfer ${transferId} not found`);

    meta.files[fileIndex].uploaded = true;
    meta.files[fileIndex].sha256 = sha256;
    await this.saveMeta(transferId, meta);

    const allComplete = meta.files.every((f) => f.uploaded);
    logger.info(
      "transfer",
      `File ${fileIndex} finalized for transfer ${transferId} (sha256: ${sha256.slice(0, 12)}...) — ${allComplete ? "ALL COMPLETE" : `${meta.files.filter((f) => f.uploaded).length}/${meta.files.length}`}`,
    );

    return { allComplete, sha256 };
  }

  /**
   * Get the bytes received so far for a file (partial or complete).
   */
  async getFileBytesReceived(transferId: string, fileIndex: number): Promise<{ bytes: number; complete: boolean }> {
    const dir = join(this.config.transferTempDir, transferId);
    const finalPath = join(dir, `${fileIndex}.bin`);
    const partialPath = join(dir, `${fileIndex}.bin.partial`);

    try {
      const st = await stat(finalPath);
      return { bytes: st.size, complete: true };
    } catch {
      try {
        const st = await stat(partialPath);
        return { bytes: st.size, complete: false };
      } catch {
        return { bytes: 0, complete: false };
      }
    }
  }

  /**
   * Get a Bun.file() reference for streaming download. Supports byte offset for range requests.
   */
  getFilePath(transferId: string, fileIndex: number): string {
    return join(this.config.transferTempDir, transferId, `${fileIndex}.bin`);
  }

  async deleteTransfer(transferId: string): Promise<void> {
    const dir = join(this.config.transferTempDir, transferId);
    try {
      await rm(dir, { recursive: true, force: true });
      logger.info("transfer", `Deleted transfer ${transferId}`);
    } catch (err: any) {
      logger.warn("transfer", `Failed to delete transfer ${transferId}: ${err.message}`);
    }
  }

  private async cleanup(): Promise<void> {
    const baseDir = this.config.transferTempDir;
    if (!existsSync(baseDir)) return;

    try {
      const entries = await readdir(baseDir);
      const now = Date.now();
      let cleaned = 0;

      for (const entry of entries) {
        const metaPath = join(baseDir, entry, "meta.json");
        try {
          const raw = await readFile(metaPath, "utf-8");
          const meta = JSON.parse(raw) as TransferMeta;
          if (new Date(meta.expiresAt).getTime() < now) {
            await rm(join(baseDir, entry), { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // No valid meta — check dir age via stat
          try {
            const st = await stat(join(baseDir, entry));
            if (now - st.mtimeMs > this.config.transferTtlMs) {
              await rm(join(baseDir, entry), { recursive: true, force: true });
              cleaned++;
            }
          } catch { /* ignore */ }
        }
      }

      if (cleaned > 0) {
        logger.info("transfer", `Cleanup: removed ${cleaned} expired transfers`);
      }
    } catch (err: any) {
      logger.warn("transfer", `Cleanup error: ${err.message}`);
    }
  }
}
