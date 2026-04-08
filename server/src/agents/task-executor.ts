/**
 * TaskExecutor: Dispatches non-agentic task jobs directly to bridges/workers.
 *
 * Task jobs skip the AI agent spawner entirely. Instead, they send commands
 * directly to bridges (bridge_command), worker local execution (worker_local_command),
 * or headless DCC programs (worker_headless_command) using the existing correlation
 * ID pattern for result matching.
 */

import type { Job, TaskSpec } from "@arkestrator/protocol";
import type { WebSocketHub } from "../ws/hub.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { WorkerResourceLeaseManager, WorkerResourceLease } from "./resource-control.js";
import type { ApiBridgeExecutor } from "../api-bridges/executor.js";
import { resolveBridgeTargets } from "./resource-control.js";
import { newId } from "../utils/id.js";
import { normalizeQuotes } from "../utils/worker-identity.js";
import { logger } from "../utils/logger.js";

export interface TaskExecutorDeps {
  hub: WebSocketHub;
  jobsRepo: JobsRepo;
  headlessProgramsRepo: HeadlessProgramsRepo;
  resourceLeaseManager: WorkerResourceLeaseManager;
  apiBridgeExecutor?: ApiBridgeExecutor;
}

interface PendingTask {
  jobId: string;
  correlationId: string;
  timer: ReturnType<typeof setTimeout>;
  lease?: WorkerResourceLease;
}

export class TaskExecutor {
  private pending = new Map<string, PendingTask>();

  constructor(private deps: TaskExecutorDeps) {}

  /** Number of in-flight task jobs (for concurrency tracking). */
  get count(): number {
    return this.pending.size;
  }

  /** Check if a correlation ID belongs to a pending task job. */
  has(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }

