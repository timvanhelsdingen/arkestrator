import { describe, test, expect, beforeEach } from "bun:test";
import { createTestDb, createTestUser, type TestContext } from "./setup";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

describe("User creation and password verification", () => {
  test("creates a user and verifies correct password", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "alice",
      password: "secret123",
    });

    expect(user.username).toBe("alice");
    expect(user.role).toBe("user");
    expect(user.id).toBeTruthy();

    const verified = await ctx.usersRepo.verifyPassword("alice", "secret123");
    expect(verified).toBeTruthy();
    expect(verified!.id).toBe(user.id);
  });

  test("rejects wrong password", async () => {
    await createTestUser(ctx.usersRepo, {
      username: "bob",
      password: "correct",
    });

    const verified = await ctx.usersRepo.verifyPassword("bob", "wrong");
    expect(verified).toBeNull();
  });

  test("rejects non-existent user", async () => {
    const verified = await ctx.usersRepo.verifyPassword("nobody", "pass");
    expect(verified).toBeNull();
  });

  test("creates admin user", async () => {
    const admin = await createTestUser(ctx.usersRepo, {
      username: "admin",
      password: "admin",
      role: "admin",
    });
    expect(admin.role).toBe("admin");
  });
});

describe("Session management", () => {
  test("creates and validates a session", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const session = ctx.usersRepo.createSession(user.id);

    expect(session.token).toBeTruthy();
    expect(session.userId).toBe(user.id);

    const result = ctx.usersRepo.validateSession(session.token);
    expect(result).toBeTruthy();
    expect(result!.user.id).toBe(user.id);
    expect(result!.session.token).toBe(session.token);
  });

  test("rejects invalid session token", () => {
    const result = ctx.usersRepo.validateSession("invalid-token");
    expect(result).toBeNull();
  });

  test("deletes a session", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const session = ctx.usersRepo.createSession(user.id);

    const deleted = ctx.usersRepo.deleteSession(session.token);
    expect(deleted).toBe(true);

    const result = ctx.usersRepo.validateSession(session.token);
    expect(result).toBeNull();
  });

  test("cleans up expired sessions", async () => {
    const user = await createTestUser(ctx.usersRepo);
    // Create a session with 0ms duration (already expired)
    const session = ctx.usersRepo.createSession(user.id, 0);

    // Should be expired already
    const result = ctx.usersRepo.validateSession(session.token);
    expect(result).toBeNull();
  });

  test("refreshes a valid session expiry", async () => {
    const user = await createTestUser(ctx.usersRepo);
    const session = ctx.usersRepo.createSession(user.id, 60_000);

    const original = ctx.usersRepo.validateSession(session.token);
    expect(original).toBeTruthy();
    const originalExpiry = original!.session.expiresAt;

    const refreshed = ctx.usersRepo.refreshSession(session.token, 120_000);
    expect(refreshed).toBe(true);

    const updated = ctx.usersRepo.validateSession(session.token);
    expect(updated).toBeTruthy();
    expect(updated!.session.expiresAt > originalExpiry).toBe(true);
  });
});

describe("API key management", () => {
  test("creates and validates an API key", async () => {
    const { rawKey } = await ctx.apiKeysRepo.create("test-key", "client");
    expect(rawKey).toMatch(/^ark_/);

    const valid = await ctx.apiKeysRepo.validate(rawKey);
    expect(valid).toBeTruthy();
    expect(valid!.name).toBe("test-key");
    expect(valid!.role).toBe("client");
  });

  test("rejects invalid API key", async () => {
    const valid = await ctx.apiKeysRepo.validate("ark_invalid");
    expect(valid).toBeNull();
  });

  test("revokes an API key", async () => {
    const { apiKey, rawKey } = await ctx.apiKeysRepo.create("revocable", "bridge");
    ctx.apiKeysRepo.revoke(apiKey.id);

    const valid = await ctx.apiKeysRepo.validate(rawKey);
    expect(valid).toBeNull();
  });

  test("revokes keys by name prefix", async () => {
    await ctx.apiKeysRepo.create("auto:user:123:a", "client");
    await ctx.apiKeysRepo.create("auto:user:123:b", "client");
    await ctx.apiKeysRepo.create("other-key", "client");

    ctx.apiKeysRepo.revokeByNamePrefix("auto:user:123");

    const keys = ctx.apiKeysRepo.list();
    const active = keys.filter((k) => !k.revokedAt);
    expect(active.length).toBe(1);
    expect(active[0].name).toBe("other-key");
  });
});

