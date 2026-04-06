import type {
  Job,
  AgentConfig,
  FileChange,
  CommandResult,
  JobIntervention,
  WorkspaceMode,
} from "@arkestrator/protocol";
import {
  buildCommand,
  buildLocalExecutionPrompt,
  buildLocalAgenticBasePrompt,
  loadCoordinatorScript,
  getCoordinatorScriptPrograms,
  getDefaultProjectDir,
  type ProgramDiscoveryDeps,
} from "./engines.js";
import {
  filterCoordinatorSourcePathsByProgram,
  loadCoordinatorPlaybookContextDetailed,
  parseCoordinatorSourcePrograms,
  parseCoordinatorReferencePaths,
  recordCoordinatorExecutionOutcome,
  recordCoordinatorContextOutcome,
} from "./coordinator-playbooks.js";
import type { ProcessTracker } from "./process-tracker.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { ProjectsRepo } from "../db/projects.repo.js";
import type { Policy } from "../db/policies.repo.js";
import type { Config } from "../config.js";
import type { SyncManager } from "../workspace/sync-manager.js";
import { checkFilePaths, checkCommandScripts } from "../policies/enforcer.js";
import { resolveWorkspace } from "../workspace/resolver.js";
import type { WorkspaceResolution } from "../workspace/resolver.js";
import { parseCommandOutput, resolveExpectedCommandLanguage } from "../workspace/command-mode.js";
import { createStreamJsonState, processStreamJsonChunk, type StreamJsonState, type CommandPolicyChecker } from "./stream-json-parser.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { collectPaths, startWatching } from "./file-snapshot.js";
import { parseTokenUsage } from "./token-parser.js";
import type { UsageRepo } from "../db/usage.repo.js";
import type { DependenciesRepo } from "../db/dependencies.repo.js";
import { readSharedConfig, resolveSpawnedAgentServerUrl } from "../utils/shared-config.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { WorkerResourceLeaseManager } from "./resource-control.js";
import { writeCliWrapper, type CliWrapperResult } from "./cli-wrapper.js";
import { executeWorkerHeadlessCommands, runWorkerHeadlessCheck } from "./worker-headless.js";
import {
  formatHeavyResourceConflictError,
  inferBridgeCommandHeavyResources,
  resolveBridgeTargets,
} from "./resource-control.js";
import { spawnWithFallback } from "../utils/spawn.js";
import { sanitizeTerminalChunk } from "../utils/terminal-output.js";
import { isTransientError, computeRetryDelay } from "../queue/retry-policy.js";
import { buildLocalCliArgs } from "./local-args.js";
import {
  checkWorkerLocalLlmHealth,
  resolveAnyAvailableWorkerLlm,
  resolveWorkerLocalLlmEndpoint,
} from "../local-models/distributed.js";
import {
  getConfiguredOllamaBaseUrl,
  getOllamaBaseUrl,
  listOllamaModels,
  pullOllamaModel,
} from "../local-models/ollama.js";
import {
  LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
  LOCAL_AGENTIC_DEFAULTS,
  LOCAL_AGENTIC_DELEGATION_TOOLS,
  parseLocalAgenticAction,
  buildLocalAgenticTurnPrompt,
  compactJson as protocolCompactJson,
  promptRequestsDelegation,
  runAgenticLoop,
  runChatAgenticLoop,
  mcpToolsToOllamaSchemas,
  mcpResultToLoopResult,
  type LocalAgenticToolCall,
  type LocalAgenticHistoryEntry,
  type AgenticLoopDeps,
  type AgenticLoopConfig,
} from "./local-agentic-protocol.js";
import { createInProcessMcpClient, type InProcessMcpClient } from "../mcp/in-process-client.js";
import type { McpDeps } from "../mcp/tool-server.js";
import { dispatchToClient } from "./client-dispatch.js";
import type { LocalLlmGate } from "./local-llm-gate.js";
import {
  parseTrainingRepositoryOverrides,
  parseTrainingRepositoryPolicy,
  TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY,
  TRAINING_REPOSITORY_POLICY_SETTINGS_KEY,
} from "./training-repository.js";
import {
  TRAINING_BLOCK_START,
  TRAINING_BLOCK_END,
} from "./coordinator-training.js";
import { appendOperatorNotesToPrompt } from "./job-interventions.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { basename, join } from "path";

// ---------------------------------------------------------------------------
// Python semicolons → newlines preprocessor
// Small local models (e.g. qwen2.5:7b) sometimes generate Python as a single
// line with semicolons: `import hou;x = 1;if x:    y = 2;`
// Python can't have compound statements (if/for/while/def/class/with/try) after
// a semicolon, so we split them into separate lines.
// ---------------------------------------------------------------------------
function expandPythonSemicolons(script: string): string {
  // Only apply when the script is essentially one line (no real newlines)
  const lines = script.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 3) return script; // already multi-line, leave it alone

  // Check if we have semicolons at all
  if (!script.includes(";")) return script;

  // Split on semicolons that are NOT inside strings.
  // Simple approach: walk char by char tracking quote state.
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;
  let i = 0;

  while (i < script.length) {
    const ch = script[i];
    const next2 = script.slice(i, i + 3);

    // Handle triple-quote toggles
    if (!inDouble && !inTripleDouble && next2 === "'''") {
      inTripleSingle = !inTripleSingle;
      current += "'''";
      i += 3;
      continue;
    }
    if (!inSingle && !inTripleSingle && next2 === '"""') {
      inTripleDouble = !inTripleDouble;
      current += '"""';
      i += 3;
      continue;
    }

    // Handle single-quote toggles (only if not in triple)
    if (!inTripleSingle && !inTripleDouble && !inDouble && ch === "'" && (i === 0 || script[i - 1] !== "\\")) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (!inTripleSingle && !inTripleDouble && !inSingle && ch === '"' && (i === 0 || script[i - 1] !== "\\")) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Semicolons outside strings → split
    if (ch === ";" && !inSingle && !inDouble && !inTripleSingle && !inTripleDouble) {
      parts.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current);

  // Only reformat if we actually split something
  if (parts.length <= 1) return script;

  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join("\n");
}

export interface SpawnerDeps {
  processTracker: ProcessTracker;
  hub: WebSocketHub;
  jobsRepo: JobsRepo;
  agentsRepo: AgentsRepo;
  projectsRepo: ProjectsRepo;
  config: Config;
  syncManager?: SyncManager;
  usageRepo: UsageRepo;
  depsRepo: DependenciesRepo;
  headlessProgramsRepo?: HeadlessProgramsRepo;
  settingsRepo?: SettingsRepo;
  skillsRepo?: SkillsRepo;
  skillStore?: SkillStore;
  handoffRepo?: import("../db/handoff.repo.js").HandoffRepo;
  skillEffectivenessRepo?: import("../db/skill-effectiveness.repo.js").SkillEffectivenessRepo;
  skillIndex?: import("../skills/skill-index.js").SkillIndex;
  workersRepo?: WorkersRepo;
  jobInterventionsRepo?: JobInterventionsRepo;
  resourceLeaseManager?: WorkerResourceLeaseManager;
  localLlmGate?: LocalLlmGate;
  policiesRepo?: import("../db/policies.repo.js").PoliciesRepo;
  routingOutcomesRepo?: import("../db/routing-outcomes.repo.js").RoutingOutcomesRepo;
  toolRestrictions?: string[];
  filePathPolicies?: Policy[];
  commandFilterPolicies?: Policy[];
  processPriority?: import("../policies/enforcer.js").ProcessPriorityLevel | null;
}

/** Resolve the effective job timeout: per-job override → DB override → env/config fallback.
 *  Per-job overrides are capped by an explicit admin setting (job_timeout_ms) but NOT by the config default,
 *  so users can request longer timeouts without needing an env-var change. */
function getEffectiveJobTimeoutMs(deps: SpawnerDeps, job?: { runtimeOptions?: { timeoutMinutes?: number } }): number {
  const adminExplicit = deps.settingsRepo?.getNumber("job_timeout_ms");
  const configDefault = deps.config.jobTimeoutMs;
  const perJob = job?.runtimeOptions?.timeoutMinutes;
  if (perJob != null && Number.isFinite(perJob) && perJob > 0) {
    const perJobMs = perJob * 60_000;
    // Only cap against an explicit admin setting, not the config default
    return adminExplicit != null ? Math.min(perJobMs, adminExplicit) : perJobMs;
  }
  return adminExplicit ?? configDefault;
}

type InjectedMcpConfig = {
  path: string;
  backup: string | null;
};

function normalizeRequestedModelName(raw: string | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.toLowerCase() === "auto") return null;
  if (value.includes("{{")) return null;
  if (/\s/.test(value)) return null;
  return value;
}

function extractOllamaModelFromArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) return null;

  if (args[0] === "run") {
    const candidate = normalizeRequestedModelName(args[1]);
    // For `ollama run <model>`, require explicit tag format to avoid
    // accidentally treating a prompt string as a model when {{MODEL}} resolved to prompt.
    if (candidate && candidate.includes(":")) return candidate;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] ?? "").trim();
    if (arg === "--model" || arg === "-m") {
      const candidate = normalizeRequestedModelName(args[i + 1]);
      if (candidate) return candidate;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const candidate = normalizeRequestedModelName(arg.slice("--model=".length));
      if (candidate) return candidate;
    }
  }

  return null;
}

function resolveRequestedOllamaModel(config: AgentConfig, args: string[]): string | null {
  const fromConfig = normalizeRequestedModelName(config.model);
  if (fromConfig) return fromConfig;
  return extractOllamaModelFromArgs(args);
}

export function writeInjectedMcpConfig(
  cwd: string,
  serverUrl: string,
  apiKey: string,
  jobId: string,
): InjectedMcpConfig {
  mkdirSync(cwd, { recursive: true });
  const configPath = join(cwd, ".mcp.json");
  const mcpConfig: Record<string, any> = { mcpServers: {} };
  let backup: string | null = null;

  if (existsSync(configPath)) {
    try {
      backup = readFileSync(configPath, "utf-8");
      Object.assign(mcpConfig, JSON.parse(backup));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      backup = null;
    }
  }

  mcpConfig.mcpServers.arkestrator = {
    type: "http",
    url: `${serverUrl}/mcp`,
    headers: { Authorization: `Bearer ${apiKey}`, "X-Job-Id": jobId },
  };
  mcpConfig.__arkestrator_injected = true;

  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  return { path: configPath, backup };
}

async function ensureOllamaModelPresent(
  deps: SpawnerDeps,
  job: Job,
  model: string,
  baseUrl: string,
): Promise<void> {
  const available = await listOllamaModels(fetch, baseUrl);
  if (available.some((entry) => entry.name === model)) return;

  const start = `[local-oss] model "${model}" missing at ${baseUrl}; pulling before execution...\n`;
  deps.jobsRepo.appendLog(job.id, start);
  sendLog(deps, job, start);
  await pullOllamaModel(model, fetch, baseUrl);
  const done = `[local-oss] model "${model}" pull complete; starting execution.\n`;
  deps.jobsRepo.appendLog(job.id, done);
  sendLog(deps, job, done);
}

// Pre-compiled regex patterns for bridge program inference — avoids re-compiling
// 7 RegExps on every job completion. Combined into a single alternation for
// single-pass scanning of potentially megabyte-sized log buffers.
const BRIDGE_PROGRAM_PATTERN = new RegExp(
  [
    /\[get_bridge_context\]\s+([a-z0-9_-]+)/.source,
    /\[execute_multiple_commands\]\s+([a-z0-9_-]+)\s*:/.source,
    /\[execute_command\]\s+([a-z0-9_-]+)\s*\/[a-z0-9_-]+/.source,
    /\[run_headless_check\]\s+([a-z0-9_-]+)/.source,
    /\[exec\][^\r\n]*\bam\s+context\s+([a-z0-9_-]+)/.source,
    /\[exec\][^\r\n]*\bam\s+exec\b[^\r\n]*(?:-t|--target)\s+([a-z0-9_-]+)/.source,
    /\[exec\][^\r\n]*\bam\s+headless-check\s+([a-z0-9_-]+)/.source,
  ].join("|"),
  "gi",
);

function inferUsedBridgeProgramsFromLogs(
  job: Job,
  logs: string,
  knownPrograms: string[],
): string[] {
  const out = new Set<string>();
  const raw = String(logs ?? "");
  const known = new Set(
    knownPrograms
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (known.size === 0) return [];

  // Single-pass scan with combined regex (reset lastIndex for reuse)
  BRIDGE_PROGRAM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = BRIDGE_PROGRAM_PATTERN.exec(raw)) !== null) {
    // Find the first non-undefined capture group (alternation puts each in different group)
    for (let i = 1; i < match.length; i++) {
      if (match[i]) {
        const p = match[i].trim().toLowerCase();
        if (p && known.has(p)) out.add(p);
        break;
      }
    }
  }

  return [...out];
}

export function shouldCompleteCommandModeFromBridgeExecution(
  job: Pick<Job, "usedBridges"> | null | undefined,
): boolean {
  if (!Array.isArray(job?.usedBridges)) return false;
  return job.usedBridges.some((program) => String(program ?? "").trim().length > 0);
}

/**
 * Check whether headless/background bridge execution should be preferred.
 * Returns true if:
 *  1. The job explicitly requests headless mode via runtimeOptions, OR
 *  2. The server-level "prefer_headless_bridges" setting is enabled AND
 *     the job doesn't explicitly request "live" mode.
 */
export function preferHeadlessBridgeExecution(
  job: Pick<Job, "runtimeOptions"> | null | undefined,
  serverPreferHeadless?: boolean,
): boolean {
  const jobMode = job?.runtimeOptions?.bridgeExecutionMode;
  // Explicit per-job override always wins
  if (jobMode === "headless") return true;
  if (jobMode === "live") return false;
  // Fall back to server-level preference
  return serverPreferHeadless === true;
}

// Constants imported from @arkestrator/protocol via LOCAL_AGENTIC_DEFAULTS

export interface LocalAgenticToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  bridgesUsed?: string[];
  commandResults?: CommandResult[];
}

interface LocalAgenticRunResult {
  handled: boolean;
  success: boolean;
  fallbackToLegacy: boolean;
  cancelled: boolean;
  error?: string;
  logBuffer: string;
  commands: CommandResult[];
  durationMs: number;
}

// LocalAgenticHistoryEntry imported from @arkestrator/protocol

function parseStringArg(value: unknown): string {
  return String(value ?? "").trim();
}

function parseNumberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizePathLike(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function resolveBridgeProgramTarget(rawTarget: string, deps: SpawnerDeps, preferredProgram?: string): string {
  const target = parseStringArg(rawTarget);
  if (!target) return "";
  const normalizedTarget = target.toLowerCase();
  if (deps.hub.getBridgesByProgram(normalizedTarget).length > 0) {
    return normalizedTarget;
  }

  // Cache getBridges() once — avoids 3 separate O(n) iterations
  const allBridges = deps.hub.getBridges();

  const targetPath = normalizePathLike(target);
  if (targetPath.includes("/")) {
    for (const bridge of allBridges) {
      const program = parseStringArg((bridge as any).program).toLowerCase();
      if (!program) continue;
      const projectPath = normalizePathLike(parseStringArg((bridge as any).projectPath));
      const activeProjectsRaw = Array.isArray((bridge as any).activeProjects) ? (bridge as any).activeProjects : [];
      const activeProjects = activeProjectsRaw.map((entry: unknown) => normalizePathLike(parseStringArg(entry)));
      const paths = [projectPath, ...activeProjects].filter(Boolean);
      if (paths.some((path) => path === targetPath || targetPath.startsWith(`${path}/`) || path.startsWith(`${targetPath}/`))) {
        return program;
      }
    }
  }

  for (const bridge of allBridges) {
    const program = parseStringArg((bridge as any).program).toLowerCase();
    if (!program) continue;
    if (normalizedTarget.includes(program)) return program;
  }

  const preferred = parseStringArg(preferredProgram).toLowerCase();
  if (preferred && deps.hub.getBridgesByProgram(preferred).length > 0) {
    return preferred;
  }

  const connectedPrograms = [...new Set(
    allBridges
      .map((bridge) => parseStringArg((bridge as any).program).toLowerCase())
      .filter(Boolean),
  )];
  if (connectedPrograms.length === 1) {
    return connectedPrograms[0];
  }

  return normalizedTarget;
}

function buildGodotLabelAddScriptFromPrompt(prompt: string): string | null {
  const text = String(prompt ?? "");
  const labelMatch = /label\s+with\s+the\s+text\s+"([^"]+)"/i.exec(text)
    ?? /label[^"\n]*"([^"]+)"/i.exec(text);
  const labelText = labelMatch?.[1]?.trim();
  if (!labelText) return null;
  if (!/selected\s+.*control|control\s+node\s+that\s+i\s+have\s+selected/i.test(text.toLowerCase())) {
    return null;
  }
  return [
    "func run(editor: EditorInterface) -> void:",
    "\tvar selected_nodes = editor.get_selection().get_selected_nodes()",
    "\tif selected_nodes.is_empty():",
    "\t\tpush_error(\"No selected node\")",
    "\t\treturn",
    "\tvar label = Label.new()",
    `\tlabel.text = ${JSON.stringify(labelText)}`,
    "\tselected_nodes[0].add_child(label)",
  ].join("\n");
}

// Pre-compiled regex for training block stripping (constants never change)
const TRAINING_BLOCK_PATTERN = new RegExp(
  `${escapeRegex(TRAINING_BLOCK_START)}[\\s\\S]*?${escapeRegex(TRAINING_BLOCK_END)}`,
  "g",
);

/** Remove auto-generated training blocks from coordinator/playbook text. */
function stripTrainingBlocks(text: string): string {
  const pattern = TRAINING_BLOCK_PATTERN;
  return text.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateText(value: string, maxChars: number): string {
  if (!value) return "";
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function compactJson(value: unknown, maxChars = 5000): string {
  try {
    return truncateText(JSON.stringify(value), maxChars);
  } catch {
    return truncateText(String(value ?? ""), maxChars);
  }
}

interface BridgeExecutionVerdict {
  ok: boolean;
  executed: number;
  failed: number;
  skipped: number;
  reason?: string;
}

function evaluateBridgeExecutionResult(result: unknown): BridgeExecutionVerdict {
  if (!result || typeof result !== "object") {
    return { ok: false, executed: 0, failed: 0, skipped: 0, reason: "Missing bridge execution payload" };
  }
  const obj = result as Record<string, unknown>;
  const success = obj.success === true;
  const executed = Number(obj.executed ?? 0);
  const failed = Number(obj.failed ?? 0);
  const skipped = Number(obj.skipped ?? 0);
  const errors = Array.isArray(obj.errors)
    ? obj.errors.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  if (!success) {
    const reason = errors.length > 0
      ? errors.join("; ")
      : "Bridge reported failure";
    return { ok: false, executed, failed, skipped, reason };
  }
  if (Number.isFinite(failed) && failed > 0) {
    const reason = errors.length > 0
      ? errors.join("; ")
      : `Bridge reported ${failed} failed command(s)`;
    return { ok: false, executed, failed, skipped, reason };
  }
  if (Number.isFinite(skipped) && skipped > 0) {
    const reason = errors.length > 0
      ? errors.join("; ")
      : `Bridge skipped ${skipped} command(s)`;
    return { ok: false, executed, failed, skipped, reason };
  }
  if (Number.isFinite(executed) && executed <= 0) {
    return {
      ok: false,
      executed,
      failed,
      skipped,
      reason: "Bridge reported zero executed commands",
    };
  }
  return { ok: true, executed, failed, skipped };
}

// buildLocalAgenticTurnPrompt and promptRequestsDelegation imported from @arkestrator/protocol

/**
 * Infer the target bridge program from the job prompt by matching against
 * connected bridge program names. Helps local LLMs (14-32B) that aren't
 * smart enough to figure out the right bridge from the coordinator prompt.
 */
function inferBridgeProgramFromPrompt(prompt: string, connectedPrograms: string[]): string | undefined {
  if (connectedPrograms.length === 0) return undefined;
  const lower = prompt.toLowerCase();
  const matches = connectedPrograms.filter((p) => lower.includes(p.toLowerCase()));
  // Only infer if exactly one program matches — ambiguous matches should be left to the LLM
  if (matches.length === 1) return matches[0];
  return undefined;
}

function buildLocalAgenticTaskSummary(job: Job, connectedPrograms?: string[]): string {
  const lines = [`User request: ${job.prompt}`];
  const projectRoot = parseStringArg(job.editorContext?.projectRoot);
  if (projectRoot) lines.push(`Project root: ${projectRoot}`);
  const activeFile = parseStringArg(job.editorContext?.activeFile);
  if (activeFile) lines.push(`Active file: ${activeFile}`);
  const metadata = (job.editorContext?.metadata ?? {}) as Record<string, unknown>;
  const selectedNodes = Array.isArray(metadata.selected_nodes) ? metadata.selected_nodes : [];
  if (selectedNodes.length > 0) {
    lines.push(`Selected nodes: ${compactJson(selectedNodes, 600)}`);
  }
  // Use explicit bridgeProgram if set, otherwise infer from prompt
  const targetBridge = parseStringArg(job.bridgeProgram)
    || (connectedPrograms ? inferBridgeProgramFromPrompt(job.prompt, connectedPrograms) : undefined);
  if (targetBridge) {
    lines.push(`Target bridge: ${targetBridge} — use execute_command with target="${targetBridge}" for this task.`);
  }
  return lines.join("\n");
}

function getPendingOperatorNotesPrompt(
  repo: JobInterventionsRepo | undefined,
  jobId: string,
): {
  interventionIds: string[];
  notePrompt: string;
} {
  if (!repo) return { interventionIds: [], notePrompt: "" };
  const pending = repo.listPending(jobId);
  return {
    interventionIds: pending.map((entry) => entry.id),
    notePrompt: appendOperatorNotesToPrompt("", pending).trim(),
  };
}

function summarizeLocalToolCall(call: LocalAgenticToolCall): string {
  if (call.tool === "execute_command") {
    const target = parseStringArg(call.args?.target);
    const language = parseStringArg(call.args?.language);
    const script = truncateText(String(call.args?.script ?? ""), 180);
    return `${call.tool} target=${target || "(missing)"} language=${language || "(missing)"} script=${compactJson(script, 260)}`;
  }
  if (call.tool === "execute_multiple_commands") {
    const target = parseStringArg(call.args?.target);
    const count = Array.isArray(call.args?.commands) ? call.args.commands.length : 0;
    return `${call.tool} target=${target || "(missing)"} count=${count}`;
  }
  if (call.tool === "get_bridge_context") {
    const target = parseStringArg(call.args?.target);
    return `${call.tool} target=${target || "(missing)"}`;
  }
  return call.tool;
}

async function runLocalModelTurn(
  job: Job,
  config: AgentConfig,
  deps: SpawnerDeps,
  prompt: string,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  const args = buildLocalCliArgs(config.args, prompt, config.model);
  let proc;
  try {
    const { proc: spawnedProc } = spawnWithFallback(config.command, args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = spawnedProc;
  } catch (err: any) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: `Failed to spawn local runtime: ${err?.message ?? err}`,
    };
  }

  deps.processTracker.register(job.id, proc);
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* best effort */ }
  }, timeoutMs);

  try {
    const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);
    return {
      exitCode,
      stdout: sanitizeTerminalChunk(stdoutRaw),
      stderr: sanitizeTerminalChunk(stderrRaw),
      timedOut,
    };
  } catch (err: any) {
    clearTimeout(killTimer);
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut,
      error: `Local runtime turn failed: ${err?.message ?? err}`,
    };
  } finally {
    deps.processTracker.unregister(job.id);
  }
}

async function executeBridgeCommandsForLocalLoop(
  deps: SpawnerDeps,
  job: Job,
  params: {
    target: string;
    commands: CommandResult[];
    timeout?: number;
    projectPath?: string;
  },
): Promise<LocalAgenticToolResult> {
  const target = parseStringArg(params.target).toLowerCase();
  if (!target) return { ok: false, error: "target is required" };
  if (!Array.isArray(params.commands) || params.commands.length === 0) {
    return { ok: false, error: "commands must be a non-empty array" };
  }

  if (deps.commandFilterPolicies && deps.commandFilterPolicies.length > 0) {
    const violations = checkCommandScripts(
      params.commands.map((cmd) => ({ language: cmd.language, script: cmd.script })),
      deps.commandFilterPolicies,
    );
    const blockers = violations.filter((v) => v.action === "block");
    if (blockers.length > 0) {
      return {
        ok: false,
        error: `Command policy violation: ${blockers.map((v) => v.message).join("; ")}`,
      };
    }
  }

  const timeoutMs = Math.min(
    Math.max(parseNumberArg(params.timeout) ?? 60_000, 1_000),
    300_000,
  );

  const serverPreferHeadless = deps.settingsRepo?.getBool("prefer_headless_bridges") ?? false;
  const forceHeadless = preferHeadlessBridgeExecution(job, serverPreferHeadless);
  const resolvedTargets = forceHeadless
    ? { targets: [], workerKeys: [] }
    : resolveBridgeTargets(deps.hub, target, "program", job.targetWorkerName ?? job.workerName, job.workerName);
  const targets = resolvedTargets.targets;
  if (targets.length === 0) {
    const workerHeadless = await executeWorkerHeadlessCommands({
      hub: deps.hub,
      headlessProgramsRepo: deps.headlessProgramsRepo,
      resourceLeaseManager: deps.resourceLeaseManager,
      program: target,
      commands: params.commands,
      timeoutMs,
      projectPath: params.projectPath ?? job.editorContext?.projectRoot,
      targetWorkerName: job.targetWorkerName ?? job.workerName,
      leaseOwnerId: `job:${job.id}:headless:${target}`,
      leaseOwnerLabel: `job ${job.id.slice(0, 8)} headless ${target}`,
    });
    if (!workerHeadless.handled) {
      return {
        ok: false,
        error: forceHeadless
          ? `Headless execution was required for ${target}, but no eligible desktop client can execute it`
          : `No connected bridge for ${target} and no eligible desktop client can execute it`,
      };
    }
    if (!workerHeadless.success) {
      return {
        ok: false,
        error: workerHeadless.error || `Headless execution failed for ${target}`,
      };
    }
    const verdict = evaluateBridgeExecutionResult(workerHeadless.result);
    if (!verdict.ok) {
      return {
        ok: false,
        error: verdict.reason || `Headless execution did not execute commands for ${target}`,
      };
    }
    return {
      ok: true,
      data: workerHeadless.result ?? { summary: "worker headless success" },
      bridgesUsed: [target],
      commandResults: params.commands,
    };
  }

  const resources = inferBridgeCommandHeavyResources(target, params.commands);
  if (resources.length > 0 && resolvedTargets.workerKeys.length !== 1) {
    return {
      ok: false,
      error: `Heavy ${target} execution resolves to multiple workers (${resolvedTargets.workerKeys.join(", ")}); set targetWorkerName before launching it.`,
    };
  }
  const acquired = deps.resourceLeaseManager?.acquire(
    resolvedTargets.workerKeys,
    resources,
    {
      ownerId: `job:${job.id}:bridge:${target}`,
      ownerLabel: `job ${job.id.slice(0, 8)} bridge ${target}`,
      program: target,
    },
  );
  if (acquired && !acquired.ok) {
    return {
      ok: false,
      error: formatHeavyResourceConflictError(acquired.conflict, target),
    };
  }

  const correlationId = newId();
  const resultPromise = deps.hub.registerPendingCommand(correlationId, timeoutMs);
  let metadataChanged = false;

  for (const targetWs of targets as any[]) {
    const projectPath = params.projectPath ?? job.editorContext?.projectRoot;
    if (projectPath) {
      metadataChanged = deps.hub.recordBridgeProjectPath(targetWs.data.id, projectPath) || metadataChanged;
    }
    targetWs.send(
      JSON.stringify({
        type: "bridge_command",
        id: newId(),
        payload: {
          senderId: "local-agentic-loop",
          commands: params.commands,
          correlationId,
          projectPath,
        },
      }),
    );
  }

  if (metadataChanged) deps.hub.broadcastBridgeStatus();

  try {
    const result = await resultPromise;
    const verdict = evaluateBridgeExecutionResult(result);
    if (!verdict.ok) {
      return {
        ok: false,
        error: verdict.reason || `Bridge execution did not run commands for ${target}`,
      };
    }
    const bridgesUsed = [...new Set((targets as any[]).map((ws) => String(ws.data?.program ?? "").trim()).filter(Boolean))];
    return {
      ok: true,
      data: result,
      bridgesUsed,
      commandResults: params.commands,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Bridge command timed out" };
  } finally {
    acquired?.ok && acquired.lease.release();
  }
}

export async function executeLocalAgenticToolCall(
  call: LocalAgenticToolCall,
  deps: SpawnerDeps,
  job: Job,
): Promise<LocalAgenticToolResult> {
  const args = call.args ?? {};

  if (call.tool === "list_bridges") {
    return {
      ok: true,
      data: deps.hub.getBridges().map((b) => ({
        id: b.id,
        program: b.program,
        workerName: b.workerName,
        projectPath: b.projectPath,
        activeProjects: Array.isArray(b.activeProjects) ? b.activeProjects : (b.projectPath ? [b.projectPath] : []),
        programVersion: b.programVersion,
      })),
    };
  }

  if (call.tool === "get_bridge_context") {
    const target = resolveBridgeProgramTarget(parseStringArg(args.target), deps, job.bridgeProgram);
    if (!target) return { ok: false, error: "target is required" };
    const bridges = deps.hub.getBridgesByProgram(target);
    if (bridges.length === 0) {
      return { ok: false, error: `No bridge connected for: ${target}` };
    }
    const contexts = bridges.map((ws: any) => {
      const ctx = deps.hub.getBridgeContext(ws.data.id);
      return {
        bridgeId: ws.data.id,
        program: ws.data.program,
        workerName: ws.data.workerName,
        projectPath: ws.data.projectPath,
        editorContext: ctx?.editorContext ?? null,
        files: ctx?.files ?? [],
        contextItems: ctx?.items ?? [],
      };
    });
    return { ok: true, data: contexts };
  }

  if (call.tool === "execute_command") {
    const rawTarget = parseStringArg(args.target);
    const target = resolveBridgeProgramTarget(rawTarget, deps, job.bridgeProgram);
    const language = parseStringArg(args.language).toLowerCase();
    let script = String(args.script ?? "");
    if (language === "gdscript") {
      const recovered = buildGodotLabelAddScriptFromPrompt(job.prompt);
      if (recovered) script = recovered;
    }
    if (language === "python") script = expandPythonSemicolons(script);
    if (!target || !language || !script.trim()) {
      return { ok: false, error: "target, language, and script are required" };
    }
    // Validate that the resolved target actually has a connected bridge or headless path.
    // Without this check, a disconnected bridge name passes through and may be
    // misrouted to a different bridge via fallback logic.
    if (deps.hub.getBridgesByProgram(target).length === 0) {
      const connectedPrograms = deps.hub.getBridges()
        .map((b: any) => String(b.program ?? "").toLowerCase())
        .filter(Boolean);
      const unique = [...new Set(connectedPrograms)];
      if (unique.length > 0) {
        return {
          ok: false,
          error: `No connected bridge for "${rawTarget}". Connected programs: ${unique.join(", ")}. ` +
            `The ${rawTarget} bridge may be offline — ask the user to open ${rawTarget} with the Arkestrator bridge enabled.`,
        };
      }
      return { ok: false, error: `No connected bridge for "${rawTarget}". No bridges are currently connected.` };
    }
    return executeBridgeCommandsForLocalLoop(deps, job, {
      target,
      timeout: parseNumberArg(args.timeout),
      projectPath: parseStringArg(args.project_path || args.projectPath) || undefined,
      commands: [{ language, script, description: parseStringArg(args.description) || undefined }],
    });
  }

  if (call.tool === "execute_multiple_commands") {
    const rawMultiTarget = parseStringArg(args.target);
    const target = resolveBridgeProgramTarget(rawMultiTarget, deps, job.bridgeProgram);
    if (!target) return { ok: false, error: "target is required" };
    // Early validation: ensure target bridge is actually connected
    if (deps.hub.getBridgesByProgram(target).length === 0) {
      const unique = [...new Set(deps.hub.getBridges().map((b: any) => String(b.program ?? "").toLowerCase()).filter(Boolean))];
      return {
        ok: false,
        error: unique.length > 0
          ? `No connected bridge for "${rawMultiTarget}". Connected programs: ${unique.join(", ")}.`
          : `No connected bridge for "${rawMultiTarget}". No bridges are currently connected.`,
      };
    }
    if (!Array.isArray(args.commands) || args.commands.length === 0) {
      return { ok: false, error: "commands must be a non-empty array" };
    }
    const commands: CommandResult[] = [];
    for (const item of args.commands) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      // Accept common aliases: type/lang → language, code/content/source → script
      const language = parseStringArg(row.language || row.type || row.lang).toLowerCase();
      let script = String(row.script ?? row.code ?? row.content ?? row.source ?? "");
      if (language === "python") script = expandPythonSemicolons(script);
      if (!language || !script.trim()) continue;
      commands.push({
        language,
        script,
        description: parseStringArg(row.description) || undefined,
      });
    }
    if (commands.length === 0) {
      return { ok: false, error: "commands did not contain any valid language/script entries. Each command must have 'language' and 'script' fields, e.g. {\"language\":\"python\",\"script\":\"import hou; ...\"}" };
    }
    return executeBridgeCommandsForLocalLoop(deps, job, {
      target,
      commands,
      timeout: parseNumberArg(args.timeout),
      projectPath: parseStringArg(args.project_path || args.projectPath) || undefined,
    });
  }

  if (call.tool === "run_headless_check") {
    if (!deps.headlessProgramsRepo) {
      return { ok: false, error: "headless programs repository is not available" };
    }
    const program = parseStringArg(args.program).toLowerCase();
    if (!program) return { ok: false, error: "program is required" };
    if (!Array.isArray(args.args)) {
      return { ok: false, error: "args must be a string array" };
    }
    const cliArgs = args.args.map((value) => String(value ?? "")).filter((v) => !!v);
    const result = await runWorkerHeadlessCheck({
      hub: deps.hub,
      headlessProgramsRepo: deps.headlessProgramsRepo,
      resourceLeaseManager: deps.resourceLeaseManager,
      program,
      args: cliArgs,
      projectPath: parseStringArg(args.project_path || args.projectPath) || undefined,
      timeoutMs: Math.min(Math.max(parseNumberArg(args.timeout) ?? 30_000, 1_000), 120_000),
      targetWorkerName: job.targetWorkerName ?? job.workerName,
      leaseOwnerId: `job:${job.id}:headless-check:${program}`,
      leaseOwnerLabel: `job ${job.id.slice(0, 8)} headless check ${program}`,
    });
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, data: { output: result.output ?? "(no output)" }, bridgesUsed: [program] };
  }

  if (call.tool === "list_agent_configs") {
    const configs = deps.agentsRepo.list().map((cfg) => ({
      id: cfg.id,
      name: cfg.name,
      engine: cfg.engine,
      model: cfg.model ?? null,
      priority: cfg.priority,
    }));
    return { ok: true, data: configs };
  }

  if (call.tool === "create_job") {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "prompt is required" };
    const handover = String(args.handover_notes ?? "").trim();
    const targetProgram = parseStringArg(args.target_program).toLowerCase() || undefined;
    const targetWorker = parseStringArg(args.target_worker).toLowerCase() || undefined;
    const requestedConfigId = parseStringArg(args.agent_config_id) || undefined;
    const rawPriority = parseStringArg(args.priority).toLowerCase();
    const priority = (
      rawPriority === "critical" || rawPriority === "high" || rawPriority === "low" || rawPriority === "normal"
        ? rawPriority
        : "normal"
    ) as Job["priority"];
    const name = parseStringArg(args.name) || undefined;
    const dependsOn = Array.isArray(args.depends_on_job_ids)
      ? args.depends_on_job_ids.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];

    let configId = requestedConfigId;
    if (!configId) {
      const configs = deps.agentsRepo.list();
      if (configs.length === 0) {
        return { ok: false, error: "No agent configs available" };
      }
      const preferred = configs.find((c) => c.engine === "local-oss")
        ?? configs.find((c) => c.engine === "claude-code")
        ?? configs[0];
      configId = preferred.id;
    } else {
      const found = deps.agentsRepo.getById(configId);
      if (!found) return { ok: false, error: `Agent config not found: ${configId}` };
    }

    let bridgeId: string | undefined;
    let bridgeProgram: string | undefined;
    if (targetProgram) {
      bridgeProgram = targetProgram;
      const bridges = deps.hub.getBridgesByProgram(targetProgram);
      if (bridges.length > 0) {
        bridgeId = (bridges[0] as any).data?.id;
      } else {
        const headless = deps.headlessProgramsRepo?.list()
          .find((hp) => hp.program === targetProgram && hp.enabled);
        if (!headless) {
          return {
            ok: false,
            error: `No "${targetProgram}" bridge is connected and no headless program is enabled`,
          };
        }
      }
    }

    const fullPrompt = handover
      ? `## Context from Coordinator\n\n${handover}\n\n---\n\n## Your Task\n\n${prompt}`
      : prompt;
    const created = deps.jobsRepo.create(
      {
        prompt: fullPrompt,
        agentConfigId: configId,
        priority,
        coordinationMode: "server",
        name,
        files: [],
        contextItems: [],
        startPaused: false,
      },
      bridgeId,
      bridgeProgram,
      undefined,
      targetWorker,
      undefined,
      job.id,
    );

    for (const depId of dependsOn) {
      try {
        deps.depsRepo.add(created.id, depId);
      } catch {
        // ignore invalid/duplicate dependency ids
      }
    }

    const updated = deps.jobsRepo.getById(created.id);
    if (updated) {
      deps.hub.broadcastToType("client", {
        type: "job_updated",
        id: newId(),
        payload: { job: updated },
      });
    }

    return {
      ok: true,
      data: {
        job_id: created.id,
        status: created.status,
        target_program: bridgeProgram ?? null,
        target_worker: targetWorker ?? null,
        depends_on: dependsOn,
      },
    };
  }

  if (call.tool === "get_job_status") {
    const jobId = parseStringArg(args.job_id);
    if (!jobId) return { ok: false, error: "job_id is required" };
    const child = deps.jobsRepo.getById(jobId);
    if (!child) return { ok: false, error: `Job not found: ${jobId}` };
    const outputSummary = child.logs
      ? child.logs.split("\n").filter((line) => line.trim()).slice(child.status === "failed" ? -10 : -20).join("\n")
      : undefined;
    return {
      ok: true,
      data: {
        job_id: child.id,
        status: child.status,
        created_at: child.createdAt,
        started_at: child.startedAt ?? null,
        completed_at: child.completedAt ?? null,
        error: child.error ?? null,
        files_changed: Array.isArray(child.result) ? child.result.length : 0,
        commands_executed: Array.isArray(child.commands) ? child.commands.length : 0,
        output_summary: outputSummary ?? null,
        waiting_on_job_ids: deps.depsRepo.getBlockingDeps(jobId),
      },
    };
  }

  if (call.tool === "list_jobs") {
    const status = parseStringArg(args.status).toLowerCase();
    const validStatus = (
      status === "queued" || status === "running" || status === "completed"
      || status === "failed" || status === "cancelled" || status === "paused"
    ) ? status : undefined;
    const limit = Math.min(Math.max(parseNumberArg(args.limit) ?? 20, 1), 50);
    const { jobs } = deps.jobsRepo.list(validStatus ? [validStatus] : [], limit, 0);
    return {
      ok: true,
      data: jobs.map((row) => ({
        job_id: row.id,
        name: row.name ?? row.prompt.slice(0, 60),
        status: row.status,
        target: row.bridgeProgram ?? row.targetWorkerName ?? "any",
        created_at: row.createdAt,
        started_at: row.startedAt ?? null,
        completed_at: row.completedAt ?? null,
        error: row.error ?? null,
      })),
    };
  }

  // ── Skill tools (direct repo access, no HTTP round-trip) ─────────────
  if (call.tool === "search_skills") {
    const query = parseStringArg(args.query);
    if (!query) return { ok: false, error: "search_skills requires a query" };
    if (!deps.skillIndex) return { ok: false, error: "Skills system not available" };
    const program = parseStringArg(args.program) || undefined;
    const results = deps.skillIndex.search(query, { limit: 8, program });
    if (results.length === 0) return { ok: true, data: "No matching skills found." };
    return {
      ok: true,
      data: results.map((r) => ({
        slug: r.slug, program: r.program, title: r.title, score: r.relevanceScore?.toFixed(2),
      })),
    };
  }

  if (call.tool === "get_skill") {
    const slug = parseStringArg(args.slug);
    if (!slug) return { ok: false, error: "get_skill requires a slug" };
    if (!deps.skillIndex) return { ok: false, error: "Skills system not available" };
    const program = parseStringArg(args.program) || undefined;
    const skill = deps.skillIndex.get(slug, program);
    if (!skill) return { ok: false, error: `Skill not found: ${slug}` };
    return { ok: true, data: `# ${skill.title || slug} [${skill.program}]\n\n${skill.content || "(empty)"}` };
  }

  if (call.tool === "create_skill") {
    const slug = parseStringArg(args.slug);
    const title = parseStringArg(args.title);
    const program = parseStringArg(args.program);
    const content = parseStringArg(args.content);
    if (!slug || !title || !program || !content) {
      return { ok: false, error: "create_skill requires slug, title, program, content" };
    }
    if (!deps.skillsRepo && !deps.skillStore) return { ok: false, error: "Skills system not available" };
    try {
      const input = {
        name: slug, slug, program, title, description: title, content,
        category: parseStringArg(args.category) || "custom",
        keywords: Array.isArray(args.keywords) ? args.keywords : [program, slug],
        source: "agent", priority: 50, autoFetch: false, enabled: true,
      };
      if (deps.skillStore) {
        await deps.skillStore.upsertBySlugAndProgram(input);
      } else {
        deps.skillsRepo!.upsertBySlugAndProgram(input);
        deps.skillIndex?.refresh();
      }
      return { ok: true, data: `Skill created: ${slug} [${program}]` };
    } catch (err: any) {
      return { ok: false, error: `create_skill failed: ${err.message}` };
    }
  }

  if (call.tool === "rate_skill") {
    const slug = parseStringArg(args.slug);
    const rating = parseStringArg(args.rating);
    if (!slug || !rating) return { ok: false, error: "rate_skill requires slug and rating" };
    if (!deps.skillIndex || !deps.skillEffectivenessRepo) return { ok: false, error: "Skills system not available" };
    const skill = deps.skillIndex.get(slug);
    if (!skill) return { ok: false, error: `Skill not found: ${slug}` };
    const outcomeMap: Record<string, string> = { useful: "positive", not_useful: "negative", partial: "average" };
    deps.skillEffectivenessRepo.recordSkillOutcome(skill.id, job.id, outcomeMap[rating] || "average");
    return { ok: true, data: `Rated: ${slug} → ${rating}` };
  }

  if (call.tool === "rate_job") {
    const rating = parseStringArg(args.rating);
    if (!rating || !["good", "average", "poor"].includes(rating)) {
      return { ok: false, error: "rate_job requires rating: good, average, or poor" };
    }
    const notes = parseStringArg(args.notes) || "";
    const storedRating = rating === "good" ? "positive" as const
      : rating === "average" ? "average" as const
      : "negative" as const;
    deps.jobsRepo.markOutcome(job.id, storedRating, notes.trim(), null);
    if (deps.skillEffectivenessRepo) {
      const skillOutcome = rating === "good" ? "positive" : rating === "poor" ? "negative" : "average";
      deps.skillEffectivenessRepo.recordOutcome(job.id, skillOutcome);
    }
    return { ok: true, data: `Job rated: ${rating}${notes.trim() ? ` — ${notes.trim()}` : ""}` };
  }

  return { ok: false, error: `Unsupported tool: ${call.tool}` };
}

