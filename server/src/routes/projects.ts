import { Hono } from "hono";
import { z } from "zod";
import type { ProjectsRepo } from "../db/projects.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import { getAuthPrincipal, apiKeyRoleAllowed, getClientIp } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

const ProjectCreateSchema = z.object({
  name: z.string().trim().min(1),
  prompt: z.string().nullable().optional(),
  pathMappings: z.array(z.any()).optional(),
  folders: z.array(z.any()).optional(),
  files: z.array(z.any()).optional(),
  githubRepos: z.array(z.any()).optional(),
});

const ProjectUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  prompt: z.string().nullable().optional(),
  pathMappings: z.array(z.any()).optional(),
  folders: z.array(z.any()).optional(),
  files: z.array(z.any()).optional(),
  githubRepos: z.array(z.any()).optional(),
});

export function createProjectRoutes(
  projectsRepo: ProjectsRepo,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
  auditRepo: AuditRepo,
) {
  const router = new Hono();

  // Helper: authenticate via session or API key (admin/client roles)
  async function requireProjectAccess(c: any): Promise<{ userId: string; username: string } | null> {
    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;
    if (principal.kind === "user") {
      if (!principal.user.permissions.manageProjects) return null;
      return { userId: principal.user.id, username: principal.user.username };
    }
    // API keys with admin or client role can manage projects
    if (!apiKeyRoleAllowed(principal.apiKey, ["admin", "client"])) return null;
    return { userId: principal.apiKey.id, username: `apikey:${principal.apiKey.label}` };
  }

  // List projects
  router.get("/", async (c) => {
    const auth = await requireProjectAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const projects = projectsRepo.list();
    return c.json(projects);
  });

  // Get project by ID
  router.get("/:id", async (c) => {
    const auth = await requireProjectAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const project = projectsRepo.getById(c.req.param("id"));
    if (!project) return errorResponse(c, 404, "Project not found", "NOT_FOUND");
    return c.json(project);
  });

  // Create project
  router.post("/", async (c) => {
    const auth = await requireProjectAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = ProjectCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }
    const { name, prompt, pathMappings, folders, files, githubRepos } = parsed.data;

    const project = projectsRepo.create({
      name,
      prompt: prompt ?? undefined,
      pathMappings: pathMappings ?? [],
      folders: folders ?? [],
      files: files ?? [],
      githubRepos: githubRepos ?? [],
    });

    auditRepo.log({
      userId: auth.userId,
      username: auth.username,
      action: "create_project",
      resource: "project",
      resourceId: project.id,
      details: JSON.stringify({ name }),
      ipAddress: getClientIp(c),
    });

    return c.json(project, 201);
  });

  // Update project
  router.put("/:id", async (c) => {
    const auth = await requireProjectAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const existing = projectsRepo.getById(c.req.param("id"));
    if (!existing) return errorResponse(c, 404, "Project not found", "NOT_FOUND");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = ProjectUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }
    const next = parsed.data;
    const updated = projectsRepo.update({
      ...existing,
      name: next.name ?? existing.name,
      prompt: next.prompt !== undefined ? next.prompt : existing.prompt,
      pathMappings: next.pathMappings ?? existing.pathMappings,
      folders: next.folders ?? existing.folders,
      files: next.files ?? existing.files,
      githubRepos: next.githubRepos ?? existing.githubRepos,
    });

    if (!updated) return errorResponse(c, 500, "Update failed", "INTERNAL_ERROR");

    auditRepo.log({
      userId: auth.userId,
      username: auth.username,
      action: "update_project",
      resource: "project",
      resourceId: c.req.param("id"),
      details: JSON.stringify(next),
      ipAddress: getClientIp(c),
    });

    return c.json(updated);
  });

  // Delete project
  router.delete("/:id", async (c) => {
    const auth = await requireProjectAccess(c);
    if (!auth) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleted = projectsRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "Project not found", "NOT_FOUND");

    auditRepo.log({
      userId: auth.userId,
      username: auth.username,
      action: "delete_project",
      resource: "project",
      resourceId: c.req.param("id"),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true });
  });

  return router;
}
