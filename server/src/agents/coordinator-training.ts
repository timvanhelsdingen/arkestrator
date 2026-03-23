import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import type { FileChange, Job, JobSubmit } from "@arkestrator/protocol";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import {
  filterCoordinatorSourcePathsByProgram,
  parseCoordinatorReferencePaths,
  parseCoordinatorSourcePrograms,
  recordCoordinatorExecutionOutcome,
} from "./coordinator-playbooks.js";
import { getCoordinatorScriptDefault, getCoordinatorScriptPrograms, type ProgramDiscoveryDeps } from "./engines.js";
import {
  flushTrainingRepositoryIndexRefresh,
  parseTrainingRepositoryOverrides,
  parseTrainingRepositoryPolicy,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
  scheduleTrainingRepositoryIndexRefresh,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
} from "./training-repository.js";

export const COORDINATOR_TRAINING_SCHEDULE_KEY = "coordinator_training_schedule";
export const COORDINATOR_TRAINING_LAST_RUN_KEY = "coordinator_training_last_run_by_program";
const ANALYZE_AGENT_SETTING = "coordinator_analyze_agent_config_id";

export const TRAINING_BLOCK_START = "<!-- ARKESTRATOR_TRAINING:START -->";
export const TRAINING_BLOCK_END = "<!-- ARKESTRATOR_TRAINING:END -->";
const PROJECT_CONFIG_FILES = [
  "arkestrator.coordinator.json",
  "agent-manager.coordinator.json",
];
const PROJECT_NOTES_FILES = [
  "arkestrator.coordinator.md",
  "agent-manager.coordinator.md",
];
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
const LEARNING_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const MAX_LEARNING_SUMMARIES = 160;
const MAX_LEARNING_DISCOVERY_FILES = 1200;
const TRAINING_VAULT_METADATA_SETTING = "coordinator_training_vault_metadata_v1";
const TRAINING_AGENTIC_ANALYSIS_TIMEOUT_MS = 45 * 60_000;
const TRAINING_AGENTIC_STATUS_POLL_MS = 1_000;
const TRAINING_CHILD_LOG_TAIL_CHARS = 12_000;

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

export interface CoordinatorTrainingSchedule {
  enabled: boolean;
  intervalMinutes: number;
  apply: boolean;
  programs: string[];
}

export interface CoordinatorTrainingSummary {
  name: string;
  path: string;
  summary: string;
}

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
}

interface CoordinatorTrainingJobTerminalState {
  status: Job["status"] | "missing" | "timeout";
  error?: string;
  logs?: string;
}

interface CoordinatorTrainingProjectDetail {
  projectPath: string;
  sourcePath: string;
  projectName: string;
  configPath: string;
  notesPath: string;
  config?: Record<string, unknown>;
  notesExcerpt?: string;
  inventory: {
    files: string[];
    sceneFiles: string[];
  };
}

interface CoordinatorTrainingArtifact {
  version: 1;
  source: "coordinator_training_job";
  job: {
    id: string;
    program: string;
    trigger: "manual" | "scheduled";
    apply: boolean;
    createdAt: string;
    generatedAt: string;
    analysisJobId?: string;
    analysisStatus?: string;
  };
  objective?: string;
  projectCount: number;
  sourcePaths: string[];
  summaries: CoordinatorTrainingSummary[];
  projects: CoordinatorTrainingProjectDetail[];
  outputs: {
    scriptPath: string;
    scriptUpdated: boolean;
    playbookPath: string;
    playbookUpdated: boolean;
  };
  notes: string[];
}

interface TrainingProjectFileBaseline {
  path: string;
  existed: boolean;
  content?: string;
}

interface AgenticTrainingSeed {
  summaries: CoordinatorTrainingSummary[];
  projects: CoordinatorTrainingProjectDetail[];
  notes: string[];
  blockedReason?: string;
}

interface TrainingVaultMetadataActor {
  id: string | null;
  username: string | null;
  ipAddress: string | null;
  workerName: string | null;
}

function isSafeProgramName(program: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(program);
}

function isWindowsAbsolutePath(pathValue: string): boolean {
  const input = String(pathValue ?? "").trim();
  if (!input) return false;
  return /^[a-zA-Z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input);
}

function resolveWithin(baseDir: string, pathValue: string): string | null {
  const input = String(pathValue ?? "").trim();
  if (!input) return null;
  const absoluteInput = isAbsolute(input) || isWindowsAbsolutePath(input);
  const out = absoluteInput ? input : join(baseDir, input);
  if (absoluteInput) return out;
  const rel = relative(baseDir, out);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return out;
}

function resolveProgramDir(playbooksDir: string, program: string): string {
  if (!isSafeProgramName(program)) throw new Error(`Invalid coordinator program: ${program}`);
  const full = join(playbooksDir, program);
  const rel = relative(playbooksDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid coordinator program: ${program}`);
  return full;
}

function resolveProjectConfigPath(projectDir: string): string | null {
  for (const file of PROJECT_CONFIG_FILES) {
    const candidate = join(projectDir, file);
    if (existsSync(candidate)) return candidate;
  }
  return join(projectDir, PROJECT_CONFIG_FILES[0]);
}

function resolveProjectNotesPath(projectDir: string): string | null {
  for (const file of PROJECT_NOTES_FILES) {
    const candidate = join(projectDir, file);
    if (existsSync(candidate)) return candidate;
  }
  return join(projectDir, PROJECT_NOTES_FILES[0]);
}

function resolveScriptPath(scriptsDir: string, program: string): string {
  if (!isSafeProgramName(program)) throw new Error(`Invalid coordinator program: ${program}`);
  const full = join(scriptsDir, `${program}.md`);
  const rel = relative(scriptsDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid coordinator program: ${program}`);
  return full;
}

