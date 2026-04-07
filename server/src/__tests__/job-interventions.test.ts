import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createJobRoutes } from "../routes/jobs.js";
import { WebSocketHub } from "../ws/hub.js";
import { buildOperatorNotesBlock, getJobInterventionSupport } from "../agents/job-interventions.js";
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

describe("job interventions", () => {
  it("allows an owner to submit and list queued operator notes", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "intervene-owner",
      password: "intervene-owner-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Queued Agent",
      engine: "claude-code",
    });
    const job = ctx.jobsRepo.create({
      prompt: "queued job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, user.id);

    const app = createJobsApp();
    const createRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Keep the roof edge tighter and avoid extra trim pieces.",
        source: "jobs",
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.intervention.status).toBe("pending");
    expect(created.support.acceptsQueuedNotes).toBe(true);
    expect(created.support.acceptsLiveNotes).toBe(false);

    const listRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      headers: authHeader(session.token),
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.interventions).toHaveLength(1);
    expect(listed.interventions[0].text).toContain("roof edge tighter");
  });

  it("allows admins to intervene on other users' jobs", async () => {
    const owner = await createTestUser(ctx.usersRepo, {
      username: "intervene-job-owner",
      password: "intervene-job-owner-pass",
      role: "user",
    });
    const admin = await createTestUser(ctx.usersRepo, {
      username: "intervene-admin",
      password: "intervene-admin-pass",
      role: "admin",
    });
    const adminSession = createTestSession(ctx.usersRepo, admin.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Queued Agent",
      engine: "claude-code",
    });
    const job = ctx.jobsRepo.create({
      prompt: "queued job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, owner.id);

    const app = createJobsApp();
    const res = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(adminSession.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Use thicker corner posts.",
        source: "chat",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.intervention.authorUsername).toBe("intervene-admin");
  });

  it("forbids users without interveneJobs permission even on their own jobs", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "intervene-blocked",
      password: "intervene-blocked-pass",
      role: "user",
    });
    ctx.usersRepo.setPermissions(user.id, { interveneJobs: false });
    const session = createTestSession(ctx.usersRepo, user.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Queued Agent",
      engine: "claude-code",
    });
    const job = ctx.jobsRepo.create({
      prompt: "queued job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, user.id);

    const app = createJobsApp();
    const res = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Use a narrower doorway.",
        source: "jobs",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("accepts live notes for running Claude jobs", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "intervene-live-blocked",
      password: "intervene-live-blocked-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Cloud Agent",
      engine: "claude-code",
    });
    const job = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, user.id);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.setWorkspaceMode(job.id, "command");

    const app = createJobsApp();
    const res = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Make the porch wider.",
        source: "jobs",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.intervention.status).toBe("pending");
    expect(body.support.acceptsLiveNotes).toBe(true);
  });

  it("accepts live notes for running local command-mode jobs and preserves repo ordering/status", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "intervene-live-ok",
      password: "intervene-live-ok-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local Agent",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5:14b",
    });
    const job = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, user.id);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.setWorkspaceMode(job.id, "command");

    const app = createJobsApp();
    const firstRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Square up the door opening.",
        source: "chat",
      }),
    });
    const secondRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Darken the roof shingles.",
        source: "jobs",
      }),
    });

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);

    const pending = ctx.jobInterventionsRepo.listPending(job.id);
    expect(pending).toHaveLength(2);
    expect(pending[0].text).toContain("door opening");
    expect(pending[1].text).toContain("roof shingles");

    const delivered = ctx.jobInterventionsRepo.markDelivered(
      [pending[0].id],
      { channel: "local-agentic-turn", turn: 3 },
      "Delivered on next turn boundary.",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("delivered");
    expect(delivered[0].deliveryMetadata?.turn).toBe(3);

    const rejected = ctx.jobInterventionsRepo.rejectPendingForJob(
      job.id,
      "Job completed before delivery.",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe("rejected");
    expect(rejected[0].statusReason).toBe("Job completed before delivery.");

    const notesBlock = buildOperatorNotesBlock(delivered);
    expect(notesBlock).toContain("## Operator Notes");
    expect(notesBlock).toContain("Square up the door opening.");

    const support = getJobInterventionSupport(ctx.jobsRepo.getById(job.id)!, ctx.agentsRepo);
    expect(support.acceptsLiveNotes).toBe(true);
  });

  it("marks pending live guidance delivered when the same running job fetches it via API key + X-Job-Id", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "intervene-self-fetch",
      password: "intervene-self-fetch-pass",
      role: "user",
    });
    const session = createTestSession(ctx.usersRepo, user.id);
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "Codex Agent",
      engine: "codex",
      command: "codex",
    });
    const job = ctx.jobsRepo.create({
      prompt: "running job",
      agentConfigId: config.id,
      mode: "agentic" as const,
      priority: "normal",
      coordinationMode: "server",
      files: [],
      contextItems: [],
    }, undefined, undefined, undefined, undefined, user.id);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.setWorkspaceMode(job.id, "repo");

    const app = createJobsApp();
    const createRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Add a stronger bevel to the railing.",
        source: "jobs",
      }),
    });

    expect(createRes.status).toBe(201);
    expect(ctx.jobInterventionsRepo.listPending(job.id)).toHaveLength(1);

    const { rawKey } = await ctx.apiKeysRepo.create("runtime-client", "client");
    const listRes = await app.request(`/api/jobs/${job.id}/interventions`, {
      headers: {
        authorization: `Bearer ${rawKey}`,
        "x-job-id": job.id,
      },
    });

    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(Array.isArray(listed.interventions)).toBe(true);
    expect(listed.interventions[0].status).toBe("delivered");
    expect(listed.interventions[0].deliveryMetadata?.channel).toBe("agent-poll");
    expect(ctx.jobInterventionsRepo.listPending(job.id)).toHaveLength(0);
  });
});
