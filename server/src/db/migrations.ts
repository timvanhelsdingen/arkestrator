import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

const MIGRATIONS = [
  // Agent configurations
  `CREATE TABLE IF NOT EXISTS agent_configs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    engine        TEXT NOT NULL CHECK(engine IN ('claude-code','codex','gemini','local-oss')),
    command       TEXT NOT NULL,
    args          TEXT NOT NULL DEFAULT '[]',
    model         TEXT,
    fallback_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
    max_turns     INTEGER NOT NULL DEFAULT 300,
    system_prompt TEXT,
    priority      INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,

  // Jobs
  `CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','paused','running','completed','failed','cancelled')),
    priority        TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
    coordination_mode TEXT NOT NULL DEFAULT 'server' CHECK(coordination_mode IN ('server','client')),
    prompt          TEXT NOT NULL,
    editor_context  TEXT,
    files           TEXT NOT NULL DEFAULT '[]',
    runtime_options TEXT,
    agent_config_id TEXT NOT NULL REFERENCES agent_configs(id),
    requested_agent_config_id TEXT,
    actual_agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
    actual_model TEXT,
    routing_reason TEXT CHECK(routing_reason IN ('local','cloud')),
    bridge_id       TEXT,
    result          TEXT,
    logs            TEXT,
    error           TEXT,
    outcome_rating  TEXT CHECK(outcome_rating IN ('positive','average','negative')),
    outcome_notes   TEXT,
    outcome_marked_at TEXT,
    outcome_marked_by TEXT,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    completed_at    TEXT
  )`,

  // Fast lookup for the scheduler
  `CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, priority, created_at)`,

  // API keys
  `CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL DEFAULT 'bridge' CHECK(role IN ('bridge','client','admin')),
    created_at  TEXT NOT NULL,
    revoked_at  TEXT
  )`,

  // Users
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user','viewer')),
    permissions   TEXT,
    require_2fa   INTEGER NOT NULL DEFAULT 0,
    client_coordination_enabled INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,

  // Sessions
  `CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,

  // Policies (block/ignore/warn rules)
  `CREATE TABLE IF NOT EXISTS policies (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','user')),
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('file_path','tool','prompt_filter','engine_model','command_filter')),
    pattern     TEXT NOT NULL,
    action      TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn')),
    description TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, type, enabled)`,

  // Audit log
  `CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    username    TEXT NOT NULL,
    action      TEXT NOT NULL,
    resource    TEXT NOT NULL,
    resource_id TEXT,
    details     TEXT,
    ip_address  TEXT,
    created_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC)`,

  // Usage stats (token tracking - table created now, populated later)
  `CREATE TABLE IF NOT EXISTS usage_stats (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  )`,

  // Projects (server-side project path mappings)
  `CREATE TABLE IF NOT EXISTS projects (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    bridge_path_pattern TEXT NOT NULL,
    source_type         TEXT NOT NULL CHECK(source_type IN ('local','git')),
    source_path         TEXT NOT NULL,
    git_branch          TEXT,
    git_auto_pull       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_projects_pattern ON projects(bridge_path_pattern)`,

  // Job dependencies
  `CREATE TABLE IF NOT EXISTS job_dependencies (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    depends_on_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    UNIQUE(job_id, depends_on_job_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_job_deps_job ON job_dependencies(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_deps_parent ON job_dependencies(depends_on_job_id)`,

  // Workers (persistent worker tracking)
  `CREATE TABLE IF NOT EXISTS workers (
    id                TEXT PRIMARY KEY,
    machine_id        TEXT,
    name              TEXT NOT NULL UNIQUE,
    last_program      TEXT,
    last_project_path TEXT,
    last_ip           TEXT,
    first_seen_at     TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL
  )`,

  // Worker bridge history (tracks all programs a worker has provided)
  `CREATE TABLE IF NOT EXISTS worker_bridges (
    id              TEXT PRIMARY KEY,
    worker_name     TEXT NOT NULL,
    worker_machine_id TEXT,
    program         TEXT NOT NULL,
    program_version TEXT,
    bridge_version  TEXT,
    project_path    TEXT,
    last_seen_at    TEXT NOT NULL,
    UNIQUE(worker_name, program)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_worker_bridges_worker ON worker_bridges(worker_name)`,
  `CREATE INDEX IF NOT EXISTS idx_workers_machine_id ON workers(machine_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_bridges_machine ON worker_bridges(worker_machine_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_bridges_machine_program
    ON worker_bridges(worker_machine_id, program)
    WHERE worker_machine_id IS NOT NULL`,

  // Server settings (key-value store for global config like 2FA enforcement)
  `CREATE TABLE IF NOT EXISTS server_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Headless programs (CLI fallback when no bridge connected)
  `CREATE TABLE IF NOT EXISTS headless_programs (
    id            TEXT PRIMARY KEY,
    program       TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    executable    TEXT NOT NULL,
    args_template TEXT NOT NULL DEFAULT '[]',
    language      TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS job_interventions (
    id               TEXT PRIMARY KEY,
    job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    author_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_username  TEXT,
    source           TEXT NOT NULL CHECK(source IN ('jobs','chat','mcp')),
    status           TEXT NOT NULL CHECK(status IN ('pending','delivered','superseded','rejected')),
    text             TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    delivered_at     TEXT,
    rejected_at      TEXT,
    status_reason    TEXT,
    delivery_metadata TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_job_interventions_job ON job_interventions(job_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_interventions_pending ON job_interventions(job_id, status, created_at)`,

  // Skills (coordinator scripts, playbooks, training records, custom user skills)
  `CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    program     TEXT NOT NULL DEFAULT 'global',
    category    TEXT NOT NULL CHECK(category IN ('coordinator','bridge','training','playbook','verification','project','custom')),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords    TEXT NOT NULL DEFAULT '[]',
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'user',
    source_path TEXT,
    priority    INTEGER NOT NULL DEFAULT 50,
    auto_fetch  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(slug, program)
  )`,
];

// Column additions for existing tables (safe to fail if column already exists)
const COLUMN_ADDITIONS = [
  `ALTER TABLE jobs ADD COLUMN submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE jobs ADD COLUMN workspace_mode TEXT CHECK(workspace_mode IN ('command','repo','sync'))`,
  `ALTER TABLE jobs ADD COLUMN commands TEXT`,
  `ALTER TABLE jobs ADD COLUMN bridge_program TEXT`,
  `ALTER TABLE jobs ADD COLUMN name TEXT`,
  `ALTER TABLE jobs ADD COLUMN worker_name TEXT`,
  `ALTER TABLE jobs ADD COLUMN target_worker_name TEXT`,
  `ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)`,
  `ALTER TABLE jobs ADD COLUMN context_items TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE projects ADD COLUMN system_prompt TEXT`,
  // 2FA columns
  `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN totp_verified_at TEXT`,
  `ALTER TABLE users ADD COLUMN recovery_codes TEXT`,
  `ALTER TABLE users ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0`,
  // Per-user token limits
  `ALTER TABLE users ADD COLUMN token_limit_input INTEGER`,
  `ALTER TABLE users ADD COLUMN token_limit_output INTEGER`,
  `ALTER TABLE users ADD COLUMN token_limit_period TEXT DEFAULT 'monthly'`,
  // Parent job tracking for sub-jobs spawned by MCP orchestrators
  `ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`,
  // Bridge programs used by the job (JSON array of program names e.g. ["godot","blender"])
  `ALTER TABLE jobs ADD COLUMN used_bridges TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE jobs ADD COLUMN coordination_mode TEXT NOT NULL DEFAULT 'server' CHECK(coordination_mode IN ('server','client'))`,
  `ALTER TABLE jobs ADD COLUMN runtime_options TEXT`,
  `ALTER TABLE users ADD COLUMN client_coordination_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN permissions TEXT`,
  `ALTER TABLE workers ADD COLUMN machine_id TEXT`,
  `ALTER TABLE worker_bridges ADD COLUMN worker_machine_id TEXT`,
  `ALTER TABLE agent_configs ADD COLUMN fallback_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL`,
  `ALTER TABLE jobs ADD COLUMN requested_agent_config_id TEXT`,
  `ALTER TABLE jobs ADD COLUMN actual_agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL`,
  `ALTER TABLE jobs ADD COLUMN actual_model TEXT`,
  `ALTER TABLE jobs ADD COLUMN routing_reason TEXT CHECK(routing_reason IN ('local','cloud'))`,
  `ALTER TABLE jobs ADD COLUMN outcome_rating TEXT CHECK(outcome_rating IN ('positive','average','negative'))`,
  `ALTER TABLE jobs ADD COLUMN outcome_notes TEXT`,
  `ALTER TABLE jobs ADD COLUMN outcome_marked_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN outcome_marked_by TEXT REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE usage_stats ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`,
  // Token tracking on jobs (denormalized from usage_stats for fast access)
  `ALTER TABLE jobs ADD COLUMN input_tokens INTEGER`,
  `ALTER TABLE jobs ADD COLUMN output_tokens INTEGER`,
  `ALTER TABLE jobs ADD COLUMN cost_usd REAL`,
  `ALTER TABLE jobs ADD COLUMN duration_ms INTEGER`,
  // Project prompt structured data columns
  `ALTER TABLE projects ADD COLUMN path_mappings TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE projects ADD COLUMN folders TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE projects ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE projects ADD COLUMN github_repos TEXT NOT NULL DEFAULT '[]'`,
  // local-oss model host: "server" or "client" (distributed to any LLM-enabled worker)
  `ALTER TABLE agent_configs ADD COLUMN local_model_host TEXT CHECK(local_model_host IN ('server', 'client'))`,
  // Per-model system prompt overrides (JSON map: { "model_name": "prompt text" })
  `ALTER TABLE agent_configs ADD COLUMN model_system_prompts TEXT`,
  // Structured per-model overrides (JSON map: { "model_name": { systemPrompt?, maxTurns? } })
  `ALTER TABLE agent_configs ADD COLUMN model_overrides TEXT`,
  // API key fine-grained permissions (JSON, same structure as user permissions)
  `ALTER TABLE api_keys ADD COLUMN permissions TEXT`,
];

// Reset any jobs stuck in 'running' state (server crashed while they were active)
const STARTUP_RECOVERY = `UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`;

export function runMigrations(db: Database) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  // Add columns to existing tables (ignore errors if column already exists)
  for (const sql of COLUMN_ADDITIONS) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  // Rebuild jobs table if CHECK constraint is missing 'paused' status
  rebuildJobsTableIfNeeded(db);

  // Rebuild policies table if CHECK constraint is missing 'command_filter'
  rebuildPoliciesTableIfNeeded(db);

  // Normalize existing worker names to lowercase (fixes case-sensitivity duplicates)
  normalizeWorkerNames(db);

  // Recover from crash
  const recovered = db.run(STARTUP_RECOVERY);
  if (recovered.changes > 0) {
    logger.info("migrations",
      `Recovered ${recovered.changes} job(s) from 'running' back to 'queued'`,
    );
  }
}

/** Rebuild policies table if CHECK constraint is missing 'command_filter'. */
function rebuildPoliciesTableIfNeeded(db: Database) {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='policies'`,
  ).get() as { sql: string } | null;

  if (!tableInfo || tableInfo.sql.includes("'command_filter'")) {
    return; // Already has command_filter or table doesn't exist
  }

  logger.info("migrations", "Migrating policies table to support 'command_filter' type...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`CREATE TABLE policies_new (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','user')),
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('file_path','tool','prompt_filter','engine_model','command_filter')),
      pattern     TEXT NOT NULL,
      action      TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn')),
      description TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`);
    const oldCols = db.prepare(`PRAGMA table_info(policies)`).all() as { name: string }[];
    const colNames = oldCols.map((c) => c.name);
    const selectCols = colNames.join(", ");
    db.exec(`INSERT INTO policies_new (${selectCols}) SELECT ${selectCols} FROM policies`);
    db.exec(`DROP TABLE policies`);
    db.exec(`ALTER TABLE policies_new RENAME TO policies`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, type, enabled)`);
    db.exec("COMMIT");
    logger.info("migrations", "Policies table migration complete.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Normalize all worker names to lowercase, merging duplicates by keeping the most recently seen. */
function normalizeWorkerNames(db: Database) {
  type WorkerRow = { id: string; name: string; last_seen_at: string };
  const all = db.prepare("SELECT id, name, last_seen_at FROM workers").all() as WorkerRow[];

  // Check if any work is needed
  const needsWork = all.some((w) => w.name !== w.name.toLowerCase());
  if (!needsWork) return;

  logger.info("migrations", "Normalizing worker names to lowercase...");

  // Group by lowercase name
  const byLower = new Map<string, WorkerRow[]>();
  for (const w of all) {
    const key = w.name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key)!.push(w);
  }

  // Clear worker_bridges — they'll be recreated on next bridge reconnect
  db.exec("DELETE FROM worker_bridges");

  let normalized = 0;
  for (const [lowerName, workers] of byLower) {
    if (workers.length === 1 && workers[0].name === lowerName) continue;

    // Sort: most recently seen first
    workers.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));

    // Delete duplicates (all but the first / most recent)
    for (const w of workers.slice(1)) {
      db.prepare("DELETE FROM workers WHERE id = ?").run(w.id);
    }

    // Rename the kept worker to lowercase if needed
    if (workers[0].name !== lowerName) {
      db.prepare("UPDATE workers SET name = ? WHERE id = ?").run(lowerName, workers[0].id);
    }
    normalized++;
  }

  logger.info("migrations", `Worker names normalized (${normalized} worker(s) updated)`);
}

