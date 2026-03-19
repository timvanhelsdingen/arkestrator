// Catch unhandled errors so the server doesn't silently crash
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

import { loadConfig, type Config } from "./config.js";
import { openDatabase } from "./db/database.js";
import { JobsRepo } from "./db/jobs.repo.js";
import { AgentsRepo } from "./db/agents.repo.js";
import { ApiKeysRepo } from "./db/apikeys.repo.js";
import { UsersRepo } from "./db/users.repo.js";
import { PoliciesRepo } from "./db/policies.repo.js";
import { AuditRepo } from "./db/audit.repo.js";
import { ProjectsRepo } from "./db/projects.repo.js";
import { WorkersRepo } from "./db/workers.repo.js";
import { UsageRepo } from "./db/usage.repo.js";
import { DependenciesRepo } from "./db/dependencies.repo.js";
import { HeadlessProgramsRepo } from "./db/headless-programs.repo.js";
import { SettingsRepo } from "./db/settings.repo.js";
import { JobInterventionsRepo } from "./db/job-interventions.repo.js";
import { SyncManager } from "./workspace/sync-manager.js";
import { WebSocketHub } from "./ws/hub.js";
import { handleMessage } from "./ws/handler.js";
import { handleClientDisconnect } from "./agents/client-dispatch.js";
import type { ServerWebSocket } from "bun";
import type { WsData } from "./ws/hub.js";
import { ProcessTracker } from "./agents/process-tracker.js";
import { Scheduler } from "./queue/scheduler.js";
import { WorkerLoop } from "./queue/worker.js";
import { createApp } from "./app.js";
import { WorkerResourceLeaseManager } from "./agents/resource-control.js";
import { LocalLlmGate } from "./agents/local-llm-gate.js";
import { setLogLevel } from "./utils/logger.js";
import { logger } from "./utils/logger.js";
import { newId } from "./utils/id.js";
import { readSharedConfig, writeSharedConfig, getSharedConfigPath } from "./utils/shared-config.js";
import { normalizeCodexArgs } from "./utils/codex-args.js";
import { seedCoordinatorScripts, ensureCoordinatorScript } from "./agents/engines.js";
import { seedCoordinatorPlaybooks } from "./agents/coordinator-playbooks.js";
import { runScheduledCoordinatorTrainingTick } from "./agents/coordinator-training.js";
import { deriveWorkerIdentity } from "./utils/worker-identity.js";
import {
  findStaleLoopbackWorkerIds,
  resolveCanonicalLoopbackWorkerName,
} from "./utils/local-worker.js";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  evaluateNetworkAccess,
  extractDomainForPolicy,
  getNetworkControls,
} from "./security/network-policy.js";
import { evaluateWorkerAccess } from "./security/worker-rules.js";

/** Retry Bun.serve() up to `retries` times to handle orphaned sockets on Windows */
async function serveWithRetry(fn: () => ReturnType<typeof Bun.serve>, retries = 15, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return fn();
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" && i < retries - 1) {
        logger.warn("server", `Port in use, retrying in ${delayMs}ms... (${i + 1}/${retries})`);
        await Bun.sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to start server after retries");
}

function parseOfferedProtocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractWsApiKeyFromProtocol(header: string | null): { token?: string; protocol?: string } {
  const offered = parseOfferedProtocols(header);
  for (const protocol of offered) {
    if (!protocol.startsWith("arkestrator.auth.")) continue;
    const token = protocol.slice("arkestrator.auth.".length).trim();
    if (token) return { token, protocol };
  }
  return {};
}

function generateBootstrapSecret(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function writeBootstrapCredentials(dbPath: string, username: string, password: string): string {
  const outDir = dirname(dbPath);
  const outPath = join(outDir, "bootstrap-admin.txt");
  mkdirSync(outDir, { recursive: true });
  const content = [
    "# Arkestrator bootstrap credentials",
    "# Rotate immediately after first login.",
    `username=${username}`,
    `password=${password}`,
    `generatedAt=${new Date().toISOString()}`,
    "",
  ].join("\n");
  writeFileSync(outPath, content, { mode: 0o600 });
  return outPath;
}

function directoryHasEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function copyMissingTree(sourceDir: string, targetDir: string): { copiedFiles: number; skippedFiles: number } {
  mkdirSync(targetDir, { recursive: true });
  let copiedFiles = 0;
  let skippedFiles = 0;

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      const nested = copyMissingTree(sourcePath, targetPath);
      copiedFiles += nested.copiedFiles;
      skippedFiles += nested.skippedFiles;
      continue;
    }

    if (!entry.isFile()) continue;
    if (existsSync(targetPath)) {
      skippedFiles += 1;
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    copiedFiles += 1;
  }

  return { copiedFiles, skippedFiles };
}

