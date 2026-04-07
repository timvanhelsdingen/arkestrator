import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createJobRoutes } from "../routes/jobs.js";
import { createTestAgentConfig, createTestDb, createTestSession, createTestUser, type TestContext } from "./setup.js";
import { WebSocketHub } from "../ws/hub.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("jobs route bridge-program inference", () => {
  it("does not infer bridgeProgram from ambient live bridge state", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "infer-single-user",
      password: "infer-single-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const cfg = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5:14b",
    });

    const hub = new WebSocketHub();
    (hub as any).getBridges = () => [
      { id: "b1", type: "bridge", role: "admin", workerName: "ws-1", program: "godot" },
    ];

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
      hub,
    ));

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Add a label in the current godot scene.",
        agentConfigId: cfg.id,
        priority: "normal",
        coordinationMode: "server",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bridgeProgram).toBeUndefined();
  });

  it("preserves explicit bridgeProgram from the request", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "infer-worker-user",
      password: "infer-worker-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const cfg = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5:14b",
    });

    const hub = new WebSocketHub();
    (hub as any).getBridges = () => [
      { id: "b1", type: "bridge", role: "admin", workerName: "ws-godot", program: "godot" },
      { id: "b2", type: "bridge", role: "admin", workerName: "ws-blender", program: "blender" },
    ];

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
      hub,
    ));

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Add a centered label.",
        agentConfigId: cfg.id,
        priority: "normal",
        bridgeProgram: "godot",
        coordinationMode: "server",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bridgeProgram).toBe("godot");
  });

  it("links job submissions to the caller job when x-job-id is present", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "infer-parent-user",
      password: "infer-parent-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const cfg = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5:14b",
    });

    const parent = ctx.jobsRepo.create({
      prompt: "orchestrate follow-up work",
      agentConfigId: cfg.id,
      mode: "agentic" as const,
      priority: "normal",
      editorContext: { projectRoot: "/tmp/demo" },
      files: [],
      contextItems: [],
      coordinationMode: "server",
    });

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
      new WebSocketHub(),
    ));

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
        "x-job-id": parent.id,
      },
      body: JSON.stringify({
        prompt: "render the texture variation",
        agentConfigId: cfg.id,
        priority: "normal",
        coordinationMode: "server",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.parentJobId).toBe(parent.id);
  });
});
