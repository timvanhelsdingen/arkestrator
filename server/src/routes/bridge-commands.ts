import { Hono } from "hono";
import type { BridgeExecutionMode } from "@arkestrator/protocol";
import type { WebSocketHub } from "../ws/hub.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { Config } from "../config.js";
import type { WorkerResourceLeaseManager } from "../agents/resource-control.js";
import { checkCommandScripts } from "../policies/enforcer.js";
import { executeWorkerHeadlessCommands, runWorkerHeadlessCheck } from "../agents/worker-headless.js";
import { executeComfyUiHeadless } from "../agents/comfyui-headless.js";
import {
  formatHeavyResourceConflictError,
  inferBridgeCommandHeavyResources,
  resolveBridgeTargets,
} from "../agents/resource-control.js";
import {
  getAuthPrincipal,
  principalHasPermission,
  type AuthPrincipal,
} from "../middleware/auth.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";

const DEFAULT_TIMEOUT_MS = 60_000; // 60s
const MAX_TIMEOUT_MS = 300_000; // 5min
const HEADLESS_DEFAULT_TIMEOUT_MS = 30_000; // 30s
const HEADLESS_MAX_TIMEOUT_MS = 120_000; // 2min

export interface BridgeCommandParams {
  target: string;
  targetType?: "program" | "id";
  commands: Array<{ language: string; script: string; description?: string }>;
  projectPath?: string;
  timeout?: number;
  executionMode?: BridgeExecutionMode;
  targetWorkerName?: string;
}

export interface BridgeCommandResult {
  result?: any;
  error?: string;
  status?: number;
  /** Bridge programs that were used (for job tagging). Only set on success. */
  bridgesUsed?: string[];
}

export interface BridgeContextSnapshot {
  bridgeId: string;
  program?: string;
  workerName?: string;
  projectPath?: string;
  activeProjects?: string[];
  editorContext: unknown | null;
  files: unknown[];
  contextItems: unknown[];
}

export interface HeadlessCheckParams {
  program: string;
  args: string[];
  projectPath?: string;
  timeout?: number;
}

export interface HeadlessCheckResult {
  output?: string;
  error?: string;
  status?: number;
}

function evaluateBridgeExecutionResult(obj: any): { ok: boolean; reason?: string } {
  if (!obj || obj.success !== true) {
    const reason = typeof obj?.error === "string" && obj.error.trim()
      ? obj.error
      : "Bridge execution reported failure";
    return { ok: false, reason };
  }
  const executed = Number(obj.executed ?? 0);
  const failed = Number(obj.failed ?? 0);
  const skipped = Number(obj.skipped ?? 0);
  const errors = Array.isArray(obj.errors)
    ? obj.errors.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
    : [];

  if (Number.isFinite(failed) && failed > 0) {
    return {
      ok: false,
      reason: errors.length > 0 ? errors.join("; ") : `Bridge reported ${failed} failed command(s)`,
    };
  }
  if (Number.isFinite(skipped) && skipped > 0) {
    return {
      ok: false,
      reason: errors.length > 0 ? errors.join("; ") : `Bridge skipped ${skipped} command(s)`,
    };
  }
  if (Number.isFinite(executed) && executed <= 0) {
    return {
      ok: false,
      reason: "Bridge reported zero executed commands",
    };
  }
  return { ok: true };
}

/**
 * Core bridge command execution logic — shared by REST, MCP, and CLI.
 * Handles policy checking, bridge discovery, headless fallback, and correlation-based async.
 */