/** SQLite doesn't support ALTER CHECK constraints, so rebuild the table if needed. */
function rebuildJobsTableIfNeeded(db: Database) {
  // Check if the current CHECK constraint includes 'paused'
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`,
  ).get() as { sql: string } | null;

  if (!tableInfo || tableInfo.sql.includes("'paused'")) {
    return; // Already has paused or table doesn't exist
  }

  logger.info("migrations", "Migrating jobs table to support 'paused' status...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`CREATE TABLE jobs_new (
      id              TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','paused','running','completed','failed','cancelled')),
      priority        TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
      coordination_mode TEXT NOT NULL DEFAULT 'server' CHECK(coordination_mode IN ('server','client')),
      prompt          TEXT NOT NULL,
      editor_context  TEXT,
      files           TEXT NOT NULL DEFAULT '[]',
      context_items   TEXT NOT NULL DEFAULT '[]',
      agent_config_id TEXT NOT NULL REFERENCES agent_configs(id),
      requested_agent_config_id TEXT,
      actual_agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
      actual_model TEXT,
      routing_reason TEXT CHECK(routing_reason IN ('local','cloud')),
      bridge_id       TEXT,
      result          TEXT,
      logs            TEXT,
      error           TEXT,
      outcome_rating  TEXT CHECK(outcome_rating IN ('positive','average','negative')),
      outcome_notes   TEXT,
      outcome_marked_at TEXT,
      outcome_marked_by TEXT,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      completed_at    TEXT,
      submitted_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
      workspace_mode  TEXT CHECK(workspace_mode IN ('command','repo','sync')),
      commands        TEXT,
      bridge_program  TEXT,
      name            TEXT,
      worker_name     TEXT,
      target_worker_name TEXT,
      project_id      TEXT REFERENCES projects(id),
      parent_job_id   TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      used_bridges    TEXT NOT NULL DEFAULT '[]'
    )`);
    // Copy existing columns (bridge_program may not exist yet in old table)
    const oldCols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
    const colNames = oldCols.map((c) => c.name);
    const selectCols = colNames.join(", ");
    db.exec(`INSERT INTO jobs_new (${selectCols}) SELECT ${selectCols} FROM jobs`);
    db.exec(`DROP TABLE jobs`);
    db.exec(`ALTER TABLE jobs_new RENAME TO jobs`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, priority, created_at)`);
    db.exec("COMMIT");
    logger.info("migrations","Jobs table migration complete.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
