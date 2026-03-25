import { Hono } from "hono";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { basename, dirname, join, relative, isAbsolute } from "path";
import type { Database } from "bun:sqlite";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { JobSubmit } from "@arkestrator/protocol";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { UsersRepo, User } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { requireAdmin, requirePermission, getClientIp, getAuthenticatedUser } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import { newId } from "../utils/id.js";
import {
  filterCoordinatorSourcePathsByProgram,
  inferCoordinatorSourceProgramsFromPath,
  parseCoordinatorReferencePaths,
  parseCoordinatorSourcePrograms,
  serializeCoordinatorSourcePrograms,
  serializeCoordinatorReferencePaths,
} from "../agents/coordinator-playbooks.js";
import {
  DEFAULT_ORCHESTRATOR_PROMPT,
  getCoordinatorScriptDefault,
  getCoordinatorScriptPrograms,
  getDefaultProjectDir,
  removeCoordinatorScript,
  type ProgramDiscoveryDeps,
} from "../agents/engines.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { Config } from "../config.js";
import {
  computeCoordinatorTrainingNextRunByProgram,
  generateCoordinatorTraining,
  getCoordinatorTrainingLastRunByProgram,
  getCoordinatorTrainingSchedule,
  fanOutTrainingByProgram,
  queueTrainingOrchestrator,
  queueCoordinatorTrainingJob,
  setCoordinatorTrainingLastRunByProgram,
  setCoordinatorTrainingSchedule,
} from "../agents/coordinator-training.js";
import {
  getHousekeepingSchedule,
  setHousekeepingSchedule,
  queueHousekeepingJob,
  type HousekeepingDeps,
} from "../agents/housekeeping.js";
import {
  getNetworkControls,
  normalizeNetworkControlsInput,
  saveNetworkControls,
} from "../security/network-policy.js";
import { evaluateWorkerAccess, getWorkerRule } from "../security/worker-rules.js";
import {
  DEFAULT_TRAINING_REPOSITORY_POLICY,
  flushTrainingRepositoryIndexRefresh,
  getTrainingRepositoryMetrics,
  getTrainingRepositoryRefreshStatus,
  listTrainingRepositoryRecords,
  overridesToJson,
  parseTrainingRepositoryOverrides,
  parseTrainingRepositoryPolicy,
  policyToJson,
  resolveTrainingRepositoryIndexPath,
  scheduleTrainingRepositoryIndexRefresh,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
  type TrainingRepositoryOverrideMode,
  type TrainingRepositoryPolicyPatch,
} from "../agents/training-repository.js";
import {
  getConfiguredOllamaBaseUrl,
  SERVER_LOCAL_LLM_BASE_URL_SETTINGS_KEY,
} from "../local-models/ollama.js";
import type { SettingsRouteDeps } from "./settings-shared.js";

