import { Hono } from "hono";
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
import type { ProcessTracker } from "../agents/process-tracker.js";
import { requirePermission } from "../middleware/auth.js";
import { errorResponse } from "../utils/errors.js";
import {
  parseCoordinatorReferencePaths,
} from "../agents/coordinator-playbooks.js";
import {
  DEFAULT_ORCHESTRATOR_PROMPT,
  type ProgramDiscoveryDeps,
} from "../agents/engines.js";
import {
  parseTrainingRepositoryPolicy,
  parseTrainingRepositoryOverrides,
  getTrainingRepositoryRefreshStatus,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
} from "../agents/training-repository.js";
import {
  getConfiguredOllamaBaseUrl,
  SERVER_LOCAL_LLM_BASE_URL_SETTINGS_KEY,
  DEFAULT_OLLAMA_BASE_URL,
} from "../local-models/ollama.js";
import {
  getNetworkControls,
} from "../security/network-policy.js";

import type { SettingsRouteDeps } from "./settings-shared.js";
import { createSettingsGeneralRoutes } from "./settings-general.js";
import { createSettingsCoordinatorRoutes } from "./settings-coordinator.js";
import { createSettingsTrainingRoutes } from "./settings-training.js";
import { createSettingsSnapshotsRoutes } from "./settings-snapshots.js";
import { createSettingsHousekeepingRoutes } from "./settings-housekeeping.js";

export function createSettingsRoutes(
  settingsRepo: SettingsRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
  jobsRepo: JobsRepo,
  agentsRepo: AgentsRepo,
  headlessProgramsRepo: HeadlessProgramsRepo | undefined,
  hub: WebSocketHub,
  coordinatorScriptsDir: string,
  coordinatorPlaybooksDir: string,
  coordinatorImportsDir: string,
  snapshotsDir: string,
  defaultCoordinatorReferencePaths: string[] = [],
  defaultCoordinatorPlaybookSourcePaths: string[] = [],
  db?: Database,
  workersRepo?: WorkersRepo,
  skillsRepo?: SkillsRepo,
  config?: Config,
  processTracker?: ProcessTracker,
) {
  const router = new Hono();

  const programDiscoveryDeps: ProgramDiscoveryDeps = {
    coordinatorScriptsDir,
    workersRepo,
    hub,
    headlessProgramsRepo,
  };

  // Build the shared deps object for sub-modules
  const deps: SettingsRouteDeps = {
    settingsRepo,
    usersRepo,
    auditRepo,
    jobsRepo,
    agentsRepo,
    headlessProgramsRepo,
    hub,
    coordinatorScriptsDir,
    coordinatorPlaybooksDir,
    coordinatorImportsDir,
    snapshotsDir,
    defaultCoordinatorReferencePaths,
    defaultCoordinatorPlaybookSourcePaths,
    db,
    workersRepo,
    skillsRepo,
    config,
    programDiscoveryDeps,
    processTracker,
  };

  // ── Helper for the overview route ──

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
      defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    } as const;
  }

  function requireSecurityManager(c: any) {
    const user = requirePermission(c, usersRepo, "manageSecurity");
    return user;
  }

  // ── GET / overview route (kept in aggregator) ──

  router.get("/", (c) => {
    const user = requireSecurityManager(c);
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const orchestratorPrompt = settingsRepo.get("orchestrator_prompt");
    const coordinatorReferencePaths = parseCoordinatorReferencePaths(
      settingsRepo.get("coordinator_reference_paths"),
    );
    const coordinatorPlaybookSourcePaths = parseCoordinatorReferencePaths(
      settingsRepo.get("coordinator_playbook_sources"),
    );
    const trainingRepositoryPolicy = parseTrainingRepositoryPolicy(
      settingsRepo.get(TRAINING_REPOSITORY_POLICY_SETTINGS_KEY),
    );
    const trainingRepositoryOverrides = parseTrainingRepositoryOverrides(
      settingsRepo.get(TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY),
    );
    const serverLocalLlm = getServerLocalLlmConfig();
    const networkControls = getNetworkControls(settingsRepo);
    return c.json({
      enforce2fa: settingsRepo.getBool("enforce_2fa"),
      allowClientCoordination: settingsRepo.getBool("allow_client_coordination"),
      serverLocalLlmBaseUrl: serverLocalLlm.baseUrl,
      serverLocalLlmEffectiveBaseUrl: serverLocalLlm.effectiveBaseUrl,
      serverLocalLlmSource: serverLocalLlm.source,
      orchestratorPrompt: orchestratorPrompt || null,
      defaultOrchestratorPrompt: DEFAULT_ORCHESTRATOR_PROMPT,
      networkControls,
      coordinatorReferencePaths,
      defaultCoordinatorReferencePaths,
      coordinatorPlaybookSourcePaths,
      defaultCoordinatorPlaybookSourcePaths,
      trainingRepositoryPolicy,
      trainingRepositoryOverridesSummary: {
        byId: Object.keys(trainingRepositoryOverrides.byId).length,
        bySourcePath: Object.keys(trainingRepositoryOverrides.bySourcePath).length,
      },
      trainingRepositoryRefreshStatus: getTrainingRepositoryRefreshStatus({
        dir: coordinatorPlaybooksDir,
      }),
    });
  });

  // ── Mount sub-routers ──

  router.route("/", createSettingsGeneralRoutes(deps));
  router.route("/", createSettingsCoordinatorRoutes(deps));
  router.route("/", createSettingsTrainingRoutes(deps));
  router.route("/", createSettingsSnapshotsRoutes(deps));
  router.route("/", createSettingsHousekeepingRoutes(deps));

  return router;
}
