import { Hono } from "hono";
import { z } from "zod";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillIndex } from "../skills/skill-index.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import { getAuthPrincipal, apiKeyRoleAllowed } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

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

  // GET /:slug — get skill by slug (from index)
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

  return router;
}
