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
