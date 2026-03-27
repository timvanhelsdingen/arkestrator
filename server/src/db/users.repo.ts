import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";
import {
  type UserPermissions,
  normalizeUserPermissions,
} from "../utils/user-permissions.js";
import { generateRandomHex } from "../utils/crypto.js";

export type UserRole = "admin" | "user" | "viewer";

export type TokenLimitPeriod = "daily" | "monthly" | "unlimited";

export type ChatPersonalityPreset = "default" | "professional" | "casual" | "mentor" | "pirate" | "custom";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  permissions: UserPermissions;
  require2fa: boolean;
  createdAt: string;
  updatedAt: string;
  totpEnabled: boolean;
  clientCoordinationEnabled: boolean;
  tokenLimitInput: number | null;
  tokenLimitOutput: number | null;
  tokenLimitPeriod: TokenLimitPeriod;
  chatPersonality: ChatPersonalityPreset;
  chatPersonalityCustom: string | null;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  permissions: string | null;
  require_2fa: number | null;
  client_coordination_enabled: number | null;
  created_at: string;
  updated_at: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_verified_at: string | null;
  recovery_codes: string | null;
  token_limit_input: number | null;
  token_limit_output: number | null;
  token_limit_period: string | null;
  chat_personality: string | null;
  chat_personality_custom: string | null;
}

