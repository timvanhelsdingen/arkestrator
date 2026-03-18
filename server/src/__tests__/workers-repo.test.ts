import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrations.js";
import { WorkersRepo } from "../db/workers.repo.js";

function makeRepo() {
  const db = new Database(":memory:");
  runMigrations(db);
  return new WorkersRepo(db);
}

describe("WorkersRepo machineId matching", () => {
  it("keeps one worker row when the same machine reconnects with a new display name", () => {
    const repo = makeRepo();

    const first = repo.upsert("tims-macbook-pro", "blender", "/tmp/demo", "10.0.0.5", "machine-123");
    const second = repo.upsert("tims-mbp.fritz.box", "blender", "/tmp/demo", "10.0.0.5", "machine-123");

    expect(second.id).toBe(first.id);
    expect(second.machineId).toBe("machine-123");
    expect(second.name).toBe("tims-mbp.fritz.box");
    expect(repo.list()).toHaveLength(1);
  });

  it("tracks bridge history by machineId when the display name changes", () => {
    const repo = makeRepo();

    repo.upsert("tims-macbook-pro", "blender", "/tmp/demo", "10.0.0.5", "machine-123");
    repo.upsertBridge("tims-macbook-pro", "blender", "4.5.0", "1.0.0", "/tmp/demo", "machine-123");

    const renamed = repo.upsert("tims-mbp.fritz.box", "blender", "/tmp/demo", "10.0.0.5", "machine-123");
    repo.upsertBridge("tims-mbp.fritz.box", "blender", "4.5.1", "1.0.0", "/tmp/demo", "machine-123");

    const history = repo.getBridgesForWorker(renamed.name, renamed.machineId);
    expect(history).toHaveLength(1);
    expect(history[0]?.worker_machine_id).toBe("machine-123");
    expect(history[0]?.worker_name).toBe("tims-mbp.fritz.box");
    expect(history[0]?.program_version).toBe("4.5.1");
  });
});
