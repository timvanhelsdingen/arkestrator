/**
 * Regression: WorkersRepo.upsert must refuse to persist sentinel
 * `lastProjectPath` values (home dir, filesystem root, etc.) on
 * worker rows.
 *
 * Background: on 2026-04-11, a Blender bridge in an Untitled session
 * reported its projectPath as `C:/Users/timvanhelsdingen`. The worker
 * repo happily stored that and the job resolver's worker-injection
 * path at `queue/worker.ts:236` fed it back into every later job as
 * `editorContext.projectRoot`, which the resolver then used as the
 * agent's cwd. Parallel Claude Code subprocesses indexing the home
 * tree corrupted the live SQLite file within 20 seconds.
 *
 * The fix sits at `db/workers.repo.ts:upsert` and uses
 * `sanitizeLastProjectPath` from `utils/project-path.ts`. A rejected
 * path is dropped silently (logged as WARN), and the existing
 * `last_project_path` on the row is preserved via COALESCE so a
 * worker that once had a valid project doesn't regress to home.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "../db/migrations.js";
import { WorkersRepo } from "../db/workers.repo.js";

describe("WorkersRepo sanitizes lastProjectPath", () => {
  let db: Database;
  let repo: WorkersRepo;
  let tempRoot: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new WorkersRepo(db);
    tempRoot = mkdtempSync(join(tmpdir(), "ark-wr-"));
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("drops the user home directory and leaves lastProjectPath null", () => {
    const worker = repo.upsert("test-worker-home", "blender", homedir(), "127.0.0.1", "mid-1");
    expect(worker.lastProjectPath).toBeUndefined();
  });

  it("accepts a legitimate project path", () => {
    const projectDir = mkdtempSync(join(tempRoot, "project-"));
    writeFileSync(join(projectDir, "package.json"), "{}");
    const worker = repo.upsert("test-worker-legit", "blender", projectDir, "127.0.0.1", "mid-2");
    expect(worker.lastProjectPath).toBeDefined();
    // Path comparison tolerant of Windows path separators + normalization
    expect(String(worker.lastProjectPath).toLowerCase()).toContain("project-");
  });

  it("preserves a previously-good path when a later bad path is dropped", () => {
    // First call with a good path
    const projectDir = mkdtempSync(join(tempRoot, "keeper-"));
    writeFileSync(join(projectDir, ".git"), "");
    let worker = repo.upsert("test-worker-keep", "blender", projectDir, "127.0.0.1", "mid-3");
    expect(worker.lastProjectPath).toBeDefined();
    const firstPath = worker.lastProjectPath;

    // Second call with home dir — should be dropped, first path preserved
    worker = repo.upsert("test-worker-keep", "blender", homedir(), "127.0.0.1", "mid-3");
    expect(worker.lastProjectPath).toBe(firstPath);
  });

  it("drops undefined projectPath without touching the row", () => {
    const projectDir = mkdtempSync(join(tempRoot, "undef-"));
    writeFileSync(join(projectDir, "package.json"), "{}");

    // Seed
    let worker = repo.upsert("test-worker-undef", "blender", projectDir, "127.0.0.1", "mid-4");
    const firstPath = worker.lastProjectPath;
    expect(firstPath).toBeDefined();

    // Touch without supplying projectPath — COALESCE should preserve it
    worker = repo.upsert("test-worker-undef", "blender", undefined, "127.0.0.1", "mid-4");
    expect(worker.lastProjectPath).toBe(firstPath);
  });
});
