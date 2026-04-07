import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAgentRoutes } from "../routes/agents.js";
import { createAuthRoutes } from "../routes/auth.js";
import { createHeadlessProgramRoutes } from "../routes/headless-programs.js";
import { createPolicyRoutes } from "../routes/policies.js";
import { createProjectRoutes } from "../routes/projects.js";
import { createUserRoutes } from "../routes/users.js";
import { createWorkerRoutes } from "../routes/workers.js";
import { WebSocketHub } from "../ws/hub.js";
import { createTestDb, createTestSession, createTestUser, type TestContext } from "./setup.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("permission-gated routes", () => {
  it("rejects malformed login credential payloads with 400", async () => {
    await createTestUser(ctx.usersRepo, { username: "typed-login", password: "typed-login-pass" });

    const app = new Hono();
    app.route("/api/auth", createAuthRoutes(
      ctx.usersRepo,
      ctx.auditRepo,
      ctx.apiKeysRepo,
      ctx.settingsRepo,
    ));

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: { value: "typed-login" },
        password: ["typed-login-pass"],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_INPUT",
      error: "Username and password are required",
    });
  });

  it("allows non-admin users with manageUsers to list users", async () => {
    const manager = await createTestUser(ctx.usersRepo, { username: "manager", role: "user" });
    ctx.usersRepo.setPermissions(manager.id, {
      manageUsers: true,
      manageAgents: false,
      editCoordinator: false,
    });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, manager.id);
    const res = await app.request("/api/users", {
      headers: authHeader(session.token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("forbids users without manageUsers from listing users", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "basic", role: "user" });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, user.id);
    const res = await app.request("/api/users", {
      headers: authHeader(session.token),
    });

    expect(res.status).toBe(403);
  });

  it("prevents non-admin managers from creating admin-role users", async () => {
    const manager = await createTestUser(ctx.usersRepo, { username: "manager2", role: "user" });
    ctx.usersRepo.setPermissions(manager.id, {
      manageUsers: true,
      manageAgents: false,
      editCoordinator: false,
    });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, manager.id);
    const res = await app.request("/api/users", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "new-admin",
        password: "secret",
        role: "admin",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects too-short passwords when creating users", async () => {
    const admin = await createTestUser(ctx.usersRepo, {
      username: "admin-create-short",
      password: "admin-create-pass",
      role: "admin",
    });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, admin.id);
    const res = await app.request("/api/users", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "short-pass-user",
        password: "short",
        role: "user",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_INPUT",
      error: "Password must be at least 8 characters",
    });
  });

  it("returns user insights with usage totals and recent jobs for managers", async () => {
    const manager = await createTestUser(ctx.usersRepo, { username: "insights-manager", role: "user" });
    ctx.usersRepo.setPermissions(manager.id, {
      manageUsers: true,
      manageAgents: false,
      editCoordinator: false,
    });
    const target = await createTestUser(ctx.usersRepo, { username: "insights-target", role: "user" });
    const agent = ctx.agentsRepo.create({
      name: "Insights Agent",
      engine: "codex",
      command: "codex",
      args: [],
      model: "gpt-5",
      maxTurns: 20,
      priority: 50,
    });
    const job = ctx.jobsRepo.create(
      {
        prompt: "Build a prop pipeline helper",
        agentConfigId: agent.id,
        mode: "agentic" as const,
        priority: "normal",
        files: [],
        contextItems: [],
        coordinationMode: "server",
      },
      undefined,
      "houdini",
      "worker-a",
      undefined,
      target.id,
    );
    ctx.usageRepo.record(job.id, target.id, agent.id, 1200, 340, 9000);

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, manager.id);
    const res = await app.request(`/api/users/${target.id}/insights?limit=5`, {
      headers: authHeader(session.token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.username).toBe("insights-target");
    expect(body.usage.allTime.totalInput).toBe(1200);
    expect(body.usage.allTime.totalOutput).toBe(340);
    expect(body.jobs.counts.total).toBe(1);
    expect(body.jobs.recent).toHaveLength(1);
    expect(body.jobs.recent[0].id).toBe(job.id);
    expect(body.jobs.recent[0].tokenUsage?.inputTokens).toBe(1200);
    expect(body.jobs.recent[0].tokenUsage?.outputTokens).toBe(340);
  });

  it("rejects invalid token-limit payloads", async () => {
    const admin = await createTestUser(ctx.usersRepo, { username: "limit-admin", role: "admin" });
    const target = await createTestUser(ctx.usersRepo, { username: "limit-target", role: "user" });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));

    const session = createTestSession(ctx.usersRepo, admin.id);
    const res = await app.request(`/api/users/${target.id}/limits`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        inputLimit: -1,
        outputLimit: 1.5,
        period: "monthly",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_INPUT",
      error: "inputLimit and outputLimit must be non-negative safe integers or null",
    });
  });

  it("allows users with manageAgents to mutate agent configs", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "agent-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageUsers: false,
      manageAgents: true,
      editCoordinator: false,
    });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const session = createTestSession(ctx.usersRepo, operator.id);
    const res = await app.request("/api/agent-configs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Operator Agent",
        engine: "codex",
        command: "codex",
        args: [],
        model: "gpt-5",
        maxTurns: 30,
        priority: 50,
      }),
    });

    expect(res.status).toBe(201);
  });

  it("forbids users without manageAgents from mutating agent configs", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "no-agent-op", role: "user" });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const session = createTestSession(ctx.usersRepo, user.id);
    const res = await app.request("/api/agent-configs", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Should Fail",
        engine: "codex",
        command: "codex",
        args: [],
        priority: 50,
      }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects non-string worker IP allow/deny list entries", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "worker-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageWorkers: true,
    });
    const worker = ctx.workersRepo.upsert("worker-node", "houdini", "/tmp/demo", "10.0.0.5");

    const app = new Hono();
    app.route(
      "/api/workers",
      createWorkerRoutes(
        ctx.workersRepo,
        ctx.usersRepo,
        ctx.apiKeysRepo,
        ctx.auditRepo,
        new WebSocketHub(),
        ctx.settingsRepo,
      ),
    );

    const session = createTestSession(ctx.usersRepo, operator.id);
    const res = await app.request(`/api/workers/${worker.id}/rules`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ipAllowlist: ["10.0.0.5", { bad: true }],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_INPUT",
      error: "ipAllowlist must be an array of strings",
    });
  });

  it("rejects malformed project payloads", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "project-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageProjects: true,
    });

    const app = new Hono();
    app.route(
      "/api/projects",
      createProjectRoutes(ctx.projectsRepo, ctx.usersRepo, ctx.apiKeysRepo, ctx.auditRepo),
    );

    const session = createTestSession(ctx.usersRepo, operator.id);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "   ",
        pathMappings: "not-an-array",
        folders: { bad: true },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects malformed headless program updates", async () => {
    const admin = await createTestUser(ctx.usersRepo, { username: "headless-admin", role: "admin" });
    const created = ctx.headlessProgramsRepo.create({
      program: "houdini",
      displayName: "Houdini",
      executable: "/usr/bin/houdini",
      argsTemplate: ["--headless"],
      language: "python",
      enabled: true,
    });

    const app = new Hono();
    app.route(
      "/api/headless-programs",
      createHeadlessProgramRoutes(ctx.headlessProgramsRepo, ctx.usersRepo, ctx.apiKeysRepo),
    );

    const session = createTestSession(ctx.usersRepo, admin.id);
    const res = await app.request(`/api/headless-programs/${created.id}`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        executable: ["not-a-string"],
        argsTemplate: ["--headless", 1],
        enabled: "yes",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects malformed policy creation payloads", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "policy-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      managePolicies: true,
    });

    const app = new Hono();
    app.route(
      "/api/policies",
      createPolicyRoutes(ctx.policiesRepo, ctx.usersRepo, ctx.auditRepo),
    );

    const session = createTestSession(ctx.usersRepo, operator.id);
    const res = await app.request("/api/policies", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "command_filter",
        pattern: { bad: true },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("allows authenticated users to read local model catalog", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "local-model-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageUsers: false,
      manageAgents: true,
      editCoordinator: false,
    });
    const basic = await createTestUser(ctx.usersRepo, { username: "local-model-basic", role: "user" });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const operatorSession = createTestSession(ctx.usersRepo, operator.id);
    const basicSession = createTestSession(ctx.usersRepo, basic.id);

    const operatorRes = await app.request("/api/agent-configs/local-models?runtime=unsupported", {
      headers: authHeader(operatorSession.token),
    });
    const basicRes = await app.request("/api/agent-configs/local-models?runtime=unsupported", {
      headers: authHeader(basicSession.token),
    });

    expect(operatorRes.status).toBe(400);
    expect(basicRes.status).toBe(400);
  });

  it("gates local model pull behind manageAgents permission", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "local-pull-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageUsers: false,
      manageAgents: true,
      editCoordinator: false,
    });
    const basic = await createTestUser(ctx.usersRepo, { username: "local-pull-basic", role: "user" });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const body = JSON.stringify({ runtime: "unsupported", model: "llama3.2:latest" });
    const allowedSession = createTestSession(ctx.usersRepo, operator.id);
    const forbiddenSession = createTestSession(ctx.usersRepo, basic.id);

    const allowedRes = await app.request("/api/agent-configs/local-models/pull", {
      method: "POST",
      headers: {
        ...authHeader(allowedSession.token),
        "content-type": "application/json",
      },
      body,
    });
    const forbiddenRes = await app.request("/api/agent-configs/local-models/pull", {
      method: "POST",
      headers: {
        ...authHeader(forbiddenSession.token),
        "content-type": "application/json",
      },
      body,
    });

    expect(allowedRes.status).toBe(400);
    expect(forbiddenRes.status).toBe(403);
  });

  it("gates streamed local model pull behind manageAgents permission", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "local-pull-stream-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageUsers: false,
      manageAgents: true,
      editCoordinator: false,
    });
    const basic = await createTestUser(ctx.usersRepo, { username: "local-pull-stream-basic", role: "user" });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const body = JSON.stringify({ runtime: "unsupported", model: "llama3.2:latest" });
    const allowedSession = createTestSession(ctx.usersRepo, operator.id);
    const forbiddenSession = createTestSession(ctx.usersRepo, basic.id);

    const allowedRes = await app.request("/api/agent-configs/local-models/pull/stream", {
      method: "POST",
      headers: {
        ...authHeader(allowedSession.token),
        "content-type": "application/json",
      },
      body,
    });
    const forbiddenRes = await app.request("/api/agent-configs/local-models/pull/stream", {
      method: "POST",
      headers: {
        ...authHeader(forbiddenSession.token),
        "content-type": "application/json",
      },
      body,
    });

    expect(allowedRes.status).toBe(400);
    expect(forbiddenRes.status).toBe(403);
  });

  it("gates local model allowlist updates behind manageAgents permission", async () => {
    const operator = await createTestUser(ctx.usersRepo, { username: "local-allowlist-op", role: "user" });
    ctx.usersRepo.setPermissions(operator.id, {
      manageUsers: false,
      manageAgents: true,
      editCoordinator: false,
    });
    const basic = await createTestUser(ctx.usersRepo, { username: "local-allowlist-basic", role: "user" });

    const app = new Hono();
    app.route(
      "/api/agent-configs",
      createAgentRoutes(
        ctx.agentsRepo,
        ctx.usersRepo,
        ctx.auditRepo,
        ctx.apiKeysRepo,
        ctx.settingsRepo,
      ),
    );

    const body = JSON.stringify({
      runtime: "unsupported",
      models: ["qwen2.5-coder:7b", "qwen2.5-coder:14b"],
    });
    const allowedSession = createTestSession(ctx.usersRepo, operator.id);
    const forbiddenSession = createTestSession(ctx.usersRepo, basic.id);

    const allowedRes = await app.request("/api/agent-configs/local-models/allowlist", {
      method: "PUT",
      headers: {
        ...authHeader(allowedSession.token),
        "content-type": "application/json",
      },
      body,
    });
    const forbiddenRes = await app.request("/api/agent-configs/local-models/allowlist", {
      method: "PUT",
      headers: {
        ...authHeader(forbiddenSession.token),
        "content-type": "application/json",
      },
      body,
    });

    expect(allowedRes.status).toBe(400);
    expect(forbiddenRes.status).toBe(403);
  });
});

