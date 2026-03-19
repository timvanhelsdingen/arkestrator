import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";
import { generateRandomHex } from "../utils/crypto.js";
import {
  normalizeApiKeyPermissions,
  type UserPermissions,
} from "../utils/user-permissions.js";

export type ApiKeyRole = "bridge" | "client" | "admin" | "mcp";

export interface ApiKey {
  id: string;
  name: string;
  role: ApiKeyRole;
  permissions: UserPermissions;
  createdAt: string;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  role: string;
  permissions: string | null;
  created_at: string;
  revoked_at: string | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  const role = row.role as ApiKeyRole;
  let rawPerms: unknown = null;
  if (row.permissions) {
    try { rawPerms = JSON.parse(row.permissions); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    name: row.name,
    role,
    permissions: normalizeApiKeyPermissions(role, rawPerms),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  return `ark_${generateRandomHex(24)}`;
}

export class ApiKeysRepo {
  private insertStmt;
  private listStmt;
  private getByHashStmt;
  private revokeStmt;
  private revokeByNamePrefixStmt;
  private updatePermissionsStmt;
  private getByIdStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO api_keys (id, name, key_hash, role, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    );
    this.getByHashStmt = db.prepare(
      `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    );
    this.revokeStmt = db.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    );
    this.revokeByNamePrefixStmt = db.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE name LIKE ? AND revoked_at IS NULL`,
    );
    this.updatePermissionsStmt = db.prepare(
      `UPDATE api_keys SET permissions = ? WHERE id = ? AND revoked_at IS NULL`,
    );
    this.getByIdStmt = db.prepare(
      `SELECT * FROM api_keys WHERE id = ?`,
    );
  }

  /** Creates a new API key. Returns the key info AND the raw key (shown once). */
  async create(
    name: string,
    role: ApiKeyRole,
    permissions?: Partial<UserPermissions>,
  ): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const id = newId();
    const rawKey = generateRawKey();
    const keyHash = await hashKey(rawKey);
    const now = new Date().toISOString();
    const permsJson = permissions ? JSON.stringify(permissions) : null;

    this.insertStmt.run(id, name, keyHash, role, permsJson, now);

    return {
      apiKey: {
        id,
        name,
        role,
        permissions: normalizeApiKeyPermissions(role, permissions ?? null),
        createdAt: now,
        revokedAt: null,
      },
      rawKey,
    };
  }

  getById(id: string): ApiKey | null {
    const row = this.getByIdStmt.get(id) as ApiKeyRow | null;
    return row ? rowToApiKey(row) : null;
  }

  updatePermissions(id: string, permissions: UserPermissions): boolean {
    const result = this.updatePermissionsStmt.run(JSON.stringify(permissions), id);
    return result.changes > 0;
  }

  list(): ApiKey[] {
    const rows = this.listStmt.all() as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /** Validates a raw API key. Returns the key info if valid, null if not. */
  async validate(rawKey: string): Promise<ApiKey | null> {
    const keyHash = await hashKey(rawKey);
    const row = this.getByHashStmt.get(keyHash) as ApiKeyRow | null;
    return row ? rowToApiKey(row) : null;
  }

  revoke(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.revokeStmt.run(now, id);
    return result.changes > 0;
  }

  /** Revoke all active keys whose name starts with the given prefix. */
  revokeByNamePrefix(prefix: string): number {
    const now = new Date().toISOString();
    const result = this.revokeByNamePrefixStmt.run(now, `${prefix}%`);
    return result.changes;
  }

  isEmpty(): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM api_keys`)
      .get() as { count: number };
    return row.count === 0;
  }
}
