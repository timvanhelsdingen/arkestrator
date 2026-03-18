import { describe, test, expect, beforeEach } from "bun:test";
import {
  createTestDb,
  createTestUser,
  createTestAgentConfig,
  createTestJob,
  type TestContext,
} from "./setup";

let ctx: TestContext;
let agentConfigId: string;

beforeEach(async () => {
  ctx = createTestDb();
  const config = createTestAgentConfig(ctx.agentsRepo);
  agentConfigId = config.id;
});

describe("Job creation", () => {
  test("creates a job with queued status", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    expect(job.status).toBe("queued");
    expect(job.prompt).toBe("Test prompt");
    expect(job.priority).toBe("normal");
    expect(job.agentConfigId).toBe(agentConfigId);
    expect(job.id).toBeTruthy();
    expect(job.createdAt).toBeTruthy();
  });

  test("defaults coordination mode to server", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    expect(job.coordinationMode).toBe("server");
  });

  test("stores explicit client coordination mode", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      coordinationMode: "client",
    });
    expect(job.coordinationMode).toBe("client");
  });

  test("creates a paused job with startPaused", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      startPaused: true,
    });
    expect(job.status).toBe("paused");
  });

  test("creates a job with custom priority", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      priority: "high",
    });
    expect(job.priority).toBe("high");
  });

  test("creates a job with submittedBy", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      submittedBy: user.id,
    });
    expect(job.submittedBy).toBe(user.id);
  });

  test("does not mark inferred bridge hints as used before execution", () => {
    const job = ctx.jobsRepo.create(
      {
        prompt: "Target blender if needed.",
        agentConfigId,
        priority: "normal",
        coordinationMode: "server",
        files: [],
        contextItems: [],
      },
      undefined,
      "blender",
    );

    expect(job.bridgeProgram).toBe("blender");
    expect(job.usedBridges).toEqual([]);
  });
});

describe("Job lifecycle", () => {
  test("claims a queued job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    const claimed = ctx.jobsRepo.claim(job.id);
    expect(claimed).toBe(true);

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("running");
    expect(updated!.startedAt).toBeTruthy();
  });

  test("cannot claim a non-queued job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      startPaused: true,
    });
    const claimed = ctx.jobsRepo.claim(job.id);
    expect(claimed).toBe(false);
  });

  test("completes a job with file changes", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    const files = [
      { path: "test.txt", content: "hello", action: "create" as const },
    ];
    ctx.jobsRepo.complete(job.id, files, "some logs");

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("completed");
    expect(updated!.result).toHaveLength(1);
    expect(updated!.result![0].path).toBe("test.txt");
    expect(updated!.completedAt).toBeTruthy();
  });

  test("completes a job with commands", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    const commands = [
      { language: "gdscript", script: "print('hello')", description: "test" },
    ];
    ctx.jobsRepo.completeWithCommands(job.id, commands, "logs");

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("completed");
    expect(updated!.commands).toHaveLength(1);
  });

  test("fails a job with error", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    ctx.jobsRepo.fail(job.id, "something went wrong", "error logs");

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBe("something went wrong");
  });

  test("records outcome feedback on a finished job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.complete(job.id, [], "done");

    const marked = ctx.jobsRepo.markOutcome(job.id, "average", "Partially worked");
    expect(marked).toBe(true);

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.outcomeRating).toBe("average");
    expect(updated!.outcomeNotes).toBe("Partially worked");
    expect(updated!.outcomeMarkedAt).toBeTruthy();
  });

  test("cancels a queued job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    const cancelled = ctx.jobsRepo.cancel(job.id);
    expect(cancelled).toBe(true);

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("cancelled");
  });

  test("cancels a running job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    const cancelled = ctx.jobsRepo.cancel(job.id);
    expect(cancelled).toBe(true);
  });

  test("cannot cancel a completed job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.complete(job.id, [], "");

    const cancelled = ctx.jobsRepo.cancel(job.id);
    expect(cancelled).toBe(false);
  });

  test("resumes a paused job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      startPaused: true,
    });
    expect(job.status).toBe("paused");

    const resumed = ctx.jobsRepo.resume(job.id);
    expect(resumed).toBe(true);

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.status).toBe("queued");
  });

  test("cannot resume a non-paused job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    const resumed = ctx.jobsRepo.resume(job.id);
    expect(resumed).toBe(false);
  });
});

