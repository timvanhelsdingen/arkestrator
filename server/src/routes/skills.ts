import { Hono } from "hono";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillEffectivenessRepo } from "../db/skill-effectiveness.repo.js";
import { type SkillIndex, DEFAULT_SKILL_RANKING_CONFIG, SKILL_RANKING_SETTINGS_KEYS, type SkillRankingConfig } from "../skills/skill-index.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import { validateSkill, previewSkillInjection } from "../skills/skill-validator.js";
import { requireAnyPrincipal, requirePrincipalAccess } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { pullBridgeSkills, pullAllBridgeSkills, BRIDGE_REGISTRY_URL, BRIDGE_RAW_BASE_URL } from "../skills/skill-registry.js";

// --- Registry cache (URLs shared with skill-registry.ts) ---
const REGISTRY_URL = BRIDGE_REGISTRY_URL;
const BRIDGE_RAW_BASE = BRIDGE_RAW_BASE_URL;
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface RegistrySkillEntry {
  slug: string;
  program: string;
  category: string;
  title: string;
  description: string;
  version: string;
  contentUrl: string;
}

interface BridgeRegistryEntry {
  id: string;
  program: string;
  skills?: Array<{ slug: string; file: string; title: string; category?: string }>;
}

interface RegistryData {
  version: number;
  skills: RegistrySkillEntry[];
}

let registryCache: { data: RegistryData; fetchedAt: number } | null = null;

async function fetchRegistry(): Promise<RegistryData> {
  if (registryCache && Date.now() - registryCache.fetchedAt < REGISTRY_CACHE_TTL) {
    return registryCache.data;
  }
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) {
      logger.warn("skills-registry", `GitHub fetch failed: ${res.status} ${res.statusText}`);
      return { version: 1, skills: [] };
    }
    const raw = (await res.json()) as { version?: number; bridges?: BridgeRegistryEntry[] };

    // Transform bridge registry format → flat skill list
    const skills: RegistrySkillEntry[] = [];
    for (const bridge of raw.bridges ?? []) {
      const program = bridge.program ?? bridge.id;
      // Each bridge has a coordinator.md (always available)
      skills.push({
        slug: `${program}-coordinator`,
        program,
        category: "bridge",
        title: `${program} Coordinator`,
        description: `Coordinator instructions for the ${program} bridge`,
        version: "1.0.0",
        contentUrl: `${BRIDGE_RAW_BASE}/${bridge.id}/coordinator.md`,
      });
      // Plus any listed skills
      for (const skill of bridge.skills ?? []) {
        skills.push({
          slug: skill.slug,
          program,
          category: skill.category ?? "custom",
          title: skill.title,
          description: "",
          version: "1.0.0",
          contentUrl: `${BRIDGE_RAW_BASE}/${bridge.id}/${skill.file}`,
        });
      }
    }

    const data: RegistryData = { version: raw.version ?? 1, skills };
    registryCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err: any) {
    logger.warn("skills-registry", `Failed to fetch registry: ${err?.message}`);
    return { version: 1, skills: [] };
  }
}

const SkillInstallSchema = z.object({
  slug: z.string().min(1),
  program: z.string().min(1),
  sourceUrl: z.string().url().optional(),
});

const SkillCreateSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  program: z.string().optional(),
  category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "project-reference", "housekeeping", "custom"]),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  content: z.string().min(1),
  playbooks: z.array(z.string()).optional(),
  relatedSkills: z.array(z.string()).optional(),
  sourcePath: z.string().nullable().optional(),
  priority: z.number().optional(),
  autoFetch: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const SkillUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  content: z.string().min(1).optional(),
  playbooks: z.array(z.string()).optional(),
  relatedSkills: z.array(z.string()).optional(),
  priority: z.number().optional(),
  autoFetch: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const SkillSearchSchema = z.object({
  query: z.string().min(1),
  program: z.string().optional(),
  category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "project-reference", "housekeeping", "custom"]).optional(),
  limit: z.number().optional(),
});

