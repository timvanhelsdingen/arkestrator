import type { Job } from "@arkestrator/protocol";
import type { Scheduler } from "./scheduler.js";
import type { ProcessTracker } from "../agents/process-tracker.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { ProjectsRepo } from "../db/projects.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { Config } from "../config.js";
import type { SyncManager } from "../workspace/sync-manager.js";
import type { UsageRepo } from "../db/usage.repo.js";
import type { UsersRepo, TokenLimitPeriod } from "../db/users.repo.js";
import type { DependenciesRepo } from "../db/dependencies.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { WorkerResourceLeaseManager } from "../agents/resource-control.js";
import type { LocalLlmGate } from "../agents/local-llm-gate.js";
import { spawnAgent } from "../agents/spawner.js";
import { applyRuntimeOptionsToConfig } from "../agents/runtime-options.js";
import { getToolRestrictions } from "../policies/enforcer.js";
import { newId } from "../utils/id.js";
import { normalizeQuotes } from "../utils/worker-identity.js";
import { logger } from "../utils/logger.js";

export interface WorkerDeps {
  scheduler: Scheduler;
  processTracker: ProcessTracker;
  agentsRepo: AgentsRepo;
  jobsRepo: JobsRepo;
  policiesRepo: PoliciesRepo;
  projectsRepo: ProjectsRepo;
  workersRepo: WorkersRepo;
  usageRepo: UsageRepo;
  usersRepo: UsersRepo;
  depsRepo: DependenciesRepo;
  headlessProgramsRepo: HeadlessProgramsRepo;
  settingsRepo?: SettingsRepo;
  skillsRepo?: SkillsRepo;
  skillStore?: import("../skills/skill-store.js").SkillStore;
  skillEffectivenessRepo?: import("../db/skill-effectiveness.repo.js").SkillEffectivenessRepo;
  skillIndex?: import("../skills/skill-index.js").SkillIndex;
  routingOutcomesRepo?: import("../db/routing-outcomes.repo.js").RoutingOutcomesRepo;
  resourceLeaseManager: WorkerResourceLeaseManager;
  localLlmGate: LocalLlmGate;
  hub: WebSocketHub;
  config: Config;
  syncManager: SyncManager;
  maxConcurrent: number;
  pollIntervalMs: number;
}

/** Compute the start of the current period for token limit checking. */
function getPeriodStart(period: TokenLimitPeriod): string {
  const now = new Date();
  switch (period) {
    case "daily": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return start.toISOString();
    }
    case "monthly": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return start.toISOString();
    }
    case "unlimited":
      return "1970-01-01T00:00:00.000Z";
  }
}

