import type { ServerWebSocket } from "bun";
import { Message } from "@arkestrator/protocol";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { ProjectsRepo } from "../db/projects.repo.js";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { UsageRepo } from "../db/usage.repo.js";
import type { DependenciesRepo } from "../db/dependencies.repo.js";
import type { Config } from "../config.js";
import type { WebSocketHub, WsData } from "./hub.js";
import type { ProcessTracker } from "../agents/process-tracker.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { WorkerResourceLeaseManager } from "../agents/resource-control.js";
import { checkCommandScripts } from "../policies/enforcer.js";
import { applyPromptBridgeExecutionMode } from "../agents/runtime-options.js";
import { getJobInterventionSupport } from "../agents/job-interventions.js";
import {
  handleClientToolRequest,
  handleClientJobLog,
  handleClientJobComplete,
  cancelClientDispatchedJob,
} from "../agents/client-dispatch.js";
import { executeLocalAgenticToolCall } from "../agents/spawner.js";
import type { SpawnerDeps } from "../agents/spawner.js";
import { LocalAgenticToolCall } from "@arkestrator/protocol";
import { basename, dirname } from "path";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

export interface HandlerDeps {
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  projectsRepo: ProjectsRepo;
  policiesRepo: PoliciesRepo;
  usersRepo: UsersRepo;
  usageRepo: UsageRepo;
  depsRepo: DependenciesRepo;
  hub: WebSocketHub;
  processTracker: ProcessTracker;
  headlessProgramsRepo: HeadlessProgramsRepo;
  workersRepo: WorkersRepo;
  jobInterventionsRepo: JobInterventionsRepo;
  config: Config;
  resourceLeaseManager: WorkerResourceLeaseManager;
  localLlmGate?: import("../agents/local-llm-gate.js").LocalLlmGate;
  skillsRepo?: import("../db/skills.repo.js").SkillsRepo;
  skillStore?: import("../skills/skill-store.js").SkillStore;
  skillIndex?: import("../skills/skill-index.js").SkillIndex;
  skillEffectivenessRepo?: import("../db/skill-effectiveness.repo.js").SkillEffectivenessRepo;
}

function send(ws: ServerWebSocket<WsData>, message: object) {
  ws.send(JSON.stringify(message));
}

function errorReply(ws: ServerWebSocket<WsData>, code: string, message: string, replyTo?: string) {
  send(ws, {
    type: "error",
    id: newId(),
    payload: { code, message, replyTo },
  });
}

function enrichJob(job: any, deps: HandlerDeps) {
  const tokenUsage = deps.usageRepo.getByJobId(job.id) ?? undefined;
  const dependsOn = deps.depsRepo.getDependencies(job.id);
  const submittedByUsername = job.submittedBy
    ? deps.usersRepo.getById(job.submittedBy)?.username ?? undefined
    : undefined;
  return {
    ...job,
    tokenUsage,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    submittedByUsername,
  };
}

function enrichJobs(rows: any[], deps: HandlerDeps) {
  if (rows.length === 0) return rows;
  const usageMap = deps.usageRepo.getByJobIds(rows.map((job) => job.id));
  const depsMap = deps.depsRepo.getDependenciesBatch(rows.map((job) => job.id));
  const submittedByUsernames = new Map<string, string>();
  for (const job of rows) {
    const submittedBy = String(job.submittedBy ?? "").trim();
    if (!submittedBy || submittedByUsernames.has(submittedBy)) continue;
    const user = deps.usersRepo.getById(submittedBy);
    if (user?.username) submittedByUsernames.set(submittedBy, user.username);
  }
  return rows.map((job) => ({
    ...job,
    tokenUsage: usageMap.get(job.id) ?? undefined,
    dependsOn: depsMap.has(job.id) ? depsMap.get(job.id) : undefined,
    submittedByUsername: job.submittedBy
      ? submittedByUsernames.get(job.submittedBy)
      : undefined,
  }));
}

