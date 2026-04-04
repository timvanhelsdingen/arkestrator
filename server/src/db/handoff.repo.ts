/**
 * HandoffRepo — Inter-agent communication via lightweight handoff notes.
 *
 * Agents post progress notes as they work, and other agents (or the same agent
 * on a subsequent run) can read them to understand what happened before.
 * Optionally includes file hashes for change detection.
 */

import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface HandoffNote {
  id: string;
  jobId: string;
  parentJobId: string | null;
  program: string;
  projectPath: string | null;
  category: "progress" | "blocker" | "done" | "warning";
  content: string;
  fileHashes: Record<string, string> | null;
  createdAt: string;
}

interface HandoffRow {
  id: string;
  job_id: string;
  parent_job_id: string | null;
  program: string;
  project_path: string | null;
  category: string;
  content: string;
  file_hashes: string | null;
  created_at: string;
}

function rowToNote(row: HandoffRow): HandoffNote {
  let fileHashes: Record<string, string> | null = null;
  if (row.file_hashes) {
    try { fileHashes = JSON.parse(row.file_hashes); } catch {}
  }
  return {
    id: row.id,
    jobId: row.job_id,
    parentJobId: row.parent_job_id,
    program: row.program,
    projectPath: row.project_path,
    category: row.category as HandoffNote["category"],
    content: row.content,
    fileHashes,
    createdAt: row.created_at,
  };
}

export class HandoffRepo {
  private insertStmt;
  private byProjectStmt;
  private byParentStmt;
  private recentStmt;
  private latestHashesStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO handoff_notes (id, job_id, parent_job_id, program, project_path, category, content, file_hashes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.byProjectStmt = db.prepare(
      `SELECT * FROM handoff_notes WHERE project_path = ? AND (? = '' OR program = ?) ORDER BY created_at DESC LIMIT ?`,
    );
    this.byParentStmt = db.prepare(
      `SELECT * FROM handoff_notes WHERE parent_job_id = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.recentStmt = db.prepare(
      `SELECT * FROM handoff_notes WHERE (? = '' OR program = ?) ORDER BY created_at DESC LIMIT ?`,
    );
    this.latestHashesStmt = db.prepare(
      `SELECT * FROM handoff_notes WHERE project_path = ? AND (? = '' OR program = ?) AND file_hashes IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    );
  }

  post(
    jobId: string,
    program: string,
    projectPath: string | null,
    category: HandoffNote["category"],
    content: string,
    fileHashes?: Record<string, string>,
    parentJobId?: string,
  ): HandoffNote {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id, jobId, parentJobId ?? null, program, projectPath ?? null,
      category, content, fileHashes ? JSON.stringify(fileHashes) : null, now,
    );
    return {
      id, jobId, parentJobId: parentJobId ?? null, program,
      projectPath: projectPath ?? null, category, content,
      fileHashes: fileHashes ?? null, createdAt: now,
    };
  }

  getForProject(projectPath: string, program?: string, limit = 10): HandoffNote[] {
    const p = program ?? "";
    return (this.byProjectStmt.all(projectPath, p, p, limit) as HandoffRow[]).map(rowToNote);
  }

  getForParentJob(parentJobId: string, limit = 20): HandoffNote[] {
    return (this.byParentStmt.all(parentJobId, limit) as HandoffRow[]).map(rowToNote);
  }

  getRecent(program?: string, limit = 10): HandoffNote[] {
    const p = program ?? "";
    return (this.recentStmt.all(p, p, limit) as HandoffRow[]).map(rowToNote);
  }

  /** Get the most recent handoff note with file hashes for a project (for change detection). */
  getLatestHashes(projectPath: string, program?: string): HandoffNote | null {
    const p = program ?? "";
    const row = this.latestHashesStmt.get(projectPath, p, p) as HandoffRow | null;
    return row ? rowToNote(row) : null;
  }
}
