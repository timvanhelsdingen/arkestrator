import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface SkillEffectivenessRecord {
  id: string;
  skillId: string;
  jobId: string;
  jobOutcome: string | null;
  ratingNotes: string | null;
  createdAt: string;
}

export interface SkillFeedbackRecord {
  skillId: string;
  jobId: string;
  jobOutcome: string | null;
  outcomeNotes: string | null;
  createdAt: string;
}

export interface SkillEffectivenessStats {
  totalUsed: number;
  goodOutcomes: number;
  averageOutcomes: number;
  poorOutcomes: number;
  pendingOutcomes: number;
  /** Weighted success rate across rated rows: positive=1, average=0.5, negative=0. */
  successRate: number;
  /** Number of rows that actually have an outcome — the phase counter used by the ranker. */
  ratedCount: number;
}

export class SkillEffectivenessRepo {
  constructor(private db: Database) {}

  /**
   * Record that a skill was injected into a job.
   * Idempotent per (skill_id, job_id) via the UNIQUE index on those columns.
   */
  recordUsage(skillId: string, jobId: string): void {
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO skill_effectiveness (id, skill_id, job_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(newId(), skillId, jobId, new Date().toISOString());
    } catch {
      // Table may not exist yet on older DBs
    }
  }

  /**
   * Record a usage row only if no row already exists for (skillId, jobId).
   * Safe under concurrency: uses INSERT OR IGNORE against the UNIQUE index on
   * (skill_id, job_id) rather than a racy SELECT-then-INSERT.
   */
  recordUsageOnce(skillId: string, jobId: string): void {
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO skill_effectiveness (id, skill_id, job_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(newId(), skillId, jobId, new Date().toISOString());
    } catch {
      // Table may not exist yet on older DBs
    }
  }

  /** Update the outcome for all skill usages associated with a job (fallback for unrated skills). */
  recordOutcome(jobId: string, outcome: string): void {
    try {
      // Only update records that haven't been explicitly rated by the agent
      this.db.prepare(
        `UPDATE skill_effectiveness SET job_outcome = ? WHERE job_id = ? AND job_outcome IS NULL`,
      ).run(outcome, jobId);
    } catch {
      // Table may not exist
    }
  }

  /**
   * Like {@link recordOutcome}, but never touches rows for the given skill ids.
   * Used by the rate_job fallback on verification-disabled jobs so that
   * verification skill rows don't get stamped with an outcome they had no
   * chance to earn (closes the last hole in the verification filter).
   */
  recordOutcomeExcluding(jobId: string, outcome: string, excludedSkillIds: string[]): void {
    if (!excludedSkillIds || excludedSkillIds.length === 0) {
      this.recordOutcome(jobId, outcome);
      return;
    }
    try {
      const placeholders = excludedSkillIds.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE skill_effectiveness
           SET job_outcome = ?
         WHERE job_id = ?
           AND job_outcome IS NULL
           AND skill_id NOT IN (${placeholders})`,
      ).run(outcome, jobId, ...excludedSkillIds);
      // Also hard-delete any stray usage rows for excluded skills on this job
      // — the skill had no chance to help, so it shouldn't keep pending rows
      // inflating its totalUsed counter either.
      this.db.prepare(
        `DELETE FROM skill_effectiveness
           WHERE job_id = ?
             AND job_outcome IS NULL
             AND skill_id IN (${placeholders})`,
      ).run(jobId, ...excludedSkillIds);
    } catch {
      // Table may not exist
    }
  }

  /**
   * Update the outcome for a specific skill+job pair (agent self-assessment).
   * Upserts: if no usage row exists yet (e.g. agent rated after only
   * `search_skills`, or via am CLI), a new row is created so the rating
   * isn't silently dropped.
   *
   * Optional `notes` captures the agent's short reason for the rating so the
   * UI can show *why* a skill was marked useful/partial/not_useful instead
   * of just a bare outcome.
   */
  recordSkillOutcome(skillId: string, jobId: string, outcome: string, notes?: string | null): void {
    const trimmedNotes = notes != null ? String(notes).trim() : "";
    const noteValue = trimmedNotes.length > 0 ? trimmedNotes : null;
    try {
      const res = this.db.prepare(
        `UPDATE skill_effectiveness
            SET job_outcome = ?,
                rating_notes = ?
          WHERE skill_id = ? AND job_id = ?`,
      ).run(outcome, noteValue, skillId, jobId);
      if (res.changes === 0) {
        this.db.prepare(
          `INSERT INTO skill_effectiveness (id, skill_id, job_id, job_outcome, rating_notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(newId(), skillId, jobId, outcome, noteValue, new Date().toISOString());
      }
    } catch {
      // Table may not exist
    }
  }

