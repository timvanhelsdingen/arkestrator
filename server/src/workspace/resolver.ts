import { existsSync } from "node:fs";
import type { Job, AgentConfig, WorkspaceMode } from "@arkestrator/protocol";
import type { ProjectsRepo, Project } from "../db/projects.repo.js";
import type { Config } from "../config.js";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";
import { hasProjectMarker } from "../utils/project-path.js";

/**
 * Guard against spawning agent subprocesses with a cwd that contains the
 * server's own data directory (or is the user's home directory root).
 *
 * Background (2026-04-11 corruption incident, run 2 — see
 * `docs/reports/2026-04-11-db-corruption-postmortem.md`):
 * Worker `tvh-13900k` reported `lastProjectPath = C:/Users/timvanhelsdingen`
 * because the Blender bridge was in an "Untitled" session with no project
 * file loaded, so it defaulted to the user's home directory. `worker.ts`
 * injected that path as the job's projectRoot, step 5 of the resolver saw
 * it existed, and every Claude Code subprocess spawned with
 * `cwd = C:/Users/timvanhelsdingen`. Four parallel agents indexing the
 * entire home tree race against the server's own writes to
 * `server/data/db/arkestrator.db`, yielding `btreeInitPage error 11` and
 * `database disk image is malformed` after ~20 s. The corruption is
 * reproducible on every parallel run once the agent cwd contains the live
 * DB file — and repo-mode gives the agent `--dangerously-skip-permissions`
 * so it can read, open, and write anywhere in that tree.
 *
 * Rule: if the candidate cwd is the home directory itself, or contains the
 * server's dataDir, refuse to use it for repo mode. Fall through to the
 * safer branches (sync/command) instead.
 */
function isUnsafeRepoCwd(candidate: string, serverDataDir: string | undefined): { unsafe: boolean; reason: string } {
  if (!candidate) return { unsafe: false, reason: "" };
  let resolved: string;
  try {
    resolved = resolve(candidate);
  } catch {
    return { unsafe: false, reason: "" };
  }

  const home = resolve(homedir());
  if (resolved === home) {
    return { unsafe: true, reason: `candidate cwd is the user home directory (${home})` };
  }

  if (serverDataDir) {
    let dataDirResolved: string;
    try {
      dataDirResolved = resolve(serverDataDir);
    } catch {
      return { unsafe: false, reason: "" };
    }
    const dataDirWithSep = dataDirResolved.endsWith(sep) ? dataDirResolved : dataDirResolved + sep;
    const candidateWithSep = resolved.endsWith(sep) ? resolved : resolved + sep;
    // Candidate contains the data dir if the data dir path starts with the candidate path
    if (dataDirWithSep.startsWith(candidateWithSep)) {
      return {
        unsafe: true,
        reason: `candidate cwd (${resolved}) contains the server data directory (${dataDirResolved}) — agent subprocess would have filesystem access to the live SQLite database`,
      };
    }
  }

  return { unsafe: false, reason: "" };
}

export interface WorkspaceResolution {
  mode: WorkspaceMode;
  cwd: string;
  /** Resolver decision step (1-7) for diagnostics and fallback analysis. */
  resolutionStep: number;
  /** Human-readable explanation of why this mode was selected. */
  resolutionReason: string;
  /** Attached project — its first folder is used as projectRoot fallback. */
  project?: Project;
  syncDir?: string;
  needsSync: boolean;
}

