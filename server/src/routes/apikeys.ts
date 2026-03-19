import { Hono } from "hono";
import type { ApiKeysRepo, ApiKeyRole } from "../db/apikeys.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import { getAuthPrincipal, requirePermission, getClientIp } from "../middleware/auth.js";
import { writeSharedConfig } from "../utils/shared-config.js";
import { loadConfig } from "../config.js";
import { errorResponse } from "../utils/errors.js";
import { readNonEmptyTrimmedString } from "../utils/credentials.js";
import {
  parseUserPermissionPatch,
  normalizeApiKeyPermissions,
} from "../utils/user-permissions.js";

export function createApiKeyRoutes(
  apiKeysRepo: ApiKeysRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
) {
  const router = new Hono();

  router.get("/", (c) => {
    const user = requirePermission(c, usersRepo, "manageApiKeys");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const keys = apiKeysRepo.list();
    return c.json(keys);
  });

  router.post("/", async (c) => {
    const user = requirePermission(c, usersRepo, "manageApiKeys");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const name = readNonEmptyTrimmedString(body?.name);
    const role = (body.role as ApiKeyRole) ?? "bridge";

    if (!name) return errorResponse(c, 400, "name is required", "INVALID_INPUT");
    if (!["bridge", "client", "admin"].includes(role)) {
      return errorResponse(c, 400, "Invalid role", "INVALID_INPUT");
    }

    // Parse optional custom permissions (overrides role defaults)
    let customPermissions: Record<string, boolean> | undefined;
    if (body.permissions && typeof body.permissions === "object") {
      const parsed = parseUserPermissionPatch(body.permissions);
      if (!parsed.ok) {
        return errorResponse(c, 400, parsed.error, "INVALID_INPUT");
      }
      customPermissions = parsed.patch as Record<string, boolean>;
    }

    const { apiKey, rawKey } = await apiKeysRepo.create(name, role, customPermissions);

    // Update shared config so bridges can auto-discover this key
    try {
      const config = loadConfig();
      writeSharedConfig(config.port, rawKey);
    } catch {
      // Non-critical — don't fail the key creation
    }

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "create_api_key",
      resource: "api_key",
      resourceId: apiKey.id,
      details: JSON.stringify({ name, role }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ...apiKey, key: rawKey }, 201);
  });

  // Write an API key to the shared config file for bridge auto-discovery.
  // Restricted to API key managers/admin-key automation because it mutates the
  // server-local shared credential file used by local bridge auto-discovery.
  router.post("/share", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (principal.kind === "user" && principal.user.permissions.manageApiKeys !== true) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (principal.kind === "apiKey" && principal.apiKey.role !== "admin") {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const rawKey = readNonEmptyTrimmedString(body?.apiKey);
    if (!rawKey || (!rawKey.startsWith("ark_") && !rawKey.startsWith("am_"))) {
      return errorResponse(c, 400, "apiKey is required (ark_... format)", "INVALID_INPUT");
    }

    // Validate the key is actually valid
    const valid = await apiKeysRepo.validate(rawKey);
    if (!valid) {
      return errorResponse(c, 400, "Invalid API key", "INVALID_INPUT");
    }

    try {
      const config = loadConfig();
      writeSharedConfig(config.port, rawKey);
    } catch {
      return errorResponse(c, 500, "Failed to write shared config", "INTERNAL_ERROR");
    }

    auditRepo.log({
      userId: principal.kind === "user" ? principal.user.id : null,
      username:
        principal.kind === "user"
          ? principal.user.username
          : `api-key:${principal.apiKey.name}`,
      action: "share_api_key",
      resource: "api_key",
      details: JSON.stringify({
        targetRole: valid.role,
        authKind: principal.kind,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, path: (await import("../utils/shared-config.js")).getSharedConfigPath() });
  });

  router.put("/:id/permissions", async (c) => {
    const user = requirePermission(c, usersRepo, "manageApiKeys");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const id = c.req.param("id");
    const existing = apiKeysRepo.getById(id);
    if (!existing || existing.revokedAt) {
      return errorResponse(c, 404, "Not found or revoked", "NOT_FOUND");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsed = parseUserPermissionPatch(body);
    if (!parsed.ok) {
      return errorResponse(c, 400, parsed.error, "INVALID_INPUT");
    }

    const merged = normalizeApiKeyPermissions(existing.role, {
      ...existing.permissions,
      ...parsed.patch,
    });

    apiKeysRepo.updatePermissions(id, merged);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_api_key_permissions",
      resource: "api_key",
      resourceId: id,
      details: JSON.stringify(parsed.patch),
      ipAddress: getClientIp(c),
    });

    return c.json({ ...existing, permissions: merged });
  });

  router.delete("/:id", (c) => {
    const user = requirePermission(c, usersRepo, "manageApiKeys");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const revoked = apiKeysRepo.revoke(c.req.param("id"));
    if (!revoked) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "revoke_api_key",
      resource: "api_key",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
