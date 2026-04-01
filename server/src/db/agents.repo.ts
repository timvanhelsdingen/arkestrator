import { Database } from "bun:sqlite";
import type { AgentConfig, AgentConfigCreate } from "@arkestrator/protocol";
import { newId } from "../utils/id.js";

/**
 * Merge legacy modelSystemPrompts into modelOverrides at read time.
 * modelOverrides takes precedence — legacy entries only fill gaps.
 * This allows the spawner to use a single lookup path (modelOverrides only).
 */
function mergeModelSystemPromptsIntoOverrides(
  overrides?: Record<string, { systemPrompt?: string }>,
  legacyPrompts?: Record<string, string>,
): Record<string, { systemPrompt?: string }> | undefined {
  if (!legacyPrompts || Object.keys(legacyPrompts).length === 0) return overrides;
  const merged = { ...(overrides ?? {}) };
  for (const [model, prompt] of Object.entries(legacyPrompts)) {
    if (!merged[model]) {
      merged[model] = { systemPrompt: prompt };
    } else if (!merged[model].systemPrompt) {
      merged[model] = { ...merged[model], systemPrompt: prompt };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

interface AgentConfigRow {
  id: string;
  name: string;
  engine: string;
  command: string;
  args: string;
  model: string | null;
  fallback_config_id: string | null;
  max_turns: number;
  system_prompt: string | null;
  model_system_prompts: string | null;
  model_overrides: string | null;
  priority: number;
  local_model_host: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeArgs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function rowToConfig(row: AgentConfigRow): AgentConfig {
  let parsedArgs: unknown = [];
  try {
    parsedArgs = JSON.parse(row.args);
  } catch {
    // Legacy rows may contain non-JSON args; fall back to a plain split.
    parsedArgs = row.args;
  }

  return {
    id: row.id,
    name: row.name,
    engine: row.engine as AgentConfig["engine"],
    command: row.command,
    args: normalizeArgs(parsedArgs),
    model: row.model ?? undefined,
    fallbackConfigId: row.fallback_config_id ?? undefined,
    maxTurns: row.max_turns,
    systemPrompt: row.system_prompt ?? undefined,
    modelSystemPrompts: row.model_system_prompts ? JSON.parse(row.model_system_prompts) : undefined,
    modelOverrides: mergeModelSystemPromptsIntoOverrides(
      row.model_overrides ? JSON.parse(row.model_overrides) : undefined,
      row.model_system_prompts ? JSON.parse(row.model_system_prompts) : undefined,
    ),
    priority: row.priority,
    localModelHost: (row.local_model_host as AgentConfig["localModelHost"]) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentsRepo {
  private insertStmt;
  private getByIdStmt;
  private listStmt;
  private updateStmt;
  private deleteStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO agent_configs (id, name, engine, command, args, model, fallback_config_id, max_turns, system_prompt, model_system_prompts, model_overrides, priority, local_model_host, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(
      `SELECT * FROM agent_configs WHERE id = ?`,
    );
    this.listStmt = db.prepare(`SELECT * FROM agent_configs ORDER BY name`);
    this.updateStmt = db.prepare(
      `UPDATE agent_configs SET name=?, engine=?, command=?, args=?, model=?, fallback_config_id=?, max_turns=?, system_prompt=?, model_system_prompts=?, model_overrides=?, priority=?, local_model_host=?, updated_at=? WHERE id=?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM agent_configs WHERE id = ?`);
  }

  create(input: AgentConfigCreate): AgentConfig {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      input.name,
      input.engine,
      input.command,
      JSON.stringify(input.args),
      input.model ?? null,
      input.fallbackConfigId ?? null,
      input.maxTurns,
      input.systemPrompt ?? null,
      input.modelSystemPrompts ? JSON.stringify(input.modelSystemPrompts) : null,
      input.modelOverrides ? JSON.stringify(input.modelOverrides) : null,
      input.priority,
      input.localModelHost ?? null,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): AgentConfig | null {
    const row = this.getByIdStmt.get(id) as AgentConfigRow | null;
    return row ? rowToConfig(row) : null;
  }

  list(): AgentConfig[] {
    const rows = this.listStmt.all() as AgentConfigRow[];
    return rows.map(rowToConfig);
  }

  update(config: AgentConfig): AgentConfig | null {
    const now = new Date().toISOString();
    const result = this.updateStmt.run(
      config.name,
      config.engine,
      config.command,
      JSON.stringify(config.args),
      config.model ?? null,
      config.fallbackConfigId ?? null,
      config.maxTurns,
      config.systemPrompt ?? null,
      config.modelSystemPrompts ? JSON.stringify(config.modelSystemPrompts) : null,
      config.modelOverrides ? JSON.stringify(config.modelOverrides) : null,
      config.priority,
      config.localModelHost ?? null,
      now,
      config.id,
    );
    if (result.changes === 0) return null;
    return this.getById(config.id);
  }

  /**
   * Returns "ok" on success, "not_found" if no config matches, or "has_jobs" if
   * a foreign-key constraint prevents deletion (jobs still reference this config).
   */
  delete(id: string): "ok" | "not_found" | "has_jobs" {
    // Block only if there are actively queued/running jobs using this config
    const activeJobs = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM jobs WHERE agent_config_id = ? AND status IN ('queued', 'running')`,
    ).get(id) as { cnt: number } | undefined;
    if (activeJobs && activeJobs.cnt > 0) return "has_jobs";

    try {
      // Reassign terminal jobs to avoid FK constraint blocking deletion
      this.db.prepare(
        `UPDATE jobs SET actual_agent_config_id = COALESCE(actual_agent_config_id, agent_config_id), agent_config_id = (SELECT id FROM agent_configs WHERE id != ? LIMIT 1) WHERE agent_config_id = ? AND status NOT IN ('queued', 'running')`,
      ).run(id, id);

      const result = this.deleteStmt.run(id);
      return result.changes > 0 ? "ok" : "not_found";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) return "has_jobs";
      throw err;
    }
  }
}
