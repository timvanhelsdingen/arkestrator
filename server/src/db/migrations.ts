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
    role        TEXT NOT NULL DEFAULT 'bridge' CHECK(role IN ('bridge','client','admin','mcp')),
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
    scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','user','project')),
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('file_path','tool','prompt_filter','engine_model','command_filter','concurrent_limit','process_priority','token_budget','cost_budget')),
    pattern     TEXT NOT NULL,
    action      TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn')),
    description TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, type, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_policies_project ON policies(project_id)`,

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
    category    TEXT NOT NULL CHECK(category IN ('coordinator','bridge','training','playbook','verification','project','project-reference','housekeeping','custom')),
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

  // Prompt templates (chat presets, job presets, project templates)
  `CREATE TABLE IF NOT EXISTS prompt_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL CHECK(type IN ('chat','project','job_preset','path_mapping')),
    category    TEXT NOT NULL DEFAULT 'General',
    subcategory TEXT,
    description TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    icon        TEXT,
    options     TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 50,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_prompt_templates_type ON prompt_templates(type, enabled, category, sort_order)`,

  // Routing outcome learning — tracks which agent configs succeed for which task patterns
  `CREATE TABLE IF NOT EXISTS routing_outcomes (
    id               TEXT PRIMARY KEY,
    task_pattern     TEXT NOT NULL,
    agent_config_id  TEXT NOT NULL,
    engine           TEXT NOT NULL DEFAULT '',
    model            TEXT NOT NULL DEFAULT '',
    outcome          TEXT NOT NULL CHECK(outcome IN ('success','failure')),
    cost_usd         REAL NOT NULL DEFAULT 0,
    duration_ms      INTEGER NOT NULL DEFAULT 0,
    complexity_score INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_routing_pattern_config ON routing_outcomes(task_pattern, agent_config_id)`,
  `CREATE INDEX IF NOT EXISTS idx_routing_config_outcome ON routing_outcomes(agent_config_id, outcome)`,
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
  `ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`,
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
  // Soft-delete (trash) and archive timestamps for jobs
  `ALTER TABLE jobs ADD COLUMN archived_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN deleted_at TEXT`,
  // Job retry support: transient failures can be retried with exponential backoff
  `ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN retry_after TEXT`,
  // TTL for worker-targeted jobs: if the target worker never connects, the job
  // expires and is failed automatically instead of sitting in the queue forever.
  `ALTER TABLE jobs ADD COLUMN expires_at TEXT`,
  // Claude CLI session ID for pause/resume
  `ALTER TABLE jobs ADD COLUMN session_id TEXT`,
  // Skill versioning
  `ALTER TABLE skills ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
  // Skill effectiveness tracking
  `CREATE TABLE IF NOT EXISTS skill_versions (
    id         TEXT PRIMARY KEY,
    skill_id   TEXT NOT NULL,
    version    INTEGER NOT NULL,
    content    TEXT NOT NULL,
    keywords   TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(skill_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS skill_effectiveness (
    id         TEXT PRIMARY KEY,
    skill_id   TEXT NOT NULL,
    job_id     TEXT NOT NULL,
    job_outcome TEXT,
    created_at TEXT NOT NULL
  )`,
  // Knowledge graph: skills reference vault playbooks and link to related skills
  `ALTER TABLE skills ADD COLUMN playbooks TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE skills ADD COLUMN related_skills TEXT NOT NULL DEFAULT '[]'`,
  // Per-user chat personality preference
  `ALTER TABLE users ADD COLUMN chat_personality TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE users ADD COLUMN chat_personality_custom TEXT`,
  // Indexes on foreign key columns for query performance
  `CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_submitted_by ON jobs(submitted_by)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_outcome_marked_by ON jobs(outcome_marked_by)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_stats_agent_config ON usage_stats(agent_config_id)`,
  `CREATE INDEX IF NOT EXISTS idx_policies_user ON policies(user_id)`,
  // Indexes + FK-style cleanup for skill_versions and skill_effectiveness
  `CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_effectiveness_skill ON skill_effectiveness(skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_effectiveness_job ON skill_effectiveness(job_id)`,
  // Richer skill effectiveness ratings
  `ALTER TABLE skill_effectiveness ADD COLUMN rating_notes TEXT`,
  `ALTER TABLE skill_effectiveness ADD COLUMN relevance TEXT`,
  `ALTER TABLE skill_effectiveness ADD COLUMN accuracy TEXT`,
  `ALTER TABLE skill_effectiveness ADD COLUMN completeness TEXT`,
  // Performance indexes for hot-path queries at scale (v0.1.102+)
  `CREATE INDEX IF NOT EXISTS idx_jobs_deleted ON jobs(deleted_at, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL`,
  // Configurable per-turn timeout and reasoning mode for local-oss agent configs
  `ALTER TABLE agent_configs ADD COLUMN turn_timeout_ms INTEGER`,
  `ALTER TABLE agent_configs ADD COLUMN reasoning_mode TEXT CHECK(reasoning_mode IN ('disabled','plan-act','plan-act-evaluate'))`,
  // Lock skills from being edited by agents (humans can still edit via UI)
  `ALTER TABLE skills ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,
  // Handoff notes — inter-agent communication during execution
  `CREATE TABLE IF NOT EXISTS handoff_notes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    parent_job_id TEXT,
    program TEXT NOT NULL DEFAULT '',
    project_path TEXT,
    category TEXT NOT NULL DEFAULT 'progress' CHECK(category IN ('progress','blocker','done','warning')),
    content TEXT NOT NULL,
    file_hashes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_program ON handoff_notes(program)`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff_notes(project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_parent ON handoff_notes(parent_job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_created ON handoff_notes(created_at DESC)`,
  // Non-agentic task jobs: mode distinguishes agentic (AI agent) from task (direct execution)
  `ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'agentic' CHECK(mode IN ('agentic', 'task'))`,
  `ALTER TABLE jobs ADD COLUMN task_spec TEXT`,
  `ALTER TABLE jobs ADD COLUMN task_progress REAL`,
  `ALTER TABLE jobs ADD COLUMN task_status_text TEXT`,
  `ALTER TABLE jobs ADD COLUMN task_ref TEXT`,
  // Track which app version created/updated each skill for compatibility filtering
  `ALTER TABLE skills ADD COLUMN app_version TEXT`,
  `ALTER TABLE skill_versions ADD COLUMN app_version TEXT`,
  // User-requested skill slugs attached to a job (from /skill:slug in prompt)
  `ALTER TABLE jobs ADD COLUMN requested_skills TEXT`,
  // API Bridges — server-side handlers for external REST APIs (Meshy, Stability, etc.)
  // IMPORTANT: CREATE TABLE must come BEFORE the ALTER TABLE below. On a fresh
  // database, the ALTER would fail silently ("no such table") and then the CREATE
  // would produce a table without `mcp_config`, leaving ApiBridgesRepo unable to
  // prepare statements referencing that column on first boot. `mcp_config` is now
  // included in the CREATE so fresh DBs get the full schema immediately; the ALTER
  // below is kept for back-compat with databases created before this column existed.
  `CREATE TABLE IF NOT EXISTS api_bridges (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('preset','custom')),
    preset_id       TEXT,
    base_url        TEXT NOT NULL,
    auth_type       TEXT NOT NULL DEFAULT 'bearer' CHECK(auth_type IN ('bearer','header','query','none')),
    auth_header     TEXT NOT NULL DEFAULT 'Authorization',
    auth_prefix     TEXT NOT NULL DEFAULT 'Bearer ',
    api_key         TEXT,
    endpoints       TEXT NOT NULL DEFAULT '{}',
    default_options TEXT NOT NULL DEFAULT '{}',
    poll_config     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    mcp_config      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  // Back-compat: add mcp_config to api_bridges tables created before it existed in the CREATE.
  // Silently fails on fresh DBs (column already exists from the CREATE above) via the
  // COLUMN_ADDITIONS try/catch — that's expected and safe.
  `ALTER TABLE api_bridges ADD COLUMN mcp_config TEXT`,
  // Coordinator script versioning — snapshot history for rollback
  `CREATE TABLE IF NOT EXISTS coordinator_script_versions (
    id         TEXT PRIMARY KEY,
    program    TEXT NOT NULL,
    version    INTEGER NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(program, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coord_script_versions_program ON coordinator_script_versions(program)`,
  // Hash of original repo skill content — null for non-repo skills.
  // When source='repo' and hash(content) !== repo_content_hash, the skill is "modified".
  `ALTER TABLE skills ADD COLUMN repo_content_hash TEXT`,
  // Per-user session token for arkestrator.com community API calls.
  // Pushed from the client after GH OAuth login; forwarded as Bearer by MCP tools
  // (search_community_skills, install_community_skill) when calling upstream.
  `ALTER TABLE users ADD COLUMN community_session_token TEXT`,
  // Deduplicate any pre-existing duplicate usage rows so the UNIQUE index below
  // can be created successfully. Keeps the oldest row per (skill_id, job_id).
  `DELETE FROM skill_effectiveness
    WHERE id NOT IN (
      SELECT MIN(id) FROM skill_effectiveness
       GROUP BY skill_id, job_id
    )`,
  // Enforce at most one usage row per (skill_id, job_id). Before this, the
  // idempotency guarantee of recordUsageOnce depended on a racy
  // SELECT-then-INSERT; with this index, INSERT OR IGNORE is safe under
  // concurrent MCP calls.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_effectiveness_skill_job
     ON skill_effectiveness(skill_id, job_id)`,
  // Capture more metadata in the version snapshot so rollback actually
  // restores the full skill state (title, category, priority, autoFetch,
  // playbooks, related skills). Previously only content/keywords/description
  // were preserved and a rollback silently dropped the rest.
  `ALTER TABLE skill_versions ADD COLUMN title TEXT`,
  `ALTER TABLE skill_versions ADD COLUMN category TEXT`,
  `ALTER TABLE skill_versions ADD COLUMN priority INTEGER`,
  `ALTER TABLE skill_versions ADD COLUMN auto_fetch INTEGER`,
  `ALTER TABLE skill_versions ADD COLUMN playbooks TEXT`,
  `ALTER TABLE skill_versions ADD COLUMN related_skills TEXT`,
  // MCP preset scoping for tool-usage skills. When set, `program` must be
  // 'global' — a skill is either domain-scoped (program) or tool-scoped
  // (mcp_preset_id), never both. See skill-validator.ts for enforcement.
  `ALTER TABLE skills ADD COLUMN mcp_preset_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_skills_mcp_preset ON skills(mcp_preset_id) WHERE mcp_preset_id IS NOT NULL`,
  // Community skill prompt-injection defense (v0.1.108+).
  // - trust_tier: from arkestrator.com publisher-side trust scoring
  //   ('verified' | 'community' | 'pending_review' | 'quarantined').
  //   Local install refuses to persist 'pending_review' / 'quarantined'.
  //   For non-community sources this is null and treated as fully trusted.
  // - flagged: 1 if either the publisher-side or local heuristic scanner
  //   matched a suspicious pattern. Flagged skills get extra prompt-injection
  //   framing when their content surfaces in agent prompts.
  // - flagged_reasons: JSON array of pattern names that triggered the flag,
  //   surfaced in the client UI so users can see *why* a skill is flagged.
  // - author_login / author_verified / author_meta: snapshot of the GitHub
  //   identity that submitted the skill, used to inform user trust decisions
  //   in the client. author_meta is a JSON blob (account age, commits, etc.).
  `ALTER TABLE skills ADD COLUMN trust_tier TEXT`,
  `ALTER TABLE skills ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE skills ADD COLUMN flagged_reasons TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE skills ADD COLUMN author_login TEXT`,
  `ALTER TABLE skills ADD COLUMN author_verified INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE skills ADD COLUMN author_meta TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_skills_flagged ON skills(flagged) WHERE flagged = 1`,
  // community_id: the upstream arkestrator.com skill id for skills installed
  // from the community registry (source='community'). Needed server-side so
  // that rate_skill can push a 1-5 star rating upstream via
  // POST /api/skills/:communityId/rate — the client-side localStorage manifest
  // is not accessible from inside the MCP tool. Null for non-community skills.
  `ALTER TABLE skills ADD COLUMN community_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_skills_community_id ON skills(community_id) WHERE community_id IS NOT NULL`,
];

// Reset any jobs stuck in 'running' state (server crashed while they were active)
const STARTUP_RECOVERY = `UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`;

export function runMigrations(db: Database) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err: any) {
      // CREATE TABLE IF NOT EXISTS can still fail if FK target doesn't exist yet;
      // tables may already exist from a previous run — safe to continue.
      if (!String(err?.message).includes("already exists")) {
        console.warn(`[migrations] Non-fatal: ${err?.message}`);
      }
    }
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
  // or if project_id FK is missing ON DELETE SET NULL
  rebuildJobsTableIfNeeded(db);

  // Rebuild policies table if CHECK constraint is missing 'command_filter'
  rebuildPoliciesTableIfNeeded(db);

  // Rebuild api_keys table if CHECK constraint is missing 'mcp' role
  rebuildApiKeysTableIfNeeded(db);

  // Rebuild skills table if CHECK constraint is missing new categories
  rebuildSkillsTableIfNeeded(db);

  // Rebuild prompt_templates table if CHECK constraint is missing 'path_mapping'
  rebuildPromptTemplatesTableIfNeeded(db);

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
function rebuildApiKeysTableIfNeeded(db: Database) {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='api_keys'`,
  ).get() as { sql: string } | null;

  if (!tableInfo || tableInfo.sql.includes("'mcp'")) {
    return; // Already has mcp role or table doesn't exist
  }

  logger.info("migrations", "Migrating api_keys table to support 'mcp' role...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`CREATE TABLE api_keys_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      key_hash    TEXT NOT NULL UNIQUE,
      role        TEXT NOT NULL DEFAULT 'bridge' CHECK(role IN ('bridge','client','admin','mcp')),
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    )`);
    const oldCols = db.prepare(`PRAGMA table_info(api_keys)`).all() as { name: string }[];
    const newCols = db.prepare(`PRAGMA table_info(api_keys_new)`).all() as { name: string }[];
    const newColSet = new Set(newCols.map((c) => c.name));
    const commonCols = oldCols.map((c) => c.name).filter((n) => newColSet.has(n));
    const selectCols = commonCols.join(", ");
    db.exec(`INSERT INTO api_keys_new (${selectCols}) SELECT ${selectCols} FROM api_keys`);
    db.exec(`DROP TABLE api_keys`);
    db.exec(`ALTER TABLE api_keys_new RENAME TO api_keys`);
    db.exec("COMMIT");
    logger.info("migrations", "api_keys table migration complete.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildPoliciesTableIfNeeded(db: Database) {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='policies'`,
  ).get() as { sql: string } | null;

  // Check if the table needs migration: missing resource types or project scope
  const needsMigration = tableInfo && (
    !tableInfo.sql.includes("'command_filter'") ||
    !tableInfo.sql.includes("'concurrent_limit'") ||
    !tableInfo.sql.includes("'project'") ||
    !tableInfo.sql.includes("project_id")
  );

  if (!tableInfo || !needsMigration) {
    return; // Already up-to-date or table doesn't exist
  }

  logger.info("migrations", "Migrating policies table (project scope + resource types)...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`CREATE TABLE policies_new (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','user','project')),
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('file_path','tool','prompt_filter','engine_model','command_filter','concurrent_limit','process_priority','token_budget','cost_budget')),
      pattern     TEXT NOT NULL,
      action      TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn')),
      description TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`);
    const oldCols = db.prepare(`PRAGMA table_info(policies)`).all() as { name: string }[];
    const newCols = db.prepare(`PRAGMA table_info(policies_new)`).all() as { name: string }[];
    const newColSet = new Set(newCols.map((c) => c.name));
    const commonCols = oldCols.map((c) => c.name).filter((n) => newColSet.has(n));
    const selectCols = commonCols.join(", ");
    db.exec(`INSERT INTO policies_new (${selectCols}) SELECT ${selectCols} FROM policies`);
    db.exec(`DROP TABLE policies`);
    db.exec(`ALTER TABLE policies_new RENAME TO policies`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, type, enabled)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_project ON policies(project_id)`);
    db.exec("COMMIT");
    logger.info("migrations", "Policies table migration complete.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Rebuild skills table if CHECK constraint is missing new categories (project-reference, housekeeping). */
function rebuildSkillsTableIfNeeded(db: Database) {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'`,
  ).get() as { sql: string } | null;

  if (!tableInfo || tableInfo.sql.includes("'project-reference'")) {
    return; // Already has new categories or table doesn't exist
  }

  logger.info("migrations", "Migrating skills table to support 'project-reference' and 'housekeeping' categories...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    // CRITICAL: this skills_new schema must include EVERY column that
    // COLUMN_ADDITIONS adds, otherwise the commonCols intersection will
    // silently drop them during the rebuild and prepared statements that
    // reference them will fail later this same boot. When you add a new
    // skills column to COLUMN_ADDITIONS, mirror it here.
    db.exec(`CREATE TABLE skills_new (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      slug              TEXT NOT NULL,
      program           TEXT NOT NULL DEFAULT 'global',
      mcp_preset_id     TEXT,
      category          TEXT NOT NULL CHECK(category IN ('coordinator','bridge','training','playbook','verification','project','project-reference','housekeeping','custom')),
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      keywords          TEXT NOT NULL DEFAULT '[]',
      content           TEXT NOT NULL,
      playbooks         TEXT NOT NULL DEFAULT '[]',
      related_skills    TEXT NOT NULL DEFAULT '[]',
      source            TEXT NOT NULL DEFAULT 'user',
      source_path       TEXT,
      priority          INTEGER NOT NULL DEFAULT 50,
      auto_fetch        INTEGER NOT NULL DEFAULT 0,
      enabled           INTEGER NOT NULL DEFAULT 1,
      locked            INTEGER NOT NULL DEFAULT 0,
      version           INTEGER NOT NULL DEFAULT 1,
      app_version       TEXT,
      repo_content_hash TEXT,
      trust_tier        TEXT,
      flagged           INTEGER NOT NULL DEFAULT 0,
      flagged_reasons   TEXT NOT NULL DEFAULT '[]',
      author_login      TEXT,
      author_verified   INTEGER NOT NULL DEFAULT 0,
      author_meta       TEXT,
      community_id      TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(slug, program)
    )`);
    const oldCols = db.prepare(`PRAGMA table_info(skills)`).all() as { name: string }[];
    const newCols = db.prepare(`PRAGMA table_info(skills_new)`).all() as { name: string }[];
    const newColSet = new Set(newCols.map((c) => c.name));
    const commonCols = oldCols.map((c) => c.name).filter((n) => newColSet.has(n));
    const selectCols = commonCols.join(", ");
    db.exec(`INSERT INTO skills_new (${selectCols}) SELECT ${selectCols} FROM skills`);
    db.exec(`DROP TABLE skills`);
    db.exec(`ALTER TABLE skills_new RENAME TO skills`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_mcp_preset ON skills(mcp_preset_id) WHERE mcp_preset_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_flagged ON skills(flagged) WHERE flagged = 1`);
    db.exec("COMMIT");
    logger.info("migrations", "Skills table migration complete.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Rebuild prompt_templates table if the CHECK constraint on `type` is missing
 * 'path_mapping' (introduced after the original CREATE). Without this, seeding
 * default path mapping templates on first boot fails with a CHECK constraint
 * violation. */
function rebuildPromptTemplatesTableIfNeeded(db: Database) {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='prompt_templates'`,
  ).get() as { sql: string } | null;

  if (!tableInfo || tableInfo.sql.includes("'path_mapping'")) {
    return; // Already has path_mapping or table doesn't exist
  }

  logger.info("migrations", "Migrating prompt_templates table to support 'path_mapping' type...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`CREATE TABLE prompt_templates_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      type        TEXT NOT NULL CHECK(type IN ('chat','project','job_preset','path_mapping')),
      category    TEXT NOT NULL DEFAULT 'General',
      subcategory TEXT,
      description TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      icon        TEXT,
      options     TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 50,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`);
    const oldCols = db.prepare(`PRAGMA table_info(prompt_templates)`).all() as { name: string }[];
    const newCols = db.prepare(`PRAGMA table_info(prompt_templates_new)`).all() as { name: string }[];
    const newColSet = new Set(newCols.map((c) => c.name));
    const commonCols = oldCols.map((c) => c.name).filter((n) => newColSet.has(n));
    const selectCols = commonCols.join(", ");
    db.exec(`INSERT INTO prompt_templates_new (${selectCols}) SELECT ${selectCols} FROM prompt_templates`);
    db.exec(`DROP TABLE prompt_templates`);
    db.exec(`ALTER TABLE prompt_templates_new RENAME TO prompt_templates`);
    // Recreate the index that was attached to the old table
    db.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_templates_type ON prompt_templates(type, enabled, category, sort_order)`);
    db.exec("COMMIT");
    logger.info("migrations", "prompt_templates table migration complete.");
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

  // Check if project_id FK needs ON DELETE SET NULL (missing in older DBs)
  const needsProjectIdFkFix = tableInfo &&
    tableInfo.sql.includes("project_id") &&
    !tableInfo.sql.includes("projects(id) ON DELETE SET NULL");

  if (!tableInfo || (tableInfo.sql.includes("'paused'") && !needsProjectIdFkFix)) {
    return; // Already up to date or table doesn't exist
  }

  logger.info("migrations", "Migrating jobs table (status constraints / FK fixes)...");
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
      project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_job_id   TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      used_bridges    TEXT NOT NULL DEFAULT '[]'
    )`);
    // Copy only columns common to both tables (old DB may have extra/missing columns)
    const oldCols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
    const newCols = db.prepare(`PRAGMA table_info(jobs_new)`).all() as { name: string }[];
    const newColSet = new Set(newCols.map((c) => c.name));
    const commonCols = oldCols.map((c) => c.name).filter((n) => newColSet.has(n));
    const selectCols = commonCols.join(", ");
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
