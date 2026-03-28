import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";
import type { SkillsRepo } from "../db/skills.repo.js";
import { logger } from "../utils/logger.js";
import {
  type TrainingRepositoryPolicy,
  type TrainingRepositoryOverrides,
  queryTrainingRepository,
  scheduleTrainingRepositoryIndexRefresh,
  type TrainingRepositoryHit,
  buildSemanticVector,
  semanticSimilarity,
} from "./training-repository.js";

export interface CoordinatorTask {
  id: string;
  title: string;
  description?: string;
  instruction: string;
  keywords?: string[];
  regex?: string[];
  examples?: string[];
}

export interface CoordinatorPlaybookManifest {
  version: number;
  program: string;
  description?: string;
  referencePaths?: string[];
  tasks: CoordinatorTask[];
}

export interface LoadCoordinatorPlaybookContextOptions {
  dir: string;
  program?: string;
  prompt: string;
  projectRoot?: string;
  importsDir?: string[];
  referencePaths?: string[];
  playbookSourcePaths?: string[];
  clientSourcePaths?: string[];
  maxTasks?: number;
  maxExamplesPerTask?: number;
  maxProjectGuides?: number;
  maxTrainingPatterns?: number;
  trainingRepositoryPolicy?: TrainingRepositoryPolicy;
  trainingRepositoryOverrides?: TrainingRepositoryOverrides;
}

export interface CoordinatorContextMatch {
  id: string;
  kind: "playbook_task" | "project_guidance" | "training_pattern";
  title: string;
  sourcePath: string;
  score: number;
  scope?: "server" | "client";
}

export interface CoordinatorPlaybookContextResult {
  text?: string;
  matches: CoordinatorContextMatch[];
}

export type CoordinatorOutcomeSignal = "positive" | "average" | "negative";

export interface RecordCoordinatorContextOutcomeOptions {
  dir: string;
  program?: string;
  matches: CoordinatorContextMatch[];
  success?: boolean;
  signal?: CoordinatorOutcomeSignal;
  qualityWeight?: number;
}

export interface RecordCoordinatorExecutionOutcomeOptions {
  dir: string;
  program?: string;
  prompt: string;
  success?: boolean;
  signal?: CoordinatorOutcomeSignal;
  qualityWeight?: number;
  matches?: CoordinatorContextMatch[];
  outcome?: string;
  skillsRepo?: SkillsRepo;
  metadata?: {
    jobId?: string;
    jobName?: string;
    bridgeProgram?: string;
    usedBridges?: string[];
    coordinationMode?: string;
    rootJobId?: string;
    rootJobName?: string;
    inheritedRootOutcome?: boolean;
    parentJobId?: string;
    submittedByUserId?: string;
    submittedByUsername?: string;
    outcomeMarkedByUserId?: string;
    outcomeMarkedByUsername?: string;
    agentConfigId?: string;
    actualAgentConfigId?: string;
    actualModel?: string;
  };
  jobSnapshot?: {
    id?: string;
    name?: string;
    status?: string;
    priority?: string;
    prompt?: string;
    coordinationMode?: string;
    workspaceMode?: string;
    bridgeId?: string;
    bridgeProgram?: string;
    usedBridges?: string[];
    workerName?: string;
    targetWorkerName?: string;
    projectId?: string;
    parentJobId?: string;
    runtimeOptions?: unknown;
    editorContext?: unknown;
    contextItems?: unknown;
    result?: unknown;
    commands?: unknown;
    logs?: string;
    error?: string;
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
    } | null;
  };
}

interface CoordinatorLearningEntry {
  success: number;
  average: number;
  failure: number;
  lastUsedAt: string;
}

interface CoordinatorLearningState {
  version: 1;
  updatedAt: string;
  entries: Record<string, CoordinatorLearningEntry>;
}

interface CoordinatorExperienceEntry {
  prompt: string;
  success: boolean;
  signal: CoordinatorOutcomeSignal;
  outcome: string;
  qualityWeight: number;
  matchIds: string[];
  timestamp: string;
  metadata?: {
    jobId?: string;
    jobName?: string;
    bridgeProgram?: string;
    usedBridges?: string[];
    coordinationMode?: string;
    rootJobId?: string;
    rootJobName?: string;
    inheritedRootOutcome?: boolean;
    parentJobId?: string;
    submittedByUserId?: string;
    submittedByUsername?: string;
    outcomeMarkedByUserId?: string;
    outcomeMarkedByUsername?: string;
    agentConfigId?: string;
    actualAgentConfigId?: string;
    actualModel?: string;
  };
}

interface CoordinatorExperienceState {
  version: 1;
  updatedAt: string;
  entries: CoordinatorExperienceEntry[];
}

interface CoordinatorJobLearningArtifact {
  version: 1;
  storedAt: string;
  source: "manual_outcome_feedback";
  program: string;
  signal: CoordinatorOutcomeSignal;
  success: boolean;
  qualityWeight: number;
  prompt: string;
  outcome: string;
  matchIds: string[];
  matches: Array<{
    id: string;
    kind: "playbook_task" | "project_guidance" | "training_pattern";
    title: string;
    sourcePath: string;
    score: number;
    scope?: "server" | "client";
  }>;
  metadata?: CoordinatorExperienceEntry["metadata"];
  job: NonNullable<RecordCoordinatorExecutionOutcomeOptions["jobSnapshot"]>;
}

const MAX_INSTRUCTION_CHARS = 8000;
const MAX_EXCERPT_CHARS = 1200;
const MAX_PROJECT_GUIDANCE_CHARS = 2400;
const MAX_DISCOVERY_FILES_PER_SOURCE = 140;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_EXPERIENCE_ENTRIES = 240;
const MAX_EXPERIENCE_PROMPT_CHARS = 150;
const MAX_EXPERIENCE_OUTCOME_CHARS = 150;
const MAX_EXPERIENCE_JOB_NAME_CHARS = 180;
const MAX_EXPERIENCE_USER_CHARS = 96;
const MAX_EXPERIENCE_MODEL_CHARS = 120;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".py",
  ".gd",
  ".json",
  ".yaml",
  ".yml",
  ".usda",
  ".cfg",
  ".ini",
]);

const DISCOVERY_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
  "geo",
  "render",
  "comp",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "will",
  "have",
  "has",
  "had",
  "job",
  "jobs",
  "task",
  "tasks",
  "then",
  "than",
  "into",
  "onto",
  "about",
  "there",
  "their",
  "they",
  "them",
  "also",
  "just",
  "use",
  "using",
  "make",
  "made",
  "need",
  "needs",
  "from",
  "over",
  "under",
  "file",
  "files",
  "path",
  "paths",
]);

const COORDINATOR_PLAYBOOK_DEFAULTS: Record<
  string,
  { manifest: CoordinatorPlaybookManifest; files: Record<string, string> }
