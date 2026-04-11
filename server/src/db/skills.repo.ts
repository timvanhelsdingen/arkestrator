import type { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";
import { SERVER_VERSION } from "../utils/version.js";

/**
 * Author trust tier from the arkestrator.com publisher-side scoring.
 *
 * - `verified`: trusted author (account age, commit history, manual approval).
 *               Eligible for auto-injection if you ever choose to relax that.
 * - `community`: normal-looking community submitter. Default for non-flagged
 *                community skills. Treated as untrusted on the prompt side.
 * - `pending_review`: flagged for admin review on arkestrator.com. The local
 *                     install path REFUSES these — they should never reach
 *                     the local DB. Persisted only as a paranoia rail.
 * - `quarantined`: removed for safety. Same refusal behavior as pending_review.
 *
 * For non-community skills (builtin, repo, user, registry, bridge-repo, etc.)
 * this field is `null` and the skill is treated as fully trusted.
 */
export type SkillTrustTier = "verified" | "community" | "pending_review" | "quarantined";

/**
 * Snapshot of the GitHub author who submitted a community skill, captured
 * at install time. Used by the client to surface "submitted by @who, account
 * age N days, unverified" so users can make informed trust decisions.
 */
export interface SkillAuthorMeta {
  login?: string;
  githubId?: number;
  accountAgeDays?: number;
  publicRepos?: number;
  followers?: number;
  verified?: boolean;
}

/**
 * Skill record as stored in the DB.
 * Keywords are stored as a JSON array string and parsed on read.
 */
export interface Skill {
  id: string;
  name: string;
  slug: string;
  program: string;
  /**
   * Optional MCP preset scope for tool-usage skills. When set, the skill is
   * about how to effectively use that MCP server (query syntax, quirks,
   * rate limits) rather than about a DCC program's domain knowledge. Skills
   * with `mcpPresetId` set must have `program === 'global'` — the exactly-one
   * rule is enforced in `skill-validator.ts`.
   */
  mcpPresetId: string | null;
  category: string;
  title: string;
  description: string;
  keywords: string[];
  content: string;
  playbooks: string[];
  relatedSkills: string[];
  source: string;
  sourcePath: string | null;
  priority: number;
  autoFetch: boolean;
  enabled: boolean;
  locked: boolean;
  version: number;
  appVersion: string | null;
  repoContentHash: string | null;
  /** Publisher-side trust tier (community skills only). null for trusted sources. */
  trustTier: SkillTrustTier | null;
  /** True if either the publisher-side or local heuristic scanner flagged this skill. */
  flagged: boolean;
  /** Pattern names that triggered the flag, surfaced in the UI. */
  flaggedReasons: string[];
  /** GitHub login of the submitter (community skills only). */
  authorLogin: string | null;
  /** Whether the author has the `verified` badge on arkestrator.com. */
  authorVerified: boolean;
  /** Full author metadata snapshot at install time. */
  authorMeta: SkillAuthorMeta | null;
  /**
   * For community-sourced skills: the upstream arkestrator.com skill id,
   * used to push rate_skill outcomes back to the marketplace as 1-5 stars.
   * null for non-community skills and for community skills installed before
   * this column existed.
   */
  communityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  content: string;
  keywords: string[];
  description: string;
  title: string | null;
  category: string | null;
  priority: number | null;
  autoFetch: boolean | null;
  playbooks: string[];
  relatedSkills: string[];
  appVersion: string | null;
  createdAt: string;
}

/** Row shape coming out of SQLite (keywords as JSON string, booleans as 0/1). */
interface SkillRow {
  id: string;
  name: string;
  slug: string;
  program: string;
  mcp_preset_id: string | null;
  category: string;
  title: string;
  description: string;
  keywords: string;
  content: string;
  playbooks: string;
  related_skills: string;
  source: string;
  source_path: string | null;
  priority: number;
  auto_fetch: number;
  enabled: number;
  locked: number;
  version: number;
  app_version: string | null;
  repo_content_hash: string | null;
  trust_tier: string | null;
  flagged: number;
  flagged_reasons: string;
  author_login: string | null;
  author_verified: number;
  author_meta: string | null;
  community_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields accepted when creating a new skill. */
export interface CreateSkillInput {
  name: string;
  slug: string;
  program?: string;
  /** Optional MCP preset scope. Exactly-one rule: if set, program must be 'global'. */
  mcpPresetId?: string | null;
  category: string;
  title: string;
  description?: string;
  keywords?: string[];
  content: string;
  playbooks?: string[];
  relatedSkills?: string[];
  source?: string;
  sourcePath?: string | null;
  priority?: number;
  autoFetch?: boolean;
  enabled?: boolean;
  /** Seed version from SKILL.md frontmatter. Defaults to 1 (DB default). */
  version?: number;
  repoContentHash?: string | null;
  /** Publisher-side trust tier (community installs only). */
  trustTier?: SkillTrustTier | null;
  /** True if the heuristic scanner or publisher flagged this skill. */
  flagged?: boolean;
  /** Pattern names that triggered the flag. */
  flaggedReasons?: string[];
  /** Snapshot of the GitHub author at install time. */
  authorLogin?: string | null;
  authorVerified?: boolean;
  authorMeta?: SkillAuthorMeta | null;
  /** Upstream arkestrator.com skill id (community installs only). */
  communityId?: string | null;
}

/** Fields accepted when updating a skill. All optional. */
export interface UpdateSkillInput {
  name?: string;
  title?: string;
  description?: string;
  keywords?: string[];
  content?: string;
  playbooks?: string[];
  relatedSkills?: string[];
  source?: string;
  sourcePath?: string | null;
  priority?: number;
  autoFetch?: boolean;
  enabled?: boolean;
  locked?: boolean;
  /** Set to null to clear, a string to set, or omit to leave unchanged. */
  mcpPresetId?: string | null;
}

function parseJsonArray(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function parseAuthorMeta(raw: string | null | undefined): SkillAuthorMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as SkillAuthorMeta;
    return null;
  } catch { return null; }
}

function isValidTrustTier(raw: string | null | undefined): SkillTrustTier | null {
  if (raw === "verified" || raw === "community" || raw === "pending_review" || raw === "quarantined") {
    return raw;
  }
  return null;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    program: row.program,
    mcpPresetId: row.mcp_preset_id ?? null,
    category: row.category,
    title: row.title,
    description: row.description,
    keywords: parseJsonArray(row.keywords),
    content: row.content,
    playbooks: parseJsonArray(row.playbooks),
    relatedSkills: parseJsonArray(row.related_skills),
    source: row.source,
    sourcePath: row.source_path,
    priority: row.priority,
    autoFetch: row.auto_fetch === 1,
    enabled: row.enabled === 1,
    locked: row.locked === 1,
    version: row.version ?? 1,
    appVersion: row.app_version ?? null,
    repoContentHash: row.repo_content_hash ?? null,
    trustTier: isValidTrustTier(row.trust_tier),
    flagged: row.flagged === 1,
    flaggedReasons: parseJsonArray(row.flagged_reasons),
    authorLogin: row.author_login ?? null,
    authorVerified: row.author_verified === 1,
    authorMeta: parseAuthorMeta(row.author_meta),
    communityId: row.community_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for skills stored in SQLite.
 * Supports all source types: builtin, coordinator, playbook, training, user, registry.
 */
export class SkillsRepo {
  private listUserStmt;
  private listAllStmt;
  private listAllEnabledStmt;
  private getBySlugStmt;
  private getBySlugAndProgramStmt;
  private getAnyBySlugAndProgramStmt;
  private insertStmt;
  private upsertStmt;
  private deleteBySlugStmt;
  private deleteBySlugAndProgramStmt;
  private deleteAnyBySlugAndProgramStmt;

  constructor(private db: Database) {
    this.listUserStmt = db.prepare(
      "SELECT * FROM skills WHERE source IN ('user', 'registry') ORDER BY priority DESC, title ASC",
    );
    this.listAllStmt = db.prepare(
      "SELECT * FROM skills ORDER BY priority DESC, title ASC",
    );
    this.listAllEnabledStmt = db.prepare(
      "SELECT * FROM skills WHERE enabled = 1 ORDER BY priority DESC, title ASC",
    );
    this.getBySlugStmt = db.prepare(
      "SELECT * FROM skills WHERE slug = ? LIMIT 1",
    );
    this.getBySlugAndProgramStmt = db.prepare(
      "SELECT * FROM skills WHERE slug = ? AND program = ? LIMIT 1",
    );
    this.getAnyBySlugAndProgramStmt = db.prepare(
      "SELECT * FROM skills WHERE slug = ? AND program = ? LIMIT 1",
    );
    this.insertStmt = db.prepare(`
      INSERT INTO skills (id, name, slug, program, mcp_preset_id, category, title, description, keywords, content, playbooks, related_skills, source, source_path, priority, auto_fetch, enabled, version, app_version, repo_content_hash, trust_tier, flagged, flagged_reasons, author_login, author_verified, author_meta, community_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO skills (id, name, slug, program, mcp_preset_id, category, title, description, keywords, content, playbooks, related_skills, source, source_path, priority, auto_fetch, enabled, version, app_version, repo_content_hash, trust_tier, flagged, flagged_reasons, author_login, author_verified, author_meta, community_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, program) DO UPDATE SET
        name = excluded.name, mcp_preset_id = excluded.mcp_preset_id,
        category = excluded.category, title = excluded.title,
        description = excluded.description, keywords = excluded.keywords, content = excluded.content,
        playbooks = excluded.playbooks, related_skills = excluded.related_skills,
        source = excluded.source, source_path = excluded.source_path, priority = excluded.priority,
        auto_fetch = excluded.auto_fetch, enabled = excluded.enabled, app_version = excluded.app_version,
        repo_content_hash = COALESCE(excluded.repo_content_hash, repo_content_hash),
        trust_tier = COALESCE(excluded.trust_tier, trust_tier),
        flagged = excluded.flagged,
        flagged_reasons = excluded.flagged_reasons,
        author_login = COALESCE(excluded.author_login, author_login),
        author_verified = excluded.author_verified,
        author_meta = COALESCE(excluded.author_meta, author_meta),
        community_id = COALESCE(excluded.community_id, community_id),
        updated_at = excluded.updated_at
    `);
    this.deleteBySlugStmt = db.prepare("DELETE FROM skills WHERE slug = ?");
    this.deleteBySlugAndProgramStmt = db.prepare(
      "DELETE FROM skills WHERE slug = ? AND program = ?",
    );
    this.deleteAnyBySlugAndProgramStmt = db.prepare(
      "DELETE FROM skills WHERE slug = ? AND program = ?",
    );
  }

  // ── User/Registry skills (backward compat) ──────────────────────────

  /** List user/registry skills, optionally filtered. */
  list(opts?: { program?: string; category?: string }): Skill[] {
    if (opts?.program || opts?.category) {
      const conditions = ["source IN ('user', 'registry')"];
      const params: string[] = [];
      if (opts.program) { conditions.push("program = ?"); params.push(opts.program); }
      if (opts.category) { conditions.push("category = ?"); params.push(opts.category); }
      const rows = this.db.prepare(
        `SELECT * FROM skills WHERE ${conditions.join(" AND ")} ORDER BY priority DESC, title ASC`,
      ).all(...params) as SkillRow[];
      return rows.map(rowToSkill);
    }
    return (this.listUserStmt.all() as SkillRow[]).map(rowToSkill);
  }

  /** Get a single skill by slug (any source). */
  get(slug: string, program?: string): Skill | null {
    const row = program
      ? (this.getBySlugAndProgramStmt.get(slug, program) as SkillRow | null)
      : (this.getBySlugStmt.get(slug) as SkillRow | null);
    return row ? rowToSkill(row) : null;
  }

  /** Create a new skill. Returns the created skill. */
  create(input: CreateSkillInput, source?: string): Skill {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // Exactly-one rule: MCP-scoped skills must live under program='global'.
    const program = input.mcpPresetId ? "global" : (input.program ?? "global");
    const src = source ?? input.source ?? "user";

    this.insertStmt.run(
      id, input.name, input.slug, program, input.mcpPresetId ?? null, input.category, input.title,
      input.description ?? "", JSON.stringify(input.keywords ?? []), input.content,
      JSON.stringify(input.playbooks ?? []), JSON.stringify(input.relatedSkills ?? []),
      src, input.sourcePath ?? null, input.priority ?? 50,
      (input.autoFetch ?? false) ? 1 : 0, (input.enabled ?? true) ? 1 : 0,
      input.version ?? 1, SERVER_VERSION, input.repoContentHash ?? null,
      input.trustTier ?? null,
      (input.flagged ?? false) ? 1 : 0,
      JSON.stringify(input.flaggedReasons ?? []),
      input.authorLogin ?? null,
      (input.authorVerified ?? false) ? 1 : 0,
      input.authorMeta ? JSON.stringify(input.authorMeta) : null,
      input.communityId ?? null,
      now, now,
    );
    return this.get(input.slug, program)!;
  }

  /** Update a skill by id. Snapshots the current version before updating. Returns updated skill or null. */
  update(slug: string, updates: UpdateSkillInput, program?: string): Skill | null {
    const existing = this.get(slug, program);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
    if (updates.title !== undefined) { sets.push("title = ?"); values.push(updates.title); }
    if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
    if (updates.keywords !== undefined) { sets.push("keywords = ?"); values.push(JSON.stringify(updates.keywords)); }
    if (updates.content !== undefined) { sets.push("content = ?"); values.push(updates.content); }
    if (updates.playbooks !== undefined) { sets.push("playbooks = ?"); values.push(JSON.stringify(updates.playbooks)); }
    if (updates.relatedSkills !== undefined) { sets.push("related_skills = ?"); values.push(JSON.stringify(updates.relatedSkills)); }
    if (updates.source !== undefined) { sets.push("source = ?"); values.push(updates.source); }
    if (updates.sourcePath !== undefined) { sets.push("source_path = ?"); values.push(updates.sourcePath); }
    if (updates.priority !== undefined) { sets.push("priority = ?"); values.push(updates.priority); }
    if (updates.autoFetch !== undefined) { sets.push("auto_fetch = ?"); values.push(updates.autoFetch ? 1 : 0); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
    if (updates.locked !== undefined) { sets.push("locked = ?"); values.push(updates.locked ? 1 : 0); }
    if (updates.mcpPresetId !== undefined) { sets.push("mcp_preset_id = ?"); values.push(updates.mcpPresetId); }

    if (sets.length === 0) return existing;

    // Snapshot the current version before updating (for rollback support).
    // Snapshot on any meaningful field change — previously only
    // content/keywords/description were tracked, so rolling back could
    // silently drop a title rename or a category re-classification.
    const contentChanged = updates.content !== undefined && updates.content !== existing.content;
    const keywordsChanged = updates.keywords !== undefined;
    const descriptionChanged = updates.description !== undefined && updates.description !== existing.description;
    const titleChanged = updates.title !== undefined && updates.title !== existing.title;
    const priorityChanged = updates.priority !== undefined && updates.priority !== existing.priority;
    const autoFetchChanged = updates.autoFetch !== undefined && updates.autoFetch !== existing.autoFetch;
    const playbooksChanged = updates.playbooks !== undefined;
    const relatedSkillsChanged = updates.relatedSkills !== undefined;
    if (
      contentChanged ||
      keywordsChanged ||
      descriptionChanged ||
      titleChanged ||
      priorityChanged ||
      autoFetchChanged ||
      playbooksChanged ||
      relatedSkillsChanged
    ) {
      try {
        this.db.prepare(
          `INSERT OR IGNORE INTO skill_versions
             (id, skill_id, version, content, keywords, description,
              title, category, priority, auto_fetch, playbooks, related_skills,
              app_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId(),
          existing.id,
          existing.version,
          existing.content,
          JSON.stringify(existing.keywords),
          existing.description,
          existing.title,
          existing.category,
          existing.priority,
          existing.autoFetch ? 1 : 0,
          JSON.stringify(existing.playbooks ?? []),
          JSON.stringify(existing.relatedSkills ?? []),
          existing.appVersion,
          new Date().toISOString(),
        );
        // Increment version and stamp current app version
        sets.push("version = version + 1");
        sets.push("app_version = ?"); values.push(SERVER_VERSION);
      } catch {
        // skill_versions table may not exist on older DBs — proceed without snapshotting
      }
    }

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(existing.id);

    this.db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...(values as import("bun:sqlite").SQLQueryBindings[]));
    return this.get(slug, program ?? existing.program);
  }

  /**
   * Cascade-delete dependent rows (version history + effectiveness stats)
   * for a skill id. There are no real FK constraints on these tables so
   * we have to do this manually, otherwise a deleted skill leaves
   * orphaned rows that inflate listVersions / getStats queries the next
   * time a skill with the same id ever gets generated.
   */
  private cascadeDeleteSkillChildren(skillId: string): void {
    try {
      this.db.prepare("DELETE FROM skill_versions WHERE skill_id = ?").run(skillId);
    } catch { /* table may not exist on old DBs */ }
    try {
      this.db.prepare("DELETE FROM skill_effectiveness WHERE skill_id = ?").run(skillId);
    } catch { /* table may not exist on old DBs */ }
  }

  /** Delete a skill by slug. */
  delete(slug: string, program?: string): boolean {
    const existing = this.get(slug, program);
    const result = program
      ? this.deleteBySlugAndProgramStmt.run(slug, program)
      : this.deleteBySlugStmt.run(slug);
    if (result.changes > 0 && existing) {
      this.cascadeDeleteSkillChildren(existing.id);
    }
    return result.changes > 0;
  }

  // ── All-source methods ──────────────────────────────────────────────

  /** List ALL skills (any source), with optional filters. */
  listAll(opts?: { enabled?: boolean; category?: string; program?: string; source?: string }): Skill[] {
    if (!opts || Object.keys(opts).length === 0) {
      return (this.listAllStmt.all() as SkillRow[]).map(rowToSkill);
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.enabled !== undefined) { conditions.push("enabled = ?"); params.push(opts.enabled ? 1 : 0); }
    if (opts.category) { conditions.push("category = ?"); params.push(opts.category); }
    if (opts.program) { conditions.push("program = ?"); params.push(opts.program); }
    if (opts.source) { conditions.push("source = ?"); params.push(opts.source); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM skills ${where} ORDER BY priority DESC, title ASC`).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as SkillRow[]).map(rowToSkill);
  }

  /** Get any skill by slug+program regardless of source. */
  getAny(slug: string, program: string): Skill | null {
    const row = this.getAnyBySlugAndProgramStmt.get(slug, program) as SkillRow | null;
    return row ? rowToSkill(row) : null;
  }

  /** Upsert a skill by (slug, program). Creates if not exists, updates if exists. */
  upsertBySlugAndProgram(input: CreateSkillInput): Skill {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // Exactly-one rule: MCP-scoped skills must live under program='global'.
    const program = input.mcpPresetId ? "global" : (input.program ?? "global");

    this.upsertStmt.run(
      id, input.name ?? input.slug, input.slug, program, input.mcpPresetId ?? null, input.category, input.title,
      input.description ?? "", JSON.stringify(input.keywords ?? []), input.content,
      JSON.stringify(input.playbooks ?? []), JSON.stringify(input.relatedSkills ?? []),
      input.source ?? "user", input.sourcePath ?? null, input.priority ?? 50,
      (input.autoFetch ?? false) ? 1 : 0, (input.enabled ?? true) ? 1 : 0,
      input.version ?? 1, SERVER_VERSION, input.repoContentHash ?? null,
      input.trustTier ?? null,
      (input.flagged ?? false) ? 1 : 0,
      JSON.stringify(input.flaggedReasons ?? []),
      input.authorLogin ?? null,
      (input.authorVerified ?? false) ? 1 : 0,
      input.authorMeta ? JSON.stringify(input.authorMeta) : null,
      input.communityId ?? null,
      now, now,
    );
    return this.get(input.slug, program)!;
  }

  /**
   * Upsert a repo-sourced skill (bridge-repo, registry, etc.). Only updates
   * content if the user hasn't modified it (detected by comparing current
   * content hash against stored repo_content_hash). Always updates metadata
   * (title, description, keywords, priority, etc.) and preserves the
   * caller-supplied `source` tag rather than forcing `"repo"` — so bridge
   * pulls stay tagged `bridge-repo` and aren't reclassified on re-pull.
   */
  upsertRepoSkill(input: CreateSkillInput & { repoContentHash: string }): Skill {
    const program = input.program ?? "global";
    const existing = this.getAny?.(input.slug, program) ?? this.get(input.slug, program);
    const source = input.source ?? "repo";

    if (!existing) {
      return this.upsertBySlugAndProgram({ ...input, source });
    }

    // Never clobber locked skills, even metadata-only.
    if (existing.locked) return existing;

    // Existing skill — check if user modified the content
    const contentHash = Bun.hash(existing.content).toString(16);
    const isModified = existing.repoContentHash != null && contentHash !== existing.repoContentHash;

    if (isModified) {
      // User modified content — update metadata only, keep their content, update the repo hash
      // so we know what the latest repo version is
      this.db.prepare(`
        UPDATE skills SET
          name = ?, category = ?, title = ?, description = ?, keywords = ?,
          source = ?, priority = ?, auto_fetch = ?, enabled = ?,
          repo_content_hash = ?, app_version = ?, updated_at = ?
        WHERE slug = ? AND program = ?
      `).run(
        input.name ?? input.slug, input.category, input.title,
        input.description ?? "", JSON.stringify(input.keywords ?? []),
        source, input.priority ?? 50, (input.autoFetch ?? false) ? 1 : 0,
        (input.enabled ?? true) ? 1 : 0,
        input.repoContentHash, SERVER_VERSION, new Date().toISOString(),
        input.slug, program,
      );
    } else {
      // Not modified — safe to overwrite everything
      this.upsertBySlugAndProgram({ ...input, source });
    }

    return this.get(input.slug, program)!;
  }

  /** Delete any skill regardless of source. */
  deleteAny(slug: string, program: string): boolean {
    const existing = this.getAny(slug, program);
    const changes = this.deleteAnyBySlugAndProgramStmt.run(slug, program).changes;
    if (changes > 0 && existing) {
      this.cascadeDeleteSkillChildren(existing.id);
    }
    return changes > 0;
  }

  /** List skills by source. */
  listBySource(source: string): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE source = ? ORDER BY priority DESC, title ASC").all(source) as SkillRow[]).map(rowToSkill);
  }

  /** Delete all skills with a given source. */
  deleteBySource(source: string, program?: string): number {
    // Look up the affected rows first so we can cascade-clean children.
    const targets = program
      ? (this.db.prepare("SELECT id FROM skills WHERE source = ? AND program = ?").all(source, program) as Array<{ id: string }>)
      : (this.db.prepare("SELECT id FROM skills WHERE source = ?").all(source) as Array<{ id: string }>);
    const changes = program
      ? this.db.prepare("DELETE FROM skills WHERE source = ? AND program = ?").run(source, program).changes
      : this.db.prepare("DELETE FROM skills WHERE source = ?").run(source).changes;
    for (const row of targets) this.cascadeDeleteSkillChildren(row.id);
    return changes;
  }

  // ── Versioning ──────────────────────────────────────────────────────

  /** List version history for a skill (newest first). */
  listVersions(skillId: string): SkillVersion[] {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC",
      ).all(skillId) as Array<{
        id: string;
        skill_id: string;
        version: number;
        content: string;
        keywords: string;
        description: string;
        title: string | null;
        category: string | null;
        priority: number | null;
        auto_fetch: number | null;
        playbooks: string | null;
        related_skills: string | null;
        app_version: string | null;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        skillId: row.skill_id,
        version: row.version,
        content: row.content,
        keywords: (() => { try { return JSON.parse(row.keywords); } catch { return []; } })(),
        description: row.description,
        title: row.title ?? null,
        category: row.category ?? null,
        priority: row.priority ?? null,
        autoFetch: row.auto_fetch == null ? null : row.auto_fetch === 1,
        playbooks: (() => { try { return row.playbooks ? JSON.parse(row.playbooks) : []; } catch { return []; } })(),
        relatedSkills: (() => { try { return row.related_skills ? JSON.parse(row.related_skills) : []; } catch { return []; } })(),
        appVersion: row.app_version ?? null,
        createdAt: row.created_at,
      }));
    } catch {
      return []; // skill_versions table may not exist
    }
  }

  /**
   * Rollback a skill to a previous version. Returns the restored skill or null.
   * Restores every field that the version row captured — including title,
   * category, priority, autoFetch, playbooks, relatedSkills — so the
   * rollback is lossless for skills snapshotted after the full-field
   * schema landed. Skills with only the legacy columns will still restore
   * content/keywords/description correctly.
   */
  rollback(skillId: string, version: number): Skill | null {
    try {
      const versionRow = this.db.prepare(
        "SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?",
      ).get(skillId, version) as {
        content: string;
        keywords: string;
        description: string;
        title: string | null;
        category: string | null;
        priority: number | null;
        auto_fetch: number | null;
        playbooks: string | null;
        related_skills: string | null;
      } | null;
      if (!versionRow) return null;

      const now = new Date().toISOString();
      // Snapshot current state before rollback so the user can undo it.
      const current = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(skillId) as SkillRow | null;
      if (!current) return null;

      this.db.prepare(
        `INSERT OR IGNORE INTO skill_versions
           (id, skill_id, version, content, keywords, description,
            title, category, priority, auto_fetch, playbooks, related_skills,
            app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        skillId,
        current.version,
        current.content,
        current.keywords,
        current.description,
        current.title,
        current.category,
        current.priority,
        current.auto_fetch,
        current.playbooks,
        current.related_skills,
        current.app_version,
        now,
      );

      // Build the UPDATE dynamically so legacy version rows (without the new
      // columns) still restore the fields they did capture.
      const sets: string[] = [
        "content = ?",
        "keywords = ?",
        "description = ?",
        "version = version + 1",
        "app_version = ?",
        "updated_at = ?",
      ];
      const params: unknown[] = [
        versionRow.content,
        versionRow.keywords,
        versionRow.description,
        SERVER_VERSION,
        now,
      ];
      if (versionRow.title != null) { sets.push("title = ?"); params.push(versionRow.title); }
      if (versionRow.category != null) { sets.push("category = ?"); params.push(versionRow.category); }
      if (versionRow.priority != null) { sets.push("priority = ?"); params.push(versionRow.priority); }
      if (versionRow.auto_fetch != null) { sets.push("auto_fetch = ?"); params.push(versionRow.auto_fetch); }
      if (versionRow.playbooks != null) { sets.push("playbooks = ?"); params.push(versionRow.playbooks); }
      if (versionRow.related_skills != null) { sets.push("related_skills = ?"); params.push(versionRow.related_skills); }
      params.push(skillId);
      this.db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...(params as import("bun:sqlite").SQLQueryBindings[]));

      const restored = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(skillId) as SkillRow | null;
      return restored ? rowToSkill(restored) : null;
    } catch {
      return null; // skill_versions table may not exist
    }
  }

  /** Delete a specific version snapshot. Returns true if a row was deleted. */
  deleteVersion(skillId: string, version: number): boolean {
    try {
      const result = this.db.prepare(
        "DELETE FROM skill_versions WHERE skill_id = ? AND version = ?"
      ).run(skillId, version);
      return result.changes > 0;
    } catch {
      return false;
    }
  }
}
