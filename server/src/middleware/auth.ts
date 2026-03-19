import type { Context } from "hono";
import type { UsersRepo, User } from "../db/users.repo.js";
import type { ApiKeysRepo, ApiKey, ApiKeyRole } from "../db/apikeys.repo.js";
import type { UserPermissionKey } from "../utils/user-permissions.js";

export type AuthPrincipal =
  | {
      kind: "user";
      user: User;
    }
  | {
      kind: "apiKey";
      apiKey: ApiKey;
      source: "header" | "query";
    };

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

async function getApiKeyPrincipal(
  c: Context,
  apiKeysRepo: ApiKeysRepo,
): Promise<AuthPrincipal | null> {
  const headerToken = extractBearerToken(c.req.header("authorization"));
  if (headerToken) {
    const apiKey = await apiKeysRepo.validate(headerToken);
    if (apiKey) {
      return { kind: "apiKey", apiKey, source: "header" };
    }
  }

  const queryToken = String(c.req.query("key") ?? "").trim();
  if (queryToken) {
    const apiKey = await apiKeysRepo.validate(queryToken);
    if (apiKey) {
      return { kind: "apiKey", apiKey, source: "query" };
    }
  }

  return null;
}

export function getAuthenticatedUser(
  c: Context,
  usersRepo: UsersRepo,
): User | null {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return null;
  const result = usersRepo.validateSession(token);
  return result?.user ?? null;
}

export async function getAuthPrincipal(
  c: Context,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
): Promise<AuthPrincipal | null> {
  const user = getAuthenticatedUser(c, usersRepo);
  if (user) return { kind: "user", user };
  return getApiKeyPrincipal(c, apiKeysRepo);
}

export function apiKeyRoleAllowed(
  apiKey: ApiKey,
  allowedRoles: ApiKeyRole[],
): boolean {
  return allowedRoles.includes(apiKey.role);
}

/**
 * Require that the request has a valid session token OR a valid API key.
 * Returns true if authenticated, false otherwise.
 */
export async function isAuthenticated(
  c: Context,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
): Promise<boolean> {
  return (await getAuthPrincipal(c, usersRepo, apiKeysRepo)) !== null;
}

export function requireAdmin(
  c: Context,
  usersRepo: UsersRepo,
): User | null {
  const user = getAuthenticatedUser(c, usersRepo);
  if (!user || user.role !== "admin") return null;
  return user;
}

export function requirePermission(
  c: Context,
  usersRepo: UsersRepo,
  permission: UserPermissionKey,
): User | null {
  const user = getAuthenticatedUser(c, usersRepo);
  if (!user) return null;
  if (!user.permissions[permission]) return null;
  return user;
}

/**
 * Check if a principal (user or API key) has a specific permission.
 * Works uniformly for both authentication types.
 */
export function principalHasPermission(
  principal: AuthPrincipal,
  permission: UserPermissionKey,
): boolean {
  if (principal.kind === "user") {
    return !!principal.user.permissions[permission];
  }
  if (principal.kind === "apiKey") {
    return !!principal.apiKey.permissions[permission];
  }
  return false;
}

export function getClientIp(c: Context): string | undefined {
  const trustProxyHeaders = /^(1|true|yes|on)$/i.test(
    String(process.env.TRUST_PROXY_HEADERS ?? ""),
  );
  if (!trustProxyHeaders) return undefined;

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header("x-real-ip")?.trim();
  return realIp || undefined;
}
