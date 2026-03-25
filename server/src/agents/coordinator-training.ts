/**
 * coordinator-training.ts — Main orchestration for coordinator training jobs.
 *
 * Sub-modules (re-exported below for backward compatibility):
 * - training-extraction.ts  — JSON parsing and analysis extraction
 * - training-vault.ts       — Vault/artifact writing and learning collection
 * - training-scheduling.ts  — Schedule management
 * - training-discovery.ts   — Project discovery and source path resolution
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { Job, JobSubmit } from "@arkestrator/protocol";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { recordCoordinatorExecutionOutcome } from "./coordinator-playbooks.js";
import { getCoordinatorScriptDefault, getCoordinatorScriptPrograms, type ProgramDiscoveryDeps } from "./engines.js";
import { queueHousekeepingJob, type HousekeepingDeps } from "./housekeeping.js";
import {
  flushTrainingRepositoryIndexRefresh,
  parseTrainingRepositoryOverrides,
  parseTrainingRepositoryPolicy,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
  scheduleTrainingRepositoryIndexRefresh,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
} from "./training-repository.js";

// ── Sub-module imports used internally ───────────────────────────────────────

import {
  type AgenticTrainingSeed,
  extractAgenticTrainingSeed,
  parsePromptSummary,
  summarizeContextsPrompt,
  TRAINING_CHILD_LOG_TAIL_CHARS,
} from "./training-extraction.js";

import {
  type CoordinatorTrainingArtifact,
  buildTrainingCompletionFiles,
  collectLearningVaultSummaries,
  isLikelyLearningVaultPath,
  writeTrainingArtifact,
} from "./training-vault.js";

import {
  captureTrainingProjectFileBaselines,
  collectTrainingProjectDetails,
  detectProgramsInPaths,
  discoverProjectDirs,
  PROJECT_CONFIG_FILES,
  resolveProjectConfigPath,
  readDocSnippet,
  readProjectConfig,
  readProjectConfigFromNotes,
  resolvePlaybookPath,
  resolveProjectDirFromSourceFile,
  resolveScriptPath,
  resolveScheduledVaultSourcePaths,
  resolveTrainingSourcePaths,
  restoreTrainingProjectFileBaselines,
  type CoordinatorTrainingSummary,
  type TrainingProjectFileBaseline,
} from "./training-discovery.js";

import {
  getCoordinatorTrainingLastRunByProgram,
  getCoordinatorTrainingSchedule,
  setCoordinatorTrainingLastRunByProgram,
  type CoordinatorTrainingSchedule,
} from "./training-scheduling.js";

// ── Re-export sub-modules for backward compatibility ─────────────────────────

export * from "./training-extraction.js";
export * from "./training-vault.js";
export * from "./training-scheduling.js";
export * from "./training-discovery.js";

// ── Constants ────────────────────────────────────────────────────────────────

const ANALYZE_AGENT_SETTING = "coordinator_analyze_agent_config_id";
const TRAINING_AGENTIC_ANALYSIS_TIMEOUT_MS = 45 * 60_000;
const TRAINING_AGENTIC_STATUS_POLL_MS = 1_000;

export const TRAINING_BLOCK_START = "<!-- ARKESTRATOR_TRAINING:START -->";
export const TRAINING_BLOCK_END = "<!-- ARKESTRATOR_TRAINING:END -->";

// ── Training Level ──────────────────────────────────────────────────────────
export type TrainingLevel = "low" | "medium" | "high";
export const TRAINING_LEVELS: readonly TrainingLevel[] = ["low", "medium", "high"] as const;

/** Per-level tuning knobs applied to discovery, prompts, and timeouts. */
const TRAINING_LEVEL_CONFIG: Record<TrainingLevel, {
  /** Override analysis mode? null = auto-detect (bridge > headless > filesystem). */
  forceAnalysisMode: "filesystem" | null;
  /** Max directory depth for discoverProjectDirs. */
  discoveryDepth: number;
  /** Max projects from discoverProjectDirs. */
  discoveryMaxProjects: number;
  /** Summary char limit per project reference. */
  summaryCharLimit: number;
  /** Multiplier applied to the agentic analysis timeout. */
  timeoutMultiplier: number;
  /** Extra prompt lines injected into the agentic analysis prompt. */
  promptPrefix: string[];
}> = {
  low: {
    forceAnalysisMode: "filesystem",
    discoveryDepth: 2,
    discoveryMaxProjects: 100,
    summaryCharLimit: 120,
    timeoutMultiplier: 0.5,
    promptPrefix: [
      "Perform a QUICK, filesystem-only scan. Do NOT use bridge tools or execute_command.",
      "Focus on: file listing, folder structure, file sizes, basic metadata.",
      "Write a brief 1-paragraph summary per project. Do not inspect internal scene data.",
      "Speed is more important than depth — keep analysis under 5 minutes.",
    ],
  },
  medium: {
    forceAnalysisMode: null,
    discoveryDepth: 3,
    discoveryMaxProjects: 300,
    summaryCharLimit: 220,
    timeoutMultiplier: 1,
    promptPrefix: [],
  },
  high: {
    forceAnalysisMode: null,
    discoveryDepth: 5,
    discoveryMaxProjects: 600,
    summaryCharLimit: 400,
    timeoutMultiplier: 2,
    promptPrefix: [
      "Perform EXHAUSTIVE deep analysis. Inspect every node, every parameter.",
      "For Houdini: traverse full node tree recursively, dump all SOP/DOP/SHOP parameters with exact values.",
      "For Blender: inspect all objects, modifiers, materials, shader nodes, render settings.",
      "Document exact parameter values suitable for automated recreation.",
      "Write a comprehensive step-by-step recreation guide with all numeric values.",
      "Take your time — thoroughness is more important than speed.",
    ],
  },
};

// ── Exported interfaces ──────────────────────────────────────────────────────
// CoordinatorTrainingSummary is defined in training-discovery.ts and re-exported via export *
// CoordinatorTrainingSchedule is defined in training-scheduling.ts and re-exported via export *

export interface CoordinatorTrainingResult {
  program: string;
  apply: boolean;
  generatedAt: string;
  projectCount: number;
  sourcePaths: string[];
  suggestedScript: string;
  scriptPath: string;
  scriptUpdated: boolean;
  playbookPath: string;
  playbookUpdated: boolean;
  summaries: CoordinatorTrainingSummary[];
}

export interface GenerateCoordinatorTrainingOptions {
  program: string;
  coordinatorScriptsDir: string;
  coordinatorPlaybooksDir: string;
  settingsRepo: SettingsRepo;
  skillsRepo?: SkillsRepo;
  defaultCoordinatorPlaybookSourcePaths?: string[];
  sourcePaths?: string[];
  trainingPrompt?: string;
  apply?: boolean;
  seedSummaries?: CoordinatorTrainingSummary[];
  skipSourceScan?: boolean;
  trainingLevel?: TrainingLevel;
}

export interface QueueCoordinatorTrainingJobOptions {
  program: string;
  trigger: "manual" | "scheduled";
  apply?: boolean;
  sourcePaths?: string[];
  trainingPrompt?: string;
  agentConfigId?: string;
  targetWorkerName?: string;
  submittedBy?: string;
  trainingLevel?: TrainingLevel;
  /** Set when called from orchestrator to link child jobs to the parent. */
  parentJobId?: string;
}

export interface QueueCoordinatorTrainingJobDeps {
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  settingsRepo: SettingsRepo;
  skillsRepo?: SkillsRepo;
  headlessProgramsRepo?: HeadlessProgramsRepo;
  hub: WebSocketHub;
  coordinatorScriptsDir: string;
  coordinatorPlaybooksDir: string;
  defaultCoordinatorPlaybookSourcePaths?: string[];
  /** Process tracker for suspend/resume during child analysis polling. */
  processTracker?: import("./process-tracker.js").ProcessTracker;
}