function migrateLegacyCoordinatorData(config: Config): void {
  const migrationPairs = [
    {
      label: "coordinator scripts",
      from: resolve("./data/coordinator-scripts"),
      to: resolve(config.coordinatorScriptsDir),
    },
    {
      label: "coordinator playbooks/training",
      from: resolve("./data/coordinator-playbooks"),
      to: resolve(config.coordinatorPlaybooksDir),
    },
    {
      label: "coordinator imports",
      from: resolve("./data/coordinator-imports"),
      to: resolve(config.coordinatorImportsDir),
    },
  ];

  for (const pair of migrationPairs) {
    if (pair.from === pair.to) continue;
    if (!directoryHasEntries(pair.from)) continue;

    const result = copyMissingTree(pair.from, pair.to);
    if (result.copiedFiles > 0) {
      logger.warn(
        "server",
        `Migrated ${result.copiedFiles} legacy ${pair.label} file(s) from ${pair.from} to ${pair.to}`,
      );
    }
    if (result.skippedFiles > 0) {
      logger.info(
        "server",
        `Skipped ${result.skippedFiles} existing ${pair.label} file(s) during legacy migration`,
      );
    }
  }
}

async function main() {
  // 1. Load config
  const config = loadConfig();
  setLogLevel(config.logLevel);
  logger.info("server", "Starting Arkestrator server...");
  migrateLegacyCoordinatorData(config);

  // 2. Initialize database
  const db = openDatabase(config.dbPath);

  // 3. Initialize repositories
  const jobsRepo = new JobsRepo(db);
  const agentsRepo = new AgentsRepo(db);
  const apiKeysRepo = new ApiKeysRepo(db);
  const usersRepo = new UsersRepo(db);
  const policiesRepo = new PoliciesRepo(db);
  const auditRepo = new AuditRepo(db);
  const projectsRepo = new ProjectsRepo(db);
  const workersRepo = new WorkersRepo(db);
  const usageRepo = new UsageRepo(db);
  const depsRepo = new DependenciesRepo(db);
  const headlessProgramsRepo = new HeadlessProgramsRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const jobInterventionsRepo = new JobInterventionsRepo(db);
  const syncManager = new SyncManager(config);

  // 4. Seed defaults on first run
  const firstRun = usersRepo.isEmpty();
  if (firstRun) {
    const bootstrapUsername = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || "admin";
    const bootstrapPasswordEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
    const bootstrapPassword = bootstrapPasswordEnv && bootstrapPasswordEnv.length >= 12
      ? bootstrapPasswordEnv
      : generateBootstrapSecret(24);

    await usersRepo.create(bootstrapUsername, bootstrapPassword, "admin");
    const credentialsPath = writeBootstrapCredentials(
      config.dbPath,
      bootstrapUsername,
      bootstrapPassword,
    );
    logger.info("server", "=".repeat(60));
    logger.info("server", "First run detected. Created bootstrap admin user:");
    logger.info("server", `  Username: ${bootstrapUsername}`);
    logger.info("server", `  Credentials written to: ${credentialsPath}`);
    logger.info("server", "Rotate this bootstrap password after first login.");
    logger.info("server", "=".repeat(60));
  }

  if (apiKeysRepo.isEmpty()) {
    const { rawKey } = await apiKeysRepo.create(
      "Default Admin Key",
      "admin",
    );
    logger.info("server", "=".repeat(60));
    logger.info("server", "First run detected. Generated default admin API key.");
    logger.info("server", "Raw key is not logged. Retrieve via authenticated API key management endpoints.");
    logger.info("server", "=".repeat(60));

    // Write API key to shared config file so bridges can auto-connect
    const firstRunResult = writeSharedConfig(config.port, rawKey);
    if (firstRunResult === "written") {
      logger.info("server", `Shared config written to ${getSharedConfigPath()}`);
    } else {
      logger.warn("server", `Shared config NOT written — another server owns ${getSharedConfigPath()} (or writing is disabled via NO_SHARED_CONFIG=1)`);
    }
  }
  // Ensure the shared config is always usable for spawned CLI jobs and bridges.
  // The shared config key MUST have admin or bridge role — a "client" role key
  // will be rejected by bridges (403: "Client API keys cannot open bridge sockets").
  // This recovers from cases where the DB persists but ~/.arkestrator/config.json
  // is missing, stale, or was overwritten with a non-admin key during login.
  {
    const existingShared = readSharedConfig();
    let sharedApiKey = String(existingShared?.apiKey ?? "").trim();
    let sharedApiKeyUsable = false;
    if (sharedApiKey) {
      try {
        const validated = await apiKeysRepo.validate(sharedApiKey);
        // Key must exist AND have a role that bridges can use (admin or bridge)
        sharedApiKeyUsable = !!(validated && validated.role !== "client");
      } catch {
        sharedApiKeyUsable = false;
      }
    }
    if (!sharedApiKeyUsable) {
      apiKeysRepo.revokeByNamePrefix("Runtime Shared Key");
      const created = await apiKeysRepo.create("Runtime Shared Key", "admin");
      sharedApiKey = created.rawKey;
      logger.info("server", "Generated runtime shared API key for CLI/bridge orchestration.");
    }
    const sharedResult = writeSharedConfig(config.port, sharedApiKey);
    if (sharedResult === "written") {
      logger.info("server", `Shared config written to ${getSharedConfigPath()}`);
    } else {
      logger.warn("server", `Shared config NOT written — another server owns ${getSharedConfigPath()} (or writing is disabled via NO_SHARED_CONFIG=1). Spawned CLI agents on this host may not auto-discover this server.`);
    }
  }

  // Enable client-side coordination by default unless explicitly disabled
  if (!settingsRepo.get("allow_client_coordination")) {
    settingsRepo.setBool("allow_client_coordination", true);
    logger.info("server", "Client-side coordination enabled by default.");
  }

  if (firstRun && agentsRepo.list().length === 0) {
    logger.info("server", "First run detected. Agent configs start empty by default.");
    logger.info("server", "Create an agent config from templates in Admin > Agents.");
  }

  // Normalize legacy Codex args in existing configs so prompt passing stays stable
  // across Codex CLI upgrades (e.g. old "-p" / "--approval-mode full-auto").
  sanitizeAgentConfigs(agentsRepo);

  if (config.seedExampleHeadlessPrograms && headlessProgramsRepo.list().length === 0) {
    headlessProgramsRepo.create({
      program: "blender",
      displayName: "Blender (Headless)",
      executable: "blender",
      argsTemplate: ["--background", "--python-expr", "{{SCRIPT}}"],
      language: "python",
    });
    headlessProgramsRepo.create({
      program: "godot",
      displayName: "Godot (Headless)",
      executable: "godot",
      argsTemplate: ["--headless", "--path", "{{PROJECT_PATH}}", "--script", "{{SCRIPT_FILE}}"],
      language: "gdscript",
    });
    headlessProgramsRepo.create({
      program: "houdini",
      displayName: "Houdini (hython)",
      executable: "hython",
      argsTemplate: ["-c", "{{SCRIPT}}"],
      language: "python",
    });
    logger.info(
      "server",
      "Seeded example headless program configs (blender, godot, houdini). Disable with SEED_EXAMPLE_HEADLESS_PROGRAMS=false.",
    );
  }

  // Optional executable hint map (JSON via HEADLESS_EXECUTABLE_HINTS_JSON).
  // This avoids hardcoding machine-specific paths in core logic.
  for (const [program, knownPaths] of Object.entries(config.headlessExecutableHints)) {
    const existing = headlessProgramsRepo.getByProgram(program);
    if (!existing || !existing.enabled) continue;
    const executable = String(existing.executable || "").trim();
    if (executable.includes("/") && existsSync(executable)) continue;
    const resolved = knownPaths.find((candidate) => existsSync(candidate));
    if (!resolved || resolved === executable) continue;
    headlessProgramsRepo.update(existing.id, { executable: resolved });
    logger.info("server", `Updated ${program} headless executable to detected path: ${resolved}`);
  }

  // Seed coordinator scripts directory with per-bridge defaults (on every startup, for new scripts)
  seedCoordinatorScripts(config.coordinatorScriptsDir);
  logger.info("server", `Coordinator scripts seeded at ${config.coordinatorScriptsDir}`);
  seedCoordinatorPlaybooks(config.coordinatorPlaybooksDir);
  logger.info("server", `Coordinator playbooks seeded at ${config.coordinatorPlaybooksDir}`);

  // 5. Create infrastructure
  const hub = new WebSocketHub();
  const processTracker = new ProcessTracker(config.jobTimeoutMs);
  const scheduler = new Scheduler(jobsRepo);
  const resourceLeaseManager = new WorkerResourceLeaseManager();
  const localLlmGate = new LocalLlmGate();

  // 5b. Recover orphaned "running" jobs from a previous server instance
  // When the server restarts (e.g. --watch), jobs that were mid-flight lose
  // their process tracking. Mark them as failed so the user can requeue manually.
  {
    const { jobs: orphaned } = jobsRepo.list(["running"]);
    for (const job of orphaned) {
      logger.warn("server", `Recovering orphaned running job ${job.id} (${job.name ?? "unnamed"}) → failed`);
      jobsRepo.fail(job.id, "Server restarted while job was running. Requeue to retry.", job.logs ?? "");
    }
    if (orphaned.length > 0) {
      logger.info("server", `Recovered ${orphaned.length} orphaned job(s) (marked as failed)`);
    }
  }

  // 6. Start timeout checker
  processTracker.startTimeoutChecker((jobId) => {
    jobsRepo.fail(jobId, "Job timed out", "");
  });

  // 7. Start sync manager cleanup timer
  syncManager.start();

  // 7.5. Schedule periodic session cleanup (every hour)
  const sessionCleanupInterval = setInterval(() => {
    usersRepo.cleanExpiredSessions();
    logger.info("server", "Cleaned expired sessions");
  }, 60 * 60 * 1000);

  // 8. Create worker loop
  const worker = new WorkerLoop({
    scheduler,
    processTracker,
    agentsRepo,
    jobsRepo,
    policiesRepo,
    projectsRepo,
    workersRepo,
    usageRepo,
    usersRepo,
    depsRepo,
    headlessProgramsRepo,
    settingsRepo,
    syncManager,
    config,
    hub,
    resourceLeaseManager,
    localLlmGate,
    maxConcurrent: config.maxConcurrentAgents,
    pollIntervalMs: config.workerPollMs,
  });

  // 9. Create Hono app
  const app = createApp({ db, jobsRepo, agentsRepo, apiKeysRepo, usersRepo, policiesRepo, auditRepo, projectsRepo, workersRepo, usageRepo, depsRepo, syncManager, hub, headlessProgramsRepo, settingsRepo, jobInterventionsRepo, config, resourceLeaseManager, processTracker, dispatchJob: (id) => worker.dispatchById(id) });

  // Handler deps for WebSocket messages
  const handlerDeps = {
    jobsRepo,
    agentsRepo,
    projectsRepo,
    policiesRepo,
    usersRepo,
    usageRepo,
    depsRepo,
    hub,
    processTracker,
    headlessProgramsRepo,
    workersRepo,
    jobInterventionsRepo,
    config,
    resourceLeaseManager,
    localLlmGate,
  };

  // 10. Start server with Bun.serve (handles both HTTP and WebSocket)
  const tlsConfig = config.tlsCertPath && config.tlsKeyPath
    ? { cert: Bun.file(config.tlsCertPath), key: Bun.file(config.tlsKeyPath) }
    : undefined;

  const server = await serveWithRetry(() => Bun.serve({
    port: config.port,
    tls: tlsConfig,
    // SSE streams (chat, job logs) can take minutes before producing data.
    // Bun's default HTTP idle timeout is 10s, which kills long-running SSE
    // connections before the spawned AI process produces its first output.
    // Set to 0 to disable; chat.ts has its own 5-minute process timeout.
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade at /ws
      if (url.pathname === "/ws") {
        const forwardedIp = config.trustProxyHeaders
          ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? req.headers.get("x-real-ip")
            ?? undefined
          : undefined;
        const preIp =
          forwardedIp ??
          server.requestIP(req)?.address ??
          undefined;
        const preDecision = evaluateNetworkAccess({
          ip: preIp,
          domain: extractDomainForPolicy(req.url, req.headers.get("origin") ?? undefined),
          controls: getNetworkControls(settingsRepo),
        });
        if (!preDecision.allowed) {
          logger.warn(
            "security",
            `WS upgrade denied: ${preDecision.reason ?? "network policy"}`,
          );
          return new Response(preDecision.reason ?? "Forbidden", { status: 403 });
        }

        // Authenticate via API key before upgrading
        const wsProtocolAuth = extractWsApiKeyFromProtocol(
          req.headers.get("sec-websocket-protocol"),
        );
        const rawKey = url.searchParams.get("key") ?? wsProtocolAuth.token ?? null;
        if (!rawKey) {
          return new Response("API key required", { status: 401 });
        }
        const apiKey = await apiKeysRepo.validate(rawKey);
        if (!apiKey) {
          return new Response("Invalid API key", { status: 401 });
        }

        // Extract client IP, normalising IPv6 representations to IPv4 where possible
        const rawIp =
          forwardedIp ??
          server.requestIP(req)?.address ??
          undefined;
        const ip = rawIp
          ? rawIp.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1")
          : undefined;

        const wsType = url.searchParams.get("type") === "client" ? "client" : "bridge";
        if (wsType === "client" && apiKey.role === "bridge") {
          return new Response("Bridge API keys cannot open client sockets", { status: 403 });
        }
        if (wsType === "bridge" && (apiKey.role === "client" || apiKey.role === "mcp")) {
          return new Response("Client/MCP API keys cannot open bridge sockets", { status: 403 });
        }

        const name = url.searchParams.get("name") ?? undefined;
        const program = url.searchParams.get("program") ?? undefined;
        const programVersion = url.searchParams.get("programVersion") ?? undefined;
        const bridgeVersion = url.searchParams.get("bridgeVersion") ?? undefined;
        const projectPath = url.searchParams.get("projectPath") ?? undefined;
        const osUser = url.searchParams.get("osUser") ?? undefined;
        const machineId = url.searchParams.get("machineId") ?? undefined;
        const workerModeParam = url.searchParams.get("workerMode");
        const workerMode = workerModeParam === "false" ? false : true;
        const requestedWorkerName = wsType === "bridge"
          ? resolveCanonicalLoopbackWorkerName({
            socketWorkerName: url.searchParams.get("workerName"),
            sharedWorkerName: readSharedConfig()?.workerName,
            ip,
          })
          : (url.searchParams.get("workerName") ?? undefined);
        const workerName = deriveWorkerIdentity({
          workerName: requestedWorkerName,
          osUser,
          ip,
          name,
          program,
        });

        if (wsType === "bridge" && workerName) {
          const workerDecision = evaluateWorkerAccess(settingsRepo, workerName, ip ?? undefined);
          if (!workerDecision.allowed) {
            logger.warn("security", `WS bridge denied for worker "${workerName}": ${workerDecision.reason}`);
            return new Response(workerDecision.reason, { status: 403 });
          }
        }

        const upgraded = server.upgrade(req, {
          headers: wsProtocolAuth.protocol
            ? { "Sec-WebSocket-Protocol": wsProtocolAuth.protocol }
            : undefined,
          data: {
            id: newId(),
            role: apiKey.role,
            type: wsType,
            name,
            connectedAt: new Date().toISOString(),
            program,
            programVersion,
            bridgeVersion,
            projectPath,
            machineId,
            workerName,
            ip: ip ?? undefined,
            osUser,
            workerMode,
          },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Everything else goes to Hono. Wrap in try/catch to avoid unhandled throws
      try {
        return await app.fetch(req);
      } catch (err: any) {
        logger.error("http", `Error while handling ${req.method} ${url.pathname}: ${err?.message ?? err}`);
        try {
          return new Response("Internal server error", { status: 500 });
        } catch {
          // If constructing a response fails for some reason, return a minimal fallback
          return new Response(null, { status: 500 });
        }
      }
    },
    websocket: {
      // Disable Bun's built-in idle timeout; we send manual pings instead
      idleTimeout: 0,
      open(rawWs) {
        const ws = rawWs as ServerWebSocket<WsData>;
        ws.data.lastPongAt = Date.now();
        // Auth already validated in fetch handler before upgrade
        hub.register(ws);
        logger.info(
          "server",
          `WebSocket connection: ${ws.data.type} (${ws.data.id}) role=${ws.data.role}`,
        );

        // Notify clients when a bridge connects
        if (ws.data.type === "bridge") {
          hub.broadcastBridgeStatus();
          // Upsert worker record and bridge program history using the
          // workerName supplied by the socket (or a local fallback derivation).
          // Do not merge workers across sockets by IP/osUser: multiple machines
          // can legitimately share those values behind proxies/NAT, and collapsing
          // them causes workers to swap names or presence in the UI.
          ws.data.workerName = ws.data.workerName ?? deriveWorkerIdentity({
            workerName: resolveCanonicalLoopbackWorkerName({
              socketWorkerName: ws.data.workerName,
              sharedWorkerName: readSharedConfig()?.workerName,
              ip: ws.data.ip,
            }),
            osUser: ws.data.osUser,
            ip: ws.data.ip,
            name: ws.data.name,
            program: ws.data.program,
          });
          if (ws.data.workerName) {
            const worker = workersRepo.upsert(
              ws.data.workerName,
              ws.data.program,
              ws.data.projectPath,
              ws.data.ip,
              ws.data.machineId,
            );
            ws.data.workerName = worker.name;
            ws.data.machineId = worker.machineId ?? ws.data.machineId;
            for (const staleWorkerId of findStaleLoopbackWorkerIds(
              workersRepo.list(),
              ws.data.workerName,
              ws.data.ip,
            )) {
              workersRepo.delete(staleWorkerId);
            }
            // Track this program in worker_bridges for offline awareness
            if (ws.data.program) {
              workersRepo.upsertBridge(
                ws.data.workerName,
                ws.data.program,
                ws.data.programVersion,
                ws.data.bridgeVersion,
                ws.data.projectPath,
                ws.data.machineId,
              );
              // Auto-create coordinator script for newly detected programs
              ensureCoordinatorScript(config.coordinatorScriptsDir, ws.data.program);
            }
          }
          hub.broadcastWorkerStatus(workersRepo);
        }

        // Register client as a worker (client is the canonical source of machine identity)
        if (ws.data.type === "client") {
          if (ws.data.workerName) {
            const worker = workersRepo.upsert(
              ws.data.workerName,
              undefined, // no program for clients
              undefined, // no project path for clients
              ws.data.ip,
              ws.data.machineId,
            );
            ws.data.workerName = worker.name;
            ws.data.machineId = worker.machineId ?? ws.data.machineId;
            for (const staleWorkerId of findStaleLoopbackWorkerIds(
              workersRepo.list(),
              ws.data.workerName,
              ws.data.ip,
            )) {
              workersRepo.delete(staleWorkerId);
            }
            hub.broadcastWorkerStatus(workersRepo);
          }
          hub.sendContextSync(ws.data.id);
          hub.sendBridgeStatus(ws.data.id);
          hub.sendWorkerStatus(ws.data.id, workersRepo);
        }
      },
      message(rawWs, message) {
        const ws = rawWs as ServerWebSocket<WsData>;
        hub.recordMessage(ws.data.id);
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        handleMessage(ws, raw, handlerDeps);
      },
      pong(rawWs) {
        const ws = rawWs as ServerWebSocket<WsData>;
        hub.recordPong(ws.data.id);
      },
      close(rawWs) {
        const ws = rawWs as ServerWebSocket<WsData>;
        hub.unregister(ws);

        // Fail any client-dispatched jobs if the client disconnects
        if (ws.data.type === "client") {
          handleClientDisconnect(ws.data.id);
          // Broadcast updated worker status so other clients see this
          // machine go offline (client presence affects worker status)
          hub.broadcastWorkerStatus(workersRepo);
        }

        // Notify clients when a bridge disconnects
        if (ws.data.type === "bridge") {
          hub.broadcastBridgeStatus();
          if (ws.data.workerName) {
            workersRepo.touchLastSeen(ws.data.workerName, ws.data.machineId);
          }
          hub.broadcastWorkerStatus(workersRepo);
        }
      },
    },
  }));

  // 11. Start worker loop
  worker.start();

  // 12. WebSocket keepalive: ping all clients every 30s to prevent idle disconnects
  const wsHeartbeatInterval = setInterval(() => {
    const removedStale = hub.pingAll();
    if (removedStale) {
      // Broadcast updated status so clients see stale workers go offline
      hub.broadcastBridgeStatus();
      hub.broadcastWorkerStatus(workersRepo);
    }
  }, 30_000);

  // 13. Coordinator training scheduler tick (every minute)
  const coordinatorTrainingInterval = setInterval(() => {
    try {
      const queued = runScheduledCoordinatorTrainingTick({
        jobsRepo,
        agentsRepo,
        settingsRepo,
        headlessProgramsRepo,
        hub,
        coordinatorScriptsDir: config.coordinatorScriptsDir,
        coordinatorPlaybooksDir: config.coordinatorPlaybooksDir,
        defaultCoordinatorPlaybookSourcePaths: config.coordinatorPlaybookSourcePaths,
      });
      if (queued.length > 0) {
        logger.info(
          "coordinator-training",
          `Queued scheduled training jobs: ${queued.map((item) => `${item.program}:${item.jobId}`).join(", ")}`,
        );
      }
    } catch (err: any) {
      logger.warn("coordinator-training", `Scheduled training tick failed: ${String(err?.message ?? err)}`);
    }
  }, 60_000);

  const protocol = tlsConfig ? "https" : "http";
  const wsProtocol = tlsConfig ? "wss" : "ws";
  logger.info(
    "server",
    `Server listening on ${protocol}://localhost:${server.port}`,
  );
  logger.info(
    "server",
    `WebSocket endpoint: ${wsProtocol}://localhost:${server.port}/ws`,
  );
  if (tlsConfig) {
    logger.info("server", "TLS enabled");
  }

  // 12. Graceful shutdown
  process.on(
    "SIGINT",
    () => shutdown(worker, processTracker, syncManager, sessionCleanupInterval, wsHeartbeatInterval, coordinatorTrainingInterval, db),
  );
  process.on(
    "SIGTERM",
    () => shutdown(worker, processTracker, syncManager, sessionCleanupInterval, wsHeartbeatInterval, coordinatorTrainingInterval, db),
  );
}

function shutdown(
  worker: WorkerLoop,
  processTracker: ProcessTracker,
  syncManager: SyncManager,
  sessionCleanupInterval: ReturnType<typeof setInterval>,
  wsHeartbeatInterval: ReturnType<typeof setInterval>,
  coordinatorTrainingInterval: ReturnType<typeof setInterval>,
  db: ReturnType<typeof openDatabase>,
) {
  logger.info("server", "Shutting down...");
  worker.stop();
  processTracker.stop();
  syncManager.stop();
  clearInterval(sessionCleanupInterval);
  clearInterval(wsHeartbeatInterval);
  clearInterval(coordinatorTrainingInterval);
  db.close();
  process.exit(0);
}

// Prevent unhandled errors from crashing the server
process.on("uncaughtException", (err) => {
  logger.error("server", `Uncaught exception: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
  logger.error("server", `Unhandled rejection: ${reason}`);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

function sanitizeAgentConfigs(agentsRepo: AgentsRepo) {
  const configs = agentsRepo.list();
  let updated = 0;

  for (const cfg of configs) {
    let args = cfg.args ?? [];
    let changed = false;

    if (cfg.engine === "codex") {
      const normalized = normalizeCodexArgs(args);
      if (JSON.stringify(normalized) !== JSON.stringify(args)) {
        args = normalized;
        changed = true;
      }
    } else if (cfg.engine === "claude-code") {
      // Strip legacy -p, --print, --model from args (these are added programmatically)
      const filtered = args.filter(a => a !== "-p" && a !== "--print" && a !== "--model");
      if (filtered.length !== args.length) {
        args = filtered;
        changed = true;
      }
    }

    if (changed) {
      agentsRepo.update({ ...cfg, args });
      updated++;
    }
  }

  if (updated > 0) {
    logger.info("server", `Normalized legacy args in ${updated} agent config(s)`);
  }
}