export async function executeBridgeCommand(
  hub: WebSocketHub,
  policiesRepo: PoliciesRepo,
  headlessProgramsRepo: HeadlessProgramsRepo,
  config: Config,
  params: BridgeCommandParams,
  resourceLeaseManager?: WorkerResourceLeaseManager,
  settingsRepo?: SettingsRepo,
): Promise<BridgeCommandResult> {
  const { target, targetType = "program", commands, projectPath, timeout, executionMode, targetWorkerName } = params;

  if (!target || typeof target !== "string") {
    return { error: "Missing or invalid 'target' field", status: 400 };
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    return { error: "Missing or empty 'commands' array", status: 400 };
  }
  for (const cmd of commands) {
    if (!cmd.language || !cmd.script) {
      return { error: "Each command must have 'language' and 'script' fields", status: 400 };
    }
  }

  // Check command scripts against command_filter policies
  const policies = policiesRepo.getEffectiveForUser(null);
  const cmdViolations = checkCommandScripts(commands, policies);
  const blockers = cmdViolations.filter((v) => v.action === "block");
  if (blockers.length > 0) {
    return {
      error: "Command blocked by policy",
      result: {
        violations: blockers.map((v) => ({
          pattern: v.pattern,
          message: v.message,
          description: v.description,
        })),
      },
      status: 403,
    };
  }

  const timeoutMs = Math.min(
    Math.max(typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );

  // Prefer headless if explicitly requested, or if server-level setting is on (and not targeting by bridge ID)
  const serverPreferHeadless = settingsRepo?.getBool("prefer_headless_bridges") ?? false;
  const preferHeadless = targetType !== "id" && (
    executionMode === "headless" ||
    (serverPreferHeadless && executionMode !== "live")
  );

  // Find target bridges
  const resolvedTargets = preferHeadless
    ? { targets: [], workerKeys: [] }
    : resolveBridgeTargets(hub, target, targetType, targetWorkerName);
  let targets: any[] = resolvedTargets.targets;

  if (targets.length === 0) {
    if (targetType !== "id") {
      const workerResult = await executeWorkerHeadlessCommands({
        hub,
        headlessProgramsRepo,
        resourceLeaseManager,
        program: target,
        commands: commands as any,
        timeoutMs,
        projectPath,
        targetWorkerName,
        leaseOwnerId: `bridge-command:${target}:${Date.now()}`,
        leaseOwnerLabel: `bridge command ${target}`,
      });
      if (workerResult.handled) {
        if (!workerResult.success) {
          return { error: workerResult.error || "Headless execution failed", result: workerResult.result, status: 409 };
        }
        return { result: workerResult.result, bridgesUsed: [target] };
      }

      // ComfyUI-specific fallback: talk directly to its HTTP REST API
      if (!workerResult.handled && target.toLowerCase() === "comfyui" && config.comfyuiUrl) {
        try {
          const comfyResult = await executeComfyUiHeadless(commands as any, config.comfyuiUrl, { timeoutMs });
          if (!comfyResult.success) {
            return { error: comfyResult.errors.join("; ") || "ComfyUI execution failed", result: comfyResult, status: 409 };
          }
          return { result: comfyResult, bridgesUsed: ["comfyui"] };
        } catch (err: any) {
          logger.warn("bridge-commands", `ComfyUI HTTP fallback failed: ${err?.message ?? err}`);
          // Fall through to the normal "no bridge found" error
        }
      }
    }

    if (resolvedTargets.error) {
      return {
        error: resolvedTargets.error,
        status: 404,
      };
    }

    const bridges = hub.getBridges();
    const available = bridges.map((b) => b.program).filter(Boolean);
    return {
      error: executionMode === "headless"
        ? `Headless execution requested for target: ${target}, but no eligible desktop client can execute it`
        : `No connected bridge found for target: ${target}`,
      result: { availableBridges: [...new Set(available)] },
      status: 404,
    };
  }

  const resources = inferBridgeCommandHeavyResources(target, commands as any);
  if (resources.length > 0 && resolvedTargets.workerKeys.length !== 1) {
    return {
      error: `Heavy ${target} execution resolves to multiple workers (${resolvedTargets.workerKeys.join(", ")}); specify targetWorkerName or targetType:"id" before launching it.`,
      status: 409,
    };
  }
  const acquired = resourceLeaseManager?.acquire(
    resolvedTargets.workerKeys,
    resources,
    {
      ownerId: `bridge-command:${target}:${Date.now()}`,
      ownerLabel: `bridge command ${target}`,
      program: target,
    },
  );
  if (acquired && !acquired.ok) {
    return {
      error: formatHeavyResourceConflictError(acquired.conflict, target),
      status: 409,
    };
  }

  // Generate a correlationId and register the pending command
  const correlationId = newId();
  const resultPromise = hub.registerPendingCommand(correlationId, timeoutMs);
  let metadataChanged = false;

  for (const targetWs of targets) {
    if (projectPath) {
      metadataChanged = hub.recordBridgeProjectPath(targetWs.data.id, projectPath) || metadataChanged;
    }
    targetWs.send(
      JSON.stringify({
        type: "bridge_command",
        id: newId(),
        payload: {
          senderId: "rest-api",
          commands,
          correlationId,
          projectPath,
        },
      }),
    );
  }

  if (metadataChanged) {
    hub.broadcastBridgeStatus();
  }

  logger.info(
    "bridge-cmd",
    `Bridge command sent to ${targets.length} bridge(s) targeting "${target}" (correlation: ${correlationId})`,
  );

  const bridgesUsed = [...new Set(targets.map((t: any) => t.data?.program).filter(Boolean))] as string[];

  try {
    const result = await resultPromise;
    const verdict = evaluateBridgeExecutionResult(result);
    if (!verdict.ok) {
      return {
        error: verdict.reason || "Bridge execution failed",
        result,
        bridgesUsed,
        status: 409,
      };
    }
    return { result, bridgesUsed };
  } catch (err: any) {
    return { error: err.message || "Bridge command failed", bridgesUsed, status: 504 };
  } finally {
    acquired?.ok && acquired.lease.release();
  }
}

/**
 * List currently connected bridges (real WebSocket + virtual HTTP-based).
 */
export function listConnectedBridges(hub: WebSocketHub) {
  return hub.getBridges().map((b) => ({
    id: b.id,
    program: b.program,
    programVersion: b.programVersion,
    workerName: b.workerName,
    projectPath: b.projectPath,
    activeProjects: Array.isArray(b.activeProjects)
      ? b.activeProjects
      : (b.projectPath ? [b.projectPath] : []),
    connectedAt: b.connectedAt,
  }));
}

/**
 * Get live editor/context payloads for all connected bridges of a given program.
 */
export function getBridgeContexts(hub: WebSocketHub, target: string): BridgeContextSnapshot[] {
  const bridges = hub.getBridgesByProgram(target);
  return bridges.map((ws: any) => {
    const ctx = hub.getBridgeContext(ws.data.id);
    return {
      bridgeId: ws.data.id,
      program: ws.data.program,
      workerName: ws.data.workerName,
      projectPath: ws.data.projectPath,
      activeProjects: Array.isArray(ws.data.activeProjects)
        ? ws.data.activeProjects
        : (ws.data.projectPath ? [ws.data.projectPath] : []),
      editorContext: ctx?.editorContext ?? null,
      files: ctx?.files ?? [],
      contextItems: ctx?.items ?? [],
    };
  });
}

/**
 * Shared headless checker (used by REST + MCP).
 */
export async function runHeadlessCheck(
  hub: WebSocketHub,
  headlessProgramsRepo: HeadlessProgramsRepo,
  resourceLeaseManager: WorkerResourceLeaseManager | undefined,
  params: HeadlessCheckParams & { targetWorkerName?: string },
): Promise<HeadlessCheckResult> {
  const { program, args, projectPath, timeout } = params;
  if (!program || typeof program !== "string") {
    return { error: "Missing or invalid 'program' field", status: 400 };
  }
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== "string")) {
    return { error: "Missing or invalid 'args' array (must be string[])", status: 400 };
  }

  const timeoutMs = Math.min(
    Math.max(typeof timeout === "number" ? timeout : HEADLESS_DEFAULT_TIMEOUT_MS, 1000),
    HEADLESS_MAX_TIMEOUT_MS,
  );
  return await runWorkerHeadlessCheck({
    hub,
    headlessProgramsRepo,
    resourceLeaseManager,
    program,
    args,
    timeoutMs,
    projectPath,
    targetWorkerName: params.targetWorkerName,
    leaseOwnerId: `headless-check:${program}:${Date.now()}`,
    leaseOwnerLabel: `headless check ${program}`,
  });
}

