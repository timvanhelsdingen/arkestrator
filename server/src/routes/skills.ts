import { Hono } from "hono";
import { z } from "zod";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillIndex } from "../skills/skill-index.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { getAuthPrincipal, apiKeyRoleAllowed } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { pullBridgeSkills, pullAllBridgeSkills } from "../skills/skill-registry.js";

// --- Registry cache ---
const REGISTRY_URL =
  "https://raw.githubusercontent.com/timvanhelsdingen/arkestrator-bridges/main/skills/registry.json";
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
    const data = (await res.json()) as RegistryData;
    if (!data || !Array.isArray(data.skills)) {
      return { version: 1, skills: [] };
    }
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
  category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "custom"]),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  content: z.string().min(1),
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
  priority: z.number().optional(),
  autoFetch: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const SkillSearchSchema = z.object({
  query: z.string().min(1),
  program: z.string().optional(),
  category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "custom"]).optional(),
  limit: z.number().optional(),
});

export function createSkillsRoutes(
  skillsRepo: SkillsRepo,
  skillIndex: SkillIndex,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
  settingsRepo?: SettingsRepo,
) {
  const router = new Hono();

  // Helper: authenticate via session or API key
  async function requireAuth(c: any): Promise<{ userId: string; username: string } | null> {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;
    if (principal.kind === "user") {
      return { userId: principal.user.id, username: principal.user.username };
    }
    if (apiKeyRoleAllowed(principal.apiKey, ["admin", "client", "mcp"])) {
      return { userId: principal.apiKey.id, username: `apikey:${principal.apiKey.label}` };
    }
    return null;
  }

  // Helper: authenticate and require write permission (admin or user with manageSettings)
  async function requireWriteAccess(c: any): Promise<{ userId: string; username: string } | null> {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;
    if (principal.kind === "user") {
      if (!principal.user.permissions.manageSettings) return null;
      return { userId: principal.user.id, username: principal.user.username };
    }
    if (apiKeyRoleAllowed(principal.apiKey, ["admin"])) {
      return { userId: principal.apiKey.id, username: `apikey:${principal.apiKey.label}` };
    }
    return null;
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

  // DELETE /:slug — delete custom skill (source=user only)
  router.delete("/:slug", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const deleted = skillsRepo.delete(slug, program || undefined);
    if (!deleted) {
      return errorResponse(c, 404, `Custom skill not found: ${slug}`, "NOT_FOUND");
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

    // Mark which skills are already installed
    const installedSlugs = new Set<string>();
    const existingSkills = skillsRepo.list();
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
      const result = await pullAllBridgeSkills(skillsRepo, settingsRepo);
      skillIndex.refresh();
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to pull bridge skills", "INTERNAL_ERROR");
    }
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