function resolvePlaybookPath(playbooksDir: string, program: string): string {
  const programDir = resolveProgramDir(playbooksDir, program);
  return join(programDir, "playbook.json");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function parsePromptSummary(prompt: string, maxChars = 220): string {
  const cleaned = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function isLikelyLearningVaultPath(pathValue: string): boolean {
  const normalized = String(pathValue ?? "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/_learning/") || normalized.endsWith("/_learning")
    || normalized.includes("/learning/") || normalized.endsWith("/learning");
}

function listFilesForLearningDiscovery(root: string, maxFiles = MAX_LEARNING_DISCOVERY_FILES): string[] {
  const out: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.shift() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    entries.sort();
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(name)) continue;
        queue.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

function extractLearningJsonSummary(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): CoordinatorTrainingSummary | null {
  const parsedJob = (parsed.job ?? {}) as Record<string, unknown>;
  const parsedMetadata = (parsed.metadata ?? {}) as Record<string, unknown>;
  const programHint = String(parsed.program ?? parsedJob.bridgeProgram ?? "").trim().toLowerCase();
  if (programHint && programHint !== program) return null;

  const name = String(
    parsed.projectName
      ?? parsed.name
      ?? parsedJob.name
      ?? parsedMetadata.jobName
      ?? basename(filePath),
  ).trim();

  const signal = String(parsed.signal ?? "").trim().toLowerCase();
  const prompt = String(
    parsed.prompt
      ?? parsedJob.prompt
      ?? parsed.summary
      ?? "",
  ).trim();
  const outcome = String(parsed.outcome ?? "").trim();
  const notes = String(parsed.notes ?? "").trim();
  const summary = parsePromptSummary(
    [
      signal ? `Signal: ${signal}` : "",
      prompt,
      outcome,
      notes,
    ].filter(Boolean).join(" | "),
    220,
  );
  if (!summary) return null;

  return {
    name: name || basename(filePath),
    path: filePath,
    summary,
  };
}

function collectLearningVaultSummaries(program: string, sourcePath: string): CoordinatorTrainingSummary[] {
  const files = (() => {
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      return [];
    }
    if (st.isFile()) return [sourcePath];
    if (st.isDirectory()) return listFilesForLearningDiscovery(sourcePath, MAX_LEARNING_DISCOVERY_FILES);
    return [];
  })();

  const out: CoordinatorTrainingSummary[] = [];
  const seen = new Set<string>();
  for (const filePath of files) {
    if (out.length >= MAX_LEARNING_SUMMARIES) break;
    const ext = basename(filePath).includes(".")
      ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
      : "";
    if (!LEARNING_TEXT_EXTENSIONS.has(ext)) continue;

    if (ext === ".json") {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const summary = extractLearningJsonSummary(program, filePath, parsed);
        if (!summary) continue;
        const key = `${summary.name}::${summary.summary}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(summary);
      } catch {
        // ignore invalid JSON
      }
      continue;
    }

    try {
      const text = readFileSync(filePath, "utf-8");
      const summary = parsePromptSummary(text, 220);
      if (!summary) continue;
      const item: CoordinatorTrainingSummary = {
        name: basename(filePath),
        path: filePath,
        summary,
      };
      const key = `${item.name}::${item.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    } catch {
      // ignore unreadable text files
    }
  }

  return out;
}

function normalizeTrainingPrompt(value: unknown, maxChars = 4_000): string {
  const cleaned = String(value ?? "").replace(/\r/g, "").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function summarizeContextsPrompt(config: any): string {
  const contexts = Array.isArray(config?.contexts) ? config.contexts : [];
  if (contexts.length === 0) return "";
  const snippets = contexts
    .map((ctx: any) => String(ctx?.prompt ?? ctx?.summary ?? ctx?.description ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (snippets.length === 0) return "";
  return snippets.join(" | ");
}

function readProjectConfig(path: string): any | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
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
        return {
          ...parsed,
          program,
          projectPath: projectDir,
        };
      }
    } catch {
      // try next block
    }
  }

  const purposeMatch = content.match(/^##\s+Purpose Summary\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/im);
  const prompt = String(purposeMatch?.[1] ?? "").trim();
  if (!prompt) return null;
  return {
    version: 1,
    program,
    projectName: basename(projectDir),
    projectPath: projectDir,
    prompt,
  };
}

function readProjectConfigFromNotes(program: string, projectDir: string): any | null {
  const notesPath = resolveProjectNotesPath(projectDir);
  if (!notesPath || !existsSync(notesPath)) return null;
  try {
    const markdown = readFileSync(notesPath, "utf-8");
    return parseProjectConfigFromNotesMarkdown(program, projectDir, markdown);
  } catch {
    return null;
  }
}

function readDocSnippet(projectDir: string, maxChars = 500): string {
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

function looksLikeProjectDir(program: string, entries: string[]): boolean {
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  const hasDoc = DOC_FILE_CANDIDATES.some((f) => lower.has(f.toLowerCase()));
  const hasFileWithExt = (extRegex: RegExp) => entries.some((e) => extRegex.test(e));

  if (program === "godot") return lower.has("project.godot");
  if (program === "unity") return lower.has("assets") && lower.has("projectsettings");
  if (program === "unreal") return hasFileWithExt(/\.uproject$/i);
  if (program === "blender") return hasFileWithExt(/\.blend$/i);
  if (program === "houdini") return hasFileWithExt(/\.hip(?:lc|nc)?$/i);
  if (program === "comfyui") return lower.has("workflow_api.json") || (hasDoc && hasFileWithExt(/\.json$/i));
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

    if (looksLikeProjectDir(program, entries) && !seen.has(path)) {
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

function resolveProjectDirFromSourceFile(program: string, sourceFile: string, maxParents = 5): string | null {
  let currentDir = dirname(sourceFile);
  for (let i = 0; i <= maxParents; i++) {
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      entries = [];
    }
    if (entries.length > 0 && looksLikeProjectDir(program, entries)) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (!parent || parent === currentDir) break;
    currentDir = parent;
  }
  return dirname(sourceFile);
}

function normalizeTrainingVaultMetadataPath(pathValue: string): string {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function parseTrainingVaultMetadataMap(raw: string | null | undefined): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const normalizedPath = normalizeTrainingVaultMetadataPath(
        String((value as Record<string, unknown>).path ?? key),
      );
      if (!normalizedPath) continue;
      out[normalizedPath] = {
        ...(value as Record<string, unknown>),
        path: normalizedPath,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function upsertTrainingVaultMetadata(
  settingsRepo: SettingsRepo,
  options: {
    path: string;
    kind: "file" | "directory";
    actor?: Partial<TrainingVaultMetadataActor>;
    projectPaths?: string[];
    sourcePaths?: string[];
    remarks?: string;
  },
): void {
  const normalizedPath = normalizeTrainingVaultMetadataPath(options.path);
  if (!normalizedPath) return;

  const map = parseTrainingVaultMetadataMap(settingsRepo.get(TRAINING_VAULT_METADATA_SETTING));
  const now = new Date().toISOString();
  const previous = map[normalizedPath];
  const fallbackActor: TrainingVaultMetadataActor = {
    id: null,
    username: null,
    ipAddress: null,
    workerName: null,
  };
  const actor: TrainingVaultMetadataActor = {
    id: String(options.actor?.id ?? "").trim() || null,
    username: String(options.actor?.username ?? "").trim() || null,
    ipAddress: String(options.actor?.ipAddress ?? "").trim() || null,
    workerName: String(options.actor?.workerName ?? "").trim() || null,
  };
  const hasActor = Boolean(actor.id || actor.username || actor.ipAddress || actor.workerName);
  const sanitizePaths = (values: string[] | undefined): string[] =>
    [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 300);
  const remarks = String(options.remarks ?? "").trim().slice(0, 4_000);
  const previousProjectPaths = Array.isArray(previous?.projectPaths)
    ? previous.projectPaths.map((value) => String(value ?? "")).filter(Boolean)
    : [];
  const previousSourcePaths = Array.isArray(previous?.sourcePaths)
    ? previous.sourcePaths.map((value) => String(value ?? "")).filter(Boolean)
    : [];

  map[normalizedPath] = {
    path: normalizedPath,
    kind: options.kind,
    createdAt: String(previous?.createdAt ?? now),
    updatedAt: now,
    createdBy: previous?.createdBy ?? (hasActor ? actor : fallbackActor),
    updatedBy: hasActor ? actor : previous?.updatedBy ?? previous?.createdBy ?? fallbackActor,
    projectPaths: options.projectPaths ? sanitizePaths(options.projectPaths) : previousProjectPaths,
    sourcePaths: options.sourcePaths ? sanitizePaths(options.sourcePaths) : previousSourcePaths,
    remarks: remarks || previous?.remarks || null,
  };
  settingsRepo.set(TRAINING_VAULT_METADATA_SETTING, JSON.stringify(map));
}

function buildTrainingAgenticAnalyzePrompt(
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
  lines.push("Do NOT create or modify files inside source project folders.");
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

function extractAgenticNotesExcerpt(logs: string): string {
  const text = String(logs ?? "").trim();
  if (!text) return "";
  const markers = [
    "## Purpose Summary",
    "**Purpose Summary**",
    "Purpose Summary",
  ];
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) return text.slice(index).trim().slice(0, 12_000);
  }
  return text.slice(-12_000);
}

function detectAgenticAnalysisBlocker(
  logs: string,
  selectedRecord: Record<string, unknown> | null,
): string | null {
  const text = String(logs ?? "");
  const checks: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /http\/1\.[01]\s+401\s+unauthorized/i,
      reason: "Bridge API returned HTTP 401 Unauthorized.",
    },
    {
      regex: /"error"\s*:\s*"unauthorized"/i,
      reason: "Bridge API returned Unauthorized.",
    },
    {
      regex: /missing\s+arkestrator_url\s+or\s+arkestrator_api_key/i,
      reason: "ARKESTRATOR_URL/ARKESTRATOR_API_KEY was missing in analysis environment.",
    },
    {
      regex: /\bkey:\s*0\b/i,
      reason: "ARKESTRATOR_API_KEY was empty in analysis environment.",
    },
    {
      regex: /no\s+such\s+file\s+or\s+directory/i,
      reason: "Analysis source paths were not accessible in the analysis workspace.",
    },
  ];
  for (const check of checks) {
    if (check.regex.test(text)) return check.reason;
  }

  const prompt = String(selectedRecord?.prompt ?? "").trim().toLowerCase();
  if (prompt.startsWith("blocked analysis run")) {
    return "Agentic analysis explicitly reported a blocked run.";
  }

  const contexts = Array.isArray(selectedRecord?.contexts) ? selectedRecord.contexts : [];
  for (const context of contexts) {
    if (!context || typeof context !== "object" || Array.isArray(context)) continue;
    const record = context as Record<string, unknown>;
    const name = String(record.name ?? "").trim().toLowerCase();
    if (name.includes("blocker")) {
      return `Agentic analysis returned blocker context "${name}".`;
    }
    const pattern = String(record.pattern ?? "").trim().toLowerCase();
    if (
      pattern.includes("unauthorized")
      || pattern.includes("api_key")
      || pattern.includes("401")
      || pattern.includes("no mounted source")
      || pattern.includes("source path")
    ) {
      return "Agentic analysis reported an access/source blocker in context output.";
    }
  }
  return null;
}

function extractAgenticTrainingSeed(
  program: string,
  sourcePaths: string[],
  logs: string,
  trainingPrompt: string,
): AgenticTrainingSeed {
  const text = String(logs ?? "");
  if (!text.trim()) {
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: "Agentic analysis returned empty output.",
    };
  }

  const candidates: Array<Record<string, unknown>> = [];
  const jsonCodeBlockRegex = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = jsonCodeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore invalid JSON blocks.
    }
  }

  const selected = [...candidates]
    .reverse()
    .find((candidate) => {
      const candidateProgram = String(candidate.program ?? "").trim().toLowerCase();
      return !candidateProgram || candidateProgram === program;
    });
  const blockerReason = detectAgenticAnalysisBlocker(text, selected ?? null);
  if (blockerReason) {
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: blockerReason,
    };
  }
  if (!selected) {
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: "Agentic analysis did not emit a required structured JSON config block.",
    };
  }
  const selectedRecord = selected ?? {};
  const projectPath = String((selectedRecord as Record<string, unknown>).projectPath ?? sourcePaths[0] ?? "").trim();
  const sourcePath = String(sourcePaths[0] ?? projectPath).trim() || projectPath;
  const projectName = String(
    (selectedRecord as Record<string, unknown>).projectName
      ?? (selectedRecord as Record<string, unknown>).name
      ?? (projectPath ? basename(projectPath) : `${program}-training-reference`),
  ).trim() || `${program}-training-reference`;
  const prompt = String((selectedRecord as Record<string, unknown>).prompt ?? "").trim()
    || summarizeContextsPrompt(selectedRecord as Record<string, unknown>)
    || parsePromptSummary(trainingPrompt, 500)
    || "Bridge-analyzed coordinator training reference.";

  const notesExcerpt = extractAgenticNotesExcerpt(text);
  const summary: CoordinatorTrainingSummary = {
    name: projectName,
    path: projectPath || sourcePath || `bridge:${program}`,
    summary: parsePromptSummary(prompt, 220),
  };
  const project: CoordinatorTrainingProjectDetail = {
    projectPath: projectPath || sourcePath || `bridge:${program}`,
    sourcePath: sourcePath || projectPath || `bridge:${program}`,
    projectName,
    configPath: projectPath
      ? join(projectPath, PROJECT_CONFIG_FILES[0])
      : `${projectName}/${PROJECT_CONFIG_FILES[0]}`,
    notesPath: projectPath
      ? join(projectPath, PROJECT_NOTES_FILES[0])
      : `${projectName}/${PROJECT_NOTES_FILES[0]}`,
    config: Object.keys(selectedRecord).length > 0 ? (selectedRecord as Record<string, unknown>) : undefined,
    notesExcerpt: notesExcerpt || undefined,
    inventory: {
      files: [],
      sceneFiles: [],
    },
  };

  return {
    summaries: [summary],
    projects: [project],
    notes: [
      "Training summaries seeded from bridge-analysis artifact (no server filesystem scan required).",
    ],
  };
}