  /**
   * Dispatch a task job to the appropriate bridge/worker.
   * The job must already be claimed (status = 'running').
   */
  async dispatch(job: Job): Promise<{ ok: boolean; error?: string }> {
    const spec = job.taskSpec;
    if (!spec) {
      return { ok: false, error: "Task job is missing taskSpec" };
    }

    const correlationId = newId();

    try {
      switch (spec.executionType) {
        case "bridge_command":
          return this.dispatchBridgeCommand(job, spec, correlationId);

        case "worker_local":
          return this.dispatchWorkerLocal(job, spec, correlationId);

        case "worker_headless":
          return this.dispatchWorkerHeadless(job, spec, correlationId);

        case "api_call":
          return this.dispatchApiCall(job);

        default:
          return { ok: false, error: `Unknown execution type: ${spec.executionType}` };
      }
    } catch (err: any) {
      this.failJob(job.id, `Task dispatch error: ${err?.message ?? err}`);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Handle a result arriving for a pending task job.
   * Called from the WS handler when a bridge_command_result, worker_local_result,
   * or worker_headless_result matches a pending task correlation ID.
   */
  handleResult(
    correlationId: string,
    success: boolean,
    result: {
      stdout?: string | null;
      stderr?: string | null;
      errors?: string[];
      exitCode?: number | null;
      outputs?: any[];
    },
  ): boolean {
    const pending = this.pending.get(correlationId);
    if (!pending) return false;

    this.clearPending(correlationId);

    const logParts: string[] = [];
    if (result.stdout) logParts.push(result.stdout);
    if (result.stderr) logParts.push(`[stderr] ${result.stderr}`);
    if (result.errors?.length) logParts.push(`[errors] ${result.errors.join("; ")}`);
    const logs = logParts.join("\n");

    if (success) {
      this.deps.jobsRepo.complete(pending.jobId, [], logs);
      logger.info("task-executor", `Task job ${pending.jobId} completed successfully`);
    } else {
      const errorMsg = result.errors?.join("; ") || result.stderr || "Task execution failed";
      this.deps.jobsRepo.fail(pending.jobId, errorMsg, logs);
      logger.warn("task-executor", `Task job ${pending.jobId} failed: ${errorMsg}`);
    }

    this.broadcastJobUpdated(pending.jobId);
    return true;
  }

  /**
   * Handle incremental progress from a running task job.
   * Called from the WS handler when a task_progress message arrives.
   */
  handleProgress(
    jobId: string,
    percent: number | null,
    statusText?: string,
  ): void {
    this.deps.jobsRepo.updateTaskProgress(jobId, percent, statusText);
    this.broadcastJobUpdated(jobId);
  }

  /**
   * Cancel a pending task job. Cleans up timers and leases.
   */
  cancel(jobId: string): boolean {
    // Find by jobId (not correlationId)
    for (const [corrId, pending] of this.pending) {
      if (pending.jobId === jobId) {
        this.clearPending(corrId);
        return true;
      }
    }
    return false;
  }

  // ---------- Private dispatch methods ----------

  private dispatchBridgeCommand(
    job: Job,
    spec: TaskSpec,
    correlationId: string,
  ): { ok: boolean; error?: string } {
    if (!spec.targetProgram) {
      this.failJob(job.id, "bridge_command task requires targetProgram");
      return { ok: false, error: "targetProgram is required for bridge_command" };
    }
    if (!spec.commands?.length) {
      this.failJob(job.id, "bridge_command task requires commands");
      return { ok: false, error: "commands array is required for bridge_command" };
    }

    const resolution = resolveBridgeTargets(
      this.deps.hub,
      spec.targetProgram,
      "program",
      job.targetWorkerName,
    );

    if (resolution.error || resolution.targets.length === 0) {
      const err = resolution.error || `No ${spec.targetProgram} bridges connected`;
      this.failJob(job.id, err);
      return { ok: false, error: err };
    }

    // Send to first available target
    const targetWs = resolution.targets[0];
    targetWs.send(
      JSON.stringify({
        type: "bridge_command",
        id: newId(),
        payload: {
          senderId: "task-executor",
          commands: spec.commands,
          correlationId,
          projectPath: spec.cwd,
        },
      }),
    );

    // Track the job's used bridge
    this.deps.jobsRepo.addUsedBridge(job.id, spec.targetProgram);

    this.registerPending(job.id, correlationId, spec.timeoutMs ?? 600_000);
    logger.info("task-executor", `Dispatched bridge_command task ${job.id} to ${spec.targetProgram}`);
    return { ok: true };
  }

  private dispatchWorkerLocal(
    job: Job,
    spec: TaskSpec,
    correlationId: string,
  ): { ok: boolean; error?: string } {
    if (!spec.command) {
      this.failJob(job.id, "worker_local task requires command");
      return { ok: false, error: "command is required for worker_local" };
    }

    // Find a client connection on the target worker
    const targetClient = this.findClientForWorker(job.targetWorkerName);
    if (!targetClient) {
      const err = job.targetWorkerName
        ? `No client connected for worker "${job.targetWorkerName}"`
        : "No client connected to execute worker_local task";
      this.failJob(job.id, err);
      return { ok: false, error: err };
    }

    this.deps.hub.send(targetClient, {
      type: "worker_local_command",
      id: newId(),
      payload: {
        senderId: "task-executor",
        correlationId,
        mode: spec.localMode ?? "shell",
        command: spec.command,
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs ?? 600_000,
      },
    });

    this.registerPending(job.id, correlationId, spec.timeoutMs ?? 600_000);
    logger.info("task-executor", `Dispatched worker_local task ${job.id}`);
    return { ok: true };
  }

  private dispatchWorkerHeadless(
    job: Job,
    spec: TaskSpec,
    correlationId: string,
  ): { ok: boolean; error?: string } {
    if (!spec.targetProgram) {
      this.failJob(job.id, "worker_headless task requires targetProgram");
      return { ok: false, error: "targetProgram is required for worker_headless" };
    }
    if (!spec.commands?.length) {
      this.failJob(job.id, "worker_headless task requires commands");
      return { ok: false, error: "commands array is required for worker_headless" };
    }

    // Find client on target worker that has headless capability for this program
    const targetClient = this.findClientForWorker(job.targetWorkerName);
    if (!targetClient) {
      const err = job.targetWorkerName
        ? `No client connected for worker "${job.targetWorkerName}"`
        : "No client connected to execute worker_headless task";
      this.failJob(job.id, err);
      return { ok: false, error: err };
    }

    // Look up headless config for this program
    const headlessConfig = this.deps.hub.getWorkerHeadlessProgram(
      job.targetWorkerName ?? "",
      spec.targetProgram,
    );
    if (!headlessConfig) {
      const err = `No headless capability for "${spec.targetProgram}" on worker "${job.targetWorkerName ?? "any"}"`;
      this.failJob(job.id, err);
      return { ok: false, error: err };
    }

    this.deps.hub.send(targetClient, {
      type: "worker_headless_command",
      id: newId(),
      payload: {
        senderId: "task-executor",
        correlationId,
        program: spec.targetProgram,
        projectPath: spec.cwd,
        timeoutMs: spec.timeoutMs ?? 600_000,
        execution: {
          mode: "commands" as const,
          config: headlessConfig,
          commands: spec.commands,
        },
      },
    });

    this.deps.jobsRepo.addUsedBridge(job.id, spec.targetProgram);

    this.registerPending(job.id, correlationId, spec.timeoutMs ?? 600_000);
    logger.info("task-executor", `Dispatched worker_headless task ${job.id} for ${spec.targetProgram}`);
    return { ok: true };
  }

  private async dispatchApiCall(
    job: Job,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.apiBridgeExecutor) {
      this.failJob(job.id, "API bridge executor not available");
      return { ok: false, error: "API bridge executor not initialized" };
    }
    // Delegate entirely to the API bridge executor (handles its own async lifecycle)
    return this.deps.apiBridgeExecutor.dispatch(job);
  }

  // ---------- Helpers ----------

  private registerPending(jobId: string, correlationId: string, timeoutMs: number) {
    const timer = setTimeout(() => this.handleTimeout(correlationId), timeoutMs + 5_000);
    this.pending.set(correlationId, { jobId, correlationId, timer });
  }

  private clearPending(correlationId: string) {
    const pending = this.pending.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.lease?.release();
      this.pending.delete(correlationId);
    }
  }

