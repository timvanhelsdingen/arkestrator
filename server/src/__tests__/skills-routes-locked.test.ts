/**
 * Regression tests for the locked-flag contract on the skills REST route.
 *
 * The contract (see routes/skills.ts PUT /:slug):
 *   - A locked skill refuses all PUTs...
 *   - ...EXCEPT a standalone `{ locked: false }` payload, which unlocks it.
 *     Any extra field in the body (even alongside locked:false) is rejected
 *     with 423 so the user must unlock in one step and edit in another.
 *   - DELETE is refused on a locked skill.
 *
 * Before the fix the route dropped `locked` from the update schema entirely,
 * so the admin UI toggle was silently swallowed and nothing persisted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrations.js";
import { SkillsRepo } from "../db/skills.repo.js";
import { UsersRepo } from "../db/users.repo.js";
import { ApiKeysRepo } from "../db/apikeys.repo.js";
import { SettingsRepo } from "../db/settings.repo.js";
import { SkillIndex } from "../skills/skill-index.js";
import { createSkillsRoutes } from "../routes/skills.js";

async function setup() {
  const db = new Database(":memory:");
  runMigrations(db);

  const skillsRepo = new SkillsRepo(db);
  const usersRepo = new UsersRepo(db);
  const apiKeysRepo = new ApiKeysRepo(db);
  const settingsRepo = new SettingsRepo(db);

  const skillIndex = new SkillIndex(() => skillsRepo.list({ includeDisabled: true }), settingsRepo);
  skillIndex.refresh();

  const { rawKey } = await apiKeysRepo.create("test-admin", "admin");

  const app = new Hono();
  app.route(
    "/api/skills",
    createSkillsRoutes(skillsRepo, skillIndex, usersRepo, apiKeysRepo, settingsRepo),
  );

  const seed = skillsRepo.create({
    name: "Lock Target",
    slug: "lock-target",
    program: "global",
    category: "custom",
    title: "Lock Target",
    description: "",
    content: "# Lock Target\n\nTest skill for locked-flag regressions.",
  });
  skillIndex.refresh();

  return { db, skillsRepo, skillIndex, apiKeysRepo, app, rawKey, seed };
}

function auth(rawKey: string) {
  return { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" };
}

describe("skills route locked-flag contract", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => {
    try { ctx.db.close(); } catch { /* ignore */ }
  });

  it("lock then unlock round-trips and persists via GET", async () => {
    // Lock
    let res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ locked: true }),
    });
    expect(res.status).toBe(200);
    let body: any = await res.json();
    expect(body.skill.locked).toBe(true);

    // Verify via fresh GET (hits the refreshed index)
    ctx.skillIndex.refresh();
    res = await ctx.app.request("/api/skills/lock-target", { headers: auth(ctx.rawKey) });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.skill.locked).toBe(true);

    // Unlock via standalone PUT
    res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ locked: false }),
    });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.skill.locked).toBe(false);
  });

  it("rejects non-lock edits on a locked skill with 423", async () => {
    ctx.skillsRepo.update("lock-target", { locked: true }, "global");
    ctx.skillIndex.refresh();

    const res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ title: "Changed" }),
    });
    expect(res.status).toBe(423);
    const body: any = await res.json();
    expect(body.code).toBe("LOCKED");
  });

  it("rejects mixed payloads that bundle unlock with other edits", async () => {
    ctx.skillsRepo.update("lock-target", { locked: true }, "global");
    ctx.skillIndex.refresh();

    const res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ locked: false, title: "Changed" }),
    });
    expect(res.status).toBe(423);
  });

  it("accepts a standalone unlock PUT", async () => {
    ctx.skillsRepo.update("lock-target", { locked: true }, "global");
    ctx.skillIndex.refresh();

    const res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ locked: false }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.skill.locked).toBe(false);
  });

  it("refuses DELETE on a locked skill, then allows it after unlock", async () => {
    ctx.skillsRepo.update("lock-target", { locked: true }, "global");
    ctx.skillIndex.refresh();

    let res = await ctx.app.request("/api/skills/lock-target", {
      method: "DELETE",
      headers: auth(ctx.rawKey),
    });
    expect(res.status).toBe(423);

    // Unlock via the allowed standalone PUT path
    res = await ctx.app.request("/api/skills/lock-target", {
      method: "PUT",
      headers: auth(ctx.rawKey),
      body: JSON.stringify({ locked: false }),
    });
    expect(res.status).toBe(200);
    ctx.skillIndex.refresh();

    // Then DELETE should succeed
    res = await ctx.app.request("/api/skills/lock-target", {
      method: "DELETE",
      headers: auth(ctx.rawKey),
    });
    expect(res.status).toBe(200);
  });
});
