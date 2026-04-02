import { afterEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { loadConfig } from "../config.js";

const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  DB_PATH: process.env.DB_PATH,
  COORDINATOR_SCRIPTS_DIR: process.env.COORDINATOR_SCRIPTS_DIR,
  COORDINATOR_PLAYBOOKS_DIR: process.env.COORDINATOR_PLAYBOOKS_DIR,
  COORDINATOR_IMPORTS_DIR: process.env.COORDINATOR_IMPORTS_DIR,
  SNAPSHOTS_DIR: process.env.SNAPSHOTS_DIR,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("derives durable storage paths from DATA_DIR by default", () => {
    process.env.DATA_DIR = "/srv/ark-data";
    delete process.env.DB_PATH;
    delete process.env.COORDINATOR_SCRIPTS_DIR;
    delete process.env.COORDINATOR_PLAYBOOKS_DIR;
    delete process.env.COORDINATOR_IMPORTS_DIR;
    delete process.env.SNAPSHOTS_DIR;
    delete process.env.SKILLS_DIR;

    const base = "/srv/ark-data";
    const config = loadConfig();
    expect(config.dataDir).toBe(base);
    expect(config.dbPath).toBe(join(base, "db", "arkestrator.db"));
    expect(config.coordinatorScriptsDir).toBe(join(base, "coordinator-scripts"));
    expect(config.coordinatorPlaybooksDir).toBe(join(base, "coordinator-playbooks"));
    expect(config.coordinatorImportsDir).toBe(join(base, "coordinator-imports"));
    expect(config.snapshotsDir).toBe(join(base, "snapshots"));
    expect(config.skillsDir).toBe(join(base, "skills"));
  });
});
