import type { CommandResult } from "@arkestrator/protocol";
import type { HeadlessProgramsRepo, HeadlessProgram } from "../db/headless-programs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { WorkerResourceLeaseManager } from "./resource-control.js";
import {
  formatHeavyResourceConflictError,
  inferBridgeCommandHeavyResources,
  inferHeadlessArgsHeavyResources,
} from "./resource-control.js";
import { newId } from "../utils/id.js";
import { existsSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { logger } from "../utils/logger.js";

/**
 * Ensure a project path is a valid directory for use as cwd.
 * If the path is a file, returns its parent directory.
 * If the path doesn't exist or is empty, returns undefined.
 */
function sanitizeProjectPath(projectPath?: string): string | undefined {
  const trimmed = String(projectPath ?? "").trim();
  if (!trimmed) return undefined;
  try {
    const st = statSync(trimmed);
    if (st.isDirectory()) return trimmed;
    if (st.isFile()) return dirname(trimmed);
  } catch {
    // Path doesn't exist — don't use it as cwd
  }
  return undefined;
}

export interface WorkerHeadlessResult {
  success: boolean;
  executed: number;
  failed: number;
  skipped: number;
  errors: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  program: string;
  headless: true;
}

export interface WorkerHeadlessExecutionResponse {
  handled: boolean;
  success: boolean;
  program: string;
  result?: WorkerHeadlessResult;
  error?: string;
}

function normalizeWorkerKey(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueWorkerKeys(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeWorkerKey(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function describeWorkerKey(value?: string | null): string {
  const normalized = normalizeWorkerKey(value);
  return normalized || "unknown-worker";
}

function resolveClientForHeadlessProgram(
  hub: WebSocketHub,
  program: string,
  explicitTargetWorker?: string,
): { clientId?: string; workerKey?: string; error?: string } {
  const requestedWorker = normalizeWorkerKey(explicitTargetWorker);
  if (requestedWorker) {
    const clients = hub.getClientConnectionsByWorker(requestedWorker);
    if (clients.length === 1) {
      return { clientId: clients[0].data.id, workerKey: requestedWorker };
    }
    if (clients.length > 1) {
      return { error: `Multiple desktop clients are connected for worker "${requestedWorker}"` };
    }
    return { error: `No connected desktop client for worker "${requestedWorker}"` };
  }

  // Use workerName as the canonical identifier per bridge connection.
  // Including both machineId and workerName creates false duplicates
  // when a single bridge has both set (e.g. "5d0140dd..." and "tvh-13900k").
  const bridgeWorkers = uniqueWorkerKeys(
    hub.getBridgesByProgram(program).map((ws) => ws.data.workerName ?? ws.data.machineId),
  );
  if (bridgeWorkers.length === 1) {
    const clients = hub.getClientConnectionsByWorker(bridgeWorkers[0]);
    if (clients.length === 1) {
      return { clientId: clients[0].data.id, workerKey: bridgeWorkers[0] };
    }
    if (clients.length > 1) {
      return { error: `Multiple desktop clients are connected for worker "${bridgeWorkers[0]}"` };
    }
    return {
      error: `Program "${program}" is online on worker "${bridgeWorkers[0]}", but no desktop client is connected there`,
    };
  }
  if (bridgeWorkers.length > 1) {
    return {
      error: `Program "${program}" is online on multiple workers (${bridgeWorkers.join(", ")}); targetWorkerName is required for headless execution`,
    };
  }

  // No online bridge found for this program and no explicit target worker.
  // Do NOT fall back to an arbitrary client — that would route commands to the
  // wrong program's bridge (e.g. sending blender commands to houdini).
  return { error: `No connected bridge for "${program}" and no targetWorkerName specified for headless execution` };
}

async function dispatchWorkerHeadlessRequest(
  hub: WebSocketHub,
  clientId: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerHeadlessResult> {
  const correlationId = String(payload.correlationId ?? "");
  if (!correlationId) {
    throw new Error("Missing correlationId for worker headless request");
  }
  if (!clientId) {
    throw new Error("Missing client target id for worker headless request");
  }

  const resultPromise = hub.registerPendingCommand(correlationId, timeoutMs);
  hub.send(clientId, {
    type: "worker_headless_command",
    id: newId(),
    payload,
  });
  return await resultPromise as WorkerHeadlessResult;
}

export async function executeWorkerHeadlessCommands(params: {
  hub: WebSocketHub;
  headlessProgramsRepo?: HeadlessProgramsRepo;
  resourceLeaseManager?: WorkerResourceLeaseManager;
  program: string;
  commands: CommandResult[];
  timeoutMs: number;
  projectPath?: string;
  targetWorkerName?: string;
  leaseOwnerLabel?: string;
  leaseOwnerId?: string;
}): Promise<WorkerHeadlessExecutionResponse> {
  const program = String(params.program ?? "").trim().toLowerCase();
  if (!program) {
    return { handled: false, success: false, program };
  }

  // Use priority chain: worker-reported > admin global > nothing
  const resolvedConfig = resolveHeadlessProgramConfig(
    params.hub,
    params.headlessProgramsRepo,
    program,
    params.targetWorkerName,
  );
  if (!resolvedConfig) {
    return { handled: false, success: false, program };
  }

  const clientTarget = resolveClientForHeadlessProgram(
    params.hub,
    program,
    params.targetWorkerName,
  );
  if (!clientTarget.clientId) {
    return {
      handled: true,
      success: false,
      program,
      error: clientTarget.error || `No desktop client can execute headless ${program}`,
    };
  }

  const resources = inferBridgeCommandHeavyResources(program, params.commands);
  const acquired = params.resourceLeaseManager?.acquire(
    clientTarget.workerKey ? [clientTarget.workerKey] : [],
    resources,
    {
      ownerId: params.leaseOwnerId ?? `headless:${program}:${Date.now()}`,
      ownerLabel: params.leaseOwnerLabel ?? `headless ${program}`,
      program,
    },
  );
  if (acquired && !acquired.ok) {
    return {
      handled: true,
      success: false,
      program,
      error: formatHeavyResourceConflictError(acquired.conflict, program),
    };
  }

  try {
    const result = await dispatchWorkerHeadlessRequest(
      params.hub,
      clientTarget.clientId,
      {
        senderId: "server",
        correlationId: newId(),
        program,
        projectPath: sanitizeProjectPath(params.projectPath),
        timeoutMs: params.timeoutMs,
        execution: {
          mode: "commands",
          config: {
            executable: resolvedConfig.executable,
            argsTemplate: resolvedConfig.argsTemplate,
            language: resolvedConfig.language,
          },
          commands: params.commands,
        },
      },
      params.timeoutMs,
    );
    let error: string | undefined;
    if (!result.success) {
      const parts: string[] = [];
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        parts.push(...result.errors.map((e: string) => String(e).trim()).filter(Boolean));
      }
      if (result.stderr && typeof result.stderr === "string" && result.stderr.trim()) {
        parts.push(`stderr: ${result.stderr.trim()}`);
      }
      error = parts.length > 0 ? parts.join("\n") : `Headless execution failed for ${program}`;
    }
    return {
      handled: true,
      success: result.success,
      program,
      result,
      error,
    };
  } catch (err: any) {
    return {
      handled: true,
      success: false,
      program,
      error: err?.message ?? `Headless execution failed for ${program}`,
    };
  } finally {
    acquired?.ok && acquired.lease.release();
  }
}

export async function runWorkerHeadlessCheck(params: {
  hub: WebSocketHub;
  headlessProgramsRepo?: HeadlessProgramsRepo;
  resourceLeaseManager?: WorkerResourceLeaseManager;
  program: string;
  args: string[];
  timeoutMs: number;
  projectPath?: string;
  targetWorkerName?: string;
  leaseOwnerLabel?: string;
  leaseOwnerId?: string;
}): Promise<{
  output?: string;
  error?: string;
  status?: number;
}> {
  const program = String(params.program ?? "").trim().toLowerCase();
  if (!program) {
    return { error: "Missing or invalid 'program' field", status: 400 };
  }
  if (!Array.isArray(params.args) || params.args.length === 0 || params.args.some((arg) => typeof arg !== "string")) {
    return { error: "Missing or invalid 'args' array (must be string[])", status: 400 };
  }

  // Use priority chain: worker-reported > admin global > nothing
  const resolvedConfig = resolveHeadlessProgramConfig(
    params.hub,
    params.headlessProgramsRepo,
    program,
    params.targetWorkerName,
  );
  if (!resolvedConfig) {
    return {
      error: `"${program}" is not registered as an enabled headless program`,
      status: 404,
    };
  }

  const clientTarget = resolveClientForHeadlessProgram(
    params.hub,
    program,
    params.targetWorkerName,
  );
  if (!clientTarget.clientId) {
    return {
      error: clientTarget.error || `No desktop client can execute headless ${program}`,
      status: 409,
    };
  }

  const resources = inferHeadlessArgsHeavyResources(program, params.args);
  const acquired = params.resourceLeaseManager?.acquire(
    clientTarget.workerKey ? [clientTarget.workerKey] : [],
    resources,
    {
      ownerId: params.leaseOwnerId ?? `headless-check:${program}:${Date.now()}`,
      ownerLabel: params.leaseOwnerLabel ?? `headless check ${program}`,
      program,
    },
  );
  if (acquired && !acquired.ok) {
    return {
      error: formatHeavyResourceConflictError(acquired.conflict, program),
      status: 409,
    };
  }

  try {
    const result = await dispatchWorkerHeadlessRequest(
      params.hub,
      clientTarget.clientId,
      {
        senderId: "server",
        correlationId: newId(),
        program,
        projectPath: sanitizeProjectPath(params.projectPath),
        timeoutMs: params.timeoutMs,
        execution: {
          mode: "raw_args",
          executable: resolvedConfig.executable,
          args: params.args,
        },
      },
      params.timeoutMs,
    );
    const parts: string[] = [];
    if (result.exitCode !== undefined) parts.push(`Exit code: ${result.exitCode}`);
    if (result.stdout?.trim()) parts.push(`STDOUT:\n${result.stdout.trim()}`);
    if (result.stderr?.trim()) parts.push(`STDERR:\n${result.stderr.trim()}`);
    if (result.errors.length > 0) parts.push(`ERRORS:\n${result.errors.join("\n")}`);
    if (parts.length === 0) parts.push("(no output)");
    return { output: parts.join("\n\n") };
  } catch (err: any) {
    return { error: `Failed to run ${program}: ${err?.message ?? err}`, status: 500 };
  } finally {
    acquired?.ok && acquired.lease.release();
  }
}

/**
 * Resolve the full executable path for a headless program.
 * If the stored executable is a bare name (e.g. "hython") and not on PATH,
 * try to derive the full path from known install conventions:
 * - Houdini: hython lives in the same bin/ folder as houdini/houdinifx
 *   (e.g. C:\Program Files\Side Effects Software\Houdini 21.0.512\bin\hython.exe)
 * - Blender: blender CLI is the same executable as the GUI app
 *
 * Uses connected bridge version info when available to target the exact version.
 */
function resolveHeadlessExecutable(
  program: HeadlessProgram,
  hub: WebSocketHub,
  targetWorkerName?: string,
): string {
  const exe = program.executable.trim();
  // If it's already a full path that exists, use it
  if ((exe.includes("/") || exe.includes("\\")) && existsSync(exe)) return exe;

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (program.program === "houdini") {
    // Try to get version from connected bridge
    const bridges = hub.getBridges().filter(
      (b) => String(b.program ?? "").toLowerCase() === "houdini"
        && (!targetWorkerName || normalizeWorkerKey(b.workerName) === normalizeWorkerKey(targetWorkerName)),
    );
    const bridgeVersion = bridges[0]?.programVersion;

    if (isWindows) {
      const sfsBase = "C:/Program Files/Side Effects Software";
      // If we know the exact version from the bridge, try that first
      if (bridgeVersion) {
        const exactPath = join(sfsBase, `Houdini ${bridgeVersion}`, "bin", "hython.exe");
        if (existsSync(exactPath)) {
          logger.info("worker-headless", `Resolved hython from bridge version ${bridgeVersion}: ${exactPath}`);
          return exactPath;
        }
      }
      // Scan for any installed version (newest first)
      try {
        if (existsSync(sfsBase)) {
          const found = readdirSync(sfsBase)
            .filter((d) => d.startsWith("Houdini "))
            .sort().reverse()
            .map((d) => join(sfsBase, d, "bin", "hython.exe"))
            .find((p) => existsSync(p));
          if (found) {
            logger.info("worker-headless", `Resolved hython from install scan: ${found}`);
            return found;
          }
        }
      } catch { /* ignore */ }
    } else if (isMac) {
      // macOS: /Applications/Houdini/Houdini{version}/Frameworks/Houdini.framework/Versions/Current/Resources/bin/hython
      // or via hfs: /opt/hfs{version}/bin/hython
      if (bridgeVersion) {
        const hfsPath = `/opt/hfs${bridgeVersion}/bin/hython`;
        if (existsSync(hfsPath)) return hfsPath;
      }
      // Scan /opt/hfs*
      try {
        const dirs = readdirSync("/opt").filter((d) => d.startsWith("hfs")).sort().reverse();
        for (const d of dirs) {
          const p = join("/opt", d, "bin", "hython");
          if (existsSync(p)) return p;
        }
      } catch { /* ignore */ }
    }
  }

  if (program.program === "blender") {
    if (isWindows) {
      const candidates = [
        "C:/Program Files/Blender Foundation/Blender/blender.exe",
        ...(() => {
          try {
            return readdirSync("C:/Program Files/Blender Foundation")
              .filter((d) => d.startsWith("Blender"))
              .sort().reverse()
              .map((d) => `C:/Program Files/Blender Foundation/${d}/blender.exe`);
          } catch { return []; }
        })(),
      ];
      const found = candidates.find((c) => existsSync(c));
      if (found) return found;
    } else if (isMac) {
      const macPath = "/Applications/Blender.app/Contents/MacOS/Blender";
      if (existsSync(macPath)) return macPath;
    }
  }

  // Fallback: verify the bare name is on PATH before returning it
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const proc = Bun.spawnSync([whichCmd, exe], { stdout: "pipe", stderr: "pipe" });
    const resolved = proc.stdout.toString().trim().split(/\r?\n/)[0]?.trim();
    if (proc.exitCode === 0 && resolved && existsSync(resolved)) {
      logger.info("worker-headless", `Resolved ${exe} via PATH: ${resolved}`);
      return resolved;
    }
  } catch {
    // which/where not available or failed — fall through
  }

  // Last resort: return the bare name
  logger.warn("worker-headless", `Could not resolve ${exe} — returning bare name`);
  return exe;
}

function serializeHeadlessProgram(program: HeadlessProgram, hub: WebSocketHub, targetWorkerName?: string) {
  return {
    executable: resolveHeadlessExecutable(program, hub, targetWorkerName),
    argsTemplate: [...program.argsTemplate],
    language: program.language,
  };
}

/**
 * Resolve headless program config using priority chain:
 *   1. Worker-reported auto-detected capability (from client desktop app)
 *   2. Admin global config (headless-programs.repo)
 *   3. Nothing available
 */
export function resolveHeadlessProgramConfig(
  hub: WebSocketHub,
  headlessProgramsRepo: HeadlessProgramsRepo | undefined,
  program: string,
  targetWorkerName?: string,
): { executable: string; argsTemplate: string[]; language: string; source: "worker" | "admin" } | undefined {
  const normalizedProgram = program.trim().toLowerCase();

  // Priority 1: Worker-reported auto-detected capability
  if (targetWorkerName) {
    const workerCap = hub.getWorkerHeadlessProgram(targetWorkerName, normalizedProgram);
    if (workerCap) {
      logger.info("worker-headless",
        `Using worker-reported headless for ${normalizedProgram} on ${describeWorkerKey(targetWorkerName)}: ${workerCap.executable}`);
      return {
        executable: workerCap.executable,
        argsTemplate: [...workerCap.argsTemplate],
        language: workerCap.language,
        source: "worker",
      };
    }
  } else {
    // No explicit target: check if the single bridge worker reported headless
    const bridgeWorkers = uniqueWorkerKeys(
      hub.getBridgesByProgram(normalizedProgram).map((ws) => ws.data.workerName ?? ws.data.machineId),
    );
    if (bridgeWorkers.length === 1) {
      const workerCap = hub.getWorkerHeadlessProgram(bridgeWorkers[0], normalizedProgram);
      if (workerCap) {
        logger.info("worker-headless",
          `Using worker-reported headless for ${normalizedProgram} on ${describeWorkerKey(bridgeWorkers[0])}: ${workerCap.executable}`);
        return {
          executable: workerCap.executable,
          argsTemplate: [...workerCap.argsTemplate],
          language: workerCap.language,
          source: "worker",
        };
      }
    }
  }

  // Priority 2: Admin global config (headless-programs.repo)
  const adminConfig = headlessProgramsRepo?.getByProgram(normalizedProgram);
  if (adminConfig?.enabled && adminConfig.executable) {
    return {
      executable: resolveHeadlessExecutable(adminConfig, hub, targetWorkerName),
      argsTemplate: [...adminConfig.argsTemplate],
      language: adminConfig.language,
      source: "admin",
    };
  }

  // Priority 3: Nothing available
  return undefined;
}
