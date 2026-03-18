import { Hono } from "hono";
import type { UsersRepo, UserRole, TokenLimitPeriod } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { UsageRepo } from "../db/usage.repo.js";
import { requirePermission, getClientIp } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import {
  applyUserPermissionPatch,
  parseUserPermissionPatch,
} from "../utils/user-permissions.js";
import {
  MIN_PASSWORD_LENGTH,
  passwordLengthError,
  readNonEmptyPassword,
  readNonEmptyTrimmedString,
} from "../utils/credentials.js";

function startOfUtcDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function startOfUtcMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function parseOptionalTokenLimit(value: unknown): number | null | typeof INVALID_TOKEN_LIMIT {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return INVALID_TOKEN_LIMIT;
  }
  return value;
}

const INVALID_TOKEN_LIMIT = Symbol("invalid-token-limit");

export function createUserRoutes(
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
  jobsRepo: JobsRepo,
  usageRepo: UsageRepo,
) {
  const router = new Hono();

  // List all users
  router.get("/", (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const users = usersRepo.list();
    return c.json(users);
  });

  // Detailed per-user insights for admin usage/cost and job visibility
  router.get("/:id/insights", (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    const rawLimit = Number.parseInt(String(c.req.query("limit") ?? "25"), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 100))
      : 25;

    const dailyUsage = usageRepo.getByUserIdSince(targetUser.id, startOfUtcDayIso());
    const monthlyUsage = usageRepo.getByUserIdSince(targetUser.id, startOfUtcMonthIso());
    const allTimeUsage = usageRepo.getByUserIdSince(targetUser.id, "1970-01-01T00:00:00.000Z");

    const statusCounts = jobsRepo.getStatusCountsBySubmittedBy(targetUser.id);
    const recentJobs = jobsRepo.listBySubmittedBy(targetUser.id, limit);
    const usageByJobId = usageRepo.getByJobIds(recentJobs.map((job) => job.id));

    return c.json({
      user: {
        id: targetUser.id,
        username: targetUser.username,
        role: targetUser.role,
        require2fa: targetUser.require2fa,
        clientCoordinationEnabled: targetUser.clientCoordinationEnabled,
        tokenLimitInput: targetUser.tokenLimitInput,
        tokenLimitOutput: targetUser.tokenLimitOutput,
        tokenLimitPeriod: targetUser.tokenLimitPeriod,
        createdAt: targetUser.createdAt,
      },
      usage: {
        daily: dailyUsage,
        monthly: monthlyUsage,
        allTime: allTimeUsage,
      },
      jobs: {
        counts: statusCounts,
        recent: recentJobs.map((job) => ({
          id: job.id,
          name: job.name ?? null,
          prompt: job.prompt,
          status: job.status,
          priority: job.priority,
          bridgeProgram: job.bridgeProgram ?? null,
          workerName: job.workerName ?? null,
          workspaceMode: job.workspaceMode ?? null,
          createdAt: job.createdAt,
          startedAt: job.startedAt ?? null,
          completedAt: job.completedAt ?? null,
          tokenUsage: usageByJobId.get(job.id) ?? null,
        })),
      },
    });
  });

  // Create user
  router.post("/", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const username = readNonEmptyTrimmedString(body?.username);
    const password = readNonEmptyPassword(body?.password);
    const { role, permissions, require2fa, clientCoordinationEnabled } = body;

    if (!username || !password) {
      return errorResponse(c, 400, "Username and password are required", "INVALID_INPUT");
    }

    const validRoles: UserRole[] = ["admin", "user", "viewer"];
    if (role && !validRoles.includes(role)) {
      return errorResponse(c, 400, "Invalid role", "INVALID_INPUT");
    }
    if (role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can create admin users", "FORBIDDEN");
    }

    let permissionPatch = {};
    if (permissions !== undefined) {
      const parsedPermissions = parseUserPermissionPatch(permissions);
      if (!parsedPermissions.ok) {
        return errorResponse(c, 400, parsedPermissions.error, "INVALID_INPUT");
      }
      permissionPatch = parsedPermissions.patch;
    }
    if (require2fa !== undefined && typeof require2fa !== "boolean") {
      return errorResponse(c, 400, "require2fa must be a boolean", "INVALID_INPUT");
    }
    if (clientCoordinationEnabled !== undefined && typeof clientCoordinationEnabled !== "boolean") {
      return errorResponse(c, 400, "clientCoordinationEnabled must be a boolean", "INVALID_INPUT");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return errorResponse(c, 400, passwordLengthError(), "INVALID_INPUT");
    }

    // Check username uniqueness
    const existing = usersRepo.getByUsername(username);
    if (existing) {
      return errorResponse(c, 409, "Username already taken", "CONFLICT");
    }

    const resolvedRole = (role ?? "user") as UserRole;
    const newUser = await usersRepo.create(username, password, resolvedRole, permissionPatch);
    if (typeof require2fa === "boolean") {
      usersRepo.setRequire2fa(newUser.id, require2fa);
    }
    if (typeof clientCoordinationEnabled === "boolean") {
      usersRepo.setClientCoordinationEnabled(newUser.id, clientCoordinationEnabled);
    }
    const savedUser = usersRepo.getById(newUser.id) ?? newUser;

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "create_user",
      resource: "user",
      resourceId: savedUser.id,
      details: JSON.stringify({
        username: savedUser.username,
        role: savedUser.role,
        permissions: savedUser.permissions,
        require2fa: savedUser.require2fa,
        clientCoordinationEnabled: savedUser.clientCoordinationEnabled,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json(savedUser, 201);
  });

  // Update user role
  router.put("/:id/role", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const { role } = body;

    const validRoles: UserRole[] = ["admin", "user", "viewer"];
    if (!validRoles.includes(role)) {
      return errorResponse(c, 400, "Invalid role", "INVALID_INPUT");
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    if ((targetUser.role === "admin" || role === "admin") && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can modify admin roles", "FORBIDDEN");
    }

    const updated = usersRepo.updateRole(c.req.param("id"), role);
    if (!updated) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_user_role",
      resource: "user",
      resourceId: c.req.param("id"),
      details: JSON.stringify({ newRole: role }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Reset user password
  router.put("/:id/password", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const oldPassword = readNonEmptyPassword(body?.oldPassword);
    const newPassword = readNonEmptyPassword(body?.newPassword);
    const confirmNewPassword = readNonEmptyPassword(body?.confirmNewPassword);

    if (!oldPassword || !newPassword || !confirmNewPassword) {
      return errorResponse(
        c,
        400,
        "Old password, new password, and confirmation are required",
        "INVALID_INPUT",
      );
    }

    if (newPassword !== confirmNewPassword) {
      return errorResponse(c, 400, "New password and confirmation do not match", "INVALID_INPUT");
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return errorResponse(c, 400, passwordLengthError("New password"), "INVALID_INPUT");
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");
    if (targetUser.role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can reset admin passwords", "FORBIDDEN");
    }

    const verified = await usersRepo.verifyPassword(targetUser.username, oldPassword);
    if (!verified) {
      return errorResponse(c, 401, "Old password is incorrect", "AUTH_FAILED");
    }

    const updated = await usersRepo.updatePassword(c.req.param("id"), newPassword);
    if (!updated) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "reset_password",
      resource: "user",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Set token limits
  router.put("/:id/limits", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsedInputLimit = parseOptionalTokenLimit(body?.inputLimit);
    const parsedOutputLimit = parseOptionalTokenLimit(body?.outputLimit);
    const { period } = body;
    const validPeriods: TokenLimitPeriod[] = ["daily", "monthly", "unlimited"];
    if (period && !validPeriods.includes(period)) {
      return errorResponse(c, 400, "Invalid period (daily, monthly, unlimited)", "INVALID_INPUT");
    }
    if (parsedInputLimit === INVALID_TOKEN_LIMIT || parsedOutputLimit === INVALID_TOKEN_LIMIT) {
      return errorResponse(
        c,
        400,
        "inputLimit and outputLimit must be non-negative safe integers or null",
        "INVALID_INPUT",
      );
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");
    if (targetUser.role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can change admin limits", "FORBIDDEN");
    }

    const updated = usersRepo.setTokenLimits(
      c.req.param("id"),
      parsedInputLimit,
      parsedOutputLimit,
      period ?? "monthly",
    );
    if (!updated) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "set_token_limits",
      resource: "user",
      resourceId: c.req.param("id"),
      details: JSON.stringify({ inputLimit: parsedInputLimit, outputLimit: parsedOutputLimit, period }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Update fine-grained user permissions
  router.put("/:id/permissions", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const { permissions } = body;
    const parsedPermissions = parseUserPermissionPatch(permissions);
    if (!parsedPermissions.ok) {
      return errorResponse(c, 400, parsedPermissions.error, "INVALID_INPUT");
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");
    if (targetUser.role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can change admin permissions", "FORBIDDEN");
    }

    const nextPermissions = applyUserPermissionPatch(
      targetUser.role,
      targetUser.permissions,
      parsedPermissions.patch,
    );
    const updated = usersRepo.setPermissions(c.req.param("id"), nextPermissions);
    if (!updated) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_user_permissions",
      resource: "user",
      resourceId: c.req.param("id"),
      details: JSON.stringify({ permissions: nextPermissions }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, permissions: nextPermissions });
  });

  // Update per-user security settings
  router.put("/:id/settings", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const { require2fa, clientCoordinationEnabled } = body;
    if (require2fa !== undefined && typeof require2fa !== "boolean") {
      return errorResponse(c, 400, "require2fa must be a boolean", "INVALID_INPUT");
    }
    if (clientCoordinationEnabled !== undefined && typeof clientCoordinationEnabled !== "boolean") {
      return errorResponse(c, 400, "clientCoordinationEnabled must be a boolean", "INVALID_INPUT");
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");
    if (targetUser.role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can change admin user settings", "FORBIDDEN");
    }

    if (typeof require2fa === "boolean") {
      usersRepo.setRequire2fa(targetUser.id, require2fa);
    }
    if (typeof clientCoordinationEnabled === "boolean") {
      usersRepo.setClientCoordinationEnabled(targetUser.id, clientCoordinationEnabled);
    }

    const updated = usersRepo.getById(targetUser.id);
    if (!updated) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_user_settings",
      resource: "user",
      resourceId: targetUser.id,
      details: JSON.stringify({
        require2fa: updated.require2fa,
        clientCoordinationEnabled: updated.clientCoordinationEnabled,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({
      ok: true,
      require2fa: updated.require2fa,
      clientCoordinationEnabled: updated.clientCoordinationEnabled,
    });
  });

  // Delete user (requires admin password confirmation)
  router.delete("/:id", async (c) => {
    const user = requirePermission(c, usersRepo, "manageUsers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    // Prevent deleting yourself
    if (c.req.param("id") === user.id) {
      return errorResponse(c, 400, "Cannot delete your own account", "INVALID_INPUT");
    }

    // Require password confirmation
    const body = await c.req.json().catch(() => ({}));
    const { password } = body as { password?: string };
    if (!password) {
      return errorResponse(c, 400, "Password confirmation is required", "INVALID_INPUT");
    }
    const verified = await usersRepo.verifyPassword(user.username, password);
    if (!verified) {
      return errorResponse(c, 401, "Invalid password", "AUTH_FAILED");
    }

    const targetUser = usersRepo.getById(c.req.param("id"));
    if (!targetUser) return errorResponse(c, 404, "User not found", "NOT_FOUND");
    if (targetUser.role === "admin" && user.role !== "admin") {
      return errorResponse(c, 403, "Only admins can delete admin users", "FORBIDDEN");
    }

    const deleted = usersRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "User not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "delete_user",
      resource: "user",
      resourceId: c.req.param("id"),
      details: JSON.stringify({ deletedUsername: targetUser.username }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
