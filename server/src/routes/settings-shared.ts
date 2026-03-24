/**
 * Shared types and dependency interface for settings route sub-modules.
 *
 * Each sub-module receives a SettingsRouteDeps object and creates its own
 * Hono router instance. The main settings.ts aggregator mounts them all.
 */

import type { Database } from "bun:sqlite";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { Config } from "../config.js";
import type { ProgramDiscoveryDeps } from "../agents/engines.js";

/**
 * All dependencies that `createSettingsRoutes` currently receives as params,
 * bundled into a single interface for cleaner sub-module signatures.
 */
export interface SettingsRouteDeps {
  settingsRepo: SettingsRepo;
  usersRepo: UsersRepo;
  auditRepo: AuditRepo;
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  headlessProgramsRepo: HeadlessProgramsRepo | undefined;
  hub: WebSocketHub;
  coordinatorScriptsDir: string;
  coordinatorPlaybooksDir: string;
  coordinatorImportsDir: string;
  snapshotsDir: string;
  defaultCoordinatorReferencePaths: string[];
  defaultCoordinatorPlaybookSourcePaths: string[];
  db?: Database;
  workersRepo?: WorkersRepo;
  skillsRepo?: SkillsRepo;
  config?: Config;
  /** Pre-built ProgramDiscoveryDeps derived from the raw params. */
  programDiscoveryDeps: ProgramDiscoveryDeps;
}