function rowToUser(row: UserRow): User {
  const role = row.role as UserRole;
  let parsedPermissions: unknown = null;
  if (row.permissions) {
    try {
      parsedPermissions = JSON.parse(row.permissions);
    } catch {
      parsedPermissions = null;
    }
  }

  return {
    id: row.id,
    username: row.username,
    role,
    permissions: normalizeUserPermissions(role, parsedPermissions),
    require2fa: row.require_2fa === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totpEnabled: row.totp_enabled === 1,
    clientCoordinationEnabled: row.client_coordination_enabled === 1,
    tokenLimitInput: row.token_limit_input ?? null,
    tokenLimitOutput: row.token_limit_output ?? null,
    tokenLimitPeriod: (row.token_limit_period as TokenLimitPeriod) ?? "monthly",
    chatPersonality: (row.chat_personality as ChatPersonalityPreset) ?? "default",
    chatPersonalityCustom: row.chat_personality_custom ?? null,
  };
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export class UsersRepo {
  static readonly DEFAULT_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  private insertStmt;
  private getByIdStmt;
  private getByUsernameStmt;
  private listStmt;
  private updateRoleStmt;
  private updatePermissionsStmt;
  private updatePasswordStmt;
  private deleteStmt;
  private insertSessionStmt;
  private getSessionStmt;
  private refreshSessionStmt;
  private deleteSessionStmt;
  private deleteUserSessionsStmt;
  private cleanExpiredStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
    this.getByUsernameStmt = db.prepare(
      `SELECT * FROM users WHERE username = ?`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM users ORDER BY created_at DESC`,
    );
    this.updateRoleStmt = db.prepare(
      `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`,
    );
    this.updatePermissionsStmt = db.prepare(
      `UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?`,
    );
    this.updatePasswordStmt = db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM users WHERE id = ?`);
    this.insertSessionStmt = db.prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.getSessionStmt = db.prepare(
      `SELECT * FROM sessions WHERE token = ? AND expires_at > ?`,
    );
    this.refreshSessionStmt = db.prepare(
      `UPDATE sessions SET expires_at = ? WHERE token = ?`,
    );
    this.deleteSessionStmt = db.prepare(
      `DELETE FROM sessions WHERE token = ?`,
    );
    this.deleteUserSessionsStmt = db.prepare(
      `DELETE FROM sessions WHERE user_id = ?`,
    );
    this.cleanExpiredStmt = db.prepare(
      `DELETE FROM sessions WHERE expires_at <= ?`,
    );
  }

  async create(
    username: string,
    password: string,
    role: UserRole,
    permissions?: Partial<UserPermissions>,
  ): Promise<User> {
    const id = newId();
    const now = new Date().toISOString();
    const passwordHash = await Bun.password.hash(password);
    const resolvedPermissions = normalizeUserPermissions(role, permissions ?? null);
    this.insertStmt.run(
      id,
      username,
      passwordHash,
      role,
      JSON.stringify(resolvedPermissions),
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): User | null {
    const row = this.getByIdStmt.get(id) as UserRow | null;
    return row ? rowToUser(row) : null;
  }

  getByUsername(username: string): UserRow | null {
    return this.getByUsernameStmt.get(username) as UserRow | null;
  }

  list(): User[] {
    const rows = this.listStmt.all() as UserRow[];
    return rows.map(rowToUser);
  }

  updateRole(id: string, role: UserRole): boolean {
    const now = new Date().toISOString();
    const result = this.updateRoleStmt.run(role, now, id);
    return result.changes > 0;
  }

  setPermissions(id: string, permissions: Partial<UserPermissions>): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    const nextPermissions = normalizeUserPermissions(existing.role, {
      ...existing.permissions,
      ...permissions,
    });
    const now = new Date().toISOString();
    const result = this.updatePermissionsStmt.run(
      JSON.stringify(nextPermissions),
      now,
      id,
    );
    return result.changes > 0;
  }

  async updatePassword(id: string, password: string): Promise<boolean> {
    const now = new Date().toISOString();
    const passwordHash = await Bun.password.hash(password);
    const result = this.updatePasswordStmt.run(passwordHash, now, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    this.deleteUserSessionsStmt.run(id);
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  async verifyPassword(username: string, password: string): Promise<User | null> {
    const row = this.getByUsername(username);
    if (!row) return null;
    const valid = await Bun.password.verify(password, row.password_hash);
    return valid ? rowToUser(row) : null;
  }

  // --- Sessions ---

  createSession(
    userId: string,
    durationMs: number = UsersRepo.DEFAULT_SESSION_DURATION_MS,
  ): Session {
    const id = newId();
    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();
    this.insertSessionStmt.run(id, userId, token, expiresAt, now.toISOString());
    return { id, userId, token, expiresAt, createdAt: now.toISOString() };
  }

  validateSession(token: string): { session: Session; user: User } | null {
    const now = new Date().toISOString();
    const row = this.getSessionStmt.get(token, now) as SessionRow | null;
    if (!row) return null;
    const user = this.getById(row.user_id);
    if (!user) return null;
    return {
      session: {
        id: row.id,
        userId: row.user_id,
        token: row.token,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      },
      user,
    };
  }

  refreshSession(
    token: string,
    durationMs: number = UsersRepo.DEFAULT_SESSION_DURATION_MS,
  ): boolean {
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const result = this.refreshSessionStmt.run(expiresAt, token);
    return result.changes > 0;
  }

  deleteSession(token: string): boolean {
    const result = this.deleteSessionStmt.run(token);
    return result.changes > 0;
  }

  cleanExpiredSessions() {
    const now = new Date().toISOString();
    this.cleanExpiredStmt.run(now);
  }

  isEmpty(): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM users`)
      .get() as { count: number };
    return row.count === 0;
  }

  // --- Token Limits ---

  setTokenLimits(
    userId: string,
    inputLimit: number | null,
    outputLimit: number | null,
    period: TokenLimitPeriod,
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE users SET token_limit_input = ?, token_limit_output = ?, token_limit_period = ?, updated_at = ? WHERE id = ?`,
      )
      .run(inputLimit, outputLimit, period, now, userId);
    return result.changes > 0;
  }

  setClientCoordinationEnabled(userId: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE users SET client_coordination_enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, now, userId);
    return result.changes > 0;
  }

  setRequire2fa(userId: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE users SET require_2fa = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, now, userId);
    return result.changes > 0;
  }

  setChatPersonality(userId: string, personality: ChatPersonalityPreset, customPrompt?: string | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE users SET chat_personality = ?, chat_personality_custom = ?, updated_at = ? WHERE id = ?`,
      )
      .run(personality, customPrompt ?? null, now, userId);
    return result.changes > 0;
  }

  // --- TOTP 2FA ---

  setTotpSecret(userId: string, secret: string): void {
    this.db
      .prepare(`UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?`)
      .run(secret, new Date().toISOString(), userId);
  }

  getTotpSecret(userId: string): string | null {
    const row = this.db
      .prepare(`SELECT totp_secret FROM users WHERE id = ?`)
      .get(userId) as { totp_secret: string | null } | null;
    return row?.totp_secret ?? null;
  }

  enableTotp(userId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE users SET totp_enabled = 1, totp_verified_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, userId);
  }

  disableTotp(userId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_verified_at = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?`)
      .run(now, userId);
  }

  setRecoveryCodes(userId: string, hashedCodes: string[]): void {
    this.db
      .prepare(`UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(hashedCodes), new Date().toISOString(), userId);
  }

  getRecoveryCodes(userId: string): string[] {
    const row = this.db
      .prepare(`SELECT recovery_codes FROM users WHERE id = ?`)
      .get(userId) as { recovery_codes: string | null } | null;
    if (!row?.recovery_codes) return [];
    try {
      return JSON.parse(row.recovery_codes);
    } catch {
      return [];
    }
  }

  /** Consume a recovery code (remove it from the list). Returns true if the code was valid. */
  async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const codes = this.getRecoveryCodes(userId);
    for (let i = 0; i < codes.length; i++) {
      const valid = await Bun.password.verify(code, codes[i]);
      if (valid) {
        codes.splice(i, 1);
        this.setRecoveryCodes(userId, codes);
        return true;
      }
    }
    return false;
  }
}

function generateSessionToken(): string {
  return generateRandomHex(32);
}
