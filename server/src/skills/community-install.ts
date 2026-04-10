/**
 * Shared helper for installing skills from the arkestrator.com community registry.
 *
 * Two call paths:
 *   1. Client UI install (agentDriven: false) → hits the free GET /api/skills/:id/download
 *      endpoint. No auth token required. Used by POST /api/skills/install-community.
 *   2. Agent MCP install (agentDriven: true) → hits POST /api/skills/:id/agent-install.
 *      Requires a Bearer session token. Used by the install_community_skill MCP tool.
 *
 * During the free beta phase, the arkestrator.com /agent-install endpoint allows any
 * authenticated user. Post-beta, it enforces subscription tier checks server-side.
 * This helper is agnostic: it forwards whatever token it's given and relays whatever
 * error the server returns via forward-compatible error passthrough.
 */

import type { SkillsRepo, Skill } from "../db/skills.repo.js";
import type { SkillStore } from "./skill-store.js";
import type { SkillIndex } from "./skill-index.js";
import { parseSkillFile, skillFileToSkillFields } from "./skill-file.js";
import { validateSkill } from "./skill-validator.js";
import { logger } from "../utils/logger.js";

/**
 * Hard cap on community skill body size. 256 KB is well above every
 * legitimate SKILL.md we've seen and cheap to enforce; without this a
 * hostile or buggy upstream could stuff the local DB with megabytes of
 * content per call.
 */
const MAX_COMMUNITY_SKILL_BYTES = 256 * 1024;

const VALID_CATEGORIES = [
  "coordinator",
  "bridge",
  "training",
  "playbook",
  "verification",
  "project",
  "project-reference",
  "housekeeping",
  "custom",
] as const;

export interface CommunityInstallOptions {
  communityId: string;
  baseUrl: string;
  /** Optional Bearer token for agent-driven gated installs. Null/undefined for free UI installs. */
  sessionToken?: string | null;
  /** When true, hits the gated agent-install endpoint. When false, hits the free /download endpoint. */
  agentDriven: boolean;
  skillsRepo: SkillsRepo;
  skillIndex?: SkillIndex;
  skillStore?: SkillStore;
}

export interface CommunityInstallSuccess {
  ok: true;
  skill: Skill;
  slug: string;
  program: string;
  communityId: string;
  beta?: boolean;
}

export interface CommunityInstallError {
  ok: false;
  /** Short machine-readable error code, e.g. "sponsorship_required", "not_found", "unreachable". */
  error: string;
  /** Human-readable message from the server (or a generated one for local-only failures). */
  message: string;
  /** HTTP status code if the error came from an HTTP response. */
  status?: number;
  /** Arbitrary additional fields passed through from the server response (e.g. upgradeUrl). */
  [extra: string]: unknown;
}

export type CommunityInstallResult = CommunityInstallSuccess | CommunityInstallError;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Parse a response body as JSON, falling back to a plain object with the raw text.
 * Used on error responses to preserve whatever structured info the server returned.
 */
async function parseErrorBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    try {
      const text = await res.text();
      return { raw: text };
    } catch {
      return {};
    }
  }
}

/**
 * Fetch skill metadata + content for a community skill.
 *
 * For agent-driven installs, hits POST /agent-install with a Bearer token — returns
 * JSON { slug, program, category, title, description, keywords, content }.
 *
 * For UI-driven installs, hits the existing GET /api/skills/:id and /api/skills/:id/download
 * endpoints as two separate calls (preserving the old two-step flow that works without auth).
 */
async function fetchCommunitySkill(opts: CommunityInstallOptions): Promise<
  | { ok: true; detail: { slug: string; program: string; category: string; title: string; description: string; keywords: string[]; relatedSkills?: string[] }; content: string; parsedFields: ReturnType<typeof skillFileToSkillFields> | null; beta?: boolean }
  | CommunityInstallError
> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  if (opts.agentDriven) {
    // Agent path: hit the gated endpoint with the stored session token
    if (!opts.sessionToken) {
      return {
        ok: false,
        error: "sponsorship_required",
        message:
          "You need to log in to arkestrator.com via the Community tab to use agent auto-install. The free beta requires authentication so that usage can be attributed to a real account.",
        upgradeUrl: `${baseUrl}/login`,
      };
    }

    let res: Response;
    try {
      res = await fetch(
        `${baseUrl}/api/skills/${encodeURIComponent(opts.communityId)}/agent-install`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.sessionToken}` },
        },
      );
    } catch (err: any) {
      return {
        ok: false,
        error: "unreachable",
        message: `Unable to reach the community registry: ${err?.message ?? "network error"}`,
      };
    }

    if (!res.ok) {
      const body = await parseErrorBody(res);
      return {
        ok: false,
        error: (body.error as string) ?? `http_${res.status}`,
        message: (body.message as string) ?? `Install failed with HTTP ${res.status}`,
        status: res.status,
        ...body,
      };
    }

    let body: any;
    try {
      body = await res.json();
    } catch (err: any) {
      return {
        ok: false,
        error: "invalid_response",
        message: `Community registry returned a non-JSON response: ${err?.message ?? "parse error"}`,
      };
    }

    // The agent-install endpoint returns full skill data in a single response
    const detail = {
      slug: String(body.slug ?? opts.communityId),
      program: String(body.program ?? "global"),
      category: String(body.category ?? "custom"),
      title: String(body.title ?? body.slug ?? opts.communityId),
      description: String(body.description ?? ""),
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
      relatedSkills: Array.isArray(body.relatedSkills) ? body.relatedSkills : undefined,
    };
    const content = String(body.content ?? "");
    if (content.length > MAX_COMMUNITY_SKILL_BYTES) {
      return {
        ok: false,
        error: "content_too_large",
        message: `Community skill content is ${content.length} bytes — exceeds the ${MAX_COMMUNITY_SKILL_BYTES}-byte limit.`,
      };
    }
    // The content from agent-install may or may not have frontmatter;
    // try parsing and fall back to raw.
    const parsed = parseSkillFile(content);
    const parsedFields = parsed ? skillFileToSkillFields(parsed) : null;
    const bodyContent = parsed ? parsed.body : content;
    return {
      ok: true,
      detail,
      content: bodyContent,
      parsedFields,
      beta: body.beta === true,
    };
  }

  // Client UI path: two-step, no auth required (existing free flow)
  let detail: any;
  try {
    const res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(opts.communityId)}`);
    if (!res.ok) {
      return {
        ok: false,
        error: "not_found",
        message: `Community API error: ${res.status}`,
        status: res.status,
      };
    }
    detail = await res.json();
  } catch (err: any) {
    return {
      ok: false,
      error: "unreachable",
      message: `Failed to reach community API: ${err?.message ?? "network error"}`,
    };
  }

  let rawContent: string;
  try {
    const res = await fetch(
      `${baseUrl}/api/skills/${encodeURIComponent(opts.communityId)}/download`,
    );
    if (!res.ok) {
      return {
        ok: false,
        error: "download_failed",
        message: `Failed to download skill content: ${res.status}`,
        status: res.status,
      };
    }
    rawContent = await res.text();
  } catch (err: any) {
    return {
      ok: false,
      error: "unreachable",
      message: `Failed to download skill content: ${err?.message ?? "network error"}`,
    };
  }

  if (rawContent.length > MAX_COMMUNITY_SKILL_BYTES) {
    return {
      ok: false,
      error: "content_too_large",
      message: `Community skill content is ${rawContent.length} bytes — exceeds the ${MAX_COMMUNITY_SKILL_BYTES}-byte limit.`,
    };
  }

  const parsed = parseSkillFile(rawContent);
  const parsedFields = parsed ? skillFileToSkillFields(parsed) : null;
  const content = parsed ? parsed.body : rawContent;

  return {
    ok: true,
    detail: {
      slug: String(detail.slug ?? opts.communityId),
      program: String(detail.program ?? "global"),
      category: String(detail.category ?? "custom"),
      title: String(detail.title ?? detail.slug ?? opts.communityId),
      description: String(detail.description ?? ""),
      keywords: Array.isArray(detail.keywords) ? detail.keywords : [],
      relatedSkills: Array.isArray(detail.relatedSkills) ? detail.relatedSkills : undefined,
    },
    content,
    parsedFields,
  };
}

/**
 * Install a community skill into the local Arkestrator skill store.
 *
 * Handles slug collision by retrying with a "-community" suffix.
 */
export async function installCommunitySkill(
  opts: CommunityInstallOptions,
): Promise<CommunityInstallResult> {
  const fetched = await fetchCommunitySkill(opts);
  if (!("ok" in fetched) || !fetched.ok) {
    return fetched as CommunityInstallError;
  }

  const { detail, content, parsedFields, beta } = fetched;
  let slug = detail.slug || opts.communityId;
  const program = detail.program || "global";
  const category = (VALID_CATEGORIES as readonly string[]).includes(detail.category)
    ? detail.category
    : "custom";

  const skillInput = {
    name: slug,
    slug,
    program,
    category,
    title: detail.title || slug,
    description: detail.description || "",
    keywords: detail.keywords || [],
    relatedSkills: parsedFields?.relatedSkills ?? detail.relatedSkills ?? [],
    content,
    enabled: true,
  };

  // Reject obviously broken community skills (empty content, invalid regex
  // keywords, etc.) before they hit the DB. Warnings are allowed but logged.
  const validation = validateSkill(skillInput as any, (s) => opts.skillIndex?.get(s) != null);
  const validationErrors = validation.issues.filter((i) => i.severity === "error");
  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: "invalid_content",
      message: `Community skill failed validation: ${validationErrors.map((i) => i.message).join("; ")}`,
    };
  }
  if (validation.issues.some((i) => i.severity === "warning")) {
    logger.warn(
      "community-install",
      `Installed ${slug} with warnings: ${validation.issues.filter((i) => i.severity === "warning").map((i) => i.message).join("; ")}`,
    );
  }

  try {
    let skill: Skill;
    try {
      skill = opts.skillStore
        ? await opts.skillStore.create(skillInput, "community")
        : opts.skillsRepo.create(skillInput, "community");
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("UNIQUE") || msg.toLowerCase().includes("exists")) {
        // Slug collision — retry with suffix
        slug = `${slug}-community`;
        skillInput.name = slug;
        skillInput.slug = slug;
        skill = opts.skillStore
          ? await opts.skillStore.create(skillInput, "community")
          : opts.skillsRepo.create(skillInput, "community");
      } else {
        throw err;
      }
    }

    if (!opts.skillStore && opts.skillIndex) opts.skillIndex.refresh();

    return {
      ok: true,
      skill,
      slug,
      program,
      communityId: opts.communityId,
      beta,
    };
  } catch (err: any) {
    logger.warn("community-install", `Failed to install skill: ${err?.message}`);
    return {
      ok: false,
      error: "internal",
      message: err?.message ?? "Failed to install community skill",
    };
  }
}

