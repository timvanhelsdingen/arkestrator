import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { requirePermission, getAuthenticatedUser } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

export function createStatsRoutes(deps: AppDeps) {
  const router = new Hono();

  // Dashboard stats
  router.get("/dashboard", (c) => {
    const user = requirePermission(c, deps.usersRepo, "viewUsage");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const today = new Date().toISOString().split("T")[0];
    const jobStats = deps.jobsRepo.getDashboardStats(today);

    const connectedBridges = deps.hub.getBridges().length;
    const connectedClients = deps.hub.getClients().length;

    const users = deps.usersRepo.list();
    const agentConfigs = deps.agentsRepo.list();

    return c.json({
      ...jobStats,
      connectedBridges,
      connectedClients,
      totalUsers: users.length,
      totalAgentConfigs: agentConfigs.length,
    });
  });

  // Usage stats — admin can query any user, authenticated users can query their own
  router.get("/usage", (c) => {
    const authUser = getAuthenticatedUser(c, deps.usersRepo);
    if (!authUser) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const userId = c.req.query("userId") ?? authUser.id;
    const since = c.req.query("since") ?? "1970-01-01T00:00:00.000Z";

    const canViewAny = authUser.role === "admin" || authUser.permissions.viewUsage;
    if (userId !== authUser.id && !canViewAny) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const usage = deps.usageRepo.getByUserIdSince(userId, since);
    const targetUser = deps.usersRepo.getById(userId);

    return c.json({
      ...usage,
      tokenLimitInput: targetUser?.tokenLimitInput ?? null,
      tokenLimitOutput: targetUser?.tokenLimitOutput ?? null,
      tokenLimitPeriod: targetUser?.tokenLimitPeriod ?? "monthly",
    });
  });

  return router;
}
