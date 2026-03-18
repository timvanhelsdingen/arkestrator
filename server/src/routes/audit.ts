import { Hono } from "hono";
import type { AuditRepo } from "../db/audit.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import { requirePermission } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

export function createAuditRoutes(
  auditRepo: AuditRepo,
  usersRepo: UsersRepo,
) {
  const router = new Hono();

  // List audit log entries (paginated)
  router.get("/", (c) => {
    const user = requirePermission(c, usersRepo, "viewAuditLog");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const userId = c.req.query("userId");
    const action = c.req.query("action");

    const result = auditRepo.list({
      limit: Math.min(limit, 200),
      offset,
      userId: userId || undefined,
      action: action || undefined,
    });

    return c.json(result);
  });

  return router;
}
