import { Database } from "bun:sqlite";
import type { PolicyScope, PolicyType, PolicyAction } from "@arkestrator/protocol";
import { newId } from "../utils/id.js";

export interface Policy {
  id: string;
  scope: PolicyScope;
  userId: string | null;
  projectId: string | null;
  type: PolicyType;
  pattern: string;
  action: PolicyAction;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyInput {
  scope: PolicyScope;
  userId?: string;
  projectId?: string;
  type: PolicyType;
  pattern: string;
  action?: PolicyAction;
  description?: string;
}

interface PolicyRow {
  id: string;
  scope: string;
  user_id: string | null;
  project_id: string | null;
  type: string;
  pattern: string;
  action: string;
  description: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    scope: row.scope as PolicyScope,
    userId: row.user_id,
    projectId: row.project_id,
    type: row.type as PolicyType,
    pattern: row.pattern,
    action: row.action as PolicyAction,
    description: row.description,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PoliciesRepo {
  private insertStmt;
  private getByIdStmt;
  private listAllStmt;
  private listByTypeStmt;
  private listByScopeStmt;
  private listForUserStmt;
  private listForContextStmt;
  private updateStmt;
  private deleteStmt;
  private toggleStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO policies (id, scope, user_id, project_id, type, pattern, action, description, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM policies WHERE id = ?`);
    this.listAllStmt = db.prepare(
      `SELECT * FROM policies ORDER BY scope, type, created_at DESC`,
    );
    this.listByTypeStmt = db.prepare(
      `SELECT * FROM policies WHERE type = ? AND enabled = 1 ORDER BY scope, created_at DESC`,
    );
    this.listByScopeStmt = db.prepare(
      `SELECT * FROM policies WHERE scope = ? ORDER BY type, created_at DESC`,
    );
    this.listForUserStmt = db.prepare(
      `SELECT * FROM policies WHERE enabled = 1 AND (scope = 'global' OR user_id = ?) ORDER BY type, scope`,
    );
    this.listForContextStmt = db.prepare(
      `SELECT * FROM policies WHERE enabled = 1 AND (scope = 'global' OR user_id = ? OR project_id = ?) ORDER BY type, scope`,
    );
    this.updateStmt = db.prepare(
      `UPDATE policies SET scope=?, user_id=?, project_id=?, type=?, pattern=?, action=?, description=?, updated_at=? WHERE id=?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM policies WHERE id = ?`);
    this.toggleStmt = db.prepare(
      `UPDATE policies SET enabled = ?, updated_at = ? WHERE id = ?`,
    );
  }

  create(input: CreatePolicyInput): Policy {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      input.scope,
      input.userId ?? null,
      input.projectId ?? null,
      input.type,
      input.pattern,
      input.action ?? "block",
      input.description ?? null,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): Policy | null {
    const row = this.getByIdStmt.get(id) as PolicyRow | null;
    return row ? rowToPolicy(row) : null;
  }

  list(filters?: {
    type?: PolicyType;
    scope?: PolicyScope;
  }): Policy[] {
    if (filters?.type) {
      return (this.listByTypeStmt.all(filters.type) as PolicyRow[]).map(
        rowToPolicy,
      );
    }
    if (filters?.scope) {
      return (this.listByScopeStmt.all(filters.scope) as PolicyRow[]).map(
        rowToPolicy,
      );
    }
    return (this.listAllStmt.all() as PolicyRow[]).map(rowToPolicy);
  }

  /** Returns all enabled policies that apply to a user (global + user-specific) */
  getEffectiveForUser(userId: string | null): Policy[] {
    if (!userId) {
      // No user context — only global policies
      return (this.db.prepare(
        `SELECT * FROM policies WHERE enabled = 1 AND scope = 'global' ORDER BY type, created_at DESC`,
      ).all() as PolicyRow[]).map(rowToPolicy);
    }
    return (this.listForUserStmt.all(userId) as PolicyRow[]).map(rowToPolicy);
  }

  /** Returns all enabled policies for a full context: global + user + project */
  getEffectiveForContext(userId: string | null, projectId: string | null): Policy[] {
    if (!userId && !projectId) {
      return this.getEffectiveForUser(null);
    }
    if (!projectId) {
      return this.getEffectiveForUser(userId);
    }
    if (!userId) {
      // Global + project-scoped only
      return (this.db.prepare(
        `SELECT * FROM policies WHERE enabled = 1 AND (scope = 'global' OR project_id = ?) ORDER BY type, scope`,
      ).all(projectId) as PolicyRow[]).map(rowToPolicy);
    }
    return (this.listForContextStmt.all(userId, projectId) as PolicyRow[]).map(rowToPolicy);
  }

  update(
    id: string,
    changes: Partial<CreatePolicyInput>,
  ): Policy | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.updateStmt.run(
      changes.scope ?? existing.scope,
      changes.userId ?? existing.userId,
      changes.projectId ?? existing.projectId,
      changes.type ?? existing.type,
      changes.pattern ?? existing.pattern,
      changes.action ?? existing.action,
      changes.description ?? existing.description,
      now,
      id,
    );
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  toggle(id: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.toggleStmt.run(enabled ? 1 : 0, now, id);
    return result.changes > 0;
  }
}