interface CoordinatorTrainingJobTerminalState {
  status: Job["status"] | "missing" | "timeout";
  error?: string;
  logs?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTrainingPrompt(value: unknown, maxChars = 4_000): string {
  const cleaned = String(value ?? "").replace(/\r/g, "").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function normalizeProgramList(programs: string[] | undefined, deps?: ProgramDiscoveryDeps): string[] {
  const known = new Set(getCoordinatorScriptPrograms(deps).map((p) => p.toLowerCase()));
  const out = new Set<string>();
  for (const raw of programs ?? []) {
    const p = String(raw ?? "").trim().toLowerCase();
    if (!p) continue;
    if (!known.has(p)) continue;
    out.add(p);
  }
  return [...out];
}

function mergeTrainingBlock(script: string, blockBody: string): string {
  const block = `${TRAINING_BLOCK_START}\n${blockBody}\n${TRAINING_BLOCK_END}`;
  const patterns: Array<[string, string]> = [[TRAINING_BLOCK_START, TRAINING_BLOCK_END]];
  let stripped = script;
  for (const [start, end] of patterns) {
    const existingRegex = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "g");
    stripped = stripped.replace(existingRegex, "");
  }
  stripped = stripped.trimEnd();
  return `${stripped}\n\n${block}\n`;
}

function resolveTrainingAgentId(
  agentsRepo: AgentsRepo,
  settingsRepo: SettingsRepo,
  preferredAgentConfigId?: string,
): string {
  const agents = agentsRepo.list();
  if (agents.length === 0) {
    throw new Error("No agent config available to attach training job");
  }
  const preferred = String(preferredAgentConfigId ?? "").trim();
  if (preferred && agents.some((a) => a.id === preferred)) return preferred;
  const configured = String(settingsRepo.get(ANALYZE_AGENT_SETTING) ?? "").trim();
  if (configured && agents.some((a) => a.id === configured)) return configured;
  return agents[0].id;
}

function broadcastJobUpdated(hub: WebSocketHub, jobsRepo: JobsRepo, jobId: string): void {
  const job = jobsRepo.getById(jobId);
  if (!job) return;
  hub.broadcastToType("client", {
    type: "job_updated",
    id: newId(),
    payload: { job },
  });
}

function appendJobLog(hub: WebSocketHub, jobsRepo: JobsRepo, jobId: string, text: string): void {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  jobsRepo.appendLog(jobId, line);
  hub.broadcastToType("client", {
    type: "job_log",
    id: newId(),
    payload: { jobId, text: line },
  });
}

export function buildTrainingAgenticAnalyzePrompt(
  program: string,
  sourcePaths: string[],
  trainingPrompt: string,
  mode: "bridge" | "headless" | "filesystem",
  level: TrainingLevel = "medium",
): string {
  const levelCfg = TRAINING_LEVEL_CONFIG[level];
  const lines: string[] = [];
  lines.push(`Analyze coordinator training source paths for ${program} (${mode} mode, training level: ${level}).`);

  // Inject level-specific prompt prefix
  if (levelCfg.promptPrefix.length > 0) {
    lines.push("");
    for (const line of levelCfg.promptPrefix) lines.push(line);
    lines.push("");
  }

  if (mode === "bridge") {
    lines.push("Use bridge execution for this program when inspecting scene/project internals.");
  } else if (mode === "headless") {
    lines.push("No live GUI bridge is available. Use execute_command and rely on headless CLI fallback (for Houdini this should route through hython when configured).");
    lines.push("If headless execution fails, continue with deep filesystem analysis and still write detailed outputs.");
  } else {
    lines.push("No live bridge is available. Perform deep filesystem analysis directly from files/folders.");
    lines.push("Do NOT skip analysis because bridge tools are unavailable.");
  }
  lines.push("Perform deep analysis but keep outputs in your final response only.");
  lines.push("CRITICAL: Do NOT create, write, or save ANY files inside source project folders.");
  lines.push("If you must write temporary files, use the current working directory (your projectRoot), NEVER the source paths.");
  lines.push("All analysis output (logs, params, JSON, markdown) must go in your final response text, never to disk in source folders.");
  lines.push("");
  if (trainingPrompt.trim()) {
    lines.push("Training objective from user:");
    for (const line of trainingPrompt.split("\n").map((value) => value.trim()).filter(Boolean)) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }
  lines.push("Source paths:");
  for (const sourcePath of sourcePaths) {
    lines.push(`- ${sourcePath}`);
  }
  lines.push("");
  lines.push("For each discovered project:");
  lines.push("1) Include concrete findings: pipeline decisions, key nodes/components, validation checks, caveats.");
  lines.push("2) Do not write generic boilerplate; base conclusions on inspected files/scene data.");
  lines.push("3) Include explicit file references (relative paths) backing each major conclusion.");
  lines.push("4) Return a structured JSON block and markdown analysis in the final response.");
  lines.push("");
  lines.push("JSON config requirements:");
  lines.push("- version: 1");
  lines.push(`- program: \"${program}\"`);
  lines.push("- projectName");
  lines.push("- projectPath");
  lines.push("- prompt (detailed workflow guidance)");
  lines.push("- contexts[] with focused reusable patterns if applicable");
  lines.push("- updatedAt (ISO datetime)");
  lines.push("");
  lines.push("Notes markdown requirements:");
  lines.push("- Purpose summary");
  lines.push("- Detailed findings");
  lines.push("- Practical reuse instructions");
  lines.push("- Risks / when not to reuse");
  lines.push("");
  lines.push("At the end, print a concise summary with counts: discovered, created, updated, skipped.");
  return lines.join("\n");
}

async function waitForCoordinatorTrainingJobTerminalState(
  jobsRepo: JobsRepo,
  jobId: string,
  timeoutMs = TRAINING_AGENTIC_ANALYSIS_TIMEOUT_MS,
  pollMs = TRAINING_AGENTIC_STATUS_POLL_MS,
): Promise<CoordinatorTrainingJobTerminalState> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const job = jobsRepo.getById(jobId);
    if (!job) return { status: "missing" };
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return { status: job.status, error: job.error, logs: job.logs ?? "" };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { status: "timeout" };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isCoordinatorTrainingJob(job: Job, program?: string): boolean {
  const metadata = job.editorContext?.metadata as Record<string, unknown> | undefined;
  const marked = metadata?.coordinator_training_job === true;
  if (!marked) return false;
  if (!program) return true;
  const target = String(metadata?.coordinator_training_program ?? "").trim().toLowerCase();
  return target === String(program ?? "").trim().toLowerCase();
}

export function generateCoordinatorTraining(
  options: GenerateCoordinatorTrainingOptions,
): CoordinatorTrainingResult {
  const {
    program,
    coordinatorScriptsDir,
    coordinatorPlaybooksDir,
    settingsRepo,
    defaultCoordinatorPlaybookSourcePaths = [],
    sourcePaths: inputPaths,
    trainingPrompt,
    apply = false,
    seedSummaries = [],
    skipSourceScan = false,
    trainingLevel = "medium" as TrainingLevel,
  } = options;
  const levelCfg = TRAINING_LEVEL_CONFIG[trainingLevel];
  const normalizedTrainingPrompt = normalizeTrainingPrompt(trainingPrompt);

  const sourcePaths = resolveTrainingSourcePaths(
    settingsRepo,
    defaultCoordinatorPlaybookSourcePaths,
    coordinatorPlaybooksDir,
    program,
    inputPaths,
  );
  const summaries: CoordinatorTrainingSummary[] = [];
  const seenProjects = new Set<string>();

  for (const seed of seedSummaries) {
    const name = String(seed?.name ?? "").trim();
    const path = String(seed?.path ?? "").trim();
    const summary = parsePromptSummary(String(seed?.summary ?? ""), levelCfg.summaryCharLimit)
      || "Use this project as a style and architecture reference.";
    if (!name || !path) continue;
    const dedupeKey = `${name}::${path}`;
    if (seenProjects.has(dedupeKey)) continue;
    seenProjects.add(dedupeKey);
    summaries.push({ name, path, summary });
  }

  if (!skipSourceScan) {
    for (const sourcePath of sourcePaths) {
      if (!existsSync(sourcePath)) continue;
      if (isLikelyLearningVaultPath(sourcePath)) {
        const learningSummaries = collectLearningVaultSummaries(program, sourcePath);
        if (learningSummaries.length > 0) {
          for (const summary of learningSummaries) {
            const dedupeKey = `${summary.name}::${summary.path}`;
            if (seenProjects.has(dedupeKey)) continue;
            seenProjects.add(dedupeKey);
            summaries.push(summary);
          }
          continue;
        }
      }
      let st;
      try {
        st = statSync(sourcePath);
      } catch {
        continue;
      }
      const projectDirs = st.isDirectory()
        ? discoverProjectDirs(program, sourcePath, levelCfg.discoveryDepth, levelCfg.discoveryMaxProjects)
        : st.isFile()
        ? [resolveProjectDirFromSourceFile(program, sourcePath)].filter((p): p is string => !!p)
        : [];
      for (const projectDir of projectDirs) {
        if (seenProjects.has(projectDir)) continue;
        seenProjects.add(projectDir);

        const configPath = resolveProjectConfigPath(projectDir);
        const config = configPath && existsSync(configPath)
          ? readProjectConfig(configPath)
          : readProjectConfigFromNotes(program, projectDir);
        const prompt = String(config?.prompt ?? "").trim()
          || summarizeContextsPrompt(config)
          || readDocSnippet(projectDir, 380);
        const summary = parsePromptSummary(prompt, levelCfg.summaryCharLimit);
        summaries.push({
          name: String(config?.projectName ?? basename(projectDir)).trim() || basename(projectDir),
          path: projectDir,
          summary: summary || "Use this project as a style and architecture reference.",
        });
      }
    }
  }

  // When no project references are found (e.g. first-time training with an
  // empty vault and no configured source paths), produce a minimal training
  // block with source path metadata rather than crashing the job.
  if (summaries.length === 0 && sourcePaths.length > 0) {
    for (const sp of sourcePaths.slice(0, 5)) {
      summaries.push({
        name: basename(sp) || sp,
        path: sp,
        summary: "Source path registered for future training. No project references discovered yet.",
      });
    }
  }
  if (summaries.length === 0) {
    throw new Error(
      "No analyzable project references found for training. "
      + "Configure source paths under Coordinator → Playbook Sources, or provide them when submitting the training job.",
    );
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name));
  const generatedAt = new Date().toISOString();
  const trainingLines: string[] = [];
  trainingLines.push(`Auto-generated ${generatedAt}`);
  if (normalizedTrainingPrompt) {
    trainingLines.push("Training objective provided by user:");
    for (const line of normalizedTrainingPrompt.split("\n").map((part) => part.trim()).filter(Boolean).slice(0, 40)) {
      trainingLines.push(`- ${line}`);
    }
  }
  trainingLines.push("Use the following project references when planning and validating tasks:");
  for (const item of summaries.slice(0, 40)) {
    trainingLines.push(`- ${item.name} (${item.path}): ${item.summary}`);
  }

