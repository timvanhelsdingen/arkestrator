import { Database } from "bun:sqlite";
import { newId } from "../utils/id.js";

export interface HeadlessProgram {
  id: string;
  program: string;
  displayName: string;
  executable: string;
  argsTemplate: string[];
  language: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HeadlessProgramCreate {
  program: string;
  displayName: string;
  executable: string;
  argsTemplate: string[];
  language: string;
  enabled?: boolean;
}

interface HeadlessProgramRow {
  id: string;
  program: string;
  display_name: string;
  executable: string;
  args_template: string;
  language: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToProgram(row: HeadlessProgramRow): HeadlessProgram {
  return {
    id: row.id,
    program: row.program,
    displayName: row.display_name,
    executable: row.executable,
    argsTemplate: JSON.parse(row.args_template),
    language: row.language,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class HeadlessProgramsRepo {
  private insertStmt;
  private getByIdStmt;
  private getByProgramStmt;
  private listStmt;
  private updateStmt;
  private deleteStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO headless_programs (id, program, display_name, executable, args_template, language, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = db.prepare(
      `SELECT * FROM headless_programs WHERE id = ?`,
    );
    this.getByProgramStmt = db.prepare(
      `SELECT * FROM headless_programs WHERE program = ?`,
    );
    this.listStmt = db.prepare(
      `SELECT * FROM headless_programs ORDER BY program`,
    );
    this.updateStmt = db.prepare(
      `UPDATE headless_programs SET display_name = ?, executable = ?, args_template = ?, language = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM headless_programs WHERE id = ?`);
  }

  create(data: HeadlessProgramCreate): HeadlessProgram {
    const id = newId();
    const now = new Date().toISOString();
    this.insertStmt.run(
      id,
      data.program,
      data.displayName,
      data.executable,
      JSON.stringify(data.argsTemplate),
      data.language,
      data.enabled !== false ? 1 : 0,
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): HeadlessProgram | null {
    const row = this.getByIdStmt.get(id) as HeadlessProgramRow | null;
    return row ? rowToProgram(row) : null;
  }

  getByProgram(program: string): HeadlessProgram | null {
    const row = this.getByProgramStmt.get(program) as HeadlessProgramRow | null;
    return row ? rowToProgram(row) : null;
  }

  list(): HeadlessProgram[] {
    const rows = this.listStmt.all() as HeadlessProgramRow[];
    return rows.map(rowToProgram);
  }

  update(id: string, data: Partial<HeadlessProgramCreate>): HeadlessProgram | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.updateStmt.run(
      data.displayName ?? existing.displayName,
      data.executable ?? existing.executable,
      data.argsTemplate ? JSON.stringify(data.argsTemplate) : JSON.stringify(existing.argsTemplate),
      data.language ?? existing.language,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
      now,
      id,
    );
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  /**
   * Seed default headless programs on first run. Skips any program that already
   * exists in the database so admin overrides are preserved.
   */
  seedDefaults(): void {
    const defaults: HeadlessProgramCreate[] = [
      {
        program: "houdini",
        displayName: "Houdini (hython)",
        executable: "hython",
        argsTemplate: ["{{SCRIPT_FILE}}"],
        language: "python",
        enabled: true,
      },
      {
        program: "blender",
        displayName: "Blender (CLI)",
        executable: "blender",
        argsTemplate: ["--background", "--python", "{{SCRIPT_FILE}}"],
        language: "python",
        enabled: true,
      },
      {
        program: "godot",
        displayName: "Godot (headless)",
        executable: "godot",
        argsTemplate: ["--headless", "--script", "{{SCRIPT_FILE}}"],
        language: "gdscript",
        enabled: true,
      },
    ];

    for (const def of defaults) {
      if (!this.getByProgram(def.program)) {
        this.create(def);
      }
    }
  }
}
