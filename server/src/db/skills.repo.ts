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
 * Repository for custom (source='user') skills stored in SQLite.
 * Follows the same constructor pattern as SettingsRepo.
 */
export class SkillsRepo {
  private listStmt;
  private listByProgramStmt;
  private listByCategoryStmt;
  private listByProgramAndCategoryStmt;
  private getBySlugStmt;
  private getBySlugAndProgramStmt;
  private insertStmt;
  private deleteBySlugStmt;
  private deleteBySlugAndProgramStmt;

  constructor(private db: Database) {
    this.listStmt = db.prepare(
      "SELECT * FROM skills WHERE source = 'user' ORDER BY priority DESC, title ASC",
    );
    this.listByProgramStmt = db.prepare(
      "SELECT * FROM skills WHERE source = 'user' AND program = ? ORDER BY priority DESC, title ASC",
    );
    this.listByCategoryStmt = db.prepare(
      "SELECT * FROM skills WHERE source = 'user' AND category = ? ORDER BY priority DESC, title ASC",
    );
    this.listByProgramAndCategoryStmt = db.prepare(
      "SELECT * FROM skills WHERE source = 'user' AND program = ? AND category = ? ORDER BY priority DESC, title ASC",
    );
    this.getBySlugStmt = db.prepare(
      "SELECT * FROM skills WHERE slug = ? AND source = 'user' LIMIT 1",
    );
    this.getBySlugAndProgramStmt = db.prepare(
      "SELECT * FROM skills WHERE slug = ? AND program = ? AND source = 'user' LIMIT 1",
    );
    this.insertStmt = db.prepare(`
      INSERT INTO skills (id, name, slug, program, category, title, description, keywords, content, source, source_path, priority, auto_fetch, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
    `);
    this.deleteBySlugStmt = db.prepare(
      "DELETE FROM skills WHERE slug = ? AND source = 'user'",
    );
    this.deleteBySlugAndProgramStmt = db.prepare(
      "DELETE FROM skills WHERE slug = ? AND program = ? AND source = 'user'",
    );
  }

  /** List custom skills, optionally filtered by program and/or category. */
  list(opts?: { program?: string; category?: string }): Skill[] {
    let rows: SkillRow[];
    if (opts?.program && opts?.category) {
      rows = this.listByProgramAndCategoryStmt.all(opts.program, opts.category) as SkillRow[];
    } else if (opts?.program) {
      rows = this.listByProgramStmt.all(opts.program) as SkillRow[];
    } else if (opts?.category) {
      rows = this.listByCategoryStmt.all(opts.category) as SkillRow[];
    } else {
      rows = this.listStmt.all() as SkillRow[];
    }
    return rows.map(rowToSkill);
  }

  /** Get a single custom skill by slug (and optionally program). */
  get(slug: string, program?: string): Skill | null {
    const row = program
      ? (this.getBySlugAndProgramStmt.get(slug, program) as SkillRow | null)
      : (this.getBySlugStmt.get(slug) as SkillRow | null);
    return row ? rowToSkill(row) : null;
  }

  /** Create a new custom skill. Returns the created skill. */
  create(input: CreateSkillInput): Skill {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const program = input.program ?? "global";
    const description = input.description ?? "";
    const keywords = JSON.stringify(input.keywords ?? []);
    const priority = input.priority ?? 50;
    const autoFetch = (input.autoFetch ?? false) ? 1 : 0;
    const enabled = (input.enabled ?? true) ? 1 : 0;

    this.insertStmt.run(
      id,
      input.name,
      input.slug,
      program,
      input.category,
      input.title,
      description,
      keywords,
      input.content,
      input.sourcePath ?? null,
      priority,
      autoFetch,
      enabled,
      now,
      now,
    );

    return this.get(input.slug, program)!;
  }

  /** Update a custom skill by slug (and optionally program). Returns updated skill or null. */
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

  /** Delete a custom skill by slug (and optionally program). Returns true if deleted. */
  delete(slug: string, program?: string): boolean {
    const result = program
      ? this.deleteBySlugAndProgramStmt.run(slug, program)
      : this.deleteBySlugStmt.run(slug);
    return result.changes > 0;
  }
}
