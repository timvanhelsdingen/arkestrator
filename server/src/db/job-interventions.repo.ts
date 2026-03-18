import { Database } from "bun:sqlite";
import type {
  JobIntervention,
  JobInterventionCreate,
  JobInterventionSource,
  JobInterventionStatus,
} from "@arkestrator/protocol";
import { newId } from "../utils/id.js";

interface JobInterventionRow {
  id: string;
  job_id: string;
  author_user_id: string | null;
  author_username: string | null;
  source: string;
  status: string;
  text: string;
  created_at: string;
  delivered_at: string | null;
  rejected_at: string | null;
  status_reason: string | null;
  delivery_metadata: string | null;
}

function rowToIntervention(row: JobInterventionRow): JobIntervention {
  let deliveryMetadata: Record<string, unknown> | undefined;
  if (row.delivery_metadata) {
    try {
      deliveryMetadata = JSON.parse(row.delivery_metadata);
    } catch {
      deliveryMetadata = undefined;
    }
  }
  return {
    id: row.id,
    jobId: row.job_id,
    authorUserId: row.author_user_id ?? undefined,
    authorUsername: row.author_username ?? undefined,
    source: row.source as JobInterventionSource,
    status: row.status as JobInterventionStatus,
    text: row.text,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    statusReason: row.status_reason ?? undefined,
    deliveryMetadata,
  };
}

export class JobInterventionsRepo {
  private insertStmt;
  private listByJobStmt;
  private listPendingStmt;
  private markDeliveredStmt;
  private markRejectedPendingByJobStmt;
  private getByIdStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO job_interventions (
        id, job_id, author_user_id, author_username, source, status, text,
        created_at, delivered_at, rejected_at, status_reason, delivery_metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listByJobStmt = db.prepare(
      `SELECT * FROM job_interventions WHERE job_id = ? ORDER BY created_at ASC`,
    );
    this.listPendingStmt = db.prepare(
      `SELECT * FROM job_interventions
       WHERE job_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
    );
    this.markDeliveredStmt = db.prepare(
      `UPDATE job_interventions
       SET status = 'delivered', delivered_at = ?, status_reason = ?, delivery_metadata = ?
       WHERE id IN (SELECT value FROM json_each(?)) AND status = 'pending'`,
    );
    this.markRejectedPendingByJobStmt = db.prepare(
      `UPDATE job_interventions
       SET status = 'rejected', rejected_at = ?, status_reason = ?
       WHERE job_id = ? AND status = 'pending'`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM job_interventions WHERE id = ?`);
  }

  create(
    jobId: string,
    input: JobInterventionCreate,
    author: { userId?: string | null; username: string },
  ): JobIntervention {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      jobId,
      author.userId ?? null,
      author.username,
      input.source,
      "pending",
      input.text,
      now,
      null,
      null,
      null,
      null,
    );
    return this.getById(id)!;
  }

  getById(id: string): JobIntervention | null {
    const row = this.getByIdStmt.get(id) as JobInterventionRow | null;
    return row ? rowToIntervention(row) : null;
  }

  listByJob(jobId: string): JobIntervention[] {
    return (this.listByJobStmt.all(jobId) as JobInterventionRow[]).map(rowToIntervention);
  }

  listPending(jobId: string): JobIntervention[] {
    return (this.listPendingStmt.all(jobId) as JobInterventionRow[]).map(rowToIntervention);
  }

  markDelivered(
    interventionIds: string[],
    metadata?: Record<string, unknown>,
    reason?: string,
  ): JobIntervention[] {
    if (interventionIds.length === 0) return [];
    const now = new Date().toISOString();
    this.markDeliveredStmt.run(
      now,
      reason ?? null,
      metadata ? JSON.stringify(metadata) : null,
      JSON.stringify(interventionIds),
    );
    return interventionIds
      .map((id) => this.getById(id))
      .filter((entry): entry is JobIntervention => !!entry);
  }

  rejectPendingForJob(jobId: string, reason: string): JobIntervention[] {
    const pending = this.listPending(jobId);
    if (pending.length === 0) return [];
    const now = new Date().toISOString();
    this.markRejectedPendingByJobStmt.run(now, reason, jobId);
    return pending
      .map((entry) => this.getById(entry.id))
      .filter((entry): entry is JobIntervention => !!entry);
  }
}