/**
 * POST /api/bridge-command
 * GET  /api/bridge-command/bridges
 */
export function createBridgeCommandRoutes(
  hub: WebSocketHub,
  apiKeysRepo: ApiKeysRepo,
  usersRepo: UsersRepo,
  policiesRepo: PoliciesRepo,
  headlessProgramsRepo: HeadlessProgramsRepo,
  config: Config,
  jobsRepo?: JobsRepo,
  resourceLeaseManager?: WorkerResourceLeaseManager,
  settingsRepo?: SettingsRepo,
) {
  const app = new Hono();

  async function authenticate(c: any): Promise<AuthPrincipal | null> {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;
    // Bridge-role API keys connect via WebSocket, not REST command routes
    if (principal.kind === "apiKey" && principal.apiKey.role === "bridge") return null;
    return principal;
  }

  app.post("/", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!principalHasPermission(principal, "executeCommands")) {
      return errorResponse(c, 403, "Missing executeCommands permission", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const callerJobId = String(c.req.header("x-job-id") ?? "").trim();
    const callerJob = callerJobId && jobsRepo ? jobsRepo.getById(callerJobId) : null;
    const executionMode = callerJob?.runtimeOptions?.bridgeExecutionMode;
    if (executionMode === "headless" && body.targetType === "id") {
      return errorResponse(
        c,
        400,
        "Headless execution is only supported for program targets, not a specific live bridge id",
        "INVALID_INPUT",
      );
    }

    // Only fall back to the caller job's targetWorkerName when the request body
    // doesn't specify its own worker targeting AND isn't targeting a specific
    // bridge by ID. When targetType is "id", injecting a worker name causes
    // resolution failures if the bridge isn't on that worker.
    const inheritCallerWorker = body.targetType !== "id" && !body.targetWorkerName && !body.target_worker;
    const result = await executeBridgeCommand(hub, policiesRepo, headlessProgramsRepo, config, {
      ...body,
      projectPath: body.projectPath ?? body.project_path,
      executionMode,
      targetWorkerName: body.targetWorkerName ?? body.target_worker ?? (inheritCallerWorker ? callerJob?.targetWorkerName : undefined),
    }, resourceLeaseManager, settingsRepo);

    // Track bridge usage regardless of success/failure — the bridge was used either way.
    if (callerJobId && jobsRepo && Array.isArray(result.bridgesUsed) && result.bridgesUsed.length > 0) {
      let changed = false;
      for (const program of result.bridgesUsed) {
        if (!program) continue;
        const updated = jobsRepo.addUsedBridge(callerJobId, program);
        changed = changed || updated;
      }
      if (changed) {
        const updatedJob = jobsRepo.getById(callerJobId);
        if (updatedJob) {
          hub.broadcastToType("client", {
            type: "job_updated",
            id: newId(),
            payload: { job: updatedJob },
          });
        }
      }
    }

    if (result.error) {
      const status = result.status ?? 500;
      const code = status === 403 ? "POLICY_BLOCKED" as const : status === 404 ? "NOT_FOUND" as const : "INTERNAL_ERROR" as const;
      return errorResponse(c, status, result.error, code, result.result);
    }

    return c.json(result.result);
  });

  app.get("/bridges", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    return c.json({ bridges: listConnectedBridges(hub) });
  });

  // Get full bridge context by target program (parity with MCP get_bridge_context)
  app.get("/context/:target", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const target = c.req.param("target");
    if (!target) {
      return errorResponse(c, 400, "Missing target program", "INVALID_INPUT");
    }

    const contexts = getBridgeContexts(hub, target);
    if (contexts.length === 0) {
      const available = [...new Set(hub.getBridges().map((b) => b.program).filter(Boolean))];
      return errorResponse(c, 404, `No bridge connected for: ${target}`, "NOT_FOUND", { availableBridges: available });
    }
    return c.json({ contexts });
  });

  // Run headless checks (parity with MCP run_headless_check)
  app.post("/headless-check", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const result = await runHeadlessCheck(hub, headlessProgramsRepo, resourceLeaseManager, {
      program: body.program,
      args: body.args,
      projectPath: body.projectPath ?? body.project_path,
      timeout: body.timeout,
      targetWorkerName: body.targetWorkerName ?? body.target_worker,
    });

    if (result.error) {
      const status = result.status ?? 500;
      const code = status === 404 ? "NOT_FOUND" as const : "INTERNAL_ERROR" as const;
      return errorResponse(c, status, result.error, code);
    }
    return c.json({ output: result.output });
  });

  // --- File Delivery (cross-machine asset transfer) ---
  // POST /api/bridge-command/file-deliver
  // Sends files to a target bridge or client via WebSocket.
  app.post("/file-deliver", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!principalHasPermission(principal, "deliverFiles")) {
      return errorResponse(c, 403, "Missing deliverFiles permission", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const target = String(body.target ?? "").trim();
    const targetType = String(body.targetType ?? body.target_type ?? "program").trim();
    const files = body.files;
    const projectPath = body.projectPath ?? body.project_path;
    const targetWorkerName = body.targetWorkerName ?? body.target_worker;

    if (!target) {
      return errorResponse(c, 400, "Missing 'target' field", "INVALID_INPUT");
    }
    if (!Array.isArray(files) || files.length === 0) {
      return errorResponse(c, 400, "Missing or empty 'files' array", "INVALID_INPUT");
    }

    const deliverPayload = {
      type: "file_deliver" as const,
      id: newId(),
      payload: { files, projectPath, source: body.source },
    };

    let delivered = 0;

    // Try bridges first
    if (targetType === "program" || targetType === "id") {
      const resolved = resolveBridgeTargets(hub, target, targetType as "program" | "id", targetWorkerName);
      for (const ws of resolved.targets) {
        ws.send(JSON.stringify(deliverPayload));
        delivered++;
      }
    }

    // Also try clients (by worker name)
    if (targetType === "worker" || (delivered === 0 && targetType === "program")) {
      const clientTarget = targetType === "worker" ? target : targetWorkerName;
      if (clientTarget) {
        for (const client of hub.getClients()) {
          const workerName = String(client.workerName ?? "").trim().toLowerCase();
          if (workerName === clientTarget.toLowerCase()) {
            hub.send(client.id, deliverPayload);
            delivered++;
          }
        }
      }
    }

    if (delivered === 0) {
      const bridges = hub.getBridges().map((b) => b.program).filter(Boolean);
      const workers = hub.getClients().map((c) => c.workerName).filter(Boolean);
      return errorResponse(c, 404, `No bridge or client found for target: ${target}`, "NOT_FOUND", {
        availableBridges: [...new Set(bridges)],
        availableWorkers: [...new Set(workers)],
      });
    }

    return c.json({ delivered, files: files.length });
  });

  return app;
}
