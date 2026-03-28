import { Database } from "bun:sqlite";
import type { ProjectCreate } from "@arkestrator/protocol";
import { newId } from "../utils/id.js";

export interface Project {
  id: string;
  name: string;
  prompt: string | null;
  pathMappings: unknown[];
  folders: unknown[];
  files: unknown[];
  githubRepos: unknown[];
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  system_prompt: string | null;
  path_mappings: string;
  folders: string;
  files: string;
  github_repos: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    prompt: row.system_prompt,
    pathMappings: JSON.parse(row.path_mappings || "[]"),
    folders: JSON.parse(row.folders || "[]"),
    files: JSON.parse(row.files || "[]"),
    githubRepos: JSON.parse(row.github_repos || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectsRepo {
  private insertStmt;
  private getByIdStmt;
  private listStmt;
  private updateStmt;
  private deleteStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO projects (id, name, bridge_path_pattern, source_type, source_path, system_prompt, path_mappings, folders, files, github_repos, created_at, updated_at)
       VALUES (?, ?, '', 'local', '', ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(
      `SELECT id, name, system_prompt, path_mappings, folders, files, github_repos, created_at, updated_at FROM projects WHERE id = ?`,
    );
    this.listStmt = db.prepare(
      `SELECT id, name, system_prompt, path_mappings, folders, files, github_repos, created_at, updated_at FROM projects ORDER BY name`,
    );
    this.updateStmt = db.prepare(
      `UPDATE projects SET name=?, system_prompt=?, path_mappings=?, folders=?, files=?, github_repos=?, updated_at=? WHERE id=?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM projects WHERE id = ?`);
  }

  create(input: ProjectCreate): Project {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      input.name,
      input.prompt ?? null,
      JSON.stringify(input.pathMappings ?? []),
      JSON.stringify(input.folders ?? []),
      JSON.stringify(input.files ?? []),
      JSON.stringify(input.githubRepos ?? []),
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): Project | null {
    const row = this.getByIdStmt.get(id) as ProjectRow | null;
    return row ? rowToProject(row) : null;
  }

  list(): Project[] {
    const rows = this.listStmt.all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  update(project: Project): Project | null {
    const now = new Date().toISOString();
    const result = this.updateStmt.run(
      project.name,
      project.prompt ?? null,
      JSON.stringify(project.pathMappings ?? []),
      JSON.stringify(project.folders ?? []),
      JSON.stringify(project.files ?? []),
      JSON.stringify(project.githubRepos ?? []),
      now,
      project.id,
    );
    if (result.changes === 0) return null;
    return this.getById(project.id);
  }

  delete(id: string): boolean {
    // Unlink jobs first so FK constraint doesn't block deletion
    this.db.prepare("UPDATE jobs SET project_id = NULL WHERE project_id = ?").run(id);
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }
}
