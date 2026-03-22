import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { createHealthRoutes } from "./routes/health.js";
import { createJobRoutes } from "./routes/jobs.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createApiKeyRoutes } from "./routes/apikeys.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createUserRoutes } from "./routes/users.js";
import { createPolicyRoutes } from "./routes/policies.js";
import { createAuditRoutes } from "./routes/audit.js";
import { createStatsRoutes } from "./routes/stats.js";
import { createConnectionRoutes } from "./routes/connections.js";
import { createProjectRoutes } from "./routes/projects.js";
import { createWorkerRoutes } from "./routes/workers.js";
import { createSyncRoutes } from "./routes/sync.js";
import { createBridgeCommandRoutes } from "./routes/bridge-commands.js";
import { createHeadlessProgramRoutes } from "./routes/headless-programs.js";
import { createChatRoutes } from "./routes/chat.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSkillsRoutes } from "./routes/skills.js";
import { createMcpRoutes } from "./mcp/routes.js";
import { CodexChatSessionManager } from "./chat/codex-sessions.js";
import type { Database } from "bun:sqlite";
import type { JobsRepo } from "./db/jobs.repo.js";
import type { AgentsRepo } from "./db/agents.repo.js";
import type { ApiKeysRepo } from "./db/apikeys.repo.js";
import type { UsersRepo } from "./db/users.repo.js";
import type { PoliciesRepo } from "./db/policies.repo.js";
import type { AuditRepo } from "./db/audit.repo.js";
import type { ProjectsRepo } from "./db/projects.repo.js";
import type { WorkersRepo } from "./db/workers.repo.js";
import type { UsageRepo } from "./db/usage.repo.js";
import type { DependenciesRepo } from "./db/dependencies.repo.js";
import type { HeadlessProgramsRepo } from "./db/headless-programs.repo.js";
import type { SettingsRepo } from "./db/settings.repo.js";
import type { JobInterventionsRepo } from "./db/job-interventions.repo.js";
import type { Config } from "./config.js";
import type { SyncManager } from "./workspace/sync-manager.js";
import type { WebSocketHub } from "./ws/hub.js";
import type { ProcessTracker } from "./agents/process-tracker.js";
import type { WorkerResourceLeaseManager } from "./agents/resource-control.js";
import { logger } from "./utils/logger.js";
import { getClientIp } from "./middleware/auth.js";
import {
  evaluateNetworkAccess,
  extractDomainForPolicy,
  getNetworkControls,
} from "./security/network-policy.js";
import { errorResponse } from "./utils/errors.js";
import type { SkillsRepo } from "./db/skills.repo.js";
import { SkillIndex } from "./skills/skill-index.js";
import { materializeSkills } from "./skills/skill-materializer.js";

export interface AppDeps {
  db: Database;
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  apiKeysRepo: ApiKeysRepo;
  usersRepo: UsersRepo;
  policiesRepo: PoliciesRepo;
  auditRepo: AuditRepo;
  projectsRepo: ProjectsRepo;
  workersRepo: WorkersRepo;
  usageRepo: UsageRepo;
  depsRepo: DependenciesRepo;
  syncManager: SyncManager;
  hub: WebSocketHub;
  headlessProgramsRepo: HeadlessProgramsRepo;
  settingsRepo: SettingsRepo;
  skillsRepo: SkillsRepo;
  jobInterventionsRepo: JobInterventionsRepo;
  config: Config;
  resourceLeaseManager: WorkerResourceLeaseManager;
  processTracker?: ProcessTracker;
  dispatchJob?: (jobId: string) => { ok: boolean; error?: string };
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const chatSessions = new CodexChatSessionManager();

  // Global error handler - catch unhandled errors and return JSON
  app.onError((err, c) => {
    logger.error("http", `Unhandled error on ${c.req.method} ${c.req.path}: ${err.message}`);
    return errorResponse(c, 500, "Internal server error", "INTERNAL_ERROR");
  });

  app.use(
    "*",
    cors(
      deps.config.corsOrigins.length > 0
        ? { origin: deps.config.corsOrigins }
        : { origin: ["http://localhost:1420", "http://localhost:5173", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] },
    ),
  );

