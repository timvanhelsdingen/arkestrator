import { existsSync } from "node:fs";
import type { Job, AgentConfig, WorkspaceMode } from "@arkestrator/protocol";
import type { ProjectsRepo, Project } from "../db/projects.repo.js";
import type { Config } from "../config.js";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

export interface WorkspaceResolution {
  mode: WorkspaceMode;
  cwd: string;
  /** Resolver decision step (1-7) for diagnostics and fallback analysis. */
  resolutionStep: number;
  /** Human-readable explanation of why this mode was selected. */
  resolutionReason: string;
  /** Attached project for prompt injection (does NOT influence mode or cwd). */
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
  const projectRoot = job.editorContext?.projectRoot;
  const preferredMode = (job as any).preferredMode as WorkspaceMode | undefined;
  const metadata = (job.editorContext?.metadata ?? {}) as Record<string, unknown>;
  const targetBridges = Array.isArray(metadata.target_bridges)
    ? metadata.target_bridges.filter((v): v is string => typeof v === "string")
    : [];
  const hasBridgeProgram = !!job.bridgeProgram;

  // Look up attached project for prompt injection (does not affect workspace mode/cwd)
  let attachedProject: Project | undefined;
  if ((job as any).projectId) {
    attachedProject = projectsRepo.getById((job as any).projectId) ?? undefined;
    if (attachedProject) {
      logger.info("resolver", `Job ${job.id}: attached project '${attachedProject.name}' for prompt injection`);
    }
  }

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

  // 5. Check if projectRoot exists on server filesystem (same-machine)
  if (preferredMode !== "sync" && existsSync(projectRoot)) {
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