export function handleMessage(
  ws: ServerWebSocket<WsData>,
  raw: string,
  deps: HandlerDeps,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errorReply(ws, "PARSE_ERROR", "Invalid JSON");
    return;
  }

  const result = Message.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 5).map((i) =>
      `${i.path.join(".")}: ${i.message}`,
    ).join("; ");
    const msgType = String((parsed as Record<string, unknown>)?.type ?? "unknown");
    // Log protocol validation errors server-side only — don't bother clients
    // with internal message format issues they can't act on.
    logger.warn(
      "ws-handler",
      `Invalid WS message from ${ws.data.type}/${ws.data.id}: type=${msgType}: ${issues}`,
    );
    return;
  }

  const msg = result.data;

  try {
    switch (msg.type) {
      case "job_submit":
        handleJobSubmit(ws, msg, deps);
        break;
      case "job_list":
        handleJobList(ws, msg, deps);
        break;
      case "job_cancel":
        handleJobCancel(ws, msg, deps);
        break;
      case "job_reprioritize":
        handleJobReprioritize(ws, msg, deps);
        break;
      case "job_intervention_list":
        handleJobInterventionList(ws, msg, deps);
        break;
      case "job_intervention_submit":
        handleJobInterventionSubmit(ws, msg, deps);
        break;
      case "agent_config_list":
        handleAgentConfigList(ws, msg, deps);
        break;
      case "agent_config_create":
        if (ws.data.type === "bridge") {
          errorReply(ws, "FORBIDDEN", "Bridges cannot create agent configs", msg.id);
          break;
        }
        handleAgentConfigCreate(ws, msg, deps);
        break;
      case "agent_config_update":
        if (ws.data.type === "bridge") {
          errorReply(ws, "FORBIDDEN", "Bridges cannot update agent configs", msg.id);
          break;
        }
        handleAgentConfigUpdate(ws, msg, deps);
        break;
      case "agent_config_delete":
        if (ws.data.type === "bridge") {
          errorReply(ws, "FORBIDDEN", "Bridges cannot delete agent configs", msg.id);
          break;
        }
        handleAgentConfigDelete(ws, msg, deps);
        break;
      case "project_list":
        handleProjectList(ws, msg, deps);
        break;
      case "bridge_command_send":
        handleBridgeCommandSend(ws, msg, deps);
        break;
      case "bridge_command_result":
        handleBridgeCommandResult(ws, msg, deps);
        break;
      case "bridge_file_read_response":
        handleBridgeFileReadResponse(ws, msg, deps);
        break;
      case "worker_headless_result":
        handleWorkerHeadlessResult(ws, msg as any, deps);
        break;
      case "bridge_context_item_add":
        handleBridgeContextItemAdd(ws, msg, deps);
        break;
      case "bridge_context_clear":
        handleBridgeContextClear(ws, msg, deps);
        break;
      case "bridge_editor_context":
        handleBridgeEditorContext(ws, msg, deps);
        break;
      case "client_context_item_remove":
        handleClientContextItemRemove(ws, msg, deps);
        break;
      case "client_context_items_clear":
        handleClientContextItemsClear(ws, msg, deps);
        break;
      case "subscribe_job_logs":
        if (ws.data.type !== "client") break;
        if (msg.payload?.jobId) deps.hub.subscribeJobLogs(ws.data.id, msg.payload.jobId);
        break;
      case "unsubscribe_job_logs":
        if (ws.data.type !== "client") break;
        deps.hub.unsubscribeJobLogs(ws.data.id, msg.payload?.jobId);
        break;
      case "client_tool_request":
        if (ws.data.type !== "client") {
          errorReply(ws, "FORBIDDEN", "Only clients can send tool requests", msg.id);
          break;
        }
        void handleClientToolRequest(
          { hub: deps.hub, jobsRepo: deps.jobsRepo },
          ws.data.id,
          msg.payload,
          async (tool, args, job) => {
            // Build a minimal SpawnerDeps-compatible object for executeLocalAgenticToolCall
            const spawnerDeps = {
              hub: deps.hub,
              jobsRepo: deps.jobsRepo,
              agentsRepo: deps.agentsRepo,
              projectsRepo: deps.projectsRepo,
              config: deps.config,
              processTracker: deps.processTracker,
              usageRepo: deps.usageRepo,
              depsRepo: deps.depsRepo,
              headlessProgramsRepo: deps.headlessProgramsRepo,
              workersRepo: deps.workersRepo,
              jobInterventionsRepo: deps.jobInterventionsRepo,
              resourceLeaseManager: deps.resourceLeaseManager,
              localLlmGate: deps.localLlmGate,
              skillsRepo: deps.skillsRepo,
              skillStore: deps.skillStore,
              skillIndex: deps.skillIndex,
              skillEffectivenessRepo: deps.skillEffectivenessRepo,
            } satisfies Partial<SpawnerDeps> as SpawnerDeps;
            const toolCall = LocalAgenticToolCall.parse({ type: "tool_call", tool, args });
            const result = await executeLocalAgenticToolCall(
              toolCall,
              spawnerDeps,
              job,
            );
            return result;
          },
        );
        break;
      case "client_job_log":
        if (ws.data.type !== "client") {
          errorReply(ws, "FORBIDDEN", "Only clients can send job logs", msg.id);
          break;
        }
        handleClientJobLog(
          { hub: deps.hub, jobsRepo: deps.jobsRepo },
          msg.payload,
        );
        break;
      case "client_job_complete":
        if (ws.data.type !== "client") {
          errorReply(ws, "FORBIDDEN", "Only clients can complete jobs", msg.id);
          break;
        }
        handleClientJobComplete(msg.payload);
        break;
      case "client_headless_capabilities": {
        if (ws.data.type !== "client") {
          errorReply(ws, "FORBIDDEN", "Only clients can report headless capabilities", msg.id);
          break;
        }
        const workerKey = ws.data.machineId ?? ws.data.workerName;
        if (workerKey) {
          deps.hub.setWorkerHeadlessCapabilities(workerKey, msg.payload.programs);
          const programNames = msg.payload.programs.map((p: { program: string }) => p.program);
          logger.info(
            "ws-handler",
            `Client ${ws.data.id} reported ${msg.payload.programs.length} headless capabilities` +
            (programNames.length > 0 ? `: ${programNames.join(", ")}` : ""),
          );
        }
        break;
      }
      default:
        errorReply(ws, "UNKNOWN_TYPE", `Unhandled message type: ${(msg as { type: string }).type}`);
    }
  } catch (err: any) {
    logger.error("handler", `Unhandled error processing ${msg.type}: ${err.message}`);
    errorReply(ws, "INTERNAL_ERROR", `Server error: ${err.message}`, msg.id);
  }
}