export class WorkerLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDiagTick = 0;
  private currentPollMs = 0;
  private readonly minPollMs: number;
  private readonly maxPollMs: number;

  constructor(private deps: WorkerDeps) {
    const base = Math.max(100, deps.pollIntervalMs);
    this.currentPollMs = base;
    this.minPollMs = Math.max(100, Math.floor(base * 0.5));
    this.maxPollMs = Math.max(5000, base * 8);
  }

  start() {
    logger.info(
      "worker",
      `Starting worker loop (max concurrent: ${this.deps.maxConcurrent}, poll: adaptive base=${this.deps.pollIntervalMs}ms min=${this.minPollMs}ms max=${this.maxPollMs}ms)`,
    );
    this.scheduleNextTick(0);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("worker", "Worker loop stopped");
  }

  /**
   * Manually dispatch a specific queued job, bypassing the normal poll cycle.
   * Returns { ok, error? } describing what happened.
   */
  dispatchById(jobId: string): { ok: boolean; error?: string } {
    const job = this.deps.jobsRepo.getById(jobId);
    if (!job) return { ok: false, error: "Job not found" };
    if (job.status !== "queued") return { ok: false, error: `Job is ${job.status}, not queued` };

    const running = this.deps.processTracker.count;
    if (running >= this.deps.maxConcurrent) {
      return {
        ok: false,
        error: `All ${this.deps.maxConcurrent} concurrency slots are in use (${running} running). The job will start when a slot frees up.`,
      };
    }

    return this.dispatchJob(job);
  }

  /** Broadcast a job_updated message to all connected clients */
  private broadcastJobUpdated(jobId: string) {
    const updatedJob = this.deps.jobsRepo.getById(jobId);
    if (updatedJob) {
      this.deps.hub.broadcastToType("client", {
        type: "job_updated",
        id: newId(),
        payload: { job: updatedJob },
      });
    }
  }

  /** Core dispatch logic for a single job. Shared by tick() and dispatchById(). */
  private dispatchJob(job: Job): { ok: boolean; error?: string } {
    // Atomically claim the job (sets status = 'running' in DB)
    const claimed = this.deps.jobsRepo.claim(job.id);
    if (!claimed) return { ok: false, error: "Failed to claim job (may have already started)" };

    // Immediately notify all clients that this job is now running.
    // spawnAgent() also calls broadcastJobUpdated but only after the process
    // is successfully spawned, which can be seconds later (file scanning, CLI
    // wrapper setup, etc.). Without this early broadcast the client shows
    // 'queued' indefinitely while the job is already claimed as 'running'.
    this.broadcastJobUpdated(job.id);

    // Eagerly acquire the local LLM gate so subsequent tick() calls see
    // this worker's GPU as busy. The gate is released inside spawnAgent()
    // when the job completes or fails.
    const jobConfig = this.deps.agentsRepo.getById(job.agentConfigId);
    if (jobConfig?.engine === "local-oss") {
      // Use targetWorkerName if set, otherwise fall back to "server" as the
      // default gate key. This ensures the GPU gate works even when no
      // explicit worker target is specified (e.g. localModelHost=server).
      const gateKey = job.targetWorkerName
        ? normalizeQuotes(job.targetWorkerName).trim().toLowerCase()
        : "__server__";
      this.deps.localLlmGate.acquire(job.id, gateKey, job.runtimeOptions?.model ?? jobConfig.model ?? "unknown");
    }

    // Check per-user token budget before spawning
    if (job.submittedBy) {
      const user = this.deps.usersRepo.getById(job.submittedBy);
      if (user && (user.tokenLimitInput !== null || user.tokenLimitOutput !== null)) {
        const periodStart = getPeriodStart(user.tokenLimitPeriod);
        const usage = this.deps.usageRepo.getByUserIdSince(job.submittedBy, periodStart);

        if (user.tokenLimitInput !== null && usage.totalInput >= user.tokenLimitInput) {
          this.deps.jobsRepo.fail(
            job.id,
            `Token budget exceeded: input tokens used (${usage.totalInput}) >= limit (${user.tokenLimitInput}) for ${user.tokenLimitPeriod} period`,
            "",
          );
          this.broadcastJobUpdated(job.id);
          logger.warn("worker", `Job ${job.id} rejected: user ${user.username} over input token budget`);
          return { ok: false, error: "Token budget exceeded (input)" };
        }
        if (user.tokenLimitOutput !== null && usage.totalOutput >= user.tokenLimitOutput) {
          this.deps.jobsRepo.fail(
            job.id,
            `Token budget exceeded: output tokens used (${usage.totalOutput}) >= limit (${user.tokenLimitOutput}) for ${user.tokenLimitPeriod} period`,
            "",
          );
          this.broadcastJobUpdated(job.id);
          logger.warn("worker", `Job ${job.id} rejected: user ${user.username} over output token budget`);
          return { ok: false, error: "Token budget exceeded (output)" };
        }
      }
    }

    const config = this.deps.agentsRepo.getById(job.agentConfigId);
    if (!config) {
      logger.error(
        "worker",
        `Agent config ${job.agentConfigId} not found for job ${job.id}`,
      );
      this.deps.jobsRepo.fail(
        job.id,
        `Agent config not found: ${job.agentConfigId}`,
        "",
      );
      this.broadcastJobUpdated(job.id);
      return { ok: false, error: `Agent config not found: ${job.agentConfigId}` };
    }

    // Load effective policies for this job's user
    const policies = this.deps.policiesRepo.getEffectiveForUser(job.submittedBy ?? null);
    const toolRestrictions = getToolRestrictions(policies);
    const filePathPolicies = policies.filter((p) => p.type === "file_path");
    const commandFilterPolicies = policies.filter((p) => p.type === "command_filter");

    // If job has a targetWorkerName but no editorContext.projectRoot, inject the worker's lastProjectPath
    let enrichedJob = job;
    if (job.targetWorkerName && !job.editorContext?.projectRoot) {
      const worker = this.deps.workersRepo.getByName(job.targetWorkerName);
      if (worker?.lastProjectPath) {
        enrichedJob = {
          ...job,
          editorContext: {
            ...job.editorContext,
            projectRoot: worker.lastProjectPath,
          },
        };
        logger.info(
          "worker",
          `Injected projectRoot "${worker.lastProjectPath}" from worker "${job.targetWorkerName}" for job ${job.id}`,
        );
      }
    }

    const effectiveConfig = applyRuntimeOptionsToConfig(
      config,
      job.runtimeOptions,
    );

    logger.info(
      "worker",
      `Dispatching job ${job.id} to agent "${effectiveConfig.name}"`,
    );

    // Fire-and-forget: spawner manages its own lifecycle
    spawnAgent(enrichedJob, effectiveConfig, {
      processTracker: this.deps.processTracker,
      hub: this.deps.hub,
      jobsRepo: this.deps.jobsRepo,
      agentsRepo: this.deps.agentsRepo,
      projectsRepo: this.deps.projectsRepo,
      config: this.deps.config,
      syncManager: this.deps.syncManager,
      usageRepo: this.deps.usageRepo,
      depsRepo: this.deps.depsRepo,
      headlessProgramsRepo: this.deps.headlessProgramsRepo,
      settingsRepo: this.deps.settingsRepo,
      skillsRepo: this.deps.skillsRepo,
      skillStore: this.deps.skillStore,
      skillEffectivenessRepo: this.deps.skillEffectivenessRepo,
      skillIndex: this.deps.skillIndex,
      routingOutcomesRepo: this.deps.routingOutcomesRepo,
      workersRepo: this.deps.workersRepo,
      resourceLeaseManager: this.deps.resourceLeaseManager,
      localLlmGate: this.deps.localLlmGate,
      policiesRepo: this.deps.policiesRepo,
      toolRestrictions,
      filePathPolicies,
      commandFilterPolicies,
    });

    return { ok: true };
  }

  private scheduleNextTick(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(25, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private lastExpiryCheck = 0;
  private readonly EXPIRY_CHECK_INTERVAL = 60_000; // Check TTL every 60s

  private tick() {
    let nextPollMs = this.currentPollMs;
    try {
      // Periodically expire stale worker-targeted jobs
      const now = Date.now();
      if (now - this.lastExpiryCheck >= this.EXPIRY_CHECK_INTERVAL) {
        this.lastExpiryCheck = now;
        const expired = this.deps.jobsRepo.expireStaleTargetedJobs();
        if (expired > 0) {
          logger.info("worker", `Expired ${expired} stale worker-targeted job(s) past TTL`);
        }
      }

      const running = this.deps.processTracker.count;
      const availableSlots = this.deps.maxConcurrent - running;

      // Periodic diagnostic logging (every 10 seconds)
      if (now - this.lastDiagTick >= 10_000) {
        this.lastDiagTick = now;
        if (running > 0 || availableSlots === 0) {
          logger.debug(
            "worker",
            `Worker tick: ${running}/${this.deps.maxConcurrent} slots used, ${availableSlots} available (poll=${this.currentPollMs}ms)`,
          );
        }
      }

      if (availableSlots <= 0) {
        // Busy system: keep polling faster so queued work starts quickly as soon as a slot opens.
        nextPollMs = this.minPollMs;
        return;
      }

      let dispatchedCount = 0;

      // Collect connected worker names so worker-targeted jobs can be matched.
      // If bridges are connected, prefer pickNextForWorker which also returns
      // untargeted jobs but prioritises jobs targeted at a connected worker.
      const connectedWorkers = new Set<string>();
      for (const b of this.deps.hub.getBridges()) {
        const wn = normalizeQuotes(String(b.workerName ?? "")).trim().toLowerCase();
        if (wn) connectedWorkers.add(wn);
      }
      // Also include workers that have a client connected (no bridges needed for general tasks)
      for (const c of this.deps.hub.getClients()) {
        const wn = normalizeQuotes(String(c.workerName ?? "")).trim().toLowerCase();
        if (wn) connectedWorkers.add(wn);
      }
      const workerNames = [...connectedWorkers];

      for (let i = 0; i < availableSlots; i++) {
        let job: Job | null = null;

        // Round-robin across connected workers to ensure fair scheduling.
        // Without this, the first worker in the list would always get priority,
        // starving other workers' targeted jobs when all slots are busy.
        if (workerNames.length > 0) {
          const startIdx = (dispatchedCount + i) % workerNames.length;
          for (let wi = 0; wi < workerNames.length; wi++) {
            const wn = workerNames[(startIdx + wi) % workerNames.length];
            job = this.deps.scheduler.pickNextForWorker(wn);
            if (job) break;
          }
        }
        if (!job) {
          job = this.deps.scheduler.pickNext();
        }
        if (!job) break;

        // Guard: if job targets a worker that isn't connected, skip it.
        // It stays queued and will be picked up once the target worker connects.
        if (job.targetWorkerName) {
          const targetNorm = normalizeQuotes(job.targetWorkerName).trim().toLowerCase();
          if (targetNorm && !connectedWorkers.has(targetNorm)) {
            logger.debug(
              "worker",
              `Skipping job ${job.id}: target worker "${job.targetWorkerName}" not connected`,
            );
            continue;
          }
        }

        // Guard: local-oss jobs must wait if the GPU is already busy with
        // another local-oss job. Ollama can only serve one generation at a time
        // per GPU, so concurrent jobs cause timeouts and OOM errors.
        const jobConfig = this.deps.agentsRepo.getById(job.agentConfigId);
        if (jobConfig?.engine === "local-oss") {
          const gateKey = job.targetWorkerName
            ? normalizeQuotes(job.targetWorkerName).trim().toLowerCase()
            : "__server__";
          if (!this.deps.localLlmGate.canStart(gateKey)) {
            const active = this.deps.localLlmGate.getActiveOnWorker(gateKey);
            logger.debug(
              "worker",
              `Skipping local-oss job ${job.id}: GPU busy with job ${active?.jobId} (model: ${active?.model})`,
            );
            continue;
          }
        }

        this.dispatchJob(job);
        dispatchedCount++;
      }

      if (dispatchedCount > 0) {
        // Jobs were available, stay snappy.
        nextPollMs = this.minPollMs;
      } else {
        // Check if queued jobs exist that we couldn't dispatch (e.g. target worker
        // not connected yet). If so, keep polling aggressively so we pick them up
        // as soon as the target worker connects.
        const hasQueuedWork = this.deps.scheduler.pickNext() !== null;
        if (hasQueuedWork) {
          nextPollMs = this.minPollMs;
        } else if (running > 0) {
          // Active jobs but empty queue: moderate cadence.
          nextPollMs = Math.max(this.minPollMs, Math.min(this.deps.pollIntervalMs, Math.floor(this.currentPollMs * 0.9)));
        } else {
          // Fully idle: back off gradually to avoid needless wakeups.
          nextPollMs = Math.min(this.maxPollMs, Math.max(this.deps.pollIntervalMs, Math.floor(this.currentPollMs * 1.6)));
        }
      }
    } catch (err: any) {
      logger.error("worker", `Worker tick error: ${err?.message ?? err}`);
      nextPollMs = this.deps.pollIntervalMs;
    } finally {
      if (nextPollMs !== this.currentPollMs) {
        logger.debug("worker", `Worker poll interval adjusted: ${this.currentPollMs}ms -> ${nextPollMs}ms`);
      }
      this.currentPollMs = nextPollMs;
      this.scheduleNextTick(this.currentPollMs);
    }
  }
}