export function resolveWorkspace(
  job: Job,
  config: AgentConfig,
  projectsRepo: ProjectsRepo,
  serverConfig: Config,
): WorkspaceResolution {
  const preferredMode = (job as any).preferredMode as WorkspaceMode | undefined;
  const metadata = (job.editorContext?.metadata ?? {}) as Record<string, unknown>;
  const targetBridges = Array.isArray(metadata.target_bridges)
    ? metadata.target_bridges.filter((v): v is string => typeof v === "string")
    : [];
  const hasBridgeProgram = !!job.bridgeProgram;

  // Look up attached project — its rootPath is used as a fallback for cwd
  let attachedProject: Project | undefined;
  if ((job as any).projectId) {
    attachedProject = projectsRepo.getById((job as any).projectId) ?? undefined;
    if (attachedProject) {
      logger.info("resolver", `Job ${job.id}: attached project '${attachedProject.name}' for prompt injection`);
    }
  }

  // Resolve projectRoot: prefer editorContext, fall back to attached project's first folder
  const editorProjectRoot = job.editorContext?.projectRoot;
  const projectFolderPath = (attachedProject?.folders as any)?.[0]?.path as string | undefined;
  const projectRoot = editorProjectRoot || projectFolderPath || "";

  // 1. If preferred mode is explicitly set, honor it
  if (preferredMode === "command") {
    logger.info("resolver", `Job ${job.id}: using preferred mode 'command'`);
    return {
      mode: "command",
      cwd: process.cwd(),
      resolutionStep: 1,
      resolutionReason: "preferred_mode_command",
      project: attachedProject,
      needsSync: false,
    };
  }

  // 2. If server default is not "auto", use it (unless overridden above)
  if (
    serverConfig.defaultWorkspaceMode !== "auto" &&
    !preferredMode
  ) {
    const mode = serverConfig.defaultWorkspaceMode as WorkspaceMode;
    logger.info(
      "resolver",
      `Job ${job.id}: using server default mode '${mode}'`,
    );
    if (mode === "command") {
      return {
        mode: "command",
        cwd: process.cwd(),
        resolutionStep: 2,
        resolutionReason: "server_default_command",
        project: attachedProject,
        needsSync: false,
      };
    }
    // For repo/sync, still need to resolve cwd below
  }

  // 3. No project root → command mode
  if (!projectRoot) {
    logger.info(
      "resolver",
      `Job ${job.id}: no projectRoot, using command mode`,
    );
    return {
      mode: "command",
      cwd: process.cwd(),
      resolutionStep: 3,
      resolutionReason: "missing_project_root",
      project: attachedProject,
      needsSync: false,
    };
  }

  // 4. Bridge-submitted jobs should execute through bridge commands by default,
  // not local repo mode. This keeps DCC execution client-side unless the user
  // explicitly sets a preferred mode override.
  if (!preferredMode && hasBridgeProgram) {
    const shouldDefaultForTargeted =
      targetBridges.length > 0 && targetBridges.includes(job.bridgeProgram!);
    const reason = shouldDefaultForTargeted
      ? "bridge_targeted_command_default"
      : "bridge_program_command_default";
    logger.info(
      "resolver",
      `Job ${job.id}: bridge program detected (${job.bridgeProgram}) -> command mode`,
    );
    return {
      mode: "command",
      cwd: process.cwd(),
      resolutionStep: 4,
      resolutionReason: reason,
      project: attachedProject,
      needsSync: false,
    };
  }

  // 5. Check if projectRoot exists on server filesystem (same-machine).
  //
  // Two guards (see 2026-04-11 post-mortem):
  //
  //  a) `isUnsafeRepoCwd` — refuse paths that are the user's home dir
  //     or contain the server's dataDir. The agent subprocess must not
  //     get filesystem access to the live SQLite file.
  //  b) `hasProjectMarker` — refuse paths that are not actually project
  //     roots. Bare directories that happen to exist (e.g. `~` on
  //     linux, `C:\Users\<user>\Documents` on Windows) would otherwise
  //     pass the bare `existsSync` check and land the agent in a huge
  //     tree with no reasonable workspace scope. A project root must
  //     have at least one recognisable marker file (`.git`,
  //     `package.json`, `*.blend`, `*.hip`, `arkestrator.coordinator.json`,
  //     etc. — see `utils/project-path.ts`).
  //
  // When either guard rejects, we log a warning and fall through to
  // sync (if attached files) or command mode (in the server cwd).
  if (preferredMode !== "sync" && existsSync(projectRoot)) {
    const safety = isUnsafeRepoCwd(projectRoot, (serverConfig as any).dataDir);
    if (safety.unsafe) {
      logger.warn(
        "resolver",
        `Job ${job.id}: refusing repo mode at ${projectRoot} — ${safety.reason}. Falling through to sync/command mode.`,
      );
    } else {
      const marker = hasProjectMarker(projectRoot);
      if (marker === false) {
        logger.warn(
          "resolver",
          `Job ${job.id}: refusing repo mode at ${projectRoot} — directory has no project marker (.git, package.json, *.blend, arkestrator.coordinator.json, etc.). Falling through to sync/command mode.`,
        );
      } else {
        // marker === true OR marker === null (permission error — lean safe-accept,
        // the unsafe-cwd guard above already blocks the most dangerous case).
        logger.info(
          "resolver",
          `Job ${job.id}: projectRoot exists locally → repo mode (${projectRoot})`,
        );
        return {
          mode: "repo",
          cwd: projectRoot,
          resolutionStep: 5,
          resolutionReason: "project_root_exists_locally",
          project: attachedProject,
          needsSync: false,
        };
      }
    }
  }

  // 6. If job has attached files → sync mode
  if (job.files && job.files.length > 0) {
    const syncDir = join(serverConfig.syncTempDir, job.id);
    logger.info(
      "resolver",
      `Job ${job.id}: has ${job.files.length} attached files → sync mode`,
    );
    return {
      mode: "sync",
      cwd: syncDir,
      resolutionStep: 6,
      resolutionReason: "attached_files_sync_mode",
      project: attachedProject,
      syncDir,
      needsSync: true,
    };
  }

  // 7. Fallback → command mode
  logger.info(
    "resolver",
    `Job ${job.id}: no local path, no files → command mode fallback`,
  );
  return {
    mode: "command",
    cwd: process.cwd(),
    resolutionStep: 7,
    resolutionReason: "fallback_command_mode",
    project: attachedProject,
    needsSync: false,
  };
}
