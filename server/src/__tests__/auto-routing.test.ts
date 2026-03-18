import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createJobRoutes } from "../routes/jobs.js";
import { createTestAgentConfig, createTestDb, createTestSession, createTestUser, type TestContext } from "./setup.js";
import { WebSocketHub } from "../ws/hub.js";
import { resolveAutoAgentByPriority } from "../agents/auto-routing.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("auto routing", () => {
  it("picks highest-priority config for simple prompts", () => {
    const low = createTestAgentConfig(ctx.agentsRepo, {
      name: "Low",
      engine: "claude-code",
      priority: 10,
    });
    const high = createTestAgentConfig(ctx.agentsRepo, {
      name: "High",
      engine: "local-oss",
      model: "qwen2.5-coder:7b",
      priority: 90,
    });

    const result = resolveAutoAgentByPriority(
      "hello",
      undefined,
      ctx.agentsRepo,
      ctx.settingsRepo,
    );
    expect(result.actualAgentConfigId).toBe(high.id);
    expect(result.routingReason).toBe("local");
    expect(result.actualAgentConfigId).not.toBe(low.id);
  });

  it("escalates complex prompts via fallbackConfigId", () => {
    const cloud = createTestAgentConfig(ctx.agentsRepo, {
      name: "Cloud Pro",
      engine: "claude-code",
      priority: 60,
    });
    const local = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local Fast",
      engine: "local-oss",
      model: "qwen2.5-coder:7b",
      priority: 95,
      fallbackConfigId: cloud.id,
    });

    const result = resolveAutoAgentByPriority(
      "Please provide architecture, test plan, performance analysis, and root cause across multiple files.\n\nInclude migration strategy.",
      undefined,
      ctx.agentsRepo,
      ctx.settingsRepo,
    );
    expect(result.actualAgentConfigId).toBe(cloud.id);
    expect(result.routingReason).toBe("cloud");
    expect(result.actualAgentConfigId).not.toBe(local.id);
  });

  it("escalates complex prompts to next priority config when no fallbackConfigId is set", () => {
    const cloud = createTestAgentConfig(ctx.agentsRepo, {
      name: "Cloud Next",
      engine: "claude-code",
      priority: 80,
    });
    const local = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local Top",
      engine: "local-oss",
      model: "qwen2.5:7b",
      priority: 95,
    });

    const result = resolveAutoAgentByPriority(
      "Need architecture, integration, migration, performance analysis, and a test plan across multiple files.",
      undefined,
      ctx.agentsRepo,
      ctx.settingsRepo,
    );
    expect(result.actualAgentConfigId).toBe(cloud.id);
    expect(result.routingReason).toBe("cloud");
    expect(result.actualAgentConfigId).not.toBe(local.id);
  });

  it("stores requested/actual routing metadata on created jobs", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "auto-routing-user",
      password: "auto-routing-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const cloud = createTestAgentConfig(ctx.agentsRepo, {
      name: "Cloud Fallback",
      engine: "claude-code",
      priority: 20,
    });
    createTestAgentConfig(ctx.agentsRepo, {
      name: "Local Primary",
      engine: "local-oss",
      model: "qwen2.5-coder:7b",
      priority: 80,
      fallbackConfigId: cloud.id,
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
      },
      body: JSON.stringify({
        prompt: "Need architecture and multi-file migration with test plan.",
        agentConfigId: "auto",
        priority: "normal",
        coordinationMode: "server",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestedAgentConfigId).toBe("auto");
    expect(body.actualAgentConfigId).toBe(cloud.id);
    expect(body.routingReason).toBe("cloud");
    expect(body.agentConfigId).toBe(cloud.id);
  });
});
