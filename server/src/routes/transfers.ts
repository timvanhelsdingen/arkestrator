import { Hono } from "hono";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  getAuthPrincipal,
  principalHasPermission,
  type AuthPrincipal,
} from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { resolveBridgeTargets } from "../agents/resource-control.js";
import type { TransferManager } from "../transfers/transfer-manager.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { Config } from "../config.js";

/**
 * HTTP streaming file transfer endpoints.
 *
 * POST   /                          — Create a transfer (returns upload URLs)
 * PUT    /:transferId/files/:index  — Upload a file (raw binary stream)
 * HEAD   /:transferId/files/:index  — Query upload progress
 * GET    /:transferId/files/:index  — Download a file (binary stream)
 * GET    /:transferId               — Get transfer metadata
 * DELETE /:transferId               — Cancel/cleanup a transfer
 */
export function createTransfersRoutes(
  transferManager: TransferManager,
  hub: WebSocketHub,
  apiKeysRepo: ApiKeysRepo,
  usersRepo: UsersRepo,
  config: Config,
) {
  const app = new Hono();

  async function authenticate(c: any): Promise<AuthPrincipal | null> {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;
    if (principal.kind === "apiKey" && principal.apiKey.role === "bridge") return null;
    return principal;
  }

  function principalId(p: AuthPrincipal): string {
    return p.kind === "user" ? p.user.id : p.apiKey.id;
  }

  // --- POST / — Create a transfer ---
  app.post("/", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    if (!principalHasPermission(principal, "deliverFiles")) {
      return errorResponse(c, 403, "Missing deliverFiles permission", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const files = body.files;
    const target = String(body.target ?? "").trim();
    if (!target) return errorResponse(c, 400, "Missing 'target' field", "INVALID_INPUT");
    if (!Array.isArray(files) || files.length === 0) {
      return errorResponse(c, 400, "Missing or empty 'files' array", "INVALID_INPUT");
    }

    // Validate file entries
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.path || typeof f.path !== "string") {
        return errorResponse(c, 400, `files[${i}].path is required`, "INVALID_INPUT");
      }
      if (typeof f.size !== "number" || f.size < 0) {
        return errorResponse(c, 400, `files[${i}].size must be a non-negative number`, "INVALID_INPUT");
      }
    }

    try {
      const meta = await transferManager.createTransfer({
        files: files.map((f: any) => ({ path: String(f.path), size: Number(f.size) })),
        target,
        targetType: body.targetType ?? body.target_type ?? "program",
        targetWorkerName: body.targetWorkerName ?? body.target_worker,
        projectPath: body.projectPath ?? body.project_path,
        source: body.source,
        creatorPrincipal: principalId(principal),
      });

      return c.json({
        transferId: meta.transferId,
        files: meta.files.map((f, i) => ({
          path: f.path,
          uploadUrl: `/api/transfers/${meta.transferId}/files/${i}`,
        })),
        expiresAt: meta.expiresAt,
      });
    } catch (err: any) {
      return errorResponse(c, 400, err.message, "BAD_REQUEST");
    }
  });

  // --- PUT /:transferId/files/:index — Upload a file ---
  app.put("/:transferId/files/:index", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    if (!principalHasPermission(principal, "deliverFiles")) {
      return errorResponse(c, 403, "Missing deliverFiles permission", "FORBIDDEN");
    }

    const { transferId, index: indexStr } = c.req.param();
    const fileIndex = parseInt(indexStr, 10);
    if (isNaN(fileIndex) || fileIndex < 0) {
      return errorResponse(c, 400, "Invalid file index", "INVALID_INPUT");
    }

    const meta = await transferManager.getMeta(transferId);
    if (!meta) return errorResponse(c, 404, "Transfer not found", "NOT_FOUND");
    if (fileIndex >= meta.files.length) {
      return errorResponse(c, 400, `File index ${fileIndex} out of range (${meta.files.length} files)`, "INVALID_INPUT");
    }
    if (meta.files[fileIndex].uploaded) {
      return errorResponse(c, 409, `File ${fileIndex} already uploaded`, "CONFLICT");
    }

    // Parse Content-Range for resume: "bytes <start>-<end>/<total>"
    let rangeStart = 0;
    const rangeHeader = c.req.header("content-range");
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes\s+(\d+)-/);
      if (match) rangeStart = parseInt(match[1], 10);
    }

    const body = c.req.raw.body;
    if (!body) return errorResponse(c, 400, "No body provided", "INVALID_INPUT");

    try {
      const { bytesWritten } = await transferManager.writeFileStream(
        transferId,
        fileIndex,
        body,
        rangeStart,
      );

      // If we received the expected number of bytes, finalize
      if (bytesWritten >= meta.files[fileIndex].size) {
        const { allComplete, sha256 } = await transferManager.finalizeFile(transferId, fileIndex);

        // If all files uploaded, notify the target
        if (allComplete) {
          await notifyTarget(transferId, meta);
        }

        return c.json({ received: bytesWritten, complete: true, sha256 });
      }

      // Partial upload — client can resume later
      return c.json({ received: bytesWritten, complete: false });
    } catch (err: any) {
      logger.error("transfer", `Upload error for ${transferId}/${fileIndex}: ${err.message}`);
      return errorResponse(c, 500, err.message, "INTERNAL_ERROR");
    }
  });

  // --- HEAD /:transferId/files/:index — Query upload progress ---
  app.on("HEAD", "/:transferId/files/:index", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const { transferId, index: indexStr } = c.req.param();
    const fileIndex = parseInt(indexStr, 10);
    if (isNaN(fileIndex) || fileIndex < 0) {
      return errorResponse(c, 400, "Invalid file index", "INVALID_INPUT");
    }

    const meta = await transferManager.getMeta(transferId);
    if (!meta) return errorResponse(c, 404, "Transfer not found", "NOT_FOUND");
    if (fileIndex >= meta.files.length) {
      return errorResponse(c, 400, "File index out of range", "INVALID_INPUT");
    }

    const { bytes, complete } = await transferManager.getFileBytesReceived(transferId, fileIndex);
    return c.body(null, 200, {
      "X-Bytes-Received": String(bytes),
      "X-File-Complete": String(complete),
    });
  });

  // --- GET /:transferId/files/:index — Download a file ---
  app.get("/:transferId/files/:index", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const { transferId, index: indexStr } = c.req.param();
    const fileIndex = parseInt(indexStr, 10);
    if (isNaN(fileIndex) || fileIndex < 0) {
      return errorResponse(c, 400, "Invalid file index", "INVALID_INPUT");
    }

    const meta = await transferManager.getMeta(transferId);
    if (!meta) return errorResponse(c, 404, "Transfer not found", "NOT_FOUND");
    if (fileIndex >= meta.files.length) {
      return errorResponse(c, 400, "File index out of range", "INVALID_INPUT");
    }
    if (!meta.files[fileIndex].uploaded) {
      return errorResponse(c, 404, "File not yet uploaded", "NOT_FOUND");
    }

    const filePath = transferManager.getFilePath(transferId, fileIndex);
    if (!existsSync(filePath)) {
      return errorResponse(c, 404, "File not found on disk", "NOT_FOUND");
    }

    const file = Bun.file(filePath);
    const fileSize = file.size;
    const fileName = meta.files[fileIndex].path.split(/[/\\]/).pop() ?? `file_${fileIndex}`;

    // Support Range requests for resume
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start >= fileSize) {
          return c.body(null, 416, {
            "Content-Range": `bytes */${fileSize}`,
          });
        }

        const sliced = file.slice(start, end + 1);
        return new Response(sliced.stream(), {
          status: 206,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Content-Disposition": `attachment; filename="${fileName}"`,
          },
        });
      }
    }

    // Full download
    return new Response(file.stream(), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  });

  // --- GET /:transferId — Get transfer metadata ---
  app.get("/:transferId", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const { transferId } = c.req.param();
    const meta = await transferManager.getMeta(transferId);
    if (!meta) return errorResponse(c, 404, "Transfer not found", "NOT_FOUND");

    return c.json({
      transferId: meta.transferId,
      files: meta.files.map((f, i) => ({
        path: f.path,
        size: f.size,
        uploaded: f.uploaded,
        sha256: f.sha256,
        downloadUrl: f.uploaded ? `/api/transfers/${transferId}/files/${i}` : undefined,
      })),
      target: meta.target,
      targetType: meta.targetType,
      projectPath: meta.projectPath,
      source: meta.source,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      allUploaded: meta.files.every((f) => f.uploaded),
    });
  });

  // --- DELETE /:transferId — Cancel/cleanup ---
  app.delete("/:transferId", async (c) => {
    const principal = await authenticate(c);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const { transferId } = c.req.param();
    const meta = await transferManager.getMeta(transferId);
    if (!meta) return errorResponse(c, 404, "Transfer not found", "NOT_FOUND");

    await transferManager.deleteTransfer(transferId);
    return c.json({ deleted: true });
  });

  // --- Helper: notify target when all files are uploaded ---
  async function notifyTarget(transferId: string, meta: any): Promise<void> {
    const serverUrl = `${config.tlsCertPath ? "https" : "http"}://localhost:${config.port}`;
    const downloadBaseUrl = `${serverUrl}/api/transfers/${transferId}/files`;

    const initiatePayload = {
      type: "transfer_initiate" as const,
      id: newId(),
      payload: {
        transferId,
        files: meta.files.map((f: any) => ({
          path: f.path,
          size: f.size,
          sha256: f.sha256,
        })),
        totalBytes: meta.files.reduce((sum: number, f: any) => sum + f.size, 0),
        projectPath: meta.projectPath,
        source: meta.source,
        downloadBaseUrl,
      },
    };

    let delivered = 0;

    // Try bridges
    if (meta.targetType === "program" || meta.targetType === "id") {
      const resolved = resolveBridgeTargets(
        hub,
        meta.target,
        meta.targetType as "program" | "id",
        meta.targetWorkerName,
      );
      for (const ws of resolved.targets) {
        ws.send(JSON.stringify(initiatePayload));
        delivered++;
      }
    }

    // Try clients by worker name
    if (meta.targetType === "worker" || (delivered === 0 && meta.targetType === "program")) {
      const clientTarget = meta.targetType === "worker" ? meta.target : meta.targetWorkerName;
      if (clientTarget) {
        for (const client of hub.getClients()) {
          const workerName = String(client.workerName ?? "").trim().toLowerCase();
          if (workerName === clientTarget.toLowerCase()) {
            hub.send(client.id, initiatePayload);
            delivered++;
          }
        }
      }
    }

    if (delivered > 0) {
      logger.info("transfer", `Notified ${delivered} target(s) for transfer ${transferId}`);
    } else {
      logger.warn("transfer", `No target found for transfer ${transferId} (target: ${meta.target}, type: ${meta.targetType})`);
    }
  }

  return app;
}