  // Optional server-side network policy enforcement (IP/domain allow/deny lists).
  app.use("*", async (c, next) => {
    const controls = getNetworkControls(deps.settingsRepo);
    const decision = evaluateNetworkAccess({
      ip: getClientIp(c),
      domain: extractDomainForPolicy(c.req.url, c.req.header("origin")),
      controls,
    });
    if (!decision.allowed) {
      logger.warn(
        "security",
        `HTTP request denied: ${decision.reason ?? "network policy"} ${c.req.method} ${c.req.path}`,
      );
      return errorResponse(c, 403, decision.reason ?? "Forbidden", "FORBIDDEN");
    }
    return next();
  });

  // API routes
  app.route("/", createHealthRoutes());
  app.route("/api/auth", createAuthRoutes(deps.usersRepo, deps.auditRepo, deps.apiKeysRepo, deps.settingsRepo));
  app.route("/api/users", createUserRoutes(deps.usersRepo, deps.auditRepo, deps.jobsRepo, deps.usageRepo));
  app.route(
    "/api/jobs",
    createJobRoutes(
      deps.jobsRepo,
      deps.agentsRepo,
      deps.policiesRepo,
      deps.usersRepo,
      deps.auditRepo,
      deps.usageRepo,
      deps.depsRepo,
      deps.apiKeysRepo,
      deps.settingsRepo,
      deps.jobInterventionsRepo,
      deps.hub,
      deps.dispatchJob,
      deps.config.coordinatorPlaybooksDir,
      deps.config.coordinatorPlaybookSourcePaths,
      deps.processTracker,
    ),
  );
  app.route("/api/agent-configs", createAgentRoutes(deps.agentsRepo, deps.usersRepo, deps.auditRepo, deps.apiKeysRepo, deps.settingsRepo, deps.hub, deps.workersRepo));
  app.route("/api/keys", createApiKeyRoutes(deps.apiKeysRepo, deps.usersRepo, deps.auditRepo));
  app.route("/api/policies", createPolicyRoutes(deps.policiesRepo, deps.usersRepo, deps.auditRepo));
  app.route("/api/audit-log", createAuditRoutes(deps.auditRepo, deps.usersRepo));
  app.route("/api/stats", createStatsRoutes(deps));
  app.route("/api/connections", createConnectionRoutes(deps.hub, deps.usersRepo, deps.auditRepo));
  app.route("/api/projects", createProjectRoutes(deps.projectsRepo, deps.usersRepo, deps.apiKeysRepo, deps.auditRepo));
  app.route(
    "/api/workers",
    createWorkerRoutes(
      deps.workersRepo,
      deps.usersRepo,
      deps.apiKeysRepo,
      deps.auditRepo,
      deps.hub,
      deps.settingsRepo,
    ),
  );
  app.route("/api/sync", createSyncRoutes(deps.syncManager, deps.apiKeysRepo));
  app.route(
    "/api/bridge-command",
    createBridgeCommandRoutes(
      deps.hub,
      deps.apiKeysRepo,
      deps.usersRepo,
      deps.policiesRepo,
      deps.headlessProgramsRepo,
      deps.config,
      deps.jobsRepo,
      deps.resourceLeaseManager,
    ),
  );
  app.route("/api/headless-programs", createHeadlessProgramRoutes(deps.headlessProgramsRepo, deps.usersRepo, deps.apiKeysRepo));
  app.route(
    "/api/chat",
    createChatRoutes({
      agentsRepo: deps.agentsRepo,
      usersRepo: deps.usersRepo,
      apiKeysRepo: deps.apiKeysRepo,
      settingsRepo: deps.settingsRepo,
      workersRepo: deps.workersRepo,
      hub: deps.hub,
      config: deps.config,
      chatSessions,
    }),
  );
  app.route(
    "/api/settings",
    createSettingsRoutes(
      deps.settingsRepo,
      deps.usersRepo,
      deps.auditRepo,
      deps.jobsRepo,
      deps.agentsRepo,
      deps.headlessProgramsRepo,
      deps.hub,
      deps.config.coordinatorScriptsDir,
      deps.config.coordinatorPlaybooksDir,
      deps.config.coordinatorImportsDir,
      deps.config.snapshotsDir,
      deps.config.coordinatorReferencePaths,
      deps.config.coordinatorPlaybookSourcePaths,
      deps.db,
      deps.workersRepo,
      deps.skillsRepo,
    ),
  );

