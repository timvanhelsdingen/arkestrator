import { Hono } from "hono";
import { z } from "zod";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import { requireAdmin, isAuthenticated } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";

const HeadlessProgramCreateSchema = z.object({
  program: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  argsTemplate: z.array(z.string()).default([]),
  language: z.string().trim().min(1),
  enabled: z.boolean().optional(),
});

const HeadlessProgramUpdateSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  executable: z.string().trim().min(1).optional(),
  argsTemplate: z.array(z.string()).optional(),
  language: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
});

export function createHeadlessProgramRoutes(
  headlessProgramsRepo: HeadlessProgramsRepo,
  usersRepo: UsersRepo,
  apiKeysRepo: ApiKeysRepo,
) {
  const router = new Hono();

  router.get("/", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const programs = headlessProgramsRepo.list();
    return c.json(programs);
  });

  router.get("/:id", async (c) => {
    if (!await isAuthenticated(c, usersRepo, apiKeysRepo)) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const program = headlessProgramsRepo.getById(c.req.param("id"));
    if (!program) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json(program);
  });

  router.post("/", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = HeadlessProgramCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }
    const { program, displayName, executable, argsTemplate, language, enabled } = parsed.data;

    if (headlessProgramsRepo.getByProgram(program)) {
      return errorResponse(c, 409, `Program '${program}' already exists`, "CONFLICT");
    }

    const created = headlessProgramsRepo.create({
      program,
      displayName,
      executable,
      argsTemplate: argsTemplate ?? [],
      language,
      enabled,
    });

    return c.json(created, 201);
  });

  router.put("/:id", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }
    const parsed = HeadlessProgramUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
        details: parsed.error.flatten(),
      });
    }

    const updated = headlessProgramsRepo.update(c.req.param("id"), parsed.data);
    if (!updated) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json(updated);
  });

  router.delete("/:id", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const deleted = headlessProgramsRepo.delete(c.req.param("id"));
    if (!deleted) return errorResponse(c, 404, "Not found", "NOT_FOUND");
    return c.json({ ok: true });
  });

  return router;
}
