import { Hono } from "hono";
import type { SyncManager } from "../workspace/sync-manager.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";
import { apiKeyRoleAllowed } from "../middleware/auth.js";

function isUploadValidationError(message: string): boolean {
  const checks = [
    "Invalid sync job ID",
    "File path must be a non-empty relative path",
    "Absolute paths are not allowed in sync uploads",
    "Path escapes sync directory",
    "exceeds limit of",
    "Invalid files payload",
  ];
  return checks.some((marker) => message.includes(marker));
}

export function createSyncRoutes(
  syncManager: SyncManager,
  apiKeysRepo: ApiKeysRepo,
) {
  const router = new Hono();

  // Upload files for a job's sync directory
  router.post("/:jobId/upload", async (c) => {
    // Authenticate via API key
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse(c, 401, "Missing API key", "UNAUTHORIZED");
    }
    const rawKey = authHeader.slice(7);
    const apiKey = await apiKeysRepo.validate(rawKey);
    if (!apiKey) {
      return errorResponse(c, 401, "Invalid API key", "AUTH_FAILED");
    }
    if (!apiKeyRoleAllowed(apiKey, ["admin", "bridge"])) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const jobId = c.req.param("jobId");
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const { files } = body;

    if (!Array.isArray(files) || files.length === 0) {
      return errorResponse(c, 400, "files array is required and must not be empty", "INVALID_INPUT");
    }
    for (const file of files) {
      if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string") {
        return errorResponse(c, 400, "Invalid files payload", "INVALID_INPUT");
      }
    }

    try {
      const syncDir = await syncManager.createSyncDir(jobId);
      await syncManager.writeFiles(jobId, files);

      logger.info("sync", `Uploaded ${files.length} files for job ${jobId}`);
      return c.json({ ok: true, syncDir, fileCount: files.length });
    } catch (err: any) {
      const message = String(err?.message ?? "Upload failed");
      logger.error("sync", `Upload failed for job ${jobId}: ${message}`);
      if (isUploadValidationError(message)) {
        return errorResponse(c, 400, message, "INVALID_INPUT");
      }
      return errorResponse(c, 500, message, "INTERNAL_ERROR");
    }
  });

  return router;
}
