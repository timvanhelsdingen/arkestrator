/**
 * Manages client-dispatched local LLM jobs.
 *
 * When the server dispatches a local-oss job to this client (because
 * localModelHost is "client"), this module runs the agentic loop locally
 * against Ollama and proxies tool calls back through the server via WS.
 */

import { runClientAgenticLoop, type ClientJobDispatch } from "./localAgenticLoop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingToolRequest {
  resolve: (result: { ok: boolean; data?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
}

interface RunningJob {
  jobId: string;
  cancelled: boolean;
  pendingTools: Map<string, PendingToolRequest>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const runningJobs = new Map<string, RunningJob>();

/** WS send function — set by ws.ts on connect. */
let wsSend: ((msg: object) => void) | null = null;

/** Set the WebSocket send function. Called from ws.ts. */
export function setWsSend(fn: (msg: object) => void) {
  wsSend = fn;
}

// ---------------------------------------------------------------------------
// Public API — called from ws.ts dispatch
// ---------------------------------------------------------------------------

/**
 * Handle a `client_job_dispatch` message from the server.
 * Starts the local agentic loop in the background.
 */
export function handleJobDispatch(payload: {
  jobId: string;
  job: unknown;
  agentConfig: unknown;
  basePrompt: string;
  model: string;
  maxTurns: number;
  turnTimeoutMs: number;
  systemPrompt?: string;
}) {
  const { jobId, basePrompt, model, maxTurns, turnTimeoutMs, systemPrompt } = payload;

  // Already running?
  if (runningJobs.has(jobId)) {
    console.warn(`[clientJob] Job ${jobId} already running, ignoring duplicate dispatch`);
    return;
  }

  const job: RunningJob = {
    jobId,
    cancelled: false,
    pendingTools: new Map(),
  };
  runningJobs.set(jobId, job);

  const dispatch: ClientJobDispatch = {
    jobId,
    basePrompt,
    model,
    maxTurns,
    turnTimeoutMs,
    systemPrompt,
  };

  // Run the loop asynchronously
  void runClientAgenticLoop(dispatch, {
    requestTool: (tool, args) => requestToolFromServer(job, tool, args),
    sendLog: (text) => sendJobLog(jobId, text),
    sendComplete: (result) => {
      sendJobComplete(jobId, result);
      cleanup(jobId);
    },
    isCancelled: () => job.cancelled,
  }).catch((err) => {
    console.error(`[clientJob] Agentic loop crashed for job ${jobId}:`, err);
    sendJobComplete(jobId, {
      success: false,
      error: `Client agentic loop crashed: ${err instanceof Error ? err.message : String(err)}`,
      commands: [],
      durationMs: 0,
    });
    cleanup(jobId);
  });
}

/**
 * Handle a `client_tool_result` message from the server.
 * Resolves the pending tool request promise.
 */
export function handleToolResult(payload: {
  jobId: string;
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}) {
  const job = runningJobs.get(payload.jobId);
  if (!job) {
    console.warn(`[clientJob] Tool result for unknown job ${payload.jobId}`);
    return;
  }

  const pending = job.pendingTools.get(payload.correlationId);
  if (!pending) {
    console.warn(`[clientJob] Tool result for unknown correlationId ${payload.correlationId}`);
    return;
  }

  job.pendingTools.delete(payload.correlationId);
  pending.resolve({
    ok: payload.ok,
    data: payload.data,
    error: payload.error,
  });
}

/**
 * Handle a `client_job_cancel` message from the server.
 * Sets the cancel flag so the loop bails on the next turn.
 */
export function handleJobCancel(payload: { jobId: string }) {
  const job = runningJobs.get(payload.jobId);
  if (!job) return;

  job.cancelled = true;
  // Reject all pending tool requests
  for (const [, pending] of job.pendingTools) {
    pending.reject(new Error("Job cancelled"));
  }
  job.pendingTools.clear();
}

/**
 * Clean up when the WebSocket disconnects.
 * Fails all running client jobs.
 */
export function handleDisconnect() {
  for (const [jobId, job] of runningJobs) {
    job.cancelled = true;
    for (const [, pending] of job.pendingTools) {
      pending.reject(new Error("WebSocket disconnected"));
    }
    job.pendingTools.clear();
    console.warn(`[clientJob] Failing job ${jobId} due to WS disconnect`);
  }
  runningJobs.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requestToolFromServer(
  job: RunningJob,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!wsSend) {
    return Promise.resolve({ ok: false, error: "WebSocket not connected" });
  }

  const correlationId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    job.pendingTools.set(correlationId, { resolve, reject });

    wsSend!({
      type: "client_tool_request",
      id: crypto.randomUUID(),
      payload: {
        jobId: job.jobId,
        correlationId,
        tool,
        args,
      },
    });
  });
}

function sendJobLog(jobId: string, text: string) {
  if (!wsSend) return;
  wsSend({
    type: "client_job_log",
    id: crypto.randomUUID(),
    payload: { jobId, text },
  });
}

function sendJobComplete(
  jobId: string,
  result: {
    success: boolean;
    error?: string;
    commands: Array<{
      language: string;
      script: string;
      success: boolean;
      output?: string;
      error?: string;
      executionTimeMs?: number;
    }>;
    durationMs: number;
  },
) {
  if (!wsSend) return;
  wsSend({
    type: "client_job_complete",
    id: crypto.randomUUID(),
    payload: {
      jobId,
      success: result.success,
      error: result.error,
      commands: result.commands,
      durationMs: result.durationMs,
    },
  });
}

function cleanup(jobId: string) {
  const job = runningJobs.get(jobId);
  if (job) {
    for (const [, pending] of job.pendingTools) {
      pending.reject(new Error("Job completed"));
    }
    job.pendingTools.clear();
  }
  runningJobs.delete(jobId);
}