function handleJobSubmit(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: any },
  deps: HandlerDeps,
) {
  if (msg.payload?.agentConfigId === "auto") {
    errorReply(
      ws,
      "INVALID_INPUT",
      "WebSocket job_submit does not support agentConfigId='auto' yet. Use REST /api/jobs for AUTO routing.",
      msg.id,
    );
    return;
  }

  let job;
  try {
    job = deps.jobsRepo.create(
      {
        ...msg.payload,
        runtimeOptions: applyPromptBridgeExecutionMode(
          msg.payload?.prompt,
          msg.payload?.runtimeOptions,
        ),
      },
      ws.data.id,
      ws.data.program,
      ws.data.workerName,
    );
  } catch (err: any) {
    logger.error("handler", `Job creation failed: ${err.message}`);
    errorReply(ws, "CREATE_FAILED", `Failed to create job: ${err.message}`, msg.id);
    return;
  }
  logger.info("handler", `Job submitted: ${job.id} by ${ws.data.id}`);

  send(ws, {
    type: "job_accepted",
    id: newId(),
    payload: { jobId: job.id },
  });

  // Notify clients with the new job
  deps.hub.broadcastToType("client", {
    type: "job_updated",
    id: newId(),
    payload: { job: enrichJob(job, deps) },
  });
}

function handleJobList(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { status?: string[]; limit?: number; offset?: number } },
  deps: HandlerDeps,
) {
  const { jobs, total } = deps.jobsRepo.list(msg.payload.status, msg.payload.limit, msg.payload.offset);
  send(ws, {
    type: "job_list_response",
    id: newId(),
    payload: { jobs: enrichJobs(jobs, deps), total },
  });
}

