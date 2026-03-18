import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrations.js";
import { WorkersRepo } from "../db/workers.repo.js";
import { ensureLiveWorkersPersisted } from "../utils/live-workers.js";

function makeRepo() {
  const db = new Database(":memory:");
  runMigrations(db);
  return new WorkersRepo(db);
}

describe("ensureLiveWorkersPersisted", () => {
  it("recreates a deleted worker from a live bridge snapshot", () => {
    const repo = makeRepo();
    const worker = repo.upsert("tims-macbook-pro", "blender", "/tmp/demo", "10.0.0.5", "machine-123");
    expect(repo.delete(worker.id)).toBe(true);
    expect(repo.getByName("tims-macbook-pro")).toBeNull();

    ensureLiveWorkersPersisted(
      repo,
      [{
        machineId: "machine-123",
        workerName: "tims-macbook-pro",
        program: "blender",
        projectPath: "/tmp/demo",
        ip: "10.0.0.5",
        programVersion: "4.5.0",
        bridgeVersion: "1.0.0",
      }],
      [],
    );

    const restored = repo.getByName("tims-macbook-pro");
    expect(restored).not.toBeNull();
    expect(restored?.machineId).toBe("machine-123");
    expect(restored?.knownPrograms).toContain("blender");
    expect(restored?.lastProjectPath).toBe("/tmp/demo");
  });

  it("recreates a deleted worker from client presence when no bridge is connected", () => {
    const repo = makeRepo();
    const worker = repo.upsert("tims-macbook-pro", undefined, undefined, "10.0.0.5", "machine-123");
    expect(repo.delete(worker.id)).toBe(true);

    ensureLiveWorkersPersisted(
      repo,
      [],
      [{ workerName: "tims-macbook-pro", machineId: "machine-123", ip: "10.0.0.5" }],
    );

    const restored = repo.getByName("tims-macbook-pro");
    expect(restored).not.toBeNull();
    expect(restored?.machineId).toBe("machine-123");
    expect(restored?.lastIp).toBe("10.0.0.5");
  });
});
