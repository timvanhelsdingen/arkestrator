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

import type { SkillsRepo, Skill, SkillTrustTier, SkillAuthorMeta } from "../db/skills.repo.js";
import type { SkillStore } from "./skill-store.js";
import type { SkillIndex } from "./skill-index.js";
import { parseSkillFile, skillFileToSkillFields } from "./skill-file.js";
import { validateSkill, scanSkillContentForInjection } from "./skill-validator.js";
import { logger } from "../utils/logger.js";

/**
 * Whitelist of trust tier strings the local server is willing to honor.
 * Anything else from the marketplace is treated as `null` (= unknown) which,
 * for community-source installs, is rejected by `enforceTrustTier()`.
 */
function parseTrustTier(raw: unknown): SkillTrustTier | null {
  if (raw === "verified" || raw === "community" || raw === "pending_review" || raw === "quarantined") {
    return raw;
  }
  return null;
}

/**
 * Parse an author metadata blob from an arkestrator.com response into the
 * shape we persist on the skill row. Tolerates partially-populated payloads.
 */
function parseAuthorBlob(raw: unknown): { meta: SkillAuthorMeta | null; login: string | null; verified: boolean } {
  if (!raw || typeof raw !== "object") return { meta: null, login: null, verified: false };
  const obj = raw as Record<string, unknown>;
  const meta: SkillAuthorMeta = {};
  if (typeof obj.login === "string") meta.login = obj.login;
  if (typeof obj.githubId === "number") meta.githubId = obj.githubId;
  if (typeof obj.accountAgeDays === "number") meta.accountAgeDays = obj.accountAgeDays;
  if (typeof obj.publicRepos === "number") meta.publicRepos = obj.publicRepos;
  if (typeof obj.followers === "number") meta.followers = obj.followers;
  if (typeof obj.verified === "boolean") meta.verified = obj.verified;
  return {
    meta: Object.keys(meta).length > 0 ? meta : null,
    login: meta.login ?? null,
    verified: meta.verified === true,
  };
}

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
interface FetchedCommunitySkill {
  ok: true;
  detail: {
    slug: string;
    program: string;
    category: string;
    title: string;
    description: string;
    keywords: string[];
    relatedSkills?: string[];
  };
  content: string;
  parsedFields: ReturnType<typeof skillFileToSkillFields> | null;
  beta?: boolean;
  /** Publisher-side trust tier from arkestrator.com (or null if missing). */
  trustTier: SkillTrustTier | null;
  /** Publisher-side scanner result (or empty arrays if missing). */
  publisherFlagged: boolean;
  publisherFlaggedReasons: string[];
  /** Author snapshot at submission time. */
  authorMeta: SkillAuthorMeta | null;
  authorLogin: string | null;
  authorVerified: boolean;
}

async function fetchCommunitySkill(opts: CommunityInstallOptions): Promise<
  | FetchedCommunitySkill
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
    // Trust signals from arkestrator.com publisher-side scoring/scanner.
    // The marketplace ships in lockstep with this code — when those fields
    // are missing, we treat the response as untrusted (null tier) and the
    // gate in installCommunitySkill rejects it.
    const trustTier = parseTrustTier(body.trustTier);
    const publisherFlagged = body.flagged === true;
    const publisherFlaggedReasons = Array.isArray(body.flaggedReasons)
      ? body.flaggedReasons.map((s: unknown) => String(s)).slice(0, 32)
      : [];
    const authorParsed = parseAuthorBlob(body.author);
    return {
      ok: true,
      detail,
      content: bodyContent,
      parsedFields,
      beta: body.beta === true,
      trustTier,
      publisherFlagged,
      publisherFlaggedReasons,
      authorMeta: authorParsed.meta,
      authorLogin: authorParsed.login,
      authorVerified: authorParsed.verified,
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
  // Trust signals can also come back as response headers on the /download
  // endpoint (since the body is raw markdown, not JSON). The marketplace
  // ships custom X-Arkestrator-* headers; we read them defensively.
  let downloadHeaders: Headers | null = null;
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
    downloadHeaders = res.headers;
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

  // Trust signals: prefer the metadata payload from /api/skills/:id, fall
  // back to the X-Arkestrator-* response headers on /download.
  const trustTier = parseTrustTier(detail?.trustTier)
    ?? parseTrustTier(downloadHeaders?.get("x-arkestrator-trust-tier"));
  const publisherFlagged = detail?.flagged === true
    || downloadHeaders?.get("x-arkestrator-flagged") === "true";
  const publisherFlaggedReasons = Array.isArray(detail?.flaggedReasons)
    ? detail.flaggedReasons.map((s: unknown) => String(s)).slice(0, 32)
    : [];
  const authorParsed = parseAuthorBlob(detail?.author);
  if (!authorParsed.login && downloadHeaders?.get("x-arkestrator-author-login")) {
    authorParsed.login = downloadHeaders.get("x-arkestrator-author-login");
    authorParsed.verified = downloadHeaders.get("x-arkestrator-author-verified") === "true";
    if (!authorParsed.meta) {
      authorParsed.meta = { login: authorParsed.login ?? undefined, verified: authorParsed.verified };
    }
  }

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
    trustTier,
    publisherFlagged,
    publisherFlaggedReasons,
    authorMeta: authorParsed.meta,
    authorLogin: authorParsed.login,
    authorVerified: authorParsed.verified,
  };
}

