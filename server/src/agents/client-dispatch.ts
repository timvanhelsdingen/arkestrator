/**
 * Server-side management of client-dispatched local LLM jobs.
 *
 * When localModelHost === "client", instead of running the agentic loop on
 * the server (which can't reach localhost Ollama when in Docker), the server
 * dispatches the job to the connected Tauri client for the target worker
 * machine. The client runs the loop locally and proxies tool calls back.
 */

import type { Job, AgentConfig, CommandResult } from "@arkestrator/protocol";
import type { WebSocketHub } from "../ws/hub.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/id.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal deps needed for client-dispatch handlers (avoids circular import with spawner). */
export interface ClientDispatchDeps {
  hub: WebSocketHub;
  jobsRepo: JobsRepo;
}

/** How long to wait for the client to acknowledge/complete a dispatched job. */
const CLIENT_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface ClientDispatchedJob {
  jobId: string;
  clientConnectionId: string;
  workerName: string;
  dispatchedAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
  /** Callback when client reports completion. */
  onComplete: (result: {
    success: boolean;
    error?: string;
    commands: CommandResult[];
    durationMs: number;
  }) => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const dispatchedJobs = new Map<string, ClientDispatchedJob>();

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Find a connected client for the target worker and dispatch a local-oss
 * job to it. Returns true if dispatched successfully, false if no suitable
 * client was found (caller should fall back to existing approach).
 */
export function dispatchToClient(
  hub: WebSocketHub,
  job: Job,
  config: AgentConfig,
  targetWorkerName: string,
  basePrompt: string,
  model: string,
  maxTurns: number,
  turnTimeoutMs: number,
  systemPrompt: string | undefined,
  onComplete: ClientDispatchedJob["onComplete"],
  mcpEndpoint?: { url: string; apiKey: string },
): boolean {
  // Find connected client(s) for the target worker machine
  const clients = hub.getClientConnectionsByWorker(targetWorkerName);
  if (clients.length === 0) {
    logger.info("client-dispatch", `No connected client for worker "${targetWorkerName}", cannot dispatch job ${job.id}`);
    return false;
  }

  // Use the first connected client
  const clientWs = clients[0];
  const clientId = clientWs.data.id;

  // Set up a timeout to fail the job if the client never responds
  const timeoutTimer = setTimeout(() => {
    const tracked = dispatchedJobs.get(job.id);
    if (tracked) {
      logger.warn(
        "client-dispatch",
        `Job ${job.id} timed out after ${CLIENT_DISPATCH_TIMEOUT_MS / 1000}s — client "${targetWorkerName}" never completed it`,
      );
      dispatchedJobs.delete(job.id);
      tracked.onComplete({
        success: false,
        error: `Client dispatch timed out after ${CLIENT_DISPATCH_TIMEOUT_MS / 1000}s. The client may not support local job execution — ensure the Tauri client is updated.`,
        commands: [],
        durationMs: Date.now() - tracked.dispatchedAt,
      });
    }
  }, CLIENT_DISPATCH_TIMEOUT_MS);

  // Track the dispatched job
  dispatchedJobs.set(job.id, {
    jobId: job.id,
    clientConnectionId: clientId,
    workerName: targetWorkerName,
    dispatchedAt: Date.now(),
    timeoutTimer,
    onComplete,
  });

  // Send dispatch message to client
  hub.send(clientId, {
    type: "client_job_dispatch",
    id: newId(),
    payload: {
      jobId: job.id,
      job,
      agentConfig: config,
      basePrompt,
      model,
      maxTurns,
      turnTimeoutMs,
      systemPrompt,
      mcpEndpoint: mcpEndpoint ?? undefined,
    },
  });

  logger.info(
    "client-dispatch",
    `Dispatched job ${job.id} to client ${clientId} on worker "${targetWorkerName}" (model: ${model})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Handle messages from client
// ---------------------------------------------------------------------------

/**
 * Handle a `client_tool_request` from a client running a dispatched job.
 * Executes the tool on the server and sends the result back.
 *
 * The executeToolCall callback is injected to avoid circular dependency with spawner.
 */
export async function handleClientToolRequest(
  deps: ClientDispatchDeps,
  clientConnectionId: string,
  payload: {
    jobId: string;
    correlationId: string;
    tool: string;
    args: Record<string, unknown>;
  },
  executeToolCall: (
    tool: string,
    args: Record<string, unknown>,
    job: Job,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string; bridgesUsed?: string[] }>,
) {
  const { jobId, correlationId, tool, args } = payload;
  const tracked = dispatchedJobs.get(jobId);

  if (!tracked) {
    logger.warn("client-dispatch", `Tool request for unknown dispatched job ${jobId}`);
    deps.hub.send(clientConnectionId, {
      type: "client_tool_result",
      id: newId(),
      payload: { jobId, correlationId, ok: false, error: "Job not tracked on server" },
    });
    return;
  }

  const job = deps.jobsRepo.getById(jobId);
  if (!job) {
    deps.hub.send(clientConnectionId, {
      type: "client_tool_result",
      id: newId(),
      payload: { jobId, correlationId, ok: false, error: "Job not found" },
    });
    return;
  }

  try {
    const result = await executeToolCall(tool, args, job);

    // Track bridge usage
    if (result.bridgesUsed?.length) {
      for (const program of result.bridgesUsed) {
        deps.jobsRepo.addUsedBridge(jobId, program);
      }
    }

    deps.hub.send(clientConnectionId, {
      type: "client_tool_result",
      id: newId(),
      payload: {
        jobId,
        correlationId,
        ok: result.ok,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : (result.error ?? "Unknown tool error"),
      },
    });
  } catch (err: any) {
    deps.hub.send(clientConnectionId, {
      type: "client_tool_result",
      id: newId(),
      payload: {
        jobId,
        correlationId,
        ok: false,
        error: `Tool execution error: ${err?.message ?? err}`,
      },
    });
  }
}

/**
 * Handle a `client_job_log` from a client — append to job logs and broadcast.
 */
export function handleClientJobLog(
  deps: ClientDispatchDeps,
  payload: { jobId: string; text: string },
) {
  const { jobId, text } = payload;
  deps.jobsRepo.appendLog(jobId, text);

  // Broadcast log to connected clients (admin UI, etc.)
  deps.hub.broadcastToType("client", {
    type: "job_log",
    id: newId(),
    payload: { jobId, text },
  });
}

/**
 * Handle a `client_job_complete` from a client — finalize the job.
 */
export function handleClientJobComplete(
  payload: {
    jobId: string;
    success: boolean;
    error?: string;
    commands: CommandResult[];
    durationMs: number;
  },
) {
  const tracked = dispatchedJobs.get(payload.jobId);
  if (!tracked) {
    logger.warn("client-dispatch", `Completion for unknown dispatched job ${payload.jobId}`);
    return;
  }

  clearTimeout(tracked.timeoutTimer);
  dispatchedJobs.delete(payload.jobId);
  tracked.onComplete({
    success: payload.success,
    error: payload.error,
    commands: payload.commands,
    durationMs: payload.durationMs,
  });
}

/**
 * Cancel a client-dispatched job by sending cancel to the client.
 */
export function cancelClientDispatchedJob(hub: WebSocketHub, jobId: string) {
  const tracked = dispatchedJobs.get(jobId);
  if (!tracked) return;

  clearTimeout(tracked.timeoutTimer);
  hub.send(tracked.clientConnectionId, {
    type: "client_job_cancel",
    id: newId(),
    payload: { jobId },
  });
}

/**
 * Handle client disconnect — fail all jobs dispatched to that client.
 */
export function handleClientDisconnect(clientConnectionId: string) {
  for (const [jobId, tracked] of dispatchedJobs) {
    if (tracked.clientConnectionId === clientConnectionId) {
      logger.warn("client-dispatch", `Client ${clientConnectionId} disconnected, failing job ${jobId}`);
      clearTimeout(tracked.timeoutTimer);
      dispatchedJobs.delete(jobId);
      tracked.onComplete({
        success: false,
        error: "Client disconnected during job execution",
        commands: [],
        durationMs: Date.now() - tracked.dispatchedAt,
      });
    }
  }
}

/**
 * Check if a job is currently dispatched to a client.
 */
export function isClientDispatchedJob(jobId: string): boolean {
  return dispatchedJobs.has(jobId);
}