> = {
  global: {
    manifest: {
      version: 1,
      program: "global",
      description:
        "Global cross-bridge guidance references. Keep shared workflow conventions here.",
      tasks: [
        {
          id: "cross_bridge_workflow",
          title: "Cross-Bridge Workflow",
          description: "Common verification and handoff patterns across bridges.",
          instruction: "tasks/cross_bridge_workflow.md",
          keywords: ["workflow", "handoff", "verification", "multi-bridge"],
          examples: [
            "examples/shared",
          ],
        },
        {
          id: "execution_gate_enforcement",
          title: "Execution Gate Enforcement",
          description: "Force list_bridges and per-bridge context checks before any execution.",
          instruction: "tasks/execution_gate_enforcement.md",
          keywords: ["list_bridges", "get_bridge_context", "preflight", "gate"],
          examples: [
            "examples/shared/preflight",
          ],
        },
      ],
    },
    files: {
      "tasks/cross_bridge_workflow.md": [
        "When tasks span multiple bridges:",
        "1. Confirm the target bridge and artifact path for each stage.",
        "2. Verify outputs exist before triggering downstream stages.",
        "3. Keep naming/versioning consistent across generated files.",
      ].join("\n"),
      "tasks/execution_gate_enforcement.md": [
        "Enforce this preflight gate before any execution:",
        "1. Run list_bridges and confirm required target programs are online.",
        "2. Run get_bridge_context(target=...) for every target bridge.",
        "3. Verify required docs/settings in context before planning.",
        "4. Print an explicit PLAN before execute_command/create_job.",
        "If any target bridge/context is missing, stop and report blockers instead of partial execution.",
      ].join("\n"),
    },
  },
  blender: {
    manifest: {
      version: 1,
      program: "blender",
      description:
        "Task-focused guidance for Blender bridge jobs. Add local team scenes and material/lighting references.",
      tasks: [
        {
          id: "scene_build_render",
          title: "Scene Build + Render",
          description: "Create a scene, assign materials/lights/camera, render and verify outputs.",
          instruction: "tasks/scene_build_render.md",
          keywords: ["scene", "material", "lighting", "camera", "render"],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/scene_build_render.md": [
        "Before finalizing Blender tasks:",
        "1. Ensure all required objects exist and transforms are intentional.",
        "2. Ensure camera framing covers the target subject.",
        "3. Ensure render output path exists and rendered files are non-empty.",
      ].join("\n"),
    },
  },
  godot: {
    manifest: {
      version: 1,
      program: "godot",
      description:
        "Task-focused guidance for Godot bridge jobs. Add project-level gameplay and architecture references.",
      tasks: [
        {
          id: "feature_impl",
          title: "Feature Implementation",
          description: "Implement gameplay/UI features with project-consistent node/script patterns.",
          instruction: "tasks/feature_impl.md",
          keywords: ["feature", "scene", "script", "ui", "gameplay"],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/feature_impl.md": [
        "For Godot feature tasks:",
        "1. Prefer existing project node/script conventions over new patterns.",
        "2. Verify scenes open and scripts parse without errors.",
        "3. Keep paths and naming aligned with the target project.",
      ].join("\n"),
    },
  },
  houdini: {
    manifest: {
      version: 1,
      program: "houdini",
      description:
        "Task-focused guidance for Houdini bridge jobs. Add local team examples, project scripts, and reference scenes.",
      tasks: [
        {
          id: "general_houdini_workflow",
          title: "General Houdini Workflow",
          description:
            "Use project-specific scripts/patterns first, then apply deterministic verification for the requested task type.",
          instruction: "tasks/general_houdini_workflow.md",
          keywords: [],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/general_houdini_workflow.md": [
        "For general Houdini tasks:",
        "1. Search matched project scripts/docs/references first and reuse those patterns if relevant.",
        "2. Keep edits scoped to the user request; avoid creating unrelated simulation/render pipelines.",
        "3. After each major step, run deterministic PASS/FAIL validation (node existence, wiring, outputs).",
        "4. Verify written outputs (geo/cache/renders) exist and are readable before claiming success.",
      ].join("\n"),
    },
  },
  unity: {
    manifest: {
      version: 1,
      program: "unity",
      description:
        "Task-focused guidance for Unity bridge jobs. Add scene/prefab and coding-style references.",
      tasks: [
        {
          id: "scene_prefab_setup",
          title: "Scene + Prefab Setup",
          description: "Implement scene changes and prefabs with consistent project conventions.",
          instruction: "tasks/scene_prefab_setup.md",
          keywords: ["scene", "prefab", "script", "gameobject"],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/scene_prefab_setup.md": [
        "For Unity tasks:",
        "1. Reuse existing prefab/component patterns when available.",
        "2. Keep script and asset paths under the expected Unity project folders.",
        "3. Verify scene/prefab references are valid after changes.",
      ].join("\n"),
    },
  },
  unreal: {
    manifest: {
      version: 1,
      program: "unreal",
      description:
        "Task-focused guidance for Unreal bridge jobs. Add level, blueprint, and tooling references.",
      tasks: [
        {
          id: "level_blueprint_flow",
          title: "Level + Blueprint Flow",
          description: "Implement level and blueprint updates with project-consistent structure.",
          instruction: "tasks/level_blueprint_flow.md",
          keywords: ["level", "blueprint", "unreal", "pipeline"],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/level_blueprint_flow.md": [
        "For Unreal tasks:",
        "1. Follow existing folder and naming conventions for assets.",
        "2. Verify level references and blueprint links after edits.",
        "3. Capture concrete output paths in job logs for downstream handoff.",
      ].join("\n"),
    },
  },
  comfyui: {
    manifest: {
      version: 1,
      program: "comfyui",
      description:
        "Task-focused guidance for ComfyUI bridge jobs. Add reusable workflow references and output conventions.",
      tasks: [
        {
          id: "workflow_generation",
          title: "Workflow Generation",
          description: "Build or adapt workflows, execute, and verify image/video artifacts.",
          instruction: "tasks/workflow_generation.md",
          keywords: ["workflow", "image", "video", "comfyui", "artifact"],
          examples: [],
        },
      ],
    },
    files: {
      "tasks/workflow_generation.md": [
        "For ComfyUI tasks:",
        "1. Prefer known-good workflow templates before inventing new graphs.",
        "2. Verify generated artifacts exist on disk and are non-empty.",
        "3. Record workflow/output paths in logs for reproducibility.",
      ].join("\n"),
    },
  },
};

interface ResolvedPlaybookTask {
  task: CoordinatorTask;
  playbookProgramDir: string;
  manifestReferencePaths: string[];
}

interface RankedTask {
  item: ResolvedPlaybookTask;
  score: number;
  matchId: string;
}

interface ExampleSummary {
  path: string;
  bytes: number;
  excerpt?: string;
}

interface ProjectGuidance {
  id: string;
  title: string;
  path: string;
  scope: "server" | "client";
  text: string;
  tokenSet: Set<string>;
}

interface RankedProjectGuidance {
  item: ProjectGuidance;
  score: number;
  matchedTerms: string[];
}

export function parseCoordinatorReferencePaths(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function serializeCoordinatorReferencePaths(paths: string[]): string {
  return paths
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

export function parseCoordinatorSourcePrograms(raw?: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out: Record<string, string[]> = {};
    for (const [path, programs] of Object.entries(parsed)) {
      const key = String(path ?? "").trim();
      if (!key || !Array.isArray(programs)) continue;
      const normalized = [...new Set(
        programs
          .map((program) => String(program ?? "").trim().toLowerCase())
          .filter(Boolean),
      )];
      if (normalized.length > 0) out[key] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeCoordinatorSourcePrograms(map: Record<string, string[]>): string {
  const out: Record<string, string[]> = {};
  for (const [path, programs] of Object.entries(map)) {
    const key = String(path ?? "").trim();
    if (!key || !Array.isArray(programs)) continue;
    const normalized = [...new Set(
      programs
        .map((program) => String(program ?? "").trim().toLowerCase())
        .filter(Boolean),
    )];
    if (normalized.length > 0) out[key] = normalized;
  }
  return JSON.stringify(out);
}

export function inferCoordinatorSourceProgramsFromPath(path: string): string[] {
  const low = String(path ?? "").toLowerCase().replace(/\\/g, "/");
  const matches: string[] = [];
  if (/(^|\/)(houdini)(\/|$)/.test(low)) matches.push("houdini");
  if (/(^|\/)(blender)(\/|$)/.test(low)) matches.push("blender");
  if (/(^|\/)(godot)(\/|$)/.test(low)) matches.push("godot");
  if (/(^|\/)(unity)(\/|$)/.test(low)) matches.push("unity");
  if (/(^|\/)(unreal)(\/|$)/.test(low)) matches.push("unreal");
  if (/(^|\/)(comfyui)(\/|$)/.test(low)) matches.push("comfyui");
  if (/(^|\/)(global)(\/|$)/.test(low)) matches.push("global");
  return [...new Set(matches)];
}

export function filterCoordinatorSourcePathsByProgram(
  paths: string[],
  map: Record<string, string[]>,
  program?: string,
): string[] {
  const target = String(program ?? "").trim().toLowerCase();
  if (!target || target === "global") return paths;

  return paths.filter((path) => {
    const scoped = map[path] ?? inferCoordinatorSourceProgramsFromPath(path);
    if (scoped.length === 0) return true;
    return scoped.includes(target) || scoped.includes("global");
  });
}

function isFilenameSafeProgram(program: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(program);
}

function resolveWithinRoot(root: string, relPath: string): string | null {
  const full = join(root, relPath);
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel)) return null;
  return full;
}

function readManifest(path: string): CoordinatorPlaybookManifest | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CoordinatorPlaybookManifest;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadPlaybookFromManifestPath(
  manifestPath: string,
  program: string,
): {
  manifest: CoordinatorPlaybookManifest;
  playbookProgramDir: string;
} | null {
  if (!existsSync(manifestPath)) return null;
  const manifest = readManifest(manifestPath);
  if (!manifest || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) return null;
  if (manifest.program && manifest.program !== program) return null;

  let playbookProgramDir = dirname(manifestPath);
  if (manifestPath.endsWith(`${sep}${program}${sep}playbook.json`)) {
    playbookProgramDir = dirname(manifestPath);
  }
  return { manifest, playbookProgramDir };
}

function collectPlaybooks(
  baseDir: string,
  program: string,
  sourcePaths: string[],
): Array<{ manifest: CoordinatorPlaybookManifest; playbookProgramDir: string }> {
  const out: Array<{ manifest: CoordinatorPlaybookManifest; playbookProgramDir: string }> = [];

  const primaryManifestPath = join(baseDir, program, "playbook.json");
  const primary = loadPlaybookFromManifestPath(primaryManifestPath, program);
  if (primary) out.push(primary);

  for (const sourcePathRaw of sourcePaths) {
    const sourcePath = sourcePathRaw.trim();
    if (!sourcePath || !existsSync(sourcePath)) continue;

    let candidates: string[] = [];
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      continue;
    }

    if (st.isFile()) {
      if (sourcePath.toLowerCase().endsWith(".json")) {
        candidates = [sourcePath];
      }
    } else if (st.isDirectory()) {
      candidates = [
        join(sourcePath, program, "playbook.json"),
        join(sourcePath, `${program}.playbook.json`),
        join(sourcePath, `${program}.json`),
        join(sourcePath, "playbook.json"),
      ];
    }

    for (const candidate of candidates) {
      const loaded = loadPlaybookFromManifestPath(candidate, program);
      if (loaded) out.push(loaded);
    }
  }

  return out;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function learningFilePath(dir: string, program: string): string {
  return join(dir, "_learning", `${program}.json`);
}

function experienceFilePath(dir: string, program: string): string {
  return join(dir, "_learning", `${program}.experiences.json`);
}

function toOutcomeSignal(signal?: string, success?: boolean): CoordinatorOutcomeSignal {
  if (signal === "positive" || signal === "good") return "positive";
  if (signal === "average") return "average";
  if (signal === "negative" || signal === "poor") return "negative";
  return success ? "positive" : "negative";
}

function normalizeQualityWeight(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0.25, Math.min(3, parsed));
}

function loadLearningEntries(dir: string, program: string): Record<string, CoordinatorLearningEntry> {
  const path = learningFilePath(dir, program);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CoordinatorLearningState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") return {};
    const out: Record<string, CoordinatorLearningEntry> = {};
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== "object") continue;
      out[id] = {
        success: Math.max(0, Number((entry as any).success ?? 0) || 0),
        average: Math.max(0, Number((entry as any).average ?? 0) || 0),
        failure: Math.max(0, Number((entry as any).failure ?? 0) || 0),
        lastUsedAt: String((entry as any).lastUsedAt ?? "").trim() || new Date().toISOString(),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLearningEntries(dir: string, program: string, entries: Record<string, CoordinatorLearningEntry>): void {
  const learningDir = join(dir, "_learning");
  try {
    mkdirSync(learningDir, { recursive: true });
    const payload: CoordinatorLearningState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    writeFileSync(learningFilePath(dir, program), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch {
    // best effort persistence
  }
}

function normalizeExperienceMetadata(
  raw: unknown,
): CoordinatorExperienceEntry["metadata"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;

  const sanitize = (input: unknown, maxChars: number): string | undefined => {
    const text = String(input ?? "").replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  };

  const parseBridgeList = (input: unknown): string[] | undefined => {
    if (!Array.isArray(input)) return undefined;
    const out = [...new Set(
      input
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter((entry) => /^[a-z0-9._-]+$/.test(entry)),
    )];
    return out.length > 0 ? out : undefined;
  };

  const metadata: NonNullable<CoordinatorExperienceEntry["metadata"]> = {};
  metadata.jobId = sanitize(value.jobId, 80);
  metadata.jobName = sanitize(value.jobName, MAX_EXPERIENCE_JOB_NAME_CHARS);
  metadata.bridgeProgram = sanitize(value.bridgeProgram, 40)?.toLowerCase();
  metadata.usedBridges = parseBridgeList(value.usedBridges);
  metadata.coordinationMode = sanitize(value.coordinationMode, 24)?.toLowerCase();
  metadata.rootJobId = sanitize(value.rootJobId, 80);
  metadata.rootJobName = sanitize(value.rootJobName, MAX_EXPERIENCE_JOB_NAME_CHARS);
  metadata.inheritedRootOutcome = value.inheritedRootOutcome === true ? true : undefined;
  metadata.parentJobId = sanitize(value.parentJobId, 80);
  metadata.submittedByUserId = sanitize(value.submittedByUserId, 80);
  metadata.submittedByUsername = sanitize(value.submittedByUsername, MAX_EXPERIENCE_USER_CHARS);
  metadata.outcomeMarkedByUserId = sanitize(value.outcomeMarkedByUserId, 80);
  metadata.outcomeMarkedByUsername = sanitize(value.outcomeMarkedByUsername, MAX_EXPERIENCE_USER_CHARS);
  metadata.agentConfigId = sanitize(value.agentConfigId, 80);
  metadata.actualAgentConfigId = sanitize(value.actualAgentConfigId, 80);
  metadata.actualModel = sanitize(value.actualModel, MAX_EXPERIENCE_MODEL_CHARS);

  const hasAny = Object.values(metadata).some((v) => {
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === "string" && v.length > 0;
  });
  return hasAny ? metadata : undefined;
}

function firstNonEmptyText(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return undefined;
}

function generateLearningJobName(prompt: unknown, program?: string): string | undefined {
  const raw = String(prompt ?? "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstContentLine = lines.find((line) => !line.startsWith("#"));
  const base = firstNonEmptyText(firstContentLine, raw);
  if (!base) {
    const fallbackProgram = String(program ?? "").trim();
    return fallbackProgram ? `${fallbackProgram} task` : undefined;
  }

  let title = base
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(please|can you|could you|would you|i want you to|i want|i need you to|i need|help me(?:\s+to)?|let'?s)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!title) return undefined;

  if (title.length > 96) {
    const clipped = title.slice(0, 96);
    const boundary = clipped.lastIndexOf(" ");
    const safe = boundary >= 48 ? clipped.slice(0, boundary) : clipped;
    title = `${safe.trim()}...`;
  }

  return title.charAt(0).toUpperCase() + title.slice(1);
}

function loadExperienceEntries(dir: string, program: string): CoordinatorExperienceEntry[] {
  const path = experienceFilePath(dir, program);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CoordinatorExperienceState;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry) => ({
        prompt: String(entry?.prompt ?? "").trim(),
        signal: toOutcomeSignal(String((entry as any)?.signal ?? "").trim(), entry?.success === true),
        success: entry?.success === true,
        outcome: String(entry?.outcome ?? "").trim(),
        qualityWeight: normalizeQualityWeight((entry as any)?.qualityWeight, 1),
        matchIds: Array.isArray(entry?.matchIds)
          ? entry.matchIds.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [],
        timestamp: String(entry?.timestamp ?? "").trim(),
        metadata: normalizeExperienceMetadata((entry as any)?.metadata),
      }))
      .filter((entry) => entry.prompt && entry.outcome && !Number.isNaN(Date.parse(entry.timestamp)));
  } catch {
    return [];
  }
}

function writeExperienceEntries(dir: string, program: string, entries: CoordinatorExperienceEntry[]): void {
  const learningDir = join(dir, "_learning");
  try {
    mkdirSync(learningDir, { recursive: true });
    const payload: CoordinatorExperienceState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    writeFileSync(experienceFilePath(dir, program), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch {
    // best effort persistence
  }
}

function isSafeJobArtifactId(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function sanitizeArtifactLabel(value: unknown): string {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return text;
}

function buildJobArtifactFileName(entry: CoordinatorJobLearningArtifact, jobId: string): string {
  const preferredLabel = firstNonEmptyText(entry.job?.name, entry.metadata?.jobName);
  const sanitized = sanitizeArtifactLabel(preferredLabel);
  return sanitized ? `${sanitized}--${jobId}.json` : `${jobId}.json`;
}

function writeJobLearningArtifact(
  dir: string,
  program: string,
  entry: CoordinatorJobLearningArtifact,
  jobId: string,
): void {
  if (!isSafeJobArtifactId(jobId)) return;
  const learningDir = join(dir, "_learning", "jobs", program);
  try {
    mkdirSync(learningDir, { recursive: true });
    const legacyName = `${jobId}.json`;
    const existingNamed = readdirSync(learningDir).find((name) =>
      name.toLowerCase().endsWith(`--${jobId.toLowerCase()}.json`),
    );
    const chosenName = existingNamed || buildJobArtifactFileName(entry, jobId);
    const outputPath = join(learningDir, chosenName);
    writeFileSync(outputPath, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");

    // One-way migration for older id-only filenames.
    if (chosenName !== legacyName) {
      const legacyPath = join(learningDir, legacyName);
      if (existsSync(legacyPath)) {
        rmSync(legacyPath, { force: true });
      }
    }
  } catch {
    // best effort persistence
  }
}

function summarizeExperienceText(text: string, maxChars: number): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function rankExperiencesForPrompt(
  entries: CoordinatorExperienceEntry[],
  prompt: string,
  activeMatchIds: Set<string>,
): CoordinatorExperienceEntry[] {
  const queryTokens = new Set(tokenize(prompt));
  const nowMs = Date.now();
  const byScored = entries.map((entry) => {
    const entryTokens = new Set(tokenize(`${entry.prompt} ${entry.outcome}`));
    let overlap = 0;
    for (const token of queryTokens) {
      if (entryTokens.has(token)) overlap += 1;
    }

    const ts = Date.parse(entry.timestamp);
    const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86_400_000) : 9999;
    const recencyBoost = ageDays < 7 ? 1.0 : ageDays < 30 ? 0.6 : ageDays < 90 ? 0.25 : 0.0;

    let score = overlap * 1.25 + recencyBoost;
    if (entry.signal === "positive") score += 0.35 * entry.qualityWeight;
    if (entry.signal === "average") score += 0.1 * entry.qualityWeight;
    if (entry.signal === "negative") score -= 0.15 * entry.qualityWeight;
    for (const id of entry.matchIds) {
      if (activeMatchIds.has(id)) {
        score += 0.9;
        break;
      }
    }
    return { entry, score };
  });

  byScored.sort((a, b) => b.score - a.score);
  return byScored.map((item) => item.entry);
}

function buildExperienceSection(
  entries: CoordinatorExperienceEntry[],
  prompt: string,
  activeMatchIds: Set<string>,
): string | undefined {
  if (entries.length === 0) return undefined;
  const ranked = rankExperiencesForPrompt(entries, prompt, activeMatchIds);
  const successes: CoordinatorExperienceEntry[] = [];
  const averages: CoordinatorExperienceEntry[] = [];
  const failures: CoordinatorExperienceEntry[] = [];

  for (const entry of ranked) {
    if (entry.signal === "positive" && successes.length < 2) successes.push(entry);
    if (entry.signal === "average" && averages.length < 1) averages.push(entry);
    if (entry.signal === "negative" && failures.length < 1) failures.push(entry);
    if (successes.length >= 2 && averages.length >= 1 && failures.length >= 1) break;
  }

  if (successes.length === 0 && averages.length === 0 && failures.length === 0) return undefined;

  const lines: string[] = [
    "## Learned Outcomes (Auto)",
    "Use these prior outcomes to bias planning toward proven patterns and avoid repeated failure modes.",
  ];

  if (successes.length > 0) {
    lines.push("### Similar Success Patterns");
    for (const item of successes) {
      lines.push(`- Prompt pattern: ${item.prompt}`);
      lines.push(`  Outcome: ${item.outcome}`);
      if (item.qualityWeight !== 1) lines.push(`  Confidence weight: ${item.qualityWeight.toFixed(2)}`);
    }
  }

  if (averages.length > 0) {
    lines.push("### Similar Mixed/Partial Patterns");
    for (const item of averages) {
      lines.push(`- Prompt pattern: ${item.prompt}`);
      lines.push(`  Outcome: ${item.outcome}`);
      if (item.qualityWeight !== 1) lines.push(`  Confidence weight: ${item.qualityWeight.toFixed(2)}`);
    }
  }

  if (failures.length > 0) {
    lines.push("### Similar Failure Patterns");
    for (const item of failures) {
      lines.push(`- Prompt pattern: ${item.prompt}`);
      lines.push(`  Outcome: ${item.outcome}`);
      if (item.qualityWeight !== 1) lines.push(`  Confidence weight: ${item.qualityWeight.toFixed(2)}`);
    }
  }

  lines.push("Prefer the success patterns unless the current request explicitly requires a different approach.");
  return lines.join("\n");
}

function learningBias(entry?: CoordinatorLearningEntry): number {
  if (!entry) return 0;
  const positive = Math.min(4, entry.success * 0.25);
  const neutral = Math.min(2, entry.average * 0.08);
  const negative = Math.min(3, entry.failure * 0.35);
  return positive + neutral - negative;
}

function rankTasks(
  tasks: ResolvedPlaybookTask[],
  prompt: string,
  learningEntries: Record<string, CoordinatorLearningEntry>,
): RankedTask[] {
  const low = prompt.toLowerCase();
  const queryTokens = new Set(tokenize(prompt));

  // Build a semantic vector for the prompt once (48-dim hash vector)
  const promptVector = buildSemanticVector(prompt);

  const ranked: RankedTask[] = tasks.map((task) => {
    const matchId = `task:${task.task.id}:${task.playbookProgramDir}`;
    let score = 0;
    const matchedTerms = new Set<string>();

    // Keyword matching (exact substring in prompt)
    for (const kw of task.task.keywords ?? []) {
      const key = kw.toLowerCase().trim();
      if (!key) continue;
      if (low.includes(key)) {
        score += 2;
        matchedTerms.add(key);
      }
    }

    // Token overlap between prompt and task title/description
    const titleTokens = tokenize(`${task.task.title} ${task.task.description ?? ""}`);
    for (const token of titleTokens) {
      if (queryTokens.has(token)) {
        score += 0.5;
        matchedTerms.add(token);
      }
    }

    // Regex pattern matching
    for (const pattern of task.task.regex ?? []) {
      try {
        if (new RegExp(pattern, "i").test(prompt)) score += 3;
      } catch {
        // ignore malformed regex
      }
    }

    // Semantic similarity: compare prompt vector against task title+description+keywords vector.
    // This catches cases where the prompt is semantically related but uses different words.
    const taskText = [
      task.task.title,
      task.task.description ?? "",
      ...(task.task.keywords ?? []),
    ].join(" ");
    const taskVector = buildSemanticVector(taskText);
    const sim = semanticSimilarity(promptVector, taskVector);
    // Scale: max ~1.5 points from semantic match (40% weight vs keyword/regex 60%)
    if (sim > 0.1) {
      score += sim * 1.5;
    }

    score += learningBias(learningEntries[matchId]);

    if (matchedTerms.size === 0 && (task.task.keywords?.length ?? 0) === 0 && (task.task.regex?.length ?? 0) === 0) {
      score += 0.25;
    }

    return { item: task, score, matchId };
  });

  ranked.sort((a, b) => b.score - a.score);

  if (ranked.some((r) => r.score > 0)) {
    return ranked.filter((r) => r.score > 0);
  }

  const fallback = ranked.find(
    (r) => (r.item.task.keywords?.length ?? 0) === 0 && (r.item.task.regex?.length ?? 0) === 0,
  );
  return fallback ? [fallback] : [];
}

function findExamplesInDir(dir: string, maxFiles: number): string[] {
  const out: string[] = [];
  const queue: string[] = [dir];

  while (queue.length > 0 && out.length < maxFiles) {
    const cur = queue.shift() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }

    entries.sort();
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        queue.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

function summarizeExample(path: string): ExampleSummary | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }

  const ext = extname(path).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) || st.size > 256_000) {
    return { path, bytes: st.size };
  }

  try {
    const text = readFileSync(path, "utf-8");
    return {
      path,
      bytes: st.size,
      excerpt: text.slice(0, MAX_EXCERPT_CHARS),
    };
  } catch {
    return { path, bytes: st.size };
  }
}

function resolveExampleRef(
  ref: string,
  playbookProgramDir: string,
  referenceRoots: string[],
): string | null {
  if (isAbsolute(ref)) {
    return existsSync(ref) ? ref : null;
  }

  const inPlaybook = resolveWithinRoot(playbookProgramDir, ref);
  if (inPlaybook && existsSync(inPlaybook)) return inPlaybook;

  const configuredImportsDir = String(process.env.COORDINATOR_IMPORTS_DIR ?? "").trim();
  const siblingImportsDir = join(dirname(playbookProgramDir), "..", "coordinator-imports");
  const importsRoot = configuredImportsDir || siblingImportsDir;
  const inSiblingImports = resolveWithinRoot(importsRoot, ref);
  if (inSiblingImports && existsSync(inSiblingImports)) return inSiblingImports;

  for (const root of referenceRoots) {
    const fromRoot = resolveWithinRoot(root, ref);
    if (fromRoot && existsSync(fromRoot)) return fromRoot;
  }

  return null;
}

function buildTaskSection(
  task: CoordinatorTask,
  playbookProgramDir: string,
  referenceRoots: string[],
  maxExamplesPerTask: number,
): string {
  const chunks: string[] = [];
  chunks.push(`### Task: ${task.title} (${task.id})`);
  if (task.description) chunks.push(task.description);

  const instructionPath = resolveWithinRoot(playbookProgramDir, task.instruction);
  if (instructionPath && existsSync(instructionPath)) {
    try {
      const instructions = readFileSync(instructionPath, "utf-8").slice(0, MAX_INSTRUCTION_CHARS).trim();
      if (instructions) {
        chunks.push("Task Instructions:");
        chunks.push(instructions);
      }
    } catch {
      chunks.push(`Task Instructions: FAILED_TO_READ (${task.instruction})`);
    }
  } else {
    chunks.push(`Task Instructions: MISSING (${task.instruction})`);
  }

  const exampleSummaries: ExampleSummary[] = [];
  for (const exRef of task.examples ?? []) {
    if (exampleSummaries.length >= maxExamplesPerTask) break;
    const resolved = resolveExampleRef(exRef, playbookProgramDir, referenceRoots);
    if (!resolved) continue;

    let st;
    try {
      st = statSync(resolved);
    } catch {
      continue;
    }

    const exampleFiles = st.isDirectory()
      ? findExamplesInDir(resolved, maxExamplesPerTask - exampleSummaries.length)
      : [resolved];

    for (const file of exampleFiles) {
      if (exampleSummaries.length >= maxExamplesPerTask) break;
      const summary = summarizeExample(file);
      if (summary) exampleSummaries.push(summary);
    }
  }

  if (exampleSummaries.length > 0) {
    chunks.push("Reference Examples:");
    for (const ex of exampleSummaries) {
      chunks.push(`- ${ex.path} (${ex.bytes} bytes)`);
      if (ex.excerpt) {
        chunks.push("```text");
        chunks.push(ex.excerpt);
        chunks.push("```");
      }
    }
  }

  return chunks.join("\n\n");
}

function mayIncludeDocPath(fullPath: string, relativeDepth: number): boolean {
  const name = basename(fullPath).toLowerCase();
  const ext = extname(name);

  if (
    name === "arkestrator.coordinator.json"
    || name === "arkestrator.coordinator.md"
  ) return true;

  if (ext === ".md") {
    if (name === "readme.md") return true;
    if (/coordinator|prompt|guide|notes|workflow|pipeline|instructions/.test(name)) return true;
    return relativeDepth <= 2;
  }

  if (ext === ".json") {
    if (/coordinator|prompt|guide|notes|workflow/.test(name)) return true;
    return false;
  }

  return false;
}

function collectCandidateDocsFromSourcePath(sourcePath: string): string[] {
  const out: string[] = [];
  let sourceStat;
  try {
    sourceStat = statSync(sourcePath);
  } catch {
    return out;
  }

  if (sourceStat.isFile()) {
    if (mayIncludeDocPath(sourcePath, 0)) out.push(sourcePath);
    return out;
  }

  if (!sourceStat.isDirectory()) return out;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: sourcePath, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_DISCOVERY_FILES_PER_SOURCE) {
    const cur = queue.shift() as { dir: string; depth: number };

    let entries: string[] = [];
    try {
      entries = readdirSync(cur.dir);
    } catch {
      continue;
    }

    entries.sort();
    for (const name of entries) {
      if (out.length >= MAX_DISCOVERY_FILES_PER_SOURCE) break;
      if (name === "." || name === "..") continue;
      const full = join(cur.dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (cur.depth >= MAX_DISCOVERY_DEPTH) continue;
        if (DISCOVERY_SKIP_DIRS.has(name.toLowerCase())) continue;
        queue.push({ dir: full, depth: cur.depth + 1 });
      } else if (st.isFile()) {
        const rel = relative(sourcePath, full);
        const relDepth = rel.split(/[\\/]/).length - 1;
        if (mayIncludeDocPath(full, relDepth)) {
          out.push(full);
        }
      }
    }
  }

  return out;
}

function normalizeGuidanceText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

function readProjectGuidanceFromFile(
  path: string,
  scope: "server" | "client",
  program: string,
): ProjectGuidance[] {
  const makeGuidance = (
    id: string,
    title: string,
    sourcePath: string,
    sourceScope: "server" | "client",
    rawText: string,
    extraTokens = "",
  ): ProjectGuidance | null => {
    const text = normalizeGuidanceText(rawText).slice(0, MAX_PROJECT_GUIDANCE_CHARS);
    if (!text) return null;
    const tokenSet = new Set(tokenize(`${title} ${sourcePath} ${text} ${extraTokens}`));
    if (tokenSet.size === 0) return null;
    return {
      id,
      title,
      path: sourcePath,
      scope: sourceScope,
      text,
      tokenSet,
    };
  };

  const ext = extname(path).toLowerCase();
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }

  if (st.size <= 0 || st.size > 512_000) return [];

  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return [];

    const lowerName = basename(path).toLowerCase();
    let title = basename(dirname(path));
    const out: ProjectGuidance[] = [];

    if (ext === ".json") {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const parsedProgram = String(parsed?.program ?? "").trim();
      if (parsedProgram && parsedProgram !== program) return [];

      const projectName = String(parsed?.projectName ?? parsed?.name ?? "").trim();
      if (projectName) title = projectName;

      const parts: string[] = [];
      if (typeof parsed?.prompt === "string") parts.push(parsed.prompt);
      if (typeof parsed?.description === "string") parts.push(parsed.description);
      if (typeof parsed?.summary === "string") parts.push(parsed.summary);
      if (Array.isArray(parsed?.keywords)) {
        const keywords = parsed.keywords.map((v) => String(v ?? "").trim()).filter(Boolean);
        if (keywords.length > 0) parts.push(`Keywords: ${keywords.join(", ")}`);
      }
      if (Array.isArray(parsed?.tags)) {
        const tags = parsed.tags.map((v) => String(v ?? "").trim()).filter(Boolean);
        if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
      }

      if (parts.length > 0) {
        const baseGuide = makeGuidance(
          `guide:${scope}:${path}`,
          title,
          path,
          scope,
          parts.join("\n\n"),
        );
        if (baseGuide) out.push(baseGuide);
      }

      const contexts = Array.isArray(parsed?.contexts) ? parsed.contexts : [];
      for (let i = 0; i < contexts.length; i++) {
        const ctx = contexts[i] as Record<string, unknown>;
        if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) continue;

        const ctxPrograms = Array.isArray(ctx.programs)
          ? ctx.programs.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean)
          : Array.isArray(ctx.bridges)
            ? ctx.bridges.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean)
            : [];
        if (ctxPrograms.length > 0 && !ctxPrograms.includes(program) && !ctxPrograms.includes("global")) {
          continue;
        }

        const ctxScope = String(ctx.scope ?? "").trim().toLowerCase();
        if (ctxScope === "client" && scope === "server") continue;
        if (ctxScope === "server" && scope === "client") continue;

        const ctxText = String(ctx.prompt ?? ctx.summary ?? ctx.description ?? "").trim();
        if (!ctxText) continue;

        const ctxTitle = String(ctx.title ?? ctx.name ?? ctx.label ?? `Context ${i + 1}`).trim() || `Context ${i + 1}`;
        const tags = Array.isArray(ctx.tags)
          ? ctx.tags.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean)
          : [];

        const contextGuide = makeGuidance(
          `guide:${scope}:${path}#context:${i}`,
          `${title} — ${ctxTitle}`,
          `${path}#context:${i}`,
          scope,
          ctxText,
          `${ctxPrograms.join(" ")} ${tags.join(" ")}`,
        );
        if (contextGuide) out.push(contextGuide);
      }

      if (out.length === 0 && !/coordinator|prompt|guide|notes/.test(lowerName)) {
        return [];
      }
    } else if (ext === ".md") {
      const mdGuide = makeGuidance(`guide:${scope}:${path}`, title, path, scope, raw);
      if (mdGuide) out.push(mdGuide);
    } else {
      return [];
    }

    return out;
  } catch {
    return [];
  }
}

function collectProjectGuidance(
  sourcePaths: string[],
  scope: "server" | "client",
  program: string,
): ProjectGuidance[] {
  const out: ProjectGuidance[] = [];
  const seenPaths = new Set<string>();

  for (const sourcePathRaw of sourcePaths) {
    const sourcePath = sourcePathRaw.trim();
    if (!sourcePath || !existsSync(sourcePath)) continue;

    const candidates = collectCandidateDocsFromSourcePath(sourcePath);
    for (const candidate of candidates) {
      if (seenPaths.has(candidate)) continue;
      seenPaths.add(candidate);

      const parsed = readProjectGuidanceFromFile(candidate, scope, program);
      if (parsed.length > 0) out.push(...parsed);
    }
  }

  return out;
}

function rankProjectGuidance(
  docs: ProjectGuidance[],
  prompt: string,
  learningEntries: Record<string, CoordinatorLearningEntry>,
): RankedProjectGuidance[] {
  const queryTokens = tokenize(prompt);
  const querySet = new Set(queryTokens);
  const lowPrompt = prompt.toLowerCase();

  const ranked: RankedProjectGuidance[] = docs.map((doc) => {
    let score = 0;
    const matchedTerms: string[] = [];

    for (const token of querySet) {
      if (doc.tokenSet.has(token)) {
        score += 1.6;
        if (matchedTerms.length < 8) matchedTerms.push(token);
      }
    }

    const lowTitle = doc.title.toLowerCase();
    if (lowTitle && lowPrompt.includes(lowTitle)) score += 3;

    const parentDir = basename(dirname(doc.path)).toLowerCase();
    if (parentDir && lowPrompt.includes(parentDir)) score += 1.5;

    const lowPath = doc.path.toLowerCase();
    if (lowPath.includes("arkestrator.coordinator")) {
      score += 0.6;
    }

    score += learningBias(learningEntries[doc.id]);

    return { item: doc, score, matchedTerms };
  });

  ranked.sort((a, b) => b.score - a.score);

  if (ranked.some((r) => r.score > 0)) return ranked.filter((r) => r.score > 0);

  const fallback = ranked.find((r) => {
    const lowPath = r.item.path.toLowerCase();
    return lowPath.includes("arkestrator.coordinator");
  });
  return fallback ? [fallback] : ranked.slice(0, 1);
}

function buildProjectGuidanceSection(items: RankedProjectGuidance[]): string | undefined {
  if (items.length === 0) return undefined;

  const chunks: string[] = [
    "## Project Guidance (Auto-Matched)",
    "Use these matched project notes/configs as implementation references before executing.",
  ];

  for (const ranked of items) {
    const label = ranked.item.scope === "client" ? "Client Source" : "Server Source";
    chunks.push(`### Reference: ${ranked.item.title}`);
    chunks.push(`- ${label}: ${ranked.item.path}`);
    if (ranked.matchedTerms.length > 0) {
      chunks.push(`- Matched terms: ${ranked.matchedTerms.join(", ")}`);
    }
    chunks.push("Guidance excerpt:");
    chunks.push("```text");
    chunks.push(ranked.item.text);
    chunks.push("```");
  }

  return chunks.join("\n\n");
}

function buildTrainingPatternSection(
  hits: TrainingRepositoryHit[],
): string | undefined {
  if (hits.length === 0) return undefined;

  const lines: string[] = [
    "## Training Repository Patterns (Auto-Retrieved)",
    "Reuse these proven patterns when they match the request. Prefer high-score good-quality patterns first.",
  ];

  for (const hit of hits) {
    const quality = hit.record.qualityRating;
    const qualityLabel = quality === "good" ? "good" : quality === "poor" ? "poor" : "average";
    const summaryTrunc = hit.record.summary.length > 200 ? hit.record.summary.slice(0, 200) + "…" : hit.record.summary;
    lines.push(`### Pattern: ${hit.record.title}`);
    lines.push(`- Quality: ${qualityLabel} | Score: ${hit.score.toFixed(1)}`);
    lines.push(`- Summary: ${summaryTrunc}`);
    if (hit.record.outcome) lines.push(`- Outcome: ${hit.record.outcome}`);
  }

  return lines.join("\n");
}

export function loadCoordinatorPlaybookContextDetailed(
  options: LoadCoordinatorPlaybookContextOptions,
): CoordinatorPlaybookContextResult {
  const {
    dir,
    program,
    prompt,
    projectRoot,
    importsDir = [],
    referencePaths = [],
    playbookSourcePaths = [],
    clientSourcePaths = [],
    maxTasks = 2,
    maxExamplesPerTask = 4,
    maxProjectGuides = 3,
    maxTrainingPatterns = 3,
    trainingRepositoryPolicy,
    trainingRepositoryOverrides,
  } = options;

  if (!program || !isFilenameSafeProgram(program)) return { text: undefined, matches: [] };

  const learningEntries = loadLearningEntries(dir, program);

  const sections: string[] = [];
  const matches: CoordinatorContextMatch[] = [];

  const playbooks = collectPlaybooks(dir, program, playbookSourcePaths);
  if (playbooks.length > 0) {
    const mergedTasks: ResolvedPlaybookTask[] = [];
    for (const playbook of playbooks) {
      for (const task of playbook.manifest.tasks ?? []) {
        if (!task || typeof task.instruction !== "string") continue;
        mergedTasks.push({
          task,
          playbookProgramDir: playbook.playbookProgramDir,
          manifestReferencePaths: playbook.manifest.referencePaths ?? [],
        });
      }
    }

    const rankedTasks = rankTasks(mergedTasks, prompt, learningEntries).slice(0, Math.max(1, maxTasks));
    if (rankedTasks.length > 0) {
      const taskSections = rankedTasks.map(({ item }) => {
        const allReferenceRoots = [
          ...(projectRoot ? [projectRoot] : []),
          ...importsDir,
          ...item.manifestReferencePaths,
          ...referencePaths,
          ...playbookSourcePaths,
          ...clientSourcePaths,
        ].filter(Boolean);
        const uniqueReferenceRoots = [...new Set(allReferenceRoots)];
        return buildTaskSection(
          item.task,
          item.playbookProgramDir,
          uniqueReferenceRoots,
          maxExamplesPerTask,
        );
      });

      const taskHeader = [
        "## Task Playbooks (Auto-Selected)",
        "Use these task-specific instructions and references before planning or coding.",
        "If references conflict with the base coordinator script, prefer the task playbook guidance for the matched task.",
      ].join("\n");

      sections.push(`${taskHeader}\n\n${taskSections.join("\n\n")}`);

      for (const ranked of rankedTasks) {
        const instructionPath = resolveWithinRoot(ranked.item.playbookProgramDir, ranked.item.task.instruction)
          ?? join(ranked.item.playbookProgramDir, ranked.item.task.instruction);
        matches.push({
          id: ranked.matchId,
          kind: "playbook_task",
          title: ranked.item.task.title,
          sourcePath: instructionPath,
          score: ranked.score,
        });
      }
    }
  }

  const serverSources = [...playbookSourcePaths, ...referencePaths];
  const serverDocs = collectProjectGuidance(serverSources, "server", program);
  const clientDocs = collectProjectGuidance(clientSourcePaths, "client", program);
  const rankedGuidance = rankProjectGuidance(
    [...serverDocs, ...clientDocs],
    prompt,
    learningEntries,
  ).slice(0, Math.max(1, maxProjectGuides));

  const projectSection = buildProjectGuidanceSection(rankedGuidance);
  if (projectSection) {
    sections.push(projectSection);
    for (const guide of rankedGuidance) {
      matches.push({
        id: guide.item.id,
        kind: "project_guidance",
        title: guide.item.title,
        sourcePath: guide.item.path,
        scope: guide.item.scope,
        score: guide.score,
      });
    }
  }

  const trainingHits = queryTrainingRepository({
    dir,
    program,
    prompt,
    maxResults: Math.max(1, maxTrainingPatterns),
    policy: trainingRepositoryPolicy,
    overrides: trainingRepositoryOverrides,
  });
  const trainingSection = buildTrainingPatternSection(trainingHits);
  if (trainingSection) {
    sections.push(trainingSection);
    for (const hit of trainingHits) {
      matches.push({
        id: `training:${hit.record.id}`,
        kind: "training_pattern",
        title: hit.record.title,
        sourcePath: hit.record.sourcePath,
        score: hit.score,
      });
    }
  }

  const experienceEntries = loadExperienceEntries(dir, program);
  const experienceSection = buildExperienceSection(
    experienceEntries,
    prompt,
    new Set(matches.map((m) => m.id)),
  );
  if (experienceSection) {
    sections.push(experienceSection);
  }

  if (sections.length === 0) return { text: undefined, matches };
  return {
    text: sections.join("\n\n"),
    matches,
  };
}

export function loadCoordinatorPlaybookContext(
  options: LoadCoordinatorPlaybookContextOptions,
): string | undefined {
  return loadCoordinatorPlaybookContextDetailed(options).text;
}

export function recordCoordinatorContextOutcome(
  options: RecordCoordinatorContextOutcomeOptions,
): void {
  const { dir, program, matches } = options;
  const signal = toOutcomeSignal(options.signal, options.success);
  const weight = normalizeQualityWeight(options.qualityWeight, 1);
  if (!program || !isFilenameSafeProgram(program) || !Array.isArray(matches) || matches.length === 0) return;

  const entries = loadLearningEntries(dir, program);
  const now = new Date().toISOString();
  const uniqueIds = [...new Set(matches.map((m) => m.id).filter(Boolean))];

  for (const id of uniqueIds) {
    const existing = entries[id] ?? { success: 0, average: 0, failure: 0, lastUsedAt: now };
    if (signal === "positive") existing.success += weight;
    else if (signal === "average") existing.average += weight;
    else existing.failure += weight;
    existing.lastUsedAt = now;
    entries[id] = existing;
  }

  writeLearningEntries(dir, program, entries);
}

export function recordCoordinatorExecutionOutcome(
  options: RecordCoordinatorExecutionOutcomeOptions,
): void {
  const { dir, program, prompt, matches = [], outcome, metadata, jobSnapshot } = options;
  const signal = toOutcomeSignal(options.signal, options.success);
  const qualityWeight = normalizeQualityWeight(options.qualityWeight, 1);
  const success = signal === "positive";
  if (!program || !isFilenameSafeProgram(program)) return;

  const promptSummary = summarizeExperienceText(prompt, MAX_EXPERIENCE_PROMPT_CHARS);
  if (!promptSummary) return;

  const fallbackOutcome = signal === "positive"
    ? "Completed successfully."
    : signal === "average"
      ? "Partially successful. Reuse what worked and adjust weak steps."
      : "Execution failed. Avoid the same approach without adjustment.";
  const outcomeSummary = summarizeExperienceText(outcome || fallbackOutcome, MAX_EXPERIENCE_OUTCOME_CHARS);
  if (!outcomeSummary) return;

  const matchIds = [...new Set(matches.map((m) => String(m.id ?? "").trim()).filter(Boolean))];
  const timestamp = new Date().toISOString();
  const entries = loadExperienceEntries(dir, program);
  const normalizedMetadata = normalizeExperienceMetadata(metadata);
  const resolvedJobName = summarizeExperienceText(
    firstNonEmptyText(
      jobSnapshot?.name,
      normalizedMetadata?.jobName,
      generateLearningJobName(jobSnapshot?.prompt ?? prompt, program),
    ) ?? "",
    MAX_EXPERIENCE_JOB_NAME_CHARS,
  );
  const metadataWithJobName = normalizedMetadata
    ? (resolvedJobName && !normalizedMetadata.jobName
        ? { ...normalizedMetadata, jobName: resolvedJobName }
        : normalizedMetadata)
    : (resolvedJobName ? { jobName: resolvedJobName } : undefined);
  const metadataJobId = normalizedMetadata?.jobId;

  const existing = metadataJobId
    ? entries.find((entry) => entry.metadata?.jobId === metadataJobId)
    : entries.find(
      (entry) =>
        entry.signal === signal &&
        entry.prompt === promptSummary &&
        entry.outcome === outcomeSummary,
    );

  if (existing) {
    existing.timestamp = timestamp;
    existing.signal = signal;
    existing.success = success;
    existing.prompt = promptSummary;
    existing.outcome = outcomeSummary;
    existing.qualityWeight = qualityWeight;
    existing.matchIds = [...new Set([...existing.matchIds, ...matchIds])];
    if (metadataWithJobName) existing.metadata = metadataWithJobName;
  } else {
    entries.push({
      prompt: promptSummary,
      success,
      signal,
      outcome: outcomeSummary,
      qualityWeight,
      matchIds,
      timestamp,
      metadata: metadataWithJobName,
    });
  }

  entries.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const trimmed = entries.slice(0, MAX_EXPERIENCE_ENTRIES);
  writeExperienceEntries(dir, program, trimmed);

  const jobId = String(jobSnapshot?.id ?? normalizedMetadata?.jobId ?? "").trim();
  if (jobId && isSafeJobArtifactId(jobId)) {
    const artifact: CoordinatorJobLearningArtifact = {
      version: 1,
      storedAt: timestamp,
      source: "manual_outcome_feedback",
      program,
      signal,
      success,
      qualityWeight,
      prompt: String(prompt ?? ""),
      outcome: String(outcome || fallbackOutcome),
      matchIds,
      matches: matches.map((match) => ({
        id: String(match.id ?? "").trim(),
        kind: match.kind,
        title: String(match.title ?? ""),
        sourcePath: String(match.sourcePath ?? ""),
        score: Number(match.score ?? 0) || 0,
        scope: match.scope,
      })),
      metadata: metadataWithJobName,
      job: {
        id: jobId,
        name: String(resolvedJobName ?? ""),
        status: String(jobSnapshot?.status ?? ""),
        priority: String(jobSnapshot?.priority ?? ""),
        prompt: String(jobSnapshot?.prompt ?? prompt ?? ""),
        coordinationMode: String(jobSnapshot?.coordinationMode ?? normalizedMetadata?.coordinationMode ?? ""),
        workspaceMode: String(jobSnapshot?.workspaceMode ?? ""),
        bridgeId: String(jobSnapshot?.bridgeId ?? ""),
        bridgeProgram: String(jobSnapshot?.bridgeProgram ?? normalizedMetadata?.bridgeProgram ?? ""),
        usedBridges: Array.isArray(jobSnapshot?.usedBridges)
          ? jobSnapshot?.usedBridges
              .map((item) => String(item ?? "").trim().toLowerCase())
              .filter(Boolean)
          : (normalizedMetadata?.usedBridges ?? []),
        workerName: String(jobSnapshot?.workerName ?? ""),
        targetWorkerName: String(jobSnapshot?.targetWorkerName ?? ""),
        projectId: String(jobSnapshot?.projectId ?? ""),
        parentJobId: String(jobSnapshot?.parentJobId ?? ""),
        runtimeOptions: jobSnapshot?.runtimeOptions,
        editorContext: jobSnapshot?.editorContext,
        contextItems: jobSnapshot?.contextItems,
        result: jobSnapshot?.result,
        commands: jobSnapshot?.commands,
        logs: String(jobSnapshot?.logs ?? ""),
        error: String(jobSnapshot?.error ?? ""),
        createdAt: String(jobSnapshot?.createdAt ?? ""),
        startedAt: String(jobSnapshot?.startedAt ?? ""),
        completedAt: String(jobSnapshot?.completedAt ?? ""),
        tokenUsage: jobSnapshot?.tokenUsage ?? null,
      },
    };
    writeJobLearningArtifact(dir, program, artifact, jobId);
  }

  // Outcome data is already persisted in the training vault and repository index.
  // Don't create per-job "outcome skills" — they're just metadata noise ("Outcome:
  // positive, Prompt: ...") that pollutes the skills list without adding actionable
  // knowledge.  Real skills are created by training (per-project references) and
  // housekeeping (pattern-based recommendations).

  // Keep the training repository index fresh after each recorded outcome.
  scheduleTrainingRepositoryIndexRefresh({
    dir,
    program,
    reason: "execution_outcome",
  });
}

export function seedCoordinatorPlaybooks(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });

    for (const [program, payload] of Object.entries(COORDINATOR_PLAYBOOK_DEFAULTS)) {
      const programDir = join(dir, program);
      mkdirSync(programDir, { recursive: true });

      const manifestPath = join(programDir, "playbook.json");
      if (!existsSync(manifestPath)) {
        writeFileSync(manifestPath, `${JSON.stringify(payload.manifest, null, 2)}\n`, "utf-8");
      }

      for (const [relPath, content] of Object.entries(payload.files)) {
        const fullPath = resolveWithinRoot(programDir, relPath);
        if (!fullPath) continue;
        const parent = fullPath.slice(0, fullPath.lastIndexOf(sep));
        if (parent) mkdirSync(parent, { recursive: true });
        if (!existsSync(fullPath)) {
          writeFileSync(fullPath, `${content}\n`, "utf-8");
        }
      }
    }
  } catch {
    // best effort seeding
  }
}
