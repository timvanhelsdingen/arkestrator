import type { Database } from "bun:sqlite";

/**
 * Skill record as stored in the DB.
 * Keywords are stored as a JSON array string and parsed on read.
 */
export interface Skill {
  id: string;
  name: string;
  slug: string;
  program: string;
  category: string;
  title: string;
  description: string;
  keywords: string[];
  content: string;
  source: string;
  sourcePath: string | null;
  priority: number;
  autoFetch: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Row shape coming out of SQLite (keywords as JSON string, booleans as 0/1). */
interface SkillRow {
  id: string;
  name: string;
  slug: string;
  program: string;
  category: string;
  title: string;
  description: string;
  keywords: string;
  content: string;
  source: string;
  source_path: string | null;
  priority: number;
  auto_fetch: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Fields accepted when creating a new skill. */
export interface CreateSkillInput {
  name: string;
  slug: string;
  program?: string;
  category: string;
  title: string;
  description?: string;
  keywords?: string[];
  content: string;
  source?: string;
  sourcePath?: string | null;
  priority?: number;
  autoFetch?: boolean;
  enabled?: boolean;
}

/** Fields accepted when updating a skill. All optional. */
export interface UpdateSkillInput {
  name?: string;
  title?: string;
  description?: string;
  keywords?: string[];
  content?: string;
  source?: string;
  priority?: number;
  autoFetch?: boolean;
  enabled?: boolean;
}

function rowToSkill(row: SkillRow): Skill {
  let keywords: string[] = [];
  try {
    keywords = JSON.parse(row.keywords);
  } catch {
    /* default empty */
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    program: row.program,
    category: row.category,
    title: row.title,
    description: row.description,
    keywords,
    content: row.content,
    source: row.source,
    sourcePath: row.source_path,
    priority: row.priority,
    autoFetch: row.auto_fetch === 1,
    enabled: row.enabled === 1,
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
      INSERT INTO skills (id, name, slug, program, category, title, description, keywords, content, source, source_path, priority, auto_fetch, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO skills (id, name, slug, program, category, title, description, keywords, content, source, source_path, priority, auto_fetch, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, program) DO UPDATE SET
        name = excluded.name, category = excluded.category, title = excluded.title,
        description = excluded.description, keywords = excluded.keywords, content = excluded.content,
        source = excluded.source, source_path = excluded.source_path, priority = excluded.priority,
        auto_fetch = excluded.auto_fetch, enabled = excluded.enabled, updated_at = excluded.updated_at
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
    const program = input.program ?? "global";
    const src = source ?? input.source ?? "user";

    this.insertStmt.run(
      id, input.name, input.slug, program, input.category, input.title,
      input.description ?? "", JSON.stringify(input.keywords ?? []), input.content,
      src, input.sourcePath ?? null, input.priority ?? 50,
      (input.autoFetch ?? false) ? 1 : 0, (input.enabled ?? true) ? 1 : 0,
      now, now,
    );
    return this.get(input.slug, program)!;
  }

  /** Update a skill by id. Returns updated skill or null. */
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
    if (updates.source !== undefined) { sets.push("source = ?"); values.push(updates.source); }
    if (updates.priority !== undefined) { sets.push("priority = ?"); values.push(updates.priority); }
    if (updates.autoFetch !== undefined) { sets.push("auto_fetch = ?"); values.push(updates.autoFetch ? 1 : 0); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(existing.id);

    this.db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(slug, program ?? existing.program);
  }

  /** Delete a skill by slug. */
  delete(slug: string, program?: string): boolean {
    const result = program
      ? this.deleteBySlugAndProgramStmt.run(slug, program)
      : this.deleteBySlugStmt.run(slug);
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
    return (this.db.prepare(`SELECT * FROM skills ${where} ORDER BY priority DESC, title ASC`).all(...params) as SkillRow[]).map(rowToSkill);
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
    const program = input.program ?? "global";

    this.upsertStmt.run(
      id, input.name ?? input.slug, input.slug, program, input.category, input.title,
      input.description ?? "", JSON.stringify(input.keywords ?? []), input.content,
      input.source ?? "user", input.sourcePath ?? null, input.priority ?? 50,
      (input.autoFetch ?? false) ? 1 : 0, (input.enabled ?? true) ? 1 : 0,
      now, now,
    );
    return this.get(input.slug, program)!;
  }

  /** Delete any skill regardless of source. */
  deleteAny(slug: string, program: string): boolean {
    return this.deleteAnyBySlugAndProgramStmt.run(slug, program).changes > 0;
  }

  /** List skills by source. */
  listBySource(source: string): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE source = ? ORDER BY priority DESC, title ASC").all(source) as SkillRow[]).map(rowToSkill);
  }

  /** Delete all skills with a given source. */
  deleteBySource(source: string, program?: string): number {
    if (program) {
      return this.db.prepare("DELETE FROM skills WHERE source = ? AND program = ?").run(source, program).changes;
    }
    return this.db.prepare("DELETE FROM skills WHERE source = ?").run(source).changes;
  }
}
