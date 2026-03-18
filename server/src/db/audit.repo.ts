import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface AuditEntry {
  id: string;
  userId: string | null;
  username: string;
  action: string;
  resource: string;
  resourceId: string | null;
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface LogAuditInput {
  userId: string | null;
  username: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: string;
  ipAddress?: string;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  username: string;
  action: string;
  resource: string;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    resource: row.resource,
    resourceId: row.resource_id,
    details: row.details,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  };
}

export class AuditRepo {
  private insertStmt;
  private listStmt;
  private listByUserStmt;
  private listByActionStmt;
  private countStmt;
  private countByUserStmt;
  private countByActionStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO audit_log (id, user_id, username, action, resource, resource_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.listByUserStmt = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.listByActionStmt = db.prepare(
      `SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.countStmt = db.prepare(`SELECT COUNT(*) as count FROM audit_log`);
    this.countByUserStmt = db.prepare(
      `SELECT COUNT(*) as count FROM audit_log WHERE user_id = ?`,
    );
    this.countByActionStmt = db.prepare(
      `SELECT COUNT(*) as count FROM audit_log WHERE action = ?`,
    );
  }

  /** Fire-and-forget audit log entry. Never throws. */
  log(input: LogAuditInput): void {
    try {
      const id = newId();
      const now = new Date().toISOString();
      this.insertStmt.run(
        id,
        input.userId,
        input.username,
        input.action,
        input.resource,
        input.resourceId ?? null,
        input.details ?? null,
        input.ipAddress ?? null,
        now,
      );
    } catch {
      // Audit failures should never crash the server
    }
  }

  list(opts: {
    limit?: number;
    offset?: number;
    userId?: string;
    action?: string;
  }): { entries: AuditEntry[]; total: number } {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    let rows: AuditRow[];
    let total: number;

    if (opts.userId) {
      rows = this.listByUserStmt.all(opts.userId, limit, offset) as AuditRow[];
      total = (this.countByUserStmt.get(opts.userId) as { count: number }).count;
    } else if (opts.action) {
      rows = this.listByActionStmt.all(opts.action, limit, offset) as AuditRow[];
      total = (this.countByActionStmt.get(opts.action) as { count: number }).count;
    } else {
      rows = this.listStmt.all(limit, offset) as AuditRow[];
      total = (this.countStmt.get() as { count: number }).count;
    }

    return {
      entries: rows.map(rowToEntry),
      total,
    };
  }
}
