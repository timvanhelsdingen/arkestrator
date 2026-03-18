import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import type { Config } from "../config.js";
import { WorkerResourceLeaseManager } from "../agents/resource-control.js";
import { createBridgeCommandRoutes } from "../routes/bridge-commands.js";
import { createJobRoutes } from "../routes/jobs.js";
import {
  createTestAgentConfig,
  createTestDb,
  createTestSession,
  createTestUser,
  type TestContext,
} from "./setup.js";

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createConfig(tempDir: string): Config {
  return {
    port: 7800,
    dataDir: tempDir,
    dbPath: ":memory:",
    maxConcurrentAgents: 1,
    workerPollMs: 500,
    jobTimeoutMs: 30_000,
    logLevel: "error",
    syncTempDir: join(tempDir, "sync"),
    syncTtlMs: 60_000,
    syncCleanupIntervalMs: 30_000,
    syncMaxSizeMb: 10,
    defaultWorkspaceMode: "auto",
    headlessTempDir: join(tempDir, "headless"),
    comfyuiUrl: "http://127.0.0.1:8188",
    seedExampleHeadlessPrograms: false,
    headlessExecutableHints: {},
    coordinatorScriptsDir: join(tempDir, "coordinator-scripts"),
    coordinatorPlaybooksDir: join(tempDir, "coordinator-playbooks"),
    coordinatorImportsDir: join(tempDir, "coordinator-imports"),
    snapshotsDir: join(tempDir, "snapshots"),
    coordinatorReferencePaths: [],
    coordinatorPlaybookSourcePaths: [],
    corsOrigins: [],
    trustProxyHeaders: false,
  };
}

