import { Hono } from "hono";
import { TOTP, Secret } from "otpauth";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { getAuthenticatedUser, getClientIp } from "../middleware/auth.js";
import { readSharedConfig, writeSharedConfig } from "../utils/shared-config.js";
import { loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { generateRandomHex } from "../utils/crypto.js";
import { errorResponse } from "../utils/errors.js";
import {
  MIN_PASSWORD_LENGTH,
  passwordLengthError,
  readNonEmptyPassword,
  readNonEmptyTrimmedString,
} from "../utils/credentials.js";
import { parseCoordinatorReferencePaths } from "../agents/coordinator-playbooks.js";
import { getNetworkControls } from "../security/network-policy.js";

// Simple in-memory rate limiter for auth endpoints
const loginAttempts = new Map<
  string,
  { count: number; resetAt: number; windowMs: number; max: number }
>();

function checkRateLimit(
  ip: string,
  config: { windowMs: number; max: number },
): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (
    !entry
    || now > entry.resetAt
    || entry.windowMs !== config.windowMs
    || entry.max !== config.max
  ) {
    loginAttempts.set(ip, {
      count: 1,
      resetAt: now + config.windowMs,
      windowMs: config.windowMs,
      max: config.max,
    });
    return true;
  }
  entry.count++;
  return entry.count <= config.max;
}

// Periodically clean up expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

// Pending 2FA challenges (in-memory, short-lived)
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingChallenges = new Map<
  string,
  { userId: string; username: string; role: string; expiresAt: number }
>();

// Cleanup expired challenges every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, challenge] of pendingChallenges) {
    if (now > challenge.expiresAt) pendingChallenges.delete(id);
  }
}, 2 * 60 * 1000);

function generateChallengeToken(): string {
  return generateRandomHex(32);
}

const RECOVERY_CODE_COUNT = 8;

function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    codes.push(generateRandomHex(4));
  }
  return codes;
}

function canManageCoordinator(
  user: { id: string; role: string; permissions?: { editCoordinator?: boolean } },
  settingsRepo: SettingsRepo,
): boolean {
  if (user.role === "admin") return true;
  if (user.permissions?.editCoordinator) return true;
  const editors = new Set(
    parseCoordinatorReferencePaths(settingsRepo.get("coordinator_editors")),
  );
  return editors.has(user.id);
}

