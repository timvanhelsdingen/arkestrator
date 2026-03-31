import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createMcpRoutes } from "../mcp/routes.js";
import { createTestDb, createTestUser, createTestSession } from "./setup.js";
import { WebSocketHub } from "../ws/hub.js";
import { WorkerResourceLeaseManager } from "../agents/resource-control.js";

function buildInitializeRequest() {
  return {
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arkestrator-test", version: "1.0.0" },
    },
  };
}

describe("MCP route auth", () => {
  it("denies MCP access for users with useMcp disabled", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-deny-user" });
    const session = createTestSession(ctx.usersRepo, user.id);
    const changed = ctx.usersRepo.setPermissions(user.id, { useMcp: false });
    expect(changed).toBe(true);

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildInitializeRequest()),
    });

    expect(res.status).toBe(401);
  });

  it("allows MCP access for users with useMcp enabled", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-allow-user" });
    const session = createTestSession(ctx.usersRepo, user.id);
    const changed = ctx.usersRepo.setPermissions(user.id, { useMcp: true });
    expect(changed).toBe(true);

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildInitializeRequest()),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result?.serverInfo?.name).toBe("arkestrator");
  });

  it("denies MCP access for auto user API keys when owner useMcp is disabled", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-api-key-deny-user" });
    const changed = ctx.usersRepo.setPermissions(user.id, { useMcp: false });
    expect(changed).toBe(true);
    const { rawKey } = await ctx.apiKeysRepo.create(`auto:user:${user.id}`, "client");

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildInitializeRequest()),
    });

    expect(res.status).toBe(401);
  });

  it("allows MCP access for auto user API keys when owner useMcp is enabled", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-api-key-allow-user" });
    const changed = ctx.usersRepo.setPermissions(user.id, { useMcp: true });
    expect(changed).toBe(true);
    const { rawKey } = await ctx.apiKeysRepo.create(`auto:user:${user.id}`, "client");

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildInitializeRequest()),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result?.serverInfo?.name).toBe("arkestrator");
  });

  it("returns 400 for malformed MCP JSON payloads", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-bad-json-user" });
    const session = createTestSession(ctx.usersRepo, user.id);

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_JSON",
      error: "Invalid JSON body",
    });
  });

  it("returns 400 for non-object MCP payloads", async () => {
    const ctx = createTestDb();
    const user = await createTestUser(ctx.usersRepo, { username: "mcp-bad-shape-user" });
    const session = createTestSession(ctx.usersRepo, user.id);

    const app = new Hono();
    app.route("/mcp", createMcpRoutes({
      hub: new WebSocketHub(),
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    }, ctx.apiKeysRepo, ctx.usersRepo));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify("not-an-object"),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_INPUT",
      error: "Invalid MCP request body",
    });
  });
});