describe("bridge execution mode routing", () => {
  let ctx: TestContext;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    ctx = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), "ark-bridge-execution-mode-"));
    config = createConfig(tempDir);
  });

  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores a headless bridge execution preference when the prompt explicitly asks for background/CLI execution", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "headless-user",
      password: "headless-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const agent = createTestAgentConfig(ctx.agentsRepo);

    const app = new Hono();
    app.route("/api/jobs", createJobRoutes(
      ctx.jobsRepo,
      ctx.agentsRepo,
      ctx.policiesRepo,
      ctx.usersRepo,
      ctx.auditRepo,
      ctx.usageRepo,
      ctx.depsRepo,
      ctx.apiKeysRepo,
      ctx.settingsRepo,
      {} as any,
    ));

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Use headless Blender in a separate background process and do not touch my active session. Save the result to disk.",
        agentConfigId: agent.id,
        bridgeProgram: "blender",
      }),
    });

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.runtimeOptions?.bridgeExecutionMode).toBe("headless");

    const stored = ctx.jobsRepo.getById(created.id);
    expect(stored?.runtimeOptions?.bridgeExecutionMode).toBe("headless");
  });

  it("forces CLI-wrapper bridge commands through headless fallback even when a live bridge is connected", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "bridge-mode-user",
      password: "bridge-mode-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    ctx.headlessProgramsRepo.create({
      program: "blender",
      displayName: "Blender (Headless)",
      executable: process.execPath,
      argsTemplate: ["-e", "console.log('forced-headless-route')"],
      language: "python",
    });

    const sentToLiveBridge: string[] = [];
    const sentToClient: any[] = [];
    const fakeHub = {
      getConnection: () => undefined,
      getBridgesByProgram: (program: string) => program === "blender"
        ? [{
            data: { type: "bridge", id: "live-blender", program: "blender", workerName: "ws-01" },
            send: () => { sentToLiveBridge.push("sent"); },
          }]
        : [],
      getClientConnectionsByWorker: (worker: string) => worker === "ws-01"
        ? [{
            data: { type: "client", id: "desktop-client", workerName: "ws-01" },
            send: (raw: string) => { sentToClient.push(JSON.parse(raw)); },
          }]
        : [],
      getClientConnections: () => [{
        data: { type: "client", id: "desktop-client", workerName: "ws-01" },
        send: (raw: string) => { sentToClient.push(JSON.parse(raw)); },
      }],
      getBridges: () => [{ program: "blender" }],
      registerPendingCommand: () => Promise.resolve({
        success: true,
        executed: 1,
        failed: 0,
        skipped: 0,
        errors: [],
        stdout: "worker-headless-route",
        program: "blender",
        headless: true,
      }),
      recordBridgeProjectPath: () => false,
      broadcastBridgeStatus: () => undefined,
      broadcastToType: () => undefined,
      send: (id: string, message: object) => {
        if (id === "desktop-client") {
          sentToClient.push(message);
        }
      },
    } as any;

    const job = ctx.jobsRepo.create(
      {
        prompt: "Use headless Blender and keep my current session untouched.",
        agentConfigId: createTestAgentConfig(ctx.agentsRepo).id,
        priority: "normal",
        coordinationMode: "server",
        files: [],
        contextItems: [],
        runtimeOptions: { bridgeExecutionMode: "headless" },
      },
      undefined,
      "blender",
      undefined,
      undefined,
      user.id,
    );

    const app = new Hono();
    app.route(
      "/api/bridge-command",
      createBridgeCommandRoutes(
        fakeHub,
        ctx.apiKeysRepo,
        ctx.usersRepo,
        ctx.policiesRepo,
        ctx.headlessProgramsRepo,
        config,
        ctx.jobsRepo,
      ),
    );

    const res = await app.request("/api/bridge-command", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
        "x-job-id": job.id,
      },
      body: JSON.stringify({
        target: "blender",
        commands: [{ language: "python", script: "print('hello')" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.headless).toBe(true);
    expect(body.stdout).toContain("worker-headless-route");
    expect(sentToLiveBridge).toEqual([]);
    expect(sentToClient.some((msg) => msg.type === "worker_headless_command")).toBe(true);
  });

  it("blocks conflicting gpu-heavy bridge commands on the same worker while one is already running", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "resource-lock-user",
      password: "resource-lock-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const resourceLeaseManager = new WorkerResourceLeaseManager();

    let pendingResolve: ((value: unknown) => void) | null = null;
    const fakeHub = {
      getConnection: () => undefined,
      getBridgesByProgram: (program: string) => (
        program === "comfyui" || program === "blender"
          ? [{
              data: { type: "bridge", id: `${program}-bridge`, program, workerName: "gpu-ws-01" },
              send: () => undefined,
            }]
          : []
      ),
      getBridges: () => [
        { program: "comfyui" },
        { program: "blender" },
      ],
      getClients: () => [],
      registerPendingCommand: () => new Promise((resolve) => {
        pendingResolve = resolve;
      }),
      recordBridgeProjectPath: () => false,
      broadcastBridgeStatus: () => undefined,
      broadcastToType: () => undefined,
    } as any;

    const app = new Hono();
    app.route(
      "/api/bridge-command",
      createBridgeCommandRoutes(
        fakeHub,
        ctx.apiKeysRepo,
        ctx.usersRepo,
        ctx.policiesRepo,
        ctx.headlessProgramsRepo,
        config,
        ctx.jobsRepo,
        resourceLeaseManager,
      ),
    );

    const firstRequest = app.request("/api/bridge-command", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "comfyui",
        commands: [{ language: "workflow", script: "{\"nodes\":[]}" }],
      }),
    });

    await Promise.resolve();

    const blockedRes = await app.request("/api/bridge-command", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "blender",
        commands: [{ language: "python", script: "import bpy\nbpy.ops.render.render(write_still=True)" }],
      }),
    });

    expect(blockedRes.status).toBe(409);
    const blockedBody = await blockedRes.json();
    expect(String(blockedBody?.error ?? blockedBody?.message ?? "")).toContain("conflicting gpu_vram_heavy task");

    pendingResolve?.({
      success: true,
      executed: 1,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    const firstRes = await firstRequest;
    expect(firstRes.status).toBe(200);
  });

  it("treats skipped bridge commands as API failures instead of semantic success", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "skip-check-user",
      password: "skip-check-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const fakeHub = {
      getConnection: () => undefined,
      getBridgesByProgram: (program: string) => program === "blender"
        ? [{
            data: { type: "bridge", id: "live-blender", program: "blender", workerName: "ws-01" },
            send: () => undefined,
          }]
        : [],
      getBridges: () => [{ program: "blender" }],
      getClients: () => [],
      registerPendingCommand: () => Promise.resolve({
        success: true,
        executed: 0,
        failed: 0,
        skipped: 1,
        errors: ["Unsupported language: powershell (skipped)"],
      }),
      recordBridgeProjectPath: () => false,
      broadcastBridgeStatus: () => undefined,
      broadcastToType: () => undefined,
    } as any;

    const app = new Hono();
    app.route(
      "/api/bridge-command",
      createBridgeCommandRoutes(
        fakeHub,
        ctx.apiKeysRepo,
        ctx.usersRepo,
        ctx.policiesRepo,
        ctx.headlessProgramsRepo,
        config,
        ctx.jobsRepo,
      ),
    );

    const res = await app.request("/api/bridge-command", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "blender",
        commands: [{ language: "powershell", script: "Write-Host hi" }],
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(String(body.error)).toContain("Unsupported language");
  });
});
