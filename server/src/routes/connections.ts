import { Hono } from "hono";
import type { WebSocketHub } from "../ws/hub.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import { requirePermission, getClientIp } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

export function createConnectionRoutes(
  hub: WebSocketHub,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
) {
  const router = new Hono();

  // List all active WebSocket connections
  router.get("/", (c) => {
    const user = requirePermission(c, usersRepo, "manageConnections");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const connections = hub.getAll().map((ws) => ({
      id: ws.id,
      type: ws.type,
      role: ws.role,
      name: ws.name ?? ws.id,
      connectedAt: ws.connectedAt,
      program: ws.program,
      programVersion: ws.programVersion,
      bridgeVersion: ws.bridgeVersion,
      projectPath: ws.projectPath,
      activeProjects: Array.isArray(ws.activeProjects)
        ? ws.activeProjects
        : (ws.projectPath ? [ws.projectPath] : []),
      ip: ws.ip,
      osUser: ws.osUser,
    }));

    return c.json(connections);
  });

  // Kick a connected client
  router.post("/:id/kick", (c) => {
    const user = requirePermission(c, usersRepo, "manageConnections");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const targetId = c.req.param("id");
    const kicked = hub.kick(targetId);
    if (!kicked) return errorResponse(c, 404, "Connection not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "kick_connection",
      resource: "connection",
      resourceId: targetId,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