  private handleTimeout(correlationId: string) {
    const pending = this.pending.get(correlationId);
    if (!pending) return;

    this.clearPending(correlationId);
    this.deps.jobsRepo.fail(pending.jobId, "Task execution timed out", "");
    this.broadcastJobUpdated(pending.jobId);
    logger.warn("task-executor", `Task job ${pending.jobId} timed out`);
  }

  private failJob(jobId: string, error: string) {
    this.deps.jobsRepo.fail(jobId, error, "");
    this.broadcastJobUpdated(jobId);
  }

  private broadcastJobUpdated(jobId: string) {
    const job = this.deps.jobsRepo.getById(jobId);
    if (job) {
      this.deps.hub.broadcastToType("client", {
        type: "job_updated",
        id: newId(),
        payload: { job },
      });
    }
  }

  /**
   * Find a client WebSocket connection ID for a given worker name.
   * If no workerName specified, returns the first connected client.
   */
  private findClientForWorker(workerName?: string): string | null {
    const clients = this.deps.hub.getClients();
    if (!workerName) {
      return clients[0]?.id ?? null;
    }
    const normalized = normalizeQuotes(workerName).trim().toLowerCase();
    for (const client of clients) {
      const clientWorker = normalizeQuotes(String(client.workerName ?? "")).trim().toLowerCase();
      if (clientWorker === normalized) {
        return client.id;
      }
    }
    return null;
  }
}