export function createSkillsRoutes(
  skillsRepo: SkillsRepo,
  skillIndex: SkillIndex,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
  settingsRepo?: SettingsRepo,
  workersRepo?: WorkersRepo,
  skillEffectivenessRepo?: SkillEffectivenessRepo,
  coordinatorPlaybooksDir?: string,
) {
  const router = new Hono();

  // Auth helpers — delegate to shared middleware
  async function requireAuth(c: any) {
    return requireAnyPrincipal(c, usersRepo, apiKeysRepo);
  }

  async function requireWriteAccess(c: any) {
    return requirePrincipalAccess(c, usersRepo, apiKeysRepo, {
      userPermission: "editCoordinator",
      allowedApiKeyRoles: ["admin"],
    });
  }

  // GET / — list skills (from index, includes all sources)
  router.get("/", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const program = c.req.query("program");
    const category = c.req.query("category") as any;
    const skills = skillIndex.list({ program: program || undefined, category: category || undefined });
    return c.json({ skills });
  });

  // POST / — create custom skill (writes to DB via skillsRepo)
  router.post("/", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const parsed = SkillCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, parsed.error.message, "VALIDATION_ERROR");
    }

    try {
      const skill = skillsRepo.create(parsed.data);
      skillIndex.refresh();
      return c.json({ skill }, 201);
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to create skill", "INTERNAL_ERROR");
    }
  });

  // PUT /:slug — update custom skill
  router.put("/:slug", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const parsed = SkillUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, parsed.error.message, "VALIDATION_ERROR");
    }

    const updated = skillsRepo.update(slug, parsed.data, program || undefined);
    if (!updated) {
      return errorResponse(c, 404, `Custom skill not found: ${slug}`, "NOT_FOUND");
    }

    skillIndex.refresh();
    return c.json({ skill: updated });
  });

  // DELETE /:slug — delete any skill
  router.delete("/:slug", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const deleted = program
      ? skillsRepo.deleteAny(slug, program)
      : skillsRepo.delete(slug);
    if (!deleted) {
      return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");
    }

    skillIndex.refresh();
    return c.json({ ok: true });
  });

  // POST /search — search skills
  router.post("/search", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const parsed = SkillSearchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, parsed.error.message, "VALIDATION_ERROR");
    }

    const results = skillIndex.search(parsed.data.query, {
      program: parsed.data.program,
      category: parsed.data.category,
      limit: parsed.data.limit,
    });
    return c.json({ results });
  });

  // POST /refresh-index — force refresh the skill index
  router.post("/refresh-index", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    skillIndex.refresh();
    return c.json({ ok: true, message: "Skill index refreshed" });
  });

  // GET /registry — fetch available skills from the bridge repo registry
  router.get("/registry", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const registry = await fetchRegistry();

    // Mark which skills are already installed (check all sources, not just user/registry)
    const installedSlugs = new Set<string>();
    const existingSkills = skillsRepo.listAll();
    for (const s of existingSkills) {
      installedSlugs.add(`${s.slug}:${s.program}`);
    }

    const skills = registry.skills.map((s) => ({
      ...s,
      installed: installedSlugs.has(`${s.slug}:${s.program}`),
    }));

    return c.json({ skills });
  });

  // POST /install — install a skill from the registry
  router.post("/install", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const parsed = SkillInstallSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, parsed.error.message, "VALIDATION_ERROR");
    }

    const { slug, program, sourceUrl } = parsed.data;

    // Check if already installed
    const existing = skillsRepo.get(slug, program);
    if (existing) {
      return errorResponse(c, 409, `Skill "${slug}" for program "${program}" is already installed`, "CONFLICT");
    }

    // Resolve the content URL
    let contentUrl = sourceUrl;
    if (!contentUrl) {
      const registry = await fetchRegistry();
      const entry = registry.skills.find((s) => s.slug === slug && s.program === program);
      if (!entry) {
        return errorResponse(c, 404, `Skill "${slug}" for "${program}" not found in registry`, "NOT_FOUND");
      }
      contentUrl = entry.contentUrl;
    }

    // Fetch skill content from GitHub
    let content: string;
    try {
      const res = await fetch(contentUrl);
      if (!res.ok) {
        return errorResponse(c, 502, `Failed to fetch skill content: ${res.status} ${res.statusText}`, "UPSTREAM_ERROR");
      }
      content = await res.text();
    } catch (err: any) {
      return errorResponse(c, 502, `Failed to fetch skill content: ${err?.message}`, "UPSTREAM_ERROR");
    }

    // Look up registry metadata for title/description/category
    const registry = await fetchRegistry();
    const registryEntry = registry.skills.find((s) => s.slug === slug && s.program === program);

    try {
      const skill = skillsRepo.create({
        name: slug,
        slug,
        program,
        category: registryEntry?.category ?? "bridge",
        title: registryEntry?.title ?? slug,
        description: registryEntry?.description ?? "",
        content,
        sourcePath: contentUrl,
      }, "registry");
      skillIndex.refresh();
      return c.json({ skill }, 201);
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to install skill", "INTERNAL_ERROR");
    }
  });

  // POST /pull/:program — manually trigger skill pull from bridge repo for a program
  router.post("/pull/:program", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const program = c.req.param("program");
    if (!program || !program.trim()) {
      return errorResponse(c, 400, "Program name is required", "BAD_REQUEST");
    }

    try {
      const result = await pullBridgeSkills(program, skillsRepo, settingsRepo, true);
      skillIndex.refresh();
      return c.json({ ok: true, program, ...result });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to pull bridge skills", "INTERNAL_ERROR");
    }
  });

  // POST /pull-all — pull skills for all known programs from bridge registry
  router.post("/pull-all", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    try {
      const connectedPrograms = workersRepo?.getDistinctPrograms() ?? [];
      const result = await pullAllBridgeSkills(skillsRepo, settingsRepo, connectedPrograms);
      skillIndex.refresh();
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to pull bridge skills", "INTERNAL_ERROR");
    }
  });

  // ── Skill versioning ──────────────────────────────────────────────────

  // GET /:slug/versions — list version history
  router.get("/:slug/versions", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    const versions = skillsRepo.listVersions(skill.id);
    return c.json({ versions, currentVersion: skill.version });
  });

  // POST /:slug/rollback — rollback to a previous version
  router.post("/:slug/rollback", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    let body: any;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "Invalid JSON", "INVALID_INPUT"); }
    const version = Number(body?.version);
    if (!Number.isFinite(version) || version < 1) {
      return errorResponse(c, 400, "Invalid version number", "INVALID_INPUT");
    }

    const restored = skillsRepo.rollback(skill.id, version);
    if (!restored) return errorResponse(c, 404, `Version ${version} not found`, "NOT_FOUND");

    skillIndex.refresh();
    return c.json({ ok: true, skill: restored });
  });

  // ── Skill validation ──────────────────────────────────────────────────

  // POST /validate — validate a skill definition
  router.post("/validate", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "Invalid JSON", "INVALID_INPUT"); }

    const result = validateSkill(body);
    return c.json(result);
  });

  // POST /preview — preview skill injection for a job context
  router.post("/preview", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "Invalid JSON", "INVALID_INPUT"); }

    const slug = String(body?.slug ?? "").trim();
    const program = String(body?.program ?? "").trim();
    const skill = slug ? skillIndex.get(slug, program || undefined) : null;
    if (!skill) return errorResponse(c, 404, "Skill not found", "NOT_FOUND");

    const preview = previewSkillInjection(skill, program);
    return c.json(preview);
  });

  // ── Skill effectiveness ─────────────────────────────────────────────

  // POST /batch-effectiveness — get effectiveness stats for multiple skills
  router.post("/batch-effectiveness", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "Invalid JSON", "INVALID_INPUT"); }

    const skillIds = Array.isArray(body?.skillIds) ? body.skillIds.filter((id: any) => typeof id === "string") : [];
    if (!skillEffectivenessRepo || skillIds.length === 0) {
      return c.json({ stats: {} });
    }

    const statsMap = skillEffectivenessRepo.getStatsForSkills(skillIds);
    // Convert Map to plain object for JSON serialization
    const stats: Record<string, any> = {};
    for (const [id, s] of statsMap) {
      stats[id] = s;
    }
    return c.json({ stats });
  });

  // GET /:slug/effectiveness — get effectiveness stats
  router.get("/:slug/effectiveness", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    if (!skillEffectivenessRepo) {
      return c.json({ stats: { totalUsed: 0, goodOutcomes: 0, averageOutcomes: 0, poorOutcomes: 0, pendingOutcomes: 0, successRate: 0 }, records: [] });
    }

    const stats = skillEffectivenessRepo.getStats(skill.id);
    const records = skillEffectivenessRepo.listForSkill(skill.id, 20);
    return c.json({ stats, records });
  });

  // POST /:slug/rate — rate a skill's usefulness for a job (for non-MCP agents via am CLI)
  router.post("/:slug/rate", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const slug = c.req.param("slug");
    let body: any;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "Invalid JSON", "INVALID_INPUT"); }

    const program = body?.program;
    const rating = body?.rating; // "useful" | "not_useful" | "partial"
    const jobId = body?.jobId || c.req.header("x-job-id");

    if (!rating || !jobId) {
      return errorResponse(c, 400, "Missing required fields: rating, jobId", "INVALID_INPUT");
    }

    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    if (!skillEffectivenessRepo) {
      return errorResponse(c, 500, "Skill effectiveness tracking not available", "INTERNAL");
    }

    const outcomeMap: Record<string, string> = { useful: "positive", not_useful: "negative", partial: "average", positive: "positive", negative: "negative", average: "average" };
    const outcome = outcomeMap[rating] || "average";
    skillEffectivenessRepo.recordSkillOutcome(skill.id, jobId, outcome);

    return c.json({ ok: true, slug, rating, outcome });
  });

  // GET /:slug/playbook-content — load referenced playbook artifact content
  router.get("/:slug/playbook-content", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    if (!coordinatorPlaybooksDir) {
      return c.json({ playbooks: [], error: "Coordinator playbooks directory not configured" });
    }

    const playbooks: Array<{ path: string; content: string | null; error?: string }> = [];
    for (const pbPath of skill.playbooks ?? []) {
      const fullPath = join(coordinatorPlaybooksDir, pbPath);
      try {
        if (existsSync(fullPath)) {
          playbooks.push({ path: pbPath, content: readFileSync(fullPath, "utf-8") });
        } else {
          playbooks.push({ path: pbPath, content: null, error: "File not found" });
        }
      } catch (err: any) {
        playbooks.push({ path: pbPath, content: null, error: err?.message ?? "Read error" });
      }
    }
    return c.json({ playbooks });
  });

  // ── Ranking configuration ──

  /** GET /ranking-config — read current skill ranking thresholds */
  router.get("/ranking-config", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Admin or editCoordinator required", "FORBIDDEN");

    const config: Record<string, number> = {};
    for (const [field, dbKey] of Object.entries(SKILL_RANKING_SETTINGS_KEYS)) {
      const stored = settingsRepo?.getNumber(dbKey) ?? null;
      config[field] = stored ?? DEFAULT_SKILL_RANKING_CONFIG[field as keyof SkillRankingConfig];
    }
    return c.json({ config, defaults: DEFAULT_SKILL_RANKING_CONFIG });
  });

  /** PUT /ranking-config — update skill ranking thresholds */
  router.put("/ranking-config", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Admin or editCoordinator required", "FORBIDDEN");
    if (!settingsRepo) return errorResponse(c, 500, "Settings not available", "INTERNAL");

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const updated: string[] = [];
    for (const [field, dbKey] of Object.entries(SKILL_RANKING_SETTINGS_KEYS)) {
      if (!(field in body)) continue;
      const val = Number(body[field]);
      if (!Number.isFinite(val) || val < 0) {
        return errorResponse(c, 400, `Invalid value for ${field}: must be a non-negative number`, "BAD_REQUEST");
      }
      settingsRepo.setNumber(dbKey, val);
      updated.push(field);
    }

    // Read back current state
    const config: Record<string, number> = {};
    for (const [field, dbKey] of Object.entries(SKILL_RANKING_SETTINGS_KEYS)) {
      const stored = settingsRepo.getNumber(dbKey) ?? null;
      config[field] = stored ?? DEFAULT_SKILL_RANKING_CONFIG[field as keyof SkillRankingConfig];
    }

    logger.info(`Skill ranking config updated: ${updated.join(", ")}`);
    return c.json({ ok: true, updated, config });
  });

  /** POST /ranking-config/reset — reset ranking config to defaults */
  router.post("/ranking-config/reset", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Admin or editCoordinator required", "FORBIDDEN");
    if (!settingsRepo) return errorResponse(c, 500, "Settings not available", "INTERNAL");

    for (const [field, dbKey] of Object.entries(SKILL_RANKING_SETTINGS_KEYS)) {
      settingsRepo.setNumber(dbKey, DEFAULT_SKILL_RANKING_CONFIG[field as keyof SkillRankingConfig]);
    }
    logger.info("Skill ranking config reset to defaults");
    return c.json({ ok: true, config: DEFAULT_SKILL_RANKING_CONFIG });
  });

  // GET /:slug — get skill by slug (from index) — MUST be last (catch-all param route)
  router.get("/:slug", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) {
      return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");
    }
    return c.json({ skill });
  });

  return router;
}
