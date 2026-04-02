import { Database } from "bun:sqlite";
import type {
  Job,
  JobSubmit,
  JobStatus,
  JobPriority,
  JobOutcomeRating,
  CoordinationMode,
  FileChange,
  CommandResult,
  WorkspaceMode,
} from "@arkestrator/protocol";
import { newId } from "../utils/id.js";
import { normalizeQuotes } from "../utils/worker-identity.js";
import { normalizeJobRuntimeOptions } from "../agents/runtime-options.js";

interface JobRow {
  id: string;
  status: string;
  priority: string;
  coordination_mode: string | null;
  name: string | null;
  prompt: string;
  editor_context: string | null;
  files: string;
  runtime_options: string | null;
  agent_config_id: string;
  requested_agent_config_id: string | null;
  actual_agent_config_id: string | null;
  actual_model: string | null;
  routing_reason: string | null;
  bridge_id: string | null;
  bridge_program: string | null;
  worker_name: string | null;
  target_worker_name: string | null;
  project_id: string | null;
  context_items: string;
  result: string | null;
  commands: string | null;
  workspace_mode: string | null;
  logs: string | null;
  error: string | null;
  outcome_rating: string | null;
  outcome_notes: string | null;
  outcome_marked_at: string | null;
  outcome_marked_by: string | null;
  submitted_by: string | null;
  parent_job_id: string | null;
  used_bridges: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  archived_at: string | null;
  deleted_at: string | null;
  retry_count: number;
  max_retries: number;
  retry_after: string | null;
  expires_at: string | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function parseEditorContext(raw: string | null): Job["editorContext"] {
  if (!raw) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const fallbackFromMetadata = Array.isArray(parsed?.metadata?.coordinator_training_source_paths)
    ? String(parsed.metadata.coordinator_training_source_paths[0] ?? "").trim()
    : "";
  const projectRoot = typeof parsed.projectRoot === "string"
    ? parsed.projectRoot
    : fallbackFromMetadata;

  return {
    projectRoot,
    activeFile: typeof parsed.activeFile === "string" ? parsed.activeFile : undefined,
    selection: typeof parsed.selection === "string" ? parsed.selection : undefined,
    cursorLine: typeof parsed.cursorLine === "number" ? parsed.cursorLine : undefined,
    metadata: parsed.metadata && typeof parsed.metadata === "object"
      ? parsed.metadata
      : undefined,
  };
}

function parseRuntimeOptions(raw: string | null): Job["runtimeOptions"] {
  if (!raw) return undefined;
  try {
    return normalizeJobRuntimeOptions(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    status: row.status as JobStatus,
    priority: row.priority as JobPriority,
    coordinationMode: (row.coordination_mode as CoordinationMode) ?? "server",
    name: row.name ?? undefined,
    prompt: row.prompt,
    editorContext: parseEditorContext(row.editor_context),
    files: JSON.parse(row.files),
    runtimeOptions: parseRuntimeOptions(row.runtime_options),
    contextItems: row.context_items ? JSON.parse(row.context_items) : [],
    agentConfigId: row.agent_config_id,
    requestedAgentConfigId: (row.requested_agent_config_id as Job["requestedAgentConfigId"]) ?? undefined,
    actualAgentConfigId: row.actual_agent_config_id ?? undefined,
    actualModel: row.actual_model ?? undefined,
    routingReason: (row.routing_reason as Job["routingReason"]) ?? undefined,
    bridgeId: row.bridge_id ?? undefined,
    bridgeProgram: row.bridge_program ?? undefined,
    workerName: row.worker_name ?? undefined,
    targetWorkerName: row.target_worker_name ?? undefined,
    projectId: row.project_id ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    commands: row.commands ? JSON.parse(row.commands) : undefined,
    workspaceMode: (row.workspace_mode as WorkspaceMode) ?? undefined,
    logs: row.logs ?? undefined,
    error: row.error ?? undefined,
    outcomeRating: (row.outcome_rating as Job["outcomeRating"]) ?? undefined,
    outcomeNotes: row.outcome_notes ?? undefined,
    outcomeMarkedAt: row.outcome_marked_at ?? undefined,
    outcomeMarkedBy: row.outcome_marked_by ?? undefined,
    submittedBy: row.submitted_by ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    usedBridges: row.used_bridges ? JSON.parse(row.used_bridges) : [],
    tokenUsage: row.input_tokens != null || row.output_tokens != null
      ? {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          durationMs: row.duration_ms ?? 0,
          costUsd: row.cost_usd ?? undefined,
        }
      : undefined,
    archivedAt: row.archived_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    retryCount: row.retry_count ?? 0,
    maxRetries: row.max_retries ?? 0,
    retryAfter: row.retry_after ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export class JobsRepo {
  private insertStmt;
  private getByIdStmt;
  private listByStatusStmt;
  private listAllStmt;
  private claimJobStmt;
  private updateCompletedStmt;
  private updateCompletedWithCommandsStmt;
  private updateFailedStmt;
  private cancelStmt;
  private reprioritizeStmt;
  private appendLogStmt;
  private pickNextStmt;
  private pickNextForWorkerStmt;
  private setWorkspaceModeStmt;
  private deleteStmt;
  private deleteBulkStmt;
  private resumeStmt;
  private dashboardStatsStmt;
  private countAllStmt;
  private countByStatusStmt;
  private listPaginatedStmt;
  private listByStatusPaginatedStmt;
  private hasPendingChildrenStmt;
  private addUsedBridgeStmt;
  private markOutcomeStmt;
  private listBySubmittedByStmt;
  private countBySubmittedByStmt;
  private countBySubmittedByStatusStmt;
  private listByStatusIncludingTrashedStmt;
  private updateTokensStmt;
  private archiveStmt;
  private restoreStmt;
  private permanentDeleteStmt;
  private listTrashedStmt;
  private countTrashedStmt;
  private listArchivedStmt;
  private countArchivedStmt;
  private purgeOldTrashStmt;
  private countCompletedSinceStmt;
  private countCompletedSinceForProgramStmt;
  private getChildJobsStmt;
  private pauseStmt;
  private setSessionIdStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO jobs (id, status, priority, coordination_mode, name, prompt, editor_context, files, runtime_options, context_items, agent_config_id, requested_agent_config_id, actual_agent_config_id, actual_model, routing_reason, bridge_id, bridge_program, worker_name, target_worker_name, project_id, submitted_by, parent_job_id, used_bridges, outcome_rating, outcome_notes, outcome_marked_at, outcome_marked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL`);
    this.listByStatusStmt = db.prepare(
      `SELECT * FROM jobs WHERE status IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY created_at DESC`,
    );
    this.listAllStmt = db.prepare(
      `SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    this.claimJobStmt = db.prepare(
      `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
    );
    this.updateCompletedStmt = db.prepare(
      `UPDATE jobs SET status = 'completed', result = ?, logs = ?, completed_at = ? WHERE id = ?`,
    );
    this.updateCompletedWithCommandsStmt = db.prepare(
      `UPDATE jobs SET status = 'completed', commands = ?, logs = CASE WHEN ? = '' THEN logs ELSE ? END, completed_at = ? WHERE id = ?`,
    );
    this.updateFailedStmt = db.prepare(
      `UPDATE jobs SET status = 'failed', error = ?, logs = CASE WHEN ? = '' THEN logs ELSE ? END, completed_at = ? WHERE id = ?`,
    );
    this.cancelStmt = db.prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'running')`,
    );
    this.reprioritizeStmt = db.prepare(
      `UPDATE jobs SET priority = ? WHERE id = ? AND status IN ('queued', 'paused')`,
    );
    this.appendLogStmt = db.prepare(
      `UPDATE jobs SET logs = COALESCE(logs, '') || ? WHERE id = ?`,
    );
    // Use NOT EXISTS instead of NOT IN for better SQLite query planner performance
    // at scale — NOT IN rescans the subquery for each candidate row.
    this.pickNextStmt = db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM job_dependencies d
         JOIN jobs dep ON dep.id = d.depends_on_job_id
         WHERE d.job_id = jobs.id AND dep.status NOT IN ('completed')
       )
       AND (retry_after IS NULL OR retry_after <= datetime('now'))
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY CASE priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'normal' THEN 2
         WHEN 'low' THEN 3
       END, created_at ASC
       LIMIT 1`,
    );
    this.pickNextForWorkerStmt = db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM job_dependencies d
         JOIN jobs dep ON dep.id = d.depends_on_job_id
         WHERE d.job_id = jobs.id AND dep.status NOT IN ('completed')
       )
       AND (retry_after IS NULL OR retry_after <= datetime('now'))
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND (target_worker_name IS NULL OR target_worker_name = '' OR target_worker_name = ?)
       ORDER BY
         CASE WHEN target_worker_name = ? THEN 0 ELSE 1 END,
         CASE priority
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'normal' THEN 2
           WHEN 'low' THEN 3
         END, created_at ASC
       LIMIT 1`,
    );
    this.setWorkspaceModeStmt = db.prepare(
      `UPDATE jobs SET workspace_mode = ? WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(
      `UPDATE jobs SET deleted_at = ? WHERE id = ? AND status IN ('paused', 'completed', 'failed', 'cancelled')`,
    );
    this.deleteBulkStmt = db.prepare(
      `UPDATE jobs SET deleted_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('paused', 'completed', 'failed', 'cancelled')`,
    );
    this.resumeStmt = db.prepare(
      `UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'paused'`,
    );
    this.pauseStmt = db.prepare(
      `UPDATE jobs SET status = 'paused' WHERE id = ? AND status = 'running'`,
    );
    this.setSessionIdStmt = db.prepare(
      `UPDATE jobs SET session_id = ? WHERE id = ?`,
    );
    this.dashboardStatsStmt = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'completed' AND completed_at >= ? THEN 1 ELSE 0 END) as completed_today,
        SUM(CASE WHEN status = 'failed' AND completed_at >= ? THEN 1 ELSE 0 END) as failed_today
       FROM jobs`,
    );
    this.countAllStmt = db.prepare(`SELECT COUNT(*) as total FROM jobs WHERE deleted_at IS NULL`);
    this.countByStatusStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE status IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
    );
    this.listPaginatedStmt = db.prepare(
      `SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.listByStatusPaginatedStmt = db.prepare(
      `SELECT * FROM jobs WHERE status IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.hasPendingChildrenStmt = db.prepare(
      `SELECT COUNT(*) as n FROM jobs WHERE parent_job_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    );
    // Atomically add a bridge program to the used_bridges JSON array if not already present
    this.addUsedBridgeStmt = db.prepare(
      `UPDATE jobs SET used_bridges = (
         CASE WHEN json_extract(used_bridges, '$') IS NULL THEN json_array(?)
         WHEN EXISTS (SELECT 1 FROM json_each(used_bridges) WHERE value = ?) THEN used_bridges
         ELSE json_insert(used_bridges, '$[#]', ?)
         END
       ) WHERE id = ?`,
    );
    this.markOutcomeStmt = db.prepare(
      `UPDATE jobs
       SET outcome_rating = ?, outcome_notes = ?, outcome_marked_at = ?, outcome_marked_by = ?
       WHERE id = ?`,
    );
    this.listBySubmittedByStmt = db.prepare(
      `SELECT * FROM jobs WHERE submitted_by = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.countBySubmittedByStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE submitted_by = ?`,
    );
    this.countBySubmittedByStatusStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE submitted_by = ? AND status = ?`,
    );
    this.listByStatusIncludingTrashedStmt = db.prepare(
      `SELECT * FROM jobs WHERE status IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?`,
    );
    this.updateTokensStmt = db.prepare(
      `UPDATE jobs SET input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ? WHERE id = ?`,
    );
    this.archiveStmt = db.prepare(
      `UPDATE jobs SET archived_at = ? WHERE id = ? AND deleted_at IS NULL`,
    );
    this.restoreStmt = db.prepare(
      `UPDATE jobs SET deleted_at = NULL, archived_at = NULL WHERE id = ?`,
    );
    this.permanentDeleteStmt = db.prepare(
      `DELETE FROM jobs WHERE id = ?`,
    );
    this.listTrashedStmt = db.prepare(
      `SELECT * FROM jobs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
    );
    this.countTrashedStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE deleted_at IS NOT NULL`,
    );
    this.listArchivedStmt = db.prepare(
      `SELECT * FROM jobs WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
    );
    this.countArchivedStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE archived_at IS NOT NULL AND deleted_at IS NULL`,
    );
    this.purgeOldTrashStmt = db.prepare(
      `DELETE FROM jobs WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    );
    this.countCompletedSinceStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs
       WHERE status = 'completed' AND completed_at > ?
       AND (bridge_program IS NULL OR bridge_program NOT IN ('coordinator-training', 'housekeeping'))`,
    );
    this.countCompletedSinceForProgramStmt = db.prepare(
      `SELECT COUNT(*) as total FROM jobs
       WHERE status = 'completed' AND completed_at > ?
       AND (bridge_program IS NULL OR bridge_program NOT IN ('coordinator-training', 'housekeeping'))
       AND EXISTS (SELECT 1 FROM json_each(used_bridges) WHERE value = ?)`,
    );
    // Targeted child-job lookup using parent_job_id index — avoids loading all jobs
    this.getChildJobsStmt = db.prepare(
      `SELECT * FROM jobs WHERE parent_job_id = ? AND deleted_at IS NULL`,
    );
  }

  create(
    input: JobSubmit,
    bridgeId?: string,
    bridgeProgram?: string,
    workerName?: string,
    targetWorkerName?: string,
    submittedBy?: string,
    parentJobId?: string,
    routing?: {
      requestedAgentConfigId?: Job["requestedAgentConfigId"];
      actualAgentConfigId?: string;
      actualModel?: string;
      routingReason?: Job["routingReason"];
    },
  ): Job {
    const id = newId();
    const now = new Date().toISOString();
    const initialStatus = input.startPaused ? "paused" : "queued";
    const runtimeOptions = normalizeJobRuntimeOptions(input.runtimeOptions);
    // Bridge usage is execution-derived. Do not seed usedBridges from submit-time routing hints.
    const initialBridges = "[]";
    this.insertStmt.run(
      id,
      initialStatus,
      input.priority,
      input.coordinationMode ?? "server",
      input.name ?? null,
      input.prompt,
      input.editorContext ? JSON.stringify(input.editorContext) : null,
      JSON.stringify(input.files),
      runtimeOptions ? JSON.stringify(runtimeOptions) : null,
      JSON.stringify(input.contextItems),
      input.agentConfigId,
      routing?.requestedAgentConfigId ?? null,
      routing?.actualAgentConfigId ?? null,
      routing?.actualModel ?? null,
      routing?.routingReason ?? null,
      bridgeId ?? null,
      bridgeProgram ?? null,
      workerName ?? null,
      targetWorkerName ? normalizeQuotes(targetWorkerName) : null,
      input.projectId ?? null,
      submittedBy ?? null,
      parentJobId ?? null,
      initialBridges,
      null,
      null,
      null,
      null,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): Job | null {
    const row = this.getByIdStmt.get(id) as JobRow | null;
    return row ? rowToJob(row) : null;
  }

  listBySubmittedBy(submittedBy: string, limit = 25): Job[] {
    const rows = this.listBySubmittedByStmt.all(submittedBy, limit) as JobRow[];
    return rows.map(rowToJob);
  }

  getStatusCountsBySubmittedBy(submittedBy: string): {
    total: number;
    queued: number;
    paused: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const total = (this.countBySubmittedByStmt.get(submittedBy) as { total: number }).total;
    const byStatus = (status: JobStatus) =>
      (this.countBySubmittedByStatusStmt.get(submittedBy, status) as { total: number }).total;

    return {
      total,
      queued: byStatus("queued"),
      paused: byStatus("paused"),
      running: byStatus("running"),
      completed: byStatus("completed"),
      failed: byStatus("failed"),
      cancelled: byStatus("cancelled"),
    };
  }

  list(statusFilter?: string[], limit?: number, offset?: number): { jobs: Job[]; total: number } {
    const hasFilter = statusFilter && statusFilter.length > 0;
    const hasPagination = limit !== undefined;

    let rows: JobRow[];
    let total: number;

    if (hasFilter && hasPagination) {
      const filterJson = JSON.stringify(statusFilter);
      rows = this.listByStatusPaginatedStmt.all(filterJson, limit, offset ?? 0) as JobRow[];
      total = (this.countByStatusStmt.get(filterJson) as { total: number }).total;
    } else if (hasFilter) {
      const filterJson = JSON.stringify(statusFilter);
      rows = this.listByStatusStmt.all(filterJson) as JobRow[];
      total = rows.length;
    } else if (hasPagination) {
      rows = this.listPaginatedStmt.all(limit, offset ?? 0) as JobRow[];
      total = (this.countAllStmt.get() as { total: number }).total;
    } else {
      rows = this.listAllStmt.all() as JobRow[];
      total = rows.length;
    }

    return { jobs: rows.map(rowToJob), total };
  }

  /**
   * List jobs by status, including soft-deleted (trashed) jobs.
   * Used by housekeeping/self-learning to review jobs that ran but were
   * trashed before the learning loop could analyze them.
   */
  listIncludingTrashed(statuses: string[], limit: number): Job[] {
    const filterJson = JSON.stringify(statuses);
    const rows = this.listByStatusIncludingTrashedStmt.all(filterJson, limit) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Atomically claim a queued job for execution. Returns true if claimed. */
  claim(jobId: string): boolean {
    const now = new Date().toISOString();
    const result = this.claimJobStmt.run(now, jobId);
    return result.changes > 0;
  }

  complete(jobId: string, fileChanges: FileChange[], logs: string) {
    const now = new Date().toISOString();
    this.updateCompletedStmt.run(
      JSON.stringify(fileChanges),
      logs,
      now,
      jobId,
    );
  }

  completeWithCommands(
    jobId: string,
    commands: CommandResult[],
    logs: string,
  ) {
    const now = new Date().toISOString();
    this.updateCompletedWithCommandsStmt.run(
      JSON.stringify(commands),
      logs, // for the CASE WHEN check
      logs, // for the ELSE branch
      now,
      jobId,
    );
  }

  fail(jobId: string, error: string, logs: string) {
    const now = new Date().toISOString();
    this.updateFailedStmt.run(
      error,
      logs, // for the CASE WHEN check
      logs, // for the ELSE branch
      now,
      jobId,
    );
  }

  cancel(jobId: string): boolean {
    const now = new Date().toISOString();
    const result = this.cancelStmt.run(now, jobId);
    return result.changes > 0;
  }

  /** Pause a running job (kills process externally, this just updates status). */
  pause(jobId: string): boolean {
    const result = this.pauseStmt.run(jobId);
    return result.changes > 0;
  }

  /** Move a paused job to queued so the worker can pick it up. */
  resume(jobId: string): boolean {
    const result = this.resumeStmt.run(jobId);
    return result.changes > 0;
  }

  /** Store/clear the Claude CLI session ID for pause/resume. */
  setSessionId(jobId: string, sessionId: string | null): void {
    this.setSessionIdStmt.run(sessionId, jobId);
  }

  /** Move a running job back to queued (e.g. orphaned after server restart). */
  requeue(jobId: string): boolean {
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'queued', started_at = NULL WHERE id = ? AND status = 'running'`,
    ).run(jobId);
    return result.changes > 0;
  }

  /** Add a bridge program to the job's usedBridges list (idempotent). */
  addUsedBridge(jobId: string, program: string): boolean {
    const result = this.addUsedBridgeStmt.run(program, program, program, jobId);
    return result.changes > 0;
  }

  /** Update token usage metrics on a completed/failed job. */
  updateTokens(
    jobId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    durationMs: number,
  ) {
    this.updateTokensStmt.run(inputTokens, outputTokens, costUsd, durationMs, jobId);
  }

  markOutcome(
    jobId: string,
    rating: JobOutcomeRating,
    notes?: string,
    markedBy?: string | null,
  ): boolean {
    const normalizedNotes = String(notes ?? "").trim();
    const now = new Date().toISOString();
    const result = this.markOutcomeStmt.run(
      rating,
      normalizedNotes || null,
      now,
      markedBy ?? null,
      jobId,
    );
    return result.changes > 0;
  }

  reprioritize(jobId: string, priority: JobPriority): boolean {
    const result = this.reprioritizeStmt.run(priority, jobId);
    return result.changes > 0;
  }

  appendLog(jobId: string, text: string) {
    this.appendLogStmt.run(text, jobId);
  }

  pickNext(): Job | null {
    const row = this.pickNextStmt.get() as JobRow | null;
    return row ? rowToJob(row) : null;
  }

  /** Pick next queued job, preferring jobs targeted at the given worker.
   *  Worker-targeted jobs are only returned to matching workers;
   *  untargeted jobs are returned to any worker. */
  pickNextForWorker(workerName: string): Job | null {
    const normalized = normalizeQuotes(workerName).trim().toLowerCase();
    const row = this.pickNextForWorkerStmt.get(normalized, normalized) as JobRow | null;
    return row ? rowToJob(row) : null;
  }

  /** Get all direct child jobs of a parent — uses the parent_job_id index for O(log n) lookup. */
  getChildJobs(parentJobId: string): Job[] {
    const rows = this.getChildJobsStmt.all(parentJobId) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Returns true if the job has any sub-jobs (parentJobId = jobId) still in a non-terminal state. */
  hasPendingChildren(jobId: string): boolean {
    const row = this.hasPendingChildrenStmt.get(jobId) as { n: number };
    return row.n > 0;
  }

  setWorkspaceMode(jobId: string, mode: WorkspaceMode) {
    this.setWorkspaceModeStmt.run(mode, jobId);
  }

  delete(jobId: string): boolean {
    const now = new Date().toISOString();
    const result = this.deleteStmt.run(now, jobId);
    return result.changes > 0;
  }

  deleteBulk(jobIds: string[]): number {
    const now = new Date().toISOString();
    const result = this.deleteBulkStmt.run(now, JSON.stringify(jobIds));
    return result.changes;
  }

  /** Archive a job (soft-archive, still visible in archive list). */
  archive(jobId: string): boolean {
    const now = new Date().toISOString();
    const result = this.archiveStmt.run(now, jobId);
    return result.changes > 0;
  }

  /** Restore a trashed or archived job back to normal state. */
  restore(jobId: string): boolean {
    const result = this.restoreStmt.run(jobId);
    return result.changes > 0;
  }

  /** Permanently delete a job from the database (no status restriction). */
  permanentDelete(jobId: string): boolean {
    const result = this.permanentDeleteStmt.run(jobId);
    return result.changes > 0;
  }

  /** List soft-deleted (trashed) jobs. */
  listTrashed(limit?: number, offset?: number): { jobs: Job[]; total: number } {
    const rows = this.listTrashedStmt.all(limit ?? 50, offset ?? 0) as JobRow[];
    const total = (this.countTrashedStmt.get() as { total: number }).total;
    return { jobs: rows.map(rowToJob), total };
  }

  /** List archived jobs (not trashed). */
  listArchived(limit?: number, offset?: number): { jobs: Job[]; total: number } {
    const rows = this.listArchivedStmt.all(limit ?? 50, offset ?? 0) as JobRow[];
    const total = (this.countArchivedStmt.get() as { total: number }).total;
    return { jobs: rows.map(rowToJob), total };
  }

  /** Permanently delete jobs that have been in the trash longer than `daysOld` days. Returns count of purged rows. */
  purgeOldTrash(daysOld: number): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60_000).toISOString();
    const result = this.purgeOldTrashStmt.run(cutoff);
    return result.changes;
  }

  /**
   * Count completed user jobs since a given timestamp.
   * Excludes training/housekeeping jobs (bridge_program = 'coordinator-training' or 'housekeeping').
   * Optionally filter by bridge program (checks used_bridges JSON array).
   */
  countCompletedSince(sinceIso: string, bridgeProgram?: string): number {
    if (bridgeProgram) {
      const row = this.countCompletedSinceForProgramStmt.get(sinceIso, bridgeProgram) as { total: number };
      return row.total;
    }
    const row = this.countCompletedSinceStmt.get(sinceIso) as { total: number };
    return row.total;
  }

  /** Get dashboard stats efficiently using SQL COUNT queries */
  getDashboardStats(todayPrefix: string): {
    totalJobs: number;
    activeJobs: number;
    queuedJobs: number;
    completedToday: number;
    failedToday: number;
  } {
    const row = this.dashboardStatsStmt.get(todayPrefix, todayPrefix) as {
      total: number;
      active: number;
      queued: number;
      completed_today: number;
      failed_today: number;
    };
    return {
      totalJobs: row.total,
      activeJobs: row.active,
      queuedJobs: row.queued,
      completedToday: row.completed_today,
      failedToday: row.failed_today,
    };
  }

  // ── Retry & TTL ──────────────────────────────────────────────────────────

  /**
   * Requeue a failed job for retry.
   * Increments retry_count, sets retry_after to a future timestamp,
   * and resets status to "queued".
   */
  requeueForRetry(jobId: string, retryDelayMs: number): boolean {
    const retryAfter = new Date(Date.now() + retryDelayMs).toISOString();
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'queued', started_at = NULL, error = NULL,
       retry_count = retry_count + 1, retry_after = ?
       WHERE id = ? AND status = 'failed'`,
    ).run(retryAfter, jobId);
    return result.changes > 0;
  }

  /** Set max retries for a job (call at creation time). */
  setMaxRetries(jobId: string, maxRetries: number): void {
    this.db.prepare(`UPDATE jobs SET max_retries = ? WHERE id = ?`).run(maxRetries, jobId);
  }

  /** Set expiration time for a job (used for worker-targeted TTL). */
  setExpiry(jobId: string, expiresAt: string): void {
    this.db.prepare(`UPDATE jobs SET expires_at = ? WHERE id = ?`).run(expiresAt, jobId);
  }

  /**
   * Fail all queued jobs that have expired (expires_at < now).
   * Returns the number of jobs expired.
   */
  expireStaleTargetedJobs(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'failed', error = 'Target worker never connected within TTL',
       completed_at = ?
       WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(now, now);
    return result.changes;
  }
}
