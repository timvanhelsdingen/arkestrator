import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface SkillEffectivenessRecord {
  id: string;
  skillId: string;
  jobId: string;
  jobOutcome: string | null;
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
  successRate: number;
}

export class SkillEffectivenessRepo {
  constructor(private db: Database) {}

  /** Record that a skill was injected into a job. */
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

  /** Update the outcome for a specific skill+job pair (agent self-assessment). */
  recordSkillOutcome(skillId: string, jobId: string, outcome: string): void {
    try {
      this.db.prepare(
        `UPDATE skill_effectiveness SET job_outcome = ? WHERE skill_id = ? AND job_id = ?`,
      ).run(outcome, skillId, jobId);
    } catch {
      // Table may not exist
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
      };
    } catch {
      return { totalUsed: 0, goodOutcomes: 0, averageOutcomes: 0, poorOutcomes: 0, pendingOutcomes: 0, successRate: 0 };
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
        });
      }
    } catch {
      // Table may not exist
    }
    return result;
  }

  /** List recent usage records for a skill (newest first). */
  listForSkill(skillId: string, limit = 20): SkillEffectivenessRecord[] {
    try {
      const rows = this.db.prepare(
        `SELECT * FROM skill_effectiveness WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(skillId, limit) as Array<{
        id: string; skill_id: string; job_id: string; job_outcome: string | null; created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        skillId: r.skill_id,
        jobId: r.job_id,
        jobOutcome: r.job_outcome,
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