export function createSettingsTrainingRoutes(deps: SettingsRouteDeps) {
  const {
    settingsRepo, usersRepo, auditRepo, jobsRepo, agentsRepo,
    headlessProgramsRepo, hub, coordinatorScriptsDir, coordinatorPlaybooksDir,
    coordinatorImportsDir, snapshotsDir, defaultCoordinatorReferencePaths,
    defaultCoordinatorPlaybookSourcePaths, db, workersRepo, skillsRepo, config,
    programDiscoveryDeps, processTracker,
  } = deps;

  const router = new Hono();

  const MAX_PLAYBOOK_FILE_READ_BYTES = 512_000;
  const MAX_COORDINATOR_FILE_READ_BYTES = 2_000_000;
  const MAX_TRAINING_UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
  const MAX_TRAINING_UPLOAD_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_TRAINING_UPLOAD_EXTRACTED_BYTES = 512 * 1024 * 1024;
  const MAX_TRAINING_UPLOAD_EXTRACTED_ENTRIES = 25_000;


  function normalizeServerLocalLlmBaseUrl(value: unknown): string | null {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  function getServerLocalLlmConfig() {
    const storedRaw = String(settingsRepo.get(SERVER_LOCAL_LLM_BASE_URL_SETTINGS_KEY) ?? "").trim();
    const storedNormalized = normalizeServerLocalLlmBaseUrl(storedRaw);
    const envRaw = String(process.env.OLLAMA_BASE_URL ?? "").trim();
    const envNormalized = normalizeServerLocalLlmBaseUrl(envRaw);
    const effectiveBaseUrl = getConfiguredOllamaBaseUrl(settingsRepo);
    const source = storedNormalized ? "setting" : (envNormalized ? "env" : "default");
    return {
      baseUrl: storedNormalized,
      effectiveBaseUrl,
      source,
      defaultBaseUrl: "http://127.0.0.1:11434",
    } as const;
  }

  type CoordinatorFileRootKey = "scripts" | "playbooks" | "learning" | "imports";
  type CoordinatorFileRoot = {
    key: CoordinatorFileRootKey;
    label: string;
    baseDir: string;
  };

  type TrainingVaultMetadataActor = {
    id: string | null;
    username: string | null;
    ipAddress: string | null;
    workerName: string | null;
  };

  type TrainingVaultMetadata = {
    path: string;
    kind: "file" | "directory";
    createdAt: string;
    updatedAt: string;
    createdBy: TrainingVaultMetadataActor;
    updatedBy: TrainingVaultMetadataActor;
    projectPaths: string[];
    sourcePaths: string[];
    remarks: string | null;
  };

  type TrainingJobSignal = "positive" | "average" | "negative" | "unknown";
  type TrainingJobTransport = "mcp" | "cli_rest" | "mixed" | "unknown";

  type TrainingJobSummary = {
    jobId: string;
    name: string;
    program: string;
    signal: TrainingJobSignal;
    prompt: string;
    outcome: string;
    model: string | null;
    agentEngine: string | null;
    agentConfigId: string | null;
    actualAgentConfigId: string | null;
    workspaceMode: string | null;
    coordinationMode: string | null;
    transport: TrainingJobTransport;
    workerName: string | null;
    targetWorkerName: string | null;
    bridgeProgram: string | null;
    bridgeId: string | null;
    usedBridges: string[];
    submittedByUserId: string | null;
    submittedByUsername: string | null;
    outcomeMarkedByUserId: string | null;
    outcomeMarkedByUsername: string | null;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    storedAt: string | null;
    artifactCount: number;
    artifactPaths: string[];
  };

  type TrainingJobQueryFilters = {
    programs: string[];
    jobId: string | null;
    q: string | null;
    signal: TrainingJobSignal | null;
    transport: TrainingJobTransport | null;
    dateFrom: string | null;
    dateTo: string | null;
    limit: number;
  };

  type TrainingDataExportScope = "all" | "filtered" | "program" | "job" | "selected";

  function resolveCoordinatorScriptPath(program: string): string | null {
    // Only allow simple filename-safe program keys (no path separators/traversal).
    if (!/^[a-zA-Z0-9._-]+$/.test(program)) return null;
    const fullPath = join(coordinatorScriptsDir, `${program}.md`);
    const rel = relative(coordinatorScriptsDir, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return fullPath;
  }

  function resolveCoordinatorPlaybookProgramDir(program: string): string | null {
    if (!/^[a-zA-Z0-9._-]+$/.test(program)) return null;
    const fullPath = join(coordinatorPlaybooksDir, program);
    const rel = relative(coordinatorPlaybooksDir, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return fullPath;
  }

  function resolveCoordinatorImportProgramDir(program: string): string | null {
    if (!/^[a-zA-Z0-9._-]+$/.test(program)) return null;
    const fullPath = join(coordinatorImportsDir, program);
    const rel = relative(coordinatorImportsDir, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return fullPath;
  }

  function resolvePathWithin(baseDir: string, relPath: string): string | null {
    if (!relPath || typeof relPath !== "string") return null;
    const fullPath = join(baseDir, relPath);
    const rel = relative(baseDir, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return fullPath;
  }

  function normalizeRelativePath(value: string): string {
    return String(value ?? "").trim().replace(/\\/g, "/");
  }

  function isRootPath(pathValue: string): boolean {
    const normalized = normalizeRelativePath(pathValue).replace(/\/+$/g, "");
    return !normalized || normalized === ".";
  }

  function getCoordinatorFileRoots(): CoordinatorFileRoot[] {
    return [
      {
        key: "scripts",
        label: "Coordinator Scripts",
        baseDir: coordinatorScriptsDir,
      },
      {
        key: "playbooks",
        label: "Coordinator Playbooks",
        baseDir: coordinatorPlaybooksDir,
      },
      {
        key: "learning",
        label: "Coordinator Learning",
        baseDir: join(coordinatorPlaybooksDir, "_learning"),
      },
      {
        key: "imports",
        label: "Imported References",
        baseDir: coordinatorImportsDir,
      },
    ];
  }

  function getCoordinatorFileRoot(rootKeyRaw: string): CoordinatorFileRoot | null {
    const rootKey = String(rootKeyRaw ?? "").trim().toLowerCase();
    if (!rootKey) return null;
    return getCoordinatorFileRoots().find((root) => root.key === rootKey) ?? null;
  }

  const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;
  const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
  const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const SNAPSHOT_MAX_FILES = 20_000;

  const CONFIG_SNAPSHOT_TABLES = [
    "agent_configs",
    "jobs",
    "api_keys",
    "users",
    "sessions",
    "policies",
    "audit_log",
    "usage_stats",
    "projects",
    "job_dependencies",
    "workers",
    "worker_bridges",
    "server_settings",
    "headless_programs",
  ] as const;
  type ConfigSnapshotTableName = (typeof CONFIG_SNAPSHOT_TABLES)[number];

  type SnapshotEncodedFile = {
    path: string;
    bytes: number;
    updatedAt: string;
    encoding: "utf8" | "base64";
    content: string;
  };

  type SnapshotSkippedFile = {
    path: string;
    reason: string;
  };

  type SnapshotTrainingFile = SnapshotEncodedFile & {
    root: CoordinatorFileRootKey;
    relPath: string;
  };

  type SnapshotTrainingMetadata = TrainingVaultMetadata;

  type SnapshotServerFile = SnapshotEncodedFile;

  type ConfigSnapshot = {
    format: "arkestrator-config-snapshot";
    schemaVersion: number;
    generatedAt: string;
    generatedBy: {
      id: string;
      username: string;
    };
    includes: {
      training: true;
      serverFiles: boolean;
    };
    tables: Record<ConfigSnapshotTableName, Record<string, unknown>[]>;
    training: {
      files: SnapshotTrainingFile[];
      skipped: SnapshotSkippedFile[];
      metadata: SnapshotTrainingMetadata[];
    };
    serverFiles: {
      files: SnapshotServerFile[];
      roots: string[];
      skipped: SnapshotSkippedFile[];
    };
  };

  function parseExportImportBoolean(value: unknown): boolean {
    if (value === true || value === false) return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
      if (lowered === "false" || lowered === "0" || lowered === "no") return false;
    }
    if (typeof value === "number") return value !== 0;
    return false;
  }

  function encodeSnapshotFileContent(
    bytes: Uint8Array,
  ): { encoding: "utf8" | "base64"; content: string } {
    const text = Buffer.from(bytes).toString("utf8");
    if (text.includes("\u0000") || text.includes("\ufffd")) {
      return {
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
      };
    }
    return { encoding: "utf8", content: text };
  }

  function decodeSnapshotFileContent(entry: {
    path: string;
    encoding: unknown;
    content: unknown;
  }): Uint8Array {
    const encoding = String(entry.encoding ?? "").trim().toLowerCase();
    const content = String(entry.content ?? "");
    if (encoding === "utf8") return Buffer.from(content, "utf8");
    if (encoding === "base64") {
      try {
        return Buffer.from(content, "base64");
      } catch {
        throw new Error(`Invalid base64 content for ${entry.path}`);
      }
    }
    throw new Error(`Unsupported file encoding for ${entry.path}: ${encoding || "(empty)"}`);
  }

  function shouldSkipSnapshotPath(name: string): boolean {
    return name === ".git" || name === "node_modules" || name === "__pycache__";
  }

  function collectSnapshotFilesFromPath(
    rootPath: string,
    pathPrefix = "",
    maxFiles = SNAPSHOT_MAX_FILES,
    maxTotalBytes = SNAPSHOT_MAX_TOTAL_BYTES,
    maxFileBytes = SNAPSHOT_MAX_FILE_BYTES,
  ): {
    files: SnapshotEncodedFile[];
    skipped: SnapshotSkippedFile[];
    totalBytes: number;
  } {
    const files: SnapshotEncodedFile[] = [];
    const skipped: SnapshotSkippedFile[] = [];
    let totalBytes = 0;
    const stack: Array<{ absPath: string; relPath: string }> = [{ absPath: rootPath, relPath: pathPrefix }];

    while (stack.length > 0 && files.length < maxFiles) {
      const item = stack.pop() as { absPath: string; relPath: string };

      let st;
      try {
        st = statSync(item.absPath);
      } catch {
        skipped.push({ path: item.relPath || item.absPath, reason: "stat_failed" });
        continue;
      }

      if (st.isDirectory()) {
        let names: string[] = [];
        try {
          names = readdirSync(item.absPath).sort();
        } catch {
          skipped.push({ path: item.relPath || item.absPath, reason: "read_dir_failed" });
          continue;
        }
        for (let i = names.length - 1; i >= 0; i--) {
          const name = names[i];
          if (shouldSkipSnapshotPath(name)) continue;
          const childAbs = join(item.absPath, name);
          const childRel = item.relPath ? `${item.relPath}/${name}` : name;
          stack.push({ absPath: childAbs, relPath: childRel.replace(/\\/g, "/") });
        }
        continue;
      }

      if (!st.isFile()) continue;
      if (st.size > maxFileBytes) {
        skipped.push({ path: item.relPath || item.absPath, reason: "file_too_large" });
        continue;
      }
      if (totalBytes + st.size > maxTotalBytes) {
        skipped.push({ path: item.relPath || item.absPath, reason: "total_size_limit" });
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = readFileSync(item.absPath);
      } catch {
        skipped.push({ path: item.relPath || item.absPath, reason: "read_file_failed" });
        continue;
      }
      const encoded = encodeSnapshotFileContent(bytes);
      files.push({
        path: item.relPath || item.absPath,
        bytes: st.size,
        updatedAt: new Date(st.mtimeMs || Date.now()).toISOString(),
        encoding: encoded.encoding,
        content: encoded.content,
      });
      totalBytes += st.size;
    }

    return { files, skipped, totalBytes };
  }

  function getSnapshotTableRows(table: ConfigSnapshotTableName): Record<string, unknown>[] {
    if (!db) return [];
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    return rows.map((row) => ({ ...row }));
  }

  function getSnapshotTableColumns(table: ConfigSnapshotTableName): string[] {
    if (!db) return [];
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows
      .map((row) => String(row?.name ?? "").trim())
      .filter(Boolean);
  }

  function collectServerFileRootsForSnapshot(): string[] {
    const out = new Set<string>();

    const refs = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_reference_paths"));
    const sources = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_playbook_sources"));
    for (const entry of [...refs, ...sources]) {
      const path = String(entry ?? "").trim();
      if (!path) continue;
      out.add(path);
    }

    if (db) {
      const projectRows = db.query(
        "SELECT source_path AS sourcePath, source_type AS sourceType FROM projects WHERE source_type = 'local'",
      ).all() as Array<{ sourcePath?: unknown; sourceType?: unknown }>;
      for (const row of projectRows) {
        if (String(row?.sourceType ?? "") !== "local") continue;
        const path = String(row?.sourcePath ?? "").trim();
        if (path) out.add(path);
      }
    }

    return [...out].sort();
  }

  function normalizeSnapshotRows(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((row) => row && typeof row === "object" && !Array.isArray(row))
      .map((row) => ({ ...(row as Record<string, unknown>) }));
  }

  function replaceSnapshotTableRows(
    table: ConfigSnapshotTableName,
    rows: Record<string, unknown>[],
  ) {
    if (!db) throw new Error("Database unavailable");
    const allowedColumns = getSnapshotTableColumns(table);
    const allowedSet = new Set(allowedColumns);

    db.exec(`DELETE FROM ${table}`);
    for (const row of rows) {
      const keys = Object.keys(row).filter((key) => allowedSet.has(key));
      if (keys.length === 0) continue;
      const placeholders = keys.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
      const values = keys.map((key) => {
        const value = row[key];
        return value === undefined ? null : value;
      });
      db.prepare(sql).run(...(values as any[]));
    }
  }

  function buildConfigSnapshotPayload(
    user: User,
    includeServerFiles: boolean,
  ): {
    suggestedFileName: string;
    snapshot: ConfigSnapshot;
    summary: {
      tables: Record<string, number>;
      trainingFileCount: number;
      trainingSkippedCount: number;
      trainingMetadataCount: number;
      serverFileCount: number;
      serverSkippedCount: number;
    };
  } {
    const tables = {} as Record<ConfigSnapshotTableName, Record<string, unknown>[]>;
    for (const table of CONFIG_SNAPSHOT_TABLES) {
      tables[table] = getSnapshotTableRows(table);
    }

    const trainingFiles: SnapshotTrainingFile[] = [];
    const trainingSkipped: SnapshotSkippedFile[] = [];
    for (const root of getCoordinatorFileRoots()) {
      if (!existsSync(root.baseDir)) continue;
      const collected = collectSnapshotFilesFromPath(root.baseDir);
      for (const file of collected.files) {
        const relPath = normalizeRelativePath(file.path).replace(/^\/+|\/+$/g, "");
        if (!relPath) continue;
        trainingFiles.push({
          ...file,
          root: root.key,
          relPath,
          path: `${root.key}/${relPath}`,
        });
      }
      for (const skipped of collected.skipped) {
        const relPath = normalizeRelativePath(skipped.path).replace(/^\/+|\/+$/g, "");
        trainingSkipped.push({
          path: relPath ? `${root.key}/${relPath}` : `${root.key}/`,
          reason: skipped.reason,
        });
      }
    }
    trainingFiles.sort((a, b) => a.path.localeCompare(b.path));
    const trainingMetadata = Object.values(getTrainingVaultMetadataMap()).sort((a, b) => a.path.localeCompare(b.path));

    const serverFileRoots = includeServerFiles ? collectServerFileRootsForSnapshot() : [];
    const serverFiles: SnapshotServerFile[] = [];
    const serverSkipped: SnapshotSkippedFile[] = [];
    const seenServerPaths = new Set<string>();

    if (includeServerFiles) {
      for (const configuredRoot of serverFileRoots) {
        const absoluteRoot = isAbsolute(configuredRoot)
          ? configuredRoot
          : join(process.cwd(), configuredRoot);

        if (!existsSync(absoluteRoot)) {
          serverSkipped.push({ path: absoluteRoot, reason: "root_missing" });
          continue;
        }

        let st;
        try {
          st = statSync(absoluteRoot);
        } catch {
          serverSkipped.push({ path: absoluteRoot, reason: "stat_failed" });
          continue;
        }

        if (st.isDirectory()) {
          const collected = collectSnapshotFilesFromPath(absoluteRoot);
          for (const file of collected.files) {
            const relPath = normalizeRelativePath(file.path).replace(/^\/+|\/+$/g, "");
            if (!relPath) continue;
            const absolutePath = join(absoluteRoot, relPath).replace(/\\/g, "/");
            if (seenServerPaths.has(absolutePath)) continue;
            seenServerPaths.add(absolutePath);
            serverFiles.push({ ...file, path: absolutePath });
          }
          for (const skipped of collected.skipped) {
            const relPath = normalizeRelativePath(skipped.path).replace(/^\/+|\/+$/g, "");
            const absolutePath = relPath
              ? join(absoluteRoot, relPath).replace(/\\/g, "/")
              : absoluteRoot;
            serverSkipped.push({ path: absolutePath, reason: skipped.reason });
          }
        } else if (st.isFile()) {
          const collected = collectSnapshotFilesFromPath(absoluteRoot, absoluteRoot.replace(/\\/g, "/"));
          for (const file of collected.files) {
            const absolutePath = normalizeRelativePath(file.path);
            if (!absolutePath || seenServerPaths.has(absolutePath)) continue;
            seenServerPaths.add(absolutePath);
            serverFiles.push({ ...file, path: absolutePath });
          }
          for (const skipped of collected.skipped) {
            serverSkipped.push({ path: normalizeRelativePath(skipped.path), reason: skipped.reason });
          }
        }
      }
    }
    serverFiles.sort((a, b) => a.path.localeCompare(b.path));

    const snapshot: ConfigSnapshot = {
      format: "arkestrator-config-snapshot",
      schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: {
        id: user.id,
        username: user.username,
      },
      includes: {
        training: true,
        serverFiles: includeServerFiles,
      },
      tables,
      training: {
        files: trainingFiles,
        skipped: trainingSkipped,
        metadata: trainingMetadata,
      },
      serverFiles: {
        files: serverFiles,
        roots: serverFileRoots,
        skipped: serverSkipped,
      },
    };
    const stamp = snapshot.generatedAt.replace(/[:.]/g, "-");
    const suggestedFileName = `arkestrator-config-snapshot-${stamp}.json`;
    return {
      suggestedFileName,
      snapshot,
      summary: {
        tables: Object.fromEntries(
          CONFIG_SNAPSHOT_TABLES.map((table) => [table, tables[table]?.length ?? 0]),
        ),
        trainingFileCount: trainingFiles.length,
        trainingSkippedCount: trainingSkipped.length,
        trainingMetadataCount: trainingMetadata.length,
        serverFileCount: serverFiles.length,
        serverSkippedCount: serverSkipped.length,
      },
    };
  }

  function importConfigSnapshotPayload(
    snapshotRaw: unknown,
    includeServerFiles: boolean,
  ): {
    summary: {
      importedTableCounts: Record<string, number>;
      trainingWriteCount: number;
      trainingWriteErrors: Array<{ path: string; reason: string }>;
      serverWriteCount: number;
      serverWriteErrors: Array<{ path: string; reason: string }>;
    };
  } {
    if (!db) throw new Error("Snapshot import unavailable: database handle missing");
    if (!snapshotRaw || typeof snapshotRaw !== "object" || Array.isArray(snapshotRaw)) {
      throw new Error("snapshot object is required");
    }
    if (String((snapshotRaw as any).format ?? "") !== "arkestrator-config-snapshot") {
      throw new Error("Unsupported snapshot format");
    }

    const tablesRaw = (snapshotRaw as any).tables;
    if (!tablesRaw || typeof tablesRaw !== "object" || Array.isArray(tablesRaw)) {
      throw new Error("snapshot.tables object is required");
    }

    const tableRows = {} as Record<ConfigSnapshotTableName, Record<string, unknown>[]>;
    for (const table of CONFIG_SNAPSHOT_TABLES) {
      if (!(table in tablesRaw)) {
        throw new Error(`snapshot.tables.${table} is required`);
      }
      tableRows[table] = normalizeSnapshotRows((tablesRaw as Record<string, unknown>)[table]);
    }

    const usersRows = tableRows.users ?? [];
    const hasAdminUser = usersRows.some((row) => String(row.role ?? "").trim() === "admin");
    if (!hasAdminUser) {
      throw new Error("snapshot.users must include at least one admin");
    }

    const trainingRaw = Array.isArray((snapshotRaw as any)?.training?.files)
      ? (snapshotRaw as any).training.files
      : [];
    const trainingFiles: SnapshotTrainingFile[] = [];
    for (const item of trainingRaw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const root = String((item as any).root ?? "").trim().toLowerCase() as CoordinatorFileRootKey;
      if (!getCoordinatorFileRoot(root)) continue;
      const relPathRaw = String((item as any).relPath ?? (item as any).path ?? "").trim();
      const relPathNormalized = normalizeRelativePath(relPathRaw).replace(/^\/+|\/+$/g, "");
      if (!relPathNormalized) continue;
      const relPath = relPathNormalized.startsWith(`${root}/`)
        ? relPathNormalized.slice(root.length + 1)
        : relPathNormalized;
      if (!relPath) continue;
      trainingFiles.push({
        root,
        relPath,
        path: `${root}/${relPath}`,
        bytes: Number((item as any).bytes ?? 0) || 0,
        updatedAt: String((item as any).updatedAt ?? ""),
        encoding: String((item as any).encoding ?? "utf8").toLowerCase() === "base64" ? "base64" : "utf8",
        content: String((item as any).content ?? ""),
      });
    }

    const trainingMetadataRaw = Array.isArray((snapshotRaw as any)?.training?.metadata)
      ? (snapshotRaw as any).training.metadata
      : [];
    const trainingMetadataFromSnapshot: Record<string, TrainingVaultMetadata> = {};
    for (const item of trainingMetadataRaw) {
      const metadata = normalizeTrainingVaultMetadataRecord(item);
      if (!metadata) continue;
      trainingMetadataFromSnapshot[metadata.path] = metadata;
    }

    const serverRaw = Array.isArray((snapshotRaw as any)?.serverFiles?.files)
      ? (snapshotRaw as any).serverFiles.files
      : [];
    const serverFiles: SnapshotServerFile[] = [];
    if (includeServerFiles) {
      for (const item of serverRaw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const path = String((item as any).path ?? "").trim();
        if (!path || !isAbsolute(path)) continue;
        serverFiles.push({
          path,
          bytes: Number((item as any).bytes ?? 0) || 0,
          updatedAt: String((item as any).updatedAt ?? ""),
          encoding: String((item as any).encoding ?? "utf8").toLowerCase() === "base64" ? "base64" : "utf8",
          content: String((item as any).content ?? ""),
        });
      }
    }

    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      for (const table of CONFIG_SNAPSHOT_TABLES) {
        replaceSnapshotTableRows(table, tableRows[table] ?? []);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      db.exec("PRAGMA foreign_keys = ON");
      throw new Error(`Failed to import database snapshot: ${err}`);
    } finally {
      try {
        db.exec("PRAGMA foreign_keys = ON");
      } catch {
        // ignore
      }
    }

    const trainingWriteErrors: SnapshotSkippedFile[] = [];
    const trainingWrittenPaths = new Set<string>();
    let trainingWriteCount = 0;

    rmSync(coordinatorScriptsDir, { recursive: true, force: true });
    rmSync(coordinatorPlaybooksDir, { recursive: true, force: true });
    rmSync(coordinatorImportsDir, { recursive: true, force: true });

    for (const entry of trainingFiles) {
      const root = getCoordinatorFileRoot(entry.root);
      if (!root) {
        trainingWriteErrors.push({ path: entry.path, reason: "invalid_root" });
        continue;
      }
      const fullPath = resolvePathWithin(root.baseDir, entry.relPath);
      if (!fullPath) {
        trainingWriteErrors.push({ path: entry.path, reason: "invalid_path" });
        continue;
      }
      const canonicalPath = fullPath.replace(/\\/g, "/");
      if (trainingWrittenPaths.has(canonicalPath)) continue;
      trainingWrittenPaths.add(canonicalPath);

      try {
        const bytes = decodeSnapshotFileContent(entry);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, bytes);
        trainingWriteCount += 1;
      } catch {
        trainingWriteErrors.push({ path: entry.path, reason: "write_failed" });
      }
    }

    const restoredTrainingMetadata: Record<string, TrainingVaultMetadata> = {};
    for (const [path, metadata] of Object.entries(trainingMetadataFromSnapshot)) {
      const resolved = resolveTrainingVaultPath(path);
      if (!resolved) continue;
      if (!existsSync(resolved.fullPath)) continue;
      let st;
      try {
        st = statSync(resolved.fullPath);
      } catch {
        continue;
      }
      const kind: "file" | "directory" = st.isDirectory() ? "directory" : "file";
      if (!st.isDirectory() && !st.isFile()) continue;
      restoredTrainingMetadata[path] = {
        ...metadata,
        kind,
      };
    }
    setTrainingVaultMetadataMap(restoredTrainingMetadata);

    const serverWriteErrors: SnapshotSkippedFile[] = [];
    let serverWriteCount = 0;
    if (includeServerFiles) {
      for (const entry of serverFiles) {
        const path = String(entry.path ?? "").trim();
        if (!path || !isAbsolute(path)) {
          serverWriteErrors.push({ path: path || "(empty)", reason: "invalid_path" });
          continue;
        }
        try {
          const bytes = decodeSnapshotFileContent(entry);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, bytes);
          serverWriteCount += 1;
        } catch {
          serverWriteErrors.push({ path, reason: "write_failed" });
        }
      }
    }

    return {
      summary: {
        importedTableCounts: Object.fromEntries(
          CONFIG_SNAPSHOT_TABLES.map((table) => [table, tableRows[table]?.length ?? 0]),
        ),
        trainingWriteCount,
        trainingWriteErrors,
        serverWriteCount,
        serverWriteErrors,
      },
    };
  }

  function listCoordinatorEntriesRecursive(
    rootDir: string,
    maxEntries = 6000,
  ): Array<{ path: string; kind: "file" | "directory"; bytes: number; updatedAt: string }> {
    const out: Array<{ path: string; kind: "file" | "directory"; bytes: number; updatedAt: string }> = [];
    const stack: string[] = [""];

    while (stack.length > 0 && out.length < maxEntries) {
      const relDir = stack.pop() as string;
      const absDir = relDir ? join(rootDir, relDir) : rootDir;

      let entries: string[] = [];
      try {
        entries = readdirSync(absDir);
      } catch {
        continue;
      }

      entries.sort();
      for (const name of entries) {
        if (out.length >= maxEntries) break;
        // Skip dotfiles/directories (e.g. .blender.hash sidecar files)
        if (name.startsWith(".")) continue;

        const relPathNative = relDir ? join(relDir, name) : name;
        const relPath = relPathNative.replace(/\\/g, "/");
        const absPath = join(absDir, name);
        let st;
        try {
          st = statSync(absPath);
        } catch {
          continue;
        }

        const updatedAt = new Date(st.mtimeMs || Date.now()).toISOString();
        if (st.isDirectory()) {
          out.push({ path: relPath, kind: "directory", bytes: 0, updatedAt });
          stack.push(relPathNative);
        } else if (st.isFile()) {
          out.push({ path: relPath, kind: "file", bytes: st.size, updatedAt });
        }
      }
    }

    out.sort((a, b) => {
      if (a.path === b.path) {
        if (a.kind === b.kind) return 0;
        return a.kind === "directory" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });
    return out;
  }

  function resolveTrainingVaultPath(
    vaultPathRaw: string,
  ): { root: CoordinatorFileRoot; relPath: string; fullPath: string } | null {
    const normalized = normalizeRelativePath(vaultPathRaw).replace(/^\/+|\/+$/g, "");
    if (!normalized) return null;

    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const root = getCoordinatorFileRoot(parts[0]);
    if (!root) return null;

    const relPath = parts.slice(1).join("/");
    if (!relPath) {
      return { root, relPath: "", fullPath: root.baseDir };
    }
    const fullPath = resolvePathWithin(root.baseDir, relPath);
    if (!fullPath) return null;
    return { root, relPath, fullPath };
  }

  function inferTrainingVaultProgram(
    rootKey: CoordinatorFileRootKey,
    relPath: string,
  ): string | null {
    const normalized = normalizeRelativePath(relPath).replace(/^\/+|\/+$/g, "");
    if (!normalized) return null;

    if (rootKey === "scripts") {
      const file = basename(normalized);
      // Skip dotfiles (hash sidecars) and non-.md files
      if (file.startsWith(".")) return null;
      const name = file.replace(/\.md$/i, "").trim().toLowerCase();
      return /^[a-z0-9_-]+$/.test(name) ? name : null;
    }

    if (rootKey === "playbooks") {
      const first = normalized.split("/")[0]?.trim().toLowerCase() ?? "";
      if (!first || first === "_learning") return null;
      return /^[a-z0-9._-]+$/.test(first) ? first : null;
    }

    if (rootKey === "learning") {
      const segments = normalized.split("/").filter(Boolean);
      if (segments.length >= 2 && segments[0].toLowerCase() === "jobs") {
        const programDir = segments[1]?.trim().toLowerCase() ?? "";
        if (/^[a-z0-9._-]+$/.test(programDir)) return programDir;
      }
      const name = basename(normalized).trim().toLowerCase();
      const match = /^([a-z0-9._-]+)(?:\.experiences)?\.json$/i.exec(name);
      if (!match) return null;
      return match[1];
    }

    if (rootKey === "imports") {
      const first = normalized.split("/")[0]?.trim().toLowerCase() ?? "";
      return /^[a-z0-9._-]+$/.test(first) ? first : null;
    }

    return null;
  }

  function normalizeTrainingVaultMetadataPath(pathValue: string): string {
    const normalized = normalizeRelativePath(pathValue).replace(/^\/+|\/+$/g, "");
    if (!normalized) return "";
    const resolved = resolveTrainingVaultPath(normalized);
    if (!resolved) return "";
    return resolved.relPath
      ? `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/")
      : resolved.root.key;
  }

  function normalizeTrainingVaultMetadataActor(raw: unknown): TrainingVaultMetadataActor {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { id: null, username: null, ipAddress: null, workerName: null };
    }
    const actor = raw as Record<string, unknown>;
    const id = String(actor.id ?? "").trim() || null;
    const username = String(actor.username ?? "").trim() || null;
    const ipAddress = String(actor.ipAddress ?? "").trim() || null;
    const workerName = String(actor.workerName ?? "").trim() || null;
    return { id, username, ipAddress, workerName };
  }

  function normalizeTrainingVaultMetadataPaths(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out = new Set<string>();
    for (const item of raw) {
      const value = String(item ?? "").trim();
      if (!value) continue;
      out.add(value);
      if (out.size >= 300) break;
    }
    return [...out];
  }

  function normalizeTrainingVaultMetadataRemarks(raw: unknown): string | null {
    if (raw == null) return null;
    const value = String(raw).trim();
    if (!value) return null;
    return value.slice(0, 4_000);
  }

  function normalizeTrainingVaultMetadataRecord(raw: unknown): TrainingVaultMetadata | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const normalizedPath = normalizeTrainingVaultMetadataPath(String(item.path ?? ""));
    if (!normalizedPath) return null;

    const kindRaw = String(item.kind ?? "").trim().toLowerCase();
    const kind: "file" | "directory" = kindRaw === "directory" ? "directory" : "file";
    const createdAt = String(item.createdAt ?? "").trim() || new Date().toISOString();
    const updatedAt = String(item.updatedAt ?? "").trim() || createdAt;

    return {
      path: normalizedPath,
      kind,
      createdAt,
      updatedAt,
      createdBy: normalizeTrainingVaultMetadataActor(item.createdBy),
      updatedBy: normalizeTrainingVaultMetadataActor(item.updatedBy),
      projectPaths: normalizeTrainingVaultMetadataPaths(item.projectPaths),
      sourcePaths: normalizeTrainingVaultMetadataPaths(item.sourcePaths),
      remarks: normalizeTrainingVaultMetadataRemarks(item.remarks),
    };
  }

  function parseTrainingVaultMetadataMap(raw: string | null | undefined): Record<string, TrainingVaultMetadata> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      const out: Record<string, TrainingVaultMetadata> = {};
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const normalized = normalizeTrainingVaultMetadataRecord(value);
          if (!normalized) continue;
          out[normalized.path] = normalized;
        }
        return out;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalized = normalizeTrainingVaultMetadataRecord({
          ...(value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {}),
          path: String((value as any)?.path ?? key),
        });
        if (!normalized) continue;
        out[normalized.path] = normalized;
      }
      return out;
    } catch {
      return {};
    }
  }

  function serializeTrainingVaultMetadataMap(map: Record<string, TrainingVaultMetadata>): string {
    const out: Record<string, TrainingVaultMetadata> = {};
    for (const [path, raw] of Object.entries(map)) {
      const normalizedPath = normalizeTrainingVaultMetadataPath(path);
      if (!normalizedPath) continue;
      const normalized = normalizeTrainingVaultMetadataRecord({
        ...raw,
        path: normalizedPath,
      });
      if (!normalized) continue;
      out[normalizedPath] = normalized;
    }
    return JSON.stringify(out);
  }

  function getTrainingVaultMetadataMap(): Record<string, TrainingVaultMetadata> {
    return parseTrainingVaultMetadataMap(settingsRepo.get(TRAINING_VAULT_METADATA_SETTING));
  }

  function setTrainingVaultMetadataMap(map: Record<string, TrainingVaultMetadata>) {
    settingsRepo.set(TRAINING_VAULT_METADATA_SETTING, serializeTrainingVaultMetadataMap(map));
  }

  function upsertTrainingVaultMetadata(
    map: Record<string, TrainingVaultMetadata>,
    options: {
      path: string;
      kind: "file" | "directory";
      user?: User | null;
      ipAddress?: string;
      workerName?: string | null;
      projectPaths?: string[];
      sourcePaths?: string[];
      remarks?: string | null;
    },
  ): TrainingVaultMetadata | null {
    const normalizedPath = normalizeTrainingVaultMetadataPath(options.path);
    if (!normalizedPath) return null;

    const now = new Date().toISOString();
    const previous = map[normalizedPath];
    const actor: TrainingVaultMetadataActor = {
      id: options.user?.id ?? null,
      username: options.user?.username ?? null,
      ipAddress: options.ipAddress?.trim() || null,
      workerName: options.workerName?.trim() || null,
    };
    const hasActor = Boolean(actor.id || actor.username || actor.ipAddress || actor.workerName);

    const createdBy = previous?.createdBy ?? (
      hasActor
        ? actor
        : { id: null, username: null, ipAddress: null, workerName: null }
    );
    const updatedBy = hasActor ? actor : previous?.updatedBy ?? createdBy;
    const projectPaths = options.projectPaths
      ? normalizeTrainingVaultMetadataPaths(options.projectPaths)
      : (previous?.projectPaths ?? []);
    const sourcePaths = options.sourcePaths
      ? normalizeTrainingVaultMetadataPaths(options.sourcePaths)
      : (previous?.sourcePaths ?? []);
    const remarks = options.remarks !== undefined
      ? normalizeTrainingVaultMetadataRemarks(options.remarks)
      : (previous?.remarks ?? null);

    const next: TrainingVaultMetadata = {
      path: normalizedPath,
      kind: options.kind,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      createdBy,
      updatedBy,
      projectPaths,
      sourcePaths,
      remarks,
    };
    map[normalizedPath] = next;
    return next;
  }

  function pruneTrainingVaultMetadataPath(
    map: Record<string, TrainingVaultMetadata>,
    pathValue: string,
    recursive: boolean,
  ) {
    const normalizedPath = normalizeTrainingVaultMetadataPath(pathValue);
    if (!normalizedPath) return;
    delete map[normalizedPath];
    if (!recursive) return;
    const prefix = `${normalizedPath}/`;
    for (const path of Object.keys(map)) {
      if (!path.startsWith(prefix)) continue;
      delete map[path];
    }
  }

  function firstNonEmptyText(...values: Array<unknown>): string | null {
    for (const value of values) {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return null;
  }

  function parseTrainingJobFolder(folder: string): { jobId: string; jobLabel: string } {
    const raw = String(folder ?? "").trim();
    if (!raw) return { jobId: "", jobLabel: "training job" };
    const separator = raw.lastIndexOf("--");
    if (separator > 0 && separator < raw.length - 2) {
      const labelPart = raw.slice(0, separator);
      const idPart = raw.slice(separator + 2);
      const label = labelPart.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      return {
        jobId: idPart,
        jobLabel: label || idPart,
      };
    }
    return {
      jobId: raw,
      jobLabel: raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || raw,
    };
  }

  function normalizeTrainingSignal(input: unknown): TrainingJobSignal {
    const normalized = String(input ?? "").trim().toLowerCase();
    if (normalized === "positive" || normalized === "good" || normalized === "success") return "positive";
    if (normalized === "average" || normalized === "partial") return "average";
    if (normalized === "negative" || normalized === "poor" || normalized === "failed" || normalized === "failure") {
      return "negative";
    }
    return "unknown";
  }

  function normalizeTrainingTransport(input: unknown): TrainingJobTransport {
    const normalized = String(input ?? "").trim().toLowerCase();
    if (normalized === "mcp") return "mcp";
    if (normalized === "cli_rest" || normalized === "cli" || normalized === "rest" || normalized === "api") {
      return "cli_rest";
    }
    if (normalized === "mixed") return "mixed";
    return "unknown";
  }

  function inferTrainingTransportFromLogs(logs: unknown): TrainingJobTransport {
    const text = String(logs ?? "");
    if (!text.trim()) return "unknown";
    const hasMcp = /arkestrator__|(?:^|\s)\[(?:execute_command|execute_multiple_commands|list_bridges|get_bridge_context|create_job|get_job_status|list_jobs|run_headless_check)\]/im
      .test(text);
    const hasCliRest = /\/api\/bridge-command|Invoke-RestMethod\s+-Method\s+Post\s+-Uri\s+.*\/api\/bridge-command|curl[^\n]+\/api\/bridge-command|(?:^|\s)am\s+exec\b/im
      .test(text);
    if (hasMcp && hasCliRest) return "mixed";
    if (hasMcp) return "mcp";
    if (hasCliRest) return "cli_rest";
    return "unknown";
  }

  function mergeTrainingTransport(a: TrainingJobTransport, b: TrainingJobTransport): TrainingJobTransport {
    if (a === b) return a;
    if (a === "unknown") return b;
    if (b === "unknown") return a;
    return "mixed";
  }

  function normalizeTrainingProgramList(input: unknown): string[] {
    const values = Array.isArray(input)
      ? input
      : String(input ?? "")
          .split(/[,\r\n]+/);
    const out = new Set<string>();
    for (const value of values) {
      const normalized = String(value ?? "").trim().toLowerCase();
      if (!normalized) continue;
      if (!/^[a-z0-9._-]+$/.test(normalized)) continue;
      out.add(normalized);
    }
    return [...out];
  }

  function normalizeTrainingJobFilters(raw: {
    program?: unknown;
    programs?: unknown;
    jobId?: unknown;
    q?: unknown;
    signal?: unknown;
    transport?: unknown;
    dateFrom?: unknown;
    dateTo?: unknown;
    limit?: unknown;
  }): TrainingJobQueryFilters {
    const programs = normalizeTrainingProgramList(raw.programs ?? raw.program);
    const jobId = firstNonEmptyText(raw.jobId);
    const q = firstNonEmptyText(raw.q);
    const signal = normalizeTrainingSignal(raw.signal);
    const transport = normalizeTrainingTransport(raw.transport);

    const dateFromRaw = firstNonEmptyText(raw.dateFrom);
    const dateToRaw = firstNonEmptyText(raw.dateTo);
    const dateFrom = dateFromRaw && !Number.isNaN(Date.parse(dateFromRaw)) ? dateFromRaw : null;
    const dateTo = dateToRaw && !Number.isNaN(Date.parse(dateToRaw)) ? dateToRaw : null;

    const parsedLimit = Number(raw.limit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(20_000, Math.round(parsedLimit)))
      : 400;

    return {
      programs,
      jobId: jobId ? jobId.trim() : null,
      q: q ? q.toLowerCase() : null,
      signal: signal === "unknown" ? null : signal,
      transport: transport === "unknown" ? null : transport,
      dateFrom,
      dateTo,
      limit,
    };
  }

  function getTrainingJobArtifacts(
    maxEntries = 10_000,
  ): Array<{
    path: string;
    relPath: string;
    program: string;
    updatedAt: string | null;
    bytes: number;
    parsed: Record<string, unknown>;
  }> {
    const root = join(coordinatorPlaybooksDir, "_learning", "jobs");
    if (!existsSync(root)) return [];

    const entries = listCoordinatorEntriesRecursive(root, Math.max(500, maxEntries * 2));
    const out: Array<{
      path: string;
      relPath: string;
      program: string;
      updatedAt: string | null;
      bytes: number;
      parsed: Record<string, unknown>;
    }> = [];

    for (const entry of entries) {
      if (out.length >= maxEntries) break;
      if (entry.kind !== "file") continue;
      if (!entry.path.toLowerCase().endsWith(".json")) continue;

      const relPath = normalizeRelativePath(entry.path).replace(/^\/+|\/+$/g, "");
      const segments = relPath.split("/").filter(Boolean);
      const program = String(segments[0] ?? "").trim().toLowerCase();
      if (!program || !/^[a-z0-9._-]+$/.test(program)) continue;

      const absPath = resolvePathWithin(root, relPath);
      if (!absPath || !existsSync(absPath)) continue;
      if (entry.bytes > 8 * 1024 * 1024) continue;

      try {
        const raw = readFileSync(absPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        out.push({
          path: `learning/jobs/${relPath}`.replace(/\\/g, "/"),
          relPath,
          program,
          updatedAt: entry.updatedAt ?? null,
          bytes: entry.bytes,
          parsed: parsed as Record<string, unknown>,
        });
      } catch {
        // Skip unreadable or invalid JSON artifacts.
      }
    }

    return out;
  }

  function buildTrainingJobSummaryMap(
    maxEntries = 10_000,
  ): Map<string, TrainingJobSummary> {
    const byKey = new Map<string, TrainingJobSummary>();
    const artifacts = getTrainingJobArtifacts(maxEntries);

    for (const artifact of artifacts) {
      const parsed = artifact.parsed;
      const metadata = parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : {};
      const job = parsed.job && typeof parsed.job === "object" && !Array.isArray(parsed.job)
        ? (parsed.job as Record<string, unknown>)
        : {};

      const relSegments = artifact.relPath.split("/").filter(Boolean);
      const folder = relSegments[1] ?? "";
      const fileName = basename(artifact.relPath).replace(/\.json$/i, "");
      const folderInfo = parseTrainingJobFolder(folder);

      const jobId = firstNonEmptyText(
        job.id,
        metadata.jobId,
        folderInfo.jobId,
        fileName,
      );
      if (!jobId) continue;
      const key = `${artifact.program}:${jobId}`;

      const signalFromData = normalizeTrainingSignal(parsed.signal ?? metadata.signal);
      const signalFromSuccess = job.success === true ? "positive" : job.success === false ? "negative" : "unknown";
      const signal = signalFromData !== "unknown" ? signalFromData : signalFromSuccess;

      const prompt = firstNonEmptyText(job.prompt, parsed.prompt) ?? "";
      const outcome = firstNonEmptyText(parsed.outcome, job.error) ?? "";

      const derivedName = firstNonEmptyText(
        job.name,
        metadata.jobName,
        folderInfo.jobLabel,
        prompt,
      );
      const model = firstNonEmptyText(metadata.actualModel, job.actualModel);
      const agentConfigId = firstNonEmptyText(metadata.agentConfigId, job.agentConfigId);
      const actualAgentConfigId = firstNonEmptyText(metadata.actualAgentConfigId, job.actualAgentConfigId);
      const resolvedConfigId = actualAgentConfigId || agentConfigId;
      const agentEngine = resolvedConfigId ? firstNonEmptyText(agentsRepo.getById(resolvedConfigId)?.engine) : null;

      const transport = mergeTrainingTransport(
        normalizeTrainingTransport(parsed.transport),
        inferTrainingTransportFromLogs(job.logs),
      );

      const usedBridgesRaw = Array.isArray(job.usedBridges)
        ? job.usedBridges
        : Array.isArray(metadata.usedBridges)
          ? metadata.usedBridges
          : [];
      const usedBridges = [...new Set(
        usedBridgesRaw
          .map((value) => String(value ?? "").trim().toLowerCase())
          .filter((value) => /^[a-z0-9._-]+$/.test(value)),
      )];

      const submittedByUserId = firstNonEmptyText(metadata.submittedByUserId, job.submittedBy);
      const submittedByUsername = firstNonEmptyText(
        metadata.submittedByUsername,
        submittedByUserId ? usersRepo.getById(submittedByUserId)?.username : null,
      );
      const outcomeMarkedByUserId = firstNonEmptyText(metadata.outcomeMarkedByUserId, job.outcomeMarkedBy);
      const outcomeMarkedByUsername = firstNonEmptyText(
        metadata.outcomeMarkedByUsername,
        outcomeMarkedByUserId ? usersRepo.getById(outcomeMarkedByUserId)?.username : null,
      );

      const next: TrainingJobSummary = {
        jobId,
        name: derivedName ?? "",
        program: firstNonEmptyText(
          parsed.program,
          metadata.bridgeProgram,
          job.bridgeProgram,
          artifact.program,
        ) ?? artifact.program,
        signal,
        prompt,
        outcome,
        model,
        agentEngine,
        agentConfigId,
        actualAgentConfigId,
        workspaceMode: firstNonEmptyText(job.workspaceMode),
        coordinationMode: firstNonEmptyText(job.coordinationMode, metadata.coordinationMode),
        transport,
        workerName: firstNonEmptyText(job.workerName),
        targetWorkerName: firstNonEmptyText(job.targetWorkerName),
        bridgeProgram: firstNonEmptyText(job.bridgeProgram, metadata.bridgeProgram),
        bridgeId: firstNonEmptyText(job.bridgeId),
        usedBridges,
        submittedByUserId,
        submittedByUsername,
        outcomeMarkedByUserId,
        outcomeMarkedByUsername,
        createdAt: firstNonEmptyText(job.createdAt),
        startedAt: firstNonEmptyText(job.startedAt),
        completedAt: firstNonEmptyText(job.completedAt),
        storedAt: firstNonEmptyText(parsed.storedAt, artifact.updatedAt),
        artifactCount: 1,
        artifactPaths: [artifact.path],
      };

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, next);
        continue;
      }

      existing.name = firstNonEmptyText(existing.name, next.name) ?? "";
      existing.signal = existing.signal === "unknown" ? next.signal : existing.signal;
      existing.prompt = firstNonEmptyText(existing.prompt, next.prompt) ?? "";
      existing.outcome = firstNonEmptyText(existing.outcome, next.outcome) ?? "";
      existing.model = firstNonEmptyText(existing.model, next.model);
      existing.agentEngine = firstNonEmptyText(existing.agentEngine, next.agentEngine);
      existing.agentConfigId = firstNonEmptyText(existing.agentConfigId, next.agentConfigId);
      existing.actualAgentConfigId = firstNonEmptyText(existing.actualAgentConfigId, next.actualAgentConfigId);
      existing.workspaceMode = firstNonEmptyText(existing.workspaceMode, next.workspaceMode);
      existing.coordinationMode = firstNonEmptyText(existing.coordinationMode, next.coordinationMode);
      existing.transport = mergeTrainingTransport(existing.transport, next.transport);
      existing.workerName = firstNonEmptyText(existing.workerName, next.workerName);
      existing.targetWorkerName = firstNonEmptyText(existing.targetWorkerName, next.targetWorkerName);
      existing.bridgeProgram = firstNonEmptyText(existing.bridgeProgram, next.bridgeProgram);
      existing.bridgeId = firstNonEmptyText(existing.bridgeId, next.bridgeId);
      existing.usedBridges = [...new Set([...existing.usedBridges, ...next.usedBridges])];
      existing.submittedByUserId = firstNonEmptyText(existing.submittedByUserId, next.submittedByUserId);
      existing.submittedByUsername = firstNonEmptyText(existing.submittedByUsername, next.submittedByUsername);
      existing.outcomeMarkedByUserId = firstNonEmptyText(existing.outcomeMarkedByUserId, next.outcomeMarkedByUserId);
      existing.outcomeMarkedByUsername = firstNonEmptyText(existing.outcomeMarkedByUsername, next.outcomeMarkedByUsername);
      existing.createdAt = firstNonEmptyText(existing.createdAt, next.createdAt);
      existing.startedAt = firstNonEmptyText(existing.startedAt, next.startedAt);
      existing.completedAt = firstNonEmptyText(existing.completedAt, next.completedAt);
      existing.storedAt = firstNonEmptyText(next.storedAt, existing.storedAt);
      existing.artifactCount += 1;
      existing.artifactPaths = [...new Set([...existing.artifactPaths, ...next.artifactPaths])];
    }

    return byKey;
  }

  function trainingJobMatchesFilters(summary: TrainingJobSummary, filters: TrainingJobQueryFilters): boolean {
    if (filters.programs.length > 0 && !filters.programs.includes(summary.program.toLowerCase())) {
      return false;
    }

    if (filters.jobId) {
      const expected = filters.jobId.toLowerCase();
      if (!summary.jobId.toLowerCase().includes(expected)) return false;
    }

    if (filters.signal && summary.signal !== filters.signal) return false;
    if (filters.transport && summary.transport !== filters.transport) return false;

    const fromMs = filters.dateFrom ? Date.parse(filters.dateFrom) : Number.NaN;
    const toMs = filters.dateTo ? Date.parse(filters.dateTo) : Number.NaN;
    const compareDateRaw = summary.completedAt || summary.storedAt || summary.createdAt || "";
    const compareDateMs = Date.parse(compareDateRaw);
    if (Number.isFinite(fromMs) && Number.isFinite(compareDateMs) && compareDateMs < fromMs) return false;
    if (Number.isFinite(toMs) && Number.isFinite(compareDateMs) && compareDateMs > toMs) return false;

    if (filters.q) {
      const haystack = [
        summary.jobId,
        summary.name,
        summary.program,
        summary.signal,
        summary.model ?? "",
        summary.agentEngine ?? "",
        summary.transport,
        summary.workerName ?? "",
        summary.targetWorkerName ?? "",
        summary.bridgeProgram ?? "",
        summary.usedBridges.join(" "),
        summary.submittedByUsername ?? "",
        summary.outcomeMarkedByUsername ?? "",
        summary.prompt,
        summary.outcome,
        summary.artifactPaths.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.q)) return false;
    }

    return true;
  }

  function resolveTrainingDataExportSelection(raw: {
    scope?: unknown;
    program?: unknown;
    programs?: unknown;
    jobId?: unknown;
    jobIds?: unknown;
    q?: unknown;
    signal?: unknown;
    transport?: unknown;
    dateFrom?: unknown;
    dateTo?: unknown;
    limit?: unknown;
  }): {
    scope: TrainingDataExportScope;
    filters: TrainingJobQueryFilters;
    selectedJobIds: string[];
    matched: TrainingJobSummary[];
    error?: string;
  } {
    const scopeRaw = String(raw.scope ?? "filtered").trim().toLowerCase();
    const scope = (
      scopeRaw === "all" || scopeRaw === "filtered" || scopeRaw === "program" || scopeRaw === "job" || scopeRaw === "selected"
    )
      ? scopeRaw
      : "filtered";

    const requestedFilters = normalizeTrainingJobFilters({
      program: raw.program,
      programs: raw.programs,
      jobId: raw.jobId,
      q: raw.q,
      signal: raw.signal,
      transport: raw.transport,
      dateFrom: raw.dateFrom,
      dateTo: raw.dateTo,
      limit: raw.limit ?? 20_000,
    });
    const filters: TrainingJobQueryFilters = { ...requestedFilters };

    const selectedJobIds = (() => {
      const values = Array.isArray(raw.jobIds)
        ? raw.jobIds
        : String(raw.jobIds ?? "")
            .split(/[,\r\n]+/);
      const out = new Set<string>();
      for (const value of values) {
        const normalized = String(value ?? "").trim().toLowerCase();
        if (!normalized) continue;
        out.add(normalized);
      }
      return [...out];
    })();
    if (scope === "all") {
      filters.programs = [];
      filters.jobId = null;
      filters.q = null;
      filters.signal = null;
      filters.transport = null;
      filters.dateFrom = null;
      filters.dateTo = null;
    } else if (scope === "program") {
      if (filters.programs.length === 0) {
        return {
          scope,
          filters,
          selectedJobIds,
          matched: [],
          error: "program/programs filter is required for scope=program",
        };
      }
      filters.jobId = null;
      filters.q = null;
    } else if (scope === "job") {
      if (!filters.jobId) {
        return {
          scope,
          filters,
          selectedJobIds,
          matched: [],
          error: "jobId is required for scope=job",
        };
      }
      filters.q = null;
      filters.signal = null;
      filters.transport = null;
      filters.dateFrom = null;
      filters.dateTo = null;
    } else if (scope === "selected") {
      if (selectedJobIds.length === 0) {
        return {
          scope,
          filters,
          selectedJobIds,
          matched: [],
          error: "jobIds is required for scope=selected",
        };
      }
      filters.jobId = null;
      filters.q = null;
      filters.signal = null;
      filters.transport = null;
      filters.dateFrom = null;
      filters.dateTo = null;
      filters.programs = [];
    }

    const summaryMap = buildTrainingJobSummaryMap(Math.max(filters.limit * 4, 2000));
    const all = [...summaryMap.values()];
    let matched = all.filter((item) => trainingJobMatchesFilters(item, filters));
    if (scope === "selected") {
      const selected = new Set(selectedJobIds);
      matched = all.filter((item) => selected.has(item.jobId.toLowerCase()));
    }
    matched.sort((a, b) => {
      const aTs = Date.parse(a.completedAt || a.storedAt || a.createdAt || "") || 0;
      const bTs = Date.parse(b.completedAt || b.storedAt || b.createdAt || "") || 0;
      if (bTs !== aTs) return bTs - aTs;
      return a.jobId.localeCompare(b.jobId);
    });

    return {
      scope,
      filters,
      selectedJobIds,
      matched: matched.slice(0, filters.limit),
    };
  }

  function listAllTrainingVaultFiles(
    perRootLimit = 20_000,
  ): Array<{
    path: string;
    root: CoordinatorFileRootKey;
    fullPath: string;
    bytes: number;
    updatedAt: string;
    program: string | null;
  }> {
    const out: Array<{
      path: string;
      root: CoordinatorFileRootKey;
      fullPath: string;
      bytes: number;
      updatedAt: string;
      program: string | null;
    }> = [];
    for (const root of getCoordinatorFileRoots()) {
      if (!existsSync(root.baseDir)) continue;
      const rows = listCoordinatorEntriesRecursive(root.baseDir, perRootLimit);
      for (const row of rows) {
        if (row.kind !== "file") continue;
        const fullPath = resolvePathWithin(root.baseDir, row.path);
        if (!fullPath || !existsSync(fullPath)) continue;
        out.push({
          path: `${root.key}/${row.path}`.replace(/\\/g, "/"),
          root: root.key,
          fullPath,
          bytes: row.bytes,
          updatedAt: row.updatedAt,
          program: inferTrainingVaultProgram(root.key, row.path),
        });
      }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  function filterTrainingMetadataForExportPaths(
    metadataByPath: Record<string, TrainingVaultMetadata>,
    filePaths: Set<string>,
  ): TrainingVaultMetadata[] {
    const out: TrainingVaultMetadata[] = [];
    for (const metadata of Object.values(metadataByPath)) {
      const key = normalizeTrainingVaultMetadataPath(metadata.path);
      if (!key) continue;
      let include = filePaths.has(key);
      if (!include) {
        const prefix = `${key}/`;
        for (const filePath of filePaths) {
          if (filePath.startsWith(prefix)) {
            include = true;
            break;
          }
        }
      }
      if (!include) continue;
      out.push(metadata);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  function collectTrainingVaultExportFiles(
    scope: TrainingDataExportScope,
    matchedJobs: TrainingJobSummary[],
    allFiles: Array<{
      path: string;
      root: CoordinatorFileRootKey;
      fullPath: string;
      bytes: number;
      updatedAt: string;
      program: string | null;
    }>,
  ): Array<{
    path: string;
    fullPath: string;
    bytes: number;
    updatedAt: string;
  }> {
    if (scope === "all") {
      return allFiles.map((item) => ({
        path: item.path,
        fullPath: item.fullPath,
        bytes: item.bytes,
        updatedAt: item.updatedAt,
      }));
    }

    const includePaths = new Set<string>();
    for (const job of matchedJobs) {
      for (const pathRaw of job.artifactPaths ?? []) {
        const normalized = normalizeTrainingVaultMetadataPath(pathRaw);
        if (!normalized) continue;
        includePaths.add(normalized);
      }
    }

    const relatedPrograms = new Set<string>(
      matchedJobs
        .map((job) => job.program?.toLowerCase?.() ?? "")
        .filter((value) => /^[a-z0-9._-]+$/.test(value)),
    );

    for (const program of relatedPrograms) {
      includePaths.add(`scripts/${program}.md`);
    }

    const out = allFiles.filter((item) => {
      if (includePaths.has(item.path)) return true;
      const program = item.program?.toLowerCase?.() ?? "";
      if (!program) return false;
      if (!relatedPrograms.has(program)) return false;
      if (item.path.startsWith(`playbooks/${program}/`)) return true;
      if (item.path === `learning/${program}.json` || item.path === `learning/${program}.experiences.json`) return true;
      return false;
    });

    out.sort((a, b) => a.path.localeCompare(b.path));
    return out.map((item) => ({
      path: item.path,
      fullPath: item.fullPath,
      bytes: item.bytes,
      updatedAt: item.updatedAt,
    }));
  }

  function parseBooleanWithDefault(value: unknown, fallback: boolean): boolean {
    if (value == null) return fallback;
    const text = String(value).trim();
    if (!text) return fallback;
    return parseExportImportBoolean(text);
  }

  function normalizeMultipartStringList(values: unknown[]): string[] {
    const out = new Set<string>();
    for (const item of values) {
      const value = String(item ?? "").trim();
      if (!value) continue;
      out.add(value);
    }
    return [...out];
  }

  function sanitizeTrainingUploadRelativePath(input: string): string {
    const normalized = normalizeRelativePath(input).replace(/^\/+/, "");
    if (!normalized) return "";
    const parts = normalized.split("/").filter(Boolean);
    const safeParts: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "..") return "";
      const safe = part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
      if (!safe) return "";
      safeParts.push(safe);
    }
    return safeParts.join("/");
  }

  function normalizeZipEntryPath(entryPath: string): string {
    const normalized = String(entryPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.endsWith("/")) return "";
    const parts = normalized.split("/").filter(Boolean);
    const safeParts: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "..") return "";
      const safe = part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
      if (!safe) return "";
      safeParts.push(safe);
    }
    return safeParts.join("/");
  }

  async function stageTrainingUploadFiles(
    program: string,
    files: File[],
    requestedPaths: string[] = [],
  ): Promise<{
    sessionDir: string;
    sessionVaultPath: string;
    sourcePaths: string[];
    uploads: Array<{
      path: string;
      bytes: number;
      extracted: boolean;
      kind: "file" | "directory";
      sourcePath: string;
    }>;
  }> {
    const uploadsRoot = join(coordinatorPlaybooksDir, "_learning", "uploads", program);
    const sessionId = `${Date.now()}-${newId().slice(0, 8)}`;
    const sessionDir = join(uploadsRoot, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const sessionVaultPath = `learning/uploads/${program}/${sessionId}`.replace(/\\/g, "/");

    const sourcePaths = new Set<string>();
    const uploads: Array<{
      path: string;
      bytes: number;
      extracted: boolean;
      kind: "file" | "directory";
      sourcePath: string;
    }> = [];
    let totalUploadedBytes = 0;
    let totalExtractedBytes = 0;
    let totalExtractedEntries = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const requestedPath = sanitizeTrainingUploadRelativePath(requestedPaths[i] || "");
      const fallbackName = sanitizeTrainingUploadRelativePath(file.name || "") || `upload-${i + 1}.bin`;
      const relPath = requestedPath || fallbackName;
      const outPath = resolvePathWithin(sessionDir, relPath);
      if (!outPath) continue;

      const data = Buffer.from(await file.arrayBuffer());
      if (data.byteLength > MAX_TRAINING_UPLOAD_FILE_BYTES) {
        throw new Error(`Uploaded file exceeds size limit (${relPath})`);
      }
      totalUploadedBytes += data.byteLength;
      if (totalUploadedBytes > MAX_TRAINING_UPLOAD_TOTAL_BYTES) {
        throw new Error("Uploaded files exceed total size limit");
      }

      const isZip = /\.zip$/i.test(relPath) || /\.zip$/i.test(file.name || "");
      if (isZip) {
        let extractedCount = 0;
        let extractedBytes = 0;
        const archiveRootName = sanitizeTrainingUploadRelativePath(basename(relPath, ".zip")) || `archive-${i + 1}`;
        try {
          const entries = unzipSync(new Uint8Array(data));
          for (const [entryPathRaw, entryData] of Object.entries(entries)) {
            const entryPath = normalizeZipEntryPath(entryPathRaw);
            if (!entryPath) continue;
            totalExtractedEntries += 1;
            if (totalExtractedEntries > MAX_TRAINING_UPLOAD_EXTRACTED_ENTRIES) {
              throw new Error("Archive extraction exceeds entry limit");
            }
            extractedBytes += entryData.byteLength;
            totalExtractedBytes += entryData.byteLength;
            if (totalExtractedBytes > MAX_TRAINING_UPLOAD_EXTRACTED_BYTES) {
              throw new Error("Archive extraction exceeds size limit");
            }

            const extractedRelPath = `${archiveRootName}/${entryPath}`.replace(/\\/g, "/");
            const extractedOutPath = resolvePathWithin(sessionDir, extractedRelPath);
            if (!extractedOutPath) continue;
            mkdirSync(dirname(extractedOutPath), { recursive: true });
            writeFileSync(extractedOutPath, Buffer.from(entryData));
            extractedCount += 1;
          }
        } catch (err: any) {
          throw new Error(`Failed to extract zip ${relPath}: ${String(err?.message ?? err)}`);
        }

        if (extractedCount > 0) {
          const extractedDir = resolvePathWithin(sessionDir, archiveRootName);
          if (extractedDir) {
            sourcePaths.add(extractedDir);
            uploads.push({
              path: `${sessionVaultPath}/${archiveRootName}`.replace(/\\/g, "/"),
              bytes: extractedBytes,
              extracted: true,
              kind: "directory",
              sourcePath: extractedDir,
            });
          }
          continue;
        }
      }

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, data);
      sourcePaths.add(outPath);
      uploads.push({
        path: `${sessionVaultPath}/${relPath}`.replace(/\\/g, "/"),
        bytes: data.byteLength,
        extracted: false,
        kind: "file",
        sourcePath: outPath,
      });
    }

    return {
      sessionDir,
      sessionVaultPath,
      sourcePaths: [...sourcePaths],
      uploads,
    };
  }

  function getCoordinatorEditors(): string[] {
    return parseCoordinatorReferencePaths(settingsRepo.get("coordinator_editors"));
  }

  function canEditCoordinatorFiles(user: User): boolean {
    if (user.role === "admin") return true;
    if (user.permissions.editCoordinator) return true;
    const editors = new Set(getCoordinatorEditors());
    return editors.has(user.id);
  }

  function requireCoordinatorEditor(c: any) {
    const user = getAuthenticatedUser(c, usersRepo);
    if (!user) return null;
    if (!canEditCoordinatorFiles(user)) return null;
    return user;
  }

  function requireSecurityManager(c: any) {
    const user = requirePermission(c, usersRepo, "manageSecurity");
    return user;
  }

  function folderHasReferenceDocument(folderPath: string): boolean {
    const candidateNames = [
      "README.md",
      "README.txt",
      "ABOUT.md",
      "about.md",
      "DESCRIPTION.md",
      "description.md",
      "NOTES.md",
      "notes.md",
      "docs.md",
    ];
    for (const name of candidateNames) {
      const p = join(folderPath, name);
      if (existsSync(p)) {
        try {
          if (statSync(p).isFile()) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  function listFilesRecursive(root: string, maxFiles = 300): string[] {
    const out: string[] = [];
    const stack: string[] = [""];

    while (stack.length > 0 && out.length < maxFiles) {
      const relDir = stack.pop() as string;
      const absDir = relDir ? join(root, relDir) : root;

      let entries: string[] = [];
      try {
        entries = readdirSync(absDir);
      } catch {
        continue;
      }

      entries.sort();
      for (const name of entries) {
        if (out.length >= maxFiles) break;
        const relPath = relDir ? join(relDir, name) : name;
        const absPath = join(absDir, name);
        let st;
        try {
          st = statSync(absPath);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(relPath);
        } else if (st.isFile()) {
          out.push(relPath.replace(/\\/g, "/"));
        }
      }
    }

    out.sort();
    return out;
  }

  function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string; cloneUrl: string } | null {
    const trimmed = repoUrl.trim();
    if (!trimmed) return null;

    let owner = "";
    let repo = "";

    if (/^https?:\/\//i.test(trimmed)) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmed);
      } catch {
        return null;
      }
      const host = parsedUrl.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") return null;
      const parts = parsedUrl.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, "");
    } else {
      const match = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
      if (!match) return null;
      owner = match[1];
      repo = match[2];
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
      return null;
    }

    return {
      owner,
      repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  function sanitizeSlug(value: string): string {
    const slug = value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || "source";
  }

  const IMPORT_TEXT_EXTENSIONS = new Set([
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".cfg",
    ".ini",
    ".py",
    ".gd",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".cpp",
    ".h",
    ".hpp",
    ".c",
    ".rs",
    ".xml",
    ".csv",
    ".usda",
    ".vfl",
  ]);
  const MAX_IMPORTED_REFERENCE_FILE_BYTES = 512_000;
  const MAX_IMPORTED_REFERENCE_FILES = 120;

  function isPortableReferenceFile(pathValue: string): boolean {
    const ext = basename(pathValue).includes(".")
      ? `.${basename(pathValue).split(".").pop()?.toLowerCase() ?? ""}`
      : "";
    return IMPORT_TEXT_EXTENSIONS.has(ext);
  }

  function copyCuratedReferenceFolder(
    sourceDir: string,
    destinationDir: string,
  ): { copiedFiles: string[]; skippedFiles: Array<{ path: string; reason: string }> } {
    const copiedFiles: string[] = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    const files = listFilesRecursive(sourceDir, MAX_IMPORTED_REFERENCE_FILES);
    mkdirSync(destinationDir, { recursive: true });

    for (const relPath of files) {
      if (copiedFiles.length >= MAX_IMPORTED_REFERENCE_FILES) {
        skippedFiles.push({ path: relPath, reason: "limit_exceeded" });
        continue;
      }
      const sourcePath = join(sourceDir, relPath);
      let st;
      try {
        st = statSync(sourcePath);
      } catch {
        skippedFiles.push({ path: relPath, reason: "stat_failed" });
        continue;
      }
      if (!st.isFile()) continue;
      if (!isPortableReferenceFile(sourcePath)) {
        skippedFiles.push({ path: relPath, reason: "unsupported_type" });
        continue;
      }
      if (st.size > MAX_IMPORTED_REFERENCE_FILE_BYTES) {
        skippedFiles.push({ path: relPath, reason: "too_large" });
        continue;
      }
      try {
        const content = readFileSync(sourcePath);
        const outPath = resolvePathWithin(destinationDir, relPath);
        if (!outPath) {
          skippedFiles.push({ path: relPath, reason: "invalid_path" });
          continue;
        }
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, content);
        copiedFiles.push(relPath.replace(/\\/g, "/"));
      } catch {
        skippedFiles.push({ path: relPath, reason: "copy_failed" });
      }
    }

    return { copiedFiles, skippedFiles };
  }

  function findFilesByName(
    root: string,
    fileName: string,
    maxDepth = 4,
    maxFiles = 300,
  ): string[] {
    const out: string[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

    while (queue.length > 0 && out.length < maxFiles) {
      const { path, depth } = queue.shift() as { path: string; depth: number };
      let entries: string[] = [];
      try {
        entries = readdirSync(path);
      } catch {
        continue;
      }
      entries.sort();

      for (const name of entries) {
        if (out.length >= maxFiles) break;
        const full = join(path, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth < maxDepth) queue.push({ path: full, depth: depth + 1 });
        } else if (st.isFile() && name === fileName) {
          out.push(full);
        }
      }
    }
    return out;
  }

  function generateAutoPlaybookFromFolder(program: string, folderPath: string): {
    manifest: any;
    instructionFiles: Array<{ relPath: string; content: string }>;
  } | null {
    if (program === "godot") {
      const projectFiles = findFilesByName(folderPath, "project.godot", 4, 400);
      if (projectFiles.length === 0) return null;

      const groups = new Map<string, string[]>();
      for (const projectFile of projectFiles) {
        const relDir = relative(folderPath, dirname(projectFile)).replace(/\\/g, "/");
        const first = relDir.split("/")[0] || "root";
        if (!groups.has(first)) groups.set(first, []);
        groups.get(first)?.push(relDir || ".");
      }

      const tasks: any[] = [];
      const instructionFiles: Array<{ relPath: string; content: string }> = [];
      const sortedGroups = [...groups.keys()].sort();

      for (const group of sortedGroups) {
        const refs = [...new Set(groups.get(group) ?? [])].sort();
        const taskId = `${sanitizeSlug(group)}_patterns`;
        const instructionPath = `tasks/${taskId}.md`;
        const rootRef = group === "root" ? "." : group;
        const examples = [...new Set([rootRef, ...refs.slice(0, 4)])];

        tasks.push({
          id: taskId,
          title: `${group === "root" ? "General" : group.toUpperCase()} Demo Patterns`,
          description: `Auto-generated references from ${group === "root" ? "the root" : `category '${group}'`} in ${folderPath}.`,
          instruction: instructionPath,
          keywords: ["godot", group, "demo", "pattern"],
          examples,
        });

        instructionFiles.push({
          relPath: instructionPath,
          content: [
            `Use ${group === "root" ? "root-level" : `'${group}'`} demo projects in ${folderPath} as implementation references.`,
            "Keep architecture and naming consistent with the closest matching demo.",
            "Before reporting done: verify scene opens cleanly and scripts compile with no parser/runtime errors.",
          ].join("\n"),
        });
      }

      return {
        manifest: {
          version: 1,
          program,
          description: `Auto-generated from ${folderPath}`,
          referencePaths: [folderPath],
          tasks,
        },
        instructionFiles,
      };
    }

    // Generic fallback for non-Godot folders: create one task anchored to root.
    return {
      manifest: {
        version: 1,
        program,
        description: `Auto-generated from ${folderPath}`,
        referencePaths: [folderPath],
        tasks: [
          {
            id: "folder_reference",
            title: "Folder Reference",
            description: "Use this folder as reference context for this program.",
            instruction: "tasks/folder_reference.md",
            keywords: [program, "reference", "example"],
            examples: ["."],
          },
        ],
      },
      instructionFiles: [
        {
          relPath: "tasks/folder_reference.md",
          content: [
            `Use files from ${folderPath} as references for this task.`,
            "Extract implementation patterns, naming conventions, and verification checks from the closest examples.",
          ].join("\n"),
        },
      ],
    };
  }

  const PROJECT_CONFIG_FILE = "arkestrator.coordinator.json";
  const PROJECT_NOTES_FILE = "arkestrator.coordinator.md";
  const PROJECT_CONFIG_FILE_ALIASES = [PROJECT_CONFIG_FILE] as const;
  const SOURCE_NAMES_SETTING = "coordinator_playbook_source_names";
  const SOURCE_PROGRAMS_SETTING = "coordinator_playbook_source_programs";
  const ANALYZE_AGENT_SETTING = "coordinator_analyze_agent_config_id";
  const TRAINING_VAULT_METADATA_SETTING = "coordinator_training_vault_metadata_v1";
  const DOC_FILE_CANDIDATES = [
    "README.md",
    "README.txt",
    "ABOUT.md",
    "NOTES.md",
    "DESCRIPTION.md",
    "docs.md",
  ];
  const SKIP_SCAN_DIRS = new Set([
    ".git",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    "node_modules",
    "__pycache__",
    ".venv",
    "Library",
    "Temp",
    "Logs",
    "obj",
    "bin",
  ]);

  function resolveSourceFolder(programDir: string, pathValue: string): string | null {
    const input = String(pathValue ?? "").trim();
    if (!input) return null;
    if (isAbsolute(input)) return input;
    return resolvePathWithin(programDir, input);
  }

  function resolveProjectConfigPath(projectDir: string): string {
    return join(projectDir, PROJECT_CONFIG_FILE);
  }

  function resolveProjectNotesPath(projectDir: string): string {
    return join(projectDir, PROJECT_NOTES_FILE);
  }

  function looksLikeProjectDir(program: string, dirPath: string, entries: string[]): boolean {
    const lower = new Set(entries.map((e) => e.toLowerCase()));
    const hasDoc = DOC_FILE_CANDIDATES.some((f) => lower.has(f.toLowerCase()));
    const hasFileWithExt = (extRegex: RegExp) => entries.some((e) => extRegex.test(e));

    if (program === "godot") return lower.has("project.godot");
    if (program === "unity") return lower.has("assets") && lower.has("projectsettings");
    if (program === "unreal") return hasFileWithExt(/\.uproject$/i);
    if (program === "blender") return hasFileWithExt(/\.blend$/i);
    if (program === "houdini") return hasFileWithExt(/\.hip(?:lc|nc)?$/i);
    if (program === "comfyui") return lower.has("workflow_api.json") || (hasDoc && hasFileWithExt(/\.json$/i));
    if (program === "global") return hasDoc;
    return hasDoc;
  }

  function discoverProjectDirs(
    program: string,
    sourceRoot: string,
    maxDepth = 4,
    maxProjects = 400,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [{ path: sourceRoot, depth: 0 }];

    while (queue.length > 0 && out.length < maxProjects) {
      const { path, depth } = queue.shift() as { path: string; depth: number };
      let entries: string[] = [];
      try {
        entries = readdirSync(path);
      } catch {
        continue;
      }

      if (looksLikeProjectDir(program, path, entries) && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
      if (depth >= maxDepth) continue;

      entries.sort();
      for (const name of entries) {
        const full = join(path, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        if (SKIP_SCAN_DIRS.has(name)) continue;
        queue.push({ path: full, depth: depth + 1 });
      }
    }

    if (out.length === 0) out.push(sourceRoot);
    return out;
  }

  function readDocSnippet(projectDir: string, maxChars = 1800): string {
    for (const fileName of DOC_FILE_CANDIDATES) {
      const full = join(projectDir, fileName);
      if (!existsSync(full)) continue;
      try {
        if (!statSync(full).isFile()) continue;
        const text = readFileSync(full, "utf-8").trim();
        if (text) return text.slice(0, maxChars);
      } catch {
        // ignore unreadable docs
      }
    }
    return "";
  }

  type InventoryFile = { path: string; bytes: number };
  type ProjectInventory = {
    fileCount: number;
    dirCount: number;
    totalBytes: number;
    topLevelEntries: string[];
    extensionCounts: Array<{ ext: string; count: number }>;
    sampleFiles: string[];
    largestFiles: InventoryFile[];
    keyFiles: string[];
  };

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function collectProjectInventory(
    projectDir: string,
    maxDepth = 5,
    maxFiles = 2000,
  ): ProjectInventory {
    const queue: Array<{ dir: string; depth: number; rel: string }> = [{ dir: projectDir, depth: 0, rel: "" }];
    const extensionMap = new Map<string, number>();
    const sampleFiles: string[] = [];
    const largestFiles: InventoryFile[] = [];
    const keyFiles: string[] = [];
    const keyNameSet = new Set([
      "project.godot",
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "workflow_api.json",
      "readme.md",
      "main.py",
      "main.cs",
      "main.cpp",
      "main.ts",
    ]);

    let fileCount = 0;
    let dirCount = 0;
    let totalBytes = 0;
    let topLevelEntries: string[] = [];

    while (queue.length > 0 && fileCount < maxFiles) {
      const item = queue.shift() as { dir: string; depth: number; rel: string };
      let entries: string[] = [];
      try {
        entries = readdirSync(item.dir).sort();
      } catch {
        continue;
      }

      if (item.depth === 0) topLevelEntries = entries.slice(0, 64);

      for (const name of entries) {
        if (fileCount >= maxFiles) break;
        const abs = join(item.dir, name);
        const relPath = item.rel ? `${item.rel}/${name}` : name;
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }

        if (st.isDirectory()) {
          if (SKIP_SCAN_DIRS.has(name)) continue;
          dirCount += 1;
          if (item.depth < maxDepth) queue.push({ dir: abs, depth: item.depth + 1, rel: relPath });
          continue;
        }
        if (!st.isFile()) continue;

        fileCount += 1;
        totalBytes += st.size;

        if (sampleFiles.length < 160) sampleFiles.push(relPath);

        if (keyNameSet.has(name.toLowerCase()) || /\.(hip(?:lc|nc)?|blend|uproject|usd|usda|usdc)$/i.test(name)) {
          keyFiles.push(relPath);
        }

        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "(no-ext)";
        extensionMap.set(ext, (extensionMap.get(ext) ?? 0) + 1);

        largestFiles.push({ path: relPath, bytes: st.size });
      }
    }

    largestFiles.sort((a, b) => b.bytes - a.bytes);
    sampleFiles.sort();
    keyFiles.sort();

    const extensionCounts = [...extensionMap.entries()]
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      fileCount,
      dirCount,
      totalBytes,
      topLevelEntries,
      extensionCounts,
      sampleFiles: sampleFiles.slice(0, 120),
      largestFiles: largestFiles.slice(0, 12),
      keyFiles: keyFiles.slice(0, 20),
    };
  }

  function buildProjectPrompt(program: string, projectDir: string, inventory: ProjectInventory): string {
    const projectName = basename(projectDir);
    const doc = readDocSnippet(projectDir);
    const topExt = inventory.extensionCounts.slice(0, 6).map((x) => `${x.ext} (${x.count})`).join(", ");
    const keyFilesText = inventory.keyFiles.slice(0, 10).join(", ");

    const lines: string[] = [];
    lines.push(`Use ${projectName} as a reference project for ${program} tasks.`);
    lines.push("Match naming, folder layout, and implementation patterns from this project when applicable.");
    lines.push(`Project inventory: ${inventory.fileCount} files in ${inventory.dirCount} folders (${formatBytes(inventory.totalBytes)}).`);
    if (topExt) lines.push(`Primary file types: ${topExt}.`);
    if (keyFilesText) lines.push(`Important files: ${keyFilesText}.`);
    if (doc) {
      lines.push("");
      lines.push("Documentation excerpt:");
      lines.push(doc);
    }
    lines.push("");
    lines.push("Before finishing work, run project-native verification and keep outputs aligned with this project's conventions.");
    return lines.join("\n");
  }

  function buildProjectNotes(
    program: string,
    projectDir: string,
    prompt: string,
    inventory: ProjectInventory,
  ): string {
    const projectName = basename(projectDir);
    const now = new Date().toISOString();
    const machineConfig = normalizeProjectConfig(program, projectDir, {
      projectName,
      prompt,
      updatedAt: now,
    });
    const docSnippet = readDocSnippet(projectDir, 2200);
    const topLevel = inventory.topLevelEntries.slice(0, 32);

    const lines: string[] = [];
    lines.push(`# ${projectName} Coordinator Notes`);
    lines.push("");
    lines.push(`- Program: ${program}`);
    lines.push(`- Project Path: ${projectDir}`);
    lines.push(`- Generated: ${now}`);
    lines.push(`- Files Indexed: ${inventory.fileCount}`);
    lines.push(`- Folders Indexed: ${inventory.dirCount}`);
    lines.push(`- Approx Size: ${formatBytes(inventory.totalBytes)}`);
    lines.push("");
    lines.push("## Purpose Summary");
    lines.push(prompt.trim() || `Use ${projectName} as a reference project for ${program} tasks.`);
    lines.push("");

    lines.push("## Inventory Summary");
    if (inventory.extensionCounts.length === 0) {
      lines.push("- No files detected during inventory scan.");
    } else {
      lines.push("| Extension | Count |");
      lines.push("|---|---:|");
      for (const item of inventory.extensionCounts) {
        lines.push(`| \`${item.ext}\` | ${item.count} |`);
      }
    }
    lines.push("");

    if (inventory.keyFiles.length > 0) {
      lines.push("## Key Files");
      for (const file of inventory.keyFiles) lines.push(`- \`${file}\``);
      lines.push("");
    }

    if (inventory.largestFiles.length > 0) {
      lines.push("## Largest Files");
      for (const file of inventory.largestFiles) {
        lines.push(`- \`${file.path}\` (${formatBytes(file.bytes)})`);
      }
      lines.push("");
    }

    if (inventory.sampleFiles.length > 0) {
      lines.push("## Sample File Paths");
      for (const file of inventory.sampleFiles.slice(0, 80)) lines.push(`- \`${file}\``);
      lines.push("");
    }

    if (docSnippet) {
      lines.push("## Documentation Excerpt");
      lines.push("```text");
      lines.push(docSnippet.trim());
      lines.push("```");
      lines.push("");
    }
    if (topLevel.length > 0) {
      lines.push("## Top-Level Contents");
      for (const name of topLevel) lines.push(`- ${name}`);
      lines.push("");
    }
    lines.push("## Usage");
    lines.push("- Use this project as a style/pattern reference before implementing changes.");
    lines.push("- Prefer existing naming, structure, and verification conventions found here.");
    lines.push("- Start by checking key files and sample paths listed above before inventing new structure.");
    lines.push("- Keep this notes file updated when project intent changes.");
    lines.push("");
    lines.push("## Machine Config");
    lines.push(`- Structured config: \`${PROJECT_CONFIG_FILE}\``);
    lines.push("- Human summary: this file");
    lines.push("");
    lines.push("### JSON Snapshot");
    lines.push("```json");
    lines.push(JSON.stringify(machineConfig, null, 2));
    lines.push("```");
    lines.push("");

    return `${lines.join("\n").trim()}\n`;
  }

  function normalizeProjectContexts(existing: any): Array<{
    id: string;
    title: string;
    prompt: string;
    programs: string[];
    tags: string[];
    scope: "server" | "client" | "both";
  }> {
    if (!Array.isArray(existing)) return [];
    const allowedPrograms = new Set(getCoordinatorScriptPrograms(programDiscoveryDeps).map((p) => p.toLowerCase()));
    const out: Array<{
      id: string;
      title: string;
      prompt: string;
      programs: string[];
      tags: string[];
      scope: "server" | "client" | "both";
    }> = [];

    for (let i = 0; i < existing.length; i++) {
      const raw = existing[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

      const prompt = String((raw as any).prompt ?? (raw as any).summary ?? (raw as any).description ?? "")
        .trim();
      if (!prompt) continue;

      const id = String((raw as any).id ?? `ctx_${i + 1}`).trim() || `ctx_${i + 1}`;
      const title = String((raw as any).title ?? (raw as any).name ?? (raw as any).label ?? id).trim() || id;

      const rawPrograms = Array.isArray((raw as any).programs)
        ? (raw as any).programs
        : Array.isArray((raw as any).bridges)
          ? (raw as any).bridges
          : [];
      const programs = [...new Set(
        rawPrograms
          .map((value: unknown) => String(value ?? "").trim().toLowerCase())
          .filter((value: string) => value && (allowedPrograms.has(value) || value === "global")),
      )] as string[];

      const tags = Array.isArray((raw as any).tags)
        ? [...new Set(
            (raw as any).tags
              .map((value: unknown) => String(value ?? "").trim().toLowerCase())
              .filter(Boolean),
          )] as string[]
        : [] as string[];

      const scopeRaw = String((raw as any).scope ?? "").trim().toLowerCase();
      const scope: "server" | "client" | "both" = scopeRaw === "client"
        ? "client"
        : scopeRaw === "server"
          ? "server"
          : "both";

      out.push({
        id,
        title,
        prompt,
        programs,
        tags,
        scope,
      });
    }

    return out.slice(0, 64);
  }

  function normalizeProjectConfig(program: string, projectDir: string, existing: any): any {
    const projectName = String(existing?.projectName ?? basename(projectDir)).trim() || basename(projectDir);
    const prompt = String(existing?.prompt ?? "").trim();
    return {
      version: 1,
      program,
      projectName,
      projectPath: projectDir,
      prompt,
      contexts: normalizeProjectContexts(existing?.contexts),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
    };
  }

  function parseProjectConfigFromNotesMarkdown(program: string, projectDir: string, markdown: string): any | null {
    const content = String(markdown ?? "");
    if (!content.trim()) return null;

    const jsonCodeBlockRegex = /```json\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null = null;
    while ((match = jsonCodeBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return normalizeProjectConfig(program, projectDir, parsed);
        }
      } catch {
        // try next block
      }
    }

    const titleMatch = content.match(/^#\s+(.+?)\s+Coordinator Notes\s*$/im);
    const projectName = String(titleMatch?.[1] ?? "").trim() || basename(projectDir);
    const purposeMatch = content.match(/^##\s+Purpose Summary\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/im);
    let prompt = String(purposeMatch?.[1] ?? "").trim();

    if (!prompt) {
      const stripped = content
        .replace(/^#.*$/gm, "")
        .replace(
          /^[-*]\s+(Program|Project Path|Generated|Files Indexed|Folders Indexed|Approx Size):.*$/gim,
          "",
        )
        .trim();
      prompt = stripped.split(/\n{2,}/).map((block) => block.trim()).find((block) => !!block) ?? "";
    }

    if (!prompt) return null;
    return normalizeProjectConfig(program, projectDir, { projectName, prompt });
  }

  function readProjectConfigFromNotes(program: string, projectDir: string): any | null {
    const notesPath = resolveProjectNotesPath(projectDir);
    if (!existsSync(notesPath)) return null;
    try {
      const markdown = readFileSync(notesPath, "utf-8");
      return parseProjectConfigFromNotesMarkdown(program, projectDir, markdown);
    } catch {
      return null;
    }
  }

  function restoreProjectConfigFromNotes(
    program: string,
    projectDir: string,
    configPath: string,
    fallbackPrompt?: string,
  ): { restored: boolean; config: any | null } {
    const recovered = readProjectConfigFromNotes(program, projectDir);
    if (!recovered) return { restored: false, config: null };
    if (!recovered.prompt && fallbackPrompt?.trim()) {
      recovered.prompt = fallbackPrompt.trim();
    }
    recovered.updatedAt = new Date().toISOString();
    try {
      writeProjectConfig(configPath, recovered);
      return { restored: true, config: recovered };
    } catch {
      return { restored: false, config: recovered };
    }
  }

  function readProjectConfig(path: string): any | null {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeProjectConfig(path: string, config: any) {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  function extractPromptSummary(prompt: string, maxChars = 160): string {
    const cleaned = prompt.replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
  }

  type SourceEntry = { path: string; name?: string; programs?: string[] };
  type AnalyzeMode = "fast" | "ai";

  type AnalyzeSourcePayload = {
    ok: true;
    program: string;
    sourcePath: string;
    createIfMissing: boolean;
    overwritePrompt: boolean;
    projects: Array<{
      projectPath: string;
      configPath: string;
      notesPath: string;
      existed: boolean;
      created: boolean;
      updated: boolean;
      promptPreview: string;
    }>;
    projectCount: number;
    existingConfigCount: number;
    createdCount: number;
    updatedCount: number;
    paths: string[];
    names: Record<string, string>;
    programs?: Record<string, string[]>;
    entries: SourceEntry[];
  };

  type AnalyzeJobStatus = "queued" | "running" | "completed" | "failed";
  type AnalyzeJob = {
    id: string;
    program: string;
    path: string;
    mode: AnalyzeMode;
    overwritePrompt: boolean;
    createIfMissing: boolean;
    status: AnalyzeJobStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    result?: AnalyzeSourcePayload;
  };

  const analyzeJobs = new Map<string, AnalyzeJob>();

  function broadcastAnalyzeJobUpdated(jobId: string) {
    const job = jobsRepo.getById(jobId);
    if (!job) return;
    hub.broadcastToType("client", {
      type: "job_updated",
      id: newId(),
      payload: { job },
    });
  }

  function appendAnalyzeLog(jobId: string, text: string) {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    jobsRepo.appendLog(jobId, line);
    hub.broadcastToType("client", {
      type: "job_log",
      id: newId(),
      payload: { jobId, text: line },
    });
  }

  function syncAnalyzeJobStatus(job: AnalyzeJob): AnalyzeJob {
    const globalJob = jobsRepo.getById(job.id);
    if (!globalJob) return job;

    if (globalJob.status === "completed") {
      job.status = "completed";
      job.completedAt = globalJob.completedAt;
      return job;
    }
    if (globalJob.status === "failed" || globalJob.status === "cancelled") {
      job.status = "failed";
      job.completedAt = globalJob.completedAt;
      if (!job.error) job.error = globalJob.error ?? (globalJob.status === "cancelled" ? "Cancelled" : undefined);
      return job;
    }
    if (globalJob.status === "running") {
      job.status = "running";
      job.startedAt = globalJob.startedAt ?? job.startedAt;
      return job;
    }
    if (globalJob.status === "queued") {
      job.status = "queued";
      return job;
    }
    return job;
  }

  function parsePlaybookSourceNames(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const key = String(k ?? "").trim();
        const value = String(v ?? "").trim();
        if (key && value) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  function serializePlaybookSourceNames(names: Record<string, string>): string {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(names)) {
      const key = String(k ?? "").trim();
      const value = String(v ?? "").trim();
      if (key && value) out[key] = value;
    }
    return JSON.stringify(out);
  }

  function getPlaybookSourceNames(): Record<string, string> {
    return parsePlaybookSourceNames(settingsRepo.get(SOURCE_NAMES_SETTING));
  }

  function setPlaybookSourceNames(names: Record<string, string>) {
    settingsRepo.set(SOURCE_NAMES_SETTING, serializePlaybookSourceNames(names));
  }

  function getPlaybookSourcePrograms(): Record<string, string[]> {
    return parseCoordinatorSourcePrograms(settingsRepo.get(SOURCE_PROGRAMS_SETTING));
  }

  function setPlaybookSourcePrograms(programs: Record<string, string[]>) {
    settingsRepo.set(SOURCE_PROGRAMS_SETTING, serializeCoordinatorSourcePrograms(programs));
  }

  function resolveSourcePrograms(path: string, programsByPath: Record<string, string[]>): string[] {
    const explicit = (programsByPath[path] ?? [])
      .map((p) => String(p ?? "").trim().toLowerCase())
      .filter(Boolean);
    if (explicit.length > 0) return [...new Set(explicit)];
    return inferCoordinatorSourceProgramsFromPath(path);
  }

  function getConfiguredAnalyzeAgentId(): string | null {
    const raw = String(settingsRepo.get(ANALYZE_AGENT_SETTING) ?? "").trim();
    return raw || null;
  }

  function resolveAnalyzeAgent() {
    const agents = agentsRepo.list();
    if (agents.length === 0) return null;
    const configuredId = getConfiguredAnalyzeAgentId();
    if (configuredId) {
      const configured = agents.find((a) => a.id === configuredId);
      if (configured) return configured;
    }
    return agents[0];
  }

  function buildSourceEntries(
    paths: string[],
    names: Record<string, string>,
    programsByPath: Record<string, string[]> = {},
  ): SourceEntry[] {
    return paths.map((path) => {
      const name = String(names[path] ?? "").trim();
      const programs = resolveSourcePrograms(path, programsByPath);
      if (name && programs.length > 0) return { path, name, programs };
      if (name) return { path, name };
      if (programs.length > 0) return { path, programs };
      return { path };
    });
  }

  function normalizeSourceEntriesPayload(body: any): { paths: string[]; names: Record<string, string> } | null {
    const existingNames = getPlaybookSourceNames();

    if (Array.isArray(body?.entries)) {
      const names: Record<string, string> = {};
      const paths = [
        ...new Set(
          body.entries
            .map((entry: any) => ({
              path: String(entry?.path ?? "").trim(),
              name: String(entry?.name ?? "").trim(),
            }))
            .filter((entry: { path: string; name: string }) => entry.path)
            .map((entry: { path: string; name: string }) => {
              if (entry.name) names[entry.path] = entry.name;
              return entry.path;
            }),
        ),
      ] as string[];
      return { paths, names };
    }

    if (Array.isArray(body?.paths) && !body.paths.some((p: unknown) => typeof p !== "string")) {
      const paths = [...new Set(body.paths.map((p: string) => p.trim()).filter(Boolean))] as string[];
      const names: Record<string, string> = {};
      for (const path of paths) {
        if (existingNames[path]) names[path] = existingNames[path];
      }
      if (body?.names && typeof body.names === "object" && !Array.isArray(body.names)) {
        for (const [k, v] of Object.entries(body.names as Record<string, unknown>)) {
          const key = String(k ?? "").trim();
          const value = String(v ?? "").trim();
          if (paths.includes(key) && value) names[key] = value;
        }
      }
      return { paths, names };
    }

    return null;
  }

  function performAnalyzeSource(
    user: { id: string; username: string },
    ipAddress: string | undefined,
    program: string,
    programDir: string,
    body: any,
    onLog?: (line: string) => void,
  ): AnalyzeSourcePayload {
    const path = String(body?.path ?? "").trim();
    const createIfMissing = body?.createIfMissing !== false;
    const overwritePrompt = !!body?.overwritePrompt;
    if (!path) {
      throw { status: 400, message: "path must be a non-empty string", code: "INVALID_INPUT" };
    }

    const sourcePath = resolveSourceFolder(programDir, path);
    if (!sourcePath) {
      throw { status: 400, message: "Invalid source path", code: "INVALID_INPUT" };
    }
    if (!existsSync(sourcePath)) {
      throw { status: 400, message: `Path does not exist: ${path}`, code: "INVALID_INPUT" };
    }
    let sourceStat;
    try {
      sourceStat = statSync(sourcePath);
    } catch {
      throw { status: 400, message: `Unable to read path: ${path}`, code: "INVALID_INPUT" };
    }
    if (!sourceStat.isDirectory()) {
      throw { status: 400, message: "path must be a folder", code: "INVALID_INPUT" };
    }

    const discovered = discoverProjectDirs(program, sourcePath, 4, 500);
    onLog?.(`Discovered ${discovered.length} candidate project folder(s) under ${sourcePath}`);
    const projects: AnalyzeSourcePayload["projects"] = [];

    let createdCount = 0;
    let updatedCount = 0;
    let existingConfigCount = 0;

    for (const projectPath of discovered) {
      onLog?.(`Analyzing project: ${projectPath}`);
      const configPath = resolveProjectConfigPath(projectPath);
      const notesPath = resolveProjectNotesPath(projectPath);
      const existed = existsSync(configPath);
      if (existed) existingConfigCount += 1;
      let created = false;
      let updated = false;
      let restoredFromNotes = false;

      let config = existed ? readProjectConfig(configPath) : null;

      const inventory = collectProjectInventory(projectPath, 5, 2400);
      const generatedPrompt = buildProjectPrompt(program, projectPath, inventory);

      if (!existed) {
        const restored = restoreProjectConfigFromNotes(program, projectPath, configPath, generatedPrompt);
        if (restored.config) config = restored.config;
        if (restored.restored) {
          restoredFromNotes = true;
          created = true;
          createdCount += 1;
          onLog?.(`Recovered ${PROJECT_CONFIG_FILE} from ${PROJECT_NOTES_FILE}: ${projectPath}`);
        }
      }

      config = normalizeProjectConfig(program, projectPath, config ?? {});

      if (!existed && !restoredFromNotes && createIfMissing) {
        config.prompt = generatedPrompt;
        config.updatedAt = new Date().toISOString();
        try {
          writeProjectConfig(configPath, config);
          created = true;
          createdCount += 1;
        } catch {
          // Keep preview even if file write fails.
        }
      } else if (existed && overwritePrompt) {
        config.prompt = generatedPrompt;
        config.updatedAt = new Date().toISOString();
        try {
          writeProjectConfig(configPath, config);
          updated = true;
          updatedCount += 1;
        } catch {
          // ignore write failure for partial result reporting
        }
      } else if (!config.prompt) {
        config.prompt = generatedPrompt;
      }

      try {
        writeFileSync(notesPath, buildProjectNotes(program, projectPath, config.prompt, inventory), "utf-8");
      } catch {
        // best effort companion notes file
      }

      projects.push({
        projectPath,
        configPath,
        notesPath,
        existed,
        created,
        updated,
        promptPreview: extractPromptSummary(config.prompt),
      });
      onLog?.(`Completed analysis: ${projectPath}`);
    }

    const existingSources = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_playbook_sources"));
    if (!existingSources.includes(sourcePath)) {
      existingSources.push(sourcePath);
      settingsRepo.set("coordinator_playbook_sources", serializeCoordinatorReferencePaths(existingSources));
    }
    const names = getPlaybookSourceNames();
    for (const key of Object.keys(names)) {
      if (!existingSources.includes(key)) delete names[key];
    }
    setPlaybookSourceNames(names);
    const programsByPath = getPlaybookSourcePrograms();
    const scoped = new Set(resolveSourcePrograms(sourcePath, programsByPath));
    scoped.add(program.toLowerCase());
    programsByPath[sourcePath] = [...scoped];
    for (const key of Object.keys(programsByPath)) {
      if (!existingSources.includes(key)) delete programsByPath[key];
    }
    setPlaybookSourcePrograms(programsByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_playbook_source_analyzed",
      resource: `coordinator_playbook:${program}`,
      details: JSON.stringify({
        path,
        sourcePath,
        createIfMissing,
        overwritePrompt,
        projects: projects.length,
        createdCount,
        updatedCount,
      }),
      ipAddress,
    });

    return {
      ok: true,
      program,
      sourcePath,
      createIfMissing,
      overwritePrompt,
      projects,
      projectCount: projects.length,
      existingConfigCount,
      createdCount,
      updatedCount,
      paths: existingSources,
      names,
      programs: programsByPath,
      entries: buildSourceEntries(existingSources, names, programsByPath),
    };
  }

  function buildAiAnalyzePrompt(
    program: string,
    sourcePath: string,
    createIfMissing: boolean,
    overwritePrompt: boolean,
  ): string {
    const overwriteRule = overwritePrompt
      ? "Overwrite existing prompt text in JSON config files."
      : "Preserve existing prompt text in JSON config files. Only create missing files.";
    const createRule = createIfMissing
      ? "Create missing coordinator JSON/MD files."
      : "Do not create missing coordinator JSON/MD files. Update existing files only.";

    const schemaSnippet = [
      "{",
      '  "version": 1,',
      `  "program": "${program}",`,
      '  "projectName": "string",',
      '  "projectPath": "absolute path",',
      '  "prompt": "detailed project guidance for future agents",',
      '  "updatedAt": "ISO datetime"',
      "}",
    ].join("\n");

    return [
      `Analyze source path for ${program}: ${sourcePath}`,
      "",
      "You are running in command mode and MUST execute through the target bridge for this program.",
      "Do not return only a report. Write/update files on disk.",
      "",
      "Required outputs per discovered project folder:",
      `1) ${PROJECT_CONFIG_FILE} (machine-readable JSON)`,
      `2) ${PROJECT_NOTES_FILE} (human-readable Markdown)`,
      "",
      "Rules:",
      `- ${createRule}`,
      `- ${overwriteRule}`,
      "- Notes file must be detailed and concrete, not generic boilerplate.",
      "- Notes must include: project purpose, inventory summary, key files, largest files, sample file paths, and practical usage guidance.",
      "- Base all content on actual files you inspect under the source path.",
      "",
      "JSON schema target:",
      "```json",
      schemaSnippet,
      "```",
      "",
      "Discovery guidelines:",
      "- Houdini: folders containing .hip/.hiplc/.hipnc",
      "- Blender: folders containing .blend",
      "- Godot: folders containing project.godot",
      "- Unity: folders containing Assets + ProjectSettings",
      "- Unreal: folders containing .uproject",
      "- ComfyUI: folders containing workflow_api.json",
      "",
      "At the end, print a concise summary with counts: discovered, created, updated, skipped.",
    ].join("\n");
  }

  function collectAnalyzeResultFromExisting(
    user: { id: string; username: string },
    ipAddress: string | undefined,
    program: string,
    programDir: string,
    body: any,
  ): AnalyzeSourcePayload {
    const path = String(body?.path ?? "").trim();
    if (!path) {
      throw { status: 400, message: "path must be a non-empty string", code: "INVALID_INPUT" };
    }
    const sourcePath = resolveSourceFolder(programDir, path);
    if (!sourcePath) {
      throw { status: 400, message: "Invalid source path", code: "INVALID_INPUT" };
    }
    if (!existsSync(sourcePath)) {
      throw { status: 400, message: `Path does not exist: ${path}`, code: "INVALID_INPUT" };
    }
    let sourceStat;
    try {
      sourceStat = statSync(sourcePath);
    } catch {
      throw { status: 400, message: `Unable to read path: ${path}`, code: "INVALID_INPUT" };
    }
    if (!sourceStat.isDirectory()) {
      throw { status: 400, message: "path must be a folder", code: "INVALID_INPUT" };
    }

    const discovered = discoverProjectDirs(program, sourcePath, 4, 500);
    const projects: AnalyzeSourcePayload["projects"] = [];
    let existingConfigCount = 0;
    let createdCount = 0;

    for (const projectPath of discovered) {
      const configPath = resolveProjectConfigPath(projectPath);
      const notesPath = resolveProjectNotesPath(projectPath);
      const existed = existsSync(configPath);
      if (existed) existingConfigCount += 1;
      let created = false;
      let parsed = existed ? readProjectConfig(configPath) : null;
      if (!existed) {
        const restored = restoreProjectConfigFromNotes(program, projectPath, configPath);
        if (restored.config) parsed = restored.config;
        if (restored.restored) {
          created = true;
          createdCount += 1;
        }
      }
      const normalized = normalizeProjectConfig(program, projectPath, parsed ?? {});
      projects.push({
        projectPath,
        configPath,
        notesPath,
        existed,
        created,
        updated: false,
        promptPreview: extractPromptSummary(normalized.prompt),
      });
    }

    const existingSources = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_playbook_sources"));
    if (!existingSources.includes(sourcePath)) {
      existingSources.push(sourcePath);
      settingsRepo.set("coordinator_playbook_sources", serializeCoordinatorReferencePaths(existingSources));
    }
    const names = getPlaybookSourceNames();
    for (const key of Object.keys(names)) {
      if (!existingSources.includes(key)) delete names[key];
    }
    setPlaybookSourceNames(names);
    const programsByPath = getPlaybookSourcePrograms();
    const scoped = new Set(resolveSourcePrograms(sourcePath, programsByPath));
    scoped.add(program.toLowerCase());
    programsByPath[sourcePath] = [...scoped];
    for (const key of Object.keys(programsByPath)) {
      if (!existingSources.includes(key)) delete programsByPath[key];
    }
    setPlaybookSourcePrograms(programsByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_playbook_source_ai_collected",
      resource: `coordinator_playbook:${program}`,
      details: JSON.stringify({
        path,
        sourcePath,
        projects: projects.length,
        existingConfigCount,
      }),
      ipAddress,
    });

    return {
      ok: true,
      program,
      sourcePath,
      createIfMissing: false,
      overwritePrompt: false,
      projects,
      projectCount: projects.length,
      existingConfigCount,
      createdCount,
      updatedCount: 0,
      paths: existingSources,
      names,
      programs: programsByPath,
      entries: buildSourceEntries(existingSources, names, programsByPath),
    };
  }

  function cleanupAnalyzeJobs(maxJobs = 250) {
    if (analyzeJobs.size <= maxJobs) return;
    const sorted = [...analyzeJobs.values()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const removeCount = Math.max(0, sorted.length - maxJobs);
    for (let i = 0; i < removeCount; i++) {
      analyzeJobs.delete(sorted[i].id);
    }
  }


  router.get("/coordinator-training-schedule", (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const schedule = getCoordinatorTrainingSchedule(settingsRepo, programDiscoveryDeps);
    const lastRunByProgram = getCoordinatorTrainingLastRunByProgram(settingsRepo);
    const nextRunByProgram = computeCoordinatorTrainingNextRunByProgram(schedule, lastRunByProgram);
    return c.json({
      ok: true,
      schedule,
      lastRunByProgram,
      nextRunByProgram,
      knownPrograms: getCoordinatorScriptPrograms(programDiscoveryDeps),
    });
  });

  router.put("/coordinator-training-schedule", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const current = getCoordinatorTrainingSchedule(settingsRepo, programDiscoveryDeps);
    const next = {
      enabled: typeof body?.enabled === "boolean" ? body.enabled : current.enabled,
      intervalMinutes: body?.intervalMinutes == null ? current.intervalMinutes : Number(body.intervalMinutes),
      apply: typeof body?.apply === "boolean" ? body.apply : current.apply,
      programs: Array.isArray(body?.programs)
        ? body.programs.map((p: unknown) => String(p ?? "").trim().toLowerCase()).filter(Boolean)
        : current.programs,
    };
    if (!Number.isFinite(next.intervalMinutes)) {
      return errorResponse(c, 400, "intervalMinutes must be a number", "INVALID_INPUT");
    }

    setCoordinatorTrainingSchedule(settingsRepo, next, programDiscoveryDeps);
    const schedule = getCoordinatorTrainingSchedule(settingsRepo, programDiscoveryDeps);
    const lastRunByProgram = getCoordinatorTrainingLastRunByProgram(settingsRepo);
    const nextRunByProgram = computeCoordinatorTrainingNextRunByProgram(schedule, lastRunByProgram);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_schedule_updated",
      resource: "settings",
      details: JSON.stringify({ schedule }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, schedule, lastRunByProgram, nextRunByProgram });
  });

  // Manually run scheduled coordinator training now for one or more programs.
  router.post("/coordinator-training/run-now", async (c) => {
    const user = requireAdmin(c, usersRepo);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // optional body
    }

    const schedule = getCoordinatorTrainingSchedule(settingsRepo, programDiscoveryDeps);
    const requestedPrograms = Array.isArray(body?.programs)
      ? body.programs.map((p: unknown) => String(p ?? "").trim().toLowerCase()).filter(Boolean)
      : [];
    const requestedSourcePaths = Array.isArray(body?.sourcePaths)
      ? body.sourcePaths.map((p: unknown) => String(p ?? "").trim()).filter(Boolean)
      : [];
    const apply = body?.apply == null ? schedule.apply : body.apply !== false;
    const trainingPrompt = String(body?.prompt ?? "").trim();
    const targetWorkerName = String(body?.targetWorkerName ?? "").trim();
    const trainingLevel = String(body?.trainingLevel ?? "").trim();

    // Build housekeeping deps for orchestrator chaining
    const housekeepingDeps: HousekeepingDeps | undefined = skillsRepo
      ? { jobsRepo, skillsRepo, agentsRepo, settingsRepo, hub }
      : undefined;

    // Use queueTrainingOrchestrator — creates a single parent job that
    // fans out per-program training and optionally chains housekeeping.
    let orchestratorJob: import("@arkestrator/protocol").Job;
    try {
      orchestratorJob = queueTrainingOrchestrator(
        {
          jobsRepo,
          agentsRepo,
          settingsRepo,
          skillsRepo,
          headlessProgramsRepo,
          hub,
          coordinatorScriptsDir,
          coordinatorPlaybooksDir,
          defaultCoordinatorPlaybookSourcePaths,
          processTracker,
          housekeepingDeps,
        },
        {
          programs: requestedPrograms.length > 0 ? requestedPrograms : undefined,
          trigger: "manual",
          apply,
          sourcePaths: requestedSourcePaths.length > 0 ? requestedSourcePaths : undefined,
          trainingPrompt: trainingPrompt || undefined,
          targetWorkerName: targetWorkerName || undefined,
          trainingLevel: trainingLevel || undefined,
          submittedBy: user.id,
          chainHousekeeping: true,
        },
      );
    } catch (err: any) {
      return errorResponse(c, 400, String(err?.message ?? err), "INVALID_INPUT");
    }

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_run_now",
      resource: "settings",
      details: JSON.stringify({
        orchestratorJobId: orchestratorJob.id,
        autoDetected: requestedPrograms.length === 0,
        apply,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({ ok: true, apply, orchestratorJobId: orchestratorJob.id, job: orchestratorJob });
  });

  // List normalized training-job summaries from vault artifacts so admin UI can
  // inspect user/machine/bridge/model/transport details and export by filters.
  router.get("/coordinator-training-jobs", (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const filters = normalizeTrainingJobFilters({
      program: c.req.query("program"),
      programs: c.req.query("programs"),
      jobId: c.req.query("jobId"),
      q: c.req.query("q"),
      signal: c.req.query("signal"),
      transport: c.req.query("transport"),
      dateFrom: c.req.query("dateFrom"),
      dateTo: c.req.query("dateTo"),
      limit: c.req.query("limit"),
    });

    const summaryMap = buildTrainingJobSummaryMap(Math.max(filters.limit * 4, 2000));
    const all = [...summaryMap.values()];
    const matched = all
      .filter((item) => trainingJobMatchesFilters(item, filters))
      .sort((a, b) => {
        const aTs = Date.parse(a.completedAt || a.storedAt || a.createdAt || "") || 0;
        const bTs = Date.parse(b.completedAt || b.storedAt || b.createdAt || "") || 0;
        if (bTs !== aTs) return bTs - aTs;
        return a.jobId.localeCompare(b.jobId);
      });

    const items = matched.slice(0, filters.limit);
    return c.json({
      filters,
      totalArtifacts: all.length,
      matched: matched.length,
      returned: items.length,
      items,
    });
  });

  // Export training-job summaries by selected scope/filters.
  router.post("/coordinator-training-jobs/export", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const scope = String(body?.scope ?? "filtered").trim().toLowerCase();
    const requestedFilters = normalizeTrainingJobFilters({
      program: body?.program,
      programs: body?.programs,
      jobId: body?.jobId,
      q: body?.q,
      signal: body?.signal,
      transport: body?.transport,
      dateFrom: body?.dateFrom,
      dateTo: body?.dateTo,
      limit: body?.limit ?? 20_000,
    });

    const filters: TrainingJobQueryFilters = { ...requestedFilters };
    if (scope === "all") {
      filters.programs = [];
      filters.jobId = null;
      filters.q = null;
      filters.signal = null;
      filters.transport = null;
      filters.dateFrom = null;
      filters.dateTo = null;
    } else if (scope === "program") {
      if (filters.programs.length === 0) {
        return errorResponse(c, 400, "program/programs filter is required for scope=program", "INVALID_INPUT");
      }
      filters.jobId = null;
      filters.q = null;
    } else if (scope === "job") {
      if (!filters.jobId) {
        return errorResponse(c, 400, "jobId is required for scope=job", "INVALID_INPUT");
      }
      filters.q = null;
      filters.signal = null;
      filters.transport = null;
      filters.dateFrom = null;
      filters.dateTo = null;
    } else if (scope !== "filtered") {
      return errorResponse(c, 400, "scope must be one of: all, filtered, program, job", "INVALID_INPUT");
    }

    const summaryMap = buildTrainingJobSummaryMap(Math.max(filters.limit * 4, 2000));
    const matched = [...summaryMap.values()]
      .filter((item) => trainingJobMatchesFilters(item, filters))
      .sort((a, b) => {
        const aTs = Date.parse(a.completedAt || a.storedAt || a.createdAt || "") || 0;
        const bTs = Date.parse(b.completedAt || b.storedAt || b.createdAt || "") || 0;
        if (bTs !== aTs) return bTs - aTs;
        return a.jobId.localeCompare(b.jobId);
      })
      .slice(0, filters.limit);

    const countsByProgram: Record<string, number> = {};
    const countsBySignal: Record<string, number> = {};
    const countsByTransport: Record<string, number> = {};
    for (const item of matched) {
      countsByProgram[item.program] = (countsByProgram[item.program] ?? 0) + 1;
      countsBySignal[item.signal] = (countsBySignal[item.signal] ?? 0) + 1;
      countsByTransport[item.transport] = (countsByTransport[item.transport] ?? 0) + 1;
    }

    const generatedAt = new Date().toISOString();
    const exportPayload = {
      format: "arkestrator-training-jobs-export",
      schemaVersion: 1,
      generatedAt,
      generatedBy: {
        id: user.id,
        username: user.username,
      },
      scope,
      filters,
      summary: {
        total: matched.length,
        countsByProgram,
        countsBySignal,
        countsByTransport,
      },
      items: matched,
    };

    const stamp = generatedAt.replace(/[:.]/g, "-");
    const suggestedFileName = `arkestrator-training-jobs-${scope}-${stamp}.json`;

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_jobs_exported",
      resource: "coordinator_training_jobs",
      details: JSON.stringify({
        scope,
        total: matched.length,
        programs: filters.programs,
        signal: filters.signal,
        transport: filters.transport,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({
      ok: true,
      suggestedFileName,
      export: exportPayload,
    });
  });

  // Export training data as a portable zip bundle (job/program/filtered/all/selected jobs).
  router.post("/coordinator-training-files/export", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const selection = resolveTrainingDataExportSelection({
      scope: body?.scope,
      program: body?.program,
      programs: body?.programs,
      jobId: body?.jobId,
      jobIds: body?.jobIds,
      q: body?.q,
      signal: body?.signal,
      transport: body?.transport,
      dateFrom: body?.dateFrom,
      dateTo: body?.dateTo,
      limit: body?.limit ?? 20_000,
    });
    if (selection.error) {
      return errorResponse(c, 400, selection.error, "INVALID_INPUT");
    }

    const allFiles = listAllTrainingVaultFiles(Math.max(selection.filters.limit * 8, 4000));
    const exportFiles = collectTrainingVaultExportFiles(selection.scope, selection.matched, allFiles);

    if (exportFiles.length === 0) {
      return errorResponse(c, 404, "No training data matched the requested export scope", "NOT_FOUND");
    }

    const filePathSet = new Set<string>(exportFiles.map((item) => item.path));
    const metadataForExport = filterTrainingMetadataForExportPaths(getTrainingVaultMetadataMap(), filePathSet);

    const generatedAt = new Date().toISOString();
    const manifest = {
      format: "arkestrator-training-export",
      schemaVersion: 1,
      generatedAt,
      generatedBy: {
        id: user.id,
        username: user.username,
      },
      scope: selection.scope,
      filters: selection.filters,
      selectedJobIds: selection.selectedJobIds,
      jobs: selection.matched.map((job) => ({
        jobId: job.jobId,
        name: job.name,
        program: job.program,
        signal: job.signal,
        transport: job.transport,
        artifactCount: job.artifactCount,
        artifactPaths: job.artifactPaths,
      })),
      summary: {
        fileCount: exportFiles.length,
        metadataCount: metadataForExport.length,
        totalBytes: exportFiles.reduce((sum, item) => sum + Math.max(0, item.bytes), 0),
      },
    };

    const zipEntries: Record<string, Uint8Array> = {
      "training/.arkestrator-training-export.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    };
    if (metadataForExport.length > 0) {
      zipEntries["training/.arkestrator-training-metadata.json"] = strToU8(
        `${JSON.stringify(metadataForExport, null, 2)}\n`,
      );
    }

    let readFailures = 0;
    for (const file of exportFiles) {
      try {
        const bytes = readFileSync(file.fullPath);
        zipEntries[`training/${file.path}`] = bytes;
      } catch {
        readFailures += 1;
      }
    }

    const zipPayload = zipSync(zipEntries, { level: 6 });
    const stamp = generatedAt.replace(/[:.]/g, "-");
    const fileName = `arkestrator-training-${selection.scope}-${stamp}.zip`;

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_files_exported",
      resource: "coordinator_training_files",
      details: JSON.stringify({
        scope: selection.scope,
        fileCount: exportFiles.length,
        metadataCount: metadataForExport.length,
        readFailures,
        selectedJobIds: selection.selectedJobIds,
      }),
      ipAddress: getClientIp(c),
    });

    return new Response(Buffer.from(zipPayload), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  // Import training data from a zip bundle into training/ roots.
  router.post("/coordinator-training-files/import", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return errorResponse(c, 400, "Expected multipart form-data upload", "INVALID_INPUT");
    }

    const uploaded = form.get("file");
    if (!(uploaded instanceof File)) {
      return errorResponse(c, 400, "file upload is required", "INVALID_INPUT");
    }

    const data = new Uint8Array(await uploaded.arrayBuffer());
    if (data.byteLength > MAX_TRAINING_UPLOAD_TOTAL_BYTES) {
      return errorResponse(c, 400, "Uploaded archive exceeds size limit", "INVALID_INPUT");
    }

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data);
    } catch {
      return errorResponse(c, 400, "Invalid zip archive", "INVALID_INPUT");
    }

    const ipAddress = getClientIp(c);
    const importedMetadataByPath: Record<string, TrainingVaultMetadata> = {};
    const writtenPaths = new Set<string>();
    let writtenCount = 0;
    let skippedCount = 0;
    let extractedBytes = 0;
    let extractedEntries = 0;

    for (const [entryPathRaw, entryData] of Object.entries(entries)) {
      const entryPath = normalizeZipEntryPath(entryPathRaw);
      if (!entryPath) continue;

      extractedEntries += 1;
      extractedBytes += entryData.byteLength;
      if (extractedEntries > MAX_TRAINING_UPLOAD_EXTRACTED_ENTRIES) {
        return errorResponse(c, 400, "Archive extraction exceeds entry limit", "INVALID_INPUT");
      }
      if (extractedBytes > MAX_TRAINING_UPLOAD_EXTRACTED_BYTES) {
        return errorResponse(c, 400, "Archive extraction exceeds size limit", "INVALID_INPUT");
      }
      if (entryData.byteLength > MAX_TRAINING_UPLOAD_FILE_BYTES) {
        return errorResponse(c, 400, `Archive entry exceeds file-size limit (${entryPath})`, "INVALID_INPUT");
      }

      const withoutTraining = entryPath.toLowerCase().startsWith("training/")
        ? entryPath.slice("training/".length)
        : entryPath;
      const manifestName = withoutTraining.trim().toLowerCase();
      if (manifestName === ".arkestrator-training-metadata.json") {
        try {
          const raw = Buffer.from(entryData).toString("utf-8");
          const parsedMap = parseTrainingVaultMetadataMap(raw);
          for (const [path, metadata] of Object.entries(parsedMap)) {
            const normalized = normalizeTrainingVaultMetadataRecord(metadata);
            if (!normalized) continue;
            importedMetadataByPath[path] = normalized;
          }
        } catch {
          // Ignore malformed metadata payloads; files can still be imported.
        }
        continue;
      }
      if (manifestName === ".arkestrator-training-export.json") continue;

      const normalizedVaultPath = normalizeTrainingVaultMetadataPath(withoutTraining);
      if (!normalizedVaultPath) {
        skippedCount += 1;
        continue;
      }
      if (!/^(scripts|playbooks|learning|imports)\//.test(normalizedVaultPath)) {
        skippedCount += 1;
        continue;
      }

      const resolved = resolveTrainingVaultPath(normalizedVaultPath);
      if (!resolved || !resolved.relPath) {
        skippedCount += 1;
        continue;
      }

      try {
        mkdirSync(dirname(resolved.fullPath), { recursive: true });
        writeFileSync(resolved.fullPath, Buffer.from(entryData));
        writtenCount += 1;
        writtenPaths.add(`${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/"));
      } catch {
        skippedCount += 1;
      }
    }

    const metadataByPath = getTrainingVaultMetadataMap();
    for (const writtenPath of writtenPaths) {
      const imported = importedMetadataByPath[writtenPath];
      const next = upsertTrainingVaultMetadata(metadataByPath, {
        path: writtenPath,
        kind: "file",
        user,
        ipAddress,
        projectPaths: imported?.projectPaths,
        sourcePaths: imported?.sourcePaths,
        remarks: imported?.remarks ?? null,
      });
      if (next && imported) {
        next.createdAt = imported.createdAt || next.createdAt;
        next.createdBy = normalizeTrainingVaultMetadataActor(imported.createdBy);
      }
    }
    for (const [path, metadata] of Object.entries(importedMetadataByPath)) {
      if (writtenPaths.has(path)) continue;
      const resolved = resolveTrainingVaultPath(path);
      if (!resolved || !existsSync(resolved.fullPath)) continue;
      let st;
      try {
        st = statSync(resolved.fullPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const next = upsertTrainingVaultMetadata(metadataByPath, {
        path,
        kind: "directory",
        user,
        ipAddress,
        projectPaths: metadata.projectPaths,
        sourcePaths: metadata.sourcePaths,
        remarks: metadata.remarks,
      });
      if (!next) continue;
      next.createdAt = metadata.createdAt || next.createdAt;
      next.createdBy = normalizeTrainingVaultMetadataActor(metadata.createdBy);
    }
    setTrainingVaultMetadataMap(metadataByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_files_imported",
      resource: "coordinator_training_files",
      details: JSON.stringify({
        fileName: uploaded.name || null,
        writtenCount,
        skippedCount,
        metadataCount: Object.keys(importedMetadataByPath).length,
      }),
      ipAddress,
    });

    return c.json({
      ok: true,
      summary: {
        writtenCount,
        skippedCount,
        metadataImportedCount: Object.keys(importedMetadataByPath).length,
      },
    });
  });

  // List the global coordinator training vault (scripts/playbooks/learning)
  // as one logical folder tree for admin exploration.
  router.get("/coordinator-training-files", (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const queryLimit = Number(c.req.query("limit"));
    const perRootLimit = Number.isFinite(queryLimit)
      ? Math.max(100, Math.min(8000, Math.round(queryLimit)))
      : 3000;

    const roots = getCoordinatorFileRoots();
    const metadataByPath = getTrainingVaultMetadataMap();
    const entries: Array<{
      path: string;
      kind: "file" | "directory";
      bytes: number;
      updatedAt: string | null;
      root: CoordinatorFileRootKey;
      rootLabel: string;
      isRoot: boolean;
      program: string | null;
      metadata: TrainingVaultMetadata | null;
    }> = [];

    for (const root of roots) {
      let rootUpdatedAt: string | null = null;
      let canScan = false;
      if (existsSync(root.baseDir)) {
        try {
          const st = statSync(root.baseDir);
          if (st.isDirectory()) {
            canScan = true;
            rootUpdatedAt = new Date(st.mtimeMs || Date.now()).toISOString();
          }
        } catch {
          canScan = false;
        }
      }

      entries.push({
        path: root.key,
        kind: "directory",
        bytes: 0,
        updatedAt: rootUpdatedAt,
        root: root.key,
        rootLabel: root.label,
        isRoot: true,
        program: null,
        metadata: metadataByPath[root.key] ?? null,
      });

      if (!canScan) continue;

      const scanned = listCoordinatorEntriesRecursive(root.baseDir, perRootLimit);
      for (const item of scanned) {
        entries.push({
          path: `${root.key}/${item.path}`,
          kind: item.kind,
          bytes: item.bytes,
          updatedAt: item.updatedAt,
          root: root.key,
          rootLabel: root.label,
          isRoot: false,
          program: inferTrainingVaultProgram(root.key, item.path),
          metadata: metadataByPath[`${root.key}/${item.path}`.replace(/\\/g, "/")] ?? null,
        });
      }
    }

    return c.json({
      baseFolder: "training",
      subfolders: roots.map((root) => ({
        name: root.key,
        label: root.label,
        sourcePath: root.baseDir,
      })),
      entries,
    });
  });

  // Read one file inside the global coordinator training vault.
  router.get("/coordinator-training-files/content", (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const inputPath = String(c.req.query("path") ?? "").trim();
    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved || !resolved.relPath) {
      return errorResponse(c, 400, "Invalid training file path", "INVALID_INPUT");
    }
    if (!existsSync(resolved.fullPath)) {
      return errorResponse(c, 404, "Training file not found", "NOT_FOUND");
    }

    let st;
    try {
      st = statSync(resolved.fullPath);
    } catch {
      return errorResponse(c, 400, "Unable to stat training file", "INVALID_INPUT");
    }
    if (!st.isFile()) {
      return errorResponse(c, 400, "Path does not point to a file", "INVALID_INPUT");
    }
    if (st.size > MAX_COORDINATOR_FILE_READ_BYTES) {
      return errorResponse(c, 400, "Training file is too large to read in editor", "INVALID_INPUT");
    }

    try {
      const content = readFileSync(resolved.fullPath, "utf-8");
      const path = `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/");
      const metadata = getTrainingVaultMetadataMap()[path] ?? null;
      return c.json({
        path,
        root: resolved.root.key,
        bytes: st.size,
        updatedAt: new Date(st.mtimeMs || Date.now()).toISOString(),
        content,
        metadata,
      });
    } catch (err) {
      return errorResponse(c, 500, `Failed to read training file: ${err}`, "INTERNAL_ERROR");
    }
  });

  // Create/update one file inside the global coordinator training vault.
  router.put("/coordinator-training-files/content", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const inputPath = String(body?.path ?? "").trim();
    const content = body?.content;
    if (typeof content !== "string") {
      return errorResponse(c, 400, "content must be a string", "INVALID_INPUT");
    }
    const providedProjectPaths = Array.isArray(body?.projectPaths)
      ? body.projectPaths.map((item: unknown) => String(item ?? ""))
      : undefined;
    const providedSourcePaths = Array.isArray(body?.sourcePaths)
      ? body.sourcePaths.map((item: unknown) => String(item ?? ""))
      : undefined;
    const providedRemarks = typeof body?.remarks === "string" || body?.remarks === null
      ? body.remarks
      : undefined;

    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved || !resolved.relPath) {
      return errorResponse(c, 400, "Invalid training file path", "INVALID_INPUT");
    }

    try {
      mkdirSync(dirname(resolved.fullPath), { recursive: true });
      writeFileSync(resolved.fullPath, content, "utf-8");
    } catch (err) {
      return errorResponse(c, 500, `Failed to write training file: ${err}`, "WRITE_ERROR");
    }

    const path = `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/");
    const ipAddress = getClientIp(c);
    let metadata: TrainingVaultMetadata | null = null;
    const metadataByPath = getTrainingVaultMetadataMap();
    metadata = upsertTrainingVaultMetadata(metadataByPath, {
      path,
      kind: "file",
      user,
      ipAddress,
      projectPaths: providedProjectPaths,
      sourcePaths: providedSourcePaths,
      remarks: providedRemarks,
    });
    setTrainingVaultMetadataMap(metadataByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_file_saved",
      resource: `coordinator_training:${path}`,
      ipAddress,
    });

    return c.json({ ok: true, path, root: resolved.root.key, metadata });
  });

  // Create a folder inside the global coordinator training vault.
  router.post("/coordinator-training-files/folders", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const inputPath = String(body?.path ?? "").trim();
    const providedProjectPaths = Array.isArray(body?.projectPaths)
      ? body.projectPaths.map((item: unknown) => String(item ?? ""))
      : undefined;
    const providedSourcePaths = Array.isArray(body?.sourcePaths)
      ? body.sourcePaths.map((item: unknown) => String(item ?? ""))
      : undefined;
    const providedRemarks = typeof body?.remarks === "string" || body?.remarks === null
      ? body.remarks
      : undefined;
    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved || !resolved.relPath || isRootPath(resolved.relPath)) {
      return errorResponse(c, 400, "Invalid training folder path", "INVALID_INPUT");
    }

    try {
      mkdirSync(resolved.fullPath, { recursive: true });
    } catch (err) {
      return errorResponse(c, 500, `Failed to create training folder: ${err}`, "WRITE_ERROR");
    }

    const path = `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/");
    const ipAddress = getClientIp(c);
    const metadataByPath = getTrainingVaultMetadataMap();
    const metadata = upsertTrainingVaultMetadata(metadataByPath, {
      path,
      kind: "directory",
      user,
      ipAddress,
      projectPaths: providedProjectPaths,
      sourcePaths: providedSourcePaths,
      remarks: providedRemarks,
    });
    setTrainingVaultMetadataMap(metadataByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_folder_created",
      resource: `coordinator_training:${path}`,
      ipAddress,
    });

    return c.json({ ok: true, path, root: resolved.root.key, metadata });
  });

  // Update metadata for one training-vault file/folder.
  router.put("/coordinator-training-files/metadata", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const inputPath = String(body?.path ?? "").trim();
    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved) {
      return errorResponse(c, 400, "Invalid training vault path", "INVALID_INPUT");
    }
    if (!existsSync(resolved.fullPath)) {
      return errorResponse(c, 404, "Training vault path not found", "NOT_FOUND");
    }

    let st;
    try {
      st = statSync(resolved.fullPath);
    } catch {
      return errorResponse(c, 400, "Unable to stat training vault path", "INVALID_INPUT");
    }
    const kind: "file" | "directory" = st.isDirectory() ? "directory" : "file";
    if (!st.isDirectory() && !st.isFile()) {
      return errorResponse(c, 400, "Path must be a file or folder", "INVALID_INPUT");
    }

    const hasProjectPaths = Array.isArray(body?.projectPaths);
    const hasSourcePaths = Array.isArray(body?.sourcePaths);
    const hasRemarks = typeof body?.remarks === "string" || body?.remarks === null;
    if (!hasProjectPaths && !hasSourcePaths && !hasRemarks) {
      return errorResponse(
        c,
        400,
        "At least one of projectPaths, sourcePaths, or remarks must be provided",
        "INVALID_INPUT",
      );
    }

    const path = resolved.relPath
      ? `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/")
      : resolved.root.key;
    const ipAddress = getClientIp(c);
    const metadataByPath = getTrainingVaultMetadataMap();
    const metadata = upsertTrainingVaultMetadata(metadataByPath, {
      path,
      kind,
      user,
      ipAddress,
      projectPaths: hasProjectPaths ? body.projectPaths.map((item: unknown) => String(item ?? "")) : undefined,
      sourcePaths: hasSourcePaths ? body.sourcePaths.map((item: unknown) => String(item ?? "")) : undefined,
      remarks: hasRemarks ? body.remarks : undefined,
    });
    setTrainingVaultMetadataMap(metadataByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_metadata_saved",
      resource: `coordinator_training:${path}`,
      details: JSON.stringify({
        kind,
        projectPaths: metadata?.projectPaths ?? [],
        sourcePaths: metadata?.sourcePaths ?? [],
      }),
      ipAddress,
    });

    return c.json({
      ok: true,
      path,
      root: resolved.root.key,
      metadata,
    });
  });

  // Delete one file inside the global coordinator training vault.
  router.delete("/coordinator-training-files/content", (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const inputPath = String(c.req.query("path") ?? "").trim();
    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved || !resolved.relPath) {
      return errorResponse(c, 400, "Invalid training file path", "INVALID_INPUT");
    }
    if (!existsSync(resolved.fullPath)) {
      return errorResponse(c, 404, "Training file not found", "NOT_FOUND");
    }

    let st;
    try {
      st = statSync(resolved.fullPath);
    } catch {
      return errorResponse(c, 400, "Unable to stat training file", "INVALID_INPUT");
    }
    if (!st.isFile()) {
      return errorResponse(c, 400, "Path does not point to a file", "INVALID_INPUT");
    }

    try {
      rmSync(resolved.fullPath, { force: true });
    } catch (err) {
      return errorResponse(c, 500, `Failed to delete training file: ${err}`, "WRITE_ERROR");
    }

    const path = `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/");
    const metadataByPath = getTrainingVaultMetadataMap();
    pruneTrainingVaultMetadataPath(metadataByPath, path, false);
    setTrainingVaultMetadataMap(metadataByPath);
    const ipAddress = getClientIp(c);
    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_file_deleted",
      resource: `coordinator_training:${path}`,
      ipAddress,
    });

    return c.json({ ok: true, path, root: resolved.root.key });
  });

  // Delete one folder inside the global coordinator training vault.
  router.delete("/coordinator-training-files/folders", (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const inputPath = String(c.req.query("path") ?? "").trim();
    const resolved = resolveTrainingVaultPath(inputPath);
    if (!resolved || !resolved.relPath || isRootPath(resolved.relPath)) {
      return errorResponse(c, 400, "Invalid training folder path", "INVALID_INPUT");
    }
    if (!existsSync(resolved.fullPath)) {
      return errorResponse(c, 404, "Training folder not found", "NOT_FOUND");
    }

    let st;
    try {
      st = statSync(resolved.fullPath);
    } catch {
      return errorResponse(c, 400, "Unable to stat training folder", "INVALID_INPUT");
    }
    if (!st.isDirectory()) {
      return errorResponse(c, 400, "Path does not point to a folder", "INVALID_INPUT");
    }

    try {
      rmSync(resolved.fullPath, { recursive: true, force: true });
    } catch (err) {
      return errorResponse(c, 500, `Failed to delete training folder: ${err}`, "WRITE_ERROR");
    }

    const path = `${resolved.root.key}/${resolved.relPath}`.replace(/\\/g, "/");
    const metadataByPath = getTrainingVaultMetadataMap();
    pruneTrainingVaultMetadataPath(metadataByPath, path, true);
    setTrainingVaultMetadataMap(metadataByPath);
    const ipAddress = getClientIp(c);
    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_folder_deleted",
      resource: `coordinator_training:${path}`,
      ipAddress,
    });

    return c.json({ ok: true, path, root: resolved.root.key });
  });

  router.post("/coordinator-training-files/cleanup", async (c) => {
    const user = requireCoordinatorEditor(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
    }

    const dryRun = body?.dryRun !== false;
    const rootFilter = String(body?.root ?? "").trim().toLowerCase();
    const programFilter = String(body?.program ?? "").trim().toLowerCase();
    const jobIdFilter = String(body?.jobId ?? "").trim();
    const projectPathFilter = String(body?.projectPath ?? "").trim();

    const roots = getCoordinatorFileRoots().filter((root) => !rootFilter || root.key === rootFilter);
    if (rootFilter && roots.length === 0) {
      return errorResponse(c, 400, "Invalid cleanup root", "INVALID_INPUT");
    }

    const metadataByPath = getTrainingVaultMetadataMap();
    const matchedPaths = new Set<string>();
    const candidates: Array<{
      path: string;
      kind: "file" | "directory";
      root: CoordinatorFileRootKey;
      program: string | null;
      bytes: number;
      metadata: TrainingVaultMetadata | null;
    }> = [];

    for (const root of roots) {
      if (!existsSync(root.baseDir)) continue;
      for (const item of listCoordinatorEntriesRecursive(root.baseDir, 8000)) {
        const vaultPath = `${root.key}/${item.path}`.replace(/\\/g, "/");
        const metadata = metadataByPath[vaultPath] ?? null;
        const program = inferTrainingVaultProgram(root.key, item.path);
        if (programFilter && program !== programFilter) continue;
        if (jobIdFilter && !vaultPath.includes(`/${jobIdFilter}/`)) continue;
        if (projectPathFilter) {
          const metadataProjects = metadata?.projectPaths ?? [];
          if (!metadataProjects.includes(projectPathFilter)) continue;
        }
        matchedPaths.add(vaultPath);
        candidates.push({
          path: vaultPath,
          kind: item.kind,
          root: root.key,
          program,
          bytes: item.bytes,
          metadata,
        });
      }
    }

    candidates.sort((a, b) => a.path.localeCompare(b.path));

    if (dryRun) {
      return c.json({
        ok: true,
        dryRun: true,
        matchedCount: candidates.length,
        totalBytes: candidates.reduce((sum, item) => sum + Math.max(0, item.bytes), 0),
        candidates,
      });
    }

    let deletedCount = 0;
    let deletedBytes = 0;
    const deletedPaths: string[] = [];
    for (const candidate of [...candidates].sort((a, b) => b.path.localeCompare(a.path))) {
      const resolved = resolveTrainingVaultPath(candidate.path);
      if (!resolved || !resolved.relPath || !existsSync(resolved.fullPath)) continue;
      try {
        rmSync(resolved.fullPath, { recursive: candidate.kind === "directory", force: true });
        deletedCount += 1;
        deletedBytes += Math.max(0, candidate.bytes);
        deletedPaths.push(candidate.path);
      } catch {
        // best effort; leave undeleted paths in metadata
      }
    }

    for (const path of deletedPaths) {
      pruneTrainingVaultMetadataPath(metadataByPath, path, true);
    }
    setTrainingVaultMetadataMap(metadataByPath);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "coordinator_training_cleanup",
      resource: "coordinator_training",
      details: JSON.stringify({
        rootFilter: rootFilter || null,
        programFilter: programFilter || null,
        jobIdFilter: jobIdFilter || null,
        projectPathFilter: projectPathFilter || null,
        deletedCount,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({
      ok: true,
      dryRun: false,
      matchedCount: candidates.length,
      deletedCount,
      totalBytesDeleted: deletedBytes,
      deletedPaths,
    });
  });

  return router;
}
