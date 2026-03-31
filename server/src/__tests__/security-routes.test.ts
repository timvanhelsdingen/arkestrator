import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import type { Config } from "../config.js";
import { WebSocketHub } from "../ws/hub.js";
import { createBridgeCommandRoutes } from "../routes/bridge-commands.js";
import { createJobRoutes } from "../routes/jobs.js";
import { createSyncRoutes } from "../routes/sync.js";
import { createApiKeyRoutes } from "../routes/apikeys.js";
import { SyncManager } from "../workspace/sync-manager.js";
import {
  createTestAgentConfig,
  createTestDb,
  type TestContext,
} from "./setup.js";

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createConfig(syncTempDir: string): Config {
  return {
    port: 7800,
    dataDir: syncTempDir,
    dbPath: ":memory:",
    maxConcurrentAgents: 1,
    workerPollMs: 500,
    jobTimeoutMs: 30_000,
    logLevel: "error",
    syncTempDir,
    syncTtlMs: 60_000,
    syncCleanupIntervalMs: 30_000,
    syncMaxSizeMb: 10,
    defaultWorkspaceMode: "auto",
    headlessTempDir: join(syncTempDir, "headless"),
    comfyuiUrl: "http://127.0.0.1:8188",
    seedExampleHeadlessPrograms: false,
    headlessExecutableHints: {},
    coordinatorScriptsDir: join(syncTempDir, "coordinator-scripts"),
    coordinatorPlaybooksDir: join(syncTempDir, "coordinator-playbooks"),
    skillsDir: join(syncTempDir, "skills"),
    coordinatorImportsDir: join(syncTempDir, "coordinator-imports"),
    snapshotsDir: join(syncTempDir, "snapshots"),
    coordinatorReferencePaths: [],
    coordinatorPlaybookSourcePaths: [],
    corsOrigins: [],
    trustProxyHeaders: false,
  };
}