export function createAuthRoutes(
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
  apiKeysRepo: ApiKeysRepo,
  settingsRepo: SettingsRepo,
) {
  const router = new Hono();

  /** Complete login: create session + provision API key */
  async function completeLogin(
    userId: string,
    username: string,
    role: string,
    ip: string | undefined,
  ) {
    const currentUser = usersRepo.getById(userId);
    const resolvedUsername = currentUser?.username ?? username;
    const resolvedRole = currentUser?.role ?? role;
    const allowClientCoordination = settingsRepo.getBool("allow_client_coordination");
    const resolvedUser = currentUser ?? {
      id: userId,
      username: resolvedUsername,
      role: resolvedRole,
      permissions: {
        manageUsers: false,
        manageAgents: false,
        manageProjects: false,
        managePolicies: false,
        manageApiKeys: false,
        manageConnections: false,
        manageWorkers: false,
        manageSecurity: false,
        viewAuditLog: false,
        viewUsage: false,
        editCoordinator: false,
        useMcp: false,
        interveneJobs: false,
      },
    };
    const canEditCoordinator = canManageCoordinator(resolvedUser, settingsRepo);

    const session = usersRepo.createSession(userId);

    // Auto-provision an API key for the client.
    // Do NOT revoke older keys here: active bridges may still be using them
    // and revoking on every login causes bridge desync/disconnect loops.
    const keyPrefix = `auto:user:${userId}`;
    const { rawKey } = await apiKeysRepo.create(
      keyPrefix,
      resolvedRole === "admin" ? "admin" : "client",
    );

    // Write server-side shared config (for spawned agents on this machine).
    // Only overwrite if the user has MCP permission or the existing shared
    // key is invalid.  The server startup always seeds a "Runtime Shared Key"
    // (admin role) that grants MCP access.  Overwriting it with a restricted
    // user key would break MCP calls from spawned agents.
    try {
      const config = loadConfig();
      if (resolvedUser.permissions.useMcp === true) {
        writeSharedConfig(config.port, rawKey);
      } else {
        // Check if current shared key is still valid; only overwrite if it's broken
        const existingShared = readSharedConfig();
        const existingKey = String(existingShared?.apiKey ?? "").trim();
        let existingKeyValid = false;
        if (existingKey) {
          try {
            existingKeyValid = !!(await apiKeysRepo.validate(existingKey));
          } catch {
            existingKeyValid = false;
          }
        }
        if (!existingKeyValid) {
          writeSharedConfig(config.port, rawKey);
        }
      }
    } catch {
      // Non-critical
    }

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      apiKey: rawKey,
      allowClientCoordination,
      canEditCoordinator,
      user: {
        id: userId,
        username: resolvedUsername,
        role: resolvedRole,
        permissions: resolvedUser.permissions,
        require2fa: currentUser?.require2fa ?? false,
        clientCoordinationEnabled: currentUser?.clientCoordinationEnabled ?? false,
      },
    };
  }

  // Login
  router.post("/login", async (c) => {
    const ip = getClientIp(c) ?? "unknown";
    const rate = getNetworkControls(settingsRepo).rateLimits.login;
    if (!checkRateLimit(ip, rate)) {
      logger.warn("auth", `Rate limit exceeded for IP: ${ip}`);
      return errorResponse(c, 429, "Too many login attempts. Try again later.", "RATE_LIMITED");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const username = readNonEmptyTrimmedString(body?.username);
    const password = readNonEmptyPassword(body?.password);

    if (!username || !password) {
      return errorResponse(c, 400, "Username and password are required", "INVALID_INPUT");
    }

    const user = await usersRepo.verifyPassword(username, password);
    if (!user) {
      auditRepo.log({
        userId: null,
        username: username,
        action: "login_failed",
        resource: "session",
        ipAddress: getClientIp(c),
      });
      return errorResponse(c, 401, "Invalid credentials", "AUTH_FAILED");
    }

    // Check if 2FA is enabled for this user
    if (user.totpEnabled) {
      // Return a challenge token instead of completing login
      const challengeToken = generateChallengeToken();
      pendingChallenges.set(challengeToken, {
        userId: user.id,
        username: user.username,
        role: user.role,
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
      });
      return c.json({ requires2fa: true, challengeToken });
    }

    // Check if 2FA enforcement is on and user hasn't set it up
    const enforce2fa = settingsRepo.getBool("enforce_2fa") || user.require2fa;
    if (enforce2fa && !user.totpEnabled) {
      // Still log them in but flag that setup is required
      const result = await completeLogin(user.id, user.username, user.role, ip);

      auditRepo.log({
        userId: user.id,
        username: user.username,
        action: "login",
        resource: "session",
        resourceId: result.token,
        details: JSON.stringify({ requires2faSetup: true }),
        ipAddress: getClientIp(c),
      });

      return c.json({ ...result, requires2faSetup: true });
    }

    // Normal login (no 2FA)
    const result = await completeLogin(user.id, user.username, user.role, ip);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "login",
      resource: "session",
      resourceId: result.token,
      ipAddress: getClientIp(c),
    });

    return c.json(result);
  });

  // Verify TOTP code (second step of 2FA login)
  router.post("/verify-totp", async (c) => {
    const ip = getClientIp(c) ?? "unknown";
    const rate = getNetworkControls(settingsRepo).rateLimits.login;
    if (!checkRateLimit(ip, rate)) {
      return errorResponse(c, 429, "Too many attempts. Try again later.", "RATE_LIMITED");
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const challengeToken = readNonEmptyTrimmedString(body?.challengeToken);
    const code = readNonEmptyTrimmedString(body?.code);

    if (!challengeToken || !code) {
      return errorResponse(c, 400, "Challenge token and code are required", "INVALID_INPUT");
    }

    const challenge = pendingChallenges.get(challengeToken);
    if (!challenge || Date.now() > challenge.expiresAt) {
      pendingChallenges.delete(challengeToken);
      return errorResponse(c, 401, "Challenge expired or invalid. Please log in again.", "AUTH_FAILED");
    }

    const secret = usersRepo.getTotpSecret(challenge.userId);
    if (!secret) {
      pendingChallenges.delete(challengeToken);
      return errorResponse(c, 400, "2FA not configured", "INVALID_INPUT");
    }

    // Try TOTP code first
    const totp = new TOTP({
      issuer: "Arkestrator",
      label: challenge.username,
      secret: Secret.fromBase32(secret),
      period: 30,
      digits: 6,
    });

    const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });

    if (delta !== null) {
      // TOTP code is valid
      pendingChallenges.delete(challengeToken);
      const result = await completeLogin(challenge.userId, challenge.username, challenge.role, ip);

      auditRepo.log({
        userId: challenge.userId,
        username: challenge.username,
        action: "login",
        resource: "session",
        resourceId: result.token,
        details: JSON.stringify({ method: "totp" }),
        ipAddress: getClientIp(c),
      });

      return c.json(result);
    }

    // Try recovery code
    const recoveryUsed = await usersRepo.useRecoveryCode(challenge.userId, code.replace(/\s/g, ""));
    if (recoveryUsed) {
      pendingChallenges.delete(challengeToken);
      const result = await completeLogin(challenge.userId, challenge.username, challenge.role, ip);

      auditRepo.log({
        userId: challenge.userId,
        username: challenge.username,
        action: "login",
        resource: "session",
        resourceId: result.token,
        details: JSON.stringify({ method: "recovery_code" }),
        ipAddress: getClientIp(c),
      });

      return c.json(result);
    }

    return errorResponse(c, 401, "Invalid code", "AUTH_FAILED");
  });

  // Start 2FA setup — generate secret and recovery codes
  router.post("/totp/setup", async (c) => {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    // Generate a new TOTP secret
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "Arkestrator",
      label: user.username,
      secret,
      period: 30,
      digits: 6,
    });

    // Store the secret (but don't enable 2FA yet — needs verification)
    usersRepo.setTotpSecret(user.id, secret.base32);

    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = await Promise.all(
      recoveryCodes.map((code) => Bun.password.hash(code)),
    );
    usersRepo.setRecoveryCodes(user.id, hashedCodes);

    return c.json({
      secret: secret.base32,
      uri: totp.toString(),
      recoveryCodes,
    });
  });

  // Confirm 2FA setup — verify a code to enable TOTP
  router.post("/totp/verify-setup", async (c) => {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const code = readNonEmptyTrimmedString(body?.code);

    if (!code) {
      return errorResponse(c, 400, "Code is required", "INVALID_INPUT");
    }

    const secret = usersRepo.getTotpSecret(user.id);
    if (!secret) {
      return errorResponse(c, 400, "Run /totp/setup first", "INVALID_INPUT");
    }

    const totp = new TOTP({
      issuer: "Arkestrator",
      label: user.username,
      secret: Secret.fromBase32(secret),
      period: 30,
      digits: 6,
    });

    const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });
    if (delta === null) {
      return errorResponse(c, 400, "Invalid code. Try again.", "INVALID_INPUT");
    }

    usersRepo.enableTotp(user.id);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "totp_enabled",
      resource: "user",
      resourceId: user.id,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Disable 2FA
  router.post("/totp/disable", async (c) => {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const password = readNonEmptyPassword(body?.password);
    const code = readNonEmptyTrimmedString(body?.code);

    if (!password) {
      return errorResponse(c, 400, "Current password is required", "INVALID_INPUT");
    }

    // Verify password
    const verified = await usersRepo.verifyPassword(user.username, password);
    if (!verified) {
      return errorResponse(c, 401, "Invalid password", "AUTH_FAILED");
    }

    // If 2FA is enabled, also verify a TOTP code
    if (user.totpEnabled) {
      if (!code) {
        return errorResponse(c, 400, "TOTP code is required", "INVALID_INPUT");
      }

      const secret = usersRepo.getTotpSecret(user.id);
      if (secret) {
        const totp = new TOTP({
          issuer: "Arkestrator",
          label: user.username,
          secret: Secret.fromBase32(secret),
          period: 30,
          digits: 6,
        });
        const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });
        if (delta === null) {
          return errorResponse(c, 401, "Invalid TOTP code", "AUTH_FAILED");
        }
      }
    }

    usersRepo.disableTotp(user.id);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "totp_disabled",
      resource: "user",
      resourceId: user.id,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Get current user from session
  router.get("/me", (c) => {
    const token = extractToken(c.req.header("authorization"));
    if (!token) {
      return errorResponse(c, 401, "No session token", "UNAUTHORIZED");
    }

    const result = usersRepo.validateSession(token);
    if (!result) {
      return errorResponse(c, 401, "Invalid or expired session", "UNAUTHORIZED");
    }
    usersRepo.refreshSession(token);

    return c.json({
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
      permissions: result.user.permissions,
      require2fa: result.user.require2fa,
      totpEnabled: result.user.totpEnabled,
      allowClientCoordination: settingsRepo.getBool("allow_client_coordination"),
      canEditCoordinator: canManageCoordinator(result.user, settingsRepo),
      clientCoordinationEnabled: result.user.clientCoordinationEnabled,
    });
  });

  // Toggle per-user client-side coordination preference
  router.put("/client-coordination", async (c) => {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const { enabled, capability } = body;
    if (typeof enabled !== "boolean") {
      return errorResponse(c, 400, "enabled must be a boolean", "INVALID_INPUT");
    }

    const allowClientCoordination = settingsRepo.getBool("allow_client_coordination");
    if (enabled && !allowClientCoordination) {
      return errorResponse(c, 403, "Client-side coordination is disabled by admin policy", "FORBIDDEN");
    }

    const updated = usersRepo.setClientCoordinationEnabled(user.id, enabled);
    if (!updated) {
      return errorResponse(c, 404, "User not found", "NOT_FOUND");
    }

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: enabled ? "client_coordination_enabled" : "client_coordination_disabled",
      resource: "user",
      resourceId: user.id,
      details: capability ? JSON.stringify({ capability }) : undefined,
      ipAddress: getClientIp(c),
    });

    return c.json({
      ok: true,
      allowClientCoordination,
      canEditCoordinator: canManageCoordinator(user, settingsRepo),
      clientCoordinationEnabled: enabled,
    });
  });

  // Change own password
  router.put("/password", async (c) => {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const currentPassword = readNonEmptyPassword(body?.currentPassword);
    const newPassword = readNonEmptyPassword(body?.newPassword);
    const confirmNewPassword = readNonEmptyPassword(body?.confirmNewPassword);

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return errorResponse(
        c,
        400,
        "Current password, new password, and confirmation are required",
        "INVALID_INPUT",
      );
    }

    if (newPassword !== confirmNewPassword) {
      return errorResponse(c, 400, "New password and confirmation do not match", "INVALID_INPUT");
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return errorResponse(c, 400, passwordLengthError("New password"), "INVALID_INPUT");
    }

    // Verify current password
    const verified = await usersRepo.verifyPassword(user.username, currentPassword);
    if (!verified) {
      return errorResponse(c, 401, "Current password is incorrect", "AUTH_FAILED");
    }

    // Update password
    await usersRepo.updatePassword(user.id, newPassword);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "password_changed",
      resource: "user",
      resourceId: user.id,
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  // Logout
  router.post("/logout", (c) => {
    const token = extractToken(c.req.header("authorization"));
    if (token) {
      const result = usersRepo.validateSession(token);
      if (result) {
        auditRepo.log({
          userId: result.user.id,
          username: result.user.username,
          action: "logout",
          resource: "session",
          ipAddress: getClientIp(c),
        });
      }
      usersRepo.deleteSession(token);
    }
    return c.json({ ok: true });
  });

  return router;
}

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
  return null;
}
