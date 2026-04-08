import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";
import type {
  ApiBridgeConfig,
  ApiBridgeConfigCreate,
  ApiBridgeConfigUpdate,
  ApiBridgePollConfig,
  ApiBridgeEndpoint,
} from "@arkestrator/protocol";

interface ApiBridgeRow {
  id: string;
  name: string;
  display_name: string;
  type: "preset" | "custom";
  preset_id: string | null;
  base_url: string;
  auth_type: string;
  auth_header: string;
  auth_prefix: string;
  api_key: string | null;
  endpoints: string;
  default_options: string;
  poll_config: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Convert a DB row to an ApiBridgeConfig (API key is NEVER included). */
function rowToConfig(row: ApiBridgeRow): ApiBridgeConfig {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    presetId: row.preset_id ?? undefined,
    baseUrl: row.base_url,
    authType: row.auth_type as ApiBridgeConfig["authType"],
    authHeader: row.auth_header,
    authPrefix: row.auth_prefix,
    endpoints: JSON.parse(row.endpoints) as Record<string, ApiBridgeEndpoint>,
    defaultOptions: JSON.parse(row.default_options) as Record<string, unknown>,
    pollConfig: row.poll_config ? (JSON.parse(row.poll_config) as ApiBridgePollConfig) : undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ApiBridgesRepo {
  private insertStmt;
  private getByIdStmt;
  private getByNameStmt;
  private listStmt;
  private listEnabledStmt;
  private deleteStmt;
  private getApiKeyStmt;
  private setApiKeyStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO api_bridges (id, name, display_name, type, preset_id, base_url,
        auth_type, auth_header, auth_prefix, api_key, endpoints, default_options,
        poll_config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM api_bridges WHERE id = ?`);
    this.getByNameStmt = db.prepare(`SELECT * FROM api_bridges WHERE name = ?`);
    this.listStmt = db.prepare(`SELECT * FROM api_bridges ORDER BY display_name`);
    this.listEnabledStmt = db.prepare(
      `SELECT * FROM api_bridges WHERE enabled = 1 ORDER BY display_name`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM api_bridges WHERE id = ?`);
    this.getApiKeyStmt = db.prepare(`SELECT api_key FROM api_bridges WHERE id = ?`);
    this.setApiKeyStmt = db.prepare(`UPDATE api_bridges SET api_key = ?, updated_at = ? WHERE id = ?`);
  }

  create(data: ApiBridgeConfigCreate, apiKey?: string): ApiBridgeConfig {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      data.name,
      data.displayName,
      data.type,
      data.presetId ?? null,
      data.baseUrl,
      data.authType ?? "bearer",
      data.authHeader ?? "Authorization",
      data.authPrefix ?? "Bearer ",
      apiKey ?? null,
      JSON.stringify(data.endpoints ?? {}),
      JSON.stringify(data.defaultOptions ?? {}),
      data.pollConfig ? JSON.stringify(data.pollConfig) : null,
      data.enabled !== false ? 1 : 0,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): ApiBridgeConfig | null {
    const row = this.getByIdStmt.get(id) as ApiBridgeRow | null;
    return row ? rowToConfig(row) : null;
  }

  getByName(name: string): ApiBridgeConfig | null {
    const row = this.getByNameStmt.get(name) as ApiBridgeRow | null;
    return row ? rowToConfig(row) : null;
  }

  list(): ApiBridgeConfig[] {
    return (this.listStmt.all() as ApiBridgeRow[]).map(rowToConfig);
  }

  listEnabled(): ApiBridgeConfig[] {
    return (this.listEnabledStmt.all() as ApiBridgeRow[]).map(rowToConfig);
  }

  update(id: string, data: ApiBridgeConfigUpdate): ApiBridgeConfig | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) { sets.push("name = ?"); values.push(data.name); }
    if (data.displayName !== undefined) { sets.push("display_name = ?"); values.push(data.displayName); }
    if (data.type !== undefined) { sets.push("type = ?"); values.push(data.type); }
    if (data.presetId !== undefined) { sets.push("preset_id = ?"); values.push(data.presetId); }
    if (data.baseUrl !== undefined) { sets.push("base_url = ?"); values.push(data.baseUrl); }
    if (data.authType !== undefined) { sets.push("auth_type = ?"); values.push(data.authType); }
    if (data.authHeader !== undefined) { sets.push("auth_header = ?"); values.push(data.authHeader); }
    if (data.authPrefix !== undefined) { sets.push("auth_prefix = ?"); values.push(data.authPrefix); }
    if (data.endpoints !== undefined) { sets.push("endpoints = ?"); values.push(JSON.stringify(data.endpoints)); }
    if (data.defaultOptions !== undefined) { sets.push("default_options = ?"); values.push(JSON.stringify(data.defaultOptions)); }
    if (data.pollConfig !== undefined) { sets.push("poll_config = ?"); values.push(JSON.stringify(data.pollConfig)); }
    if (data.enabled !== undefined) { sets.push("enabled = ?"); values.push(data.enabled ? 1 : 0); }

    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    values.push(now);
    values.push(id);

    this.db.prepare(`UPDATE api_bridges SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getById(id);
  }

  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0;
  }

  /** Get the raw API key for server-side use. Never expose in API responses. */
  getApiKey(id: string): string | null {
    const row = this.getApiKeyStmt.get(id) as { api_key: string | null } | null;
    return row?.api_key ?? null;
  }

  /** Update the API key for a bridge. */
  setApiKey(id: string, apiKey: string | null): void {
    this.setApiKeyStmt.run(apiKey, new Date().toISOString(), id);
  }

  /** Check if a bridge name is already taken. */
  nameExists(name: string, excludeId?: string): boolean {
    const existing = this.getByName(name);
    return !!existing && existing.id !== excludeId;
  }
}
