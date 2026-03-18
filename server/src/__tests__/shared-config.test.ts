import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  getSharedConfigPath,
  resolveSpawnedAgentServerUrl,
  writeSharedConfig,
} from "../utils/shared-config.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeSharedConfig", () => {
  it("preserves client-owned workerName when the server rewrites shared config", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "ark-shared-config-"));
    tempDirs.push(tempHome);
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const configPath = getSharedConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      serverUrl: "http://localhost:7800",
      wsUrl: "ws://localhost:7800/ws",
      apiKey: "ark_old",
      machineId: "machine-123",
      workerName: "tims-macbook-pro",
    }, null, 2));

    writeSharedConfig(7800, "ark_new");

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      apiKey: string;
      machineId?: string;
      workerName?: string;
    };
    expect(parsed.apiKey).toBe("ark_new");
    expect(parsed.machineId).toBe("machine-123");
    expect(parsed.workerName).toBe("tims-macbook-pro");
  });

  it("routes spawned agents through loopback when shared config points at a remote hostname", () => {
    const resolved = resolveSpawnedAgentServerUrl(7800, {
      serverUrl: "http://truenas.local:7800",
      wsUrl: "ws://truenas.local:7800/ws",
      apiKey: "ark_test",
    });
    expect(resolved).toBe("http://127.0.0.1:7800");
  });

  it("preserves localhost URLs for spawned agents when shared config is already local", () => {
    const resolved = resolveSpawnedAgentServerUrl(7800, {
      serverUrl: "http://localhost:7800",
      wsUrl: "ws://localhost:7800/ws",
      apiKey: "ark_test",
    });
    expect(resolved).toBe("http://localhost:7800");
  });
});
