import { describe, test, expect, beforeEach } from "bun:test";
import {
  createTestDb,
  createTestUser,
  createTestAgentConfig,
  createTestJob,
  type TestContext,
} from "./setup";

let ctx: TestContext;

beforeEach(async () => {
  ctx = createTestDb();
});

describe("Token limit settings", () => {
  test("user starts with no limits", async () => {
    const user = await createTestUser(ctx.usersRepo);
    expect(user.tokenLimitInput).toBeNull();
    expect(user.tokenLimitOutput).toBeNull();
    expect(user.tokenLimitPeriod).toBe("monthly");
  });

  test("sets token limits on a user", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const updated = ctx.usersRepo.setTokenLimits(user.id, 100000, 50000, "monthly");
    expect(updated).toBe(true);

    const found = ctx.usersRepo.getById(user.id)!;
    expect(found.tokenLimitInput).toBe(100000);
    expect(found.tokenLimitOutput).toBe(50000);
    expect(found.tokenLimitPeriod).toBe("monthly");
  });

  test("clears token limits by setting null", async () => {
    const user = await createTestUser(ctx.usersRepo);
    ctx.usersRepo.setTokenLimits(user.id, 100000, 50000, "monthly");
    ctx.usersRepo.setTokenLimits(user.id, null, null, "monthly");

    const found = ctx.usersRepo.getById(user.id)!;
    expect(found.tokenLimitInput).toBeNull();
    expect(found.tokenLimitOutput).toBeNull();
  });

  test("supports all period types", async () => {
    const user = await createTestUser(ctx.usersRepo);

    ctx.usersRepo.setTokenLimits(user.id, 1000, 500, "daily");
    expect(ctx.usersRepo.getById(user.id)!.tokenLimitPeriod).toBe("daily");

    ctx.usersRepo.setTokenLimits(user.id, 1000, 500, "monthly");
    expect(ctx.usersRepo.getById(user.id)!.tokenLimitPeriod).toBe("monthly");

    ctx.usersRepo.setTokenLimits(user.id, 1000, 500, "unlimited");
    expect(ctx.usersRepo.getById(user.id)!.tokenLimitPeriod).toBe("unlimited");
  });

  test("returns false for non-existent user", () => {
    const updated = ctx.usersRepo.setTokenLimits("nonexistent", 1000, 500, "monthly");
    expect(updated).toBe(false);
  });
});

describe("Per-user usage aggregation", () => {
  test("aggregates usage for a user since a date", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const config = createTestAgentConfig(ctx.agentsRepo);
    const j1 = createTestJob(ctx.jobsRepo, config.id, { submittedBy: user.id });
    const j2 = createTestJob(ctx.jobsRepo, config.id, { submittedBy: user.id });

    ctx.usageRepo.record(j1.id, user.id, config.id, 100, 50, 1000);
    ctx.usageRepo.record(j2.id, user.id, config.id, 200, 100, 2000);

    const usage = ctx.usageRepo.getByUserIdSince(user.id, "1970-01-01T00:00:00.000Z");
    expect(usage.totalInput).toBe(300);
    expect(usage.totalOutput).toBe(150);
    expect(usage.jobCount).toBe(2);
  });

  test("filters by since date", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const config = createTestAgentConfig(ctx.agentsRepo);
    const j1 = createTestJob(ctx.jobsRepo, config.id, { submittedBy: user.id });

    ctx.usageRepo.record(j1.id, user.id, config.id, 100, 50, 1000);

    // Query from the future — should return 0
    const usage = ctx.usageRepo.getByUserIdSince(user.id, "2099-01-01T00:00:00.000Z");
    expect(usage.totalInput).toBe(0);
    expect(usage.totalOutput).toBe(0);
    expect(usage.jobCount).toBe(0);
  });

  test("does not count other users' usage", async () => {
    const user1 = await createTestUser(ctx.usersRepo, { username: "user1" });
    const user2 = await createTestUser(ctx.usersRepo, { username: "user2" });
    const config = createTestAgentConfig(ctx.agentsRepo);
    const j1 = createTestJob(ctx.jobsRepo, config.id, { submittedBy: user1.id });
    const j2 = createTestJob(ctx.jobsRepo, config.id, { submittedBy: user2.id });

    ctx.usageRepo.record(j1.id, user1.id, config.id, 1000, 500, 5000);
    ctx.usageRepo.record(j2.id, user2.id, config.id, 2000, 1000, 10000);

    const usage1 = ctx.usageRepo.getByUserIdSince(user1.id, "1970-01-01T00:00:00.000Z");
    expect(usage1.totalInput).toBe(1000);
    expect(usage1.totalOutput).toBe(500);

    const usage2 = ctx.usageRepo.getByUserIdSince(user2.id, "1970-01-01T00:00:00.000Z");
    expect(usage2.totalInput).toBe(2000);
    expect(usage2.totalOutput).toBe(1000);
  });

  test("returns zero for user with no usage", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const usage = ctx.usageRepo.getByUserIdSince(user.id, "1970-01-01T00:00:00.000Z");
    expect(usage.totalInput).toBe(0);
    expect(usage.totalOutput).toBe(0);
    expect(usage.jobCount).toBe(0);
  });
});
