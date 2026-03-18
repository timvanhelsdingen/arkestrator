import type { UserRole } from "../db/users.repo.js";

export interface UserPermissions {
  manageUsers: boolean;
  manageAgents: boolean;
  manageProjects: boolean;
  managePolicies: boolean;
  manageApiKeys: boolean;
  manageConnections: boolean;
  manageWorkers: boolean;
  manageSecurity: boolean;
  viewAuditLog: boolean;
  viewUsage: boolean;
  editCoordinator: boolean;
  useMcp: boolean;
  interveneJobs: boolean;
}

export const USER_PERMISSION_KEYS = [
  "manageUsers",
  "manageAgents",
  "manageProjects",
  "managePolicies",
  "manageApiKeys",
  "manageConnections",
  "manageWorkers",
  "manageSecurity",
  "viewAuditLog",
  "viewUsage",
  "editCoordinator",
  "useMcp",
  "interveneJobs",
] as const;

export type UserPermissionKey = (typeof USER_PERMISSION_KEYS)[number];

const ROLE_DEFAULTS: Record<UserRole, UserPermissions> = {
  admin: {
    manageUsers: true,
    manageAgents: true,
    manageProjects: true,
    managePolicies: true,
    manageApiKeys: true,
    manageConnections: true,
    manageWorkers: true,
    manageSecurity: true,
    viewAuditLog: true,
    viewUsage: true,
    editCoordinator: true,
    useMcp: true,
    interveneJobs: true,
  },
  user: {
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
    useMcp: true,
    interveneJobs: true,
  },
  viewer: {
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

export function getDefaultUserPermissions(role: UserRole): UserPermissions {
  return { ...ROLE_DEFAULTS[role] };
}

export function normalizeUserPermissions(role: UserRole, value: unknown): UserPermissions {
  const defaults = getDefaultUserPermissions(role);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const input = value as Record<string, unknown>;
  const out: UserPermissions = { ...defaults };

  for (const key of USER_PERMISSION_KEYS) {
    const next = input[key];
    if (typeof next === "boolean") {
      out[key] = next;
    }
  }

  return out;
}

export function parseUserPermissionPatch(value: unknown): {
  ok: true;
  patch: Partial<UserPermissions>;
} | {
  ok: false;
  error: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "permissions must be an object" };
  }

  const input = value as Record<string, unknown>;
  const patch: Partial<UserPermissions> = {};

  for (const key of Object.keys(input)) {
    if (!USER_PERMISSION_KEYS.includes(key as UserPermissionKey)) {
      return { ok: false, error: `Unknown permission key: ${key}` };
    }
    const next = input[key];
    if (typeof next !== "boolean") {
      return { ok: false, error: `Permission ${key} must be a boolean` };
    }
    patch[key as UserPermissionKey] = next;
  }

  return { ok: true, patch };
}

export function applyUserPermissionPatch(
  role: UserRole,
  current: UserPermissions,
  patch: Partial<UserPermissions>,
): UserPermissions {
  return normalizeUserPermissions(role, {
    ...current,
    ...patch,
  });
}