describe("Job deletion", () => {
  test("deletes a completed job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.complete(job.id, [], "");

    const deleted = ctx.jobsRepo.delete(job.id);
    expect(deleted).toBe(true);

    const found = ctx.jobsRepo.getById(job.id);
    expect(found).toBeNull();
  });

  test("deletes a failed job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);
    ctx.jobsRepo.fail(job.id, "error", "");

    const deleted = ctx.jobsRepo.delete(job.id);
    expect(deleted).toBe(true);
  });

  test("cannot delete a running job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    const deleted = ctx.jobsRepo.delete(job.id);
    expect(deleted).toBe(false);
  });

  test("cannot delete a queued job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    const deleted = ctx.jobsRepo.delete(job.id);
    expect(deleted).toBe(false);
  });

  test("bulk deletes finished jobs", () => {
    const j1 = createTestJob(ctx.jobsRepo, agentConfigId);
    const j2 = createTestJob(ctx.jobsRepo, agentConfigId);
    const j3 = createTestJob(ctx.jobsRepo, agentConfigId);

    ctx.jobsRepo.claim(j1.id);
    ctx.jobsRepo.complete(j1.id, [], "");
    ctx.jobsRepo.claim(j2.id);
    ctx.jobsRepo.fail(j2.id, "err", "");
    // j3 stays queued — should not be deleted

    const deleted = ctx.jobsRepo.deleteBulk([j1.id, j2.id, j3.id]);
    expect(deleted).toBe(2);
  });
});

describe("Job listing and filtering", () => {
  test("lists all jobs", () => {
    createTestJob(ctx.jobsRepo, agentConfigId);
    createTestJob(ctx.jobsRepo, agentConfigId);

    const { jobs, total } = ctx.jobsRepo.list();
    expect(jobs.length).toBe(2);
    expect(total).toBe(2);
  });

  test("filters by status", () => {
    const j1 = createTestJob(ctx.jobsRepo, agentConfigId);
    createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(j1.id);

    const { jobs, total } = ctx.jobsRepo.list(["running"]);
    expect(jobs.length).toBe(1);
    expect(total).toBe(1);
    expect(jobs[0].status).toBe("running");
  });

  test("paginates results", () => {
    for (let i = 0; i < 5; i++) {
      createTestJob(ctx.jobsRepo, agentConfigId, { prompt: `Job ${i}` });
    }

    const page1 = ctx.jobsRepo.list(undefined, 2, 0);
    expect(page1.jobs.length).toBe(2);
    expect(page1.total).toBe(5);

    const page2 = ctx.jobsRepo.list(undefined, 2, 2);
    expect(page2.jobs.length).toBe(2);

    const page3 = ctx.jobsRepo.list(undefined, 2, 4);
    expect(page3.jobs.length).toBe(1);
  });
});

describe("Priority ordering (pickNext)", () => {
  test("picks highest priority first", () => {
    createTestJob(ctx.jobsRepo, agentConfigId, { priority: "low" });
    createTestJob(ctx.jobsRepo, agentConfigId, { priority: "critical" });
    createTestJob(ctx.jobsRepo, agentConfigId, { priority: "normal" });

    const next = ctx.jobsRepo.pickNext();
    expect(next).toBeTruthy();
    expect(next!.priority).toBe("critical");
  });

  test("picks FIFO within same priority", () => {
    const j1 = createTestJob(ctx.jobsRepo, agentConfigId, {
      prompt: "first",
    });
    createTestJob(ctx.jobsRepo, agentConfigId, { prompt: "second" });

    const next = ctx.jobsRepo.pickNext();
    expect(next!.id).toBe(j1.id);
  });

  test("returns null when no queued jobs", () => {
    const next = ctx.jobsRepo.pickNext();
    expect(next).toBeNull();
  });

  test("skips paused jobs", () => {
    createTestJob(ctx.jobsRepo, agentConfigId, { startPaused: true });
    const next = ctx.jobsRepo.pickNext();
    expect(next).toBeNull();
  });
});

describe("Job dependencies", () => {
  test("blocks job with unsatisfied dependency", () => {
    const parent = createTestJob(ctx.jobsRepo, agentConfigId);
    const child = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.depsRepo.add(child.id, parent.id);

    // Child should not be picked while parent is queued
    const next = ctx.jobsRepo.pickNext();
    expect(next!.id).toBe(parent.id);
  });

  test("unblocks job when dependency completes", () => {
    const parent = createTestJob(ctx.jobsRepo, agentConfigId);
    const child = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.depsRepo.add(child.id, parent.id);

    // Complete the parent
    ctx.jobsRepo.claim(parent.id);
    ctx.jobsRepo.complete(parent.id, [], "");

    // Now child should be pickable
    const next = ctx.jobsRepo.pickNext();
    expect(next!.id).toBe(child.id);
  });

  test("getDependencies returns dependency IDs", () => {
    const parent = createTestJob(ctx.jobsRepo, agentConfigId);
    const child = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.depsRepo.add(child.id, parent.id);

    const deps = ctx.depsRepo.getDependencies(child.id);
    expect(deps).toContain(parent.id);
  });

  test("getDependents returns dependent IDs", () => {
    const parent = createTestJob(ctx.jobsRepo, agentConfigId);
    const child = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.depsRepo.add(child.id, parent.id);

    const dependents = ctx.depsRepo.getDependents(parent.id);
    expect(dependents).toContain(child.id);
  });

  test("getBlockingDeps returns incomplete dependencies", () => {
    const parent = createTestJob(ctx.jobsRepo, agentConfigId);
    const child = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.depsRepo.add(child.id, parent.id);

    const blocking = ctx.depsRepo.getBlockingDeps(child.id);
    expect(blocking).toContain(parent.id);

    // Complete parent
    ctx.jobsRepo.claim(parent.id);
    ctx.jobsRepo.complete(parent.id, [], "");

    const blockingAfter = ctx.depsRepo.getBlockingDeps(child.id);
    expect(blockingAfter).toHaveLength(0);
  });
});