async function runLocalAgenticLoop(
  job: Job,
  config: AgentConfig,
  deps: SpawnerDeps,
  cwd: string,
  env: Record<string, string | undefined>,
  _basePrompt: string,
): Promise<LocalAgenticRunResult> {
  const startTime = Date.now();
  const modelName = config.model ?? "";
  const perModelMaxTurns = config.modelOverrides?.[modelName]?.maxTurns;
  let maxTurns = Math.max(perModelMaxTurns || config.maxTurns || LOCAL_AGENTIC_DEFAULTS.DEFAULT_TURNS, 1);
  // Training level can scale maxTurns: low=0.5x, medium=1x, high=2x
  const trainingLevel = (job as any).editorContext?.metadata?.coordinator_training_level;
  if (trainingLevel === "low") maxTurns = Math.max(Math.round(maxTurns * 0.5), 10);
  else if (trainingLevel === "high") maxTurns = maxTurns * 2;
  // Also scale job timeout for training analysis jobs
  let effectiveJobTimeoutMs = getEffectiveJobTimeoutMs(deps, job);
  if (trainingLevel === "high") effectiveJobTimeoutMs = Math.round(effectiveJobTimeoutMs * 2);
  else if (trainingLevel === "low") effectiveJobTimeoutMs = Math.round(effectiveJobTimeoutMs * 0.5);
  // Per-turn timeout: prefer agent config setting, fall back to computed value
  const configuredTurnTimeout = config.turnTimeoutMs ?? null;
  const rawTurnTimeout = configuredTurnTimeout
    ?? Math.max(Math.floor(effectiveJobTimeoutMs / Math.max(1, maxTurns)), LOCAL_AGENTIC_DEFAULTS.DEFAULT_TURN_TIMEOUT_MS);
  const effectiveTurnTimeoutMs = Math.min(
    Math.max(rawTurnTimeout, LOCAL_AGENTIC_DEFAULTS.MIN_TURN_TIMEOUT_MS),
    LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS,
  );

  let logBuffer = deps.jobsRepo.getById(job.id)?.logs ?? "";
  const usedBridgePrograms = new Set<string>();

  const perModelPrompt = config.modelOverrides?.[modelName]?.systemPrompt
    ?? config.systemPrompt;

  // Resolve Ollama base URL for native tool calling
  const ollamaBaseUrl = String(env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST ?? "").trim()
    || getOllamaBaseUrl();

  // Create in-process MCP client for tool execution
  const mcpDeps: McpDeps = {
    hub: deps.hub,
    policiesRepo: deps.policiesRepo!,
    headlessProgramsRepo: deps.headlessProgramsRepo!,
    config: deps.config,
    resourceLeaseManager: deps.resourceLeaseManager!,
    jobsRepo: deps.jobsRepo,
    jobInterventionsRepo: deps.jobInterventionsRepo!,
    agentsRepo: deps.agentsRepo,
    depsRepo: deps.depsRepo,
    callerJobId: job.id,
    processTracker: deps.processTracker,
    skillIndex: deps.skillIndex,
    settingsRepo: deps.settingsRepo,
    skillEffectivenessRepo: deps.skillEffectivenessRepo,
    skillsRepo: deps.skillsRepo,
    skillStore: deps.skillStore,
    handoffRepo: deps.handoffRepo,
  };
  const mcpClient = await createInProcessMcpClient(mcpDeps);

  // Fetch tool schemas from MCP and filter delegation tools based on prompt
  const allowDelegation = promptRequestsDelegation(job.prompt);
  const allMcpTools = await mcpClient.listTools();
  // Filter: remove delegation tools if not needed, remove client_api_request (internal)
  const filteredTools = allMcpTools.filter((t) => {
    if (t.name === "client_api_request") return false;
    if (t.name === "submit_job_intervention") return false;
    if (t.name === "list_job_interventions") return false;
    if (t.name === "read_client_file") return false;
    if (!allowDelegation && LOCAL_AGENTIC_DELEGATION_TOOLS.has(t.name)) return false;
    return true;
  });
  const toolSchemas = mcpToolsToOllamaSchemas(filteredTools);

  const loopDeps: AgenticLoopDeps = {
    async generateResponse(prompt, timeoutMs) {
      const turnResult = await runLocalModelTurn(job, config, deps, prompt, cwd, env, timeoutMs);
      return {
        response: [turnResult.stdout, turnResult.stderr].filter(Boolean).join("\n").trim(),
        error: turnResult.error,
        timedOut: turnResult.timedOut,
        exitCode: turnResult.exitCode,
      };
    },

    async generateChatResponse(messages, tools, timeoutMs, think) {
      logger.debug("spawner", `[local-oss] chat request: model=${modelName} messages=${messages.length} tools=${tools.length} think=${think ?? "auto"} timeout=${timeoutMs}ms`);
      const { ollamaChatWithTools } = await import("../local-models/ollama.js");
      const result = await ollamaChatWithTools({
        baseUrl: ollamaBaseUrl,
        model: modelName,
        messages,
        tools,
        timeoutMs,
        think,
      });
      if (result.message) {
        const tc = result.message.tool_calls;
        logger.debug("spawner", `[local-oss] response: content=${(result.message.content?.length ?? 0)} chars, tool_calls=${tc?.length ?? 0}`);
      } else {
        logger.debug("spawner", `[local-oss] response: error=${result.error ?? "none"} timedOut=${result.timedOut ?? false}`);
      }
      return result;
    },

    async executeTool(tool, args) {
      const mcpResult = await mcpClient.callTool(tool, args);
      return mcpResultToLoopResult(mcpResult);
    },

    log(message) {
      const text = message.endsWith("\n") ? message : `${message}\n`;
      logBuffer += text;
      deps.jobsRepo.appendLog(job.id, text);
      sendLog(deps, job, text);
    },

    isCancelled() {
      const current = deps.jobsRepo.getById(job.id);
      return !current || current.status === "cancelled";
    },

    onActivated() {
      sendStarted(deps, job);
      broadcastJobUpdated(deps, job.id);
    },

    onBridgeUsed(programs) {
      for (const program of programs) {
        if (deps.jobsRepo.addUsedBridge(job.id, program)) {
          usedBridgePrograms.add(program);
        }
      }
      if (usedBridgePrograms.size > 0) broadcastJobUpdated(deps, job.id);
    },

    getTurnPromptSuffix(turn) {
      const pending = getPendingOperatorNotesPrompt(deps.jobInterventionsRepo, job.id);
      if (pending.interventionIds.length > 0 && deps.jobInterventionsRepo) {
        const delivered = deps.jobInterventionsRepo.markDelivered(
          pending.interventionIds,
          { channel: "local-agentic-turn", turn },
          "Delivered to the next local agentic turn.",
        );
        broadcastInterventionUpdates(deps, job.id, delivered);
      }
      return pending.notePrompt;
    },

    checkTimeout() {
      if (Date.now() - startTime > effectiveJobTimeoutMs) {
        return "Local agentic loop timed out";
      }
      return undefined;
    },

    shouldFallbackToLegacy(rawOutput) {
      return /```[\s\S]*```/.test(rawOutput);
    },
  };

  // Local model system prompt: admin-editable setting → per-model override → nothing
  const localModelSystemPrompt = deps.settingsRepo?.get("local_model_system_prompt") ?? undefined;
  const effectiveSystemPrompt = [localModelSystemPrompt, perModelPrompt].filter(Boolean).join("\n\n") || undefined;

  const loopConfig: AgenticLoopConfig = {
    basePrompt: buildLocalAgenticTaskSummary(job, [...new Set(deps.hub.getBridges().map((b: any) => String(b.program ?? "").toLowerCase()).filter(Boolean))]),
    maxTurns,
    turnTimeoutMs: effectiveTurnTimeoutMs,
    allowDelegationTools: allowDelegation,
    systemPrompt: effectiveSystemPrompt,
    logPrefix: "[local-agentic]",
    toolSchemas,
    reasoningMode: config.reasoningMode ?? "plan-act",
  };

  try {
    // Prefer native tool calling (chat mode) which falls back to text-prompt internally
    const result = await runChatAgenticLoop(loopConfig, loopDeps);

    return {
      handled: !result.fallbackToLegacy,
      success: result.success,
      fallbackToLegacy: result.fallbackToLegacy ?? false,
      cancelled: result.cancelled ?? false,
      error: result.error,
      logBuffer,
      commands: result.commands as CommandResult[],
      durationMs: result.durationMs,
    };
  } finally {
    mcpClient.close();
  }
}