describe("security route hardening", () => {
  let ctx: TestContext;
  let hub: WebSocketHub;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    ctx = createTestDb();
    hub = new WebSocketHub();
    tempDir = mkdtempSync(join(tmpdir(), "ark-security-routes-"));
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

  it("denies bridge API keys from listing jobs", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const { rawKey } = await ctx.apiKeysRepo.create("bridge-key", "bridge");
    const res = await app.request("/api/jobs", {
      headers: authHeader(rawKey),
    });

    expect(res.status).toBe(403);
  });

  it("denies bridge API keys from mutating the shared runtime config", async () => {
    const app = new Hono();
    app.route("/api/keys", createApiKeyRoutes(ctx.apiKeysRepo, ctx.usersRepo, ctx.auditRepo));

    const { rawKey } = await ctx.apiKeysRepo.create("bridge-key", "bridge");
    const res = await app.request("/api/keys/share", {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKey: rawKey }),
    });

    expect(res.status).toBe(403);
  });

  it("allows client API keys to create jobs but blocks mutation", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Security Agent" });
    const { rawKey } = await ctx.apiKeysRepo.create("client-key", "client");

    const createRes = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "run task",
        agentConfigId: agent.id,
        priority: "normal",
        editorContext: { projectRoot: "/tmp/demo" },
      }),
    });
    expect(createRes.status).toBe(201);
    const createdJob = await createRes.json();

    const cancelRes = await app.request(`/api/jobs/${createdJob.id}/cancel`, {
      method: "POST",
      headers: authHeader(rawKey),
    });
    expect(cancelRes.status).toBe(403);
  });

  it("allows admin API keys to mutate jobs", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Security Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "queued",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");

    const cancelRes = await app.request(`/api/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: authHeader(rawKey),
    });
    expect(cancelRes.status).toBe(200);
  });

  it("kills running processes when cancelling via REST", async () => {
    const killed: string[] = [];
    const processTracker = {
      kill(jobId: string) {
        killed.push(jobId);
        return true;
      },
    };

    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
        undefined,
        undefined,
        [],
        processTracker as any,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Cancel Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(job.id);

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const cancelRes = await app.request(`/api/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: authHeader(rawKey),
    });

    expect(cancelRes.status).toBe(200);
    expect(killed).toEqual([job.id]);
  });

  it("auto-cancels and deletes a running job via REST delete", async () => {
    const killed: string[] = [];
    const processTracker = {
      kill(jobId: string) {
        killed.push(jobId);
        return true;
      },
    };

    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
        undefined,
        undefined,
        [],
        processTracker as any,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Delete Active Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(job.id);

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const deleteRes = await app.request(`/api/jobs/${job.id}`, {
      method: "DELETE",
      headers: authHeader(rawKey),
    });

    expect(deleteRes.status).toBe(200);
    expect(killed).toEqual([job.id]);
    expect(ctx.jobsRepo.getById(job.id)).toBeNull();
  });

  it("bulk delete auto-cancels active jobs before removing them", async () => {
    const killed: string[] = [];
    const processTracker = {
      kill(jobId: string) {
        killed.push(jobId);
        return true;
      },
    };

    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
        undefined,
        undefined,
        [],
        processTracker as any,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Bulk Delete Agent" });
    const queued = ctx.jobsRepo.create({
      prompt: "queued job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    const running = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(running.id);
    const completed = ctx.jobsRepo.create({
      prompt: "completed job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(completed.id);
    ctx.jobsRepo.complete(completed.id, [], "done");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const deleteRes = await app.request("/api/jobs/bulk-delete", {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobIds: [queued.id, running.id, completed.id] }),
    });

    expect(deleteRes.status).toBe(200);
    expect(killed).toEqual([running.id]);
    expect(ctx.jobsRepo.getById(queued.id)).toBeNull();
    expect(ctx.jobsRepo.getById(running.id)).toBeNull();
    expect(ctx.jobsRepo.getById(completed.id)).toBeNull();
  });

  it("requeues an entire dependency tree when requeueing the top job", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Tree Agent" });
    const root = ctx.jobsRepo.create({
      name: "root-top",
      prompt: "root",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(root.id);
    ctx.jobsRepo.fail(root.id, "root failed", "logs");

    const childA = ctx.jobsRepo.create(
      {
        name: "child-a",
        prompt: "child-a",
        agentConfigId: agent.id,
        priority: "normal",
        editorContext: { projectRoot: "/tmp/demo" },
        files: [],
        contextItems: [],
        coordinationMode: "server",
      },
      undefined,
      "godot",
      undefined,
      undefined,
      undefined,
      root.id,
    );
    ctx.jobsRepo.claim(childA.id);
    ctx.jobsRepo.complete(childA.id, [], "done");

    const childB = ctx.jobsRepo.create(
      {
        name: "child-b",
        prompt: "child-b",
        agentConfigId: agent.id,
        priority: "normal",
        editorContext: { projectRoot: "/tmp/demo" },
        files: [],
        contextItems: [],
        coordinationMode: "server",
      },
      undefined,
      "godot",
      undefined,
      undefined,
      undefined,
      root.id,
    );
    ctx.depsRepo.add(childB.id, childA.id);
    ctx.jobsRepo.claim(childB.id);
    ctx.jobsRepo.complete(childB.id, [], "done");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const requeueRes = await app.request(`/api/jobs/${root.id}/requeue`, {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(requeueRes.status).toBe(201);
    const payload = await requeueRes.json() as { id: string; requeuedTreeSize?: number };
    expect(payload.id).toBeTruthy();
    expect(Number(payload.requeuedTreeSize ?? 0)).toBe(3);

    const all = ctx.jobsRepo.list().jobs;
    const newRoot = all.find((j) => j.id === payload.id);
    expect(newRoot).toBeTruthy();
    expect(newRoot?.status).toBe("queued");

    const newChildren = all.filter((j) => j.parentJobId === payload.id);
    expect(newChildren.length).toBe(2);
    expect(newChildren.every((j) => j.status === "queued")).toBe(true);

    const newChildA = newChildren.find((j) => j.name === "child-a");
    const newChildB = newChildren.find((j) => j.name === "child-b");
    expect(newChildA?.id).toBeTruthy();
    expect(newChildB?.id).toBeTruthy();
    expect(ctx.depsRepo.getDependencies(newChildB!.id)).toContain(newChildA!.id);
  });

  it("rejects malformed JSON when requeueing a job", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Requeue Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "failed job",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.fail(job.id, "boom", "stack");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const res = await app.request(`/api/jobs/${job.id}/requeue`, {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: "{bad json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_JSON",
    });
  });

  it("allows admin API keys to set finished job outcome feedback", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Outcome Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "finished",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.complete(job.id, [], "done");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const outcomeRes = await app.request(`/api/jobs/${job.id}/outcome`, {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rating: "good",
        notes: "Solid result",
      }),
    });
    expect(outcomeRes.status).toBe(200);

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated?.outcomeRating).toBe("positive");
    expect(updated?.outcomeNotes).toBe("Solid result");
  });

  it("auto-organizes outcome feedback by used bridges when bridgeProgram is missing", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
        undefined,
        config.coordinatorPlaybooksDir,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Outcome Agent" });
    const job = ctx.jobsRepo.create({
      prompt: "finished",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });
    ctx.jobsRepo.addUsedBridge(job.id, "godot");
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.complete(job.id, [], "done");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const outcomeRes = await app.request(`/api/jobs/${job.id}/outcome`, {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rating: "positive",
        notes: "Solid result",
      }),
    });
    expect(outcomeRes.status).toBe(200);

    const learningFilePath = join(config.coordinatorPlaybooksDir, "_learning", "godot.experiences.json");
    expect(existsSync(learningFilePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(learningFilePath, "utf-8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.metadata?.jobId).toBe(job.id);
    expect(entries[0]?.metadata?.bridgeProgram).toBe("godot");
    expect(entries[0]?.metadata?.usedBridges).toEqual(["godot"]);

    const artifactDir = join(
      config.coordinatorPlaybooksDir,
      "_learning",
      "jobs",
      "godot",
    );
    const artifactName = readdirSync(artifactDir).find((name) => name.endsWith(`--${job.id}.json`));
    expect(Boolean(artifactName)).toBe(true);
    const artifactPath = join(artifactDir, artifactName as string);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
    expect(artifact?.program).toBe("godot");
    expect(artifact?.signal).toBe("positive");
    expect(artifact?.metadata?.jobId).toBe(job.id);
    expect(artifact?.job?.id).toBe(job.id);
    expect(typeof artifact?.job?.logs).toBe("string");
  });

  it("propagates root job outcome feedback to finished delegated sub-jobs", async () => {
    const app = new Hono();
    app.route(
      "/api/jobs",
      createJobRoutes(
        ctx.jobsRepo,
        ctx.agentsRepo,
        ctx.policiesRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.usageRepo,
        ctx.depsRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
        hub,
        undefined,
        config.coordinatorPlaybooksDir,
      ),
    );

    const agent = createTestAgentConfig(ctx.agentsRepo, { name: "Outcome Agent" });
    const root = ctx.jobsRepo.create({
      prompt: "Build scene and delegate texture generation",
      agentConfigId: agent.id,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
      name: "Scene root",
    });
    ctx.jobsRepo.addUsedBridge(root.id, "blender");
    ctx.jobsRepo.claim(root.id);
    ctx.jobsRepo.complete(root.id, [], "root done");

    const child = ctx.jobsRepo.create(
      {
        prompt: "Generate texture set",
        agentConfigId: agent.id,
        priority: "normal",
        editorContext: { projectRoot: "/tmp/demo" },
        files: [],
        contextItems: [],
        coordinationMode: "server",
        name: "Texture child",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      root.id,
    );
    ctx.jobsRepo.addUsedBridge(child.id, "comfyui");
    ctx.jobsRepo.claim(child.id);
    ctx.jobsRepo.complete(child.id, [], "child done");

    const { rawKey } = await ctx.apiKeysRepo.create("admin-key", "admin");
    const outcomeRes = await app.request(`/api/jobs/${root.id}/outcome`, {
      method: "POST",
      headers: {
        ...authHeader(rawKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rating: "good",
        notes: "Great pipeline split",
      }),
    });
    expect(outcomeRes.status).toBe(200);
    const body = await outcomeRes.json() as { propagatedJobIds?: string[] };
    expect(body.propagatedJobIds).toContain(child.id);

    const updatedRoot = ctx.jobsRepo.getById(root.id);
    const updatedChild = ctx.jobsRepo.getById(child.id);
    expect(updatedRoot?.outcomeRating).toBe("positive");
    expect(updatedChild?.outcomeRating).toBe("positive");
    expect(updatedChild?.outcomeNotes).toContain("Inherited from root job");

    const comfyArtifactDir = join(
      config.coordinatorPlaybooksDir,
      "_learning",
      "jobs",
      "comfyui",
    );
    const comfyArtifactName = readdirSync(comfyArtifactDir).find((name) => name.endsWith(`--${child.id}.json`));
    expect(Boolean(comfyArtifactName)).toBe(true);
    const comfyArtifact = JSON.parse(
      readFileSync(join(comfyArtifactDir, comfyArtifactName as string), "utf-8"),
    );
    expect(comfyArtifact?.metadata?.rootJobId).toBe(root.id);
    expect(comfyArtifact?.metadata?.inheritedRootOutcome).toBe(true);
    expect(comfyArtifact?.job?.parentJobId).toBe(root.id);
  });

  it("denies bridge-role API keys on bridge-command routes", async () => {
    const app = new Hono();
    app.route(
      "/api/bridge-command",
      createBridgeCommandRoutes(
        hub,
        ctx.apiKeysRepo,
        ctx.usersRepo,
        ctx.policiesRepo,
        ctx.headlessProgramsRepo,
        config,
      ),
    );

    const { rawKey } = await ctx.apiKeysRepo.create("bridge-key", "bridge");
    const res = await app.request("/api/bridge-command/bridges", {
      headers: authHeader(rawKey),
    });
    expect(res.status).toBe(401);
  });

  it("enforces sync upload role and traversal validation", async () => {
    const syncManager = new SyncManager(config);
    const app = new Hono();
    app.route("/api/sync", createSyncRoutes(syncManager, ctx.apiKeysRepo));

    const { rawKey: clientKey } = await ctx.apiKeysRepo.create("client-key", "client");
    const deniedRes = await app.request("/api/sync/job1/upload", {
      method: "POST",
      headers: {
        ...authHeader(clientKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: [{ path: "ok.txt", content: "data" }],
      }),
    });
    expect(deniedRes.status).toBe(403);

    const { rawKey: bridgeKey } = await ctx.apiKeysRepo.create("bridge-key", "bridge");
    const traversalRes = await app.request("/api/sync/job1/upload", {
      method: "POST",
      headers: {
        ...authHeader(bridgeKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: [{ path: "../escape.txt", content: "owned" }],
      }),
    });
    expect(traversalRes.status).toBe(400);
    const body = await traversalRes.json();
    expect(String(body.error ?? "")).toContain("Path escapes sync directory");
  });
});
