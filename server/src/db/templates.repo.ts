import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface PromptTemplate {
  id: string;
  name: string;
  slug: string;
  type: "chat" | "project" | "job_preset" | "path_mapping";
  category: string;
  subcategory: string | null;
  description: string;
  content: string;
  icon: string | null;
  options: Record<string, unknown> | null;
  sortOrder: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  slug: string;
  type: string;
  category: string;
  subcategory: string | null;
  description: string;
  content: string;
  icon: string | null;
  options: string | null;
  sort_order: number;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: TemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as PromptTemplate["type"],
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    content: row.content,
    icon: row.icon,
    options: row.options ? JSON.parse(row.options) : null,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TemplateCreateInput {
  name: string;
  slug?: string;
  type: "chat" | "project" | "job_preset" | "path_mapping";
  category?: string;
  subcategory?: string | null;
  description?: string;
  content: string;
  icon?: string | null;
  options?: Record<string, unknown> | null;
  sortOrder?: number;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface TemplateUpdateInput {
  name?: string;
  slug?: string;
  type?: "chat" | "project" | "job_preset";
  category?: string;
  subcategory?: string | null;
  description?: string;
  content?: string;
  icon?: string | null;
  options?: Record<string, unknown> | null;
  sortOrder?: number;
  enabled?: boolean;
}

export class TemplatesRepo {
  private insertStmt;
  private getByIdStmt;
  private deleteStmt;
  private slugExistsStmt;
  private slugExistsExcludeStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO prompt_templates (id, name, slug, type, category, subcategory, description, content, icon, options, sort_order, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(
      `SELECT * FROM prompt_templates WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM prompt_templates WHERE id = ?`);
    this.slugExistsStmt = db.prepare(
      `SELECT 1 FROM prompt_templates WHERE slug = ?`,
    );
    this.slugExistsExcludeStmt = db.prepare(
      `SELECT 1 FROM prompt_templates WHERE slug = ? AND id != ?`,
    );
  }

  create(input: TemplateCreateInput): PromptTemplate {
    const id = newId();
    const now = new Date().toISOString();
    const slug = input.slug || slugify(input.name);
    this.insertStmt.run(
      id,
      input.name,
      slug,
      input.type,
      input.category ?? "General",
      input.subcategory ?? null,
      input.description ?? "",
      input.content,
      input.icon ?? null,
      input.options ? JSON.stringify(input.options) : null,
      input.sortOrder ?? 50,
      input.enabled !== false ? 1 : 0,
      input.createdBy ?? null,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): PromptTemplate | null {
    const row = this.getByIdStmt.get(id) as TemplateRow | null;
    return row ? rowToTemplate(row) : null;
  }

  list(filters?: { type?: string; category?: string; enabled?: boolean }): PromptTemplate[] {
    let sql = "SELECT * FROM prompt_templates";
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    if (filters?.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(filters.enabled ? 1 : 0);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY type, category, sort_order, name";

    const rows = this.db.prepare(sql).all(...params) as TemplateRow[];
    return rows.map(rowToTemplate);
  }

  update(id: string, input: TemplateUpdateInput): PromptTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const name = input.name ?? existing.name;
    const slug = input.slug ?? existing.slug;
    const type = input.type ?? existing.type;
    const category = input.category ?? existing.category;
    const subcategory = input.subcategory !== undefined ? input.subcategory : existing.subcategory;
    const description = input.description ?? existing.description;
    const content = input.content ?? existing.content;
    const icon = input.icon !== undefined ? input.icon : existing.icon;
    const options = input.options !== undefined ? input.options : existing.options;
    const sortOrder = input.sortOrder ?? existing.sortOrder;
    const enabled = input.enabled !== undefined ? input.enabled : existing.enabled;

    this.db.prepare(
      `UPDATE prompt_templates SET name=?, slug=?, type=?, category=?, subcategory=?, description=?, content=?, icon=?, options=?, sort_order=?, enabled=?, updated_at=? WHERE id=?`,
    ).run(
      name,
      slug,
      type,
      category,
      subcategory,
      description,
      content,
      icon,
      options ? JSON.stringify(options) : null,
      sortOrder,
      enabled ? 1 : 0,
      now,
      id,
    );

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  listCategories(type?: string): Array<{ type: string; category: string; subcategory: string | null; count: number }> {
    if (type) {
      return this.db.prepare(
        `SELECT type, category, subcategory, COUNT(*) as count FROM prompt_templates WHERE type = ? GROUP BY type, category, subcategory ORDER BY type, category, subcategory`,
      ).all(type) as Array<{ type: string; category: string; subcategory: string | null; count: number }>;
    }
    return this.db.prepare(
      `SELECT type, category, subcategory, COUNT(*) as count FROM prompt_templates GROUP BY type, category, subcategory ORDER BY type, category, subcategory`,
    ).all() as Array<{ type: string; category: string; subcategory: string | null; count: number }>;
  }

  slugExists(slug: string, excludeId?: string): boolean {
    if (excludeId) {
      return !!this.slugExistsExcludeStmt.get(slug, excludeId);
    }
    return !!this.slugExistsStmt.get(slug);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