  // Skills system — unified lazy-loaded prompt context
  const skillIndex = new SkillIndex(() =>
    materializeSkills({ skillsRepo: deps.skillsRepo }),
  );
  app.route("/api/skills", createSkillsRoutes(deps.skillsRepo, skillIndex, deps.usersRepo, deps.apiKeysRepo, deps.settingsRepo, deps.workersRepo));

  // MCP tool server for AI agent bridge interaction and job orchestration
  const mcpDeps = {
    hub: deps.hub,
    policiesRepo: deps.policiesRepo,
    headlessProgramsRepo: deps.headlessProgramsRepo,
    config: deps.config,
    resourceLeaseManager: deps.resourceLeaseManager,
    processTracker: deps.processTracker,
    // Job repos — let orchestrator agents create and monitor sub-jobs via MCP
    jobsRepo: deps.jobsRepo,
    jobInterventionsRepo: deps.jobInterventionsRepo,
    agentsRepo: deps.agentsRepo,
    depsRepo: deps.depsRepo,
    skillIndex,
  };
  app.route("/mcp", createMcpRoutes(mcpDeps, deps.apiKeysRepo, deps.usersRepo));

  function resolveAdminDistPath(): string | null {
    const envPath = process.env.ARKESTRATOR_ADMIN_DIST?.trim();
    const resourceSuffixes = [
      "admin/dist",
      "client/resources/admin-dist",
      "client/src-tauri/resources/admin-dist",
      "admin-dist",
      "resources/admin-dist",
      "Resources/admin-dist",
      "Resources/resources/admin-dist",
      "Resources/_up_/resources/admin-dist",
    ];
    const baseDirs = [
      import.meta.dir,
      process.cwd(),
      dirname(process.execPath),
    ];
    const candidates = [
      envPath,
      ...baseDirs.flatMap((base) => resourceSuffixes.map((suffix) => join(base, "../../", suffix))),
      ...baseDirs.flatMap((base) => resourceSuffixes.map((suffix) => join(base, suffix))),
      ...baseDirs.flatMap((base) => resourceSuffixes.map((suffix) => join(base, "../", suffix))),
    ].filter((p): p is string => !!p);

    for (const candidate of candidates) {
      if (existsSync(join(candidate, "index.html"))) {
        return candidate;
      }
    }
    return null;
  }

  let adminDistPath: string | null = null;
  let adminPathWarningShown = false;

  function getAdminDistPath(): string | null {
    const resolved = resolveAdminDistPath();
    if (resolved) {
      if (resolved !== adminDistPath) {
        logger.info("http", `Serving admin SPA from ${resolved}`);
      }
      adminDistPath = resolved;
      adminPathWarningShown = false;
      return adminDistPath;
    }

    if (!adminPathWarningShown) {
      logger.warn("http", "Admin SPA dist not found; /admin will return 404 until admin build exists");
      adminPathWarningShown = true;
    }
    adminDistPath = null;
    return null;
  }

  app.use("/admin/*", async (c, next) => {
    const root = getAdminDistPath();
    if (!root) return c.notFound();
    return serveStatic({
      root,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, ""),
    })(c, next);
  });

  // SPA fallback: serve index.html for navigation routes only (not static assets)
  const spaFallback = async (c: any) => {
    const root = getAdminDistPath();
    if (!root) return c.notFound();
    const html = await Bun.file(join(root, "index.html")).text();
    return c.html(html);
  };
  app.get("/admin", spaFallback);
  app.get("/admin/*", async (c) => {
    // Don't serve index.html for static asset requests — let them 404 properly
    const path = new URL(c.req.url).pathname;
    if (/\.\w+$/.test(path)) {
      return c.notFound();
    }
    return spaFallback(c);
  });

  return app;
}