function listProjectFiles(projectDir: string, maxFiles = 200): { files: string[]; sceneFiles: string[] } {
  const files: string[] = [];
  const sceneFiles: string[] = [];
  const queue: string[] = [projectDir];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = join(current, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(name)) continue;
        queue.push(fullPath);
        continue;
      }
      if (!st.isFile()) continue;
      const relPath = relative(projectDir, fullPath).replace(/\\/g, "/");
      files.push(relPath);
      if (/\.(hip|hiplc|hipnc|blend|tscn|scn|uproject|unity)$/i.test(name)) {
        sceneFiles.push(relPath);
      }
    }
  }
  return { files, sceneFiles };
}

function collectTrainingProjectDetails(
  program: string,
  sourcePaths: string[],
  maxProjects = 120,
): CoordinatorTrainingProjectDetail[] {
  const out: CoordinatorTrainingProjectDetail[] = [];
  const seen = new Set<string>();
  for (const sourcePath of sourcePaths) {
    if (!existsSync(sourcePath)) continue;
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      continue;
    }
    const projectDirs = st.isDirectory()
      ? discoverProjectDirs(program, sourcePath, 4, maxProjects)
      : st.isFile()
      ? [resolveProjectDirFromSourceFile(program, sourcePath)].filter((value): value is string => !!value)
      : [];
    for (const projectDir of projectDirs) {
      if (out.length >= maxProjects) break;
      const key = projectDir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const configPath = resolveProjectConfigPath(projectDir) ?? join(projectDir, PROJECT_CONFIG_FILES[0]);
      const notesPath = resolveProjectNotesPath(projectDir) ?? join(projectDir, PROJECT_NOTES_FILES[0]);
      const config = existsSync(configPath) ? (readProjectConfig(configPath) ?? undefined) : undefined;
      const notesExcerpt = existsSync(notesPath)
        ? readFileSync(notesPath, "utf-8").slice(0, 12_000)
        : undefined;
      const inventory = listProjectFiles(projectDir, 280);
      const projectName = String(config?.projectName ?? basename(projectDir)).trim() || basename(projectDir);
      out.push({
        projectPath: projectDir,
        sourcePath,
        projectName,
        configPath,
        notesPath,
        config: config as Record<string, unknown> | undefined,
        notesExcerpt,
        inventory,
      });
    }
  }
  return out;
}