function handleJobCancel(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { jobId: string } },
  deps: HandlerDeps,
) {
  const job = deps.jobsRepo.getById(msg.payload.jobId);
  if (!job) {
    errorReply(ws, "NOT_FOUND", "Job not found", msg.id);
    return;
  }

  // Kill subprocess if running, or cancel client-dispatched job
  if (job.status === "running") {
    deps.processTracker.kill(job.id);
    // Also notify client if this job was dispatched to a client
    cancelClientDispatchedJob(deps.hub, msg.payload.jobId);
  }

  const cancelled = deps.jobsRepo.cancel(msg.payload.jobId);
  if (!cancelled) {
    errorReply(ws, "CANCEL_FAILED", "Cannot cancel job", msg.id);
    return;
  }

  logger.info("handler", `Job cancelled: ${msg.payload.jobId}`);
  send(ws, {
    type: "job_accepted",
    id: newId(),
    payload: { jobId: msg.payload.jobId },
  });

  // Broadcast updated job to all clients
  const cancelledJob = deps.jobsRepo.getById(msg.payload.jobId);
  if (cancelledJob) {
    deps.hub.broadcastToType("client", {
      type: "job_updated",
      id: newId(),
      payload: { job: enrichJob(cancelledJob, deps) },
    });
  }
}

function handleJobReprioritize(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { jobId: string; priority: string } },
  deps: HandlerDeps,
) {
  const updated = deps.jobsRepo.reprioritize(
    msg.payload.jobId,
    msg.payload.priority as import("@arkestrator/protocol").JobPriority,
  );
  if (!updated) {
    errorReply(ws, "REPRIORITIZE_FAILED", "Cannot reprioritize job", msg.id);
    return;
  }
  logger.info("handler", `Job reprioritized: ${msg.payload.jobId} -> ${msg.payload.priority}`);

  // Broadcast updated job to all clients
  const reprioritizedJob = deps.jobsRepo.getById(msg.payload.jobId);
  if (reprioritizedJob) {
    deps.hub.broadcastToType("client", {
      type: "job_updated",
      id: newId(),
      payload: { job: enrichJob(reprioritizedJob, deps) },
    });
  }
}

function handleJobInterventionList(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { jobId: string } },
  deps: HandlerDeps,
) {
  const job = deps.jobsRepo.getById(msg.payload.jobId);
  if (!job) {
    errorReply(ws, "NOT_FOUND", "Job not found", msg.id);
    return;
  }
  send(ws, {
    type: "job_intervention_list_response",
    id: newId(),
    payload: {
      jobId: job.id,
      interventions: deps.jobInterventionsRepo.listByJob(job.id),
      support: getJobInterventionSupport(job, deps.agentsRepo),
    },
  });
}

function handleJobInterventionSubmit(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { jobId: string; intervention: { text: string; source: "jobs" | "chat" | "mcp" } } },
  deps: HandlerDeps,
) {
  const job = deps.jobsRepo.getById(msg.payload.jobId);
  if (!job) {
    errorReply(ws, "NOT_FOUND", "Job not found", msg.id);
    return;
  }
  const support = getJobInterventionSupport(job, deps.agentsRepo);
  const accepts =
    (job.status === "queued" || job.status === "paused") ? support.acceptsQueuedNotes : support.acceptsLiveNotes;
  if (!accepts) {
    errorReply(ws, "INVALID_INPUT", support.liveReason ?? "Job cannot accept intervention", msg.id);
    return;
  }
  const text = String(msg.payload?.intervention?.text ?? "").trim();
  if (!text || text.length > 4000) {
    errorReply(ws, "INVALID_INPUT", "Intervention text must be 1-4000 characters", msg.id);
    return;
  }
  const source = msg.payload?.intervention?.source ?? "jobs";
  const intervention = deps.jobInterventionsRepo.create(job.id, { text, source }, {
    username: ws.data.name ? `ws:${ws.data.name}` : `ws:${ws.data.id.slice(0, 8)}`,
  });
  deps.hub.broadcastToType("client", {
    type: "job_intervention_updated",
    id: newId(),
    payload: {
      jobId: job.id,
      intervention,
      support,
    },
  });
  send(ws, {
    type: "job_intervention_updated",
    id: newId(),
    payload: {
      jobId: job.id,
      intervention,
      support,
    },
  });
}

