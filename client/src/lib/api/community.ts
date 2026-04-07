/**
 * Community Skills API client — talks to arkestrator.com (or configured base URL).
 * Separate from rest.ts which targets the local Arkestrator server.
 *
 * Uses Tauri's HTTP plugin (fetch via Rust) to bypass CORS restrictions in the
 * webview, falling back to native browser fetch in non-Tauri environments (dev).
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const isTauri =
  typeof window !== "undefined" && "__TAURI__" in window;

/** Use Tauri fetch when available (bypasses CORS), else native fetch. */
const corsFetch: typeof globalThis.fetch = isTauri
  ? tauriFetch
  : globalThis.fetch;

const SETTINGS_KEY = "arkestrator-community-settings";

const DEFAULT_BASE_URL = "https://arkestrator.com";

/**
 * In browser dev mode (no Tauri), rewrite community API URLs to go through the
 * Vite proxy at /community-api, avoiding CORS issues.  In Tauri (dev or prod)
 * the request goes straight to arkestrator.com via the Rust HTTP plugin.
 */
const isDevBrowser = !isTauri && import.meta.env.DEV;

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

export interface CommunitySettings {
  enabled: boolean;
  baseUrl: string;
  authToken: string;
}

function defaultSettings(): CommunitySettings {
  return { enabled: true, baseUrl: DEFAULT_BASE_URL, authToken: "" };
}

/** Strip trailing slashes and common mis-suffixes like "/api" from the base URL. */
function normalizeBaseUrl(raw: string): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/api$/i, "");
}

export function loadSettings(): CommunitySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      authToken: parsed.authToken || "",
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: CommunitySettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    enabled: settings.enabled,
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    authToken: settings.authToken,
  }));
}

// ---------------------------------------------------------------------------
// Core request wrapper
// ---------------------------------------------------------------------------

/** Resolve the final URL for a community API path. */
function resolveUrl(baseUrl: string, path: string): string {
  // In browser dev mode, proxy through Vite to avoid CORS.
  // path is like "/api/skills" — rewrite to "/community-api/skills".
  if (isDevBrowser && (baseUrl === DEFAULT_BASE_URL || !baseUrl)) {
    return path.replace(/^\/api/, "/community-api");
  }
  return `${baseUrl}${path}`;
}

async function communityRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const settings = loadSettings();
  const url = resolveUrl(settings.baseUrl, path);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (settings.authToken) {
    headers["Authorization"] = `Bearer ${settings.authToken}`;
  }

  if (options.body instanceof FormData) {
    delete headers["Content-Type"];
  }

  const res = await corsFetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      throw new Error(parsed?.error || parsed?.message || `${res.status}: ${text}`);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith("{")) throw e;
      throw new Error(`${res.status}: ${text}`);
    }
  }

  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text);
}

async function communityRequestText(path: string): Promise<string> {
  const settings = loadSettings();
  const url = resolveUrl(settings.baseUrl, path);
  const headers: Record<string, string> = {};
  if (settings.authToken) {
    headers["Authorization"] = `Bearer ${settings.authToken}`;
  }
  const res = await corsFetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${res.status}: Failed to download skill`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// SKILL.md builder (server expects YAML frontmatter + body)
// ---------------------------------------------------------------------------

function buildSkillMd(skill: {
  slug: string;
  title: string;
  program: string;
  category: string;
  description: string;
  keywords?: string[];
  relatedSkills?: string[];
  content: string;
}): string {
  const kw = skill.keywords?.length ? `[${skill.keywords.join(", ")}]` : "[]";
  const rs = skill.relatedSkills?.length
    ? `\n  related-skills: [${skill.relatedSkills.join(", ")}]`
    : "";
  return `---
name: ${skill.slug}
description: ${skill.description}
metadata:
  title: ${skill.title}
  program: ${skill.program}
  category: ${skill.category}
  keywords: ${kw}${rs}
---

${skill.content}
`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommunitySkillSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  program: string;
  category: string;
  keywords: string[];
  version: number;
  downloads: number;
  author: { username: string; avatar_url?: string };
  created_at?: string;
  updated_at?: string;
}

export interface CommunitySkillDetail extends CommunitySkillSummary {
  content: string;
}

export interface CommunitySearchResult {
  skills: CommunitySkillSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CommunityUser {
  id: string;
  username: string;
  avatar_url?: string;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const communityApi = {
  search(params: {
    query?: string;
    program?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<CommunitySearchResult> {
    const qs = new URLSearchParams();
    if (params.query) qs.set("query", params.query);
    if (params.program) qs.set("program", params.program);
    if (params.category) qs.set("category", params.category);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return communityRequest(`/api/skills${q ? `?${q}` : ""}`);
  },

  getSkill(id: string): Promise<CommunitySkillDetail> {
    return communityRequest(`/api/skills/${encodeURIComponent(id)}`);
  },

  downloadSkill(id: string): Promise<string> {
    return communityRequestText(`/api/skills/${encodeURIComponent(id)}/download`);
  },

  async getPrograms(): Promise<string[]> {
    const res = await communityRequest<{ programs: string[] } | string[]>("/api/skills/programs");
    return Array.isArray(res) ? res : res.programs ?? [];
  },

  async getCategories(): Promise<string[]> {
    const res = await communityRequest<{ categories: string[] } | string[]>("/api/skills/categories");
    return Array.isArray(res) ? res : res.categories ?? [];
  },

  publish(skill: {
    title: string;
    slug: string;
    program: string;
    category: string;
    description: string;
    keywords?: string[];
    relatedSkills?: string[];
    content: string;
  }): Promise<{ id: string }> {
    // Server expects raw SKILL.md with YAML frontmatter, not JSON
    const md = buildSkillMd(skill);
    return communityRequest("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: md,
    });
  },

  updatePublished(id: string, skill: {
    title?: string;
    slug?: string;
    program?: string;
    category?: string;
    description?: string;
    keywords?: string[];
    relatedSkills?: string[];
    content?: string;
  }): Promise<void> {
    // Server expects raw SKILL.md with YAML frontmatter
    const md = buildSkillMd(skill as Parameters<typeof buildSkillMd>[0]);
    return communityRequest(`/api/skills/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: md,
    });
  },

  deletePublished(id: string): Promise<void> {
    return communityRequest(`/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async me(): Promise<CommunityUser> {
    const res = await communityRequest<{ user: CommunityUser | null } | CommunityUser>("/api/auth/me");
    // Server wraps in { user: ... } — unwrap it
    const user = res && "user" in res ? res.user : res;
    if (!user) throw new Error("Not authenticated");
    return user as CommunityUser;
  },

  // Re-export settings helpers for convenience
  loadSettings,
  saveSettings,
};