  const scriptPath = resolveScriptPath(coordinatorScriptsDir, program);
  const currentScript = existsSync(scriptPath)
    ? readFileSync(scriptPath, "utf-8")
    : getCoordinatorScriptDefault(program);
  const suggestedScript = mergeTrainingBlock(currentScript ?? "", trainingLines.join("\n"));
  const scriptUpdated = suggestedScript !== (currentScript ?? "");

  if (apply && scriptUpdated) {
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, suggestedScript, "utf-8");
  }

  const playbookPath = resolvePlaybookPath(coordinatorPlaybooksDir, program);
  let playbookUpdated = false;
  try {
    if (existsSync(playbookPath)) {
      const raw = readFileSync(playbookPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const trainingSnapshot = {
          updatedAt: generatedAt,
          sourcePaths,
          trainingPrompt: normalizedTrainingPrompt || undefined,
          projectCount: summaries.length,
          references: summaries.slice(0, 40).map((item) => ({
            name: item.name,
            path: item.path,
            summary: item.summary,
          })),
        };
        const next = {
          ...parsed,
          training: trainingSnapshot,
        };
        const serialized = `${JSON.stringify(next, null, 2)}\n`;
        playbookUpdated = serialized !== raw;
        if (apply && playbookUpdated) {
          mkdirSync(dirname(playbookPath), { recursive: true });
          writeFileSync(playbookPath, serialized, "utf-8");
        }
      }
    }
  } catch {
    playbookUpdated = false;
  }

  // Rebuild searchable training repository index from current learning + source inputs.
  try {
    const policy = parseTrainingRepositoryPolicy(
      settingsRepo.get(TRAINING_REPOSITORY_POLICY_SETTINGS_KEY),
    );
    const overrides = parseTrainingRepositoryOverrides(
      settingsRepo.get(TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY),
    );
    scheduleTrainingRepositoryIndexRefresh({
      dir: coordinatorPlaybooksDir,
      program,
      sourcePaths,
      trainingObjective: normalizedTrainingPrompt || undefined,
      policy,
      overrides,
      reason: "training_generation",
      debounceMs: 80,
    });
    // Training generation is an explicit user flow; flush once so retrieval is
    // immediately consistent for follow-up jobs.
    void flushTrainingRepositoryIndexRefresh({
      dir: coordinatorPlaybooksDir,
      program,
    });
  } catch (err: any) {
    logger.warn(
      "coordinator-training",
      `Failed to refresh training repository index for ${program}: ${String(err?.message ?? err)}`,
    );
  }

  // Write training patterns to skills DB
  if (options.skillsRepo) {
    try {
      const trainingBlockText = trainingLines.join("\n");
      options.skillsRepo.upsertBySlugAndProgram({
        slug: `training-${program}-patterns`,
        name: `${program.charAt(0).toUpperCase() + program.slice(1)} Training Patterns`,
        program,
        category: "training",
        title: `${program.charAt(0).toUpperCase() + program.slice(1)} Training Patterns`,
        description: `Auto-generated training patterns for ${program}`,
        content: trainingBlockText,
        source: "training",
      });
      logger.info("coordinator-training", `Wrote training patterns skill for ${program} to skills DB`);
    } catch (err: any) {
      logger.warn("coordinator-training", `Failed to write training skill for ${program}: ${String(err?.message ?? err)}`);
    }
  }

  return {
    program,
    apply,
    generatedAt,
    projectCount: summaries.length,
    sourcePaths,
    suggestedScript,
    scriptPath,
    scriptUpdated,
    playbookPath,
    playbookUpdated,
    summaries,
  };
}

/**
 * Extract skill blocks from job logs. Parses ```skill fenced blocks with
 * frontmatter (slug, program, category, title) separated by --- from content.
 */