  /**
   * Per-user outcome tally for a skill. Joins skill_effectiveness with jobs
   * on job_id and filters to the target user, so each caller's rolling
   * average is isolated from other users on the same local server.
   *
   * Used by the community-rating push: we compute a user's rolling average
   * across every internal rating they've ever left for a skill, map it to
   * stars, and upsert it on arkestrator.com.
   *
   * Pending rows (job_outcome IS NULL) are ignored so one-shot search_skills
   * touches that were never rated don't drag the average down.
   */
  getUserOutcomeTally(skillId: string, userId: string): { positive: number; average: number; negative: number; samples: number } {
    try {
      const row = this.db.prepare(
        `SELECT
            SUM(CASE WHEN se.job_outcome IN ('positive','good') THEN 1 ELSE 0 END) AS pos,
            SUM(CASE WHEN se.job_outcome = 'average' THEN 1 ELSE 0 END) AS avg,
            SUM(CASE WHEN se.job_outcome IN ('negative','poor') THEN 1 ELSE 0 END) AS neg
           FROM skill_effectiveness se
           JOIN jobs j ON j.id = se.job_id
          WHERE se.skill_id = ?
            AND j.submitted_by = ?
            AND se.job_outcome IS NOT NULL`,
      ).get(skillId, userId) as { pos: number | null; avg: number | null; neg: number | null } | null;
      const positive = row?.pos ?? 0;
      const average = row?.avg ?? 0;
      const negative = row?.neg ?? 0;
      return { positive, average, negative, samples: positive + average + negative };
    } catch {
      return { positive: 0, average: 0, negative: 0, samples: 0 };
    }
  }

  /** Get effectiveness stats for a specific skill. */
  getStats(skillId: string): SkillEffectivenessStats {
    try {
      const rows = this.db.prepare(
        `SELECT job_outcome FROM skill_effectiveness WHERE skill_id = ?`,
      ).all(skillId) as Array<{ job_outcome: string | null }>;

      const total = rows.length;
      const good = rows.filter((r) => r.job_outcome === "positive" || r.job_outcome === "good").length;
      const average = rows.filter((r) => r.job_outcome === "average").length;
      const poor = rows.filter((r) => r.job_outcome === "negative" || r.job_outcome === "poor").length;
      const pending = rows.filter((r) => !r.job_outcome).length;

      const rated = total - pending;
      return {
        totalUsed: total,
        goodOutcomes: good,
        averageOutcomes: average,
        poorOutcomes: poor,
        pendingOutcomes: pending,
        // positive=1, average=0.5, negative=0 — weighted success rate
        successRate: rated > 0 ? (good + average * 0.5) / rated : 0,
        ratedCount: rated,
      };
    } catch {
      return { totalUsed: 0, goodOutcomes: 0, averageOutcomes: 0, poorOutcomes: 0, pendingOutcomes: 0, successRate: 0, ratedCount: 0 };
    }
  }

