/**
 * Local LLM concurrency gate.
 *
 * Ensures only one local-oss job runs at a time per worker machine.
 * This prevents multiple Ollama requests from competing for the same GPU,
 * which causes timeouts and OOM errors on consumer GPUs.
 *
 * The gate is checked by the worker loop before dispatching a local-oss job.
 * Jobs that can't run yet stay queued and are picked up on the next tick.
 */

import { logger } from "../utils/logger.js";

interface LocalLlmSlot {
  jobId: string;
  workerName: string;
  model: string;
  startedAt: number;
}

export class LocalLlmGate {
  /** Active local-oss jobs, keyed by jobId. */
  private active = new Map<string, LocalLlmSlot>();

  /**
   * Check if a local-oss job can start on the given worker.
   * Returns true if the worker has no other local-oss job running.
   */
  canStart(workerName: string): boolean {
    const normalized = workerName.trim().toLowerCase();
    for (const slot of this.active.values()) {
      if (slot.workerName === normalized) {
        return false;
      }
    }
    return true;
  }

  /**
   * Register a local-oss job as running on a worker.
   */
  acquire(jobId: string, workerName: string, model: string): void {
    const normalized = workerName.trim().toLowerCase();
    this.active.set(jobId, {
      jobId,
      workerName: normalized,
      model,
      startedAt: Date.now(),
    });
    logger.info(
      "local-llm-gate",
      `Acquired slot for job ${jobId} on worker "${workerName}" (model: ${model}). Active: ${this.active.size}`,
    );
  }

  /**
   * Release a local-oss job slot when the job completes/fails.
   */
  release(jobId: string): void {
    const slot = this.active.get(jobId);
    if (slot) {
      const durationMs = Date.now() - slot.startedAt;
      logger.info(
        "local-llm-gate",
        `Released slot for job ${jobId} on worker "${slot.workerName}" after ${Math.floor(durationMs / 1000)}s. Active: ${this.active.size - 1}`,
      );
      this.active.delete(jobId);
    }
  }

  /**
   * Get the currently running job on a worker (if any).
   */
  getActiveOnWorker(workerName: string): LocalLlmSlot | undefined {
    const normalized = workerName.trim().toLowerCase();
    for (const slot of this.active.values()) {
      if (slot.workerName === normalized) {
        return slot;
      }
    }
    return undefined;
  }

  /**
   * Get count of active local-oss jobs.
   */
  get count(): number {
    return this.active.size;
  }
}
