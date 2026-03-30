import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AgentConfigCreate } from "@arkestrator/protocol";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { requirePermission, isAuthenticated, getClientIp } from "../middleware/auth.js";
import { AGENT_TEMPLATES } from "../data/agent-templates.js";
import { errorResponse } from "../utils/errors.js";
import { newId } from "../utils/id.js";
import { getConfiguredOllamaBaseUrl, listOllamaModels, pullOllamaModel, streamPullOllamaModel, type LocalModelInfo } from "../local-models/ollama.js";
import { getProviderModelCatalogs, injectPreferredTemplateModel } from "../agents/model-catalog.js";
import {
  buildLocalModelCatalog,
  getEffectiveLocalModelAllowlist,
  setStoredLocalModelAllowlist,
} from "../local-models/catalog.js";
import { resolveAnyAvailableWorkerLlm, resolveWorkerLocalLlmEndpoint } from "../local-models/distributed.js";
import { registerAgentCliAuthRoutes } from "./agent-cli-auth.js";

interface LocalModelRuntimeTarget {
  baseUrl: string;
  source: "server" | "worker";
  targetWorkerName?: string;
}

export function createAgentRoutes(
  agentsRepo: AgentsRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
  apiKeysRepo: ApiKeysRepo,
  settingsRepo: SettingsRepo,
  hub?: WebSocketHub,
  workersRepo?: WorkersRepo,
) {
  const router = new Hono();
  registerAgentCliAuthRoutes(router, agentsRepo, usersRepo, auditRepo);

  function broadcastAgentConfigs() {
    if (!hub) return;
    hub.broadcastToType("client", {
      type: "agent_config_list_response",
      id: newId(),
      payload: { configs: agentsRepo.list() },
    });
  }

  // Serve static agent config templates
  router.get("/templates", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    return c.json(AGENT_TEMPLATES.map((template) => injectPreferredTemplateModel(template)));
  });

  router.get("/model-catalogs", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    return c.json({ catalogs: getProviderModelCatalogs() });
  });

  router.get("/local-models", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const runtime = String(c.req.query("runtime") ?? "ollama").trim().toLowerCase();
    const targetWorkerName = String(c.req.query("targetWorkerName") ?? "").trim().toLowerCase();
    const host = String(c.req.query("host") ?? "").trim().toLowerCase();
    if (runtime !== "ollama") {
      return errorResponse(c, 400, `Unsupported local model runtime: ${runtime}`, "INVALID_INPUT");
    }

    let target: LocalModelRuntimeTarget;
    try {
      if (host === "client" && !targetWorkerName && workersRepo && hub) {
        // Auto-find any online worker with localLlmEnabled
        const resolution = await resolveAnyAvailableWorkerLlm(settingsRepo, workersRepo, hub);
        if (resolution && resolution.baseUrl) {
          target = { baseUrl: resolution.baseUrl, source: "worker", targetWorkerName: resolution.workerName };
        } else {
          return errorResponse(c, 404, "No online worker with local LLM enabled found", "NOT_FOUND");
        }
      } else {
        target = resolveLocalModelRuntimeTarget(targetWorkerName, workersRepo, settingsRepo);
      }
    } catch (err: any) {
      return errorResponse(c, 400, err?.message ?? "Invalid local model target", "INVALID_INPUT");
    }

    let models: LocalModelInfo[] = [];
    let ollamaReachable = false;
    try {
      models = await listOllamaModels(fetch, target.baseUrl);
      ollamaReachable = true;
    } catch {
      // Ollama not reachable — proceed with empty downloaded list.
      // The catalog will still include defaults + stored allowlist so
      // admins can manage the allowlist without a local Ollama.
    }
    const allowedModels = getEffectiveLocalModelAllowlist(settingsRepo, runtime, models);
    const catalog = buildLocalModelCatalog(models, allowedModels);
    return c.json({
      runtime,
      models,
      allowedModels,
      catalog,
      ollamaReachable,
      source: target.source,
      targetWorkerName: target.targetWorkerName ?? null,
    });
  });

  router.put("/local-models/allowlist", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const runtime = String(body?.runtime ?? "ollama").trim().toLowerCase();
    const targetWorkerName = String(body?.targetWorkerName ?? "").trim().toLowerCase();
    if (runtime !== "ollama") {
      return errorResponse(c, 400, `Unsupported local model runtime: ${runtime}`, "INVALID_INPUT");
    }
    if (!Array.isArray(body?.models)) {
      return errorResponse(c, 400, "models must be an array of model names", "INVALID_INPUT");
    }

    const allowedModels = setStoredLocalModelAllowlist(
      settingsRepo,
      runtime,
      body.models.map((value: unknown) => String(value ?? "")),
    );

    let target: LocalModelRuntimeTarget;
    try {
      target = resolveLocalModelRuntimeTarget(targetWorkerName, workersRepo, settingsRepo);
    } catch (err: any) {
      return errorResponse(c, 400, err?.message ?? "Invalid local model target", "INVALID_INPUT");
    }

    let downloadedModels: LocalModelInfo[] = [];
    let ollamaReachable = false;
    try {
      downloadedModels = await listOllamaModels(fetch, target.baseUrl);
      ollamaReachable = true;
    } catch {
      // Ollama not reachable — allowlist update still persists.
    }
    const catalog = buildLocalModelCatalog(downloadedModels, allowedModels);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_local_model_allowlist",
      resource: "agent_config",
      details: JSON.stringify({ runtime, allowedModels, targetWorkerName: targetWorkerName || null }),
      ipAddress: getClientIp(c),
    });

    return c.json({
      runtime,
      allowedModels,
      models: downloadedModels,
      catalog,
      ollamaReachable,
      source: targetWorkerName ? "worker" : "server",
      targetWorkerName: targetWorkerName || null,
    });
  });

  router.post("/local-models/pull", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const runtime = String(body?.runtime ?? "ollama").trim().toLowerCase();
    const model = String(body?.model ?? "").trim();
    const targetWorkerName = String(body?.targetWorkerName ?? "").trim().toLowerCase();
    if (!model) {
      return errorResponse(c, 400, "Model is required", "INVALID_INPUT");
    }
    if (runtime !== "ollama") {
      return errorResponse(c, 400, `Unsupported local model runtime: ${runtime}`, "INVALID_INPUT");
    }

    let target: LocalModelRuntimeTarget;
    try {
      target = resolveLocalModelRuntimeTarget(targetWorkerName, workersRepo, settingsRepo);
    } catch (err: any) {
      return errorResponse(c, 400, err?.message ?? "Invalid local model target", "INVALID_INPUT");
    }

    try {
      const result = await pullOllamaModel(model, fetch, target.baseUrl);
      auditRepo.log({
        userId: user.id,
        username: user.username,
        action: "pull_local_model",
        resource: "agent_config",
        details: JSON.stringify({ runtime, model, source: target.source, targetWorkerName: target.targetWorkerName ?? null }),
        ipAddress: getClientIp(c),
      });
      return c.json({
        runtime,
        model,
        result,
        source: target.source,
        targetWorkerName: target.targetWorkerName ?? null,
      });
    } catch (err: any) {
      return errorResponse(
        c,
        502,
        `${err?.message ?? "Failed to pull local model"} (endpoint: ${target.baseUrl})`,
        "INTERNAL_ERROR",
      );
    }
  });

  router.post("/local-models/pull/stream", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const runtime = String(body?.runtime ?? "ollama").trim().toLowerCase();
    const model = String(body?.model ?? "").trim();
    const targetWorkerName = String(body?.targetWorkerName ?? "").trim().toLowerCase();
    if (!model) {
      return errorResponse(c, 400, "Model is required", "INVALID_INPUT");
    }
    if (runtime !== "ollama") {
      return errorResponse(c, 400, `Unsupported local model runtime: ${runtime}`, "INVALID_INPUT");
    }

    let target: LocalModelRuntimeTarget;
    try {
      target = resolveLocalModelRuntimeTarget(targetWorkerName, workersRepo, settingsRepo);
    } catch (err: any) {
      return errorResponse(c, 400, err?.message ?? "Invalid local model target", "INVALID_INPUT");
    }

    return streamSSE(c, async (stream) => {
      try {
        await streamPullOllamaModel(model, async (event) => {
          const percent = (
            typeof event.total === "number"
            && event.total > 0
            && typeof event.completed === "number"
            && event.completed >= 0
          )
            ? Math.max(0, Math.min(100, Math.round((event.completed / event.total) * 100)))
            : undefined;

          await stream.writeSSE({
            event: "progress",
            data: JSON.stringify({
              ...event,
              progressPercent: percent,
            }),
          });
        }, fetch, target.baseUrl);

        auditRepo.log({
          userId: user.id,
          username: user.username,
          action: "pull_local_model",
          resource: "agent_config",
          details: JSON.stringify({ runtime, model, source: target.source, targetWorkerName: target.targetWorkerName ?? null }),
          ipAddress: getClientIp(c),
        });

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            runtime,
            model,
            ok: true,
            source: target.source,
            targetWorkerName: target.targetWorkerName ?? null,
          }),
        });
      } catch (err: any) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: err?.message ?? "Failed to pull local model",
          }),
        });
      }
    });
  });

  router.get("/", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const configs = agentsRepo.list();
    return c.json(configs);
  });

  router.get("/:id", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const config = agentsRepo.getById(c.req.param("id"));
    if (!config) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json(config);
  });

  router.post("/", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = AgentConfigCreate.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", { details: parsed.error.flatten() });
    }
    const config = agentsRepo.create(parsed.data);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "create_agent_config",
      resource: "agent_config",
      resourceId: config.id,
      details: JSON.stringify({ name: config.name, engine: config.engine }),
      ipAddress: getClientIp(c),
    });

    broadcastAgentConfigs();
    return c.json(config, 201);
  });

  router.put("/:id", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const id = c.req.param("id");
    const existing = agentsRepo.getById(id);
    if (!existing) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = AgentConfigCreate.partial().safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", { details: parsed.error.flatten() });
    }
    const updated = agentsRepo.update({ ...existing, ...parsed.data, id });

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_agent_config",
      resource: "agent_config",
      resourceId: id,
      details: JSON.stringify(body),
      ipAddress: getClientIp(c),
    });

    broadcastAgentConfigs();
    return c.json(updated);
  });

  router.delete("/:id", (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleteResult = agentsRepo.delete(c.req.param("id"));
    if (deleteResult === "not_found") return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (deleteResult === "has_jobs")
      return errorResponse(c, 409, "Cannot delete: this agent config has queued or running jobs. Wait for them to finish or cancel them first.", "CONFLICT");

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "delete_agent_config",
      resource: "agent_config",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    broadcastAgentConfigs();
    return c.json({ ok: true });
  });

  return router;
}

function resolveLocalModelRuntimeTarget(
  targetWorkerNameRaw: string,
  workersRepo: WorkersRepo | undefined,
  settingsRepo: SettingsRepo,
): LocalModelRuntimeTarget {
  const targetWorkerName = String(targetWorkerNameRaw ?? "").trim().toLowerCase();
  if (!targetWorkerName) {
    return {
      baseUrl: getConfiguredOllamaBaseUrl(settingsRepo),
      source: "server",
    };
  }

  if (!workersRepo) {
    throw new Error("Worker repository is unavailable for worker-targeted local model actions");
  }

  const resolution = resolveWorkerLocalLlmEndpoint(settingsRepo, workersRepo, targetWorkerName);
  if (!resolution.enabled) {
    throw new Error(resolution.reason || `Worker "${targetWorkerName}" local LLM is disabled`);
  }
  if (!resolution.baseUrl) {
    throw new Error(resolution.reason || `Worker "${targetWorkerName}" local LLM endpoint is not configured`);
  }

  return {
    baseUrl: resolution.baseUrl,
    source: "worker",
    targetWorkerName,
  };
}
