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
import { SkillsRepo } from "./db/skills.repo.js";
import { TemplatesRepo } from "./db/templates.repo.js";
import { SkillIndex } from "./skills/skill-index.js";
import { materializeSkills } from "./skills/skill-materializer.js";
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
import { seedDefaultTemplates } from "./routes/templates.js";
import { pullAllBridgeSkills, pullBridgeSkills } from "./skills/skill-registry.js";
import { runScheduledCoordinatorTrainingTick } from "./agents/coordinator-training.js";
import { runHousekeepingScheduleTick } from "./agents/housekeeping.js";
import { ComfyUiHealthChecker } from "./agents/comfyui-health.js";
import { deriveWorkerIdentity } from "./utils/worker-identity.js";
import {
  findStaleLoopbackWorkerIds,
  resolveCanonicalLoopbackWorkerName,
} from "./utils/local-worker.js";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  evaluateNetworkAccess,
  extractDomainForPolicy,
  getNetworkControls,
} from "./security/network-policy.js";
import { evaluateWorkerAccess, updateWorkerRule, getWorkerRule } from "./security/worker-rules.js";

/**
 * Try to kill the process occupying a port. Works on Windows (netstat+taskkill)
 * and Unix (lsof+kill). Returns true if a process was found and killed.
 */
async function tryKillPortHolder(port: number): Promise<boolean> {
  const isWindows = process.platform === "win32";
  try {
    if (isWindows) {
      // netstat -ano | findstr ":7800 " → extract PID from LISTENING line
      const netstat = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr ":${port} "`]);
      const output = netstat.stdout.toString();
      const lines = output.split(/\r?\n/).filter((line) => line.includes("LISTENING"));
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
      if (pids.size === 0) {
        logger.warn("server", `Port ${port} appears occupied but no LISTENING PID found (ghost socket). Will rely on reusePort.`);
        return false;
      }
      let anyKilled = false;
      for (const pid of pids) {
        logger.warn("server", `Killing process ${pid} holding port ${port}`);
        const result = Bun.spawnSync(["taskkill", "/F", "/PID", pid]);
        if (result.exitCode === 0) {
          anyKilled = true;
        } else {
          // Regular kill failed — try elevated (triggers UAC prompt on interactive sessions)
          logger.warn("server", `Regular kill failed for PID ${pid}, attempting elevated kill...`);
          const elevated = Bun.spawnSync([
            "powershell", "-Command",
            `Start-Process taskkill -ArgumentList '/F','/PID','${pid}' -Verb RunAs -Wait -WindowStyle Hidden`,
          ]);
          if (elevated.exitCode === 0) {
            anyKilled = true;
            logger.info("server", `Elevated kill succeeded for PID ${pid}`);
          } else {
            logger.warn("server", `Elevated kill also failed for PID ${pid} (ghost socket — will rely on reusePort)`);
          }
        }
      }
      return anyKilled;
    } else {
      // Unix: lsof -ti :port → PIDs
      const lsof = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
      const output = lsof.stdout.toString().trim();
      if (!output) return false;
      const pids = output.split(/\s+/).filter((p) => /^\d+$/.test(p));
      for (const pid of pids) {
        logger.warn("server", `Killing process ${pid} holding port ${port}`);
        Bun.spawnSync(["kill", "-9", pid]);
      }
      return pids.length > 0;
    }
  } catch {
    return false;
  }
}

/**
 * Start Bun.serve(), handling EADDRINUSE by:
 *  1. Try the requested port
 *  2. If busy, try to kill the holder process
 *  3. If still busy, try up to 10 alternative ports (port+1, port+2, …)
 * Returns { server, actualPort } so callers know which port was used.
 */
async function serveWithPortFallback(
  makeFn: (port: number) => ReturnType<typeof Bun.serve>,
  preferredPort: number,
): Promise<{ server: ReturnType<typeof Bun.serve>; actualPort: number }> {
  // Attempt 1: preferred port
  try {
    return { server: makeFn(preferredPort), actualPort: preferredPort };
  } catch (err: any) {
    if (err?.code !== "EADDRINUSE") throw err;
  }

  // Attempt 2: kill the holder and retry preferred port
  const killed = await tryKillPortHolder(preferredPort);
  if (killed) {
    logger.info("server", `Killed previous process on port ${preferredPort}, retrying...`);
    await Bun.sleep(1500);
    try {
      return { server: makeFn(preferredPort), actualPort: preferredPort };
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }

  // Attempt 3: try alternative ports
  logger.warn("server", `Port ${preferredPort} is stuck (ghost socket or another app). Scanning for a free port...`);
  for (let offset = 1; offset <= 10; offset++) {
    const candidatePort = preferredPort + offset;
    try {
      const server = makeFn(candidatePort);
      logger.info("server", `Using fallback port ${candidatePort} (preferred ${preferredPort} was unavailable)`);
      return { server, actualPort: candidatePort };
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `Could not bind to port ${preferredPort} or any of ${preferredPort + 1}–${preferredPort + 10}. `
    + `Kill the process using the port or run: powershell -Command "net stop winnat; net start winnat" (admin)`,
  );
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

/**
 * Sanitize a bridge project name sent via query parameter.
 * DCC apps often send internal identifiers (e.g. Nuke sends "Root",
 * the node name, instead of the script path).  Detect these and
 * replace with "Untitled" so the UI stays clean regardless of how
 * a third-party bridge implements its name parameter.
 */
function sanitizeBridgeName(raw: string | undefined, program: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Known DCC internal default names that are NOT real project names.
  // Bridge authors frequently pass these by mistake.
  const INTERNAL_NAMES = new Set([
    "root",       // Nuke root node name
    "untitled",   // already generic
    "scene",      // generic scene name
    "default",    // generic default
  ]);
  if (INTERNAL_NAMES.has(trimmed.toLowerCase())) {
    return "Untitled";
  }

  // If the name looks like a real file path, extract just the filename
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    const basename = trimmed.split(/[/\\]/).pop() ?? trimmed;
    return basename || "Untitled";
  }

  return trimmed;
}

function generateBootstrapSecret(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
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

/**
 * Docker fix: when the server runs as root but spawns Claude CLI / jobs as a
 * non-root user (bun/node), the CLI credentials created by `claude /login`
 * (run as root) are 0600 root:root. Claude CLI silently fails if the
 * credentials file isn't owned by the running user.
 * Detect the drop-user (bun/node) and chown the .claude dir so spawned
 * subprocesses can authenticate. Only runs when uid === 0 (Docker); no-op
 * on local machines.
 */
function fixClaudeCredentialsPerms() {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid !== "function" || getuid() !== 0) return;

  const home = process.env.HOME ?? "/root";
  const claudeDir = join(home, ".claude");
  if (!existsSync(claudeDir)) return;

  // Find the non-root user we'll drop to for subprocesses
  const dropUsers = ["bun", "node", "nobody"];
  let dropUid: number | undefined;
  let dropGid: number | undefined;
  try {
    const passwd = readFileSync("/etc/passwd", "utf-8");
    for (const user of dropUsers) {
      const line = passwd.split(/\r?\n/).find((l) => l.startsWith(`${user}:`));
      if (line) {
        const parts = line.split(":");
        dropUid = parseInt(parts[2], 10);
        dropGid = parseInt(parts[3], 10);
        break;
      }
    }
  } catch { /* no /etc/passwd — skip */ }

  if (dropUid === undefined) return;

  try {
    // Recursively fix ownership of .claude dir so the drop user owns it
    const fixOwnership = (path: string) => {
      const st = statSync(path);
      if (st.uid !== dropUid) {
        chownSync(path, dropUid!, dropGid ?? dropUid!);
      }
      if (st.isDirectory()) {
        for (const entry of readdirSync(path)) {
          fixOwnership(join(path, entry));
        }
      }
    };
    fixOwnership(claudeDir);
    logger.info("server", `Fixed Claude config ownership (uid=${dropUid}) for non-root subprocess access`);
  } catch (err) {
    logger.warn("server", `Could not fix Claude credentials ownership: ${err}`);
  }
}

async function main() {
  // 1. Load config
  const config = loadConfig();
  setLogLevel(config.logLevel);
  logger.info("server", "Starting Arkestrator server...");
  fixClaudeCredentialsPerms();
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
  const templatesRepo = new TemplatesRepo(db);
  const workersRepo = new WorkersRepo(db);
  const usageRepo = new UsageRepo(db);
  const depsRepo = new DependenciesRepo(db);
  const headlessProgramsRepo = new HeadlessProgramsRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const skillsRepo = new SkillsRepo(db);
  const { SkillEffectivenessRepo } = await import("./db/skill-effectiveness.repo.js");
  const skillEffectivenessRepo = new SkillEffectivenessRepo(db);
  const jobInterventionsRepo = new JobInterventionsRepo(db);
  const syncManager = new SyncManager(config);

  // 4. Seed defaults on first run
  const firstRun = usersRepo.isEmpty();
  if (firstRun) {
    await usersRepo.create("admin", "admin", "admin");
    logger.info("server", "First run detected. Created default admin user. Change credentials on first login.");
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
      argsTemplate: ["{{SCRIPT_FILE}}"],
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

  // Auto-discover headless executables on common install paths when the bare
  // executable name (e.g. "hython") isn't on PATH.
  // Deferred to run after the server is listening — avoids blocking startup
  // with synchronous filesystem scans on slow disks or network mounts.
  setTimeout(() => {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    // Build candidate paths dynamically by scanning install directories
    const discoverCandidates: Record<string, string[]> = { houdini: [], blender: [], godot: [] };

    // Houdini: scan Side Effects install dir for all versions, pick latest
    const sfsBase = isWindows
      ? "C:/Program Files/Side Effects Software"
      : isMac
      ? "/Applications/Houdini"
      : "/opt/hfs";
    try {
      if (existsSync(sfsBase)) {
        const dirs = readdirSync(sfsBase)
          .filter((d) => d.startsWith("Houdini ") || d.startsWith("Houdini"))
          .sort()
          .reverse(); // newest version first
        for (const dir of dirs) {
          const hythonPath = join(sfsBase, dir, "bin", isWindows ? "hython.exe" : "hython");
          if (existsSync(hythonPath)) {
            discoverCandidates.houdini.push(hythonPath);
          }
        }
      }
    } catch { /* ignore scan errors */ }

    // Blender: common install paths
    if (isWindows) {
      discoverCandidates.blender.push(
        "C:/Program Files/Blender Foundation/Blender/blender.exe",
        "C:/Program Files/Blender Foundation/Blender 4.4/blender.exe",
        "C:/Program Files/Blender Foundation/Blender 4.3/blender.exe",
      );
    } else if (isMac) {
      discoverCandidates.blender.push("/Applications/Blender.app/Contents/MacOS/Blender");
    }

    for (const [program, candidates] of Object.entries(discoverCandidates)) {
      if (candidates.length === 0) continue;
      const existing = headlessProgramsRepo.getByProgram(program);
      if (!existing || !existing.enabled) continue;
      const exe = String(existing.executable || "").trim();
      // Skip if already has a full path that exists
      if ((exe.includes("/") || exe.includes("\\")) && existsSync(exe)) continue;
      const found = candidates.find((c) => existsSync(c));
      if (found) {
        headlessProgramsRepo.update(existing.id, { executable: found });
        logger.info("server", `Auto-discovered ${program} headless executable: ${found}`);
      }
    }
  }, 0);

  // Seed coordinator scripts directory with per-bridge defaults (on every startup, for new scripts)
  seedCoordinatorScripts(config.coordinatorScriptsDir, skillsRepo);
  logger.info("server", `Coordinator scripts seeded at ${config.coordinatorScriptsDir}`);
  seedCoordinatorPlaybooks(config.coordinatorPlaybooksDir);
  logger.info("server", `Coordinator playbooks seeded at ${config.coordinatorPlaybooksDir}`);

  // Seed default prompt templates (idempotent — skips existing slugs)
  const templatesSeeded = seedDefaultTemplates(templatesRepo);
  if (templatesSeeded > 0) {
    logger.info("server", `Seeded ${templatesSeeded} default prompt template(s)`);
  }

  // Auto-pull bridge skills on first run — deferred to after server is fully up
  const shouldAutoPullSkills = skillsRepo.listAll().length === 0;

  // 5. Create infrastructure
  const hub = new WebSocketHub();
  const skillsPulledThisSession = new Set<string>(); // tracks which programs had skills pulled this session
  const processTracker = new ProcessTracker(() =>
    settingsRepo.getNumber("job_timeout_ms") ?? config.jobTimeoutMs
  );
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

  // 8. Create skill index (shared between worker and app)
  const skillIndex = new SkillIndex(() =>
    materializeSkills({ skillsRepo }),
  );

  // 8a. Create SkillStore (dual-write: SQLite + SKILL.md on disk)
  const { SkillStore } = await import("./skills/skill-store.js");
  const skillStore = new SkillStore(skillsRepo, skillIndex, {
    skillsDir: config.skillsDir,
    coordinatorPlaybooksDir: config.coordinatorPlaybooksDir,
  });

  // 8a-i. Export existing DB skills to SKILL.md files (one-time migration)
  try {
    const { exportAllSkillsToDisk } = await import("./skills/skill-export-migration.js");
    await exportAllSkillsToDisk(skillsRepo, config.skillsDir, {
      coordinatorPlaybooksDir: config.coordinatorPlaybooksDir,
      settingsRepo,
      skillEffectivenessRepo,
    });
  } catch (err) {
    logger.warn("server", `Skill export migration: ${err}`);
  }

  // 8a-ii. Rebuild SQLite index from SKILL.md files on disk.
  // Runs in background to avoid blocking startup on large skill directories.
  (async () => {
    try {
      const { rebuildSkillsIndexFromDisk } = await import("./skills/skill-disk-loader.js");
      const diskResult = await rebuildSkillsIndexFromDisk(config.skillsDir, skillsRepo);
      if (diskResult.loaded > 0 || diskResult.removed > 0) {
        logger.info("server", `Disk skill sync: ${diskResult.loaded} loaded, ${diskResult.removed} removed, ${diskResult.skipped} skipped`);
        skillIndex.refresh();
      }
    } catch (err) {
      logger.warn("server", `Disk skill rebuild: ${err}`);
    }
  })();

  // 8a-iii. Start file watcher for external SKILL.md edits
  const { SkillWatcher } = await import("./skills/skill-watcher.js");
  const skillWatcher = new SkillWatcher(config.skillsDir, skillsRepo, skillIndex);
  skillWatcher.start();

  // 8b. Create worker loop
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
    skillsRepo,
    skillStore,
    skillEffectivenessRepo,
    skillIndex,
    syncManager,
    config,
    hub,
    resourceLeaseManager,
    localLlmGate,
    maxConcurrent: config.maxConcurrentAgents,
    pollIntervalMs: config.workerPollMs,
  });

  // 9. Create Hono app
  const app = createApp({ db, jobsRepo, agentsRepo, apiKeysRepo, usersRepo, policiesRepo, auditRepo, projectsRepo, templatesRepo, workersRepo, usageRepo, depsRepo, syncManager, hub, headlessProgramsRepo, settingsRepo, skillsRepo, skillStore, skillEffectivenessRepo, skillIndex, jobInterventionsRepo, config, resourceLeaseManager, processTracker, dispatchJob: (id) => worker.dispatchById(id) });

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
    skillsRepo,
    skillStore,
    skillIndex,
    skillEffectivenessRepo,
  };

  // 10. Start server with Bun.serve (handles both HTTP and WebSocket)
  const tlsConfig = config.tlsCertPath && config.tlsKeyPath
    ? { cert: Bun.file(config.tlsCertPath), key: Bun.file(config.tlsKeyPath) }
    : undefined;

  const { server, actualPort } = await serveWithPortFallback((bindPort) => Bun.serve({
    port: bindPort,
    reusePort: true,
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

        const rawName = url.searchParams.get("name") ?? undefined;
        const program = url.searchParams.get("program") ?? undefined;
        // Sanitize bridge name: DCC apps often send internal node names
        // (e.g. Nuke sends "Root", others may send class names) instead of
        // actual project/file names. Treat these as "Untitled".
        const name = sanitizeBridgeName(rawName, program);
        const programVersion = url.searchParams.get("programVersion") ?? undefined;
        const bridgeVersion = url.searchParams.get("bridgeVersion") ?? undefined;
        const projectPath = url.searchParams.get("projectPath") ?? undefined;
        const osUser = url.searchParams.get("osUser") ?? undefined;
        const machineId = url.searchParams.get("machineId") ?? undefined;
        const workerModeParam = url.searchParams.get("workerMode");
        const workerMode = workerModeParam === "false" ? false : true;
        const localLlmEnabledParam = url.searchParams.get("localLlmEnabled");
        const clientLocalLlmEnabled = localLlmEnabledParam === "true";
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
            localLlmEnabled: clientLocalLlmEnabled,
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
              ensureCoordinatorScript(config.coordinatorScriptsDir, ws.data.program, undefined, skillsRepo);
              // Auto-pull skills for this bridge from the repo (once per program per session)
              const autoPull = settingsRepo.get("auto_pull_bridge_skills");
              const bridgeProgram = ws.data.program!;
              if (autoPull !== "false" && !skillsPulledThisSession.has(bridgeProgram)) {
                skillsPulledThisSession.add(bridgeProgram);
                pullBridgeSkills(bridgeProgram, skillsRepo, settingsRepo, false, skillStore)
                  .then((r) => {
                    if (r.pulled > 0) {
                      logger.info("skills", `Auto-pulled ${r.pulled} skills for ${bridgeProgram}`);
                      // Notify clients so admin/coordinator pages can refresh skill lists
                      hub.broadcastToType("client", {
                        type: "skills_updated",
                        id: "",
                        payload: { program: bridgeProgram, pulled: r.pulled, source: "auto-pull" },
                      });
                    }
                  })
                  .catch((err) => {
                    skillsPulledThisSession.delete(bridgeProgram); // retry on next connect
                    logger.warn("skills", `Auto-pull failed for ${bridgeProgram}: ${err}`);
                  });
              }
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

            // Sync client's localLlmEnabled setting to worker rules
            const existingRule = getWorkerRule(settingsRepo, ws.data.workerName);
            if (existingRule.localLlmEnabled !== ws.data.localLlmEnabled) {
              updateWorkerRule(settingsRepo, ws.data.workerName, { localLlmEnabled: !!ws.data.localLlmEnabled });
              logger.info("ws", `Worker "${ws.data.workerName}" localLlmEnabled=${ws.data.localLlmEnabled} (synced from client)`);
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
  }), config.port);

  // Update shared config if the server landed on a different port
  if (actualPort !== config.port) {
    const existingSharedConfig = readSharedConfig();
    const sharedKey = existingSharedConfig?.apiKey;
    if (sharedKey) writeSharedConfig(actualPort, sharedKey);
  }

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

  // 12.5. ComfyUI health checker: poll ComfyUI HTTP endpoint to register as virtual bridge
  const comfyUiHealth = new ComfyUiHealthChecker(hub, config);
  await comfyUiHealth.start();

  // 13. Coordinator training scheduler tick (every minute)
  const coordinatorTrainingInterval = setInterval(() => {
    try {
      const queued = runScheduledCoordinatorTrainingTick({
        jobsRepo,
        agentsRepo,
        settingsRepo,
        skillsRepo,
        skillStore,
        headlessProgramsRepo,
        hub,
        coordinatorScriptsDir: config.coordinatorScriptsDir,
        coordinatorPlaybooksDir: config.coordinatorPlaybooksDir,
        defaultCoordinatorPlaybookSourcePaths: config.coordinatorPlaybookSourcePaths,
        processTracker,
        housekeepingDeps: skillsRepo
          ? { jobsRepo, skillsRepo, skillStore, agentsRepo, settingsRepo, hub, skillEffectivenessRepo }
          : undefined,
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

  // 14. Housekeeping schedule tick (every 5 minutes)
  const housekeepingInterval = setInterval(() => {
    try {
      const result = runHousekeepingScheduleTick({
        jobsRepo,
        skillsRepo,
        skillStore,
        agentsRepo,
        settingsRepo,
        hub,
      });
      if (result) {
        logger.info("housekeeping", `Queued scheduled housekeeping job: ${result.jobId}`);
      }
    } catch (err: any) {
      logger.warn("housekeeping", `Housekeeping schedule tick failed: ${err?.message ?? err}`);
    }
  }, 5 * 60_000);

  // 15. Purge jobs in trash older than 30 days (run once on startup, then daily)
  const purgeTrash = () => {
    try {
      const purged = jobsRepo.purgeOldTrash(30);
      if (purged > 0) {
        logger.info("server", `Purged ${purged} jobs from trash (older than 30 days)`);
      }
    } catch (err: any) {
      logger.warn("server", `Trash purge failed: ${err?.message ?? err}`);
    }
  };
  purgeTrash(); // run once on startup
  const trashPurgeInterval = setInterval(purgeTrash, 24 * 60 * 60_000); // once per day

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

  // Auto-pull bridge skills on first run (deferred to avoid startup race conditions)
  const autoPullDisabled = settingsRepo.get("auto_pull_bridge_skills") === "false";
  if (shouldAutoPullSkills && !autoPullDisabled) {
    setTimeout(() => {
      logger.info("server", "No skills found — auto-pulling from bridge registry...");
      pullAllBridgeSkills(skillsRepo, settingsRepo, undefined, skillStore)
        .then((result) => {
          logger.info("server", `Auto-pull complete: ${result.total} skills pulled, ${result.errors.length} errors`);
        })
        .catch((err) => {
          logger.warn("server", `Auto-pull failed: ${err?.message ?? err}`);
        });
    }, 3000);
  }

  // 12. Graceful shutdown
  process.on(
    "SIGINT",
    () => shutdown(worker, processTracker, syncManager, sessionCleanupInterval, wsHeartbeatInterval, coordinatorTrainingInterval, housekeepingInterval, trashPurgeInterval, comfyUiHealth, db),
  );
  process.on(
    "SIGTERM",
    () => shutdown(worker, processTracker, syncManager, sessionCleanupInterval, wsHeartbeatInterval, coordinatorTrainingInterval, housekeepingInterval, trashPurgeInterval, comfyUiHealth, db),
  );
}

function shutdown(
  worker: WorkerLoop,
  processTracker: ProcessTracker,
  syncManager: SyncManager,
  sessionCleanupInterval: ReturnType<typeof setInterval>,
  wsHeartbeatInterval: ReturnType<typeof setInterval>,
  coordinatorTrainingInterval: ReturnType<typeof setInterval>,
  housekeepingInterval: ReturnType<typeof setInterval>,
  trashPurgeInterval: ReturnType<typeof setInterval>,
  comfyUiHealth: ComfyUiHealthChecker,
  db: ReturnType<typeof openDatabase>,
) {
  logger.info("server", "Shutting down...");
  worker.stop();
  processTracker.stop();
  syncManager.stop();
  comfyUiHealth.stop();
  clearInterval(sessionCleanupInterval);
  clearInterval(wsHeartbeatInterval);
  clearInterval(coordinatorTrainingInterval);
  clearInterval(housekeepingInterval);
  clearInterval(trashPurgeInterval);
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