export async function spawnAgent(
  job: Job,
  config: AgentConfig,
  deps: SpawnerDeps,
) {
  // Allow the orphan sweep to flush stale wsLogBuffers entries
  if (!wsLogSweepDeps) wsLogSweepDeps = deps;

  // Server-managed orchestrator jobs (training orchestrator, housekeeping parent)
  // run server-side in a setTimeout — they must NOT be dispatched as agent processes.
  if (job.editorContext?.metadata?.coordinator_training_orchestrator) {
    logger.warn("spawner", `Job ${job.id} is a server-managed orchestrator — skipping agent spawn.`);
    return;
  }

  let cliWrapper: CliWrapperResult | null = null;
  let mcpConfigBackup: string | null = null;
  let mcpConfigPath: string | null = null;

  const failBeforeSpawn = (
    message: string,
    workspace: WorkspaceResolution,
    watcher?: ReturnType<typeof startWatching> | null,
  ) => {
    logger.error("spawner", message);
    flushWsLogNow(deps, job.id);
    deps.jobsRepo.fail(job.id, message, "");
    applyUsedBridgeAttribution(message);
    recordCoordinatorOutcome(false);
    sendComplete(deps, job, false, [], [], workspace.mode, message);
    broadcastJobUpdated(deps, job.id);
    watcher?.stop();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
  };

  // 1. Resolve workspace mode
  const workspace = resolveWorkspace(
    job,
    config,
    deps.projectsRepo,
    deps.config,
  );

  logger.info(
    "spawner",
    `Job ${job.id}: workspace mode = ${workspace.mode}, cwd = ${workspace.cwd}, step = ${workspace.resolutionStep} (${workspace.resolutionReason})`,
  );
  if (workspace.resolutionStep >= 5) {
    logger.warn(
      "spawner",
      `Job ${job.id}: workspace resolution reached fallback step ${workspace.resolutionStep} (${workspace.resolutionReason}). Validate project mapping/bridge metadata to avoid unintended mode selection.`,
    );
  }

  // 2. Record mode on the job
  deps.jobsRepo.setWorkspaceMode(job.id, workspace.mode);
  // Broadcast immediately so clients/admins see command/repo/sync while running.
  broadcastJobUpdated(deps, job.id);

  // 3. Handle sync mode: create dir and write attached files
  if (workspace.needsSync && workspace.syncDir && deps.syncManager) {
    await deps.syncManager.createSyncDir(job.id);
    if (job.files && job.files.length > 0) {
      await deps.syncManager.writeFiles(job.id, job.files);
      logger.info(
        "spawner",
        `Wrote ${job.files.length} files to sync dir for job ${job.id}`,
      );
    }
  }

  // 4. Build command (with connected bridge + headless program info for cross-bridge orchestration)
  const scopedWorkerNames = getTargetWorkerNames(job);
  const scopedWorkerSet = new Set(scopedWorkerNames);
  const connectedBridges = deps.hub.getBridges()
    .filter((bridge) => {
      if (scopedWorkerSet.size === 0) return true;
      const workerName = String(bridge.workerName ?? "").trim().toLowerCase();
      return workerName.length > 0 && scopedWorkerSet.has(workerName);
    })
    .map((b) => {
      const ctx = deps.hub.getBridgeContext(b.id);
      return {
        id: b.id,
        program: b.program,
        workerName: b.workerName,
        projectPath: b.projectPath,
        programVersion: b.programVersion,
        editorContext: ctx?.editorContext as Record<string, unknown> | undefined,
        contextItems: ctx?.items as Array<Record<string, unknown>> | undefined,
        files: ctx?.files,
      };
    });
  const headlessPrograms = deps.headlessProgramsRepo
    ? deps.headlessProgramsRepo.list().filter((hp) => hp.enabled).map((hp) => ({
        program: hp.program,
        language: hp.language,
      }))
    : [];
  // Coordination script selector: controls which coordination pieces are included
  const coordScripts = job.runtimeOptions?.coordinationScripts;
  const includeBridge = (coordScripts?.bridge ?? "enabled") !== "disabled";
  const includeCoordinator = (coordScripts?.coordinator ?? "enabled") !== "disabled";
  const includeTraining = (coordScripts?.training ?? "enabled") !== "disabled";

  // Coordinator script priority: per-bridge file → global file → settings DB
  // Local-oss models use their own lightweight protocol — the full coordinator
  // script (10KB+ of transport gate, CLI reference, REST examples) is irrelevant
  // and too large for local model context windows.
  const isLocalOss = config.engine === "local-oss";
  let orchestratorPromptOverride: string | undefined;
  if (includeBridge && !isLocalOss) {
    orchestratorPromptOverride =
      loadCoordinatorScript(deps.config.coordinatorScriptsDir, job.bridgeProgram ?? undefined);
    if (!orchestratorPromptOverride) {
      orchestratorPromptOverride = deps.settingsRepo?.get("orchestrator_prompt") ?? undefined;
    }
    // Strip training blocks from bridge scripts if training is disabled
    if (orchestratorPromptOverride && !includeTraining) {
      orchestratorPromptOverride = stripTrainingBlocks(orchestratorPromptOverride);
    }
  }

  // Optional task playbook context (JSON manifest + per-task instruction/example files).
  // Appended to coordinator prompt so agents can use team-curated references.
  let playbookContext: string | undefined;
  let matchedCoordinatorContext: Awaited<ReturnType<typeof loadCoordinatorPlaybookContextDetailed>>["matches"] = [];
  if (includeCoordinator) {
    const configuredReferencePaths = parseCoordinatorReferencePaths(
      deps.settingsRepo?.get("coordinator_reference_paths"),
    );
    const configuredPlaybookSourcePaths = parseCoordinatorReferencePaths(
      deps.settingsRepo?.get("coordinator_playbook_sources"),
    );
    const configuredPlaybookSourcePrograms = parseCoordinatorSourcePrograms(
      deps.settingsRepo?.get("coordinator_playbook_source_programs"),
    );
    const scopedPlaybookSourcePaths = filterCoordinatorSourcePathsByProgram(
      [...deps.config.coordinatorPlaybookSourcePaths, ...configuredPlaybookSourcePaths],
      configuredPlaybookSourcePrograms,
      job.bridgeProgram ?? undefined,
    );
    const trainingRepositoryPolicy = parseTrainingRepositoryPolicy(
      deps.settingsRepo?.get(TRAINING_REPOSITORY_POLICY_SETTINGS_KEY) ?? null,
    );
    const trainingRepositoryOverrides = parseTrainingRepositoryOverrides(
      deps.settingsRepo?.get(TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY) ?? null,
    );
    const clientSourcePaths = resolveCoordinatorClientSourcePaths(job);
    const playbookContextResult = loadCoordinatorPlaybookContextDetailed({
      dir: deps.config.coordinatorPlaybooksDir,
      program: job.bridgeProgram ?? undefined,
      prompt: job.prompt,
      projectRoot: job.editorContext?.projectRoot,
      referencePaths: [
        ...deps.config.coordinatorReferencePaths,
        ...configuredReferencePaths,
      ],
      playbookSourcePaths: [
        ...scopedPlaybookSourcePaths,
      ],
      clientSourcePaths,
      trainingRepositoryPolicy,
      trainingRepositoryOverrides,
    });
    playbookContext = playbookContextResult.text;
    matchedCoordinatorContext = playbookContextResult.matches;
    // Strip training blocks from playbook context if training is disabled
    if (playbookContext && !includeTraining) {
      playbookContext = stripTrainingBlocks(playbookContext);
    }
  }
  const recordCoordinatorOutcome = (success: boolean, outcome?: string) => {
    // Always record routing outcome for learning (even for non-bridge jobs)
    recordRoutingOutcome(success);

    if (!job.bridgeProgram || matchedCoordinatorContext.length === 0) return;
    recordCoordinatorContextOutcome({
      dir: deps.config.coordinatorPlaybooksDir,
      program: job.bridgeProgram,
      matches: matchedCoordinatorContext,
      success,
    });
    recordCoordinatorExecutionOutcome({
      dir: deps.config.coordinatorPlaybooksDir,
      program: job.bridgeProgram,
      prompt: job.prompt,
      success,
      matches: matchedCoordinatorContext,
      outcome,
      skillsRepo: deps.skillsRepo,
    });
  };
  // Record routing outcome for learning which configs succeed for which task patterns
  const recordRoutingOutcome = (success: boolean) => {
    if (!deps.routingOutcomesRepo) return;
    try {
      const { classifyTaskPattern, promptComplexityScore } = require("./task-classifier.js") as typeof import("./task-classifier.js");
      const pattern = classifyTaskPattern(job.prompt, job.bridgeProgram ?? undefined);
      const durationMs = Date.now() - startTime;
      const costUsd = sjState?.costUsd ?? 0;
      deps.routingOutcomesRepo.record(
        pattern,
        job.agentConfigId,
        config.engine,
        config.model ?? null,
        success ? "success" : "failure",
        costUsd,
        durationMs,
        promptComplexityScore(job.prompt),
      );
    } catch (err) {
      logger.warn("spawner", `Failed to record routing outcome for job ${job.id}: ${err}`);
    }
  };

  const knownBridgePrograms = [
    ...new Set(
      getCoordinatorScriptPrograms({
        coordinatorScriptsDir: deps.config.coordinatorScriptsDir,
        workersRepo: deps.workersRepo,
        hub: deps.hub,
        headlessProgramsRepo: deps.headlessProgramsRepo,
      })
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const applyUsedBridgeAttribution = (logs: string, extraPrograms: string[] = []) => {
    const inferred = new Set<string>([
      ...inferUsedBridgeProgramsFromLogs(job, logs, knownBridgePrograms),
      ...extraPrograms.map((p) => String(p ?? "").trim().toLowerCase()).filter(Boolean),
    ]);
    let changed = false;
    for (const program of inferred) {
      if (deps.jobsRepo.addUsedBridge(job.id, program)) {
        changed = true;
      }
    }
    if (changed) {
      // Keep source/bridge badges live while the job is still running.
      broadcastJobUpdated(deps, job.id);
    }
  };
  if (playbookContext) {
    orchestratorPromptOverride = orchestratorPromptOverride
      ? `${orchestratorPromptOverride}\n\n${playbookContext}`
      : playbookContext;
  }

  // Inject relevant skills from the skills DB into the agent's context.
  // Skills are ranked by semantic relevance to the job prompt + effectiveness scores.
  // AutoFetch skills (coordinators, bridge scripts) always inject regardless of score.
  if (deps.skillsRepo) {
    const jobProgram = (job.bridgeProgram ?? "").trim().toLowerCase();

    // Only inject auto-fetch skills (coordinators, bridge scripts) into the
    // system prompt. These are small and always relevant. All other skills
    // are available on-demand via search_skills/get_skill MCP tools — the
    // coordinator agent should pull them during execution when needed.
    const allEnabled = deps.skillsRepo.listAll({ enabled: true });
    // Only inject auto-fetch skills that match the job's program or are global.
    // Don't inject houdini skills into blender jobs (they'd just get rated negative).
    const autoFetchSkills = allEnabled.filter((s) => {
      if (!s.autoFetch) return false;
      const sp = s.program.trim().toLowerCase();
      return !sp || sp === "global" || sp === jobProgram;
    });
    const rankedSkillCount = allEnabled.filter((s) => {
      if (s.autoFetch) return false;
      const sp = s.program.trim().toLowerCase();
      return !sp || sp === "global" || sp === jobProgram;
    }).length;

    if (autoFetchSkills.length > 0) {
      const skillLines: string[] = ["## Coordinator Knowledge"];
      const MAX_SKILL_CONTENT_TOTAL = 15_000;
      let totalInjected = 0;
      for (const skill of autoFetchSkills) {
        if (totalInjected >= MAX_SKILL_CONTENT_TOTAL) break;
        const header = skill.title || skill.name || skill.slug;
        const tag = skill.program && skill.program !== "global" ? ` [${skill.program}]` : "";
        skillLines.push(`### ${header}${tag}`);
        if (skill.description) skillLines.push(skill.description);
        if (skill.content) {
          const capped = skill.content.slice(0, Math.min(4000, MAX_SKILL_CONTENT_TOTAL - totalInjected));
          skillLines.push(capped);
          totalInjected += capped.length;
        }
        skillLines.push("");
      }

      // Tell the agent about on-demand skills it can pull
      if (rankedSkillCount > 0) {
        skillLines.push(`## Available Skills (${rankedSkillCount} learned skills)`);
        skillLines.push(
          "Before starting work, search for relevant skills to avoid reinventing the wheel. " +
          "Use MCP tools if available: search_skills, get_skill, create_skill, rate_skill, rate_job. " +
          "If MCP is unavailable, use the am CLI instead:\n" +
          "  - `am skills search '<query>' [--program <program>]` — find relevant skills\n" +
          "  - `am skills get <slug>` — load a skill's full content\n" +
          "  - `am skills create --slug <slug> --title '<title>' --program <program> --content '<content>'` — save a new skill\n" +
          "  - `am skills rate <slug> <useful|not_useful|partial>` — rate a skill after using it\n" +
          "  - `am jobs rate <good|average|poor> [notes]` — rate your own job outcome before finishing\n" +
          "Search for your task type before starting (e.g., 'blender rendering', 'nuke compositing'). " +
          "Search AGAIN whenever you hit errors, unexpected results, or need to retry — use the specific problem as the query. " +
          "Do not keep guessing when a skill might already have the answer. " +
          "When you learn something non-trivial (workarounds, error fixes, API quirks, multi-step patterns), " +
          "create a skill with `create_skill` so future tasks benefit.",
        );
      }

      // For training jobs: emphasize incremental skill creation during analysis
      const isTrainingJob = (job.editorContext?.metadata as any)?.coordinator_training_job === true;
      if (isTrainingJob) {
        skillLines.push("");
        skillLines.push(
          "## TRAINING MODE — Incremental Skill Creation\n" +
          "You are running a TRAINING job. Your primary goal is to analyze source material and CREATE SKILLS.\n" +
          "**Create skills AS YOU DISCOVER THEM** — do not wait until the end.\n" +
          "For each useful pattern, technique, gotcha, or best practice you find:\n" +
          "1. Use `create_skill` immediately with a descriptive slug, clear title, and actionable content\n" +
          "2. Include concrete code examples, parameter values, and common pitfalls\n" +
          "3. Use the program name from the training context (e.g., 'houdini', 'blender')\n" +
          "4. Category should be 'training' for learned patterns, 'playbook' for workflows\n" +
          "5. Search existing skills first (`search_skills`) to avoid duplicates — update instead if the pattern exists\n\n" +
          "A training job that creates 0 skills has failed its purpose. Aim for 3-10 skills per training run.",
        );
      }

      // Tell the agent to rate skills and their own job outcome
      const autoFetchSlugs = autoFetchSkills.map((s) => s.slug);
      skillLines.push("\n## Job & Skill Feedback");
      skillLines.push(
        "Before finishing your task, you MUST do the following:\n" +
        "1. **Create skills if you learned something new** — if you discovered workarounds, non-obvious techniques, error fixes, " +
        "API quirks, or multi-step workflows during this task, call `create_skill` for each one. " +
        "Include concrete code examples, parameter values, and gotchas. " +
        "Skip this if the task was straightforward and didn't teach you anything new.\n" +
        "2. **Rate your job outcome** — call `rate_job` with `good`, `average`, or `poor` to self-assess how well the task went.\n" +
        "3. **Rate skills you used** — call `rate_skill` for each skill you loaded or referenced, rating it `useful`, `not_useful`, or `partial`." +
        (autoFetchSlugs.length > 0
          ? `\n   Auto-fetched skills to rate: ${autoFetchSlugs.map((s) => `\`${s}\``).join(", ")}.`
          : "") +
        "\n\nThis feedback is critical — it improves skill recommendations and helps the system learn from your work.",
      );

      const skillBlock = skillLines.join("\n").trim();
      orchestratorPromptOverride = orchestratorPromptOverride
        ? `${orchestratorPromptOverride}\n\n${skillBlock}`
        : skillBlock;

      // Record auto-fetch skill usage for effectiveness tracking.
      // Agents are instructed to rate these, so recording usage ensures
      // the effectiveness data is meaningful.
      if (deps.skillEffectivenessRepo) {
        for (const skill of autoFetchSkills) {
          deps.skillEffectivenessRepo.recordUsage(skill.id, job.id);
        }
      }
    }

    // Log for observability
    const promptPreview = job.prompt.length > 80 ? job.prompt.slice(0, 80) + "..." : job.prompt;
    logger.info(
      "skill-ranking",
      `Job ${job.id} [${jobProgram || "global"}] "${promptPreview}" → ${autoFetchSkills.length} auto-fetch, ${rankedSkillCount} on-demand skills available`,
    );
  }

  const clientPromptOverrideBlock = buildCoordinatorClientPromptOverrideBlock(job);
  if (clientPromptOverrideBlock) {
    orchestratorPromptOverride = orchestratorPromptOverride
      ? `${orchestratorPromptOverride}\n\n${clientPromptOverrideBlock}`
      : clientPromptOverrideBlock;
  }
  const jobForLaunch =
    deps.jobInterventionsRepo && !(config.engine === "local-oss" && workspace.mode === "command")
      ? (() => {
          const pending = deps.jobInterventionsRepo?.listPending(job.id) ?? [];
          if (pending.length === 0) return job;
          return {
            ...job,
            prompt: appendOperatorNotesToPrompt(job.prompt, pending),
          };
        })()
      : job;

  // Resolve default project directory from settings or platform default
  const defaultProjectDir =
    deps.settingsRepo?.get("default_project_dir") || getDefaultProjectDir();

  const resumeSessionId = job.sessionId ?? undefined;
  const { command, args, env, cwd, runAsUser } = buildCommand(
    config,
    jobForLaunch,
    deps.toolRestrictions,
    workspace,
    connectedBridges,
    headlessPrograms,
    orchestratorPromptOverride || undefined,
    defaultProjectDir || undefined,
    resumeSessionId,
  );

  logger.info(
    "spawner",
    `Spawning ${config.engine}: ${command} ${args.join(" ")}${runAsUser ? ` [runAs=${runAsUser.username}]` : ""} (job: ${job.id})`,
  );

  // 5. Set up file change detection (ALL modes — file_path policies must be enforced everywhere)
  // Uses OS-level fs.watch + a fast path list (readdir only, no stat/content reads)
  let beforePaths: Set<string> | null = null;
  let watcher: ReturnType<typeof startWatching> | null = null;
  if (workspace.mode === "command" && !existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
  }
  logger.info("spawner", `Collecting paths and starting watcher for ${cwd}`);
  beforePaths = await collectPaths(cwd);
  watcher = startWatching(cwd);
  if (beforePaths.size === 0) {
    logger.warn("spawner", `Directory ${cwd} exceeds path limit — file change detection disabled for this job`);
  } else {
    logger.info("spawner", `Tracking ${beforePaths.size} existing paths`);
  }

  // 6. Spawn process — strip nested-agent session env vars so child CLIs do not
  // inherit sandbox/session constraints from the parent shell.
  const cleanEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(cleanEnv)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("CLAUDE") || upper.startsWith("MCP_")) {
      delete cleanEnv[key];
    }
  }
  // Restore CLAUDE_CODE_MAX_OUTPUT_TOKENS with a generous default so jobs
  // don't hit the 32k ceiling on long responses.
  cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "128000";
  if (config.engine === "codex") {
    // Prevent inherited Codex sandbox/session flags from disabling localhost
    // bridge calls (am/curl) inside spawned Codex jobs.
    delete cleanEnv.CODEX_SANDBOX;
    delete cleanEnv.CODEX_SANDBOX_NETWORK_DISABLED;
    delete cleanEnv.CODEX_THREAD_ID;
    delete cleanEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  }
  if (job.targetWorkerName) {
    const targetWorkerName = String(job.targetWorkerName).trim().toLowerCase();
    cleanEnv.ARKESTRATOR_TARGET_WORKER_NAME = targetWorkerName;
    const workerIp = String(deps.workersRepo?.getByName(targetWorkerName)?.lastIp ?? "").trim();
    if (workerIp) cleanEnv.ARKESTRATOR_TARGET_WORKER_IP = workerIp;
  }

  const commandName = basename(String(command ?? "").trim().toLowerCase());
  const usesOllamaCli = /^ollama(?:\.(?:exe|cmd|bat|ps1))?$/.test(commandName);
  let targetWorkerOllamaBaseUrl: string | null = null;
  const configuredServerOllamaBaseUrl = getConfiguredOllamaBaseUrl(deps.settingsRepo);

  if (config.engine === "local-oss" && usesOllamaCli) {
    cleanEnv.OLLAMA_HOST = configuredServerOllamaBaseUrl;
    cleanEnv.OLLAMA_BASE_URL = configuredServerOllamaBaseUrl;
  }

  if (config.engine === "local-oss") {
    // Determine the effective model host: "server" uses server Ollama; "client" (default)
    // auto-distributes to any online worker with localLlmEnabled.
    const effectiveHost = config.localModelHost ?? "client";

    if (effectiveHost === "client") {
      if (!deps.settingsRepo || !deps.workersRepo) {
        failBeforeSpawn(
          `Distributed local-LLM targeting requires settings + workers repositories for job ${job.id}`,
          workspace,
          watcher,
        );
        return;
      }

      let resolution: Awaited<ReturnType<typeof resolveWorkerLocalLlmEndpoint>> | null = null;
      let targetWorkerName = String(job.targetWorkerName ?? "").trim().toLowerCase();

      if (targetWorkerName) {
        // Explicit worker target — resolve directly
        resolution = resolveWorkerLocalLlmEndpoint(deps.settingsRepo, deps.workersRepo, targetWorkerName);
      } else {
        // Auto-select: find any online worker with localLlmEnabled.
        // Skip the server-side health check — the client-dispatch path will
        // run Ollama locally on the worker's Tauri client, so the server
        // doesn't need to reach the worker's Ollama endpoint.
        resolution = await resolveAnyAvailableWorkerLlm(
          deps.settingsRepo,
          deps.workersRepo,
          deps.hub,
          undefined,
          true, // skipHealthCheck — client dispatch handles Ollama locally
        );
        if (resolution) {
          targetWorkerName = resolution.workerName;
        }
      }

      if (!resolution || !resolution.enabled) {
        failBeforeSpawn(
          targetWorkerName
            ? `Worker "${targetWorkerName}" is not enabled for distributed local LLM execution. Update machine rules first.`
            : `No online worker with local LLM enabled found. Enable localLlmEnabled on at least one machine in worker rules.`,
          workspace,
          watcher,
        );
        return;
      }
      // For client-dispatch, baseUrl is optional — the Tauri client talks to
      // its own localhost Ollama. Only require baseUrl for server-side execution.
      if (!resolution.baseUrl && effectiveHost !== "client") {
        failBeforeSpawn(
          `Worker "${targetWorkerName}" has no local LLM endpoint. Set localLlmBaseUrl in machine rules or ensure worker IP is available.`,
          workspace,
          watcher,
        );
        return;
      }

      cleanEnv.ARKESTRATOR_TARGET_WORKER_OLLAMA_BASE_URL = resolution.baseUrl ?? undefined;
      targetWorkerOllamaBaseUrl = resolution.baseUrl;
      if (usesOllamaCli && resolution.baseUrl) {
        cleanEnv.OLLAMA_HOST = resolution.baseUrl;
        cleanEnv.OLLAMA_BASE_URL = resolution.baseUrl;
        const health = await checkWorkerLocalLlmHealth(resolution.baseUrl);
        if (!health.ok) {
          // Don't hard-fail here — the client-dispatch path below may handle
          // this by dispatching to the worker's Tauri client which has local
          // Ollama access.  Log a note and continue.
          const note =
            `[local-oss] server cannot reach worker "${targetWorkerName}" Ollama at ${resolution.baseUrl}: ` +
            `${health.error ?? "unreachable"}. Will try client dispatch.\n`;
          deps.jobsRepo.appendLog(job.id, note);
          sendLog(deps, job, note);
        } else {
          const line =
            `[local-oss] routed to worker "${targetWorkerName}" via ${resolution.baseUrl} ` +
            `(${health.modelCount} model${health.modelCount === 1 ? "" : "s"}, ${health.latencyMs}ms)\n`;
          deps.jobsRepo.appendLog(job.id, line);
          sendLog(deps, job, line);
        }
      } else {
        const line =
          `[local-oss] target worker "${targetWorkerName}" selected. Endpoint=${resolution.baseUrl} ` +
          `(non-ollama command: ${commandName || command}).\n`;
        deps.jobsRepo.appendLog(job.id, line);
        sendLog(deps, job, line);
      }
    }
    // else: effectiveHost === "server" — use server Ollama (already set above)
  }

  // Skip server-side model pull when localModelHost is "client" — the Tauri
  // client will check model availability locally via its own Ollama.
  const effectiveHostForModelCheck = config.engine === "local-oss" ? (config.localModelHost ?? "client") : "server";
  if (config.engine === "local-oss" && usesOllamaCli && effectiveHostForModelCheck !== "client") {
    const requestedModel = resolveRequestedOllamaModel(config, args);
    if (requestedModel) {
      const baseUrl = targetWorkerOllamaBaseUrl
        || String(cleanEnv.OLLAMA_BASE_URL ?? cleanEnv.OLLAMA_HOST ?? "").trim()
        || configuredServerOllamaBaseUrl
        || getOllamaBaseUrl();
      try {
        await ensureOllamaModelPresent(deps, job, requestedModel, baseUrl);
      } catch (err: any) {
        failBeforeSpawn(
          `Failed to auto-download required Ollama model "${requestedModel}" at ${baseUrl}: ${err?.message ?? err}`,
          workspace,
          watcher,
        );
        return;
      }
    }
  }

  // Inject Arkestrator connection info so spawned agents can use cross-bridge commands
  const sharedConfig = readSharedConfig();
  const sharedServerUrl = String(sharedConfig?.serverUrl ?? "").trim();
  const sharedApiKey = String(sharedConfig?.apiKey ?? "").trim();
  cleanEnv.ARKESTRATOR_URL = resolveSpawnedAgentServerUrl(deps.config.port, sharedConfig);
  if (sharedServerUrl && sharedServerUrl !== cleanEnv.ARKESTRATOR_URL) {
    cleanEnv.ARKESTRATOR_PUBLIC_URL = sharedServerUrl;
  }
  if (sharedApiKey) {
    cleanEnv.ARKESTRATOR_API_KEY = sharedApiKey;
  }
  cleanEnv.ARKESTRATOR_JOB_ID = job.id;
  if (job.editorContext?.projectRoot) {
    cleanEnv.ARKESTRATOR_PROJECT_PATH = job.editorContext.projectRoot;
  }
  if (defaultProjectDir) {
    cleanEnv.ARKESTRATOR_DEFAULT_PROJECT_DIR = defaultProjectDir;
  }
  // 6b. Set up CLI wrapper + MCP config for bridge interaction
  const serverUrl = cleanEnv.ARKESTRATOR_URL;
  const apiKey = cleanEnv.ARKESTRATOR_API_KEY ?? "";

  if (serverUrl && apiKey) {
    // Write CLI wrapper (works for all engines)
    try {
      cliWrapper = writeCliWrapper(serverUrl, apiKey);
      cleanEnv.PATH = `${cliWrapper.dir}${process.platform === "win32" ? ";" : ":"}${cleanEnv.PATH ?? ""}`;
    } catch (err) {
      logger.warn("spawner", `Failed to write CLI wrapper: ${err}`);
    }

    // Write .mcp.json for MCP-capable engines in the actual process cwd.
    if (config.engine === "claude-code" || config.engine === "codex") {
      try {
        const injected = writeInjectedMcpConfig(cwd, serverUrl, apiKey, job.id);
        mcpConfigPath = injected.path;
        mcpConfigBackup = injected.backup;
        logger.info("spawner", `Wrote .mcp.json for ${config.engine} job ${job.id} in ${cwd}`);
      } catch (err) {
        logger.warn("spawner", `Failed to write .mcp.json: ${err}`);
        mcpConfigPath = null;
      }
    }
  }

  // Local-OSS native tool loop: runs Ollama chat API with structured tool calling.
  // Applies to all workspace modes — the native loop handles bridge commands directly
  // via MCP tools, so it doesn't need the legacy subprocess+fenced-command path.
  if (config.engine === "local-oss") {
    // Use the lean prompt for the agentic loop — the protocol instructions,
    // tool list, and turn transcript are added by buildLocalAgenticTurnPrompt().
    // The full orchestrator prompt (MCP gates, CLI fallbacks, etc.) overwhelms
    // small local models.
    const basePrompt = buildLocalAgenticBasePrompt(
      job, workspace, connectedBridges, orchestratorPromptOverride,
    );

    // When localModelHost === "client", try dispatching to the connected Tauri
    // client for the target worker machine so it can run Ollama locally.
    const effectiveHostForDispatch = config.localModelHost ?? "client";
    if (effectiveHostForDispatch === "client") {
      const resolvedModel = resolveRequestedOllamaModel(config, args) ?? config.model ?? "llama3.2:latest";
      const targetWorker = String(job.targetWorkerName ?? "").trim().toLowerCase();

      // Try to find any target worker name — either explicit or auto-resolved
      let dispatchWorkerName = targetWorker;
      if (!dispatchWorkerName) {
        // Auto-select: find any client with localLlmEnabled.
        // Skip health check — the client runs Ollama locally.
        if (deps.settingsRepo && deps.workersRepo) {
          const autoResolution = await resolveAnyAvailableWorkerLlm(
            deps.settingsRepo,
            deps.workersRepo,
            deps.hub,
            undefined,
            true, // skipHealthCheck
          );
          if (autoResolution) {
            dispatchWorkerName = autoResolution.workerName;
          }
        }
        // If still no worker name, check if there are any clients at all
        if (!dispatchWorkerName) {
          const allClients = deps.hub.getClients();
          if (allClients.length > 0) {
            dispatchWorkerName = allClients[0].machineId || allClients[0].workerName || "";
          }
        }
      }

      if (dispatchWorkerName) {
        const perModelMaxTurns = config.modelOverrides?.[resolvedModel]?.maxTurns;
        let maxTurns = Math.max(perModelMaxTurns || config.maxTurns || LOCAL_AGENTIC_DEFAULTS.DEFAULT_TURNS, 1);
        // Training level can scale maxTurns for client-dispatched jobs too
        const cliTrainingLevel = (job as any).editorContext?.metadata?.coordinator_training_level;
        let cliJobTimeoutMs = getEffectiveJobTimeoutMs(deps, job);
        if (cliTrainingLevel === "low") { maxTurns = Math.max(Math.round(maxTurns * 0.5), 10); cliJobTimeoutMs = Math.round(cliJobTimeoutMs * 0.5); }
        else if (cliTrainingLevel === "high") { maxTurns = maxTurns * 2; cliJobTimeoutMs = Math.round(cliJobTimeoutMs * 2); }
        const cliRawTurnTimeout = config.turnTimeoutMs
          ?? Math.max(Math.floor(cliJobTimeoutMs / Math.max(1, maxTurns)), LOCAL_AGENTIC_DEFAULTS.DEFAULT_TURN_TIMEOUT_MS);
        const turnTimeoutMs = Math.min(
          Math.max(cliRawTurnTimeout, LOCAL_AGENTIC_DEFAULTS.MIN_TURN_TIMEOUT_MS),
          LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS,
        );
        const perModelPrompt = config.modelOverrides?.[resolvedModel]?.systemPrompt
          ?? config.systemPrompt;
        const clientLocalSystemPrompt = deps.settingsRepo?.get("local_model_system_prompt") ?? undefined;
        const clientEffectivePrompt = [clientLocalSystemPrompt, perModelPrompt].filter(Boolean).join("\n\n") || undefined;

        const dispatched = dispatchToClient(
          deps.hub,
          job,
          config,
          dispatchWorkerName,
          basePrompt,
          resolvedModel,
          maxTurns,
          turnTimeoutMs,
          clientEffectivePrompt,
          (result) => {
            // This callback fires when the client reports completion
            // Release the local LLM gate so the next queued job can start
            deps.localLlmGate?.release(job.id);

            if (result.success) {
              deps.jobsRepo.completeWithCommands(job.id, result.commands, "");
              const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
              broadcastInterventionUpdates(deps, job.id, rejected);
              recordCoordinatorOutcome(true);
              sendComplete(deps, job, true, [], [], workspace.mode);
              broadcastJobUpdated(deps, job.id);
              resumePausedDependents(deps, job.id);
            } else {
              const msg = result.error || "Client-dispatched job failed";
              deps.jobsRepo.fail(job.id, msg, "");
              recordCoordinatorOutcome(false, msg);
              sendComplete(deps, job, false, [], [], workspace.mode, msg);
              broadcastJobUpdated(deps, job.id);
              notifyBlockedDependents(deps, job.id, "failed");
            }

            try {
              deps.usageRepo.record(
                job.id,
                job.submittedBy ?? null,
                job.agentConfigId,
                0, 0,
                result.durationMs,
                0,
              );
              deps.jobsRepo.updateTokens(job.id, 0, 0, 0, result.durationMs);
              broadcastJobUpdated(deps, job.id);
            } catch (err) {
              logger.warn("spawner", `Failed to record usage for client-dispatched job ${job.id}: ${err}`);
            }

            cleanupSync(deps, workspace, job.id);
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          },
          serverUrl && apiKey ? { url: `${serverUrl}/mcp`, apiKey } : undefined,
        );

        if (dispatched) {
          const line = `[local-oss] dispatched to client on worker "${dispatchWorkerName}" (model: ${resolvedModel})\n`;
          deps.jobsRepo.appendLog(job.id, line);
          sendLog(deps, job, line);
          sendStarted(deps, job);
          broadcastJobUpdated(deps, job.id);
          // Job is now running on the client — return without spawning a subprocess
          return;
        }
        // Fall through to server-side execution if dispatch failed
        logger.info("spawner", `Client dispatch failed for job ${job.id}, falling back to server-side execution`);
      }
    }

    const localLoop = await runLocalAgenticLoop(
      job,
      config,
      deps,
      cwd,
      cleanEnv,
      basePrompt,
    );

    // Release the local LLM gate for server-side execution
    deps.localLlmGate?.release(job.id);

    if (localLoop.handled) {
      if (localLoop.cancelled) {
        logger.info("spawner", `Job ${job.id}: local agentic loop stopped (cancelled)`);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job was cancelled before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        cleanupSync(deps, workspace, job.id);
        cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
        return;
      }

      if (localLoop.success) {
        applyUsedBridgeAttribution(localLoop.logBuffer);
        deps.jobsRepo.completeWithCommands(job.id, localLoop.commands, localLoop.logBuffer);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        recordCoordinatorOutcome(true);
        // Commands were already executed live during the loop. Send no commands in
        // job_complete payload to avoid duplicate bridge execution.
        sendComplete(deps, job, true, [], [], workspace.mode);
        broadcastJobUpdated(deps, job.id);
        resumePausedDependents(deps, job.id);
      } else {
        // If the agentic loop returned failure but the logs contain a [done]
        // marker, the agent actually completed its work. Bridge/tool timeouts
        // can cause the loop to abort even though the agent produced full output.
        const agentActuallyCompleted = localLoop.logBuffer?.includes("[done]") ?? false;
        if (agentActuallyCompleted && localLoop.commands.length > 0) {
          logger.info(
            "spawner",
            `Job ${job.id}: local agentic loop returned failure but agent completed ([done] in logs). Treating as success.`,
          );
          applyUsedBridgeAttribution(localLoop.logBuffer);
          deps.jobsRepo.completeWithCommands(job.id, localLoop.commands, localLoop.logBuffer);
          const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
          broadcastInterventionUpdates(deps, job.id, rejected);
          recordCoordinatorOutcome(true);
          sendComplete(deps, job, true, [], [], workspace.mode);
          broadcastJobUpdated(deps, job.id);
          resumePausedDependents(deps, job.id);
        } else {
          const msg = localLoop.error || "Local agentic loop failed";
          applyUsedBridgeAttribution(localLoop.logBuffer ? `${localLoop.logBuffer}\n${msg}` : msg);
          deps.jobsRepo.fail(job.id, msg, localLoop.logBuffer);
          recordCoordinatorOutcome(false, msg);
          sendComplete(deps, job, false, [], [], workspace.mode, msg);
          broadcastJobUpdated(deps, job.id);
          notifyBlockedDependents(deps, job.id, "failed");
        }
      }

      try {
        deps.usageRepo.record(
          job.id,
          job.submittedBy ?? null,
          job.agentConfigId,
          0,
          0,
          localLoop.durationMs,
          0,
        );
        deps.jobsRepo.updateTokens(job.id, 0, 0, 0, localLoop.durationMs);
        broadcastJobUpdated(deps, job.id);
      } catch (err) {
        logger.warn("spawner", `Failed to record usage for local loop job ${job.id}: ${err}`);
      }

      cleanupSync(deps, workspace, job.id);
      cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
      return;
    }

    logger.info(
      "spawner",
      `Job ${job.id}: local agentic loop fallback to legacy command parser (${localLoop.error ?? "invalid protocol output"})`,
    );
  }

  const startTime = Date.now();
  let proc;
  try {
    // claude-code hangs when stdin is piped on Windows (stdout never flushes).
    // Use "ignore" for claude-code; codex still needs "pipe" for stdin-based
    // guidance delivery.
    const stdinMode = config.engine === "codex" ? "pipe" as const : "ignore" as const;
    const { proc: spawnedProc, resolvedCommand } = spawnWithFallback(command, args, {
      cwd,
      env: cleanEnv,
      runAsUser,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdinMode,
    });
    proc = spawnedProc;
    if (resolvedCommand !== command) {
      logger.info("spawner", `Resolved command '${command}' -> '${resolvedCommand}' for job ${job.id}`);
    }
  } catch (err) {
    const errorMsg = `Failed to spawn process: ${err}`;
    logger.error("spawner", errorMsg);
    deps.jobsRepo.fail(job.id, errorMsg, "");
    applyUsedBridgeAttribution(errorMsg);
    recordCoordinatorOutcome(false);
    sendComplete(deps, job, false, [], [], workspace.mode, errorMsg);
    broadcastJobUpdated(deps, job.id);
    watcher?.stop();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }

  // Per-job timeout for training level: high=2x, low=0.5x
  const effectiveTimeoutMs = getEffectiveJobTimeoutMs(deps, job);
  const procTrainingLevel = (job as any).editorContext?.metadata?.coordinator_training_level;
  const procTimeoutMs = procTrainingLevel === "high" ? Math.round(effectiveTimeoutMs * 2)
    : procTrainingLevel === "low" ? Math.round(effectiveTimeoutMs * 0.5)
    : effectiveTimeoutMs;
  deps.processTracker.register(job.id, proc, procTimeoutMs);

  // Apply process priority if set by policy (best-effort, fire-and-forget)
  if (deps.processPriority && deps.processPriority !== "normal" && proc.pid) {
    import("../utils/spawn.js").then(({ applyProcessPriority }) => {
      applyProcessPriority(proc.pid, deps.processPriority!).then((ok) => {
        if (ok) {
          logger.info("spawner", `Job ${job.id}: process priority set to "${deps.processPriority}"`);
        } else {
          logger.debug("spawner", `Job ${job.id}: failed to set process priority "${deps.processPriority}" (non-fatal)`);
        }
      });
    });
  }

  if (deps.jobInterventionsRepo && !(config.engine === "local-oss" && workspace.mode === "command")) {
    const pending = deps.jobInterventionsRepo.listPending(job.id);
    if (pending.length > 0) {
      const delivered = deps.jobInterventionsRepo.markDelivered(
        pending.map((entry) => entry.id),
        { channel: "launch" },
        "Delivered into the launched job prompt.",
      );
      broadcastInterventionUpdates(deps, job.id, delivered);
    }
  }

  // Notify bridge that the job started
  sendStarted(deps, job);

  // Broadcast updated job (now "running") to all clients
  broadcastJobUpdated(deps, job.id);

  // 7. Stream stdout and stderr concurrently
  const LOG_BUFFER_MAX = 5 * 1024 * 1024; // 5 MB cap on in-memory log buffer
  let logBuffer = "";
  const isStreamJson = config.engine === "claude-code" || config.engine === "codex";
  const sjState: StreamJsonState | null = isStreamJson ? createStreamJsonState() : null;
  let sessionIdSaved = false;

  // Helper: record token usage for this job. Called from every post-process completion path.
  let tokensRecorded = false;
  function recordTokens() {
    if (tokensRecorded) return;
    tokensRecorded = true;
    try {
      const durationMs = Date.now() - startTime;
      const sjTokens = sjState && (sjState.inputTokens > 0 || sjState.outputTokens > 0)
        ? { inputTokens: sjState.inputTokens, outputTokens: sjState.outputTokens }
        : null;
      const tokens = sjTokens ?? parseTokenUsage(logBuffer, config.engine);
      const inputTokens = tokens?.inputTokens ?? 0;
      const outputTokens = tokens?.outputTokens ?? 0;
      const costUsd = sjState?.costUsd ?? 0;
      deps.usageRepo.record(
        job.id,
        job.submittedBy ?? null,
        job.agentConfigId,
        inputTokens,
        outputTokens,
        durationMs,
        costUsd,
      );
      deps.jobsRepo.updateTokens(job.id, inputTokens, outputTokens, costUsd, durationMs);
      broadcastJobUpdated(deps, job.id);
      if (tokens) {
        logger.info(
          "spawner",
          `Token usage for job ${job.id}: ${inputTokens} in, ${outputTokens} out, ${durationMs}ms`,
        );
      }
    } catch (err) {
      logger.warn("spawner", `Failed to record usage for job ${job.id}: ${err}`);
    }
  }

  // Batch SQLite writes: accumulate log text and flush periodically
  let dbLogPending = "";
  let dbFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const DB_FLUSH_INTERVAL = 500; // ms

  function flushLogToDB() {
    dbFlushTimer = null;
    if (dbLogPending) {
      deps.jobsRepo.appendLog(job.id, dbLogPending);
      dbLogPending = "";
    }
  }

  function scheduleDBFlush(text: string) {
    dbLogPending += text;
    if (!dbFlushTimer) {
      dbFlushTimer = setTimeout(flushLogToDB, DB_FLUSH_INTERVAL);
    }
  }

  /** Raw stream reader for stderr and non-stream-json engines */
  const streamReaderRaw = async (
    stream: ReadableStream<Uint8Array> | number | null | undefined,
    prefix: string,
  ) => {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = sanitizeTerminalChunk(decoder.decode(value, { stream: true }));
        if (!text) continue;
        if (config.engine === "local-oss" && prefix === "stderr") {
          const trimmed = text.trim();
          // Ollama frequently emits spinner-only stderr frames that are not useful logs.
          if (trimmed && !/[A-Za-z0-9]/.test(trimmed) && /[⠁-⣿]/u.test(trimmed)) {
            continue;
          }
        }
        const logText = prefix ? `[${prefix}] ${text}` : text;
        if (logBuffer.length < LOG_BUFFER_MAX) {
          logBuffer += logText;
        }

        // Stream logs in real-time via WS (immediate)
        sendLog(deps, job, logText);
        // Batch DB writes to avoid blocking the stream reader
        scheduleDBFlush(logText);
      }
    } catch {
      // Stream closed
    }
  };

  /** Build a real-time command checker from command_filter policies */
  const commandChecker: CommandPolicyChecker | undefined =
    deps.commandFilterPolicies && deps.commandFilterPolicies.length > 0
      ? (command: string) => {
          const violations = checkCommandScripts(
            [{ language: "bash", script: command }],
            deps.commandFilterPolicies!,
          );
          const blocker = violations.find((v) => v.action === "block");
          return blocker ? blocker.message : null;
        }
      : undefined;

  /** Whether the agent was killed due to a real-time policy violation */
  let policyKilled = false;

  /** Stream-json reader: parses JSONL, sends human-readable display lines */
  const streamReaderJson = async (
    stream: ReadableStream<Uint8Array> | number | null | undefined,
  ) => {
    if (!stream || typeof stream === "number" || !sjState) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = processStreamJsonChunk(sjState, chunk, commandChecker);
        // Save session ID as soon as it's available (for pause/resume)
        if (!sessionIdSaved && sjState.sessionId) {
          sessionIdSaved = true;
          try { deps.jobsRepo.setSessionId(job.id, sjState.sessionId); } catch { /* best effort */ }
        }
        for (const line of lines) {
          const displayText = line.display + "\n";
          if (logBuffer.length < LOG_BUFFER_MAX) {
            logBuffer += displayText;
          }
          sendLog(deps, job, displayText);
          scheduleDBFlush(displayText);

          // Real-time policy violation detected — kill the agent immediately
          if (line.policyViolation && !policyKilled) {
            policyKilled = true;
            const violationMsg = `[POLICY VIOLATION] ${line.policyViolation}`;
            logger.warn("spawner", `Job ${job.id}: ${violationMsg} — killing agent process`);
            sendLog(deps, job, violationMsg + "\n");
            if (logBuffer.length < LOG_BUFFER_MAX) {
              logBuffer += violationMsg + "\n";
            }
            try { proc.kill(); } catch {}
            reader.cancel().catch(() => {});
            return;
          }
        }
      }
    } catch {
      // Stream closed
    }
  };

  // 7b. Post-result kill timer: if the agent sends a `result` event but the
  // process hangs (doesn't exit), force-kill it after a grace period so the
  // job doesn't stay "running" forever.
  const POST_RESULT_KILL_MS = 30_000; // 30 seconds grace after result event
  let postResultKillTimer: ReturnType<typeof setTimeout> | null = null;

  if (sjState) {
    const checkInterval = setInterval(() => {
      if (sjState.resultReceived && !postResultKillTimer) {
        clearInterval(checkInterval);
        postResultKillTimer = setTimeout(() => {
          logger.warn(
            "spawner",
            `Job ${job.id}: process still alive ${POST_RESULT_KILL_MS / 1000}s after result event, force-killing`,
          );
          try { proc.kill(); } catch {}
        }, POST_RESULT_KILL_MS);
      }
    }, 2000);
    // Absolute safety: clear the interval after 2 hours even if result was never received.
    // Prevents leaked intervals from accumulating on hung processes.
    const absoluteTimeout = setTimeout(() => clearInterval(checkInterval), 2 * 60 * 60 * 1000);
    // Clean up interval when process exits normally
    proc.exited.then(() => {
      clearInterval(checkInterval);
      clearTimeout(absoluteTimeout);
      if (postResultKillTimer) clearTimeout(postResultKillTimer);
    });
  }

  // Race stream readers with proc.exited to avoid hanging when child processes
  // (e.g. MCP servers spawned by Claude) inherit the pipe file descriptors and
  // keep them open after the main agent process exits.
  const STREAM_DRAIN_GRACE_MS = 5_000;

  const streamPromise = isStreamJson
    ? Promise.all([
        streamReaderJson(proc.stdout),
        streamReaderRaw(proc.stderr, "stderr"),
      ])
    : Promise.all([
        streamReaderRaw(proc.stdout, ""),
        streamReaderRaw(proc.stderr, "stderr"),
      ]);

  const exitCode = await proc.exited;

  // Process exited — give streams a brief grace period to drain remaining
  // buffered data, then cancel them so we don't hang on orphaned child pipes.
  const streamDrainTimeout = new Promise<void>((resolve) =>
    setTimeout(resolve, STREAM_DRAIN_GRACE_MS),
  );
  await Promise.race([streamPromise, streamDrainTimeout]);

  // Force-cancel any still-open stream readers (must await since cancel() returns a Promise)
  const stdout = proc.stdout;
  if (stdout && typeof stdout !== "number") {
    await stdout.cancel().catch(() => {});
  }
  const stderr = proc.stderr;
  if (stderr && typeof stderr !== "number") {
    await stderr.cancel().catch(() => {});
  }

  deps.processTracker.unregister(job.id);

  // Flush any remaining log text to DB
  if (dbFlushTimer) clearTimeout(dbFlushTimer);
  flushLogToDB();

  logger.info("spawner", `Job ${job.id} exited with code ${exitCode}`);

  const currentAfterExit = deps.jobsRepo.getById(job.id);
  if (!currentAfterExit) {
    watcher?.stop();
    recordTokens();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }
  if (currentAfterExit.status === "cancelled") {
    watcher?.stop();
    const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job was cancelled before queued guidance could be delivered.") ?? [];
    broadcastInterventionUpdates(deps, job.id, rejected);
    recordTokens();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }
  if (currentAfterExit.status === "paused") {
    // Job was paused by user — process was killed intentionally.
    // Don't treat as failure. Logs are already saved. Job will resume later.
    watcher?.stop();
    logger.info("spawner", `Job ${job.id} paused by user (session: ${sjState?.sessionId || "none"})`);
    recordTokens();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }

  // Real-time policy violation: agent was killed for running a blocked command
  if (policyKilled) {
    watcher?.stop();
    const msg = "Job terminated: agent executed a command that violates an active command_filter policy. Check job logs for details.";
    deps.jobsRepo.fail(job.id, msg, logBuffer);
    const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, msg) ?? [];
    broadcastInterventionUpdates(deps, job.id, rejected);
    applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
    recordCoordinatorOutcome(false);
    sendComplete(deps, job, false, [], [], workspace.mode, msg);
    broadcastJobUpdated(deps, job.id);
    recordTokens();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }

  // Append full assistant plainText to logBuffer so DB logs contain the complete
  // output (display previews truncate text blocks to 500 chars, which loses
  // structured JSON configs that training extraction depends on).
  if (sjState?.plainText) {
    const fullText = sjState.plainText.trim();
    if (fullText) {
      logBuffer += "\n\n--- Full assistant output ---\n" + fullText + "\n";
    }
  }

  // Guard: detect API auth failures that the CLI reports as exit code 0.
  // These should be treated as failures, not successful completions.
  const authFailureMatch = logBuffer.match(/(?:authentication_error|OAuth token has expired|Failed to authenticate.*API Error.*40[13])/i);
  if (authFailureMatch && exitCode === 0) {
    const msg = "Agent CLI exited cleanly but authentication failed. Re-authenticate your API credentials.";
    logger.warn("spawner", `Job ${job.id}: ${msg}`);
    watcher?.stop();
    deps.jobsRepo.fail(job.id, msg, logBuffer);
    const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, msg) ?? [];
    broadcastInterventionUpdates(deps, job.id, rejected);
    sendComplete(deps, job, false, [], [], workspace.mode, msg);
    broadcastJobUpdated(deps, job.id);
    recordTokens();
    cleanupSync(deps, workspace, job.id);
    cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
    return;
  }

  // 8. Handle completion based on mode
  if (exitCode === 0) {
    // Guard: if this coordinator spawned sub-jobs (via MCP create_job) that haven't
    // finished yet, check if it intentionally dispatched them or hit max-turns.
    if (deps.jobsRepo.hasPendingChildren(job.id)) {
      watcher?.stop();
      // Check both logBuffer (display lines) and plainText (full assistant output)
      const searchText = logBuffer + (sjState?.plainText ?? "");
      const hitMaxTurns =
        searchText.includes("Reached max turns") ||
        searchText.includes("Max turns") ||
        searchText.includes("max_turns");

      // Exit code 0 means the agent finished normally. If it dispatched children
      // and exited cleanly, that's intentional — children run independently.
      // Only treat as failure if it hit max-turns (agent ran out of budget).
      if (!hitMaxTurns) {
        // Coordinator is done dispatching — mark as completed, children run independently
        logger.info("spawner", `Job ${job.id}: coordinator dispatched all sub-jobs and exited cleanly`);
        deps.jobsRepo.complete(job.id, [], logBuffer);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        recordCoordinatorOutcome(true);
        sendComplete(deps, job, true, [], [], workspace.mode);
        broadcastJobUpdated(deps, job.id);
        resumePausedDependents(deps, job.id);
        recordTokens();
        cleanupSync(deps, workspace, job.id);
        cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
        return;
      }

      const errorMsg = hitMaxTurns
        ? "Hit max-turns limit before all sub-jobs finished. Increase max-turns in the agent config and requeue."
        : "Coordinator exited before all sub-jobs finished. Check agent logs for details.";
      logger.warn("spawner", `Job ${job.id}: ${errorMsg}`);
      deps.jobsRepo.fail(job.id, errorMsg, logBuffer);
      recordCoordinatorOutcome(false);
      sendComplete(deps, job, false, [], [], workspace.mode, errorMsg);
      broadcastJobUpdated(deps, job.id);
      recordTokens();
      cleanupSync(deps, workspace, job.id);
      cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
      return;
    }

    if (workspace.mode === "command") {
      // Enforce file_path policies — hard block if the agent modified protected files
      watcher?.stop();
      const cmdFileChanges = watcher
        ? await watcher.getChanges(beforePaths!)
        : [];
      if (cmdFileChanges.length > 0) {
        logger.info(
          "spawner",
          `Detected ${cmdFileChanges.length} file change(s) in command mode for job ${job.id}`,
        );
        for (const fc of cmdFileChanges) {
          logger.info("spawner", `  ${fc.action}: ${fc.path}`);
        }
        if (deps.filePathPolicies && deps.filePathPolicies.length > 0) {
          const changedPaths = cmdFileChanges.map((fc) => fc.path);
          const violations = checkFilePaths(changedPaths, deps.filePathPolicies);
          const blockers = violations.filter((v) => v.action === "block");
          if (blockers.length > 0) {
            const msg = `Policy violation: ${blockers.map((v) => v.message).join("; ")}`;
            logger.warn("spawner", msg);
            deps.jobsRepo.fail(job.id, msg, logBuffer);
            applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
            recordCoordinatorOutcome(false);
            sendComplete(deps, job, false, [], [], workspace.mode, msg);
            broadcastJobUpdated(deps, job.id);
            recordTokens();
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
            return;
          }
        }
      }

      // Parse stdout for command/script blocks
      // For stream-json: use accumulated plainText (assistant text blocks contain the code fences)
      const textForParsing = sjState ? sjState.plainText : logBuffer;
      const expectedCommandLanguage = resolveExpectedCommandLanguage(
        job.editorContext?.metadata,
        job.bridgeProgram,
      );
      let commands = parseCommandOutput(textForParsing, {
        expectedLanguage: expectedCommandLanguage,
      });
      if (config.engine === "codex" && commands.length > 1) {
        // Codex output can include an echoed prompt (with fenced examples from
        // system instructions). Prefer parsing from the tail where the final
        // assistant response is emitted.
        const tailCommands = parseCommandOutput(textForParsing.slice(-4000), {
          expectedLanguage: expectedCommandLanguage,
        });
        if (tailCommands.length > 0) {
          commands = tailCommands;
        }
      }
      if (commands.length > 1) {
        const seen = new Set<string>();
        commands = commands.filter((cmd) => {
          const key = `${cmd.language}\n${cmd.script}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      logger.info(
        "spawner",
        `Parsed ${commands.length} command(s) from job ${job.id} output`,
      );

      if (commands.length === 0) {
        const currentJob = deps.jobsRepo.getById(job.id);
        if (shouldCompleteCommandModeFromBridgeExecution(currentJob)) {
          const summaryLine = "[command-mode] Completed via bridge execution; no final fenced command output was required.\n";
          logger.info("spawner", `Job ${job.id}: bridge execution succeeded without fenced command output`);
          logBuffer = `${logBuffer}${summaryLine}`;
          deps.jobsRepo.completeWithCommands(job.id, [], logBuffer);
          sendLog(deps, job, summaryLine);
          const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
          broadcastInterventionUpdates(deps, job.id, rejected);
          recordCoordinatorOutcome(true);
          sendComplete(deps, job, true, [], [], workspace.mode);
          broadcastJobUpdated(deps, job.id);
          recordTokens();
          cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          return;
        }

        // If the process exited cleanly (exit code 0) and produced meaningful
        // prose output, treat it as a successful prose-only completion rather
        // than failing because no fenced code blocks were found.
        const proseText = (sjState?.plainText ?? logBuffer).trim();
        if (exitCode === 0 && proseText.length >= 50) {
          const summaryLine = "[command-mode] Completed with prose output (no fenced code blocks required).\n";
          logger.info("spawner", `Job ${job.id}: prose-only completion (${proseText.length} chars, exit 0)`);
          logBuffer = `${logBuffer}${summaryLine}`;
          deps.jobsRepo.completeWithCommands(job.id, [], logBuffer);
          sendLog(deps, job, summaryLine);
          const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
          broadcastInterventionUpdates(deps, job.id, rejected);
          applyUsedBridgeAttribution(logBuffer);
          recordCoordinatorOutcome(true);
          sendComplete(deps, job, true, [], [], workspace.mode);
          broadcastJobUpdated(deps, job.id);
          recordTokens();
          cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          return;
        }

        const bridgeHint = job.bridgeProgram
          ? `Target bridge: ${job.bridgeProgram}.`
          : "No bridge target metadata was attached (bridgeProgram/editorContext target metadata missing).";
        const msg = `No executable commands were produced in command mode. ${bridgeHint} Ensure the model returns fenced code blocks.`;
        logger.warn("spawner", msg);
        deps.jobsRepo.fail(job.id, msg, logBuffer);
        applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
        recordCoordinatorOutcome(false);
        sendComplete(deps, job, false, [], [], workspace.mode, msg);
        broadcastJobUpdated(deps, job.id);
        recordTokens();
        cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
        return;
      }

      // Check command scripts against command_filter policies
      if (deps.commandFilterPolicies && deps.commandFilterPolicies.length > 0 && commands.length > 0) {
        const scriptCommands = commands.map((cmd) => ({
          language: cmd.language,
          script: cmd.script,
        }));
        const violations = checkCommandScripts(scriptCommands, deps.commandFilterPolicies);
        const blockers = violations.filter((v) => v.action === "block");
        if (blockers.length > 0) {
          const msg = `Command policy violation: ${blockers.map((v) => v.message).join("; ")}`;
          logger.warn("spawner", msg);
          deps.jobsRepo.fail(job.id, msg, logBuffer);
          applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
          recordCoordinatorOutcome(false);
          sendComplete(deps, job, false, [], [], workspace.mode, msg);
          broadcastJobUpdated(deps, job.id);
          recordTokens();
          cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          return;
        }
        const warnings = violations.filter((v) => v.action === "warn");
        for (const w of warnings) {
          logger.warn("spawner", `Command policy warning for job ${job.id}: ${w.message}`);
        }
      }

      if (commands.length > 0 && job.bridgeProgram) {
        const srvPrefHeadless = deps.settingsRepo?.getBool("prefer_headless_bridges") ?? false;
        const headlessRequired = preferHeadlessBridgeExecution(job, srvPrefHeadless);
        const onlineBridgeCount = headlessRequired
          ? 0
          : deps.hub.getBridgesByProgram(job.bridgeProgram).length;
        if (onlineBridgeCount === 0) {
          logger.info(
            "spawner",
            headlessRequired
              ? `Job ${job.id}: headless execution required for ${job.bridgeProgram}, attempting worker-owned headless execution`
              : `Job ${job.id}: no online ${job.bridgeProgram} bridge, attempting worker-owned headless execution`,
          );
          const workerHeadless = await executeWorkerHeadlessCommands({
            hub: deps.hub,
            headlessProgramsRepo: deps.headlessProgramsRepo,
            program: job.bridgeProgram,
            commands,
            timeoutMs: Math.min(getEffectiveJobTimeoutMs(deps, job), 180_000),
            projectPath: job.editorContext?.projectRoot,
            targetWorkerName: job.targetWorkerName ?? job.workerName,
          });
          if (!workerHeadless.handled) {
            const msg = headlessRequired
              ? `Headless execution was required for ${job.bridgeProgram}, but no eligible desktop client can execute it`
              : `No online ${job.bridgeProgram} bridge and no eligible desktop client can execute it`;
            logger.warn("spawner", msg);
            deps.jobsRepo.fail(job.id, msg, logBuffer);
            applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
            recordCoordinatorOutcome(false);
            sendComplete(deps, job, false, [], [], workspace.mode, msg);
            broadcastJobUpdated(deps, job.id);
            recordTokens();
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
            return;
          }
          if (!workerHeadless.success) {
            const msg = workerHeadless.error || `Headless execution failed for ${job.bridgeProgram}`;
            logger.warn("spawner", msg);
            deps.jobsRepo.fail(job.id, msg, logBuffer);
            applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg, [job.bridgeProgram]);
            recordCoordinatorOutcome(false);
            sendComplete(deps, job, false, [], [], workspace.mode, msg);
            broadcastJobUpdated(deps, job.id);
            recordTokens();
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
            return;
          }
          if (workerHeadless.result?.stdout) {
            const summaryLine = `[worker-headless] ${workerHeadless.result.stdout}\n`;
            logBuffer = `${logBuffer}${summaryLine}`;
            deps.jobsRepo.appendLog(job.id, summaryLine);
            sendLog(deps, job, summaryLine);
          }
          applyUsedBridgeAttribution(logBuffer, [job.bridgeProgram]);
        }
      }

      applyUsedBridgeAttribution(logBuffer);
      deps.jobsRepo.completeWithCommands(job.id, commands, logBuffer);
      const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
      broadcastInterventionUpdates(deps, job.id, rejected);
      recordCoordinatorOutcome(true);
      sendComplete(deps, job, true, [], commands, workspace.mode);
      broadcastJobUpdated(deps, job.id);
    } else {
      // Repo/sync mode: get file changes from watcher
      watcher?.stop();
      const fileChanges = watcher
        ? await watcher.getChanges(beforePaths!)
        : [];
      logger.info(
        "spawner",
        `Detected ${fileChanges.length} file change(s) for job ${job.id}`,
      );
      for (const fc of fileChanges) {
        logger.info("spawner", `  ${fc.action}: ${fc.path}`);
      }

      // Post-completion file path policy check
      if (deps.filePathPolicies && deps.filePathPolicies.length > 0) {
        const changedPaths = fileChanges.map((fc) => fc.path);
        const violations = checkFilePaths(changedPaths, deps.filePathPolicies);
        const blockers = violations.filter((v) => v.action === "block");
        if (blockers.length > 0) {
          const msg = `Policy violation: ${blockers.map((v) => v.message).join("; ")}`;
          logger.warn("spawner", msg);
          deps.jobsRepo.fail(job.id, msg, logBuffer);
          applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${msg}` : msg);
          recordCoordinatorOutcome(false);
          sendComplete(deps, job, false, [], [], workspace.mode, msg);
          broadcastJobUpdated(deps, job.id);
          recordTokens();
          cleanupSync(deps, workspace, job.id);
          cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          return;
        }
      }

      applyUsedBridgeAttribution(logBuffer);
      deps.jobsRepo.complete(job.id, fileChanges, logBuffer);
      const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
      broadcastInterventionUpdates(deps, job.id, rejected);
      recordCoordinatorOutcome(true);
      sendComplete(deps, job, true, fileChanges, [], workspace.mode);
      broadcastJobUpdated(deps, job.id);
    }
    // Auto-resume paused dependents now that this job succeeded
    resumePausedDependents(deps, job.id);
  } else {
    watcher?.stop();
    // If the process exited non-zero but the logs contain [done], the agent
    // completed its work successfully. Some CLI agents return non-zero exit
    // codes even on success (e.g. when bridge tool calls timed out mid-run
    // but the agent handled them and produced full output).
    const agentActuallyCompleted = logBuffer.includes("[done]");
    if (agentActuallyCompleted) {
      logger.info(
        "spawner",
        `Job ${job.id}: process exited with code ${exitCode} but agent completed ([done] in logs). Treating as success.`,
      );
      applyUsedBridgeAttribution(logBuffer);
      if (workspace.mode === "command") {
        // Enforce file_path policies even on non-zero exit treated as success
        const doneFileChanges = watcher ? await watcher.getChanges(beforePaths!) : [];
        if (doneFileChanges.length > 0 && deps.filePathPolicies && deps.filePathPolicies.length > 0) {
          const changedPaths = doneFileChanges.map((fc) => fc.path);
          const violations = checkFilePaths(changedPaths, deps.filePathPolicies);
          const blockers = violations.filter((v) => v.action === "block");
          if (blockers.length > 0) {
            const msg = `Policy violation: ${blockers.map((v) => v.message).join("; ")}`;
            logger.warn("spawner", msg);
            deps.jobsRepo.fail(job.id, msg, logBuffer);
            recordCoordinatorOutcome(false);
            sendComplete(deps, job, false, [], [], workspace.mode, msg);
            broadcastJobUpdated(deps, job.id);
            recordTokens();
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
            return;
          }
        }
        const textForParsing = sjState ? sjState.plainText : logBuffer;
        const expectedCommandLanguage = resolveExpectedCommandLanguage(
          job.editorContext?.metadata,
          job.bridgeProgram,
        );
        const commands = parseCommandOutput(textForParsing, {
          expectedLanguage: expectedCommandLanguage,
        });
        deps.jobsRepo.completeWithCommands(job.id, commands, logBuffer);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        recordCoordinatorOutcome(true);
        sendComplete(deps, job, true, [], commands, workspace.mode);
      } else {
        const fileChanges = watcher ? await watcher.getChanges(beforePaths!) : [];
        // Enforce file_path policies on [done] fallback (repo/sync mode)
        if (fileChanges.length > 0 && deps.filePathPolicies && deps.filePathPolicies.length > 0) {
          const changedPaths = fileChanges.map((fc) => fc.path);
          const violations = checkFilePaths(changedPaths, deps.filePathPolicies);
          const blockers = violations.filter((v) => v.action === "block");
          if (blockers.length > 0) {
            const msg = `Policy violation: ${blockers.map((v) => v.message).join("; ")}`;
            logger.warn("spawner", msg);
            deps.jobsRepo.fail(job.id, msg, logBuffer);
            recordCoordinatorOutcome(false);
            sendComplete(deps, job, false, [], [], workspace.mode, msg);
            broadcastJobUpdated(deps, job.id);
            recordTokens();
            cleanupSync(deps, workspace, job.id);
            cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
            return;
          }
        }
        deps.jobsRepo.complete(job.id, fileChanges, logBuffer);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job finished before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        recordCoordinatorOutcome(true);
        sendComplete(deps, job, true, fileChanges, [], workspace.mode);
      }
      broadcastJobUpdated(deps, job.id);
      resumePausedDependents(deps, job.id);
    } else {
      const errorMsg = `Process exited with code ${exitCode}`;

      // Detect stale session resume failure — clear sessionId and retry fresh.
      // This happens when a job had a sessionId from a previous run but the
      // Claude CLI session expired or was invalidated. Instead of failing
      // permanently, clear the session and let it run fresh with the original prompt.
      const isStaleResume = logBuffer.includes("No deferred tool marker found")
        || logBuffer.includes("session was not deferred")
        || logBuffer.includes("marker is stale");
      if (isStaleResume && resumeSessionId) {
        logger.warn("spawner", `Job ${job.id}: stale session resume detected, clearing sessionId and retrying fresh`);
        // Fail first (sets status to 'failed'), then requeue for retry
        deps.jobsRepo.fail(job.id, "Stale session — retrying fresh", logBuffer);
        deps.jobsRepo.setSessionId(job.id, null);
        const retryCount = job.retryCount ?? 0;
        const maxRetries = job.maxRetries ?? 0;
        if (retryCount < Math.max(maxRetries, 1)) {
          deps.jobsRepo.requeueForRetry(job.id, 2000); // Short delay — just need a fresh launch
          applyUsedBridgeAttribution(errorMsg);
          sendLog(deps, job, `[retry] Stale session — retrying with fresh prompt (attempt ${retryCount + 1})\n`);
          broadcastJobUpdated(deps, job.id);
          recordTokens();
          cleanupSync(deps, workspace, job.id);
          cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
          return;
        }
      }

      // Check if this is a transient error eligible for retry
      const retryError = logBuffer
        ? logBuffer.slice(-2000) + "\n" + errorMsg
        : errorMsg;
      if (tryRetryJob(deps, job, retryError)) {
        // Job requeued for retry — don't mark as permanently failed
        applyUsedBridgeAttribution(retryError);
      } else {
        deps.jobsRepo.fail(job.id, errorMsg, logBuffer);
        const rejected = deps.jobInterventionsRepo?.rejectPendingForJob(job.id, "Job failed before queued guidance could be delivered.") ?? [];
        broadcastInterventionUpdates(deps, job.id, rejected);
        applyUsedBridgeAttribution(logBuffer ? `${logBuffer}\n${errorMsg}` : errorMsg);
        recordCoordinatorOutcome(false);
        sendComplete(deps, job, false, [], [], workspace.mode, errorMsg);
        broadcastJobUpdated(deps, job.id);

        // Notify dependents that this job failed
        notifyBlockedDependents(deps, job.id, "failed");
      }
    }
  }

  // 9. Record token usage (idempotent — may have already been called by an early-return path)
  recordTokens();

  // 10. Sync + tools cleanup
  cleanupSync(deps, workspace, job.id);
  cleanupAgentTools(cliWrapper, mcpConfigPath, mcpConfigBackup);
}

/** When a parent job completes, auto-resume any paused dependents to queued. */
function resumePausedDependents(deps: SpawnerDeps, completedJobId: string) {
  try {
    const dependents = deps.depsRepo.getDependents(completedJobId);
    for (const depJobId of dependents) {
      const depJob = deps.jobsRepo.getById(depJobId);
      if (depJob && depJob.status === "paused") {
        // Check if ALL dependencies are completed (not just this one)
        const blocking = deps.depsRepo.getBlockingDeps(depJobId);
        if (blocking.length === 0) {
          deps.jobsRepo.resume(depJobId);
          logger.info("spawner", `Auto-resumed dependent job ${depJobId} (parent ${completedJobId} completed)`);
        }
      }
    }
  } catch (err) {
    logger.warn("spawner", `Failed to resume paused dependents: ${err}`);
  }
}

function notifyBlockedDependents(
  deps: SpawnerDeps,
  failedJobId: string,
  reason: string,
) {
  try {
    const dependents = deps.depsRepo.getDependents(failedJobId);
    for (const depJobId of dependents) {
      const depJob = deps.jobsRepo.getById(depJobId);
      if (depJob && depJob.status === "queued") {
        deps.hub.broadcastToType("client", {
          type: "job_dependency_blocked",
          id: newId(),
          payload: {
            jobId: depJobId,
            blockedByJobId: failedJobId,
            reason,
          },
        });
      }
    }
  } catch (err) {
    logger.warn("spawner", `Failed to notify blocked dependents: ${err}`);
  }
}

/** Clean up CLI wrapper and .mcp.json that were injected for the agent. */
function cleanupAgentTools(
  cliWrapper: CliWrapperResult | null,
  mcpConfigPath: string | null,
  mcpConfigBackup: string | null,
) {
  if (cliWrapper) {
    cliWrapper.cleanup();
  }
  if (mcpConfigPath) {
    try {
      if (mcpConfigBackup) {
        // Restore original .mcp.json
        writeFileSync(mcpConfigPath, mcpConfigBackup, "utf-8");
        logger.info("spawner", `Restored original .mcp.json`);
      } else if (existsSync(mcpConfigPath)) {
        // We created it, remove it
        unlinkSync(mcpConfigPath);
        logger.info("spawner", `Removed injected .mcp.json`);
      }
    } catch (err) {
      logger.warn("spawner", `Failed to clean up .mcp.json: ${err}`);
    }
  }
}

function cleanupSync(
  deps: SpawnerDeps,
  workspace: WorkspaceResolution,
  jobId: string,
) {
  if (workspace.mode === "sync") {
    deps.syncManager?.markComplete(jobId);
  }
}

function resolveCoordinatorClientSourcePaths(job: Job): string[] {
  const metadata = job.editorContext?.metadata;
  if (!metadata || typeof metadata !== "object") return [];

  const out = new Set<string>();
  const direct = (metadata as Record<string, unknown>).coordinator_client_source_paths;
  if (Array.isArray(direct)) {
    for (const value of direct) {
      const path = String(value ?? "").trim();
      if (path) out.add(path);
    }
  }

  const byProgram = (metadata as Record<string, unknown>).coordinator_client_source_paths_by_program;
  if (byProgram && typeof byProgram === "object") {
    const programKey = String(job.bridgeProgram ?? "").trim();
    const rawList = (byProgram as Record<string, unknown>)[programKey];
    if (Array.isArray(rawList)) {
      for (const value of rawList) {
        const path = String(value ?? "").trim();
        if (path) out.add(path);
      }
    }
  }

  return [...out];
}

function buildCoordinatorClientPromptOverrideBlock(job: Job): string {
  const metadata = job.editorContext?.metadata;
  if (!metadata || typeof metadata !== "object") return "";
  const metadataObj = metadata as Record<string, unknown>;

  const globalOverride = String(metadataObj.coordinator_client_prompt_override_global ?? "").trim();
  const byProgramRaw = metadataObj.coordinator_client_prompt_overrides_by_program;

  const targetPrograms = new Set<string>();
  if (Array.isArray(metadataObj.target_bridges)) {
    for (const value of metadataObj.target_bridges) {
      const program = String(value ?? "").trim().toLowerCase();
      if (program) targetPrograms.add(program);
    }
  }
  if (Array.isArray(metadataObj.available_programs)) {
    for (const value of metadataObj.available_programs) {
      const program = String(value ?? "").trim().toLowerCase();
      if (program) targetPrograms.add(program);
    }
  }
  const bridgeProgram = String(job.bridgeProgram ?? "").trim().toLowerCase();
  if (bridgeProgram) targetPrograms.add(bridgeProgram);

  const programBlocks: Array<{ program: string; text: string }> = [];
  if (byProgramRaw && typeof byProgramRaw === "object" && !Array.isArray(byProgramRaw)) {
    const byProgram = byProgramRaw as Record<string, unknown>;
    for (const program of targetPrograms) {
      const text = String(byProgram[program] ?? "").trim();
      if (!text) continue;
      programBlocks.push({ program, text });
    }
  }

  if (!globalOverride && programBlocks.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Client-Side Bridge Prompt Overrides");
  lines.push(
    "Apply these client-local instruction additions after server scripts while preserving server policy and safety gates.",
  );
  if (globalOverride) {
    lines.push(`### Global\n${globalOverride}`);
  }
  for (const block of programBlocks) {
    lines.push(`### ${block.program}\n${block.text}`);
  }
  return lines.join("\n\n");
}

function getTargetWorkerNames(job: Job): string[] {
  const out = new Set<string>();
  const direct = String(job.targetWorkerName ?? "").trim().toLowerCase();
  if (direct) out.add(direct);

  const metadata = job.editorContext?.metadata;
  if (metadata && typeof metadata === "object") {
    const targetWorkers = (metadata as Record<string, unknown>).target_workers;
    if (Array.isArray(targetWorkers)) {
      for (const value of targetWorkers) {
        const workerName = String(value ?? "").trim().toLowerCase();
        if (workerName) out.add(workerName);
      }
    }
  }

  return [...out];
}

/** Find bridge connection IDs that should receive messages for a job. */
function getTargetBridgeIds(deps: SpawnerDeps, job: Job): string[] {
  // Direct bridge ID takes priority — but only if it's still connected.
  // Bridges can reconnect mid-job (e.g. Blender addon reload), so we fall
  // back to finding the current active bridge for the same program/worker.
  if (job.bridgeId) {
    if (deps.hub.getConnection(job.bridgeId)) {
      return [job.bridgeId];
    }
    // Original bridge is gone — fall through to program/worker lookup
  }

  const targetWorkers = getTargetWorkerNames(job);
  if (targetWorkers.length > 0) {
    const targetWorkerSet = new Set(targetWorkers);
    const bridges = deps.hub.getBridges();
    const matched = bridges
      .filter((b) => targetWorkerSet.has((b.workerName ?? "").toLowerCase()))
      .map((b) => b.id);
    if (matched.length > 0) return matched;
  }

  // Last resort: any bridge running the same program
  if (job.bridgeProgram) {
    const bridges = deps.hub.getBridges();
    const matched = bridges
      .filter((b) => b.program === job.bridgeProgram)
      .map((b) => b.id);
    if (matched.length > 0) return matched;
  }

  return [];
}

function sendStarted(deps: SpawnerDeps, job: Job) {
  for (const id of getTargetBridgeIds(deps, job)) {
    deps.hub.send(id, {
      type: "job_started",
      id: newId(),
      payload: { jobId: job.id },
    });
  }
  deps.hub.broadcastToType("client", {
    type: "job_started",
    id: newId(),
    payload: { jobId: job.id },
  });
}

// ── Job retry helper ──────────────────────────────────────────────────────
/**
 * Attempt to requeue a failed job for retry if the error is transient and
 * retries remain. Returns true if the job was requeued, false if it should
 * be permanently failed.
 */
function tryRetryJob(deps: SpawnerDeps, job: Job, error: string): boolean {
  const retryCount = job.retryCount ?? 0;
  const maxRetries = job.maxRetries ?? 0;
  if (maxRetries <= 0 || retryCount >= maxRetries) return false;
  if (!isTransientError(error)) return false;

  const delayMs = computeRetryDelay(retryCount);
  const requeued = deps.jobsRepo.requeueForRetry(job.id, delayMs);
  if (requeued) {
    const nextAttempt = retryCount + 1;
    logger.info(
      "spawner",
      `Job ${job.id} requeued for retry ${nextAttempt}/${maxRetries} (delay: ${Math.round(delayMs / 1000)}s): ${error}`,
    );
    broadcastJobUpdated(deps, job.id);
  }
  return requeued;
}

// ── Throttled WS log broadcasting ──────────────────────────────────────────
// Accumulates log chunks per job and flushes every WS_LOG_FLUSH_MS.
// This prevents flooding the client with hundreds of tiny messages per second
// during fast agent output, which was causing UI freezes.
const WS_LOG_FLUSH_MS = 200;
/** Max log payload size per flush (32KB). Larger chunks are truncated with a note. */
const WS_LOG_MAX_PAYLOAD = 32_768;
const wsLogBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null; job: Job }>();

function flushWsLog(deps: SpawnerDeps, jobId: string) {
  const buf = wsLogBuffers.get(jobId);
  if (!buf || !buf.text) return;
  // Rate limit: truncate very large log chunks to prevent memory/bandwidth issues
  let text = buf.text;
  if (text.length > WS_LOG_MAX_PAYLOAD) {
    text = text.slice(0, WS_LOG_MAX_PAYLOAD) + "\n[...log truncated, full output saved to DB]\n";
  }
  buf.text = "";
  buf.timer = null;

  // Use the stored job reference for proper bridge targeting
  for (const id of getTargetBridgeIds(deps, buf.job)) {
    deps.hub.send(id, {
      type: "job_log",
      id: newId(),
      payload: { jobId, text },
    });
  }
  // Only send logs to clients actively viewing this job (subscribed)
  const subscribers = deps.hub.getLogSubscribers(jobId);
  for (const connId of subscribers) {
    deps.hub.send(connId, {
      type: "job_log",
      id: newId(),
      payload: { jobId, text },
    });
  }
}

function sendLog(deps: SpawnerDeps, job: Job, text: string) {
  // Mark job as active so idle/stall detection doesn't kill it prematurely
  deps.processTracker.touch(job.id);
  let buf = wsLogBuffers.get(job.id);
  if (!buf) {
    buf = { text: "", timer: null, job };
    wsLogBuffers.set(job.id, buf);
  }
  buf.text += text;
  if (!buf.timer) {
    buf.timer = setTimeout(() => flushWsLog(deps, job.id), WS_LOG_FLUSH_MS);
  }
}

/** Flush any pending WS log buffer for a job (call on job completion/failure). */
function flushWsLogNow(deps: SpawnerDeps, jobId: string) {
  const buf = wsLogBuffers.get(jobId);
  if (buf) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    if (buf.text) flushWsLog(deps, jobId);
    wsLogBuffers.delete(jobId);
  }
}

/**
 * Periodic sweep to clean up orphaned wsLogBuffers entries.
 * Entries can become orphaned if a job is killed externally (process tracker
 * timeout, manual cancellation) without going through sendComplete().
 * Runs every 60s, removes entries older than 5 minutes with no active process.
 */
const WS_LOG_ORPHAN_MAX_AGE_MS = 5 * 60 * 1000;
let wsLogSweepDeps: SpawnerDeps | null = null;
const wsLogSweepInterval = setInterval(() => {
  if (!wsLogSweepDeps) return;
  const now = Date.now();
  for (const [jobId, buf] of wsLogBuffers) {
    // If no timer is pending and buffer is empty, it's just a stale reference
    if (!buf.timer && !buf.text) {
      wsLogBuffers.delete(jobId);
      continue;
    }
    // If the job object's createdAt is old and no process is running, it's orphaned
    const createdAt = buf.job.createdAt ? new Date(buf.job.createdAt).getTime() : 0;
    if (now - createdAt > WS_LOG_ORPHAN_MAX_AGE_MS) {
      if (buf.timer) clearTimeout(buf.timer);
      wsLogBuffers.delete(jobId);
    }
  }
}, 60_000);
// Prevent interval from keeping process alive on shutdown
if (wsLogSweepInterval.unref) wsLogSweepInterval.unref();

function broadcastInterventionUpdates(
  deps: SpawnerDeps,
  jobId: string,
  interventions: JobIntervention[],
) {
  if (!interventions.length) return;
  for (const intervention of interventions) {
    deps.hub.broadcastToType("client", {
      type: "job_intervention_updated",
      id: newId(),
      payload: { jobId, intervention },
    });
  }
}

function sendComplete(
  deps: SpawnerDeps,
  job: Job,
  success: boolean,
  files: FileChange[],
  commands: CommandResult[],
  workspaceMode?: WorkspaceMode,
  error?: string,
) {
  // Flush any buffered WS logs before sending the completion message
  flushWsLogNow(deps, job.id);

  // Skill effectiveness is now driven by:
  // 1. Agent self-assessment via rate_skill (during execution)
  // 2. User outcome ratings (after completion)
  // Job success/failure does NOT auto-rate skills — a job can fail for
  // reasons unrelated to skill quality (timeout, bridge crash, etc.).

  // Cleanup temp files if requested
  if (success && job.runtimeOptions?.cleanupTempFiles) {
    const projectRoot = job.editorContext?.projectRoot;
    if (projectRoot) {
      const cleanupScript = `import shutil, os\npath = os.path.join(${JSON.stringify(projectRoot)}, "_arkestrator", ${JSON.stringify(job.id)})\nif os.path.isdir(path):\n    shutil.rmtree(path)\n    print(f"Cleaned up {path}")\nelse:\n    print(f"No temp dir at {path}")`;
      const bridgeIds = getTargetBridgeIds(deps, job);
      if (bridgeIds.length > 0) {
        deps.hub.send(bridgeIds[0], {
          type: "bridge_command",
          id: newId(),
          payload: { language: "python", script: cleanupScript, correlationId: newId() },
        });
        logger.info("spawner", `Sent temp file cleanup for job ${job.id}`);
      }
    }
  }

  const payload = {
    jobId: job.id,
    success,
    files,
    commands,
    workspaceMode,
    error,
  };
  for (const id of getTargetBridgeIds(deps, job)) {
    deps.hub.send(id, {
      type: "job_complete",
      id: newId(),
      payload,
    });
  }
  deps.hub.broadcastToType("client", {
    type: "job_complete",
    id: newId(),
    payload,
  });
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function broadcastJobUpdated(deps: SpawnerDeps, jobId: string) {
  let job = deps.jobsRepo.getById(jobId);
  if (!job) return;

  // Auto-archive training and housekeeping jobs when they reach a terminal state
  if (TERMINAL_STATUSES.has(job.status) && !job.archivedAt) {
    const meta = job.editorContext?.metadata as Record<string, unknown> | undefined;
    const isTraining = meta?.coordinator_training_job === true;
    const isHousekeeping = meta?.housekeeping === true;
    if (isTraining || isHousekeeping) {
      logger.info("spawner", `Auto-archiving ${isTraining ? "training" : "housekeeping"} job ${jobId} (status=${job.status})`);
      deps.jobsRepo.archive(jobId);
      job = deps.jobsRepo.getById(jobId) ?? job;
    }
  }

  deps.hub.broadcastToType("client", {
    type: "job_updated",
    id: newId(),
    payload: { job },
  });
}