function captureTrainingProjectFileBaselines(
  program: string,
  sourcePaths: string[],
): TrainingProjectFileBaseline[] {
  const details = collectTrainingProjectDetails(program, sourcePaths, 120);
  const out: TrainingProjectFileBaseline[] = [];
  const seen = new Set<string>();

  for (const project of details) {
    const candidatePaths = [
      ...PROJECT_CONFIG_FILES.map((name) => join(project.projectPath, name)),
      ...PROJECT_NOTES_FILES.map((name) => join(project.projectPath, name)),
    ];
    for (const filePath of candidatePaths) {
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (!existsSync(filePath)) {
        out.push({ path: filePath, existed: false });
        continue;
      }

      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > 2_000_000) {
        out.push({ path: filePath, existed: true });
        continue;
      }
      try {
        out.push({
          path: filePath,
          existed: true,
          content: readFileSync(filePath, "utf-8"),
        });
      } catch {
        out.push({ path: filePath, existed: true });
      }
    }
  }

  return out;
}

function restoreTrainingProjectFileBaselines(
  baselines: TrainingProjectFileBaseline[],
): { restored: number; removed: number; failed: number } {
  let restored = 0;
  let removed = 0;
  let failed = 0;

  for (const baseline of baselines) {
    try {
      if (baseline.existed) {
        if (typeof baseline.content === "string") {
          mkdirSync(dirname(baseline.path), { recursive: true });
          writeFileSync(baseline.path, baseline.content, "utf-8");
          restored += 1;
        }
        continue;
      }
      if (!existsSync(baseline.path)) continue;
      const st = statSync(baseline.path);
      if (!st.isFile()) continue;
      unlinkSync(baseline.path);
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return { restored, removed, failed };
}

function writeTrainingArtifact(
  options: {
    coordinatorPlaybooksDir: string;
    settingsRepo: SettingsRepo;
    jobId: string;
    artifact: CoordinatorTrainingArtifact;
    metadataActor?: Partial<TrainingVaultMetadataActor>;
  },
): {
  jsonPath: string;
  markdownPath: string;
  jsonVaultPath: string;
  markdownVaultPath: string;
  mirroredProjectFiles: Array<{
    fullPath: string;
    vaultPath: string;
    projectPath: string;
    sourcePath: string;
  }>;
} {
  const { coordinatorPlaybooksDir, settingsRepo, jobId, artifact, metadataActor } = options;
  const slugifyFolderPart = (value: string, fallback: string): string => {
    const cleaned = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  };
  const objectiveSlug = slugifyFolderPart(
    parsePromptSummary(String(artifact.objective ?? ""), 64),
    "",
  );
  const summarySlug = slugifyFolderPart(String(artifact.summaries[0]?.name ?? ""), "");
  const baseFolderSlug = objectiveSlug || summarySlug || `${artifact.job.program}_training`;
  const folderName = `${baseFolderSlug}--${slugifyFolderPart(jobId, "job")}`;
  const folder = join(coordinatorPlaybooksDir, "_learning", "jobs", artifact.job.program, folderName);
  mkdirSync(folder, { recursive: true });

  const jsonPath = join(folder, "analysis.json");
  const markdownPath = join(folder, "analysis.md");
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");

  const mdLines: string[] = [];
  mdLines.push(`# ${artifact.job.program} Training Analysis`);
  mdLines.push("");
  mdLines.push(`- Job: ${artifact.job.id}`);
  mdLines.push(`- Trigger: ${artifact.job.trigger}`);
  mdLines.push(`- Generated: ${artifact.job.generatedAt}`);
  mdLines.push(`- Projects: ${artifact.projectCount}`);
  if (artifact.objective) mdLines.push(`- Objective: ${artifact.objective}`);
  if (artifact.job.analysisJobId) mdLines.push(`- Analysis Job: ${artifact.job.analysisJobId} (${artifact.job.analysisStatus ?? "unknown"})`);
  mdLines.push("");
  mdLines.push("## Summaries");
  for (const summary of artifact.summaries) {
    mdLines.push(`- **${summary.name}** (${summary.path})`);
    mdLines.push(`  - ${summary.summary}`);
  }
  mdLines.push("");
  mdLines.push("## Project Details");
  for (const project of artifact.projects) {
    mdLines.push(`### ${project.projectName}`);
    mdLines.push(`- Project Path: ${project.projectPath}`);
    mdLines.push(`- Config: ${project.configPath}`);
    mdLines.push(`- Notes: ${project.notesPath}`);
    if (project.inventory.sceneFiles.length > 0) {
      mdLines.push(`- Scene Files: ${project.inventory.sceneFiles.join(", ")}`);
    }
    if (project.config?.prompt != null) {
      mdLines.push("- Prompt Guidance:");
      mdLines.push(`  ${String(project.config.prompt).replace(/\s+/g, " ").trim().slice(0, 2_000)}`);
    }
    if (project.notesExcerpt) {
      mdLines.push("- Notes Excerpt:");
      mdLines.push("```md");
      mdLines.push(project.notesExcerpt);
      mdLines.push("```");
    }
    if (project.inventory.files.length > 0) {
      mdLines.push(`- Indexed Files (${project.inventory.files.length}): ${project.inventory.files.slice(0, 50).join(", ")}`);
    }
    mdLines.push("");
  }
  if (artifact.notes.length > 0) {
    mdLines.push("## Pipeline Notes");
    for (const line of artifact.notes) mdLines.push(`- ${line}`);
    mdLines.push("");
  }
  writeFileSync(markdownPath, `${mdLines.join("\n").trim()}\n`, "utf-8");

  const toVaultPath = (fullPath: string): string => {
    const rel = normalizeTrainingVaultMetadataPath(
      relative(coordinatorPlaybooksDir, fullPath).replace(/\\/g, "/"),
    );
    const withoutLearningPrefix = rel.replace(/^_learning\/?/i, "");
    return normalizeTrainingVaultMetadataPath(`learning/${withoutLearningPrefix}`);
  };
  const jsonVaultPath = toVaultPath(jsonPath);
  const markdownVaultPath = toVaultPath(markdownPath);
  const mirroredProjectFiles: Array<{
    fullPath: string;
    vaultPath: string;
    projectPath: string;
    sourcePath: string;
  }> = [];
  const remarks = parsePromptSummary(
    [
      artifact.objective ? `Objective: ${artifact.objective}` : "",
      ...artifact.summaries.slice(0, 3).map((item) => item.summary),
    ].filter(Boolean).join(" | "),
    1_100,
  );
  upsertTrainingVaultMetadata(settingsRepo, {
    path: jsonVaultPath,
    kind: "file",
    actor: metadataActor,
    projectPaths: artifact.projects.map((project) => project.projectPath),
    sourcePaths: artifact.sourcePaths,
    remarks,
  });
  upsertTrainingVaultMetadata(settingsRepo, {
    path: markdownVaultPath,
    kind: "file",
    actor: metadataActor,
    projectPaths: artifact.projects.map((project) => project.projectPath),
    sourcePaths: artifact.sourcePaths,
    remarks,
  });

  const safeSlug = (value: string, fallback: string): string => {
    const cleaned = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  };
  const mirrorProjectFile = (
    sourceFile: string,
    project: CoordinatorTrainingProjectDetail,
    relativeName: string,
    projectIndex: number,
  ): void => {
    if (!sourceFile || !existsSync(sourceFile)) return;
    let st;
    try {
      st = statSync(sourceFile);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (st.size > 2_000_000) return;
    let content = "";
    try {
      content = readFileSync(sourceFile, "utf-8");
    } catch {
      return;
    }
    if (!content.trim()) return;
    const projectSlug = safeSlug(
      `${projectIndex + 1}_${project.projectName || basename(project.projectPath)}`,
      `project_${projectIndex + 1}`,
    );
    const outDir = join(folder, "projects", projectSlug);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, relativeName);
    writeFileSync(outPath, content, "utf-8");
    const vaultPath = toVaultPath(outPath);
    upsertTrainingVaultMetadata(settingsRepo, {
      path: vaultPath,
      kind: "file",
      actor: metadataActor,
      projectPaths: [project.projectPath],
      sourcePaths: [project.sourcePath],
      remarks,
    });
    mirroredProjectFiles.push({
      fullPath: outPath,
      vaultPath,
      projectPath: project.projectPath,
      sourcePath: project.sourcePath,
    });
  };
  for (let i = 0; i < artifact.projects.length; i += 1) {
    const project = artifact.projects[i];
    mirrorProjectFile(project.configPath, project, PROJECT_CONFIG_FILES[0], i);
    mirrorProjectFile(project.notesPath, project, PROJECT_NOTES_FILES[0], i);
  }
  return {
    jsonPath,
    markdownPath,
    jsonVaultPath,
    markdownVaultPath,
    mirroredProjectFiles,
  };
}

function buildTrainingCompletionFiles(
  result: CoordinatorTrainingResult,
  artifactPaths: {
    jsonPath: string;
    markdownPath: string;
    mirroredProjectFiles?: Array<{ fullPath: string }>;
  },
): FileChange[] {
  const out: FileChange[] = [
    {
      path: artifactPaths.jsonPath,
      action: "modify",
      content: "Training artifact JSON persisted.",
    },
    {
      path: artifactPaths.markdownPath,
      action: "modify",
      content: "Training artifact markdown persisted.",
    },
  ];
  if (result.scriptUpdated) {
    out.push({
      path: result.scriptPath,
      action: "modify",
      content: "Coordinator training block updated.",
    });
  }
  if (result.playbookUpdated) {
    out.push({
      path: result.playbookPath,
      action: "modify",
      content: "Playbook training snapshot updated.",
    });
  }
  for (const file of artifactPaths.mirroredProjectFiles ?? []) {
    out.push({
      path: file.fullPath,
      action: "modify",
      content: "Mirrored project analysis artifact persisted to training vault.",
    });
  }
  return out;
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

function resolveTrainingSourcePaths(
  settingsRepo: SettingsRepo,
  defaultCoordinatorPlaybookSourcePaths: string[],
  coordinatorPlaybooksDir: string,
  program: string,
  inputPaths?: string[],
): string[] {
  const programDir = resolveProgramDir(coordinatorPlaybooksDir, program);
  const provided = Array.isArray(inputPaths)
    ? [...new Set(inputPaths.map((p) => String(p ?? "").trim()).filter(Boolean))]
    : [];
  if (provided.length > 0) {
    return provided
      .map((path) => resolveWithin(programDir, path))
      .filter((path): path is string => !!path);
  }

  const configured = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_playbook_sources"));
  const pathsByProgram = parseCoordinatorSourcePrograms(settingsRepo.get("coordinator_playbook_source_programs"));
  const combined = [...new Set([...defaultCoordinatorPlaybookSourcePaths, ...configured])];
  const scoped = filterCoordinatorSourcePathsByProgram(combined, pathsByProgram, program);
  return scoped
    .map((path) => resolveWithin(programDir, path))
    .filter((path): path is string => !!path);
}

function resolveScheduledVaultSourcePaths(
  coordinatorPlaybooksDir: string,
  program: string,
): string[] {
  const learningRoot = join(coordinatorPlaybooksDir, "_learning");
  const candidates = [
    join(learningRoot, "jobs", program),
    join(learningRoot, "uploads", program),
    learningRoot,
  ];
  const existing = candidates.filter((candidate) => existsSync(candidate));
  return existing.length > 0 ? existing : [learningRoot];
}

export function getCoordinatorTrainingSchedule(settingsRepo: SettingsRepo, deps?: ProgramDiscoveryDeps): CoordinatorTrainingSchedule {
  const defaults: CoordinatorTrainingSchedule = {
    enabled: false,
    intervalMinutes: 24 * 60,
    apply: true,
    programs: normalizeProgramList(getCoordinatorScriptPrograms(deps), deps),
  };
  const raw = settingsRepo.get(COORDINATOR_TRAINING_SCHEDULE_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const intervalValue = Number(parsed.intervalMinutes);
    return {
      enabled: parsed.enabled === true,
      intervalMinutes: Number.isFinite(intervalValue)
        ? Math.max(5, Math.min(7 * 24 * 60, Math.round(intervalValue)))
        : defaults.intervalMinutes,
      apply: parsed.apply !== false,
      programs: normalizeProgramList(
        Array.isArray(parsed.programs) ? parsed.programs.map((p) => String(p ?? "")) : defaults.programs,
        deps,
      ),
    };
  } catch {
    return defaults;
  }
}

export function setCoordinatorTrainingSchedule(settingsRepo: SettingsRepo, schedule: CoordinatorTrainingSchedule, deps?: ProgramDiscoveryDeps): void {
  const normalized: CoordinatorTrainingSchedule = {
    enabled: !!schedule.enabled,
    intervalMinutes: Math.max(5, Math.min(7 * 24 * 60, Math.round(Number(schedule.intervalMinutes) || 0))),
    apply: schedule.apply !== false,
    programs: normalizeProgramList(schedule.programs, deps),
  };
  settingsRepo.set(COORDINATOR_TRAINING_SCHEDULE_KEY, JSON.stringify(normalized));
}

export function getCoordinatorTrainingLastRunByProgram(settingsRepo: SettingsRepo): Record<string, string> {
  const raw = settingsRepo.get(COORDINATOR_TRAINING_LAST_RUN_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [program, iso] of Object.entries(parsed)) {
      const key = String(program ?? "").trim().toLowerCase();
      const value = String(iso ?? "").trim();
      if (!key || !value) continue;
      if (Number.isNaN(Date.parse(value))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function setCoordinatorTrainingLastRunByProgram(settingsRepo: SettingsRepo, runs: Record<string, string>): void {
  const out: Record<string, string> = {};
  for (const [program, iso] of Object.entries(runs)) {
    const key = String(program ?? "").trim().toLowerCase();
    const value = String(iso ?? "").trim();
    if (!key || !value || Number.isNaN(Date.parse(value))) continue;
    out[key] = value;
  }
  settingsRepo.set(COORDINATOR_TRAINING_LAST_RUN_KEY, JSON.stringify(out));
}

export function computeCoordinatorTrainingNextRunByProgram(
  schedule: CoordinatorTrainingSchedule,
  lastRunByProgram: Record<string, string>,
  now = new Date(),
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const nowMs = now.getTime();
  for (const program of schedule.programs) {
    if (!schedule.enabled) {
      out[program] = null;
      continue;
    }
    const last = lastRunByProgram[program];
    if (!last) {
      out[program] = new Date(nowMs).toISOString();
      continue;
    }
    const lastMs = Date.parse(last);
    if (Number.isNaN(lastMs)) {
      out[program] = new Date(nowMs).toISOString();
      continue;
    }
    out[program] = new Date(lastMs + schedule.intervalMinutes * 60_000).toISOString();
  }
  return out;
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

  if (summaries.length === 0) {
    throw new Error("No analyzable project references found for training");
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

export function isCoordinatorTrainingJob(job: Job, program?: string): boolean {
  const metadata = job.editorContext?.metadata as Record<string, unknown> | undefined;
  const marked = metadata?.coordinator_training_job === true;
  if (!marked) return false;
  if (!program) return true;
  const target = String(metadata?.coordinator_training_program ?? "").trim().toLowerCase();
  return target === String(program ?? "").trim().toLowerCase();
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

  const resolvedSourcePaths = resolveTrainingSourcePaths(
    settingsRepo,
    defaultCoordinatorPlaybookSourcePaths,
    coordinatorPlaybooksDir,
    normalizedProgram,
    Array.isArray(sourcePaths) && sourcePaths.length > 0
      ? sourcePaths
      : (trigger === "scheduled"
        ? resolveScheduledVaultSourcePaths(coordinatorPlaybooksDir, normalizedProgram)
        : sourcePaths),
  );

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
          // Training should prefer headless CLI to avoid interfering with user's live session.
          // Priority: headless > bridge (live) > filesystem
          const autoMode: "bridge" | "headless" | "filesystem" = headlessEnabled
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
            const analysisMetadata: Record<string, unknown> = {
              coordinator_analysis_mode: "ai",
              coordinator_training_analysis_job: true,
              coordinator_training_parent_job_id: created.id,
              coordinator_training_source_paths: resolvedSourcePaths,
              coordinator_training_prompt: trainingPrompt || undefined,
              coordinator_training_analysis_mode: analysisMode,
              coordinator_training_level: trainingLevel,
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
                projectRoot: resolvedSourcePaths[0] ?? coordinatorPlaybooksDir,
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
            const terminal = await waitForCoordinatorTrainingJobTerminalState(jobsRepo, analysisJobId, analysisTimeoutMs);
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

        // Record a negative outcome skill so the failure is tracked and discoverable
        if (deps.skillsRepo) {
          try {
            recordCoordinatorExecutionOutcome({
              dir: coordinatorPlaybooksDir,
              program: normalizedProgram,
              prompt: trainingPrompt || `Training for ${normalizedProgram}`,
              success: false,
              outcome: message,
              skillsRepo: deps.skillsRepo,
              jobSnapshot: {
                id: created.id,
                name: `Training: ${normalizedProgram}`,
                status: "failed",
                prompt: trainingPrompt || `Training for ${normalizedProgram}`,
                bridgeProgram: normalizedProgram,
                error: message,
                logs,
              },
            });
          } catch (outcomeErr: any) {
            logger.warn(
              "coordinator-training",
              `Failed to record outcome skill for failed training job ${created.id}: ${String(outcomeErr?.message ?? outcomeErr)}`,
            );
          }
        }
      }
    })();
  }, 0);

  const running = jobsRepo.getById(created.id);
  if (!running) throw new Error("Failed to load created training job");
  // Preserve createdAt for consistency in consumers.
  return { ...running, createdAt: created.createdAt, startedAt: running.startedAt ?? now };
}

export function runScheduledCoordinatorTrainingTick(
  deps: QueueCoordinatorTrainingJobDeps,
): Array<{ program: string; jobId: string }> {
  const programDeps: ProgramDiscoveryDeps = {
    coordinatorScriptsDir: deps.coordinatorScriptsDir,
    hub: deps.hub,
    headlessProgramsRepo: deps.headlessProgramsRepo,
  };
  const schedule = getCoordinatorTrainingSchedule(deps.settingsRepo, programDeps);
  if (!schedule.enabled || schedule.programs.length === 0) return [];

  const runningJobs = deps.jobsRepo.list(["queued", "running"]).jobs;
  const pending = new Set<string>();
  for (const job of runningJobs) {
    if (!isCoordinatorTrainingJob(job)) continue;
    const metadata = job.editorContext?.metadata as Record<string, unknown> | undefined;
    const program = String(metadata?.coordinator_training_program ?? "").trim().toLowerCase();
    if (program) pending.add(program);
  }

  const lastRunByProgram = getCoordinatorTrainingLastRunByProgram(deps.settingsRepo);
  const now = new Date();
  const nowMs = now.getTime();
  const queued: Array<{ program: string; jobId: string }> = [];

  for (const program of schedule.programs) {
    if (pending.has(program)) continue;
    const lastIso = lastRunByProgram[program];
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const dueMs = Number.isFinite(lastMs) ? lastMs + schedule.intervalMinutes * 60_000 : 0;
    if (Number.isFinite(lastMs) && nowMs < dueMs) continue;

    try {
      const job = queueCoordinatorTrainingJob(deps, {
        program,
        apply: schedule.apply,
        trigger: "scheduled",
      });
      queued.push({ program, jobId: job.id });
      lastRunByProgram[program] = now.toISOString();
    } catch (err: any) {
      logger.warn(
        "coordinator-training",
        `Scheduled training queue failed for ${program}: ${String(err?.message ?? err)}`,
      );
    }
  }

  if (queued.length > 0) {
    setCoordinatorTrainingLastRunByProgram(deps.settingsRepo, lastRunByProgram);
  }
  return queued;
}
