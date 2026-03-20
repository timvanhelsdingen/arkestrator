export type WorkspaceModeConfig = "auto" | "command" | "repo" | "sync";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  maxConcurrentAgents: number;
  workerPollMs: number;
  jobTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  syncTempDir: string;
  syncTtlMs: number;
  syncCleanupIntervalMs: number;
  syncMaxSizeMb: number;
  defaultWorkspaceMode: WorkspaceModeConfig;
  headlessTempDir: string;
  comfyuiUrl: string;
  seedExampleHeadlessPrograms: boolean;
  headlessExecutableHints: Record<string, string[]>;
  coordinatorScriptsDir: string;
  coordinatorPlaybooksDir: string;
  coordinatorImportsDir: string;
  snapshotsDir: string;
  coordinatorReferencePaths: string[];
  coordinatorPlaybookSourcePaths: string[];
  corsOrigins: string[];
  trustProxyHeaders: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

function parsePathList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/,|;|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseExecutableHints(raw?: string): Record<string, string[]> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [program, hints] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(hints)) continue;
      const cleaned = hints
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
      if (cleaned.length > 0) {
        out[String(program).trim().toLowerCase()] = cleaned;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const dataDir = process.env.DATA_DIR?.trim() || "./data";
  const explicitDbPath = process.env.DB_PATH?.trim();
  const defaultDbPath = `${dataDir}/db/arkestrator.db`;
  const dbPath = explicitDbPath || defaultDbPath;

  return {
    port: parseInt(process.env.PORT ?? "7800", 10),
    dataDir,
    dbPath,
    maxConcurrentAgents: parseInt(
      process.env.MAX_CONCURRENT_AGENTS ?? "8",
      10,
    ),
    workerPollMs: parseInt(process.env.WORKER_POLL_MS ?? "500", 10),
    jobTimeoutMs: parseInt(
      process.env.JOB_TIMEOUT_MS ?? String(30 * 60 * 1000),
      10,
    ),
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) ?? "info",
    syncTempDir: process.env.SYNC_TEMP_DIR ?? `${dataDir}/sync-tmp`,
    syncTtlMs: parseInt(
      process.env.SYNC_TTL_MS ?? String(30 * 60 * 1000),
      10,
    ),
    syncCleanupIntervalMs: parseInt(
      process.env.SYNC_CLEANUP_INTERVAL_MS ?? String(5 * 60 * 1000),
      10,
    ),
    syncMaxSizeMb: parseInt(process.env.SYNC_MAX_SIZE_MB ?? "500", 10),
    defaultWorkspaceMode:
      (process.env.DEFAULT_WORKSPACE_MODE as WorkspaceModeConfig) ?? "auto",
    headlessTempDir: process.env.HEADLESS_TEMP_DIR ?? `${dataDir}/headless-tmp`,
    comfyuiUrl: process.env.COMFYUI_URL ?? "http://127.0.0.1:8188",
    seedExampleHeadlessPrograms: parseBoolean(process.env.SEED_EXAMPLE_HEADLESS_PROGRAMS, false),
    headlessExecutableHints: parseExecutableHints(process.env.HEADLESS_EXECUTABLE_HINTS_JSON),
    coordinatorScriptsDir: process.env.COORDINATOR_SCRIPTS_DIR ?? `${dataDir}/coordinator-scripts`,
    coordinatorPlaybooksDir: process.env.COORDINATOR_PLAYBOOKS_DIR ?? `${dataDir}/coordinator-playbooks`,
    coordinatorImportsDir: process.env.COORDINATOR_IMPORTS_DIR ?? `${dataDir}/coordinator-imports`,
    snapshotsDir: process.env.SNAPSHOTS_DIR ?? `${dataDir}/snapshots`,
    coordinatorReferencePaths: parsePathList(process.env.COORDINATOR_REFERENCE_PATHS),
    coordinatorPlaybookSourcePaths: parsePathList(process.env.COORDINATOR_PLAYBOOK_SOURCE_PATHS),
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
      : [],
    trustProxyHeaders: parseBoolean(process.env.TRUST_PROXY_HEADERS, false),
    tlsCertPath: process.env.TLS_CERT_PATH || undefined,
    tlsKeyPath: process.env.TLS_KEY_PATH || undefined,
  };
}
