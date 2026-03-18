import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createChatRoutes } from "../routes/chat.js";
import { createJobRoutes } from "../routes/jobs.js";
import { createTestDb, createTestSession, createTestUser, type TestContext } from "./setup.js";
import { loadConfig } from "../config.js";
import { WebSocketHub } from "../ws/hub.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("local model allowlist route enforcement", () => {
  it("blocks chat and job submissions that use non-allowed local models", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "allowlist-user",
      password: "allowlist-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const localConfig = ctx.agentsRepo.create({
      name: "Local Runner",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5-coder:7b",
      maxTurns: 100,
      priority: 50,
    });

    ctx.settingsRepo.set(
      "local_model_allowlist_v1:ollama",
      JSON.stringify(["qwen2.5-coder:7b"]),
    );

    const hub = new WebSocketHub();
    const app = new Hono();
    app.route("/api/chat", createChatRoutes({
      agentsRepo: ctx.agentsRepo,
      usersRepo: ctx.usersRepo,
      apiKeysRepo: ctx.apiKeysRepo,
      settingsRepo: ctx.settingsRepo,
      workersRepo: ctx.workersRepo,
      hub,
      config: loadConfig(),
    }));
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

    const blockedChat = await app.request("/api/chat", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "hello",
        agentConfigId: localConfig.id,
        runtimeOptions: { model: "llama3.2:latest" },
      }),
    });
    expect(blockedChat.status).toBe(403);

    const blockedJob = await app.request("/api/jobs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "hello",
        agentConfigId: localConfig.id,
        runtimeOptions: { model: "llama3.2:latest" },
        priority: "normal",
        coordinationMode: "server",
      }),
    });
    expect(blockedJob.status).toBe(403);
  });
});
