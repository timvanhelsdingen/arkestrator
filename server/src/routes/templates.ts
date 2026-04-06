import { Hono } from "hono";
import { z } from "zod";
import type { TemplatesRepo } from "../db/templates.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import { requirePrincipalAccess } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

const TemplateCreateSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().optional(),
  type: z.enum(["chat", "project", "job_preset"]),
  category: z.string().trim().optional(),
  subcategory: z.string().trim().nullable().optional(),
  description: z.string().optional(),
  content: z.string(),
  icon: z.string().nullable().optional(),
  options: z.record(z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const TemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  slug: z.string().trim().optional(),
  type: z.enum(["chat", "project", "job_preset"]).optional(),
  category: z.string().trim().optional(),
  subcategory: z.string().trim().nullable().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  icon: z.string().nullable().optional(),
  options: z.record(z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export function createTemplatesRoutes(
  templatesRepo: TemplatesRepo,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
) {
  const router = new Hono();

  // Auth: any authenticated user or valid API key
  async function requireReadAccess(c: any) {
    return requirePrincipalAccess(c, usersRepo, apiKeysRepo, {
      allowedApiKeyRoles: ["admin", "client", "mcp"],
    });
  }

  // Auth: admin only
  async function requireAdminAccess(c: any) {
    return requirePrincipalAccess(c, usersRepo, apiKeysRepo, {
      userPermission: "manageProjects",
      allowedApiKeyRoles: ["admin"],
    });
  }

  // List templates
  router.get("/", async (c) => {
    const auth = await requireReadAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const type = c.req.query("type");
    const category = c.req.query("category");
    const enabledParam = c.req.query("enabled");
    const enabled = enabledParam !== undefined ? enabledParam === "1" : undefined;

    const templates = templatesRepo.list({ type, category, enabled });
    return c.json(templates);
  });

  // List categories
  router.get("/categories", async (c) => {
    const auth = await requireReadAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const type = c.req.query("type");
    const categories = templatesRepo.listCategories(type);
    return c.json(categories);
  });

  // Get single template
  router.get("/:id", async (c) => {
    const auth = await requireReadAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const template = templatesRepo.getById(c.req.param("id"));
    if (!template) return errorResponse(c, 404, "Template not found", "NOT_FOUND");
    return c.json(template);
  });

  // Create template
  router.post("/", async (c) => {
    const auth = await requireAdminAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = TemplateCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    const data = parsed.data;

    // Check slug uniqueness if explicitly provided
    if (data.slug && templatesRepo.slugExists(data.slug)) {
      return errorResponse(c, 409, "Slug already exists", "CONFLICT");
    }

    const template = templatesRepo.create({
      ...data,
      createdBy: auth.userId,
    });

    return c.json(template, 201);
  });

  // Update template
  router.put("/:id", async (c) => {
    const auth = await requireAdminAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const id = c.req.param("id");
    const existing = templatesRepo.getById(id);
    if (!existing) return errorResponse(c, 404, "Template not found", "NOT_FOUND");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = TemplateUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    const data = parsed.data;

    // Check slug uniqueness if changing
    if (data.slug && data.slug !== existing.slug && templatesRepo.slugExists(data.slug, id)) {
      return errorResponse(c, 409, "Slug already exists", "CONFLICT");
    }

    const updated = templatesRepo.update(id, data);
    if (!updated) return errorResponse(c, 500, "Update failed", "INTERNAL_ERROR");

    return c.json(updated);
  });

  // Delete template
  router.delete("/:id", async (c) => {
    const auth = await requireAdminAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleted = templatesRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "Template not found", "NOT_FOUND");
    return c.json({ ok: true });
  });

  // Seed default templates
  router.post("/seed", async (c) => {
    const auth = await requireAdminAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const created: string[] = [];

    for (const tpl of DEFAULT_TEMPLATES) {
      if (templatesRepo.slugExists(tpl.slug!)) continue;
      templatesRepo.create({ ...tpl, createdBy: auth.userId });
      created.push(tpl.slug!);
    }

    return c.json({ ok: true, created, skipped: DEFAULT_TEMPLATES.length - created.length });
  });

  return router;
}

/**
 * Seed default templates on server startup (idempotent — skips existing slugs).
 * Called from index.ts so templates are available immediately for new installs.
 */
export function seedDefaultTemplates(templatesRepo: TemplatesRepo): number {
  let created = 0;
  for (const tpl of DEFAULT_TEMPLATES) {
    if (templatesRepo.slugExists(tpl.slug!)) continue;
    templatesRepo.create({ ...tpl, createdBy: "system" });
    created++;
  }
  return created;
}

// ── Default seed templates ──────────────────────────────────────────────────

interface SeedTemplate {
  name: string;
  slug: string;
  type: "chat" | "project" | "job_preset";
  category: string;
  subcategory?: string;
  description: string;
  content: string;
  icon?: string;
  options?: Record<string, unknown>;
  sortOrder: number;
}

const DEFAULT_TEMPLATES: SeedTemplate[] = [
  // ── Chat templates: 3D Assets ─────────────────────────────────────────
  {
    name: "Create Asset",
    slug: "create-asset",
    type: "chat",
    category: "3D Assets",
    description: "Create a new 3D asset with specified properties",
    content: "Create a 3D asset: [describe the asset, style, poly count, textures]",
    sortOrder: 10,
  },
  {
    name: "Scene Layout",
    slug: "scene-layout",
    type: "chat",
    category: "3D Assets",
    description: "Set up a scene with objects, lighting, and camera",
    content: "Set up a scene with the following layout:\n- [describe objects, positions, lighting]\n- Camera angle: [describe]\n- Mood/atmosphere: [describe]",
    sortOrder: 20,
  },
  {
    name: "Material Setup",
    slug: "material-setup",
    type: "chat",
    category: "3D Assets",
    description: "Create materials with PBR properties",
    content: "Create materials for [object name]:\n- Base color: [color/texture]\n- Roughness: [value]\n- Normal map: [yes/no]\n- Special effects: [emission, subsurface, etc.]",
    sortOrder: 30,
  },

  // ── Chat templates: Animation ─────────────────────────────────────────
  {
    name: "Animation",
    slug: "animation",
    type: "chat",
    category: "Animation",
    description: "Animate objects or characters with specified motion",
    content: "Animate [object/character]:\n- Action: [describe motion]\n- Duration: [seconds]\n- Style: [realistic/stylized]\n- Easing: [linear/ease-in-out/etc.]",
    sortOrder: 10,
  },

  // ── Chat templates: Code ──────────────────────────────────────────────
  {
    name: "Code Task",
    slug: "code-task",
    type: "chat",
    category: "Code",
    description: "Write a script for a specific purpose",
    content: "Write a script that:\n- Purpose: [describe what it should do]\n- Language: [GDScript/Python/etc.]\n- Integration: [how it connects to existing code]",
    sortOrder: 10,
  },
  {
    name: "Bug Fix",
    slug: "bug-fix",
    type: "chat",
    category: "Code",
    description: "Fix a specific bug or issue",
    content: "Fix the following issue:\n- What's happening: [describe the bug]\n- Expected behavior: [what should happen]\n- Steps to reproduce: [list steps]\n- Relevant files: [file paths]",
    sortOrder: 20,
  },
  {
    name: "Refactor",
    slug: "refactor",
    type: "chat",
    category: "Code",
    description: "Refactor code for better structure or performance",
    content: "Refactor [file/module/system]:\n- Current problem: [describe issue]\n- Desired outcome: [what the refactored code should look like]\n- Constraints: [backward compatibility, performance, etc.]",
    sortOrder: 30,
  },

  // ── Chat templates: General ───────────────────────────────────────────
  {
    name: "Review & Explain",
    slug: "review-explain",
    type: "chat",
    category: "General",
    description: "Review and explain existing code or setup",
    content: "Review and explain the following code/setup:\n- File/node: [path or name]\n- What I want to understand: [specific question]\n- Context: [what you're trying to achieve]",
    sortOrder: 10,
  },

  // ── Project templates ─────────────────────────────────────────────────
  {
    name: "Folder per bridge",
    slug: "project-folder-per-bridge",
    type: "project",
    category: "File Structure",
    description: "Separate subfolder for each bridge program",
    content: "Create a separate subfolder for each bridge program (Blender, Godot, Houdini, etc.) under the project root. Place all generated assets and files for that program inside its respective folder.",
    icon: "📂",
    sortOrder: 10,
  },
  {
    name: "Organized by asset type",
    slug: "project-asset-type",
    type: "project",
    category: "File Structure",
    description: "Organize by models, textures, scripts, etc.",
    content: "Organize project files by asset type: models/, textures/, scripts/, scenes/, audio/, and exports/. Each bridge should output to the appropriate asset type folder.",
    icon: "🗂️",
    sortOrder: 20,
  },
  {
    name: "Pipeline stages",
    slug: "project-pipeline-stages",
    type: "project",
    category: "File Structure",
    description: "Numbered folders for each pipeline stage",
    content: "Organize files by pipeline stage: 01_concept/, 02_modeling/, 03_texturing/, 04_rigging/, 05_animation/, 06_lighting/, 07_rendering/, 08_compositing/. Each stage maps to the appropriate bridge program.",
    icon: "🔄",
    sortOrder: 30,
  },
  {
    name: "Version controlled",
    slug: "project-version-controlled",
    type: "project",
    category: "File Structure",
    description: "Latest + versioned snapshot folder structure",
    content: "Use a versioned folder structure: keep a _latest/ folder with the most recent outputs and a _versions/ folder with timestamped snapshots. Agents should always output to _latest/ and archive previous versions before overwriting.",
    icon: "📋",
    sortOrder: 40,
  },

  // ── Job presets ───────────────────────────────────────────────────────
  {
    name: "Quick Draft",
    slug: "quick-draft",
    type: "job_preset",
    category: "General",
    description: "Fast iteration with no verification",
    content: "",
    icon: "\u26A1",
    options: { verificationMode: "disabled", bridgeExecutionMode: "live" },
    sortOrder: 10,
  },
  {
    name: "Verified",
    slug: "verified",
    type: "job_preset",
    category: "General",
    description: "Standard workflow with verification enabled",
    content: "",
    icon: "\u2705",
    options: { verificationMode: "required", verificationWeight: 80, bridgeExecutionMode: "live" },
    sortOrder: 20,
  },
  {
    name: "Strict",
    slug: "strict",
    type: "job_preset",
    category: "General",
    description: "High-confidence workflow with strict verification",
    content: "",
    icon: "\uD83D\uDD12",
    options: { verificationMode: "required", verificationWeight: 99, bridgeExecutionMode: "live" },
    sortOrder: 30,
  },
];
