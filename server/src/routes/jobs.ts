import { Hono } from "hono";
import { JobInterventionCreate, JobSubmit, JobPriority, JobOutcomeRating } from "@arkestrator/protocol";
import { z } from "zod";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { UsageRepo } from "../db/usage.repo.js";
import type { DependenciesRepo } from "../db/dependencies.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { ProcessTracker } from "../agents/process-tracker.js";
import type { SkillEffectivenessRepo } from "../db/skill-effectiveness.repo.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TARGET_WORKER_TTL_MS } from "../queue/retry-policy.js";
import {
  apiKeyRoleAllowed,
  getAuthPrincipal,
  getClientIp,
  principalHasPermission,
  type AuthPrincipal,
} from "../middleware/auth.js";
import { validateJobSubmission, checkTokenBudget, checkCostBudget } from "../policies/enforcer.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";
import { getNetworkControls } from "../security/network-policy.js";
import { evaluateWorkerAccess, getWorkerRule } from "../security/worker-rules.js";
import {
  applyPromptBridgeExecutionMode,
  normalizeJobRuntimeOptions,
  resolveModelForRun,
} from "../agents/runtime-options.js";
import { getJobInterventionSupport, tryDeliverGuidanceViaStdin } from "../agents/job-interventions.js";
import { isModelAllowedByStoredAllowlist } from "../local-models/catalog.js";
import { resolveAutoAgentByPriority } from "../agents/auto-routing.js";
import {
  filterCoordinatorSourcePathsByProgram,
  loadCoordinatorPlaybookContextDetailed,
  parseCoordinatorReferencePaths,
  parseCoordinatorSourcePrograms,
  recordCoordinatorContextOutcome,
  recordCoordinatorExecutionOutcome,
  type CoordinatorOutcomeSignal,
} from "../agents/coordinator-playbooks.js";
import {
  parseTrainingRepositoryOverrides,
  parseTrainingRepositoryPolicy,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
} from "../agents/training-repository.js";

// Per-key job submission rate limiter
const jobSubmitRates = new Map<
  string,
  { count: number; resetAt: number; windowMs: number; max: number }
>();

/** Max distinct rate limit keys to prevent unbounded Map growth from key rotation. */
const RATE_LIMIT_MAX_ENTRIES = 10_000;

function checkJobRateLimit(
  key: string,
  config: { windowMs: number; max: number },
): boolean {
  const now = Date.now();
  const entry = jobSubmitRates.get(key);
  if (
    !entry
    || now > entry.resetAt
    || entry.windowMs !== config.windowMs
    || entry.max !== config.max
  ) {
    // Evict oldest entries if at capacity (LRU-style: delete first key)
    if (!entry && jobSubmitRates.size >= RATE_LIMIT_MAX_ENTRIES) {
      const firstKey = jobSubmitRates.keys().next().value;
      if (firstKey !== undefined) jobSubmitRates.delete(firstKey);
    }
    jobSubmitRates.set(key, {
      count: 1,
      resetAt: now + config.windowMs,
      windowMs: config.windowMs,
      max: config.max,
    });
    return true;
  }
  entry.count++;
  return entry.count <= config.max;
}

// Cleanup expired entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of jobSubmitRates) {
    if (now > entry.resetAt) jobSubmitRates.delete(key);
  }
}, 2 * 60 * 1000);

const JobRequeuePayloadSchema = z.object({
  targetWorkerName: z.string().trim().min(1).optional(),
});