function handleAgentConfigList(
  ws: ServerWebSocket<WsData>,
  _msg: { id: string },
  deps: HandlerDeps,
) {
  const configs = deps.agentsRepo.list();
  send(ws, {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
}

function handleAgentConfigCreate(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: any },
  deps: HandlerDeps,
) {
  deps.agentsRepo.create(msg.payload);
  const configs = deps.agentsRepo.list();
  send(ws, {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
  deps.hub.broadcastToType("client", {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
}

function handleAgentConfigUpdate(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: any },
  deps: HandlerDeps,
) {
  const updated = deps.agentsRepo.update(msg.payload);
  if (!updated) {
    errorReply(ws, "NOT_FOUND", "Agent config not found", msg.id);
    return;
  }
  const configs = deps.agentsRepo.list();
  send(ws, {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
  deps.hub.broadcastToType("client", {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
}

function handleAgentConfigDelete(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { id: string } },
  deps: HandlerDeps,
) {
  const deleted = deps.agentsRepo.delete(msg.payload.id);
  if (!deleted) {
    errorReply(ws, "NOT_FOUND", "Agent config not found", msg.id);
    return;
  }
  logger.info("handler", `Agent config deleted: ${msg.payload.id}`);
  const configs = deps.agentsRepo.list();
  send(ws, {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
  deps.hub.broadcastToType("client", {
    type: "agent_config_list_response",
    id: newId(),
    payload: { configs },
  });
}

function handleProjectList(
  ws: ServerWebSocket<WsData>,
  _msg: { id: string },
  deps: HandlerDeps,
) {
  const projects = deps.projectsRepo.list();
  send(ws, {
    type: "project_list_response",
    id: newId(),
    payload: { projects },
  });
}

function handleBridgeCommandSend(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { target: string; targetType?: string; commands: any[]; correlationId?: string; projectPath?: string } },
  deps: HandlerDeps,
) {
  const { target, targetType, commands, correlationId, projectPath } = msg.payload;

  let targets: ServerWebSocket<WsData>[] = [];

  if (targetType === "id") {
    const targetWs = deps.hub.getConnection(target);
    if (targetWs && targetWs.data.type === "bridge") {
      targets = [targetWs];
    }
  } else {
    targets = deps.hub.getBridgesByProgram(target);
  }

  if (targets.length === 0) {
    errorReply(ws, "NO_TARGET", `No connected bridge found for target: ${target}`, msg.id);
    return;
  }

  // Check command scripts against command_filter policies
  if (commands && commands.length > 0) {
    const policies = deps.policiesRepo.getEffectiveForUser(null);
    const violations = checkCommandScripts(commands, policies);
    const blockers = violations.filter((v) => v.action === "block");
    if (blockers.length > 0) {
      errorReply(ws, "COMMAND_BLOCKED", `Command blocked by policy: ${blockers.map((v) => v.message).join("; ")}`, msg.id);
      return;
    }
  }

  let bridgeMetadataChanged = false;
  for (const targetWs of targets) {
    if (projectPath) {
      bridgeMetadataChanged = deps.hub.recordBridgeProjectPath(targetWs.data.id, projectPath) || bridgeMetadataChanged;
      if (targetWs.data.workerName && targetWs.data.program) {
        deps.workersRepo.upsertBridge(
          targetWs.data.workerName,
          targetWs.data.program,
          targetWs.data.programVersion,
          targetWs.data.bridgeVersion,
          projectPath,
          targetWs.data.machineId,
        );
      }
    }
    send(targetWs, {
      type: "bridge_command",
      id: newId(),
      payload: {
        senderId: ws.data.id,
        commands,
        correlationId,
        projectPath,
      },
    });
  }

  if (bridgeMetadataChanged) {
    deps.hub.broadcastBridgeStatus();
    deps.hub.broadcastWorkerStatus(deps.workersRepo);
  }

  logger.info("handler", `Bridge command routed from ${ws.data.id} to ${targets.length} bridge(s) targeting "${target}"`);
}

function handleBridgeCommandResult(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { senderId?: string; correlationId?: string; success: boolean; executed: number; failed: number; skipped: number; errors: string[]; stdout?: string; stderr?: string; outputs?: any[] } },
  deps: HandlerDeps,
) {
  const resultPayload = {
    bridgeId: ws.data.id,
    program: ws.data.program,
    correlationId: msg.payload.correlationId,
    success: msg.payload.success,
    executed: msg.payload.executed,
    failed: msg.payload.failed,
    skipped: msg.payload.skipped,
    errors: msg.payload.errors,
    stdout: msg.payload.stdout,
    stderr: msg.payload.stderr,
    outputs: Array.isArray(msg.payload.outputs) ? msg.payload.outputs : undefined,
  };

  // Check if this is a response to a pending REST API command
  if (msg.payload.correlationId) {
    const resolved = deps.hub.resolvePendingCommand(msg.payload.correlationId, resultPayload);
    if (resolved) {
      logger.info("handler", `Bridge command result from ${ws.data.id} resolved REST pending command ${msg.payload.correlationId}`);
      return;
    }
  }

  // Forward to WS sender
  const { senderId } = msg.payload;
  if (!senderId) return;

  deps.hub.send(senderId, {
    type: "bridge_command_result",
    id: newId(),
    payload: resultPayload,
  });

  logger.info("handler", `Bridge command result from ${ws.data.id} forwarded to ${senderId}`);
}

function handleBridgeFileReadResponse(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { correlationId: string; files: Array<{ path: string; content: string; encoding: string; size: number; error?: string }> } },
  deps: HandlerDeps,
) {
  const { correlationId } = msg.payload;
  if (!correlationId) return;

  const resolved = deps.hub.resolvePendingCommand(correlationId, msg.payload);
  if (resolved) {
    logger.info("handler", `File read response from ${ws.data.id} resolved pending command ${correlationId} (${msg.payload.files.length} file(s))`);
  }
}

function handleWorkerHeadlessResult(
  ws: ServerWebSocket<WsData>,
  msg: {
    id: string;
    payload: {
      correlationId: string;
      program: string;
      success: boolean;
      executed: number;
      failed: number;
      skipped: number;
      errors: string[];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      headless?: boolean;
      senderId?: string;
    };
  },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "client") {
    errorReply(ws, "NOT_CLIENT", "Only desktop clients can report worker headless results", msg.id);
    return;
  }

  const resultPayload = {
    correlationId: msg.payload.correlationId,
    program: msg.payload.program,
    success: msg.payload.success,
    executed: msg.payload.executed,
    failed: msg.payload.failed,
    skipped: msg.payload.skipped,
    errors: msg.payload.errors,
    stdout: msg.payload.stdout,
    stderr: msg.payload.stderr,
    exitCode: msg.payload.exitCode,
    headless: msg.payload.headless !== false,
    workerName: ws.data.workerName,
    machineId: ws.data.machineId,
  };

  if (msg.payload.correlationId) {
    const resolved = deps.hub.resolvePendingCommand(msg.payload.correlationId, resultPayload);
    if (resolved) {
      logger.info(
        "handler",
        `Worker headless result from ${ws.data.id} resolved pending command ${msg.payload.correlationId}`,
      );
      return;
    }
  }

  if (msg.payload.senderId) {
    deps.hub.send(msg.payload.senderId, {
      type: "worker_headless_result",
      id: newId(),
      payload: resultPayload,
    });
  }
}

// --- Bridge Context Handlers ---

function handleBridgeContextItemAdd(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { item: any } },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "bridge") {
    errorReply(ws, "NOT_BRIDGE", "Only bridges can push context items", msg.id);
    return;
  }

  // Server assigns the index so numbering stays sequential after removals.
  const serverItem = deps.hub.addBridgeContextItem(ws.data.id, msg.payload.item);

  // Relay to all clients with bridge identity enrichment and server-assigned index
  deps.hub.broadcastToType("client", {
    type: "bridge_context_item_add",
    id: newId(),
    payload: {
      bridgeId: ws.data.id,
      bridgeName: ws.data.name ?? ws.data.id,
      program: ws.data.program,
      item: serverItem,
    },
  });

  logger.info("handler", `Bridge context item from ${ws.data.id}: @${serverItem.index} ${serverItem.name}`);
}

function handleBridgeContextClear(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: any },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "bridge") {
    errorReply(ws, "NOT_BRIDGE", "Only bridges can clear context", msg.id);
    return;
  }

  deps.hub.clearBridgeContext(ws.data.id);

  deps.hub.broadcastToType("client", {
    type: "bridge_context_clear",
    id: newId(),
    payload: {
      bridgeId: ws.data.id,
      program: ws.data.program,
    },
  });

  logger.info("handler", `Bridge context cleared: ${ws.data.id}`);
}

function handleClientContextItemRemove(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { bridgeId: string; itemIndex: number } },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "client") {
    errorReply(ws, "NOT_CLIENT", "Only clients can remove context items", msg.id);
    return;
  }

  const updatedItems = deps.hub.removeBridgeContextItem(msg.payload.bridgeId, msg.payload.itemIndex);
  if (!updatedItems) return;

  // Broadcast re-indexed context sync to all clients
  const bridgeWs = deps.hub.getConnection(msg.payload.bridgeId);
  const bridgeName = bridgeWs?.data.name ?? msg.payload.bridgeId;
  const program = bridgeWs?.data.program ?? "";
  const ctx = deps.hub.getBridgeContext(msg.payload.bridgeId);

  deps.hub.broadcastToType("client", {
    type: "bridge_context_sync",
    id: newId(),
    payload: {
      bridges: [{
        bridgeId: msg.payload.bridgeId,
        bridgeName,
        program,
        items: updatedItems,
        editorContext: ctx?.editorContext,
        files: ctx?.files ?? [],
      }],
    },
  });

  logger.info("handler", `Client removed context item @${msg.payload.itemIndex} from bridge ${msg.payload.bridgeId}`);
}

