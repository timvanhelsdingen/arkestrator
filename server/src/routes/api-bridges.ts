import { Hono } from "hono";
import { z } from "zod";
import { McpConfig } from "@arkestrator/protocol";
import type { ApiBridgesRepo } from "../db/api-bridges.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import { requireAdmin, isAuthenticated } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

const ApiBridgeCreateSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  displayName: z.string().trim().min(1).max(128),
  type: z.enum(["preset", "custom"]),
  presetId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  authType: z.enum(["bearer", "header", "query", "none"]).default("bearer"),
  authHeader: z.string().default("Authorization"),
  authPrefix: z.string().default("Bearer "),
  apiKey: z.string().optional(),
  endpoints: z.record(z.string(), z.any()).default({}),
  defaultOptions: z.record(z.string(), z.unknown()).default({}),
  pollConfig: z.any().optional(),
  mcpConfig: McpConfig.nullish(),
  enabled: z.boolean().default(true),
});

const ApiBridgeUpdateSchema = ApiBridgeCreateSchema.partial().extend({
  apiKey: z.string().optional(),
});

export function createApiBridgeRoutes(
  apiBridgesRepo: ApiBridgesRepo,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
) {
  const router = new Hono();

  // List all configured API bridges (keys masked)
  router.get("/", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const bridges = apiBridgesRepo.list();
    // Add hasApiKey flag without exposing the actual key
    const result = bridges.map((b) => ({
      ...b,
      hasApiKey: !!apiBridgesRepo.getApiKey(b.id),
    }));
    return c.json(result);
  });

  // List available preset templates (public — no sensitive data, needed by wizard before full auth)
  router.get("/presets", async (_c) => {
    // Dynamic import to ensure presets are registered
    const { listPresets, refreshRemotePresets } = await import("../api-bridges/index.js");
    // Ensure remote presets are loaded (uses cache if fresh)
    await refreshRemotePresets();
    return _c.json(listPresets());
  });

  // Force-refresh presets from GitHub (admin only)
  router.post("/presets/refresh", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const { forceRefreshRemotePresets, listPresets } = await import("../api-bridges/index.js");
    await forceRefreshRemotePresets();
    return c.json(listPresets());
  });

  // Get single bridge
  router.get("/:id", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const bridge = apiBridgesRepo.getById(c.req.param("id"));
    if (!bridge) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json({
      ...bridge,
      hasApiKey: !!apiBridgesRepo.getApiKey(bridge.id),
    });
  });

  // Create bridge
  router.post("/", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsed = ApiBridgeCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    // baseUrl required for non-MCP bridges
    if (!parsed.data.mcpConfig && !parsed.data.baseUrl) {
      return errorResponse(c, 400, "baseUrl is required for non-MCP bridges", "VALIDATION_ERROR");
    }

    if (apiBridgesRepo.nameExists(parsed.data.name)) {
      return errorResponse(c, 409, `Bridge name '${parsed.data.name}' already exists`, "CONFLICT");
    }

    // Validate preset ID if type is preset (accept both local handlers and remote presets)
    if (parsed.data.type === "preset" && parsed.data.presetId) {
      const { isKnownPreset } = await import("../api-bridges/index.js");
      if (!isKnownPreset(parsed.data.presetId)) {
        return errorResponse(c, 400, `Unknown preset: ${parsed.data.presetId}`, "BAD_REQUEST");
      }
    }

    const { apiKey, ...configData } = parsed.data;
    const created = apiBridgesRepo.create(configData, apiKey);
    return c.json({ ...created, hasApiKey: !!apiKey }, 201);
  });

  // Update bridge
  router.put("/:id", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const parsed = ApiBridgeUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    const id = c.req.param("id");

    // Check name uniqueness if changing name
    if (parsed.data.name && apiBridgesRepo.nameExists(parsed.data.name, id)) {
      return errorResponse(c, 409, `Bridge name '${parsed.data.name}' already exists`, "CONFLICT");
    }

    // Handle API key update separately
    if (parsed.data.apiKey !== undefined) {
      apiBridgesRepo.setApiKey(id, parsed.data.apiKey || null);
    }

    const { apiKey, ...updateData } = parsed.data;
    const updated = apiBridgesRepo.update(id, updateData);
    if (!updated) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json({ ...updated, hasApiKey: !!apiBridgesRepo.getApiKey(id) });
  });

  // Delete bridge
  router.delete("/:id", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleted = apiBridgesRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json({ ok: true });
  });

  // Test connectivity
  router.post("/:id/test", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const bridge = apiBridgesRepo.getById(c.req.param("id"));
    if (!bridge) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    // MCP bridge test: connect and list tools
    if (bridge.mcpConfig) {
      try {
        const { McpBridgeHandler } = await import("../api-bridges/mcp-handler.js");
        const handler = new McpBridgeHandler();
        const actions = await handler.getActionsForConfig(bridge.mcpConfig);
        return c.json({
          ok: true,
          tools: actions.length,
          toolNames: actions.map((a) => a.name),
        });
      } catch (err: any) {
        return c.json({ ok: false, error: err.message ?? String(err) });
      }
    }

    // REST API bridge test
    const apiKey = apiBridgesRepo.getApiKey(bridge.id);
    if (!apiKey && bridge.authType !== "none") {
      return c.json({ ok: false, error: "No API key configured" });
    }

    try {
      const { buildAuthHeaders } = await import("../api-bridges/handler.js");
      const headers = buildAuthHeaders(bridge, apiKey ?? "");

      // Simple connectivity test — hit the base URL
      const response = await fetch(bridge.baseUrl!, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      return c.json({
        ok: response.status < 500,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // List actions for a bridge
  router.get("/:id/actions", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const bridge = apiBridgesRepo.getById(c.req.param("id"));
    if (!bridge) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    // MCP bridges: list tools dynamically
    if (bridge.mcpConfig) {
      try {
        const { McpBridgeHandler } = await import("../api-bridges/mcp-handler.js");
        const handler = new McpBridgeHandler();
        return c.json(await handler.getActionsForConfig(bridge.mcpConfig));
      } catch (err: any) {
        return c.json([]);
      }
    }

    if (bridge.type === "preset" && bridge.presetId) {
      const { getPresetHandler } = await import("../api-bridges/index.js");
      const handler = getPresetHandler(bridge.presetId);
      if (handler) {
        return c.json(handler.getActions());
      }
    }

    // For custom bridges, return endpoint names as actions
    return c.json(
      Object.entries(bridge.endpoints).map(([name, endpoint]) => ({
        name,
        description: `${endpoint.method} ${endpoint.path}`,
        parameters: {},
      })),
    );
  });

  return router;
}