export function createJobRoutes(
  jobsRepo: JobsRepo,
  agentsRepo: AgentsRepo,
  policiesRepo: PoliciesRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
  usageRepo: UsageRepo,
  depsRepo: DependenciesRepo,
  apiKeysRepo: ApiKeysRepo,
  settingsRepo: SettingsRepo,
  jobInterventionsRepoOrHub?: JobInterventionsRepo | WebSocketHub,
  hubOrDispatchFn?: WebSocketHub | ((jobId: string) => { ok: boolean; error?: string }),
  dispatchFnOrCoordinatorPlaybooksDir?: ((jobId: string) => { ok: boolean; error?: string }) | string,
  coordinatorPlaybooksDirOrDefaultSourcePaths?: string | string[],
  defaultCoordinatorPlaybookSourcePathsOrProcessTracker: string[] | ProcessTracker = [],
  processTrackerArg?: ProcessTracker,
  skillEffectivenessRepo?: SkillEffectivenessRepo,
) {
  const isHub = (value: unknown): value is WebSocketHub =>
    !!value && typeof (value as WebSocketHub).broadcastToType === "function";
  const isJobInterventions = (value: unknown): value is JobInterventionsRepo =>
    !!value
    && typeof (value as JobInterventionsRepo).listByJob === "function"
    && typeof (value as JobInterventionsRepo).create === "function";
  const isDispatchFn = (
    value: unknown,
  ): value is (jobId: string) => { ok: boolean; error?: string } => typeof value === "function";
  const isProcessTracker = (value: unknown): value is ProcessTracker =>
    !!value && typeof (value as ProcessTracker).kill === "function";

  const jobInterventionsRepo = isJobInterventions(jobInterventionsRepoOrHub)
    ? jobInterventionsRepoOrHub
    : undefined;
  const hub = isJobInterventions(jobInterventionsRepoOrHub)
    ? (isHub(hubOrDispatchFn) ? hubOrDispatchFn : undefined)
    : (isHub(jobInterventionsRepoOrHub) ? jobInterventionsRepoOrHub : undefined);
  const dispatchFn = isJobInterventions(jobInterventionsRepoOrHub)
    ? (isDispatchFn(dispatchFnOrCoordinatorPlaybooksDir) ? dispatchFnOrCoordinatorPlaybooksDir : undefined)
    : (isDispatchFn(hubOrDispatchFn) ? hubOrDispatchFn : undefined);
  const coordinatorPlaybooksDir = isJobInterventions(jobInterventionsRepoOrHub)
    ? (typeof coordinatorPlaybooksDirOrDefaultSourcePaths === "string"
      ? coordinatorPlaybooksDirOrDefaultSourcePaths
      : undefined)
    : (typeof dispatchFnOrCoordinatorPlaybooksDir === "string"
      ? dispatchFnOrCoordinatorPlaybooksDir
      : undefined);
  const defaultCoordinatorPlaybookSourcePaths = isJobInterventions(jobInterventionsRepoOrHub)
    ? (Array.isArray(defaultCoordinatorPlaybookSourcePathsOrProcessTracker)
      ? defaultCoordinatorPlaybookSourcePathsOrProcessTracker
      : [])
    : (Array.isArray(coordinatorPlaybooksDirOrDefaultSourcePaths)
      ? coordinatorPlaybooksDirOrDefaultSourcePaths
      : []);
  const processTracker = isJobInterventions(jobInterventionsRepoOrHub)
    ? (isProcessTracker(processTrackerArg)
      ? processTrackerArg
      : (isProcessTracker(defaultCoordinatorPlaybookSourcePathsOrProcessTracker)
        ? defaultCoordinatorPlaybookSourcePathsOrProcessTracker
        : undefined))
    : (isProcessTracker(defaultCoordinatorPlaybookSourcePathsOrProcessTracker)
      ? defaultCoordinatorPlaybookSourcePathsOrProcessTracker
      : undefined);

  const router = new Hono();

  /** Broadcast job_updated to all connected clients */
  function broadcastJob(jobId: string) {
    const job = jobsRepo.getById(jobId);
    if (job && hub) {
      hub.broadcastToType("client", {
        type: "job_updated",
        id: newId(),
        payload: { job: enrichJob(job) },
      });
    }
  }

  function cancelForDelete(jobId: string, status: string): boolean {
    if (!["queued", "paused", "running"].includes(status)) return false;
    if (status === "running") {
      processTracker?.kill(jobId);
    }
    return jobsRepo.cancel(jobId);
  }

  function broadcastIntervention(jobId: string, interventionId: string) {
    if (!jobInterventionsRepo || !hub) return;
    const intervention = jobInterventionsRepo.getById(interventionId);
    const job = jobsRepo.getById(jobId);
    if (!intervention || !job) return;
    hub.broadcastToType("client", {
      type: "job_intervention_updated",
      id: newId(),
      payload: {
        jobId,
        intervention,
        support: getJobInterventionSupport(job, agentsRepo),
      },
    });
  }

  function broadcastInterventions(jobId: string, interventionIds: string[]) {
    if (!jobInterventionsRepo || !hub || interventionIds.length === 0) return;
    const job = jobsRepo.getById(jobId);
    if (!job) return;
    const support = getJobInterventionSupport(job, agentsRepo);
    for (const interventionId of interventionIds) {
      const intervention = jobInterventionsRepo.getById(interventionId);
      if (!intervention) continue;
      hub.broadcastToType("client", {
        type: "job_intervention_updated",
        id: newId(),
        payload: { jobId, intervention, support },
      });
    }
  }

  function maybeDeliverLiveGuidanceOnFetch(
    c: any,
    principal: AuthPrincipal,
    job: ReturnType<typeof jobsRepo.getById>,
  ) {
    if (!jobInterventionsRepo || !job) return;
    const callerJobId = String(c.req.header("x-job-id") ?? "").trim();
    if (!callerJobId || callerJobId !== job.id) return;
    if (principal.kind !== "apiKey") return;
    if (job.status !== "running") return;
    const support = getJobInterventionSupport(job, agentsRepo);
    if (!support.acceptsLiveNotes) return;
    const pending = jobInterventionsRepo.listPending(job.id);
    if (pending.length === 0) return;
    const delivered = jobInterventionsRepo.markDelivered(
      pending.map((entry) => entry.id),
      { channel: "agent-poll", callerJobId },
      "Delivered when the running job fetched its live guidance queue.",
    );
    broadcastInterventions(job.id, delivered.map((entry) => entry.id));
  }

  function canInterveneJob(principal: AuthPrincipal, job: { submittedBy?: string }): boolean {
    if (!canMutateJob(principal, job)) return false;
    return principalHasPermission(principal, "interveneJobs");
  }

  function canListJobInterventions(
    principal: AuthPrincipal,
    job: { id: string; status: string; submittedBy?: string },
    callerJobId?: string,
  ): boolean {
    if (canMutateJob(principal, job)) return true;
    if (principal.kind !== "apiKey") return false;
    if (!apiKeyRoleAllowed(principal.apiKey, ["admin", "client"])) return false;
    return job.status === "running" && callerJobId === job.id;
  }

  /** Enrich a single job with tokenUsage and dependsOn */
  function enrichJob(job: any) {
    const usage = usageRepo.getByJobId(job.id);
    const deps = depsRepo.getDependencies(job.id);
    const submittedByUsername = job.submittedBy
      ? usersRepo.getById(job.submittedBy)?.username ?? undefined
      : undefined;
    return {
      ...job,
      tokenUsage: usage ?? undefined,
      dependsOn: deps.length > 0 ? deps : undefined,
      submittedByUsername,
    };
  }

  /** Batch-enrich multiple jobs (avoids N+1 queries) */
  function enrichJobs(jobs: any[]) {
    if (jobs.length === 0) return jobs;
    const jobIds = jobs.map((j) => j.id);
    const usageMap = usageRepo.getByJobIds(jobIds);
    const depsMap = depsRepo.getDependenciesBatch(jobIds);
    const submittedByUsernames = new Map<string, string>();
    for (const job of jobs) {
      const submittedBy = String(job.submittedBy ?? "").trim();
      if (!submittedBy || submittedByUsernames.has(submittedBy)) continue;
      const user = usersRepo.getById(submittedBy);
      if (user?.username) submittedByUsernames.set(submittedBy, user.username);
    }
    return jobs.map((job) => ({
      ...job,
      tokenUsage: usageMap.get(job.id) ?? undefined,
      dependsOn: depsMap.has(job.id) ? depsMap.get(job.id) : undefined,
      submittedByUsername: job.submittedBy
        ? submittedByUsernames.get(job.submittedBy)
        : undefined,
    }));
  }

  function canAccessJobs(principal: AuthPrincipal): boolean {
    if (principal.kind === "user") return true;
    // API keys: allow if they have any job-related permission
    return principalHasPermission(principal, "submitJobs") ||
           principalHasPermission(principal, "interveneJobs");
  }

  function canCreateJobs(principal: AuthPrincipal): boolean {
    return principalHasPermission(principal, "submitJobs");
  }

  function canMutateJob(principal: AuthPrincipal, job: { submittedBy?: string }): boolean {
    if (principal.kind === "apiKey") {
      return principal.apiKey.role === "admin";
    }
    if (principal.user.role === "admin") return true;
    if (!job.submittedBy) return false;
    return job.submittedBy === principal.user.id;
  }

  function principalToAuditActor(principal: AuthPrincipal): { userId: string | null; username: string } {
    if (principal.kind === "user") {
      return { userId: principal.user.id, username: principal.user.username };
    }
    return { userId: null, username: `api-key:${principal.apiKey.name}` };
  }

  function resolveCoordinatorClientSourcePaths(
    job: { bridgeProgram?: string; editorContext?: { metadata?: Record<string, unknown> } },
  ): string[] {
    const metadata = job.editorContext?.metadata;
    if (!metadata || typeof metadata !== "object") return [];

    const out = new Set<string>();
    const direct = (metadata as Record<string, unknown>).coordinator_client_source_paths;
    if (Array.isArray(direct)) {
      for (const value of direct) {
        const path = String(value ?? "").trim();
        if (path) out.add(path);
      }
    }

    const byProgram = (metadata as Record<string, unknown>).coordinator_client_source_paths_by_program;
    if (byProgram && typeof byProgram === "object") {
      const programKey = String(job.bridgeProgram ?? "").trim();
      const rawList = (byProgram as Record<string, unknown>)[programKey];
      if (Array.isArray(rawList)) {
        for (const value of rawList) {
          const path = String(value ?? "").trim();
          if (path) out.add(path);
        }
      }
    }

    return [...out];
  }

  type NormalizedOutcomeRating = "good" | "average" | "poor";

  function normalizeOutcomeRating(rating: unknown): NormalizedOutcomeRating | null {
    const normalized = String(rating ?? "").trim().toLowerCase();
    if (normalized === "good" || normalized === "positive") return "good";
    if (normalized === "average") return "average";
    if (normalized === "poor" || normalized === "negative") return "poor";
    return null;
  }

  function ratingToStoredOutcome(rating: NormalizedOutcomeRating): JobOutcomeRating {
    if (rating === "good") return "positive";
    if (rating === "average") return "average";
    return "negative";
  }

  function ratingToSignal(rating: NormalizedOutcomeRating): CoordinatorOutcomeSignal {
    if (rating === "good") return "positive";
    if (rating === "average") return "average";
    return "negative";
  }

  function ratingToQualityWeight(rating: NormalizedOutcomeRating): number {
    if (rating === "good") return 1.35;
    if (rating === "average") return 1.0;
    return 1.4;
  }

  function normalizeBridgeProgram(value: unknown): string | null {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized) return null;
    if (!/^[a-z0-9._-]+$/.test(normalized)) return null;
    return normalized;
  }

  function resolveOutcomeTargetPrograms(
    job: { bridgeProgram?: string | null; usedBridges?: string[] | null },
  ): string[] {
    const out = new Set<string>();
    const primary = normalizeBridgeProgram(job.bridgeProgram);
    if (primary) out.add(primary);
    if (Array.isArray(job.usedBridges)) {
      for (const candidate of job.usedBridges) {
        const normalized = normalizeBridgeProgram(candidate);
        if (normalized) out.add(normalized);
      }
    }
    return [...out];
  }

  function isTerminalJobStatus(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  /**
   * Get all descendant jobs of a root job using targeted BFS queries.
   * Uses getChildJobs() with the parent_job_id index instead of loading
   * the entire jobs table — O(d) queries where d = depth, not O(n) memory.
   */
  function getDescendantJobs(rootJobId: string): ReturnType<JobsRepo["list"]>["jobs"] {
    const visited = new Set<string>();
    const descendants: ReturnType<JobsRepo["list"]>["jobs"] = [];
    const queue = [rootJobId];

    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      const children = jobsRepo.getChildJobs(parentId);
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return descendants;
  }

  function inheritedOutcomeNotes(rootJob: { id: string; name?: string }, notes: string): string {
    const rootLabel = rootJob.name?.trim() || `#${rootJob.id.slice(0, 8)}`;
    const trimmed = notes.trim();
    return trimmed
      ? `Inherited from root job ${rootLabel}: ${trimmed}`
      : `Inherited from root job ${rootLabel}.`;
  }

  function recordOutcomeLearning(
    job: ReturnType<JobsRepo["getById"]> extends infer T ? Exclude<T, null> : never,
    rootJob: ReturnType<JobsRepo["getById"]> extends infer T ? Exclude<T, null> : never,
    normalizedRating: NormalizedOutcomeRating,
    notes: string,
    principal: AuthPrincipal,
  ) {
    const targetPrograms = resolveOutcomeTargetPrograms(job);
    if (!coordinatorPlaybooksDir || targetPrograms.length === 0) return;

    const configuredReferencePaths = parseCoordinatorReferencePaths(
      settingsRepo.get("coordinator_reference_paths"),
    );
    const configuredPlaybookSourcePaths = parseCoordinatorReferencePaths(
      settingsRepo.get("coordinator_playbook_sources"),
    );
    const configuredPlaybookSourcePrograms = parseCoordinatorSourcePrograms(
      settingsRepo.get("coordinator_playbook_source_programs"),
    );
    const trainingRepositoryPolicy = parseTrainingRepositoryPolicy(
      settingsRepo.get(TRAINING_REPOSITORY_POLICY_SETTINGS_KEY),
    );
    const trainingRepositoryOverrides = parseTrainingRepositoryOverrides(
      settingsRepo.get(TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY),
    );
    const signal = ratingToSignal(normalizedRating);
    const qualityWeight = ratingToQualityWeight(normalizedRating);
    const notesTrimmed = notes.trim();
    const defaultOutcome = signal === "positive"
      ? "User marked this result as positive."
      : signal === "average"
        ? "User marked this result as average/partial."
        : "User marked this result as negative.";
    const submittedByUserId = typeof job.submittedBy === "string" && job.submittedBy.trim()
      ? job.submittedBy
      : undefined;
    const submittedByUsername = submittedByUserId
      ? usersRepo.getById(submittedByUserId)?.username
      : undefined;
    const tokenUsage = usageRepo.getByJobId(job.id);
    const outcomeMarkedByUserId = principal.kind === "user" ? principal.user.id : undefined;
    const outcomeMarkedByUsername = principal.kind === "user"
      ? principal.user.username
      : `api-key:${principal.apiKey.name}`;
    const derivedFromRoot = job.id !== rootJob.id;
    const outcomeText = derivedFromRoot
      ? inheritedOutcomeNotes(rootJob, notesTrimmed || defaultOutcome)
      : (notesTrimmed || defaultOutcome);

    for (const program of targetPrograms) {
      const scopedPlaybookSourcePaths = filterCoordinatorSourcePathsByProgram(
        [...defaultCoordinatorPlaybookSourcePaths, ...configuredPlaybookSourcePaths],
        configuredPlaybookSourcePrograms,
        program,
      );
      const contextResult = loadCoordinatorPlaybookContextDetailed({
        dir: coordinatorPlaybooksDir,
        program,
        prompt: job.prompt,
        projectRoot: job.editorContext?.projectRoot,
        referencePaths: configuredReferencePaths,
        playbookSourcePaths: scopedPlaybookSourcePaths,
        clientSourcePaths: resolveCoordinatorClientSourcePaths(job),
        trainingRepositoryPolicy,
        trainingRepositoryOverrides,
      });
      if (contextResult.matches.length > 0) {
        recordCoordinatorContextOutcome({
          dir: coordinatorPlaybooksDir,
          program,
          matches: contextResult.matches,
          signal,
          qualityWeight,
        });
      }
      recordCoordinatorExecutionOutcome({
        dir: coordinatorPlaybooksDir,
        program,
        prompt: job.prompt,
        signal,
        qualityWeight,
        matches: contextResult.matches,
        outcome: outcomeText,
        metadata: {
          jobId: job.id,
          jobName: job.name,
          bridgeProgram: program,
          usedBridges: targetPrograms,
          coordinationMode: job.coordinationMode,
          submittedByUserId,
          submittedByUsername,
          outcomeMarkedByUserId,
          outcomeMarkedByUsername,
          agentConfigId: job.agentConfigId,
          actualAgentConfigId: (job as any).actualAgentConfigId,
          actualModel: (job as any).actualModel,
          rootJobId: rootJob.id,
          rootJobName: rootJob.name,
          inheritedRootOutcome: derivedFromRoot,
          parentJobId: job.parentJobId,
        },
        jobSnapshot: {
          id: job.id,
          name: job.name,
          status: job.status,
          priority: job.priority,
          prompt: job.prompt,
          coordinationMode: job.coordinationMode,
          workspaceMode: job.workspaceMode,
          bridgeId: job.bridgeId,
          bridgeProgram: job.bridgeProgram,
          usedBridges: job.usedBridges,
          workerName: job.workerName,
          targetWorkerName: job.targetWorkerName,
          projectId: job.projectId,
          runtimeOptions: job.runtimeOptions,
          editorContext: job.editorContext,
          contextItems: job.contextItems,
          result: job.result,
          commands: job.commands,
          logs: job.logs,
          error: job.error,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          tokenUsage,
          parentJobId: job.parentJobId,
        },
      });
    }
  }

  router.get("/", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!canAccessJobs(principal)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const status = c.req.query("status");
    const statusFilter = status ? status.split(",") : undefined;
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
    const { jobs, total } = jobsRepo.list(statusFilter, limit, offset);
    return c.json({ jobs: enrichJobs(jobs), total });
  });

  // List soft-deleted (trashed) jobs
  router.get("/trash", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    if (!canAccessJobs(principal)) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
    const { jobs, total } = jobsRepo.listTrashed(limit, offset);
    return c.json({ jobs: enrichJobs(jobs), total });
  });

  // List archived jobs
  router.get("/archived", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    if (!canAccessJobs(principal)) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
    const { jobs, total } = jobsRepo.listArchived(limit, offset);
    return c.json({ jobs: enrichJobs(jobs), total });
  });

  router.get("/:id", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!canAccessJobs(principal)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const job = jobsRepo.getById(c.req.param("id"));
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json(enrichJob(job));
  });

  router.get("/:id/interventions", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!canAccessJobs(principal)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    const callerJobId = String(c.req.header("x-job-id") ?? "").trim();
    if (!canListJobInterventions(principal, job, callerJobId)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    maybeDeliverLiveGuidanceOnFetch(c, principal, job);
    const refreshedJob = jobsRepo.getById(jobId) ?? job;

    return c.json({
      jobId,
      interventions: jobInterventionsRepo?.listByJob(jobId) ?? [],
      support: getJobInterventionSupport(refreshedJob, agentsRepo),
    });
  });

  router.post("/:id/interventions", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canInterveneJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = JobInterventionCreate.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", { details: parsed.error.flatten() });
    }

    const support = getJobInterventionSupport(job, agentsRepo);
    const accepts =
      (job.status === "queued" || job.status === "paused") ? support.acceptsQueuedNotes : support.acceptsLiveNotes;
    if (!accepts) {
      return errorResponse(
        c,
        400,
        support.liveReason ?? "This job cannot accept guidance in its current state.",
        "INVALID_INPUT",
      );
    }

    const actor = principalToAuditActor(principal);
    if (!jobInterventionsRepo) {
      return errorResponse(c, 503, "Job interventions are not available on this server.", "UNAVAILABLE");
    }
    const intervention = jobInterventionsRepo.create(jobId, parsed.data, {
      userId: actor.userId,
      username: actor.username,
    });
    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "job_intervention_created",
      resource: "job",
      resourceId: jobId,
      details: JSON.stringify({
        interventionId: intervention.id,
        source: intervention.source,
        status: intervention.status,
      }),
      ipAddress: getClientIp(c),
    });
    broadcastIntervention(jobId, intervention.id);

    // Attempt immediate delivery via stdin for running claude-code/codex jobs
    if (processTracker && job.status === "running") {
      const result = tryDeliverGuidanceViaStdin(
        jobId,
        intervention.id,
        parsed.data.text,
        processTracker,
        jobInterventionsRepo,
        agentsRepo,
        job,
      );
      if (result.delivered) {
        // Re-broadcast with updated "delivered" status
        broadcastIntervention(jobId, intervention.id);
      }
    }

    // Return the latest state (may be "delivered" if stdin succeeded)
    const latestIntervention = jobInterventionsRepo.getById(intervention.id) ?? intervention;
    return c.json({
      intervention: latestIntervention,
      support,
    }, 201);
  });

  // Clear all pending interventions for a job
  router.delete("/:id/interventions/pending", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) {
      return errorResponse(c, 404, "Job not found", "NOT_FOUND");
    }
    if (!jobInterventionsRepo) {
      return errorResponse(c, 503, "Job interventions are not available on this server.", "UNAVAILABLE");
    }

    const body = await c.req.json().catch(() => ({}));
    const reason = (body as { reason?: string })?.reason ?? "Cleared by operator";
    const rejected = jobInterventionsRepo.rejectPendingForJob(jobId, reason);

    const actor = principalToAuditActor(principal);
    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "job_interventions_cleared",
      resource: "job",
      resourceId: jobId,
      details: JSON.stringify({ rejectedCount: rejected }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, rejectedCount: rejected });
  });

  router.post("/", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!canCreateJobs(principal)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    // Rate limit job submissions per auth token
    const authToken = c.req.header("authorization")?.slice(7) ?? c.req.query("key") ?? "unknown";
    const rateLimitKey = `job:${authToken.slice(0, 16)}`;
    const rate = getNetworkControls(settingsRepo).rateLimits.jobSubmit;
    if (!checkJobRateLimit(rateLimitKey, rate)) {
      logger.warn("jobs", `Rate limit exceeded for job submission (key: ${rateLimitKey})`);
      return errorResponse(
        c,
        429,
        `Too many job submissions. Max ${rate.max} per ${Math.max(1, Math.round(rate.windowMs / 1000))}s.`,
        "RATE_LIMITED",
      );
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = JobSubmit.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", { details: parsed.error.flatten() });
    }
    const callerJobId = String(c.req.header("x-job-id") ?? "").trim();
    const callerJob = callerJobId ? jobsRepo.getById(callerJobId) : null;

    // Check policy enforcement
    const user = principal.kind === "user" ? principal.user : null;
    const requestedCoordinationMode = parsed.data.coordinationMode ?? "server";
    const clientIp = getClientIp(c);
    const targetWorkerName = parsed.data.targetWorkerName;
    if (targetWorkerName) {
      const workerDecision = evaluateWorkerAccess(
        settingsRepo,
        targetWorkerName,
        clientIp,
      );
      if (!workerDecision.allowed) {
        return errorResponse(c, 403, workerDecision.reason, "FORBIDDEN");
      }
    }
    const runtimeOptions = applyPromptBridgeExecutionMode(
      parsed.data.prompt,
      normalizeJobRuntimeOptions(parsed.data.runtimeOptions),
    );
    const requestedAgentConfigId = parsed.data.agentConfigId;
    let config = null as ReturnType<typeof agentsRepo.getById>;
    let routed:
      | {
          requestedAgentConfigId: "auto";
          actualAgentConfigId: string;
          actualModel?: string;
          routingReason: "local" | "cloud";
        }
      | undefined;
    if (requestedAgentConfigId === "auto") {
      try {
        const decision = resolveAutoAgentByPriority(
          parsed.data.prompt,
          runtimeOptions,
          agentsRepo,
          settingsRepo,
        );
        config = decision.config;
        routed = {
          requestedAgentConfigId: "auto",
          actualAgentConfigId: decision.actualAgentConfigId,
          actualModel: decision.actualModel,
          routingReason: decision.routingReason,
        };
      } catch (err: any) {
        return errorResponse(c, 400, err?.message ?? "No agent config available for AUTO routing", "CONFIG_NOT_FOUND");
      }
    } else {
      config = agentsRepo.getById(requestedAgentConfigId);
    }
    if (!config) {
      return errorResponse(c, 400, "Agent config not found", "CONFIG_NOT_FOUND");
    }

    if (requestedCoordinationMode === "client") {
      const allowClientCoordination = settingsRepo.getBool("allow_client_coordination");
      if (!allowClientCoordination) {
        return errorResponse(c, 403, "Client-side coordination is disabled by admin policy", "FORBIDDEN");
      }
      if (targetWorkerName) {
        const workerRule = getWorkerRule(settingsRepo, targetWorkerName);
        if (!workerRule.clientCoordinationAllowed) {
          return errorResponse(
            c,
            403,
            `Client-side coordination is disabled for worker "${workerRule.workerName}"`,
            "FORBIDDEN",
          );
        }
      }
      if (!user) {
        return errorResponse(c, 403, "Client-side coordination requires a user session", "FORBIDDEN");
      }
      if (!user.clientCoordinationEnabled) {
        return errorResponse(c, 403, "Enable client-side coordination in your user settings first", "FORBIDDEN");
      }
    }

    const policies = policiesRepo.getEffectiveForContext(user?.id ?? null, parsed.data.projectId ?? null);
    const effectiveModel = resolveModelForRun(config.model, runtimeOptions);

    if (
      config.engine === "local-oss"
      && !isModelAllowedByStoredAllowlist(settingsRepo, "ollama", effectiveModel)
    ) {
      return errorResponse(
        c,
        403,
        `Local model "${effectiveModel}" is not in the allowed model list`,
        "FORBIDDEN",
      );
    }

    const policyResult = validateJobSubmission(
      parsed.data.prompt,
      config.engine,
      effectiveModel,
      policies,
    );

    if (!policyResult.allowed) {
      return errorResponse(c, 403, "Job blocked by policy", "POLICY_BLOCKED", {
        violations: policyResult.violations.map((v) => v.message),
      });
    }

    // Infer bridge program only from explicit request metadata.
    // Priority: explicit bridgeProgram field (for offline/headless UI selections)
    // → target_bridges array (canonical explicit selection) → legacy bridge_type field.
    // Do not infer from ambient live bridges; auto submissions should stay unbound
    // until the agent explicitly uses a bridge during execution.
    const metadata = parsed.data.editorContext?.metadata as Record<string, any> | undefined;
    let inferredBridgeProgram: string | undefined;
    if (typeof parsed.data.bridgeProgram === "string" && parsed.data.bridgeProgram.trim()) {
      inferredBridgeProgram = parsed.data.bridgeProgram.trim();
    } else if (metadata?.target_bridges && Array.isArray(metadata.target_bridges) && metadata.target_bridges.length === 1) {
      inferredBridgeProgram = metadata.target_bridges[0];
    } else if (typeof metadata?.bridge_type === "string") {
      inferredBridgeProgram = metadata.bridge_type;
    }

    let job;
    try {
      const createdInput = {
        ...parsed.data,
        agentConfigId: config.id,
        runtimeOptions,
      };
      job = jobsRepo.create(
        createdInput,
        undefined,
        inferredBridgeProgram,
        body.workerName,
        parsed.data.targetWorkerName,
        user?.id,
        callerJob?.id,
        {
          requestedAgentConfigId,
          actualAgentConfigId: config.id,
          actualModel: effectiveModel,
          routingReason: config.engine === "local-oss" ? "local" : "cloud",
          ...(routed ?? {}),
        },
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        // Identify which FK is bad
        const hints: string[] = [];
        if (parsed.data.projectId) hints.push(`projectId "${parsed.data.projectId}" may not exist`);
        hints.push(`agentConfigId "${config.id}" may have been deleted`);
        const detail = hints.join("; ");
        logger.warn("jobs", `FK constraint failed creating job: ${detail}`);
        return errorResponse(c, 400, `Invalid reference: ${detail}`, "INVALID_INPUT");
      }
      throw err;
    }

    // Set default retry policy for regular jobs (not training jobs which have their own retry)
    const isTraining = !!job.editorContext?.metadata?.coordinator_training_job;
    if (!isTraining && DEFAULT_MAX_RETRIES > 0) {
      jobsRepo.setMaxRetries(job.id, DEFAULT_MAX_RETRIES);
    }

    // Set TTL for worker-targeted jobs — prevents jobs from sitting in queue forever
    if (parsed.data.targetWorkerName) {
      const expiresAt = new Date(Date.now() + DEFAULT_TARGET_WORKER_TTL_MS).toISOString();
      jobsRepo.setExpiry(job.id, expiresAt);
    }

    // Create dependencies
    if (parsed.data.dependsOn && parsed.data.dependsOn.length > 0) {
      for (const depId of parsed.data.dependsOn) {
        depsRepo.add(job.id, depId);
      }
    }

    if (requestedCoordinationMode === "client" && user) {
      auditRepo.log({
        userId: user.id,
        username: user.username,
        action: "client_coordination_job_submitted",
        resource: "job",
        resourceId: job.id,
        details: JSON.stringify({
          coordinationMode: requestedCoordinationMode,
          capability: body.clientCoordinationCapability ?? null,
          targetWorkerName: parsed.data.targetWorkerName ?? null,
        }),
        ipAddress: getClientIp(c),
      });
    }

    broadcastJob(job.id);
    return c.json(enrichJob(job), 201);
  });

  router.post("/:id/cancel", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (job.status === "running") {
      processTracker?.kill(id);
    }

    const cancelled = jobsRepo.cancel(id);
    if (!cancelled) return errorResponse(c, 400, "Cannot cancel", "INVALID_INPUT");
    broadcastJob(id);
    return c.json({ ok: true });
  });

  router.post("/:id/reprioritize", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = JobPriority.safeParse(body.priority);
    if (!parsed.success) {
      return errorResponse(c, 400, "Invalid priority", "INVALID_INPUT");
    }
    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const updated = jobsRepo.reprioritize(id, parsed.data);
    if (!updated) return errorResponse(c, 400, "Cannot reprioritize", "INVALID_INPUT");
    broadcastJob(id);
    return c.json({ ok: true });
  });

  router.post("/:id/outcome", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      return errorResponse(c, 400, "Outcome can only be marked on finished jobs", "INVALID_INPUT");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const normalizedRating = normalizeOutcomeRating(body?.rating);
    if (!normalizedRating) {
      return errorResponse(
        c,
        400,
        "rating must be one of: good, average, poor (legacy positive/negative also accepted)",
        "INVALID_INPUT",
      );
    }
    const storedRating = ratingToStoredOutcome(normalizedRating);
    const notes = body?.notes == null ? "" : String(body.notes);
    if (notes.length > 4000) {
      return errorResponse(c, 400, "notes must be <= 4000 characters", "INVALID_INPUT");
    }

    const markedBy = principal.kind === "user" ? principal.user.id : null;
    const updated = jobsRepo.markOutcome(id, storedRating, notes, markedBy);
    if (!updated) return errorResponse(c, 500, "Failed to update job outcome", "INTERNAL_ERROR");

    const propagatedJobIds: string[] = [];
    const skippedActiveJobIds: string[] = [];
    const descendantJobs = getDescendantJobs(job.id);
    for (const descendant of descendantJobs) {
      if (!isTerminalJobStatus(descendant.status)) {
        skippedActiveJobIds.push(descendant.id);
        continue;
      }
      const propagated = jobsRepo.markOutcome(
        descendant.id,
        storedRating,
        inheritedOutcomeNotes(job, notes),
        markedBy,
      );
      if (propagated) propagatedJobIds.push(descendant.id);
    }

    // Update skill effectiveness for any skills that the agent didn't explicitly rate.
    // Maps user outcome ratings (good/average/poor) to skill effectiveness outcomes.
    if (skillEffectivenessRepo) {
      const skillOutcome = normalizedRating === "good" ? "positive" : normalizedRating === "poor" ? "negative" : "average";
      skillEffectivenessRepo.recordOutcome(job.id, skillOutcome);
      for (const descendant of descendantJobs) {
        if (!isTerminalJobStatus(descendant.status)) continue;
        skillEffectivenessRepo.recordOutcome(descendant.id, skillOutcome);
      }
    }

    // Feed manual feedback into coordinator learning so future context ranking can
    // prefer successful patterns and down-rank failed ones.
    if (coordinatorPlaybooksDir) {
      try {
        recordOutcomeLearning(job, job, normalizedRating, notes, principal);
        for (const descendant of descendantJobs) {
          if (!isTerminalJobStatus(descendant.status)) continue;
          recordOutcomeLearning(descendant, job, normalizedRating, notes, principal);
        }
      } catch (err: any) {
        logger.warn("jobs", `Failed to record coordinator outcome feedback for job ${id}: ${String(err?.message ?? err)}`);
      }
    }

    const actor = principalToAuditActor(principal);
    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "job_outcome_marked",
      resource: "job",
      resourceId: id,
      details: JSON.stringify({
        rating: normalizedRating,
        storedRating,
        notesLength: notes.trim().length,
        propagatedJobCount: propagatedJobIds.length,
        skippedActiveJobCount: skippedActiveJobIds.length,
      }),
      ipAddress: getClientIp(c),
    });

    broadcastJob(id);
    for (const propagatedJobId of propagatedJobIds) {
      broadcastJob(propagatedJobId);
    }
    const refreshed = jobsRepo.getById(id);
    if (!refreshed) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json({
      ...enrichJob(refreshed),
      propagatedJobIds,
      skippedActiveJobIds,
    });
  });

  // ── Re-guide a finished job ────────────────────────────────────────────
  // Creates a new child job that picks up from where the parent left off,
  // with the user's guidance as additional context. Works on completed,
  // failed, or cancelled jobs.
  router.post("/:id/guide", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const id = c.req.param("id");
    const parentJob = jobsRepo.getById(id);
    if (!parentJob) return errorResponse(c, 404, "Job not found", "NOT_FOUND");
    if (!canMutateJob(principal, parentJob)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (!["completed", "failed", "cancelled"].includes(parentJob.status)) {
      return errorResponse(c, 400, "Can only guide finished jobs (completed, failed, or cancelled)", "INVALID_INPUT");
    }

    let body: any;
    try { body = await c.req.json(); } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const guidance = String(body?.text ?? body?.guidance ?? "").trim();
    if (!guidance) {
      return errorResponse(c, 400, "guidance text is required", "INVALID_INPUT");
    }
    if (guidance.length > 8000) {
      return errorResponse(c, 400, "guidance must be <= 8000 characters", "INVALID_INPUT");
    }

    // Build the child job prompt: original context + parent outcome + guidance
    const parentStatus = parentJob.status === "completed" ? "completed successfully" : `${parentJob.status}`;
    const parentError = parentJob.error ? `\nError: ${parentJob.error}` : "";
    const parentLogsTail = parentJob.logs ? parentJob.logs.slice(-3000) : "";

    const childPrompt = [
      `## Re-guidance of previous job`,
      ``,
      `The previous job "${parentJob.name || parentJob.id}" ${parentStatus}.${parentError}`,
      ``,
      `### Original task`,
      parentJob.prompt,
      ``,
      parentLogsTail ? `### Previous output (tail)\n${parentLogsTail}\n` : "",
      `### Guidance from user`,
      guidance,
      ``,
      `Follow the user's guidance above. Pick up from where the previous job left off.`,
      `Fix any issues mentioned and complete the task as directed.`,
    ].filter(Boolean).join("\n");

    // Create child job with same config as parent
    const childInput = {
      name: `[Guided] ${parentJob.name || parentJob.prompt.slice(0, 60)}`,
      prompt: childPrompt,
      agentConfigId: parentJob.agentConfigId,
      priority: parentJob.priority,
      coordinationMode: parentJob.coordinationMode,
      files: parentJob.files ?? [],
      contextItems: parentJob.contextItems ?? [],
      editorContext: parentJob.editorContext,
      runtimeOptions: parentJob.runtimeOptions,
      projectId: parentJob.projectId,
    } as any;

    const submittedBy = principal.kind === "user" ? principal.user.id : undefined;
    const childJob = jobsRepo.create(
      childInput,
      parentJob.bridgeId,
      parentJob.bridgeProgram,
      parentJob.workerName,
      parentJob.targetWorkerName,
      submittedBy,
      parentJob.id, // parentJobId — links child to parent
    );

    // Set retry policy
    if (DEFAULT_MAX_RETRIES > 0) {
      jobsRepo.setMaxRetries(childJob.id, DEFAULT_MAX_RETRIES);
    }

    const actor = principalToAuditActor(principal);
    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "job_guided",
      resource: "job",
      resourceId: id,
      details: JSON.stringify({
        childJobId: childJob.id,
        guidanceLength: guidance.length,
        parentStatus: parentJob.status,
      }),
      ipAddress: getClientIp(c),
    });

    broadcastJob(childJob.id);
    logger.info("jobs", `Re-guided job ${id} → child job ${childJob.id} (guidance: ${guidance.length} chars)`);

    return c.json({
      ok: true,
      parentJobId: id,
      childJob: enrichJob(childJob),
    }, 201);
  });

  // Archive a job (soft-archive)
  router.post("/:id/archive", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const archived = jobsRepo.archive(id);
    if (!archived) return errorResponse(c, 400, "Cannot archive job", "INVALID_INPUT");

    broadcastJob(id);
    return c.json({ ok: true });
  });

  // Restore a trashed or archived job
  router.post("/:id/restore", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const restored = jobsRepo.restore(id);
    if (!restored) return errorResponse(c, 400, "Cannot restore job", "INVALID_INPUT");

    broadcastJob(id);
    return c.json({ ok: true });
  });

  // Permanently delete a job (admin only)
  router.delete("/:id/permanent", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    if (principal.kind === "user" && principal.user.role !== "admin") {
      return errorResponse(c, 403, "Admin only", "FORBIDDEN");
    }
    if (principal.kind === "apiKey" && principal.apiKey.role !== "admin") {
      return errorResponse(c, 403, "Admin only", "FORBIDDEN");
    }

    const id = c.req.param("id");
    const deleted = jobsRepo.permanentDelete(id);
    if (!deleted) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    const actor = principalToAuditActor(principal);
    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "permanent_delete_job",
      resource: "job",
      resourceId: id,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  router.delete("/:id", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const autoCancelled = cancelForDelete(id, job.status);
    if (["queued", "paused", "running"].includes(job.status) && !autoCancelled) {
      return errorResponse(c, 400, "Cannot cancel job before delete", "INVALID_INPUT");
    }

    const deleted = jobsRepo.delete(id);
    if (!deleted) return errorResponse(c, 400, "Not found or not deletable", "INVALID_INPUT");

    const actor = principalToAuditActor(principal);

    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "delete_job",
      resource: "job",
      resourceId: id,
      details: autoCancelled ? JSON.stringify({ autoCancelled: true, previousStatus: job.status }) : undefined,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  router.post("/bulk-delete", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const jobIds = body.jobIds;
    if (!Array.isArray(jobIds)) {
      return errorResponse(c, 400, "jobIds must be an array", "INVALID_INPUT");
    }

    const unauthorized: string[] = [];
    for (const jobId of jobIds) {
      if (typeof jobId !== "string") continue;
      const job = jobsRepo.getById(jobId);
      if (!job) continue;
      if (!canMutateJob(principal, job)) {
        unauthorized.push(jobId);
      }
    }
    if (unauthorized.length > 0) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN", {
        unauthorizedJobIds: unauthorized,
      });
    }

    const autoCancelledJobIds: string[] = [];
    for (const jobId of jobIds) {
      if (typeof jobId !== "string") continue;
      const job = jobsRepo.getById(jobId);
      if (!job) continue;
      if (!["queued", "paused", "running"].includes(job.status)) continue;
      const cancelled = cancelForDelete(jobId, job.status);
      if (!cancelled) {
        return errorResponse(c, 400, `Cannot cancel job before delete: ${jobId}`, "INVALID_INPUT");
      }
      autoCancelledJobIds.push(jobId);
    }

    const deleted = jobsRepo.deleteBulk(jobIds);
    const actor = principalToAuditActor(principal);

    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "bulk_delete_jobs",
      resource: "job",
      details: JSON.stringify({ count: deleted, jobIds, autoCancelledJobIds }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, deleted });
  });

  // Resume a paused job (move to queued so worker picks it up)
  router.post("/:id/pause", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (job.status !== "running") {
      return errorResponse(c, 400, "Can only pause running jobs", "INVALID_INPUT");
    }
    if (!job.sessionId) {
      return errorResponse(c, 400, "Job has no session ID yet (agent may still be initializing)", "INVALID_INPUT");
    }
    // Move to paused first (so the exit handler sees paused status), then kill
    const paused = jobsRepo.pause(id);
    if (!paused) return errorResponse(c, 400, "Failed to pause job", "INVALID_INPUT");
    processTracker?.kill(id);
    broadcastJob(id);
    return c.json({ ok: true, sessionId: job.sessionId });
  });

  router.post("/:id/resume", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const resumed = jobsRepo.resume(id);
    if (!resumed) return errorResponse(c, 400, "Cannot resume (not paused)", "INVALID_INPUT");
    broadcastJob(id);
    return c.json({ ok: true });
  });

  // Guide a completed/failed job — add feedback and re-queue for another run
  router.post("/:id/guide", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }
    if (job.status !== "completed" && job.status !== "failed") {
      return errorResponse(c, 400, `Cannot guide a ${job.status} job — only completed or failed`, "INVALID_INPUT");
    }

    let body: { text: string };
    try {
      const raw = await c.req.json();
      if (!raw?.text || typeof raw.text !== "string" || !raw.text.trim()) {
        return errorResponse(c, 400, "Guidance text is required", "INVALID_INPUT");
      }
      body = { text: raw.text.trim() };
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    // Create an intervention with the guidance (will be injected into prompt on next run)
    let intervention;
    if (jobInterventionsRepo) {
      const actor = principal.kind === "user"
        ? { userId: principal.user.id, username: principal.user.username }
        : { username: `apikey:${principal.apiKey.id.slice(0, 8)}` };
      intervention = jobInterventionsRepo.create(id, { text: body.text, source: "jobs" as const }, actor);
    }

    // Move job back to queued (preserves sessionId for Claude session resumption)
    const guided = jobsRepo.guide(id);
    if (!guided) {
      return errorResponse(c, 400, "Failed to re-queue job", "INTERNAL_ERROR");
    }
    broadcastJob(id);
    return c.json({ ok: true, job_id: id, intervention_id: intervention?.id ?? null });
  });

  // Manually dispatch a queued job (bypasses worker poll cycle)
  router.post("/:id/dispatch", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const id = c.req.param("id");
    const job = jobsRepo.getById(id);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    if (!dispatchFn) {
      return errorResponse(c, 501, "Manual dispatch not available", "INTERNAL_ERROR");
    }
    const result = dispatchFn(id);
    if (!result.ok) {
      return errorResponse(c, 400, result.error ?? "Dispatch failed", "INVALID_INPUT");
    }
    broadcastJob(id);
    return c.json({ ok: true });
  });

  // Requeue a failed or cancelled job
  router.post("/:id/requeue", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = JobRequeuePayloadSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    const job = jobsRepo.getById(c.req.param("id"));
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    if (job.status !== "failed" && job.status !== "cancelled") {
      return errorResponse(c, 400, "Can only requeue failed or cancelled jobs", "INVALID_INPUT");
    }

    // Allow overriding target worker on requeue
    const targetWorkerName = parsed.data.targetWorkerName ?? job.targetWorkerName;
    const { jobs: allJobs } = jobsRepo.list();
    const jobsById = new Map(allJobs.map((row) => [row.id, row]));
    const childrenByParent = new Map<string, string[]>();
    for (const row of allJobs) {
      if (!row.parentJobId) continue;
      const list = childrenByParent.get(row.parentJobId) ?? [];
      list.push(row.id);
      childrenByParent.set(row.parentJobId, list);
    }

    // Requeue the full descendant tree from the selected root.
    // Edges considered:
    // 1) sub-job relationship via parentJobId
    // 2) dependent relationship via dependency table (A -> B where B depends on A)
    const treeIds = new Set<string>([job.id]);
    const queue = [job.id];
    while (queue.length > 0) {
      const currentId = queue.shift() as string;
      for (const childId of childrenByParent.get(currentId) ?? []) {
        if (!treeIds.has(childId)) {
          treeIds.add(childId);
          queue.push(childId);
        }
      }
      for (const dependentId of depsRepo.getDependents(currentId)) {
        if (!treeIds.has(dependentId) && jobsById.has(dependentId)) {
          treeIds.add(dependentId);
          queue.push(dependentId);
        }
      }
    }

    const treeJobs = [...treeIds]
      .map((id) => jobsById.get(id))
      .filter((row): row is NonNullable<typeof row> => !!row);

    // Must be allowed to mutate every job in the tree.
    for (const treeJob of treeJobs) {
      if (!canMutateJob(principal, treeJob)) {
        return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
      }
    }

    // Requeue is only valid for terminal descendants.
    const nonTerminal = treeJobs.filter((row) => !["completed", "failed", "cancelled"].includes(row.status));
    if (nonTerminal.length > 0) {
      return errorResponse(
        c,
        400,
        "Cannot requeue tree with active jobs (queued/paused/running)",
        "INVALID_INPUT",
        { activeJobIds: nonTerminal.map((row) => row.id) },
      );
    }

    const submittedBy = principal.kind === "user" ? principal.user.id : undefined;
    const oldToNew = new Map<string, string>();
    const pending = new Set<string>(treeIds);

    // Create root/parents first, then descendants.
    while (pending.size > 0) {
      let progressed = false;
      for (const oldId of [...pending]) {
        const oldJob = jobsById.get(oldId);
        if (!oldJob) {
          pending.delete(oldId);
          continue;
        }
        const parentOldId = oldJob.parentJobId;
        const parentInTree = parentOldId && treeIds.has(parentOldId);
        if (parentInTree && !oldToNew.has(parentOldId)) continue;

        const mappedParentId = parentInTree ? oldToNew.get(parentOldId as string) : undefined;
        const created = jobsRepo.create(
          {
            name: oldJob.name,
            mode: "agentic" as const,
            prompt: oldJob.prompt,
            priority: oldJob.priority,
            agentConfigId: oldJob.agentConfigId,
            editorContext: oldJob.editorContext,
            files: oldJob.files,
            contextItems: oldJob.contextItems,
            coordinationMode: oldJob.coordinationMode,
            projectId: oldJob.projectId,
            runtimeOptions: oldJob.runtimeOptions,
          },
          oldJob.bridgeId,
          oldJob.bridgeProgram,
          oldJob.workerName,
          targetWorkerName ?? oldJob.targetWorkerName,
          submittedBy,
          mappedParentId,
          {
            requestedAgentConfigId: oldJob.requestedAgentConfigId,
            actualAgentConfigId: oldJob.actualAgentConfigId,
            actualModel: oldJob.actualModel,
            routingReason: oldJob.routingReason,
          },
        );

        oldToNew.set(oldId, created.id);
        pending.delete(oldId);
        progressed = true;
      }

      if (!progressed) {
        return errorResponse(c, 500, "Failed to requeue dependency tree", "INTERNAL_ERROR");
      }
    }

    // Recreate dependency edges inside the requeued tree.
    for (const oldId of treeIds) {
      const newId = oldToNew.get(oldId);
      if (!newId) continue;
      for (const depOldId of depsRepo.getDependencies(oldId)) {
        const depNewId = oldToNew.get(depOldId);
        if (depNewId) {
          depsRepo.add(newId, depNewId);
        }
      }
    }

    const newRootId = oldToNew.get(job.id);
    if (!newRootId) {
      return errorResponse(c, 500, "Failed to create requeued root job", "INTERNAL_ERROR");
    }
    const newJob = jobsRepo.getById(newRootId);
    if (!newJob) {
      return errorResponse(c, 500, "Failed to load requeued root job", "INTERNAL_ERROR");
    }

    const actor = principalToAuditActor(principal);

    auditRepo.log({
      userId: actor.userId,
      username: actor.username,
      action: "requeue_job",
      resource: "job",
      resourceId: newJob.id,
      details: JSON.stringify({
        originalJobId: job.id,
        requeuedTreeSize: oldToNew.size,
      }),
      ipAddress: getClientIp(c),
    });

    for (const createdId of oldToNew.values()) {
      broadcastJob(createdId);
    }

    return c.json(
      {
        ...enrichJob(newJob),
        requeuedTreeSize: oldToNew.size,
      },
      201,
    );
  });

  // --- Dependency management ---

  router.get("/:id/dependencies", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    if (!canAccessJobs(principal)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");

    return c.json({
      dependencies: depsRepo.getDependencies(jobId),
      dependents: depsRepo.getDependents(jobId),
      blocking: depsRepo.getBlockingDeps(jobId),
    });
  });

  router.post("/:id/dependencies", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const depId = body.dependsOnJobId;
    if (!depId || typeof depId !== "string") {
      return errorResponse(c, 400, "dependsOnJobId is required", "INVALID_INPUT");
    }

    const depJob = jobsRepo.getById(depId);
    if (!depJob) return errorResponse(c, 404, "Dependency job not found", "NOT_FOUND");

    if (depId === jobId) {
      return errorResponse(c, 400, "A job cannot depend on itself", "INVALID_INPUT");
    }

    depsRepo.add(jobId, depId);
    return c.json({ ok: true });
  });

  router.delete("/:id/dependencies/:depJobId", async (c) => {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const jobId = c.req.param("id");
    const job = jobsRepo.getById(jobId);
    if (!job) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    if (!canMutateJob(principal, job)) {
      return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    }

    const depJobId = c.req.param("depJobId");
    depsRepo.removeByPair(jobId, depJobId);
    return c.json({ ok: true });
  });

  return router;
}
