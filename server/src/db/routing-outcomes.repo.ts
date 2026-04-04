import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface RoutingOutcome {
  id: string;
  taskPattern: string;
  agentConfigId: string;
  engine: string;
  model: string | null;
  outcome: "success" | "failure";
  costUsd: number;
  durationMs: number;
  complexityScore: number;
  createdAt: string;
}

export interface ConfigStats {
  configId: string;
  engine: string;
  model: string | null;
  successRate: number;
  totalJobs: number;
  avgCostUsd: number;
  avgDurationMs: number;
}

export class RoutingOutcomesRepo {
  constructor(private db: Database) {}

  /** Record a routing outcome after a job completes. */
  record(
    taskPattern: string,
    agentConfigId: string,
    engine: string,
    model: string | null,
    outcome: "success" | "failure",
    costUsd = 0,
    durationMs = 0,
    complexityScore = 0,
  ): void {
    try {
      this.db.prepare(
        `INSERT INTO routing_outcomes (id, task_pattern, agent_config_id, engine, model, outcome, cost_usd, duration_ms, complexity_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(), taskPattern, agentConfigId, engine, model ?? "",
        outcome, costUsd, durationMs, complexityScore,
        new Date().toISOString(),
      );
    } catch {
      // Table may not exist on older DBs
    }
  }

  /** Get per-config success rates for a task pattern. */
  getConfigStats(taskPattern: string): ConfigStats[] {
    try {
      const rows = this.db.prepare(
        `SELECT
           agent_config_id,
           engine,
           model,
           COUNT(*) as total,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
           AVG(cost_usd) as avg_cost,
           AVG(duration_ms) as avg_duration
         FROM routing_outcomes
         WHERE task_pattern = ?
         GROUP BY agent_config_id, engine
         ORDER BY (CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC`,
      ).all(taskPattern) as Array<{
        agent_config_id: string;
        engine: string;
        model: string;
        total: number;
        successes: number;
        avg_cost: number;
        avg_duration: number;
      }>;

      return rows.map((r) => ({
        configId: r.agent_config_id,
        engine: r.engine,
        model: r.model || null,
        successRate: r.total > 0 ? r.successes / r.total : 0,
        totalJobs: r.total,
        avgCostUsd: r.avg_cost ?? 0,
        avgDurationMs: r.avg_duration ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get the best config for a task pattern within a specific engine family.
   * Only returns a result when sufficient data exists (>= minSamples).
   * Constraining by engine prevents cross-engine switching (e.g. claude → codex).
   */
  getBestConfigForEngine(
    taskPattern: string,
    engine: string,
    minSamples = 5,
  ): ConfigStats | null {
    const stats = this.getConfigStats(taskPattern);
    const candidates = stats
      .filter((s) => s.engine === engine && s.totalJobs >= minSamples)
      .sort((a, b) => b.successRate - a.successRate);
    return candidates[0] ?? null;
  }

  /**
   * Get all pattern summaries for admin visibility.
   * Returns aggregated stats grouped by task pattern.
   */
  getPatternSummary(): Array<{
    pattern: string;
    configs: ConfigStats[];
  }> {
    try {
      const rows = this.db.prepare(
        `SELECT DISTINCT task_pattern FROM routing_outcomes ORDER BY task_pattern`,
      ).all() as Array<{ task_pattern: string }>;

      return rows.map((r) => ({
        pattern: r.task_pattern,
        configs: this.getConfigStats(r.task_pattern),
      }));
    } catch {
      return [];
    }
  }
}
