import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

interface UsageRow {
  id: string;
  job_id: string;
  user_id: string | null;
  agent_config_id: string | null;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  cost_usd: number;
  created_at: string;
}

export interface UsageStat {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd?: number;
}

export interface AggregateStats {
  totalInput: number;
  totalOutput: number;
  totalDuration: number;
  jobCount: number;
}

export class UsageRepo {
  private recordStmt;
  private getByJobIdStmt;
  private getByJobIdsStmt;
  private getAggregateStmt;
  private getByUserIdSinceStmt;

  constructor(private db: Database) {
    this.recordStmt = db.prepare(
      `INSERT INTO usage_stats (id, job_id, user_id, agent_config_id, input_tokens, output_tokens, duration_ms, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByJobIdStmt = db.prepare(
      `SELECT * FROM usage_stats WHERE job_id = ?`,
    );
    this.getByJobIdsStmt = db.prepare(
      `SELECT * FROM usage_stats WHERE job_id IN (SELECT value FROM json_each(?))`,
    );
    this.getAggregateStmt = db.prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(duration_ms), 0) as total_duration,
        COUNT(*) as job_count
       FROM usage_stats`,
    );
    this.getByUserIdSinceStmt = db.prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COUNT(*) as job_count
       FROM usage_stats WHERE user_id = ? AND created_at >= ?`,
    );
  }

  record(
    jobId: string,
    userId: string | null,
    agentConfigId: string | null,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    costUsd = 0,
  ) {
    const id = newId();
    const now = new Date().toISOString();
    this.recordStmt.run(
      id,
      jobId,
      userId,
      agentConfigId,
      inputTokens,
      outputTokens,
      durationMs,
      costUsd,
      now,
    );
  }

  getByJobId(jobId: string): UsageStat | null {
    const row = this.getByJobIdStmt.get(jobId) as UsageRow | null;
    if (!row) return null;
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      durationMs: row.duration_ms,
      costUsd: row.cost_usd > 0 ? row.cost_usd : undefined,
    };
  }

  /** Batch lookup: returns a map of jobId -> UsageStat */
  getByJobIds(jobIds: string[]): Map<string, UsageStat> {
    if (jobIds.length === 0) return new Map();
    const rows = this.getByJobIdsStmt.all(JSON.stringify(jobIds)) as UsageRow[];
    const map = new Map<string, UsageStat>();
    for (const row of rows) {
      map.set(row.job_id, {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        durationMs: row.duration_ms,
        costUsd: row.cost_usd > 0 ? row.cost_usd : undefined,
      });
    }
    return map;
  }

  /** Get aggregate usage for a specific user since a given date. */
  getByUserIdSince(
    userId: string,
    since: string,
  ): { totalInput: number; totalOutput: number; jobCount: number } {
    const row = this.getByUserIdSinceStmt.get(userId, since) as {
      total_input: number;
      total_output: number;
      job_count: number;
    };
    return {
      totalInput: row.total_input,
      totalOutput: row.total_output,
      jobCount: row.job_count,
    };
  }

  getStats(): AggregateStats {
    const row = this.getAggregateStmt.get() as {
      total_input: number;
      total_output: number;
      total_duration: number;
      job_count: number;
    };
    return {
      totalInput: row.total_input,
      totalOutput: row.total_output,
      totalDuration: row.total_duration,
      jobCount: row.job_count,
    };
  }
}