describe("Password change", () => {
  test("changes password successfully", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "changer",
      password: "oldpass",
    });

    await ctx.usersRepo.updatePassword(user.id, "newpass");

    const oldResult = await ctx.usersRepo.verifyPassword("changer", "oldpass");
    expect(oldResult).toBeNull();

    const newResult = await ctx.usersRepo.verifyPassword("changer", "newpass");
    expect(newResult).toBeTruthy();
  });
});

describe("User CRUD", () => {
  test("lists all users", async () => {
    await createTestUser(ctx.usersRepo, { username: "a" });
    await createTestUser(ctx.usersRepo, { username: "b" });

    const users = ctx.usersRepo.list();
    expect(users.length).toBe(2);
  });

  test("gets user by id", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "findme" });
    const found = ctx.usersRepo.getById(user.id);
    expect(found).toBeTruthy();
    expect(found!.username).toBe("findme");
  });

  test("deletes user and their sessions", async () => {
    const user = await createTestUser(ctx.usersRepo);
    ctx.usersRepo.createSession(user.id);

    const deleted = ctx.usersRepo.delete(user.id);
    expect(deleted).toBe(true);

    const found = ctx.usersRepo.getById(user.id);
    expect(found).toBeNull();
  });

  test("updates user role", async () => {
    const user = await createTestUser(ctx.usersRepo, { role: "user" });
    ctx.usersRepo.updateRole(user.id, "admin");

    const updated = ctx.usersRepo.getById(user.id);
    expect(updated!.role).toBe("admin");
  });

  test("applies default permissions by role", async () => {
    const admin = await createTestUser(ctx.usersRepo, { username: "perm-admin", role: "admin" });
    const user = await createTestUser(ctx.usersRepo, { username: "perm-user", role: "user" });

    expect(admin.permissions.manageUsers).toBe(true);
    expect(admin.permissions.manageAgents).toBe(true);
    expect(admin.permissions.editCoordinator).toBe(true);
    expect(admin.permissions.useMcp).toBe(true);

    expect(user.permissions.manageUsers).toBe(false);
    expect(user.permissions.manageAgents).toBe(false);
    expect(user.permissions.editCoordinator).toBe(false);
    expect(user.permissions.useMcp).toBe(true);
  });

  test("updates explicit permissions", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "perm-edit" });
    const changed = ctx.usersRepo.setPermissions(user.id, {
      manageUsers: true,
      manageAgents: true,
      editCoordinator: false,
      useMcp: false,
    });
    expect(changed).toBe(true);

    const updated = ctx.usersRepo.getById(user.id);
    expect(updated?.permissions.manageUsers).toBe(true);
    expect(updated?.permissions.manageAgents).toBe(true);
    expect(updated?.permissions.editCoordinator).toBe(false);
    expect(updated?.permissions.useMcp).toBe(false);
  });

  test("defaults client coordination preference to disabled", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "coord-default" });
    expect(user.clientCoordinationEnabled).toBe(false);
  });

  test("updates client coordination preference", async () => {
    const user = await createTestUser(ctx.usersRepo, { username: "coord-toggle" });
    const changed = ctx.usersRepo.setClientCoordinationEnabled(user.id, true);
    expect(changed).toBe(true);

    const updated = ctx.usersRepo.getById(user.id);
    expect(updated?.clientCoordinationEnabled).toBe(true);
  });

  test("isEmpty returns true for empty DB", () => {
    expect(ctx.usersRepo.isEmpty()).toBe(true);
  });

  test("isEmpty returns false after adding a user", async () => {
    await createTestUser(ctx.usersRepo);
    expect(ctx.usersRepo.isEmpty()).toBe(false);
  });
});
