import { afterEach, describe, expect, it } from "bun:test";
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

    const config = loadConfig();
    expect(config.dataDir).toBe("/srv/ark-data");
    expect(config.dbPath).toBe("/srv/ark-data/db/arkestrator.db");
    expect(config.coordinatorScriptsDir).toBe("/srv/ark-data/coordinator-scripts");
    expect(config.coordinatorPlaybooksDir).toBe("/srv/ark-data/coordinator-playbooks");
    expect(config.coordinatorImportsDir).toBe("/srv/ark-data/coordinator-imports");
    expect(config.snapshotsDir).toBe("/srv/ark-data/snapshots");
  });
});