/**
 * Install a community skill into the local Arkestrator skill store.
 *
 * Defenses applied here, in order:
 *   1. Reject `pending_review` / `quarantined` from the marketplace.
 *   2. Reject if the marketplace didn't return a `trustTier` at all (the
 *      local server requires the marketplace to ship the trust API; absence
 *      means either an outdated marketplace or someone bypassing it).
 *   3. Run the local heuristic prompt-injection scanner. Block-severity
 *      matches refuse the install; flag-severity matches mark the skill.
 *   4. Run `validateSkill` for structural sanity.
 *   5. Persist with `source='community'`, `trustTier`, `flagged`,
 *      `flaggedReasons`, and the author snapshot.
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

  // ── Layer 6: enforce publisher-side trust tier ─────────────────────
  // The marketplace ships in lockstep with this code. A missing or unknown
  // trustTier means we're talking to an outdated/non-conformant origin —
  // refuse rather than fall back to "treat as community" (fail-closed).
  if (fetched.trustTier === "pending_review") {
    return {
      ok: false,
      error: "pending_review",
      message: "This skill is awaiting moderation review on arkestrator.com and is not available for install yet.",
    };
  }
  if (fetched.trustTier === "quarantined") {
    return {
      ok: false,
      error: "quarantined",
      message: "This skill has been removed from the community registry for safety reasons.",
    };
  }
  if (fetched.trustTier == null) {
    return {
      ok: false,
      error: "trust_tier_missing",
      message: "The community registry didn't return a trust tier for this skill. The marketplace may be running an outdated version, or the response was tampered with. Refusing to install.",
    };
  }

  // ── Layer 3: local heuristic content scan ──────────────────────────
  // Belt-and-suspenders behind the publisher-side scanner. If the local
  // scanner blocks, refuse install regardless of what the publisher said.
  const localScan = scanSkillContentForInjection(content);
  if (localScan.blocked) {
    logger.warn(
      "community-install",
      `Refusing community skill ${detail.slug ?? opts.communityId}: local scanner blocked ${localScan.reasons.join(", ")}`,
    );
    return {
      ok: false,
      error: "content_blocked",
      message: `Skill content tripped the local prompt-injection scanner and was refused. Reasons: ${localScan.reasons.join(", ")}.`,
      patterns: localScan.matches,
    };
  }

  // Combine local + publisher flag sets for persistence
  const combinedFlagged = localScan.flagged || fetched.publisherFlagged;
  const combinedReasons = Array.from(new Set([
    ...localScan.reasons,
    ...fetched.publisherFlaggedReasons,
  ]));

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
    trustTier: fetched.trustTier,
    flagged: combinedFlagged,
    flaggedReasons: combinedReasons,
    authorLogin: fetched.authorLogin,
    authorVerified: fetched.authorVerified,
    authorMeta: fetched.authorMeta,
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

    if (combinedFlagged) {
      logger.warn(
        "community-install",
        `Installed flagged community skill ${slug} (tier=${fetched.trustTier}, reasons=${combinedReasons.join(",")})`,
      );
    }

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
  // Honor the admin hard-disable kill switch and the per-server "allow
  // community skills" toggle in addition to the legacy auto-install flag.
  // resolveCommunityPolicy already applies the AND of all three.
  return resolveCommunityPolicy(settingsRepo).agentAutoInstallEnabled;
}

/**
 * Resolved community policy for the current server. Combines:
 *   - Admin "hard-disable" toggle (`community.adminHardDisabled`) — when on,
 *     blocks every code path that touches community skills regardless of
 *     user preference. Cannot be flipped by non-admins.
 *   - Per-server "allow community skills" user toggle (`community.allowOnClient`)
 *     — defaults to OFF (opt-in security). When OFF, the client UI hides
 *     community features and the server refuses install/search.
 *   - "Extra caution mode" (`community.extraCaution`) — defaults to ON.
 *     When ON, community skill content surfaced to agents gets a more
 *     aggressive untrusted-content preamble.
 *
 * The hard-disable always wins. The client UI must respect it as a locked
 * state ("Disabled by administrator") and cannot un-disable.
 */
export interface CommunityPolicy {
  /** Admin has hard-disabled all community features. Locked from user UI. */
  adminHardDisabled: boolean;
  /** User toggle: community skills are usable on this server. Forced false if hard-disabled. */
  allowCommunity: boolean;
  /** Apply more aggressive prompt-injection framing to community content. */
  extraCaution: boolean;
  /** Auto-install kill switch (legacy `community.agentAutoInstallEnabled`). Forced false if hard-disabled. */
  agentAutoInstallEnabled: boolean;
}

/**
 * Resolve the effective community policy from server settings.
 * Always returns a complete policy object. The `adminHardDisabled` flag
 * forces every other gate to its safe state when set.
 */
export function resolveCommunityPolicy(
  settingsRepo?: { get(key: string): string | null | undefined },
): CommunityPolicy {
  const adminHardDisabled = String(settingsRepo?.get("community.adminHardDisabled") ?? "").toLowerCase() === "true";

  // User toggle defaults to OFF for security — explicit opt-in required.
  const rawAllow = settingsRepo?.get("community.allowOnClient");
  const allowCommunity = !adminHardDisabled && (rawAllow != null && String(rawAllow).toLowerCase() === "true");

  // Extra caution defaults to ON whenever the feature is allowed at all.
  const rawExtra = settingsRepo?.get("community.extraCaution");
  const extraCaution = rawExtra == null ? true : String(rawExtra).toLowerCase() === "true";

  // Auto-install legacy flag, forced off when hard-disabled OR community is off.
  const rawAuto = settingsRepo?.get("community.agentAutoInstallEnabled");
  const autoEnabled = rawAuto != null && String(rawAuto).toLowerCase() === "true";

  return {
    adminHardDisabled,
    allowCommunity,
    extraCaution,
    agentAutoInstallEnabled: !adminHardDisabled && allowCommunity && autoEnabled,
  };
}