  /**
   * Batch-fetch effectiveness stats for multiple skills in one query.
   * Returns a Map of skillId -> stats. Missing skills get default zero stats.
   */
  getStatsForSkills(skillIds: string[]): Map<string, SkillEffectivenessStats> {
    const result = new Map<string, SkillEffectivenessStats>();
    if (skillIds.length === 0) return result;
    try {
      const placeholders = skillIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT skill_id, job_outcome FROM skill_effectiveness WHERE skill_id IN (${placeholders})`,
      ).all(...skillIds) as Array<{ skill_id: string; job_outcome: string | null }>;

      // Group by skill_id
      const grouped = new Map<string, Array<string | null>>();
      for (const row of rows) {
        let arr = grouped.get(row.skill_id);
        if (!arr) { arr = []; grouped.set(row.skill_id, arr); }
        arr.push(row.job_outcome);
      }

      for (const [skillId, outcomes] of grouped) {
        const total = outcomes.length;
        const good = outcomes.filter((o) => o === "positive" || o === "good").length;
        const average = outcomes.filter((o) => o === "average").length;
        const poor = outcomes.filter((o) => o === "negative" || o === "poor").length;
        const pending = outcomes.filter((o) => !o).length;
        const rated = total - pending;
        result.set(skillId, {
          totalUsed: total,
          goodOutcomes: good,
          averageOutcomes: average,
          poorOutcomes: poor,
          pendingOutcomes: pending,
          // positive=1, average=0.5, negative=0 — weighted success rate
          successRate: rated > 0 ? (good + average * 0.5) / rated : 0,
          ratedCount: rated,
        });
      }
    } catch {
      // Table may not exist
    }
    return result;
  }

  /**
   * Global aggregate ranking info for every skill that has at least one usage
   * row, in a single query. The ranker needs `{successRate, totalUsed, ratedCount}`
   * per skill. Skills with no usage row simply aren't in the map — callers
   * treat that as exploration phase.
   */
  getRankingInfoForAllSkills(): Map<string, { successRate: number; totalUsed: number; ratedCount: number }> {
    const result = new Map<string, { successRate: number; totalUsed: number; ratedCount: number }>();
    try {
      const rows = this.db.prepare(
        `SELECT skill_id,
                COUNT(*) AS total,
                SUM(CASE WHEN job_outcome IN ('positive','good') THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN job_outcome = 'average' THEN 1 ELSE 0 END) AS avg,
                SUM(CASE WHEN job_outcome IN ('negative','poor') THEN 1 ELSE 0 END) AS poor,
                SUM(CASE WHEN job_outcome IS NULL THEN 1 ELSE 0 END) AS pending
           FROM skill_effectiveness
          GROUP BY skill_id`,
      ).all() as Array<{ skill_id: string; total: number; good: number; avg: number; poor: number; pending: number }>;
      for (const row of rows) {
        const rated = (row.total ?? 0) - (row.pending ?? 0);
        result.set(row.skill_id, {
          totalUsed: row.total ?? 0,
          ratedCount: rated,
          successRate: rated > 0 ? ((row.good ?? 0) + (row.avg ?? 0) * 0.5) / rated : 0,
        });
      }
    } catch {
      // Table may not exist on older DBs
    }
    return result;
  }

  /**
   * Remove any effectiveness rows for a specific skill+job pair. Used when a
   * rating should be voided (e.g. verification skills on verification-disabled
   * jobs) so the rate_job fallback can't later stamp an outcome onto them.
   */
  deleteForSkillAndJob(skillId: string, jobId: string): number {
    try {
      const res = this.db.prepare(
        `DELETE FROM skill_effectiveness WHERE skill_id = ? AND job_id = ?`,
      ).run(skillId, jobId);
      return res.changes;
    } catch {
      return 0;
    }
  }

  /** Wipe ALL effectiveness records for every skill. Returns number of rows removed. */
  wipeAll(): number {
    try {
      const res = this.db.prepare(`DELETE FROM skill_effectiveness`).run();
      return res.changes;
    } catch {
      return 0;
    }
  }

  /** Wipe all effectiveness records for a single skill. Returns number of rows removed. */
  wipeForSkill(skillId: string): number {
    try {
      const res = this.db.prepare(`DELETE FROM skill_effectiveness WHERE skill_id = ?`).run(skillId);
      return res.changes;
    } catch {
      return 0;
    }
  }

  /** Delete a single effectiveness record by its id. Returns true if a row was removed. */
  deleteRecord(recordId: string): boolean {
    try {
      const res = this.db.prepare(`DELETE FROM skill_effectiveness WHERE id = ?`).run(recordId);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  // clearRecordOutcome was removed intentionally: leaving a row with
  // job_outcome = NULL while still counting it as a usage inflates the
  // phase counter in the ranking algorithm without contributing any
  // outcome signal. Removing a rating now always deletes the full row
  // via deleteRecord() so "used" and "rated" stay in sync.

  /** List recent usage records for a skill (newest first). */
  listForSkill(skillId: string, limit = 20): SkillEffectivenessRecord[] {
    try {
      const rows = this.db.prepare(
        `SELECT id, skill_id, job_id, job_outcome, rating_notes, created_at
           FROM skill_effectiveness
          WHERE skill_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      ).all(skillId, limit) as Array<{
        id: string; skill_id: string; job_id: string; job_outcome: string | null; rating_notes: string | null; created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        skillId: r.skill_id,
        jobId: r.job_id,
        jobOutcome: r.job_outcome,
        ratingNotes: r.rating_notes,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get recent feedback records for a skill, joined with job outcome notes.
   * Only returns records that have outcome notes (non-null, non-empty).
   */
  getRecentFeedbackWithNotes(skillId: string, limit = 5): SkillFeedbackRecord[] {
    try {
      const rows = this.db.prepare(
        `SELECT se.skill_id, se.job_id, se.job_outcome, j.outcome_notes, se.created_at
         FROM skill_effectiveness se
         JOIN jobs j ON se.job_id = j.id
         WHERE se.skill_id = ? AND j.outcome_notes IS NOT NULL AND j.outcome_notes != ''
         ORDER BY se.created_at DESC
         LIMIT ?`,
      ).all(skillId, limit) as Array<{
        skill_id: string; job_id: string; job_outcome: string | null; outcome_notes: string | null; created_at: string;
      }>;
      return rows.map((r) => ({
        skillId: r.skill_id,
        jobId: r.job_id,
        jobOutcome: r.job_outcome,
        outcomeNotes: r.outcome_notes,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }
}