/**
 * Search the community skill registry. Always uses the free, unauthenticated
 * GET /api/skills endpoint regardless of whether the caller has a session token.
 * Returns empty results + unreachable flag on network failure (graceful no-op).
 */
export async function searchCommunitySkills(opts: {
  baseUrl: string;
  query: string;
  program?: string;
  limit?: number;
}): Promise<{
  skills: Array<{
    id: string;
    slug: string;
    title: string;
    description: string;
    program: string;
    category: string;
    keywords: string[];
  }>;
  unreachable?: boolean;
}> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = new URL("/api/skills", baseUrl);
  url.searchParams.set("query", opts.query);
  if (opts.program) url.searchParams.set("program", opts.program);
  if (opts.limit != null) url.searchParams.set("limit", String(opts.limit));

  try {
    const res = await fetch(url);
    if (!res.ok) return { skills: [], unreachable: true };
    const data = (await res.json()) as any;
    const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
    return {
      skills: rawSkills.map((s: any) => ({
        id: String(s.id ?? s.slug ?? ""),
        slug: String(s.slug ?? s.id ?? ""),
        title: String(s.title ?? ""),
        description: String(s.description ?? ""),
        program: String(s.program ?? "global"),
        category: String(s.category ?? "custom"),
        keywords: Array.isArray(s.keywords) ? s.keywords : [],
      })),
    };
  } catch (err: any) {
    logger.warn("community-search", `Search failed: ${err?.message}`);
    return { skills: [], unreachable: true };
  }
}

/**
 * Resolve the configured community base URL.
 *
 * Priority: server_settings key > env var > default.
 *
 * The admin setting wins over the env var on purpose — operators edit it
 * via the UI and reasonably expect that value to be authoritative.
 *
 * Only `https:` URLs are accepted to prevent session tokens from travelling
 * in the clear; a badly-configured override silently falls back to the
 * default instead of downgrading the channel. `http://localhost` and
 * `http://127.0.0.1` are allowed for local development.
 */
export function resolveCommunityBaseUrl(
  settingsRepo?: { get(key: string): string | null | undefined },
): string {
  const defaultUrl = "https://arkestrator.com";
  const isSafeUrl = (candidate: string): boolean => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:") return true;
      if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return true;
      return false;
    } catch {
      return false;
    }
  };
  const settingUrl = settingsRepo?.get("community.baseUrl");
  if (settingUrl && typeof settingUrl === "string" && settingUrl.trim()) {
    const candidate = normalizeBaseUrl(settingUrl.trim());
    if (isSafeUrl(candidate)) return candidate;
    logger.warn("community-install", `Ignoring community.baseUrl="${candidate}" — must be https (or http://localhost).`);
  }
  const envUrl = process.env.ARKESTRATOR_COMMUNITY_BASE_URL?.trim();
  if (envUrl) {
    const candidate = normalizeBaseUrl(envUrl);
    if (isSafeUrl(candidate)) return candidate;
    logger.warn("community-install", `Ignoring ARKESTRATOR_COMMUNITY_BASE_URL="${candidate}" — must be https (or http://localhost).`);
  }
  return defaultUrl;
}

/**
 * Check whether agent community auto-install is enabled on this server.
 *
 * Default: **disabled**. This feature sends per-user bearer tokens to an
 * external origin and injects third-party content into agent prompts, so
 * operators must explicitly opt in via the admin Community panel (or by
 * setting `community.agentAutoInstallEnabled = "true"` directly).
 */
export function isAgentCommunityEnabled(
  settingsRepo?: { get(key: string): string | null | undefined },
): boolean {
  const raw = settingsRepo?.get("community.agentAutoInstallEnabled");
  if (raw == null) return false; // default disabled — explicit opt-in required
  return String(raw).toLowerCase() === "true";
}
