/**
 * Test helpers for server unit tests.
 * Creates an in-memory SQLite database with all migrations applied.
 */
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrations.js";
import { JobsRepo } from "../db/jobs.repo.js";
import { AgentsRepo } from "../db/agents.repo.js";
import { UsersRepo } from "../db/users.repo.js";
import { ApiKeysRepo } from "../db/apikeys.repo.js";
import { PoliciesRepo } from "../db/policies.repo.js";
import { AuditRepo } from "../db/audit.repo.js";
import { UsageRepo } from "../db/usage.repo.js";
import { DependenciesRepo } from "../db/dependencies.repo.js";
import { ProjectsRepo } from "../db/projects.repo.js";
import { WorkersRepo } from "../db/workers.repo.js";
import { SettingsRepo } from "../db/settings.repo.js";
import { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { UserRole } from "../db/users.repo.js";

export interface TestContext {
  db: Database;
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  usersRepo: UsersRepo;
  apiKeysRepo: ApiKeysRepo;
  policiesRepo: PoliciesRepo;
  auditRepo: AuditRepo;
  usageRepo: UsageRepo;
  depsRepo: DependenciesRepo;
  projectsRepo: ProjectsRepo;
  workersRepo: WorkersRepo;
  settingsRepo: SettingsRepo;
  headlessProgramsRepo: HeadlessProgramsRepo;
  jobInterventionsRepo: JobInterventionsRepo;
}

/** Create a fresh in-memory database with all repos initialized. */
export function createTestDb(): TestContext {
  const db = new Database(":memory:");
  runMigrations(db);

  return {
    db,
    jobsRepo: new JobsRepo(db),
    agentsRepo: new AgentsRepo(db),
    usersRepo: new UsersRepo(db),
    apiKeysRepo: new ApiKeysRepo(db),
    policiesRepo: new PoliciesRepo(db),
    auditRepo: new AuditRepo(db),
    usageRepo: new UsageRepo(db),
    depsRepo: new DependenciesRepo(db),
    projectsRepo: new ProjectsRepo(db),
    workersRepo: new WorkersRepo(db),
    settingsRepo: new SettingsRepo(db),
    headlessProgramsRepo: new HeadlessProgramsRepo(db),
    jobInterventionsRepo: new JobInterventionsRepo(db),
  };
}

/** Create a test user with sensible defaults. */
export async function createTestUser(
  usersRepo: UsersRepo,
  overrides?: { username?: string; password?: string; role?: UserRole },
) {
  const username = overrides?.username ?? "testuser";
  const password = overrides?.password ?? "testpass";
  const role = overrides?.role ?? "user";
  return usersRepo.create(username, password, role);
}

/** Create a test session and return the token. */
export function createTestSession(usersRepo: UsersRepo, userId: string) {
  return usersRepo.createSession(userId);
}

/** Create a test agent config with sensible defaults. */
export function createTestAgentConfig(
  agentsRepo: AgentsRepo,
  overrides?: Partial<{
    name: string;
    engine: string;
    command: string;
    args: string[];
    model: string;
    fallbackConfigId: string;
    maxTurns: number;
    systemPrompt: string;
    priority: number;
  }>,
) {
  return agentsRepo.create({
    name: overrides?.name ?? "Test Agent",
    engine: (overrides?.engine as any) ?? "claude-code",
    command: overrides?.command ?? "claude",
    args: overrides?.args ?? [],
    model: overrides?.model,
    fallbackConfigId: overrides?.fallbackConfigId,
    maxTurns: overrides?.maxTurns ?? 300,
    systemPrompt: overrides?.systemPrompt,
    priority: overrides?.priority ?? 50,
  });
}

/** Create a test job with sensible defaults. */
export function createTestJob(
  jobsRepo: JobsRepo,
  agentConfigId: string,
  overrides?: Partial<{
    prompt: string;
    priority: string;
    startPaused: boolean;
    submittedBy: string;
    coordinationMode: "server" | "client";
  }>,
) {
  return jobsRepo.create(
    {
      prompt: overrides?.prompt ?? "Test prompt",
      agentConfigId,
      mode: "agentic" as const,
      priority: (overrides?.priority as any) ?? "normal",
      coordinationMode: overrides?.coordinationMode ?? "server",
      startPaused: overrides?.startPaused,
      files: [],
      contextItems: [],
    },
    undefined,
    undefined,
    undefined,
    undefined,
    overrides?.submittedBy,
  );
}
