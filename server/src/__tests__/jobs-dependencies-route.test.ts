import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createJobRoutes } from "../routes/jobs.js";
import { WebSocketHub } from "../ws/hub.js";
import {
  createTestAgentConfig,
  createTestDb,
  createTestSession,
  createTestUser,
  type TestContext,
} from "./setup.js";

let ctx: TestContext;

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createJobsApp() {
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
    ctx.jobInterventionsRepo,
    new WebSocketHub(),
  ));
  return app;
}

beforeEach(() => {
  ctx = createTestDb();
});

describe("POST /api/jobs/:id/dependencies", () => {
  async function signedInAdmin() {
    const user = await createTestUser(ctx.usersRepo, {
      username: "dep-route-admin",
      password: "dep-route-admin-pass",
      role: "admin",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    return { user, session };
  }

  function makeJob(agentConfigId: string) {
    return ctx.jobsRepo.create(
      {
        prompt: "p",
        agentConfigId,
        mode: "agentic" as const,
        priority: "normal",
        coordinationMode: "server",
        files: [],
        contextItems: [],
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  it("rejects an edge that would close a cycle", async () => {
    const { session } = await signedInAdmin();
    const config = createTestAgentConfig(ctx.agentsRepo);
    const a = makeJob(config.id);
    const b = makeJob(config.id);
    const c = makeJob(config.id);
    // Existing chain: a -> b -> c (a depends on b depends on c).
    ctx.depsRepo.add(a.id, b.id);
    ctx.depsRepo.add(b.id, c.id);

    const app = createJobsApp();
    // Attempt to add c -> a. That would form c -> a -> b -> c.
    const res = await app.request(`/api/jobs/${c.id}/dependencies`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ dependsOnJobId: a.id }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toContain("Circular dependency");
    // And the edge must NOT have been persisted.
    expect(ctx.depsRepo.getDependencies(c.id)).not.toContain(a.id);
  });

  it("rejects a self-loop", async () => {
    const { session } = await signedInAdmin();
    const config = createTestAgentConfig(ctx.agentsRepo);
    const a = makeJob(config.id);

    const app = createJobsApp();
    const res = await app.request(`/api/jobs/${a.id}/dependencies`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ dependsOnJobId: a.id }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cannot depend on itself");
  });

  it("accepts a safe edge", async () => {
    const { session } = await signedInAdmin();
    const config = createTestAgentConfig(ctx.agentsRepo);
    const a = makeJob(config.id);
    const b = makeJob(config.id);

    const app = createJobsApp();
    const res = await app.request(`/api/jobs/${a.id}/dependencies`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ dependsOnJobId: b.id }),
    });

    expect(res.status).toBe(200);
    expect(ctx.depsRepo.getDependencies(a.id)).toContain(b.id);
  });
});