export function extractSkillBlocksFromLogs(logs: string): Array<{
  slug: string; program: string; category: string; title: string; content: string;
}> {
  const results: Array<{ slug: string; program: string; category: string; title: string; content: string }> = [];
  const regex = /```skill\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(logs)) !== null) {
    const block = match[1].trim();
    const lines = block.split("\n");
    const frontmatter: Record<string, string> = {};
    let contentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "---") { contentStart = i + 1; break; }
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        frontmatter[key] = value;
        contentStart = i + 1;
      } else {
        break;
      }
    }
    const slug = frontmatter.slug || "";
    const program = frontmatter.program || "global";
    const category = frontmatter.category || "housekeeping";
    const title = frontmatter.title || slug;
    const content = lines.slice(contentStart).join("\n").trim();
    if (slug && content) {
      results.push({ slug, program, category, title, content });
    }
  }
  return results;
}

/**
 * Unified training orchestrator — creates a single parent job that:
 * 1. Auto-detects programs from source paths (or uses explicit list)
 * 2. Fans out per-program training children
 * 3. Waits for all children to complete
 * 4. Optionally chains a housekeeping job afterward
 * 5. Extracts skills from housekeeping output
 */
export function queueTrainingOrchestrator(
  deps: QueueCoordinatorTrainingJobDeps & { housekeepingDeps?: HousekeepingDeps },
  options: Omit<QueueCoordinatorTrainingJobOptions, "program"> & {
    programs?: string[];
    chainHousekeeping?: boolean;
  },
): Job {
  // 1. Create orchestrator job
  const jobInput: JobSubmit = {
    name: "[Training] Auto-detect & train",
    prompt: "Training orchestrator — coordinates per-program training and housekeeping.",
    agentConfigId: resolveTrainingAgentId(deps.agentsRepo, deps.settingsRepo, ""),
    priority: "normal",
    coordinationMode: "server",
    files: [],
    contextItems: [],
    editorContext: {
      projectRoot: deps.coordinatorPlaybooksDir,
      metadata: {
        coordinator_training_orchestrator: true,
        coordinator_training_trigger: options.trigger,
      },
    },
  };

  const created = deps.jobsRepo.create(jobInput);
  const claimed = deps.jobsRepo.claim(created.id);
  if (!claimed) throw new Error("Failed to start training orchestrator");
  broadcastJobUpdated(deps.hub, deps.jobsRepo, created.id);
  appendJobLog(deps.hub, deps.jobsRepo, created.id, "Training orchestrator started.");

  // 2. Async handler
  setTimeout(() => {
    void (async () => {
      try {
        // Detect programs
        const programDeps: ProgramDiscoveryDeps = {
          coordinatorScriptsDir: deps.coordinatorScriptsDir,
          hub: deps.hub,
          headlessProgramsRepo: deps.headlessProgramsRepo,
        };
        let programs: string[];
        if (Array.isArray(options.programs) && options.programs.length > 0) {
          const known = new Set(getCoordinatorScriptPrograms(programDeps).map((p) => p.toLowerCase()));
          programs = [...new Set(options.programs.map((p) => p.trim().toLowerCase()).filter(Boolean))].filter((p) => known.has(p));
        } else {
          const sourcePaths = Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0
            ? options.sourcePaths
            : resolveTrainingSourcePaths(
                deps.settingsRepo,
                deps.defaultCoordinatorPlaybookSourcePaths ?? [],
                deps.coordinatorPlaybooksDir,
                "global",
                undefined,
              );
          const known = getCoordinatorScriptPrograms(programDeps).map((p) => p.toLowerCase());
          appendJobLog(deps.hub, deps.jobsRepo, created.id, `Source paths (${sourcePaths.length}): ${sourcePaths.join(", ")}`);
          appendJobLog(deps.hub, deps.jobsRepo, created.id, `Known programs: ${known.join(", ")}`);
          programs = detectProgramsInPaths(sourcePaths, known);
        }

        if (programs.length === 0) {
          throw new Error("No programs detected in source paths.");
        }
        appendJobLog(deps.hub, deps.jobsRepo, created.id, `Detected programs: ${programs.join(", ")}`);

        // Queue per-program training children
        const children: Array<{ program: string; jobId: string }> = [];
        const failures: Array<{ program: string; error: string }> = [];
        for (const program of programs) {
          try {
            const child = queueCoordinatorTrainingJob(deps, {
              ...options,
              program,
              parentJobId: created.id,
            });
            children.push({ program, jobId: child.id });
            appendJobLog(deps.hub, deps.jobsRepo, created.id, `Queued training for ${program}: ${child.id}`);
          } catch (err: any) {
            failures.push({ program, error: String(err?.message ?? err) });
            appendJobLog(deps.hub, deps.jobsRepo, created.id, `Failed to queue ${program}: ${err?.message}`);
          }
        }

        // Wait for all training children
        if (children.length > 0) {
          appendJobLog(deps.hub, deps.jobsRepo, created.id, `Waiting for ${children.length} training job(s)...`);
          for (const child of children) {
            const terminal = await waitForCoordinatorTrainingJobTerminalState(deps.jobsRepo, child.jobId, 60 * 60_000);
            appendJobLog(deps.hub, deps.jobsRepo, created.id, `Training ${child.program}: ${terminal.status}`);
          }
        }

        // Chain housekeeping
        const chainHousekeeping = options.chainHousekeeping !== false;
        if (chainHousekeeping && deps.housekeepingDeps) {
          appendJobLog(deps.hub, deps.jobsRepo, created.id, "Chaining housekeeping job...");
          const hkResult = queueHousekeepingJob(deps.housekeepingDeps, {
            submittedBy: options.submittedBy,
            parentJobId: created.id,
          });
          if (hkResult) {
            appendJobLog(deps.hub, deps.jobsRepo, created.id, `Housekeeping queued: ${hkResult.jobId}`);
            const hkTerminal = await waitForCoordinatorTrainingJobTerminalState(deps.jobsRepo, hkResult.jobId, 30 * 60_000);
            appendJobLog(deps.hub, deps.jobsRepo, created.id, `Housekeeping: ${hkTerminal.status}`);

            // Extract skills from housekeeping logs
            if (hkTerminal.status === "completed" && hkTerminal.logs && deps.skillsRepo) {
              const extracted = extractSkillBlocksFromLogs(hkTerminal.logs);
              let skillCount = 0;
              for (const skill of extracted) {
                try {
                  deps.skillsRepo.upsertBySlugAndProgram({
                    slug: skill.slug,
                    name: skill.title,
                    program: skill.program,
                    category: skill.category || "housekeeping",
                    title: skill.title,
                    description: `Auto-generated by housekeeping`,
                    content: skill.content,
                    source: "housekeeping",
                  });
                  skillCount++;
                } catch { /* skip individual skill failures */ }
              }
              if (skillCount > 0) {
                appendJobLog(deps.hub, deps.jobsRepo, created.id, `Extracted ${skillCount} skill(s) from housekeeping.`);
              }
            }
          } else {
            appendJobLog(deps.hub, deps.jobsRepo, created.id, "Housekeeping skipped (no agent available).");
          }
        }

        // Complete orchestrator
        const summary = `Training completed. Programs: ${children.map((c) => c.program).join(", ")}. Failures: ${failures.length}.`;
        appendJobLog(deps.hub, deps.jobsRepo, created.id, summary);
        const logs = deps.jobsRepo.getById(created.id)?.logs ?? "";
        deps.jobsRepo.complete(created.id, [], logs);
        broadcastJobUpdated(deps.hub, deps.jobsRepo, created.id);
      } catch (err: any) {
        const message = String(err?.message ?? err ?? "Unknown orchestrator error");
        appendJobLog(deps.hub, deps.jobsRepo, created.id, `Failed: ${message}`);
        const logs = deps.jobsRepo.getById(created.id)?.logs ?? "";
        deps.jobsRepo.fail(created.id, message, logs);
        broadcastJobUpdated(deps.hub, deps.jobsRepo, created.id);
      }
    })();
  }, 0);

  return deps.jobsRepo.getById(created.id) ?? created;
}

/** @deprecated Use {@link queueTrainingOrchestrator} instead. */
export function fanOutTrainingByProgram(
  deps: QueueCoordinatorTrainingJobDeps,
  options: Omit<QueueCoordinatorTrainingJobOptions, "program"> & { programs?: string[] },
): { queued: Array<{ program: string; jobId: string; job: Job }>; failures: Array<{ program: string; error: string }> } {
  const programDeps: ProgramDiscoveryDeps = {
    coordinatorScriptsDir: deps.coordinatorScriptsDir,
    hub: deps.hub,
    headlessProgramsRepo: deps.headlessProgramsRepo,
  };

  let programs: string[];
  if (Array.isArray(options.programs) && options.programs.length > 0) {
    const knownPrograms = new Set(getCoordinatorScriptPrograms(programDeps).map((p) => p.toLowerCase()));
    programs = [...new Set(options.programs.map((p) => String(p ?? "").trim().toLowerCase()).filter(Boolean))]
      .filter((p) => knownPrograms.has(p));
  } else {
    const sourcePaths = Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0
      ? options.sourcePaths
      : resolveTrainingSourcePaths(
          deps.settingsRepo,
          deps.defaultCoordinatorPlaybookSourcePaths ?? [],
          deps.coordinatorPlaybooksDir,
          "global",
          undefined,
        );
    const knownPrograms = getCoordinatorScriptPrograms(programDeps).map((p) => p.toLowerCase());
    programs = detectProgramsInPaths(sourcePaths, knownPrograms);
    if (programs.length > 0) {
      logger.info(
        "coordinator-training",
        `Auto-detected programs from source paths: ${programs.join(", ")}`,
      );
    }
  }

  const queued: Array<{ program: string; jobId: string; job: Job }> = [];
  const failures: Array<{ program: string; error: string }> = [];

  for (const program of programs) {
    try {
      const job = queueCoordinatorTrainingJob(deps, { ...options, program });
      queued.push({ program, jobId: job.id, job });
    } catch (err: any) {
      failures.push({ program, error: String(err?.message ?? err) });
    }
  }

  return { queued, failures };
}

export function queueCoordinatorTrainingJob(
  deps: QueueCoordinatorTrainingJobDeps,
  options: QueueCoordinatorTrainingJobOptions,
): Job {
  const {
    jobsRepo,
    agentsRepo,
    settingsRepo,
    headlessProgramsRepo,
    hub,
    coordinatorScriptsDir,
    coordinatorPlaybooksDir,
    defaultCoordinatorPlaybookSourcePaths = [],
  } = deps;
  const { program, trigger, sourcePaths, submittedBy } = options;
  const trainingLevel: TrainingLevel = TRAINING_LEVELS.includes(options.trainingLevel as TrainingLevel)
    ? (options.trainingLevel as TrainingLevel) : "medium";
  const targetWorkerName = String(options.targetWorkerName ?? "").trim();
  const apply = options.apply !== false;
  const trainingPrompt = normalizeTrainingPrompt(options.trainingPrompt, 2_000);
  const preferredAgentConfigId = String(options.agentConfigId ?? "").trim();
  const normalizedProgram = String(program ?? "").trim().toLowerCase();
  const programDeps: ProgramDiscoveryDeps = { coordinatorScriptsDir, hub, headlessProgramsRepo };
  if (!normalizeProgramList([normalizedProgram], programDeps).includes(normalizedProgram)) {
    throw new Error(`Invalid coordinator program: ${program}`);
  }

  // Scheduled training always includes configured source paths alongside vault
  // learning data. This ensures real project references are always available,
  // not just internal training artifacts.
  let resolvedSourcePaths: string[];
  if (Array.isArray(sourcePaths) && sourcePaths.length > 0) {
    resolvedSourcePaths = resolveTrainingSourcePaths(
      settingsRepo,
      defaultCoordinatorPlaybookSourcePaths,
      coordinatorPlaybooksDir,
      normalizedProgram,
      sourcePaths,
    );
  } else if (trigger === "scheduled") {
    // Merge vault paths with configured source paths
    const vaultPaths = resolveScheduledVaultSourcePaths(coordinatorPlaybooksDir, normalizedProgram);
    const configuredPaths = resolveTrainingSourcePaths(
      settingsRepo,
      defaultCoordinatorPlaybookSourcePaths,
      coordinatorPlaybooksDir,
      normalizedProgram,
      undefined, // let it read from settings
    );
    resolvedSourcePaths = [...new Set([...configuredPaths, ...vaultPaths])];
  } else {
    // Manual trigger: read configured paths first, then fall back to vault
    // learning data when no configured paths exist.  Without this fallback the
    // job immediately fails with "No analyzable project references" when the
    // user hasn't explicitly set coordinator_playbook_sources.
    const configuredPaths = resolveTrainingSourcePaths(
      settingsRepo,
      defaultCoordinatorPlaybookSourcePaths,
      coordinatorPlaybooksDir,
      normalizedProgram,
      undefined,
    );
    if (configuredPaths.length > 0) {
      resolvedSourcePaths = configuredPaths;
    } else {
      const vaultPaths = resolveScheduledVaultSourcePaths(coordinatorPlaybooksDir, normalizedProgram);
      resolvedSourcePaths = [...new Set([...configuredPaths, ...vaultPaths])];
    }
  }

  const agentConfigId = resolveTrainingAgentId(agentsRepo, settingsRepo, preferredAgentConfigId);
  const now = new Date().toISOString();
  const fallbackProjectRoot = resolvedSourcePaths[0] ?? coordinatorPlaybooksDir;
  const promptSummary = parsePromptSummary(trainingPrompt, 180);
  const jobInput: JobSubmit = {
    name: `[Coordinator] Train ${normalizedProgram} Script (${trigger})`,
    prompt: promptSummary
      ? `Coordinator training job for ${normalizedProgram}. apply=${apply}. objective=${promptSummary}`
      : `Coordinator training job for ${normalizedProgram}. apply=${apply}.`,
    agentConfigId,
    priority: "normal",
    coordinationMode: "server",
    files: [],
    contextItems: [],
    editorContext: {
      projectRoot: fallbackProjectRoot,
      metadata: {
        coordinator_training_job: true,
        coordinator_training_program: normalizedProgram,
        coordinator_training_trigger: trigger,
        coordinator_training_apply: apply,
        coordinator_training_source_paths: resolvedSourcePaths,
        coordinator_training_prompt: trainingPrompt || undefined,
        coordinator_training_level: trainingLevel,
        coordinator_training_agent_config_id: agentConfigId,
        coordinator_training_target_worker_name: targetWorkerName || undefined,
      },
    },
  };
  const created = jobsRepo.create(
    jobInput,
    undefined,
    normalizedProgram,
    undefined,
    targetWorkerName || undefined,
    submittedBy,
    options.parentJobId,
  );
  const claimed = jobsRepo.claim(created.id);
  if (!claimed) {
    throw new Error("Failed to start coordinator training job");
  }
  broadcastJobUpdated(hub, jobsRepo, created.id);
  appendJobLog(
    hub,
    jobsRepo,
    created.id,
    `Starting coordinator training for ${normalizedProgram} (${trigger}). Source paths: ${resolvedSourcePaths.length}`,
  );
  if (targetWorkerName) {
    appendJobLog(hub, jobsRepo, created.id, `Target worker: ${targetWorkerName}`);
  }
  if (trainingPrompt) {
    appendJobLog(hub, jobsRepo, created.id, `Training objective: ${parsePromptSummary(trainingPrompt, 300)}`);
  }
  appendJobLog(hub, jobsRepo, created.id, `Training level: ${trainingLevel}`);
  appendJobLog(hub, jobsRepo, created.id, `Training agent config: ${agentConfigId}`);

  setTimeout(() => {
    void (async () => {
      let projectFileBaselines: TrainingProjectFileBaseline[] = [];
      let projectFileRestoreSummary: { restored: number; removed: number; failed: number } | null = null;
      const restoreProjectFiles = (): { restored: number; removed: number; failed: number } => {
        if (projectFileRestoreSummary) return projectFileRestoreSummary;
        if (projectFileBaselines.length === 0) {
          projectFileRestoreSummary = { restored: 0, removed: 0, failed: 0 };
          return projectFileRestoreSummary;
        }
        projectFileRestoreSummary = restoreTrainingProjectFileBaselines(projectFileBaselines);
        return projectFileRestoreSummary;
      };
      try {
        let analysisJobId = "";
        let analysisStatus = "skipped";
        let analysisModeUsed: "bridge" | "headless" | "filesystem" | "skipped" = "skipped";
        let seededFromAgenticAnalysis: AgenticTrainingSeed = { summaries: [], projects: [], notes: [] };
        const artifactNotes: string[] = [];
        const shouldRunAgenticAnalysis = trigger === "manual"
          && resolvedSourcePaths.length > 0
          && resolvedSourcePaths.some((path) => !isLikelyLearningVaultPath(path));

        if (shouldRunAgenticAnalysis) {
          const levelCfg = TRAINING_LEVEL_CONFIG[trainingLevel];
          projectFileBaselines = captureTrainingProjectFileBaselines(normalizedProgram, resolvedSourcePaths);
          const bridgeOnline = hub.getBridges().some(
            (bridge) => String(bridge.program ?? "").trim().toLowerCase() === normalizedProgram,
          );
          const headlessEnabled = headlessProgramsRepo?.getByProgram(normalizedProgram)?.enabled === true;
          // Headless mode requires a desktop client connected for the target worker.
          // If no bridge is online (which implies no client on that worker), headless
          // dispatch will fail. Fall back to bridge or filesystem in that case.
          const headlessViable = headlessEnabled && (bridgeOnline || !!targetWorkerName);
          // Training should prefer headless CLI to avoid interfering with user's live session.
          // Priority: headless (if viable) > bridge (live) > filesystem
          const autoMode: "bridge" | "headless" | "filesystem" = headlessViable
            ? "headless"
            : bridgeOnline
            ? "bridge"
            : "filesystem";
          // Training level can force filesystem mode (e.g. "low" level skips bridge)
          const analysisMode: "bridge" | "headless" | "filesystem" = levelCfg.forceAnalysisMode ?? autoMode;
          analysisModeUsed = analysisMode;
          if (analysisMode === "bridge") {
            appendJobLog(
              hub,
              jobsRepo,
              created.id,
              `Agentic source analysis mode: bridge (${normalizedProgram} bridge online).`,
            );
          } else if (analysisMode === "headless") {
            appendJobLog(
              hub,
              jobsRepo,
              created.id,
              `Agentic source analysis mode: headless (${normalizedProgram} CLI preferred for training to avoid interfering with live sessions).`,
            );
          } else {
            appendJobLog(
              hub,
              jobsRepo,
              created.id,
              `Agentic source analysis mode: filesystem (${normalizedProgram} bridge/headless unavailable).`,
            );
          }

          if (analysisMode === "filesystem") {
            analysisStatus = "filesystem-fallback";
            const message = `Agentic source analysis fallback: no online ${normalizedProgram} bridge or enabled headless CLI program. Continuing with direct filesystem summarization.`;
            artifactNotes.push(message);
            appendJobLog(hub, jobsRepo, created.id, message);
          } else {
            // Create a server-side working directory for the analysis job so
            // the agent writes any temporary files there instead of polluting
            // the user's actual project directory.
            const analysisWorkDir = join(
              coordinatorPlaybooksDir,
              "_learning",
              "analysis-work",
              normalizedProgram,
              created.id,
            );
            mkdirSync(analysisWorkDir, { recursive: true });

            const analysisMetadata: Record<string, unknown> = {
              coordinator_analysis_mode: "ai",
              coordinator_training_analysis_job: true,
              coordinator_training_parent_job_id: created.id,
              coordinator_training_source_paths: resolvedSourcePaths,
              coordinator_training_prompt: trainingPrompt || undefined,
              coordinator_training_analysis_mode: analysisMode,
              coordinator_training_level: trainingLevel,
              coordinator_training_work_dir: analysisWorkDir,
              target_bridges: [normalizedProgram],
              bridge_type: normalizedProgram,
            };

            const analysisInput: JobSubmit = {
              name: `[Coordinator] Analyze ${normalizedProgram} training sources`,
              prompt: buildTrainingAgenticAnalyzePrompt(normalizedProgram, resolvedSourcePaths, trainingPrompt, analysisMode, trainingLevel),
              agentConfigId,
              priority: "normal",
              coordinationMode: "server",
              files: [],
              contextItems: [],
              runtimeOptions: analysisMode === "headless"
                ? { bridgeExecutionMode: "headless" as const }
                : undefined,
              editorContext: {
                projectRoot: analysisWorkDir,
                metadata: analysisMetadata,
              },
            };
            const analysisJob = jobsRepo.create(
              analysisInput,
              undefined,
              normalizedProgram,
              undefined,
              targetWorkerName || undefined,
              submittedBy,
              created.id,
            );
            analysisJobId = analysisJob.id;
            analysisStatus = "queued";
            appendJobLog(
              hub,
              jobsRepo,
              created.id,
              `Queued agentic source analysis job ${analysisJobId} for ${resolvedSourcePaths.length} path(s).`,
            );
            broadcastJobUpdated(hub, jobsRepo, analysisJobId);
            const analysisTimeoutMs = Math.round(TRAINING_AGENTIC_ANALYSIS_TIMEOUT_MS * levelCfg.timeoutMultiplier);
            // Suspend our process tracker slot so the child analysis job can
            // be dispatched even when maxConcurrent=1.
            if (deps.processTracker) {
              deps.processTracker.suspend(created.id);
              appendJobLog(hub, jobsRepo, created.id, `Suspended concurrency slot for child analysis dispatch.`);
            }
            const terminal = await waitForCoordinatorTrainingJobTerminalState(jobsRepo, analysisJobId, analysisTimeoutMs);
            // Re-acquire our slot after the child completes.
            if (deps.processTracker) {
              deps.processTracker.resume(created.id);
            }
            analysisStatus = terminal.status;
            // If the child job "failed" but the agent actually completed (logs contain [done]),
            // still try to extract training data. Bridge timeouts can mark a job as failed even
            // when the agent produced full output.
            const agentActuallyCompleted = terminal.logs?.includes("[done]") ?? false;
            if (terminal.status !== "completed" && !agentActuallyCompleted) {
              const detail = terminal.error ? ` (${terminal.error})` : "";
              throw new Error(`Agentic source analysis ${terminal.status}${detail}`.trim());
            }
            if (terminal.status !== "completed" && agentActuallyCompleted) {
              appendJobLog(
                hub,
                jobsRepo,
                created.id,
                `Analysis job ${analysisJobId} marked as ${terminal.status} but agent completed. Extracting training data from logs.`,
              );
            }
            const logsTail = String(terminal.logs ?? "").trim();
            if (logsTail) {
              artifactNotes.push(`Analysis logs tail: ${logsTail.slice(-TRAINING_CHILD_LOG_TAIL_CHARS)}`);
            }
            seededFromAgenticAnalysis = extractAgenticTrainingSeed(
              normalizedProgram,
              resolvedSourcePaths,
              terminal.logs ?? "",
              trainingPrompt,
            );
            if (seededFromAgenticAnalysis.blockedReason) {
              throw new Error(`Agentic source analysis reported a blocker: ${seededFromAgenticAnalysis.blockedReason}`);
            }
            if (seededFromAgenticAnalysis.summaries.length === 0) {
              throw new Error("Agentic source analysis completed without reusable training summaries.");
            }
            if (seededFromAgenticAnalysis.summaries.length > 0) {
              appendJobLog(
                hub,
                jobsRepo,
                created.id,
                `Seeded ${seededFromAgenticAnalysis.summaries.length} training reference(s) from agentic analysis artifacts.`,
              );
              artifactNotes.push(...seededFromAgenticAnalysis.notes);
            }
            appendJobLog(hub, jobsRepo, created.id, `Agentic source analysis completed via job ${analysisJobId}.`);
          }
        } else {
          artifactNotes.push("Agentic source analysis skipped for scheduled or learning-only sources.");
        }

        const result = generateCoordinatorTraining({
          program: normalizedProgram,
          coordinatorScriptsDir,
          coordinatorPlaybooksDir,
          settingsRepo,
          skillsRepo: deps.skillsRepo,
          defaultCoordinatorPlaybookSourcePaths,
          sourcePaths: resolvedSourcePaths,
          trainingPrompt,
          apply,
          seedSummaries: seededFromAgenticAnalysis.summaries,
          skipSourceScan: analysisModeUsed === "bridge",
          trainingLevel,
        });
        const scannedProjectDetails = collectTrainingProjectDetails(
          normalizedProgram,
          result.sourcePaths,
          120,
        );
        const projectDetails = scannedProjectDetails.length > 0
          ? scannedProjectDetails
          : seededFromAgenticAnalysis.projects;
        const artifact: CoordinatorTrainingArtifact = {
          version: 1,
          source: "coordinator_training_job",
          job: {
            id: created.id,
            program: normalizedProgram,
            trigger,
            apply,
            createdAt: created.createdAt,
            generatedAt: result.generatedAt,
            analysisJobId: analysisJobId || undefined,
            analysisStatus,
          },
          objective: trainingPrompt || undefined,
          projectCount: result.projectCount,
          sourcePaths: result.sourcePaths,
          summaries: result.summaries,
          projects: projectDetails,
          outputs: {
            scriptPath: result.scriptPath,
            scriptUpdated: result.scriptUpdated,
            playbookPath: result.playbookPath,
            playbookUpdated: result.playbookUpdated,
          },
          notes: [
            ...artifactNotes,
            ...(analysisModeUsed === "bridge"
              ? ["Bridge-mode training used artifact-derived summaries and skipped server filesystem scanning."]
              : []),
          ],
        };
        const latestJobState = jobsRepo.getById(created.id) ?? created;
        const artifactPaths = writeTrainingArtifact({
          coordinatorPlaybooksDir,
          settingsRepo,
          jobId: created.id,
          artifact,
          metadataActor: {
            id: String(latestJobState.submittedBy ?? "").trim() || null,
            workerName: String(latestJobState.workerName ?? latestJobState.targetWorkerName ?? "").trim() || null,
          },
        });
        try {
          const policy = parseTrainingRepositoryPolicy(
            settingsRepo.get(TRAINING_REPOSITORY_POLICY_SETTINGS_KEY),
          );
          const overrides = parseTrainingRepositoryOverrides(
            settingsRepo.get(TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY),
          );
          scheduleTrainingRepositoryIndexRefresh({
            dir: coordinatorPlaybooksDir,
            program: normalizedProgram,
            sourcePaths: [
              ...result.sourcePaths,
              artifactPaths.jsonPath,
              artifactPaths.markdownPath,
            ],
            trainingObjective: trainingPrompt || undefined,
            policy,
            overrides,
            reason: "training_artifact",
            debounceMs: 80,
          });
          void flushTrainingRepositoryIndexRefresh({
            dir: coordinatorPlaybooksDir,
            program: normalizedProgram,
          });
        } catch (err: any) {
          appendJobLog(
            hub,
            jobsRepo,
            created.id,
            `Warning: failed to refresh training index after artifact write (${String(err?.message ?? err)})`,
          );
        }
        appendJobLog(
          hub,
          jobsRepo,
          created.id,
          `Training artifact JSON: ${artifactPaths.jsonVaultPath}`,
        );
        appendJobLog(
          hub,
          jobsRepo,
          created.id,
          `Training artifact Markdown: ${artifactPaths.markdownVaultPath}`,
        );
        if (artifactPaths.mirroredProjectFiles.length > 0) {
          appendJobLog(
            hub,
            jobsRepo,
            created.id,
            `Mirrored ${artifactPaths.mirroredProjectFiles.length} project analysis file(s) into training vault.`,
          );
        }
        appendJobLog(
          hub,
          jobsRepo,
          created.id,
          `Coordinator script: ${result.scriptUpdated ? "updated" : "no-change"} (${result.scriptPath})`,
        );
        appendJobLog(
          hub,
          jobsRepo,
          created.id,
          `Playbook snapshot: ${result.playbookUpdated ? "updated" : "no-change"} (${result.playbookPath})`,
        );
        const restoreSummary = restoreProjectFiles();
        if ((restoreSummary.restored + restoreSummary.removed + restoreSummary.failed) > 0) {
          appendJobLog(
            hub,
            jobsRepo,
            created.id,
            `Project analysis file cleanup: restored=${restoreSummary.restored}, removed=${restoreSummary.removed}, failed=${restoreSummary.failed}.`,
          );
        }
        // Create per-project skills with actual analysis content.
        // Merge projectDetails with training summaries so skills always have
        // content even when the agentic analysis produced minimal output.
        // Also include the analysis agent's output as rich skill content.
        const analysisContent = analysisJobId
          ? String(jobsRepo.getById(analysisJobId)?.logs ?? "").trim()
          : "";
        const skillSources = projectDetails.length > 0
          ? projectDetails
          : result.summaries.map((s) => ({
              projectPath: s.path,
              sourcePath: s.path,
              projectName: s.name,
              notesExcerpt: undefined as string | undefined,
              config: undefined as Record<string, unknown> | undefined,
              inventory: { files: [] as string[], sceneFiles: [] as string[] },
            }));
        appendJobLog(hub, jobsRepo, created.id, `Skill creation: skillsRepo=${!!deps.skillsRepo}, sources=${skillSources.length}, analysisContent=${analysisContent.length} chars`);
        if (deps.skillsRepo && skillSources.length > 0) {
          let skillCount = 0;
          for (let si = 0; si < skillSources.length; si++) {
            const project = skillSources[si];
            const projectName = String(project.projectName ?? "").trim();
            if (!projectName) continue;
            const slug = `project-${normalizedProgram}-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`;
            const contentParts: string[] = [];
            contentParts.push(`# ${projectName}`);
            contentParts.push(`**Program:** ${normalizedProgram}`);
            contentParts.push(`**Path:** ${project.projectPath}`);
            // Include training summary from the result if available
            const matchingSummary = result.summaries.find((s) => s.name === projectName || s.path === project.projectPath);
            if (matchingSummary?.summary) {
              contentParts.push("");
              contentParts.push("## Summary");
              contentParts.push(matchingSummary.summary);
            }
            if (project.notesExcerpt) {
              contentParts.push("");
              contentParts.push("## Analysis");
              contentParts.push(project.notesExcerpt);
            }
            const config = project.config as Record<string, unknown> | undefined;
            if (config?.prompt) {
              contentParts.push("");
              contentParts.push("## Conventions");
              contentParts.push(String(config.prompt));
            }
            if (config?.contexts && Array.isArray(config.contexts)) {
              for (const ctx of (config.contexts as Array<Record<string, unknown>>)) {
                const ctxName = String(ctx?.name ?? "").trim();
                const ctxPattern = String(ctx?.pattern ?? "").trim();
                if (ctxName && ctxPattern) {
                  contentParts.push(`- **${ctxName}:** ${ctxPattern}`);
                }
              }
            }
            if (project.inventory?.sceneFiles?.length) {
              contentParts.push("");
              contentParts.push(`## Scene Files`);
              for (const f of project.inventory.sceneFiles.slice(0, 20)) {
                contentParts.push(`- ${f}`);
              }
            }
            // Include the analysis agent's output — this is the actual
            // knowledge the agent extracted about the project
            if (analysisContent && si === 0) {
              // Extract useful sections from the agent's log output
              // (skip init/tool noise, keep analysis text)
              const usefulLines = analysisContent
                .split("\n")
                .filter((line) => {
                  const t = line.trim();
                  // Skip tool call noise and init lines
                  if (t.startsWith("[init]") || t.startsWith("[TodoWrite]") || t.startsWith("[ToolSearch]")) return false;
                  if (t.startsWith("[Bash]") || t.startsWith("[Read]") || t.startsWith("[Grep]")) return false;
                  if (t.startsWith("[thinking]")) return false;
                  if (!t) return false;
                  return true;
                })
                .slice(-80) // last 80 meaningful lines
                .join("\n")
                .trim();
              if (usefulLines.length > 100) {
                contentParts.push("");
                contentParts.push("## Agent Analysis Output");
                contentParts.push(usefulLines.slice(0, 6000));
              }
            }
            const content = contentParts.join("\n");
            try {
              deps.skillsRepo.upsertBySlugAndProgram({
                slug,
                name: `${projectName} (${normalizedProgram})`,
                program: normalizedProgram,
                category: "project-reference",
                title: `${projectName} — ${normalizedProgram} project reference`,
                description: `Learned patterns and structure from ${projectName}`,
                content,
                source: "training",
              });
              skillCount++;
              appendJobLog(hub, jobsRepo, created.id, `  → Skill created: ${slug} (${content.length} chars)`);
            } catch (err: any) {
              appendJobLog(hub, jobsRepo, created.id, `  → Skill FAILED: ${projectName}: ${String(err?.message ?? err)}`);
              logger.warn("coordinator-training", `Failed to write skill for ${projectName}: ${String(err?.message ?? err)}`);
            }
          }
          if (skillCount > 0) {
            appendJobLog(hub, jobsRepo, created.id, `Created ${skillCount} project reference skill(s) from training analysis.`);
          }
        }

        appendJobLog(
          hub,
          jobsRepo,
          created.id,
          `Completed training. Projects: ${result.projectCount}. Applied: ${apply ? "yes" : "no"}. Generated: ${result.generatedAt}`,
        );
        const logs = jobsRepo.getById(created.id)?.logs ?? "";
        jobsRepo.complete(
          created.id,
          buildTrainingCompletionFiles(result, {
            jsonPath: artifactPaths.jsonPath,
            markdownPath: artifactPaths.markdownPath,
            mirroredProjectFiles: artifactPaths.mirroredProjectFiles,
          }),
          logs,
        );
        broadcastJobUpdated(hub, jobsRepo, created.id);
      } catch (err: any) {
        const restoreSummary = restoreProjectFiles();
        if ((restoreSummary.restored + restoreSummary.removed + restoreSummary.failed) > 0) {
          appendJobLog(
            hub,
            jobsRepo,
            created.id,
            `Project analysis file cleanup: restored=${restoreSummary.restored}, removed=${restoreSummary.removed}, failed=${restoreSummary.failed}.`,
          );
        }
        const message = String(err?.message ?? err ?? "Unknown training error");
        appendJobLog(hub, jobsRepo, created.id, `Failed: ${message}`);
        const logs = jobsRepo.getById(created.id)?.logs ?? "";
        jobsRepo.fail(created.id, message, logs);
        broadcastJobUpdated(hub, jobsRepo, created.id);
        logger.warn("coordinator-training", `Training job ${created.id} failed: ${message}`);

        // Training failures are tracked in job records and vault — no need for
        // outcome skills that just say "Outcome: negative".
      }
    })();
  }, 0);

  const running = jobsRepo.getById(created.id);
  if (!running) throw new Error("Failed to load created training job");
  // Preserve createdAt for consistency in consumers.
  return { ...running, createdAt: created.createdAt, startedAt: running.startedAt ?? now };
}

