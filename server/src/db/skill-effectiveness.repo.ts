import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface SkillEffectivenessRecord {
  id: string;
  skillId: string;
  jobId: string;
  jobOutcome: string | null;
  ratingNotes: string | null;
  relevance: string | null;
  accuracy: string | null;
  completeness: string | null;
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
  recordSkillOutcome(
    skillId: string,
    jobId: string,
    outcome: string,
    extra?: { notes?: string; relevance?: string; accuracy?: string; completeness?: string },
  ): void {
    try {
      this.db.prepare(
        `UPDATE skill_effectiveness
         SET job_outcome = ?,
             rating_notes = COALESCE(?, rating_notes),
             relevance = COALESCE(?, relevance),
             accuracy = COALESCE(?, accuracy),
             completeness = COALESCE(?, completeness)
         WHERE skill_id = ? AND job_id = ?`,
      ).run(
        outcome,
        extra?.notes ?? null,
        extra?.relevance ?? null,
        extra?.accuracy ?? null,
        extra?.completeness ?? null,
        skillId,
        jobId,
      );
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
        id: string; skill_id: string; job_id: string; job_outcome: string | null;
        rating_notes: string | null; relevance: string | null; accuracy: string | null; completeness: string | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        skillId: r.skill_id,
        jobId: r.job_id,
        jobOutcome: r.job_outcome,
        ratingNotes: r.rating_notes,
        relevance: r.relevance,
        accuracy: r.accuracy,
        completeness: r.completeness,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  /** Get the last N ratings for a skill including all feedback fields (for housekeeping). */
  getRecentFeedback(skillId: string, limit = 10): SkillEffectivenessRecord[] {
    try {
      const rows = this.db.prepare(
        `SELECT * FROM skill_effectiveness
         WHERE skill_id = ? AND job_outcome IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
      ).all(skillId, limit) as Array<{
        id: string; skill_id: string; job_id: string; job_outcome: string | null;
        rating_notes: string | null; relevance: string | null; accuracy: string | null; completeness: string | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        skillId: r.skill_id,
        jobId: r.job_id,
        jobOutcome: r.job_outcome,
        ratingNotes: r.rating_notes,
        relevance: r.relevance,
        accuracy: r.accuracy,
        completeness: r.completeness,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Aggregated feedback summary per skill: count of each relevance/accuracy/completeness value,
   * plus the most recent notes. Returns a Map keyed by skillId.
   */
  getSkillFeedbackSummary(skillIds: string[]): Map<string, {
    total: number;
    relevance: Record<string, number>;
    accuracy: Record<string, number>;
    completeness: Record<string, number>;
    recentNotes: string[];
  }> {
    const result = new Map<string, {
      total: number;
      relevance: Record<string, number>;
      accuracy: Record<string, number>;
      completeness: Record<string, number>;
      recentNotes: string[];
    }>();
    if (skillIds.length === 0) return result;

    try {
      const placeholders = skillIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT skill_id, rating_notes, relevance, accuracy, completeness, created_at
         FROM skill_effectiveness
         WHERE skill_id IN (${placeholders}) AND job_outcome IS NOT NULL
         ORDER BY created_at DESC`,
      ).all(...skillIds) as Array<{
        skill_id: string; rating_notes: string | null;
        relevance: string | null; accuracy: string | null; completeness: string | null;
        created_at: string;
      }>;

      for (const row of rows) {
        let entry = result.get(row.skill_id);
        if (!entry) {
          entry = { total: 0, relevance: {}, accuracy: {}, completeness: {}, recentNotes: [] };
          result.set(row.skill_id, entry);
        }
        entry.total++;
        if (row.relevance) entry.relevance[row.relevance] = (entry.relevance[row.relevance] || 0) + 1;
        if (row.accuracy) entry.accuracy[row.accuracy] = (entry.accuracy[row.accuracy] || 0) + 1;
        if (row.completeness) entry.completeness[row.completeness] = (entry.completeness[row.completeness] || 0) + 1;
        if (row.rating_notes && entry.recentNotes.length < 5) entry.recentNotes.push(row.rating_notes);
      }
    } catch {
      // Table may not exist
    }
    return result;
  }
}
