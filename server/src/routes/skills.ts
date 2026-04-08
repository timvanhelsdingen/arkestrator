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
import type { SkillStore } from "../skills/skill-store.js";
import { validateSkill, previewSkillInjection } from "../skills/skill-validator.js";
import { requireAnyPrincipal, requirePrincipalAccess } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { pullBridgeSkills, pullAllBridgeSkills, importSkillsFromGitHub, BRIDGE_REGISTRY_URL, BRIDGE_RAW_BASE_URL } from "../skills/skill-registry.js";

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
  dir?: string;
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
    const raw = (await res.json()) as any;

    // Resolve bridge entries — v2 registries need individual bridge.json fetches
    let bridgeEntries: BridgeRegistryEntry[];
    if (raw.registryVersion >= 2) {
      const entries: Array<{ id: string; dir?: string }> = raw.bridges ?? [];
      const results = await Promise.allSettled(
        entries.map(async (entry) => {
          const dir = entry.dir ?? entry.id;
          const r = await fetch(`${BRIDGE_RAW_BASE}/${dir}/bridge.json`);
          if (!r.ok) throw new Error(`${r.status}`);
          const data = (await r.json()) as BridgeRegistryEntry;
          // Carry over dir from registry index so URL construction uses the correct path
          if (!data.dir) data.dir = dir;
          return data;
        }),
      );
      bridgeEntries = results
        .filter((r): r is PromiseFulfilledResult<BridgeRegistryEntry> => r.status === "fulfilled")
        .map((r) => r.value);
    } else {
      bridgeEntries = raw.bridges ?? [];
    }

    // Transform bridge registry format → flat skill list
    const skills: RegistrySkillEntry[] = [];
    for (const bridge of bridgeEntries) {
      const program = bridge.program ?? bridge.id;
      const bridgeDir = bridge.dir ?? bridge.id;
      // Each bridge has a coordinator.md (always available)
      skills.push({
        slug: `${program}-coordinator`,
        program,
        category: "bridge",
        title: `${program} Coordinator`,
        description: `Coordinator instructions for the ${program} bridge`,
        version: "1.0.0",
        contentUrl: `${BRIDGE_RAW_BASE}/${bridgeDir}/coordinator.md`,
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
          contentUrl: `${BRIDGE_RAW_BASE}/${bridgeDir}/${skill.file}`,
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
  skillStore?: SkillStore,
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
  // When filtering by program, global skills are returned separately.
  router.get("/", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    const program = c.req.query("program");
    const category = c.req.query("category") as any;
    const includeDisabled = c.req.query("includeDisabled") === "true";
    const allSkills = skillIndex.list({ program: program || undefined, category: category || undefined, includeDisabled });

    // When filtering by a specific program, split global skills into their own group
    if (program) {
      const programSkills = allSkills.filter((s) => s.program !== "global");
      const globalSkills = allSkills.filter((s) => s.program === "global");
      return c.json({ skills: programSkills, globalSkills });
    }

    return c.json({ skills: allSkills });
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
      const skill = skillStore
        ? await skillStore.create(parsed.data)
        : skillsRepo.create(parsed.data);
      if (!skillStore) skillIndex.refresh();
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

    const updated = skillStore
      ? await skillStore.update(slug, parsed.data, program || undefined)
      : skillsRepo.update(slug, parsed.data, program || undefined);
    if (!updated) {
      return errorResponse(c, 404, `Custom skill not found: ${slug}`, "NOT_FOUND");
    }

    if (!skillStore) skillIndex.refresh();
    return c.json({ skill: updated });
  });

  // DELETE /:slug — delete any skill
  router.delete("/:slug", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const deleted = program
      ? (skillStore ? await skillStore.deleteAny(slug, program) : skillsRepo.deleteAny(slug, program))
      : (skillStore ? await skillStore.delete(slug) : skillsRepo.delete(slug));
    if (!deleted) {
      return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");
    }

    if (!skillStore) skillIndex.refresh();
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

  // POST /wipe-all — delete all skills (factory reset)
  router.post("/wipe-all", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const all = skillsRepo.listAll();
    let deleted = 0;
    for (const skill of all) {
      if (skillsRepo.deleteAny(skill.slug, skill.program)) deleted++;
    }
    // Also wipe skill files from disk if skillStore is available
    if (skillStore) {
      for (const skill of all) {
        try { await skillStore.deleteAny(skill.slug, skill.program); } catch { /* already gone */ }
      }
    }
    skillIndex.refresh();
    logger.info("skills", `Wiped all skills: ${deleted} deleted`);
    return c.json({ ok: true, deleted });
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
      const skillInput = {
        name: slug,
        slug,
        program,
        category: registryEntry?.category ?? "bridge",
        title: registryEntry?.title ?? slug,
        description: registryEntry?.description ?? "",
        content,
        sourcePath: contentUrl,
      };
      const skill = skillStore
        ? await skillStore.create(skillInput, "registry")
        : skillsRepo.create(skillInput, "registry");
      if (!skillStore) skillIndex.refresh();
      return c.json({ skill }, 201);
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to install skill", "INTERNAL_ERROR");
    }
  });

  // POST /install-community — install a skill from the community (arkestrator.com)
  router.post("/install-community", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "BAD_REQUEST");
    }

    const parsed = z.object({
      communityId: z.string().min(1),
      communityBaseUrl: z.string().url().optional(),
    }).safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, parsed.error.message, "VALIDATION_ERROR");
    }

    const { communityId, communityBaseUrl } = parsed.data;
    const baseUrl = (communityBaseUrl || "https://arkestrator.com").replace(/\/+$/, "");

    // Fetch skill detail from community API
    let detail: any;
    try {
      const res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(communityId)}`);
      if (!res.ok) return errorResponse(c, 502, `Community API error: ${res.status}`, "UPSTREAM_ERROR");
      detail = await res.json();
    } catch (err: any) {
      return errorResponse(c, 502, `Failed to reach community API: ${err?.message}`, "UPSTREAM_ERROR");
    }

    // Fetch SKILL.md content
    let content: string;
    try {
      const res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(communityId)}/download`);
      if (!res.ok) return errorResponse(c, 502, `Failed to download skill content: ${res.status}`, "UPSTREAM_ERROR");
      content = await res.text();
    } catch (err: any) {
      return errorResponse(c, 502, `Failed to download skill content: ${err?.message}`, "UPSTREAM_ERROR");
    }

    let slug = detail.slug || communityId;
    const program = detail.program || "global";

    // Map community category to valid server categories
    const VALID_CATEGORIES = ["coordinator", "bridge", "training", "playbook", "verification", "project", "project-reference", "housekeeping", "custom"];
    const category = VALID_CATEGORIES.includes(detail.category) ? detail.category : "custom";

    // Create on local server
    try {
      const skillInput = {
        name: slug,
        slug,
        program,
        category,
        title: detail.title || slug,
        description: detail.description || "",
        keywords: detail.keywords || [],
        content,
        enabled: false,
      };

      let skill: any;
      try {
        skill = skillStore
          ? await skillStore.create(skillInput, "community")
          : skillsRepo.create(skillInput, "community");
      } catch (err: any) {
        // Handle slug collision — retry with suffix
        if (String(err?.message).includes("UNIQUE") || String(err?.message).toLowerCase().includes("exists")) {
          slug = `${slug}-community`;
          skillInput.name = slug;
          skillInput.slug = slug;
          skill = skillStore
            ? await skillStore.create(skillInput, "community")
            : skillsRepo.create(skillInput, "community");
        } else {
          throw err;
        }
      }

      if (!skillStore) skillIndex.refresh();
      return c.json({ skill, communityId, slug, program }, 201);
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to install community skill", "INTERNAL_ERROR");
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
      const result = await pullBridgeSkills(program, skillsRepo, settingsRepo, true, skillStore);
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
      const result = await pullAllBridgeSkills(skillsRepo, settingsRepo, connectedPrograms, skillStore);
      skillIndex.refresh();
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to pull bridge skills", "INTERNAL_ERROR");
    }
  });

  // POST /refresh/:slug — re-fetch a single skill from its upstream source
  router.post("/refresh/:slug", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program") || undefined;

    // Find the existing skill
    const existing = program
      ? skillsRepo.getAny?.(slug, program) ?? skillsRepo.get(slug, program)
      : skillsRepo.get(slug);
    if (!existing) {
      return errorResponse(c, 404, `Skill "${slug}" not found`, "NOT_FOUND");
    }
    if (existing.source === "user" || existing.source === "builtin") {
      return errorResponse(c, 400, `Skill "${slug}" has source "${existing.source}" — nothing to refresh from`, "BAD_REQUEST");
    }

    let content: string | null = null;
    let contentUrl: string | null = existing.sourcePath ?? null;

    // For bridge-repo / registry skills: resolve contentUrl from sourcePath or registry
    if (existing.source === "bridge-repo" || existing.source === "registry") {
      if (!contentUrl) {
        // Try to find the URL in the registry
        const registry = await fetchRegistry();
        const entry = registry.skills.find(
          (s) => s.slug === slug && s.program === (existing.program ?? "global"),
        );
        if (entry) {
          contentUrl = entry.contentUrl;
        }
      }
      if (!contentUrl) {
        return errorResponse(c, 404, `Cannot resolve upstream URL for skill "${slug}"`, "NOT_FOUND");
      }
      try {
        const res = await fetch(contentUrl);
        if (!res.ok) {
          return errorResponse(c, 502, `Upstream fetch failed: ${res.status} ${res.statusText}`, "UPSTREAM_ERROR");
        }
        content = await res.text();
      } catch (err: any) {
        return errorResponse(c, 502, `Upstream fetch error: ${err?.message}`, "UPSTREAM_ERROR");
      }
    }

    // For community skills: client passes communityId + optional baseUrl
    if (existing.source === "community") {
      let body: any = {};
      try { body = await c.req.json().catch(() => ({})); } catch { /* empty */ }
      const communityId = body?.communityId;
      const baseUrl = (body?.communityBaseUrl || "https://arkestrator.com").replace(/\/+$/, "");
      if (!communityId) {
        return errorResponse(c, 400, "communityId is required to refresh a community skill", "BAD_REQUEST");
      }
      try {
        const res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(communityId)}/download`);
        if (!res.ok) {
          return errorResponse(c, 502, `Community API error: ${res.status}`, "UPSTREAM_ERROR");
        }
        content = await res.text();
      } catch (err: any) {
        return errorResponse(c, 502, `Failed to reach community API: ${err?.message}`, "UPSTREAM_ERROR");
      }
    }

    if (!content || !content.trim()) {
      return errorResponse(c, 502, "Upstream returned empty content", "UPSTREAM_ERROR");
    }

    // Update skill content (triggers version snapshot if changed)
    try {
      const updates: Record<string, unknown> = { content };
      if (contentUrl && !existing.sourcePath) {
        updates.sourcePath = contentUrl; // backfill sourcePath if missing
      }
      if (skillStore) {
        await skillStore.update(slug, updates, existing.program);
      } else {
        skillsRepo.update(existing.id, updates);
        skillIndex.refresh();
      }
      const updated = skillsRepo.getAny?.(slug, existing.program) ?? skillsRepo.get(slug, existing.program);
      return c.json({ ok: true, skill: updated });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Failed to update skill", "INTERNAL_ERROR");
    }
  });

  // POST /export-zip — export selected skills as a ZIP of SKILL.md files
  router.post("/export-zip", async (c) => {
    const auth = await requireAuth(c);
    if (!auth) return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");

    let body: any;
    try { body = await c.req.json().catch(() => ({})); } catch { body = {}; }
    const slugs = Array.isArray(body?.slugs) ? body.slugs as string[] : undefined;
    const program = typeof body?.program === "string" ? body.program : undefined;
    const category = typeof body?.category === "string" ? body.category : undefined;
    const includeDeps = body?.includeDeps !== false; // default true

    let skills = skillIndex.list({ program: program || undefined, category: category || undefined });
    if (slugs && slugs.length > 0) {
      const slugSet = new Set(slugs.map(s => String(s).trim().toLowerCase()));
      skills = skills.filter(s => slugSet.has(s.slug.toLowerCase()));
    }

    if (skills.length === 0) {
      return errorResponse(c, 404, "No skills match the given criteria", "NOT_FOUND");
    }

    // Resolve dependencies if requested
    if (includeDeps) {
      const { resolveDependencies } = await import("../skills/skill-deps.js");
      const lookupFn = (slug: string, preferProgram?: string) =>
        skillsRepo.get(slug, preferProgram ?? undefined);
      const seen = new Set(skills.map(s => `${s.slug}::${s.program}`));
      const extraDeps: typeof skills = [];
      for (const s of skills) {
        const deps = resolveDependencies(s.slug, s.program, lookupFn);
        for (const dep of deps) {
          const k = `${dep.slug}::${dep.program}`;
          if (!seen.has(k)) {
            seen.add(k);
            extraDeps.push(dep);
          }
        }
      }
      if (extraDeps.length > 0) {
        skills = [...skills, ...extraDeps];
      }
    }

    const { zipSync, strToU8 } = await import("fflate");
    const { skillToSkillFile, serializeSkillFile } = await import("../skills/skill-file.js");

    const zipEntries: Record<string, Uint8Array> = {};
    for (const summary of skills) {
      // list() returns summaries — fetch the full skill record for serialization
      const skill = skillsRepo.get(summary.slug, summary.program);
      if (!skill) continue;
      const parsed = skillToSkillFile(skill);
      const md = serializeSkillFile(parsed);
      const path = `${skill.program || "global"}/${skill.slug}/SKILL.md`;
      zipEntries[path] = strToU8(md);
    }

    const zipData = zipSync(zipEntries, { level: 6 });
    const date = new Date().toISOString().slice(0, 10);
    const fileName = skills.length === 1
      ? `arkestrator_skill_${skills[0].slug}_${date}.zip`
      : `arkestrator_skills_${date}.zip`;

    return new Response(Buffer.from(zipData), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  });

  // POST /import-zip — import skills from an uploaded ZIP of SKILL.md files
  router.post("/import-zip", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    if (!skillStore) return errorResponse(c, 500, "SkillStore not available", "INTERNAL");

    const formData = await c.req.formData().catch(() => null);
    if (!formData) return errorResponse(c, 400, "Expected multipart form data", "BAD_REQUEST");
    const file = formData.get("file") as File | null;
    if (!file) return errorResponse(c, 400, "No file uploaded", "BAD_REQUEST");

    const { unzipSync } = await import("fflate");
    const { parseSkillFile, skillFileToSkillFields } = await import("../skills/skill-file.js");

    let entries: Record<string, Uint8Array>;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      entries = unzipSync(data);
    } catch (err: any) {
      return errorResponse(c, 400, `Invalid ZIP file: ${err?.message ?? err}`, "BAD_REQUEST");
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [path, content] of Object.entries(entries)) {
      if (!path.endsWith("SKILL.md") && !path.endsWith(".md")) continue;
      try {
        const text = new TextDecoder().decode(content);
        const parsed = parseSkillFile(text);
        if (!parsed) {
          errors.push(`${path}: invalid SKILL.md format`);
          skipped++;
          continue;
        }
        const fields = skillFileToSkillFields(parsed);
        const existing = skillsRepo.get(fields.slug, fields.program);
        if (existing) {
          skillsRepo.update(fields.slug, {
            name: fields.name,
            title: fields.title,
            description: fields.description,
            content: fields.content,
            keywords: fields.keywords,
            playbooks: fields.playbooks,
            relatedSkills: fields.relatedSkills,
            priority: fields.priority,
            autoFetch: fields.autoFetch,
            enabled: fields.enabled,
          }, fields.program);
          updated++;
        } else {
          skillsRepo.create({
            slug: fields.slug,
            name: fields.name,
            program: fields.program,
            category: fields.category,
            title: fields.title,
            description: fields.description,
            content: fields.content,
            keywords: fields.keywords,
            source: "import",
            sourcePath: null,
            playbooks: fields.playbooks,
            relatedSkills: fields.relatedSkills,
            priority: fields.priority,
            autoFetch: fields.autoFetch,
            enabled: fields.enabled,
          });
          imported++;
        }
      } catch (err: any) {
        errors.push(`${path}: ${err?.message ?? err}`);
        skipped++;
      }
    }

    skillIndex.refresh();
    return c.json({ ok: true, imported, updated, skipped, errors: errors.slice(0, 20) });
  });

  // POST /import — import standard Agent Skills from a GitHub repo
  router.post("/import", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");
    if (!skillStore) return errorResponse(c, 500, "SkillStore not available", "INTERNAL");

    const body = await c.req.json().catch(() => null);
    const repoUrl = body?.repoUrl || body?.url;
    const targetProgram = body?.program || "global";
    const subPath = body?.subPath;

    if (!repoUrl || typeof repoUrl !== "string") {
      return errorResponse(c, 400, "repoUrl is required", "BAD_REQUEST");
    }

    try {
      const result = await importSkillsFromGitHub(repoUrl, targetProgram, skillStore, { subPath });
      skillIndex.refresh();
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return errorResponse(c, 500, err?.message ?? "Import failed", "INTERNAL");
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

  // DELETE /:slug/versions/:version — delete a specific version snapshot
  router.delete("/:slug/versions/:version", async (c) => {
    const auth = await requireWriteAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const slug = c.req.param("slug");
    const program = c.req.query("program");
    const version = Number(c.req.param("version"));

    const skill = skillIndex.get(slug, program || undefined);
    if (!skill) return errorResponse(c, 404, `Skill not found: ${slug}`, "NOT_FOUND");

    if (!Number.isFinite(version) || version < 1) {
      return errorResponse(c, 400, "Invalid version number", "INVALID_INPUT");
    }

    // Don't allow deleting the current version
    if (version === skill.version) {
      return errorResponse(c, 400, "Cannot delete the current version", "INVALID_INPUT");
    }

    const deleted = skillsRepo.deleteVersion(skill.id, version);
    if (!deleted) return errorResponse(c, 404, `Version ${version} not found`, "NOT_FOUND");

    return c.json({ ok: true });
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

    logger.info("skills", `Skill ranking config updated: ${updated.join(", ")}`);
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
    logger.info("skills", "Skill ranking config reset to defaults");
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