export function runScheduledCoordinatorTrainingTick(
  deps: QueueCoordinatorTrainingJobDeps & { housekeepingDeps?: HousekeepingDeps },
): Array<{ program: string; jobId: string }> {
  const programDeps: ProgramDiscoveryDeps = {
    coordinatorScriptsDir: deps.coordinatorScriptsDir,
    hub: deps.hub,
    headlessProgramsRepo: deps.headlessProgramsRepo,
  };
  const schedule = getCoordinatorTrainingSchedule(deps.settingsRepo, programDeps);
  if (!schedule.enabled) return [];

  // Auto-detect programs from configured source paths when schedule has none
  let schedulePrograms = schedule.programs;
  if (schedulePrograms.length === 0) {
    const allSourcePaths = resolveTrainingSourcePaths(
      deps.settingsRepo,
      deps.defaultCoordinatorPlaybookSourcePaths ?? [],
      deps.coordinatorPlaybooksDir,
      "global",
      undefined,
    );
    const knownPrograms = getCoordinatorScriptPrograms(programDeps).map((p) => p.toLowerCase());
    schedulePrograms = detectProgramsInPaths(allSourcePaths, knownPrograms);
    if (schedulePrograms.length === 0) return [];
  }

  // Check if any training orchestrator or training job is already running
  const runningJobs = deps.jobsRepo.list(["queued", "running"]).jobs;
  const hasRunningTraining = runningJobs.some((job) => {
    const metadata = job.editorContext?.metadata as Record<string, unknown> | undefined;
    return metadata?.coordinator_training_orchestrator === true || isCoordinatorTrainingJob(job);
  });
  if (hasRunningTraining) return [];

  // Check per-program timing — only start if at least one program is due
  const lastRunByProgram = getCoordinatorTrainingLastRunByProgram(deps.settingsRepo);
  const now = new Date();
  const nowMs = now.getTime();
  const duePrograms: string[] = [];

  for (const program of schedulePrograms) {
    const lastIso = lastRunByProgram[program];
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const dueMs = Number.isFinite(lastMs) ? lastMs + schedule.intervalMinutes * 60_000 : 0;
    if (!Number.isFinite(lastMs) || nowMs >= dueMs) {
      duePrograms.push(program);
    }
  }

  if (duePrograms.length === 0) return [];

  // Create one orchestrator for all due programs
  try {
    const orchestratorJob = queueTrainingOrchestrator(deps, {
      programs: duePrograms,
      apply: schedule.apply,
      trigger: "scheduled",
      chainHousekeeping: true,
    });

    // Update last-run timestamps for all due programs
    const nowIso = now.toISOString();
    for (const program of duePrograms) {
      lastRunByProgram[program] = nowIso;
    }
    setCoordinatorTrainingLastRunByProgram(deps.settingsRepo, lastRunByProgram);

    return duePrograms.map((program) => ({ program, jobId: orchestratorJob.id }));
  } catch (err: any) {
    logger.warn(
      "coordinator-training",
      `Scheduled training orchestrator queue failed: ${String(err?.message ?? err)}`,
    );
    return [];
  }
}