function handleClientContextItemsClear(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { bridgeId: string } },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "client") {
    errorReply(ws, "NOT_CLIENT", "Only clients can clear context items", msg.id);
    return;
  }

  deps.hub.clearBridgeContextItems(msg.payload.bridgeId);

  // Broadcast cleared state to all clients
  const bridgeWs = deps.hub.getConnection(msg.payload.bridgeId);
  const bridgeName = bridgeWs?.data.name ?? msg.payload.bridgeId;
  const program = bridgeWs?.data.program ?? "";
  const ctx = deps.hub.getBridgeContext(msg.payload.bridgeId);

  deps.hub.broadcastToType("client", {
    type: "bridge_context_sync",
    id: newId(),
    payload: {
      bridges: [{
        bridgeId: msg.payload.bridgeId,
        bridgeName,
        program,
        items: [],
        editorContext: ctx?.editorContext,
        files: ctx?.files ?? [],
      }],
    },
  });

  logger.info("handler", `Client cleared context items for bridge ${msg.payload.bridgeId}`);
}

function handleBridgeEditorContext(
  ws: ServerWebSocket<WsData>,
  msg: { id: string; payload: { editorContext: any; files?: any[] } },
  deps: HandlerDeps,
) {
  if (ws.data.type !== "bridge") {
    errorReply(ws, "NOT_BRIDGE", "Only bridges can push editor context", msg.id);
    return;
  }

  deps.hub.setBridgeEditorContext(ws.data.id, msg.payload.editorContext, msg.payload.files ?? []);

  // Keep bridge metadata in sync without forcing reconnects:
  // derive project path from editor context and update the live bridge snapshot.
  const editorContext = msg.payload.editorContext ?? {};
  const projectRoot = typeof editorContext?.projectRoot === "string"
    ? editorContext.projectRoot.trim()
    : "";
  const activeFile = typeof editorContext?.activeFile === "string"
    ? editorContext.activeFile.trim()
    : "";
  const derivedProjectPath = projectRoot || (activeFile ? dirname(activeFile) : "");
  const derivedName = activeFile ? basename(activeFile) : "";
  let bridgeMetaChanged = false;
  if (derivedName && ws.data.name !== derivedName) {
    ws.data.name = derivedName;
    bridgeMetaChanged = true;
  }
  if (derivedProjectPath) {
    const changed = deps.hub.recordBridgeProjectPath(ws.data.id, derivedProjectPath);
    if (changed) {
      bridgeMetaChanged = true;
      if (ws.data.workerName && ws.data.program) {
        deps.workersRepo.upsertBridge(
          ws.data.workerName,
          ws.data.program,
          ws.data.programVersion,
          ws.data.bridgeVersion,
          derivedProjectPath,
          ws.data.machineId,
        );
      }
    }
  }
  if (bridgeMetaChanged) {
    deps.hub.broadcastBridgeStatus();
    deps.hub.broadcastWorkerStatus(deps.workersRepo);
  }

  deps.hub.broadcastToType("client", {
    type: "bridge_editor_context",
    id: newId(),
    payload: {
      bridgeId: ws.data.id,
      bridgeName: ws.data.name ?? ws.data.id,
      program: ws.data.program,
      editorContext: msg.payload.editorContext,
      files: msg.payload.files ?? [],
    },
  });

  logger.info("handler", `Bridge editor context from ${ws.data.id} (${ws.data.program})`);
}
