import { hostname } from "node:os";
import { Hono } from "hono";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { ApiBridgesRepo } from "../db/api-bridges.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { isAuthenticated, requirePermission, getClientIp } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { getWorkerRule, updateWorkerRule } from "../security/worker-rules.js";
import { enrichWorkersWithLivePresence } from "../utils/worker-status.js";
import { ensureLiveWorkersPersisted } from "../utils/live-workers.js";
import {
  checkWorkerLocalLlmHealth,
  resolveWorkerLocalLlmEndpoint,
} from "../local-models/distributed.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function createWorkerRoutes(
  workersRepo: WorkersRepo,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
  auditRepo: AuditRepo,
  hub: WebSocketHub,
  settingsRepo: SettingsRepo,
  apiBridgesRepo?: ApiBridgesRepo,
) {
  const router = new Hono();

  /** GET /api/workers — list all workers enriched with live status */
  router.get("/", async (c) => {
    if (!(await isAuthenticated(c, usersRepo, apiKeysRepo))) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const bridges = hub.getBridges();
    const clients = hub.getClients();
    ensureLiveWorkersPersisted(workersRepo, bridges, clients);
    const allWorkers = workersRepo.list();

    // Collect virtual bridge programs keyed by the worker they belong to
    const virtualProgramsByWorker = new Map<string, string[]>();
    for (const vb of hub.getVirtualBridges()) {
      const workerKey = (vb.workerName ?? hostname()).toLowerCase();
      const existing = virtualProgramsByWorker.get(workerKey) ?? [];
      existing.push(vb.program);
      virtualProgramsByWorker.set(workerKey, existing);
    }

    const enriched = enrichWorkersWithLivePresence(allWorkers, bridges, clients).map((worker) => {
      // Merge virtual bridge programs into knownPrograms for the matching worker
      const virtualPrograms = virtualProgramsByWorker.get(worker.name.toLowerCase()) ?? [];
      const mergedPrograms = [...new Set([...(worker.knownPrograms ?? []), ...virtualPrograms])];
      return {
        ...worker,
        knownPrograms: mergedPrograms,
        rule: getWorkerRule(settingsRepo, worker.name),
      };
    });

    // Include bridge list so clients can update both workers and bridges in one call.
    // getBridges() includes both real WebSocket bridges and virtual HTTP bridges (e.g. ComfyUI).
    const bridgeList: any[] = bridges.map((b) => ({
      id: b.id,
      name: b.name ?? b.id,
      type: "bridge",
      connected: true,
      lastSeen: new Date().toISOString(),
      program: b.program,
      programVersion: b.programVersion,
      bridgeVersion: b.bridgeVersion,
      projectPath: b.projectPath,
      activeProjects: Array.isArray(b.activeProjects)
        ? b.activeProjects
        : (b.projectPath ? [b.projectPath] : []),
      machineId: b.machineId,
      workerName: b.workerName,
      ip: b.ip,
      connectedAt: b.connectedAt as string | undefined,
      osUser: b.osUser as string | undefined,
    }));
    const connectedKeys = new Set(
      bridgeList.filter((b) => b.connected).map((b) => `${String(b.machineId ?? b.workerName ?? "").toLowerCase()}:${String(b.program ?? "").toLowerCase()}`),
    );
    for (const worker of allWorkers) {
      const history = workersRepo.getBridgesForWorker(worker.name, worker.machineId);
      for (const entry of history) {
        const key = `${String(worker.machineId ?? worker.name).toLowerCase()}:${String(entry.program ?? "").toLowerCase()}`;
        if (connectedKeys.has(key)) continue;
        bridgeList.push({
          id: `offline:${worker.name}:${entry.program}`,
          name: `${entry.program} (offline)`,
          type: "bridge",
          connected: false,
          lastSeen: entry.last_seen_at,
          program: entry.program,
          programVersion: entry.program_version ?? undefined,
          bridgeVersion: entry.bridge_version ?? undefined,
          projectPath: entry.project_path ?? undefined,
          activeProjects: entry.project_path ? [entry.project_path] : [],
          machineId: worker.machineId,
          workerName: worker.name,
          ip: worker.lastIp,
          connectedAt: undefined,
          osUser: undefined,
        });
      }
    }

    // Inject a virtual "Server" worker for cloud API bridges (Meshy, Stability, etc.)
    // Exclude bridges that are already tracked as virtual bridges in the hub (e.g. ComfyUI)
    // since those show under the machine worker where they run.
    const enabledApiBridges = apiBridgesRepo?.listEnabled() ?? [];
    const virtualBridgePrograms = new Set(
      hub.getVirtualBridges().map((vb) => vb.program.toLowerCase()),
    );
    const serverOnlyBridges = enabledApiBridges.filter(
      (ab) => !virtualBridgePrograms.has(ab.name.toLowerCase()),
    );
    if (serverOnlyBridges.length > 0) {
      const serverName = "Arkestrator Server";
      const now = new Date().toISOString();
      const apiBridgePrograms = serverOnlyBridges.map((b) => b.displayName);

      enriched.push({
        id: "server-worker",
        name: serverName,
        status: "online",
        activeBridgeCount: serverOnlyBridges.length,
        knownPrograms: apiBridgePrograms,
        workerModeEnabled: true,
        isServerWorker: true,
        firstSeenAt: now,
        lastSeenAt: now,
        rule: getWorkerRule(settingsRepo, serverName),
      });

      for (const ab of serverOnlyBridges) {
        const hasKey = !!apiBridgesRepo!.getApiKey(ab.id);
        bridgeList.push({
          id: `api-bridge:${ab.name}`,
          name: ab.displayName,
          type: "bridge",
          connected: ab.enabled && hasKey,
          lastSeen: ab.updatedAt,
          program: ab.displayName,
          bridgeVersion: "api-bridge",
          workerName: serverName,
          connectedAt: ab.enabled && hasKey ? ab.updatedAt : undefined,
        });
      }
    }

    return c.json({ workers: enriched, bridges: bridgeList });
  });

  /** DELETE /api/workers/bridges-by-program/:program — remove all bridge history for a program */
  router.delete("/bridges-by-program/:program", (c) => {
    const user = requirePermission(c, usersRepo, "manageWorkers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const program = c.req.param("program");
    if (!/^[a-zA-Z0-9_-]+$/.test(program)) {
      return errorResponse(c, 400, "Invalid program name", "INVALID_INPUT");
    }

    const deleted = workersRepo.deleteBridgesByProgram(program);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "delete_bridges_by_program",
      resource: "worker",
      resourceId: program,
      details: JSON.stringify({ program, deleted }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, program, deleted });
  });

  /** PUT /api/workers/:id/rules — manage per-worker machine rules (manageWorkers permission) */
  router.put("/:id/rules", async (c) => {
    const user = requirePermission(c, usersRepo, "manageWorkers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const worker = workersRepo.getById(c.req.param("id"));
    if (!worker) return errorResponse(c, 404, "Worker not found", "NOT_FOUND");

    if (body.banned !== undefined && typeof body.banned !== "boolean") {
      return errorResponse(c, 400, "banned must be a boolean", "INVALID_INPUT");
    }
    if (
      body.clientCoordinationAllowed !== undefined
      && typeof body.clientCoordinationAllowed !== "boolean"
    ) {
      return errorResponse(c, 400, "clientCoordinationAllowed must be a boolean", "INVALID_INPUT");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return errorResponse(c, 400, "note must be a string", "INVALID_INPUT");
    }
    if (body.localLlmEnabled !== undefined && typeof body.localLlmEnabled !== "boolean") {
      return errorResponse(c, 400, "localLlmEnabled must be a boolean", "INVALID_INPUT");
    }
    if (body.localLlmBaseUrl !== undefined && typeof body.localLlmBaseUrl !== "string") {
      return errorResponse(c, 400, "localLlmBaseUrl must be a string", "INVALID_INPUT");
    }
    if (body.ipAllowlist !== undefined && !isStringArray(body.ipAllowlist)) {
      return errorResponse(c, 400, "ipAllowlist must be an array of strings", "INVALID_INPUT");
    }
    if (body.ipDenylist !== undefined && !isStringArray(body.ipDenylist)) {
      return errorResponse(c, 400, "ipDenylist must be an array of strings", "INVALID_INPUT");
    }

    const rule = updateWorkerRule(settingsRepo, worker.name, {
      banned: body.banned,
      clientCoordinationAllowed: body.clientCoordinationAllowed,
      note: body.note,
      ipAllowlist: body.ipAllowlist,
      ipDenylist: body.ipDenylist,
      localLlmEnabled: body.localLlmEnabled,
      localLlmBaseUrl: body.localLlmBaseUrl,
    });

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "update_worker_rules",
      resource: "worker",
      resourceId: worker.id,
      details: JSON.stringify({
        workerName: worker.name,
        banned: rule.banned,
        clientCoordinationAllowed: rule.clientCoordinationAllowed,
        ipAllowlist: rule.ipAllowlist,
        ipDenylist: rule.ipDenylist,
        localLlmEnabled: rule.localLlmEnabled,
        localLlmBaseUrl: rule.localLlmBaseUrl,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, rule });
  });

  /** GET /api/workers/:id/local-llm-check — check distributed local LLM endpoint health for one worker */
  router.get("/:id/local-llm-check", async (c) => {
    const user = requirePermission(c, usersRepo, "manageWorkers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const worker = workersRepo.getById(c.req.param("id"));
    if (!worker) return errorResponse(c, 404, "Worker not found", "NOT_FOUND");
    const timeoutMsRaw = Number(c.req.query("timeoutMs"));
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(300, Math.min(15_000, Math.round(timeoutMsRaw)))
      : 4_000;

    const resolution = resolveWorkerLocalLlmEndpoint(settingsRepo, workersRepo, worker.name);
    if (!resolution.enabled || !resolution.baseUrl) {
      return c.json({
        ok: false,
        workerName: worker.name,
        resolution,
        health: null,
      });
    }
    const health = await checkWorkerLocalLlmHealth(resolution.baseUrl, timeoutMs);
    return c.json({
      ok: health.ok,
      workerName: worker.name,
      resolution,
      health,
    });
  });

  /** DELETE /api/workers/:id — admin only */
  router.delete("/:id", (c) => {
    const user = requirePermission(c, usersRepo, "manageWorkers");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const worker = workersRepo.getById(c.req.param("id"));
    if (!worker) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    workersRepo.delete(c.req.param("id"));

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "delete_worker",
      resource: "worker",
      resourceId: c.req.param("id"),
      details: JSON.stringify({ name: worker.name }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