describe("Reprioritize", () => {
  test("reprioritizes a queued job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId, {
      priority: "low",
    });
    const updated = ctx.jobsRepo.reprioritize(job.id, "critical");
    expect(updated).toBe(true);

    const found = ctx.jobsRepo.getById(job.id);
    expect(found!.priority).toBe("critical");
  });

  test("cannot reprioritize a running job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(job.id);

    const updated = ctx.jobsRepo.reprioritize(job.id, "critical");
    expect(updated).toBe(false);
  });
});

describe("Agent config CRUD", () => {
  test("creates and retrieves config", () => {
    const config = createTestAgentConfig(ctx.agentsRepo, {
      name: "My Agent",
      engine: "gemini",
    });
    expect(config.name).toBe("My Agent");
    expect(config.engine).toBe("gemini");

    const found = ctx.agentsRepo.getById(config.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("My Agent");
  });

  test("lists configs", () => {
    createTestAgentConfig(ctx.agentsRepo, { name: "A" });
    createTestAgentConfig(ctx.agentsRepo, { name: "B" });

    const configs = ctx.agentsRepo.list();
    // beforeEach creates 1 config + 2 here = 3 total
    expect(configs.length).toBe(3);
  });

  test("deletes config", () => {
    const config = createTestAgentConfig(ctx.agentsRepo);
    const result = ctx.agentsRepo.delete(config.id);
    expect(result).toBe("ok");
    expect(ctx.agentsRepo.getById(config.id)).toBeNull();
  });
});

describe("Usage tracking", () => {
  test("records and retrieves usage stats", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.usageRepo.record(job.id, null, agentConfigId, 1000, 500, 5000);

    const stats = ctx.usageRepo.getByJobId(job.id);
    expect(stats).toBeTruthy();
    expect(stats!.inputTokens).toBe(1000);
    expect(stats!.outputTokens).toBe(500);
    expect(stats!.durationMs).toBe(5000);
  });

  test("batch retrieves usage stats", () => {
    const j1 = createTestJob(ctx.jobsRepo, agentConfigId);
    const j2 = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.usageRepo.record(j1.id, null, agentConfigId, 100, 50, 1000);
    ctx.usageRepo.record(j2.id, null, agentConfigId, 200, 100, 2000);

    const map = ctx.usageRepo.getByJobIds([j1.id, j2.id]);
    expect(map.size).toBe(2);
    expect(map.get(j1.id)!.inputTokens).toBe(100);
    expect(map.get(j2.id)!.inputTokens).toBe(200);
  });

  test("aggregate stats", () => {
    const j1 = createTestJob(ctx.jobsRepo, agentConfigId);
    const j2 = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.usageRepo.record(j1.id, null, agentConfigId, 100, 50, 1000);
    ctx.usageRepo.record(j2.id, null, agentConfigId, 200, 100, 2000);

    const agg = ctx.usageRepo.getStats();
    expect(agg.totalInput).toBe(300);
    expect(agg.totalOutput).toBe(150);
    expect(agg.totalDuration).toBe(3000);
    expect(agg.jobCount).toBe(2);
  });
});

describe("Log appending", () => {
  test("appends logs to a job", () => {
    const job = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.appendLog(job.id, "line 1\n");
    ctx.jobsRepo.appendLog(job.id, "line 2\n");

    const updated = ctx.jobsRepo.getById(job.id);
    expect(updated!.logs).toBe("line 1\nline 2\n");
  });
});

describe("Dashboard stats", () => {
  test("returns correct dashboard stats", () => {
    const today = new Date().toISOString().split("T")[0];
    createTestJob(ctx.jobsRepo, agentConfigId);
    const j2 = createTestJob(ctx.jobsRepo, agentConfigId);
    ctx.jobsRepo.claim(j2.id);

    const stats = ctx.jobsRepo.getDashboardStats(today);
    expect(stats.totalJobs).toBe(2);
    expect(stats.activeJobs).toBe(1);
    expect(stats.queuedJobs).toBe(1);
  });
});
