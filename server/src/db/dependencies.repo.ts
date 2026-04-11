import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export class DependenciesRepo {
  private addStmt;
  private removeStmt;
  private removeByPairStmt;
  private getDependenciesStmt;
  private getDependentsStmt;
  private getBlockingDepsStmt;
  private getDependenciesBatchStmt;

  constructor(private db: Database) {
    this.addStmt = db.prepare(
      `INSERT OR IGNORE INTO job_dependencies (id, job_id, depends_on_job_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.removeStmt = db.prepare(
      `DELETE FROM job_dependencies WHERE id = ?`,
    );
    this.removeByPairStmt = db.prepare(
      `DELETE FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?`,
    );
    this.getDependenciesStmt = db.prepare(
      `SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?`,
    );
    this.getDependentsStmt = db.prepare(
      `SELECT job_id FROM job_dependencies WHERE depends_on_job_id = ?`,
    );
    this.getBlockingDepsStmt = db.prepare(
      `SELECT d.depends_on_job_id FROM job_dependencies d
       JOIN jobs j ON j.id = d.depends_on_job_id
       WHERE d.job_id = ? AND j.status NOT IN ('completed')`,
    );
    this.getDependenciesBatchStmt = db.prepare(
      `SELECT job_id, depends_on_job_id FROM job_dependencies WHERE job_id IN (SELECT value FROM json_each(?))`,
    );
  }

  add(jobId: string, dependsOnJobId: string) {
    const id = newId();
    const now = new Date().toISOString();
    this.addStmt.run(id, jobId, dependsOnJobId, now);
  }

  /**
   * Check whether adding `jobId → dependsOnJobId` would create a cycle in
   * the dependency graph. Returns the offending path if a cycle is detected,
   * or null if the edge is safe to add.
   *
   * Uses BFS over existing dependencies: if `jobId` is reachable from
   * `dependsOnJobId` via the existing edges, adding the new edge would close
   * a cycle.
   */
  wouldCreateCycle(jobId: string, dependsOnJobId: string): string[] | null {
    if (jobId === dependsOnJobId) return [jobId, dependsOnJobId];
    const visited = new Set<string>();
    // BFS from dependsOnJobId following depends_on edges (i.e. "what does X depend on?").
    // If we can reach jobId, there's already a path jobId -> ... -> dependsOnJobId,
    // so the new edge dependsOnJobId -> jobId would close a cycle.
    // Actually we want: from dependsOnJobId follow REVERSE dependency edges
    // (its own dependencies) to see if jobId is somewhere upstream.
    const stack: Array<{ node: string; path: string[] }> = [
      { node: dependsOnJobId, path: [dependsOnJobId] },
    ];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      const upstream = this.getDependencies(node);
      for (const up of upstream) {
        if (up === jobId) return [...path, jobId];
        stack.push({ node: up, path: [...path, up] });
      }
    }
    return null;
  }

  /**
   * Recursively collect all transitive dependents of a job (jobs that depend
   * on it, directly or indirectly). Used when a job fails permanently to
   * propagate failure to downstream jobs.
   */
  getTransitiveDependents(jobId: string): string[] {
    const collected = new Set<string>();
    const stack = [jobId];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const direct = this.getDependents(node);
      for (const dep of direct) {
        if (collected.has(dep)) continue;
        collected.add(dep);
        stack.push(dep);
      }
    }
    return [...collected];
  }

  remove(depId: string) {
    this.removeStmt.run(depId);
  }

  removeByPair(jobId: string, dependsOnJobId: string) {
    this.removeByPairStmt.run(jobId, dependsOnJobId);
  }

  getDependencies(jobId: string): string[] {
    const rows = this.getDependenciesStmt.all(jobId) as {
      depends_on_job_id: string;
    }[];
    return rows.map((r) => r.depends_on_job_id);
  }

  getDependents(jobId: string): string[] {
    const rows = this.getDependentsStmt.all(jobId) as { job_id: string }[];
    return rows.map((r) => r.job_id);
  }

  getBlockingDeps(jobId: string): string[] {
    const rows = this.getBlockingDepsStmt.all(jobId) as {
      depends_on_job_id: string;
    }[];
    return rows.map((r) => r.depends_on_job_id);
  }

  /** Batch lookup: returns a map of jobId -> dependsOn[] */
  getDependenciesBatch(jobIds: string[]): Map<string, string[]> {
    if (jobIds.length === 0) return new Map();
    const rows = this.getDependenciesBatchStmt.all(JSON.stringify(jobIds)) as {
      job_id: string;
      depends_on_job_id: string;
    }[];
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const deps = map.get(row.job_id) ?? [];
      deps.push(row.depends_on_job_id);
      map.set(row.job_id, deps);
    }
    return map;
  }
}