describe("password change routes", () => {
  it("requires password confirmation when changing own password", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "self-change-user",
      password: "oldpass",
      role: "user",
    });

    const app = new Hono();
    app.route("/api/auth", createAuthRoutes(ctx.usersRepo, ctx.auditRepo, ctx.apiKeysRepo, ctx.settingsRepo));
    const session = createTestSession(ctx.usersRepo, user.id);

    const missingConfirmRes = await app.request("/api/auth/password", {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "oldpass",
        newPassword: "newpass1",
      }),
    });
    expect(missingConfirmRes.status).toBe(400);

    const mismatchRes = await app.request("/api/auth/password", {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "oldpass",
        newPassword: "newpass1",
        confirmNewPassword: "wrongpass",
      }),
    });
    expect(mismatchRes.status).toBe(400);

    const successRes = await app.request("/api/auth/password", {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "oldpass",
        newPassword: "newpass1",
        confirmNewPassword: "newpass1",
      }),
    });
    expect(successRes.status).toBe(200);

    const oldResult = await ctx.usersRepo.verifyPassword("self-change-user", "oldpass");
    expect(oldResult).toBeNull();
    const newResult = await ctx.usersRepo.verifyPassword("self-change-user", "newpass1");
    expect(newResult).toBeTruthy();
  });

  it("requires old password and confirmation for user password resets", async () => {
    const manager = await createTestUser(ctx.usersRepo, { username: "manager-reset", role: "user" });
    ctx.usersRepo.setPermissions(manager.id, {
      manageUsers: true,
      manageAgents: false,
      editCoordinator: false,
    });
    const target = await createTestUser(ctx.usersRepo, {
      username: "target-reset",
      password: "target-old",
      role: "user",
    });

    const app = new Hono();
    app.route("/api/users", createUserRoutes(ctx.usersRepo, ctx.auditRepo, ctx.jobsRepo, ctx.usageRepo));
    const session = createTestSession(ctx.usersRepo, manager.id);

    const missingOldRes = await app.request(`/api/users/${target.id}/password`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        newPassword: "target-new",
        confirmNewPassword: "target-new",
      }),
    });
    expect(missingOldRes.status).toBe(400);

    const mismatchRes = await app.request(`/api/users/${target.id}/password`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        oldPassword: "target-old",
        newPassword: "target-new",
        confirmNewPassword: "different",
      }),
    });
    expect(mismatchRes.status).toBe(400);

    const wrongOldRes = await app.request(`/api/users/${target.id}/password`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        oldPassword: "wrong-old",
        newPassword: "target-new",
        confirmNewPassword: "target-new",
      }),
    });
    expect(wrongOldRes.status).toBe(401);

    const successRes = await app.request(`/api/users/${target.id}/password`, {
      method: "PUT",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        oldPassword: "target-old",
        newPassword: "target-new",
        confirmNewPassword: "target-new",
      }),
    });
    expect(successRes.status).toBe(200);

    const oldResult = await ctx.usersRepo.verifyPassword("target-reset", "target-old");
    expect(oldResult).toBeNull();
    const newResult = await ctx.usersRepo.verifyPassword("target-reset", "target-new");
    expect(newResult).toBeTruthy();
  });
});
