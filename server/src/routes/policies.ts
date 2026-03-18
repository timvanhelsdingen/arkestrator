import { Hono } from "hono";
import { PolicyCreate } from "@arkestrator/protocol";
import type { PolicyType, PolicyScope } from "@arkestrator/protocol";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import { requirePermission, getClientIp } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

export function createPolicyRoutes(
  policiesRepo: PoliciesRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
) {
  const router = new Hono();

  // List policies
  router.get("/", (c) => {
    const user = requirePermission(c, usersRepo, "managePolicies");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const type = c.req.query("type") as PolicyType | undefined;
    const scope = c.req.query("scope") as PolicyScope | undefined;
    const policies = policiesRepo.list({ type, scope });
    return c.json(policies);
  });

  // Create policy
  router.post("/", async (c) => {
    const user = requirePermission(c, usersRepo, "managePolicies");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = PolicyCreate.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }
    const { scope, userId, type, pattern, action, description } = parsed.data;

    if (scope === "user" && !userId) {
      return errorResponse(c, 400, "userId required for user-scoped policies", "INVALID_INPUT");
    }

    const policy = policiesRepo.create({
      scope,
      userId,
      type,
      pattern,
      action,
      description,
    });

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "create_policy",
      resource: "policy",
      resourceId: policy.id,
      details: JSON.stringify({ type, pattern, scope, action }),
      ipAddress: getClientIp(c),
    });

    return c.json(policy, 201);
  });

  // Update policy
  router.put("/:id", async (c) => {
    const user = requirePermission(c, usersRepo, "managePolicies");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = PolicyCreate.partial().safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", { details: parsed.error.flatten() });
    }
    const updated = policiesRepo.update(c.req.param("id"), parsed.data);
    if (!updated) return errorResponse(c, 404, "Policy not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_policy",
      resource: "policy",
      resourceId: c.req.param("id"),
      details: JSON.stringify(body),
      ipAddress: getClientIp(c),
    });

    return c.json(updated);
  });

  // Toggle policy enabled/disabled
  router.post("/:id/toggle", async (c) => {
    const user = requirePermission(c, usersRepo, "managePolicies");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const { enabled } = body;

    if (typeof enabled !== "boolean") {
      return errorResponse(c, 400, "enabled (boolean) is required", "INVALID_INPUT");
    }

    const toggled = policiesRepo.toggle(c.req.param("id"), enabled);
    if (!toggled) return errorResponse(c, 404, "Policy not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: enabled ? "enable_policy" : "disable_policy",
      resource: "policy",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Delete policy
  router.delete("/:id", (c) => {
    const user = requirePermission(c, usersRepo, "managePolicies");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleted = policiesRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "Policy not found", "NOT_FOUND");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "delete_policy",
      resource: "policy",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
