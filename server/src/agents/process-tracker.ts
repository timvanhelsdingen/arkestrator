import type { Subprocess } from "bun";
import { logger } from "../utils/logger.js";

interface TrackedProcess {
  process: Subprocess;
  startTime: number;
  jobId: string;
  /** Per-job timeout override (if set, takes precedence over the global default). */
  timeoutMs?: number;
}

export class ProcessTracker {
  private processes = new Map<string, TrackedProcess>();
  private timeoutChecker: ReturnType<typeof setInterval> | null = null;

  constructor(private getJobTimeoutMs: number | (() => number)) {}

  /** Resolve the current global job timeout (supports static number or dynamic getter). */
  private get jobTimeoutMs(): number {
    return typeof this.getJobTimeoutMs === "function" ? this.getJobTimeoutMs() : this.getJobTimeoutMs;
  }

  register(jobId: string, proc: Subprocess, timeoutMs?: number) {
    this.processes.set(jobId, {
      process: proc,
      startTime: Date.now(),
      jobId,
      timeoutMs,
    });
    logger.debug("process-tracker", `Registered process for job ${jobId}`);
  }

  unregister(jobId: string) {
    this.processes.delete(jobId);
    logger.debug("process-tracker", `Unregistered process for job ${jobId}`);
  }

  kill(jobId: string): boolean {
    const tracked = this.processes.get(jobId);
    if (!tracked) return false;

    logger.info("process-tracker", `Killing process for job ${jobId}`);
    tracked.process.kill();
    this.processes.delete(jobId);
    return true;
  }

  /** Retrieve the subprocess handle for a running job (e.g. to write to stdin). */
  getProcess(jobId: string): Subprocess | null {
    const tracked = this.processes.get(jobId);
    return tracked?.process ?? null;
  }

  get count(): number {
    // Only count active processes — suspended jobs intentionally do NOT count
    // so that their concurrency slot is freed for child analysis jobs.
    return this.processes.size;
  }

  // ── Suspend/resume for training parent jobs ──────────────────────────
  // When a training parent job polls a child analysis job, the parent
  // holds a concurrency slot but doesn't need a running process. By
  // suspending, we free the slot so the child can be dispatched (critical
  // when maxConcurrent=1).
  private suspended = new Map<string, { proc: Subprocess; timeoutMs?: number; startTime: number }>();

  /**
   * Temporarily release a job's concurrency slot without killing the process.
   * Returns the tracked state for later re-registration, or null if not found.
   */
  suspend(jobId: string): boolean {
    const tracked = this.processes.get(jobId);
    if (!tracked) return false;
    this.suspended.set(jobId, {
      proc: tracked.process,
      timeoutMs: tracked.timeoutMs,
      startTime: tracked.startTime,
    });
    this.processes.delete(jobId);
    logger.debug("process-tracker", `Suspended process slot for job ${jobId} (frees concurrency slot)`);
    return true;
  }

  /** Re-register a suspended job, reclaiming its concurrency slot. */
  resume(jobId: string): boolean {
    const state = this.suspended.get(jobId);
    if (!state) return false;
    this.processes.set(jobId, {
      process: state.proc,
      startTime: state.startTime,
      jobId,
      timeoutMs: state.timeoutMs,
    });
    this.suspended.delete(jobId);
    logger.debug("process-tracker", `Resumed process slot for job ${jobId}`);
    return true;
  }

  /** Start periodic timeout checks */
  startTimeoutChecker(onTimeout: (jobId: string) => void) {
    this.timeoutChecker = setInterval(() => {
      const now = Date.now();
      for (const [jobId, tracked] of this.processes) {
        const effectiveTimeout = tracked.timeoutMs ?? this.jobTimeoutMs;
        if (now - tracked.startTime > effectiveTimeout) {
          logger.warn(
            "process-tracker",
            `Job ${jobId} timed out after ${Math.floor((now - tracked.startTime) / 1000)}s`,
          );
          tracked.process.kill();
          this.processes.delete(jobId);
          onTimeout(jobId);
        }
      }
    }, 30_000);
  }

  stop() {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
    }
    // Kill all running processes (active + suspended)
    for (const [jobId, tracked] of this.processes) {
      logger.info("process-tracker", `Killing process for job ${jobId} (shutdown)`);
      tracked.process.kill();
    }
    for (const [jobId, state] of this.suspended) {
      logger.info("process-tracker", `Killing suspended process for job ${jobId} (shutdown)`);
      state.proc.kill();
    }
    this.processes.clear();
    this.suspended.clear();
  }
}
