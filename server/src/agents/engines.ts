import type {
  AgentConfig,
  Job,
  FileAttachment,
  ContextItem,
  RuntimeVerificationMode,
} from "@arkestrator/protocol";
import type { WorkspaceResolution } from "../workspace/resolver.js";
import {
  buildCommandModePrompt,
  detectBridgeType,
} from "../workspace/command-mode.js";
import { normalizeCodexArgs } from "../utils/codex-args.js";
import { encodeCodexPromptArg } from "../utils/codex-prompt.js";
import { logger } from "../utils/logger.js";
import { buildLocalCliArgs } from "./local-args.js";
import { buildLiveInterventionPollingBlock } from "./job-interventions.js";
import { formatProjectPrompt } from "./project-prompt.js";
import { getClaudeRuntimeDecision } from "../utils/claude-runtime.js";
import type { SpawnUserSpec } from "../utils/spawn.js";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  runAsUser?: SpawnUserSpec;
  stdinInput?: string;
}

export interface BridgeInfo {
  id?: string;
  program?: string;
  workerName?: string;
  projectPath?: string;
  programVersion?: string;
  // Pre-resolved context injected at spawn time (eliminates need for runtime discovery)
  editorContext?: Record<string, unknown>;
  contextItems?: Array<Record<string, unknown>>;
  files?: Array<{ path: string; content: string }>;
}

export interface HeadlessProgramInfo {
  program: string;
  language: string;
}

interface InstructionPromptResult {
  text: string;
  hasBridgePrompt: boolean;
}

const CODEX_WINDOWS_PROMPT_ARG_MAX = 8000;
const MAX_INSTRUCTION_PROMPT_CHARS = 24_000;
const CLAUDE_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

/** Platform-aware default project directory (e.g. ~/Documents/Arkestrator). */
export function getDefaultProjectDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir() || "";
  return home ? join(home, "Documents", "Arkestrator") : "";
}

export function buildCommand(
  config: AgentConfig,
  job: Job,
  toolRestrictions?: string[],
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): CommandSpec {
  const cwd = workspace?.cwd ?? job.editorContext?.projectRoot ?? process.cwd();
  const baseEnv: Record<string, string> = {};

  switch (config.engine) {
    case "claude-code":
      return buildClaudeCommand(
        config,
        job,
        cwd,
        baseEnv,
        toolRestrictions,
        workspace,
        connectedBridges,
        headlessPrograms,
        orchestratorPromptOverride,
        defaultProjectDir,
      );
    case "codex":
      return buildCodexCommand(
        config,
        job,
        cwd,
        baseEnv,
        workspace,
        connectedBridges,
        headlessPrograms,
        orchestratorPromptOverride,
        defaultProjectDir,
      );
    case "gemini":
      return buildGeminiCommand(config, job, cwd, baseEnv, workspace);
    case "grok":
      return buildGrokCommand(config, job, cwd, baseEnv, workspace);
    case "local-oss":
      return buildLocalCommand(
        config,
        job,
        cwd,
        baseEnv,
        workspace,
        connectedBridges,
        headlessPrograms,
        orchestratorPromptOverride,
        defaultProjectDir,
      );
    default:
      return buildLocalCommand(
        config,
        job,
        cwd,
        baseEnv,
        workspace,
        connectedBridges,
        headlessPrograms,
        orchestratorPromptOverride,
        defaultProjectDir,
      );
  }
}

/** Build the full prompt, optionally augmented for command mode */
function buildPrompt(
  job: Job,
  workspace?: WorkspaceResolution,
): string {
  let prompt = job.prompt;

  // Append user-curated context items (referenced via @N in the prompt)
  if (job.contextItems && job.contextItems.length > 0) {
    const contextSection = formatContextItems(job.contextItems);
    prompt = `${prompt}\n\n${contextSection}`;
  }

  if (workspace?.mode === "command") {
    // Include attached file contents as context in the prompt
    if (job.files && job.files.length > 0) {
      const fileContext = job.files
        .map(
          (f: FileAttachment) =>
            `--- File: ${f.path} ---\n${f.content}\n--- End ---`,
        )
        .join("\n\n");
      prompt = `${prompt}\n\nHere are the relevant project files for context:\n\n${fileContext}`;
    }
  }

  return prompt;
}

/** Format context items into a readable section for the AI agent */
function formatContextItems(items: ContextItem[]): string {
  const lines = items.map((item) => {
    switch (item.type) {
      case "node": {
        const cls = item.metadata?.class ?? "Node";
        let desc = `@${item.index} - Node "${item.name}" (${cls}) at ${item.path}`;
        if (item.metadata?.selection_group === true && typeof item.metadata?.count === "number") {
          desc += `\n  Selection group count: ${item.metadata.count}`;
        }
        if (item.metadata?.script) {
          desc += `\n  Script: ${item.metadata.script}`;
        }
        if (item.metadata?.properties) {
          desc += `\n  Properties: ${JSON.stringify(item.metadata.properties)}`;
        }
        if (item.content && item.content.trim().length > 0) {
          desc += `\n  Details:\n\`\`\`\n${item.content}\n\`\`\``;
        }
        return desc;
      }
      case "script": {
        let desc = `@${item.index} - Script "${item.name}" (${item.path})`;
        if (item.content) {
          desc += `:\n\`\`\`\n${item.content}\n\`\`\``;
        }
        return desc;
      }
      case "scene": {
        return `@${item.index} - Scene "${item.name}" (${item.path})`;
      }
      case "asset":
      case "resource": {
        let desc = `@${item.index} - ${item.type === "asset" ? "Asset" : "Resource"} "${item.name}" (${item.path})`;
        if (item.metadata) {
          const meta = Object.entries(item.metadata)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          if (meta) desc += ` [${meta}]`;
        }
        return desc;
      }
      default:
        return `@${item.index} - "${item.name}" (${item.path})`;
    }
  });

  return `The user has referenced the following items (use @N to identify them):\n\n${lines.join("\n\n")}`;
}

function buildClaudeCommand(
  config: AgentConfig,
  job: Job,
  cwd: string,
  env: Record<string, string>,
  toolRestrictions?: string[],
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): CommandSpec {
  // Run in agentic mode so Claude can actually edit files
  // --output-format stream-json forces per-line flushing (fixes pipe buffering)
  // --verbose includes tool_use/tool_result events for real-time log detail
  const claudeRuntime = getClaudeRuntimeDecision();
  const allowSkipPermissionsFlag = claudeRuntime.allowSkipPermissionsFlag;
  const args = ["--output-format", "stream-json", "--verbose"];
  if (allowSkipPermissionsFlag) {
    args.unshift(CLAUDE_SKIP_PERMISSIONS_FLAG);
  }

  if (config.model) {
    args.push("--model", config.model);
  }
  if (config.maxTurns) {
    args.push("--max-turns", String(config.maxTurns));
  }

  const instructionPrompt = buildInstructionPrompt(
    config,
    job,
    workspace,
    connectedBridges,
    headlessPrograms,
    orchestratorPromptOverride,
    defaultProjectDir,
  );
  const systemPrompt = instructionPrompt.text;

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  for (const arg of config.args) {
    // Filter legacy prompt flags - buildClaudeCommand already adds -p with the prompt
    if (arg === "-p" || arg === "--print") continue;
    // Filter --model since we already add it above from config.model
    if (arg === "--model") continue;
    if (!allowSkipPermissionsFlag && arg === CLAUDE_SKIP_PERMISSIONS_FLAG) continue;
    args.push(arg);
  }

  // Apply tool restrictions from policies
  const allRestrictions = [...(toolRestrictions ?? [])];

  // In command mode, also block file-editing tools
  if (workspace?.mode === "command") {
    const fileTools = ["Edit", "Write", "NotebookEdit"];
    for (const tool of fileTools) {
      if (!allRestrictions.includes(tool)) {
        allRestrictions.push(tool);
      }
    }
  }

  if (allRestrictions.length > 0) {
    args.push("--disallowedTools", allRestrictions.join(","));
  }

  // Pass prompt with -p flag to avoid shell escaping issues on Windows
  const prompt = buildPrompt(job, workspace);
  args.push("-p", prompt);

  return {
    command: config.command || "claude",
    args,
    env,
    cwd,
    runAsUser: claudeRuntime.runAsUser,
  };
}

function buildCodexCommand(
  config: AgentConfig,
  job: Job,
  cwd: string,
  env: Record<string, string>,
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): CommandSpec {
  const args: string[] = [];
  let resolvedCwd = cwd;

  // Keep command-mode Codex runs out of the server repo so repo-level
  // agent instruction files do not hijack bridge orchestration behavior.
  if (workspace?.mode === "command") {
    resolvedCwd = join(tmpdir(), "arkestrator-codex", job.id);
  }

  // Non-interactive mode for server jobs with JSONL output for token tracking.
  args.push("exec");
  args.push("--json");

  if (config.model) {
    args.push("--model", config.model);
  }

  if (workspace?.mode === "command") {
    // Command-mode orchestration depends on local HTTP bridge calls (am/curl)
    // to Arkestrator, so Codex must not run with network-disabled sandboxing.
    args.push("--sandbox", "danger-full-access");
    args.push("--skip-git-repo-check");
  } else {
    args.push("--full-auto");
    // Non-repo project roots (e.g. DCC temp/project folders) can fail Codex
    // startup with "Not inside a trusted directory" unless this is set.
    args.push("--skip-git-repo-check");
  }
  args.push(...normalizeCodexArgs(config.args));

  let prompt = buildPrompt(job, workspace);

  // Prefix orchestration instructions so Codex prefers MCP first and has
  // explicit am/curl fallbacks when MCP is unavailable at runtime.
  const instructionPrompt = buildInstructionPrompt(
    config,
    job,
    workspace,
    connectedBridges,
    headlessPrograms,
    orchestratorPromptOverride,
    defaultProjectDir,
  );
  let instructionText = instructionPrompt.text;
  if (instructionPrompt.hasBridgePrompt) {
    instructionText = instructionText
      ? `${instructionText}\n\n${CODEX_CLI_BRIDGE_GUIDANCE}`
      : CODEX_CLI_BRIDGE_GUIDANCE;
  }
  if (instructionText) {
    prompt = [
      "## Execution Instructions",
      instructionText,
      "",
      "## User Request",
      prompt,
    ].join("\n");
  }

  const encodedPrompt = encodeCodexPromptArg(prompt);
  if (process.platform === "win32" && encodedPrompt.length > CODEX_WINDOWS_PROMPT_ARG_MAX) {
    // Avoid Windows CreateProcess "command line too long" failures by passing
    // a short pointer prompt and storing the full request on disk.
    mkdirSync(resolvedCwd, { recursive: true });
    const promptFilePath = join(resolvedCwd, `.arkestrator-codex-prompt-${job.id}.txt`);
    writeFileSync(promptFilePath, prompt, "utf-8");
    const pointerPrompt = [
      "Read the full user request from this UTF-8 file and execute it directly:",
      promptFilePath,
      "Do not ask the user to re-paste the prompt; use the file contents as the request.",
    ].join("\n");
    args.push(encodeCodexPromptArg(pointerPrompt));
  } else {
    args.push(encodedPrompt);
  }

  return { command: config.command || "codex", args, env, cwd: resolvedCwd };
}

function buildInstructionPrompt(
  config: AgentConfig,
  job: Job,
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): InstructionPromptResult {
  // Shared instruction chain:
  // project system prompt -> agent config system prompt -> command-mode rules -> orchestration prompt
  const sections: string[] = [];
  appendInstructionSection(sections, formatProjectPrompt(workspace?.project));
  appendInstructionSection(sections, config.systemPrompt);

  const hasCoordinatorOverride = !!orchestratorPromptOverride?.trim();
  if (workspace?.mode === "command") {
    // Multi-bridge orchestration jobs should not be constrained to a single
    // bridge-local script output; they need the cross-bridge orchestrator prompt.
    // If a coordinator script override is loaded, prefer that over generic
    // command-mode guidance to avoid redundant/conflicting instructions.
    if (!isMultiBridgeOrchestrationJob(job) && !hasCoordinatorOverride) {
      const bridgeType = detectBridgeType(
        job.editorContext?.metadata as Record<string, unknown> | undefined,
        job.bridgeProgram,
      );
      const cmdPrompt = buildCommandModePrompt(
        bridgeType,
        job.editorContext?.metadata as Record<string, unknown> | undefined,
      );
      appendInstructionSection(sections, cmdPrompt);
    }
  }

  const bridgePrompt = buildBridgeOrchestrationPrompt(
    connectedBridges,
    job.bridgeProgram,
    headlessPrograms,
    orchestratorPromptOverride,
    defaultProjectDir,
  );
  appendInstructionSection(sections, bridgePrompt);
  if (config.engine === "claude-code" || config.engine === "codex") {
    appendInstructionSection(sections, buildLiveInterventionPollingBlock(job.id));
  }
  appendInstructionSection(sections, buildRuntimeVerificationDirective(job));

  const text = compactInstructionPrompt(sections.join("\n\n"));
  return { text, hasBridgePrompt: !!bridgePrompt };
}

function isMultiBridgeOrchestrationJob(job: Job): boolean {
  const metadata = job.editorContext?.metadata as Record<string, unknown> | undefined;
  if (!metadata) return false;

  const targets = metadata.target_bridges;
  if (Array.isArray(targets) && targets.length > 1) return true;

  const bridgeCount = metadata.bridge_count;
  if (typeof bridgeCount === "number" && bridgeCount > 1) return true;

  return false;
}

function appendInstructionSection(sections: string[], section?: string | null) {
  const normalized = normalizeInstructionText(section);
  if (!normalized) return;
  const normalizedSection = normalizeInstructionForDedupe(normalized);
  for (const existing of sections) {
    const normExisting = normalizeInstructionForDedupe(existing);
    if (
      normExisting === normalizedSection
      || normExisting.includes(normalizedSection)
      || normalizedSection.includes(normExisting)
    ) {
      return;
    }
  }
  sections.push(normalized);
}

function normalizeInstructionText(text?: string | null): string {
  if (!text) return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInstructionForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compactInstructionPrompt(text: string): string {
  const normalized = normalizeInstructionText(text);
  if (!normalized) return "";
  if (normalized.length <= MAX_INSTRUCTION_PROMPT_CHARS) return normalized;
  const keepTail = normalized.slice(-MAX_INSTRUCTION_PROMPT_CHARS);
  return [
    "[Instruction prompt trimmed for token efficiency. Retained highest-priority tail sections.]",
    keepTail,
  ].join("\n\n");
}

function normalizeRuntimeVerificationWeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) return undefined;
  return rounded;
}

function verificationWeightLabel(weight: number): string {
  if (weight >= 80) return "strict";
  if (weight >= 50) return "balanced";
  if (weight >= 20) return "light";
  return "minimal";
}

function buildRuntimeVerificationDirective(job: Job): string {
  const mode = job.runtimeOptions?.verificationMode as RuntimeVerificationMode | undefined;
  const weight = normalizeRuntimeVerificationWeight(job.runtimeOptions?.verificationWeight);
  if (!mode && weight === undefined) return "";

  const effectiveMode: RuntimeVerificationMode = mode ?? "required";
  const modeLabel = effectiveMode.toUpperCase();
  const lines: string[] = [
    "## Job Runtime Override: Verification",
    "Apply this override for this run, even if coordinator defaults differ.",
    `Mode: ${modeLabel}`,
  ];
  if (weight !== undefined) {
    lines.push(`Weight: ${weight}/100 (${verificationWeightLabel(weight)})`);
  }

  if (effectiveMode === "required") {
    lines.push("You must run deterministic verification before reporting success.");
    lines.push("If verification cannot be run, report BLOCKED instead of success.");
    lines.push("Include explicit PASS/FAIL evidence in the final report.");
  } else if (effectiveMode === "optional") {
    lines.push("Attempt deterministic verification when practical for changed scope.");
    lines.push("If verification is skipped or unavailable, clearly list what remains unverified.");
    lines.push("Do not fabricate PASS claims.");
  } else {
    lines.push("Do not run extra verification loops unless needed for safety-critical checks.");
    lines.push("Focus on completing requested changes; note skipped verification explicitly.");
    lines.push("Do not claim verified PASS results when checks were not executed.");
  }

  if (weight !== undefined && effectiveMode !== "disabled") {
    if (weight >= 80) {
      lines.push("Favor deeper coverage (syntax/runtime/artifact checks) within scope.");
    } else if (weight <= 20) {
      lines.push("Keep verification lightweight and focused on highest-risk outputs.");
    }
  }

  return lines.join("\n");
}

const CODEX_CLI_BRIDGE_GUIDANCE = `
### Bridge Execution (Required)

Bridge context is pre-loaded in the prompt above — you do NOT need to discover bridges before starting work.

**The \`am\` CLI is pre-installed in your PATH.** Use it as the primary way to execute scripts in bridges.

**Execute a script in a bridge:**
\`\`\`bash
# Inline script
am exec <program> --lang <language> --script '<code>'

# Example: add monkey head in Blender
am exec blender --lang python --script 'import bpy; bpy.ops.mesh.primitive_monkey_add()'

# Multiline: write to a temp file, then use -f
cat > /tmp/script.py << 'PYEOF'
import bpy
bpy.ops.mesh.primitive_monkey_add(size=2.0, location=(0, 0, 1))
obj = bpy.context.active_object
obj.name = "Suzanne"
PYEOF
am exec blender --lang python -f /tmp/script.py
\`\`\`

**Other \`am\` commands:**
- \`am bridges\` — list connected bridges
- \`am context <program>\` — get editor context
- \`am exec-multi <program> -f commands.json\` — batch execute
- \`am jobs interventions <jobId>\` — list live operator guidance for a running job
- \`am jobs create -f <job.json>\` — create sub-job
- \`am jobs status <jobId>\` — poll sub-job
- \`am jobs list\` — list jobs
- \`am headless-check <program>\` — validate headless execution

**REST API fallback** (if \`am\` is unavailable): use curl with \`$ARKESTRATOR_URL\` and \`$ARKESTRATOR_API_KEY\` env vars:
\`\`\`bash
curl -s -X POST "$ARKESTRATOR_URL/api/bridge-command" \\
  -H "Authorization: Bearer $ARKESTRATOR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Job-Id: $ARKESTRATOR_JOB_ID" \\
  -d '{"target":"<program>","commands":[{"language":"<lang>","script":"<code>"}]}'
\`\`\`

**On Windows (PowerShell):**
\`\`\`powershell
$body = @{
  target = "<program>"
  commands = @(@{ language = "<language>"; script = $scriptContent })
} | ConvertTo-Json -Depth 4
$headers = @{
  Authorization = "Bearer $env:ARKESTRATOR_API_KEY"
  "Content-Type" = "application/json"
  "X-Job-Id" = "$env:ARKESTRATOR_JOB_ID"
}
Invoke-RestMethod -Method Post -Uri "$env:ARKESTRATOR_URL/api/bridge-command" -Headers $headers -Body $body
\`\`\`

**Other REST endpoints:**
- List bridges: \`GET $ARKESTRATOR_URL/api/bridge-command/bridges\`
- Get bridge context: \`GET $ARKESTRATOR_URL/api/bridge-command/context/<program>\`
- List live operator guidance: \`GET $ARKESTRATOR_URL/api/jobs/<jobId>/interventions\`
- Create sub-job: \`POST $ARKESTRATOR_URL/api/jobs\`
- Poll sub-job: \`GET $ARKESTRATOR_URL/api/jobs/<jobId>\`
- Headless check: \`POST $ARKESTRATOR_URL/api/bridge-command/headless-check\`

All requests require \`Authorization: Bearer $ARKESTRATOR_API_KEY\` header.

**Important for command-mode orchestration:**
- Do NOT use \`apply_patch\`, \`Write\`, or \`Edit\` to build local workspace files.
- For multiline scripts, write to a temp file and use \`am exec -f\` or pass via heredoc.
- Prefer direct bridge execution for simple tasks. Use sub-jobs only for large multi-file workflows.
`.trim();

function buildGeminiCommand(
  config: AgentConfig,
  job: Job,
  cwd: string,
  env: Record<string, string>,
  workspace?: WorkspaceResolution,
): CommandSpec {
  const args: string[] = [];

  if (config.model) {
    args.push("--model", config.model);
  }

  args.push(...config.args);

  const prompt = buildPrompt(job, workspace);
  args.push(prompt);

  return { command: config.command || "gemini", args, env, cwd };
}

function buildGrokCommand(
  config: AgentConfig,
  job: Job,
  cwd: string,
  env: Record<string, string>,
  workspace?: WorkspaceResolution,
): CommandSpec {
  const args: string[] = [];

  if (config.model) {
    args.push("--model", config.model);
  }

  args.push(...config.args);

  const prompt = buildPrompt(job, workspace);
  args.push("--prompt", prompt);

  return { command: config.command || "grok", args, env, cwd };
}

function buildLocalCommand(
  config: AgentConfig,
  job: Job,
  cwd: string,
  env: Record<string, string>,
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): CommandSpec {
  const prompt = buildLocalExecutionPrompt(
    config,
    job,
    workspace,
    connectedBridges,
    headlessPrograms,
    orchestratorPromptOverride,
    defaultProjectDir,
  );

  const args = buildLocalCliArgs(config.args, prompt, config.model);

  return {
    command: config.command,
    args,
    env,
    cwd,
  };
}

export function buildLocalExecutionPrompt(
  config: AgentConfig,
  job: Job,
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): string {
  let prompt = buildPrompt(job, workspace);
  const instructionPrompt = buildInstructionPrompt(
    config,
    job,
    workspace,
    connectedBridges,
    headlessPrograms,
    orchestratorPromptOverride,
    defaultProjectDir,
  );
  if (instructionPrompt.text) {
    prompt = [
      "## Execution Instructions",
      instructionPrompt.text,
      "",
      "## User Request",
      prompt,
    ].join("\n");
  }
  return prompt;
}

/**
 * Build a lean base prompt for the local agentic tool-call loop.
 *
 * Unlike buildLocalExecutionPrompt (which includes the full orchestrator
 * prompt, MCP transport gates, CLI fallbacks, etc.), this keeps the prompt
 * minimal so local 7–32B models aren't overwhelmed.
 *
 * The protocol instructions, available tools, and turn transcript are added
 * separately by buildLocalAgenticTurnPrompt() in the shared loop.
 */
/**
 * Strip sections from coordinator prompts that are irrelevant to local models
 * using the strict JSON tool protocol (they don't use MCP, CLI, or REST).
 */
function stripLocalIrrelevantSections(prompt: string): string {
  // Remove Transport Gate section (MCP / am CLI / REST probing)
  let result = prompt.replace(
    /### Transport Gate \(Required\)[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  // Remove Mandatory Start Gate (references playbook matching etc.)
  result = result.replace(
    /### Mandatory Start Gate[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  // Remove Live vs Headless section (local models always use live bridge)
  result = result.replace(
    /### Live vs Headless[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  // Remove Resource Contention Rule (complex GPU scheduling)
  result = result.replace(
    /### Resource Contention Rule[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  // Remove Connected Applications / Pre-loaded Bridge Context placeholders
  // (already provided in bridge list)
  result = result.replace(
    /### Connected Applications[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  result = result.replace(
    /### Pre-loaded Bridge Context[\s\S]*?(?=###|\n---\n|$)/,
    "",
  );
  // Remove empty --- separators left behind
  result = result.replace(/\n---\s*\n---/g, "\n---");
  result = result.replace(/(\n---\s*)+$/g, "");
  // Collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

export function buildLocalAgenticBasePrompt(
  job: Job,
  workspace?: WorkspaceResolution,
  connectedBridges?: BridgeInfo[],
  orchestratorPrompt?: string,
): string {
  const sections: string[] = [];

  // Minimal bridge context — just program names and versions
  const bridges = connectedBridges ?? [];
  if (bridges.length > 0) {
    const bridgeLines = bridges.map((b) => {
      const parts = [b.program ?? "unknown"];
      if (b.programVersion) parts.push(`v${b.programVersion}`);
      if (b.workerName) parts.push(`worker: ${b.workerName}`);
      return `- ${parts.join(" ")}`;
    });
    sections.push(`Connected bridges:\n${bridgeLines.join("\n")}`);
  }

  // Include coordination content (bridge scripts, playbooks, training) if provided.
  // Strip sections irrelevant to local models (transport gates, CLI probes, etc.)
  // to reduce token usage while keeping the useful coding guidance.
  if (orchestratorPrompt) {
    const cleaned = stripLocalIrrelevantSections(orchestratorPrompt);
    if (cleaned) {
      sections.push(cleaned);
    }
  }

  // User prompt (with context items if any)
  sections.push(buildPrompt(job, workspace));

  return sections.join("\n\n");
}

/**
 * Default orchestrator prompt template.
 * {BRIDGE_LIST} is replaced at runtime with the live list of connected bridges/programs.
 * Exported so the settings API can serve it to the admin UI.
 */
export const DEFAULT_ORCHESTRATOR_PROMPT = `
## Cross-Bridge Orchestration - Global Coordinator

Connected applications:
{BRIDGE_LIST}

You coordinate work across connected programs. Act as a technical lead: plan, execute, verify, and report.

---

### Pre-loaded Bridge Context

The bridge context below was captured at job creation time:
{BRIDGE_CONTEXT}

Use this context first. Re-query bridge state only when you need fresh data after making changes.

---

### Transport Gate (Required)

Before first execution call, probe transport/tool availability:
1. Try MCP tools first (list_bridges, execute_command).
2. If MCP is unavailable (for example "mcp startup: no servers", "tool not found", or tool-call failure), switch immediately to the \`am\` CLI or REST API and continue.
3. Do not fail a task only because MCP is unavailable.
4. Always report which transport was used (MCP / am CLI / REST).
5. For multi-bridge jobs, check availability per bridge separately — one bridge may support MCP while another needs REST.

**Fallback priority:** MCP tools → \`am\` CLI if present in PATH → curl/REST API.

Probe \`am\` before relying on it:
- Bash/sh: \`which am\` or \`command -v am\`
- PowerShell: \`Get-Command am\`

If \`am\` is present, you can use:
- \`am exec <program> --lang <language> --script '<code>'\` — execute in a bridge
- \`am exec <program> --lang <language> -f <script_file>\` — execute from file
- \`am bridges\` — list connected bridges
- \`am context <program>\` — get editor context
- \`am jobs create -f <job.json>\`, \`am jobs status <jobId>\`, \`am jobs list\`

REST fallback env vars (for curl):
- ARKESTRATOR_URL
- ARKESTRATOR_API_KEY
- ARKESTRATOR_JOB_ID (optional, include as X-Job-Id header when present)

REST fallback endpoints:
- GET /api/bridge-command/bridges
- GET /api/bridge-command/context/<program>
- POST /api/bridge-command
- POST /api/jobs
- GET /api/jobs/<jobId>

---

### Project Reference Priority (Required)

Before any execution, check in this order:
1. matched coordinator playbook tasks
2. project-specific scripts/docs from repo/client source paths
3. existing project files and conventions near the target area
4. official docs/examples only when internal references are insufficient

If strong references exist, reuse/adapt them. Do not invent a new pattern first.
Never run broad OS-wide searches outside projectRoot and configured source paths.
Do not recursively scan user home/temp/disks to "find" a file that should already be in context.
If attachment names are provided, use attachment/context paths directly instead of disk-wide filename hunting.

---

### File & Project Workspace Rules (Required)

Save location priority (strict order):
1. **Active project** — if bridge context has a projectRoot or open files, work there.
2. **Default project directory** ({DEFAULT_PROJECT_DIR}) — if no project is open, save here. Create a descriptive subfolder for the task (e.g. "character-model", "particle-fx", "landscape-scene").
3. **Ask the user** — if neither is available, ask where to save before proceeding.

Additional rules:
- Never create files in /tmp or system temp folders unless the user specifically requests it.
- Never create a new file when the user already has a relevant file open — work in that file.
- Only create a brand-new file when the user asks for one or the task clearly requires a new asset.

---

### Mandatory Start Gate

Before any \`execute_command\` or \`create_job\` call:
1. Output a concise plan.
2. Classify each step as direct execution or sub-job.
3. Define deterministic success criteria and verification commands.
4. State scope boundaries (what you will not touch).

---

### Live Guidance Gate

This job may receive additional operator guidance while it is running.
At safe checkpoints, query the live guidance queue for the current job before continuing:
- MCP: \`list_job_interventions(job_id="<current-job-id>")\`
- CLI fallback: \`am jobs interventions <current-job-id>\`

Check at least:
1. before final completion
2. after any long-running step
3. before any irreversible/export/publish action

If new pending guidance appears, incorporate it into this same run, then re-verify affected work before reporting completion.

---

### Execution Policy

Prefer direct \`execute_command\` for focused tasks that fit in a short script.
Use \`create_job\` for large, independent, or long-running tasks.
If work naturally splits across bridges, agents, or workers, prefer sub-jobs so independent branches can run in parallel.
Treat renders, sims, bakes, caches, exports, and asset generation as good fanout candidates when another branch can keep progressing without waiting on the exact output.
Different bridge/program ownership is a strong hint that sub-jobs may be appropriate; do not keep everything in one agent run when the dependency graph is clear and the handoff is cheap.

### Resource Contention Rule (Required)

- Do not intentionally overlap conflicting GPU/VRAM-heavy tasks on the same worker.
- Treat Blender renders/bakes, Houdini renders/sims/caches, and ComfyUI generation workflows as conflicting \`gpu_vram_heavy\` work by default unless you have explicit evidence they are lightweight.
- If one worker is already busy with a heavy GPU task, either wait, serialize the next heavy step, or target a different worker.
- Prefer parallel fanout only when the heavy steps run on different workers or when one branch is clearly non-heavy verification/planning work.

For each step:
1. Execute.
2. Read output and capture failures.
3. Fix immediately.
4. Re-verify before moving on.

---

### Verification Policy (Required)

Before reporting completion:
1. Run deterministic verification checks.
2. Confirm files/objects/artifacts exist and are usable.
3. If checks fail, fix and retry (up to 3 attempts).
4. Report only after clean verification output.

---

### Cross-Machine Delivery Rules (Required)

When the user asks to place/export/copy outputs to an absolute filesystem path:
1. Treat destination paths as machine-local (path strings are not shared across workers).
2. Determine the destination machine from path style and available bridge workers.
3. If generation happens on one worker but destination path belongs to another worker, perform explicit cross-bridge transfer (artifact bytes/base64) and write on the destination worker.
4. Verify the final path on the destination worker itself (not on the source worker shell).
5. If cross-machine transfer cannot be completed, report FAIL with blocker details. Do not claim PASS.

For REST bridge commands, target a specific worker instance with:
- \`POST /api/bridge-command\` + \`{"targetType":"id","target":"<bridgeId>",...}\`

---

### Sub-Job Handover Rules

When using \`create_job\`, include \`handover_notes\` with:
- project path and relevant files
- what was already completed
- expected outputs and naming conventions
- verification requirements

---

### Exit Protocol

When all required direct work and sub-jobs are complete or intentionally dispatched:
1. Summarize completed work and any dispatched job dependency flow.
2. Include explicit PASS/FAIL verification evidence.
3. Print: **All sub-jobs dispatched - pipeline complete** only when that state is true.
4. Exit cleanly.

---

### Prohibited

- Do not run broad machine-wide file scans for convenience.
- Do not skip plan output before first execution.
- Do not skip verification before reporting done.
- Do not claim success without evidence.
- Do not perform unrelated refactors or scene-wide rewrites for narrow requests.
- Do not rely on assumptions when context/tool output can verify state.

---

### Tool Reference

- \`list_bridges\`
- \`get_bridge_context(target)\`
- \`execute_command(target, language, script)\`
- \`execute_multiple_commands(target, commands[])\`
- \`create_job(prompt, target_program, name?, handover_notes?)\`
- \`get_job_status(job_id)\`
- \`list_jobs(status?, limit?)\`
- \`run_headless_check(program, args, project_path?, timeout?)\`

CLI equivalents:
- \`am bridges\`, \`am context <program>\`, \`am exec <program> -f <script>\`
- \`am jobs create -f <job.json>\`, \`am jobs status <jobId>\`, \`am jobs list\`
- \`am headless-check <program> --args '["--headless", ...]'\`
`.trim();

/**
 * Per-bridge default coordinator scripts.
 * These are seeded to data/coordinator-scripts/ on first run.
 * Users can edit the files; the server reloads them per-job.
 */
export const BLENDER_COORDINATOR_PROMPT = `
## Blender Agent - General bpy Coordinator

You are connected to a live Blender session through Arkestrator.
Use \`execute_command(target="blender", language="python", script="...")\`.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- Blender Python API: https://docs.blender.org/api/current/
- Blender best practices: https://docs.blender.org/api/current/info_best_practice.html
- Blender operators: https://docs.blender.org/api/current/bpy.ops.html

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec blender --lang python --script '<code>'\` or \`am exec blender --lang python -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before mutating anything:
1. Review pre-loaded context and identify target scene/objects.
2. Classify task type (modeling, layout, shading, rigging, animation, render, pipeline/fix).
3. Check matched project scripts/docs from repo/client source paths.
4. Reuse project naming, hierarchy, materials, and export conventions when available.
5. Output a short plan and deterministic verification steps.

### Scope Rules
- Keep edits narrowly scoped to the request.
- Do not rebuild unrelated scene systems.
- Do not run broad disk scans outside projectRoot/configured source paths.
- Do not search user-wide temp/home folders to rediscover known attachment names.
- If reference images/files are attached, use the provided context path(s) directly.

---

### Execution Loop

1. Write focused bpy script.
2. Execute it.
3. Read output and fix errors.
4. Verify state with a follow-up check script.
5. Repeat until checks pass.

Limit fix loops to 3 attempts before reporting a blocker.

---

### Quality Checks (Required)

After each major edit, verify and print:
- target objects exist with expected names/types
- transforms/modifiers/material assignments are correct
- exports exist at expected paths and have non-zero size (if requested)
- scene save status if persistence is required
- rendered outputs exist and match requested frame/format settings (if requested)

### Resource Contention Rule
- Treat renders, bake jobs, and heavy viewport/GPU operations as \`gpu_vram_heavy\`.
- Never intentionally start a Blender render/bake on a worker that is already busy with another Blender/Houdini/ComfyUI heavy GPU task.
- If you need generation/render work in parallel, split it onto another worker or finish the current heavy task first.

---

### Verification Requirement

Before reporting done:
1. Run deterministic validation scripts.
2. Confirm generated assets/files are usable.
3. Fix and re-verify on failure (up to 3 attempts).
4. Report success only with explicit PASS evidence.

### Prohibited
- Do not skip verification.
- Do not claim success from assumptions.
- Do not use Bash/Write/Edit for Blender scene mutation.
`.trim();

export const GODOT_COORDINATOR_PROMPT = `
## Godot Agent - General Editor Coordinator

You are connected to a live Godot editor through Arkestrator.
Use \`execute_command(target="godot", language="gdscript", script="...")\`.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- Godot class reference: https://docs.godotengine.org/en/stable/classes/index.html
- EditorInterface API: https://docs.godotengine.org/en/stable/classes/class_editorinterface.html
- GDScript basics: https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_basics.html

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec godot --lang gdscript --script '<code>'\` or \`am exec godot --lang gdscript -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before execution:
1. Review pre-loaded context and identify target scene/files.
2. Classify task type (scene/layout, gameplay script, UI, asset wiring, debug/fix).
3. Check matched project scripts/docs from repo/client source paths.
4. Reuse project architecture and node/script conventions when available.
5. Output a short plan including syntax/runtime verification commands.

### Scope Rules
- Keep changes request-scoped.
- Avoid unrelated scene or gameplay rewrites.
- Avoid broad system-wide file searches outside projectRoot/configured source paths.
- Do not search user-wide temp/home folders to rediscover attachment names.
- Use provided attachment/context paths directly when references are supplied.

---

### Execution Rules

Every script must define:
\`func run(editor: EditorInterface) -> void:\`

Loop:
1. Implement with focused GDScript.
2. Execute command.
3. Fix errors immediately.
4. Verify syntax and runtime.

---

### Required Verification Steps

After writing/editing Godot scripts:
1. Syntax check:
\`run_headless_check(program="godot", args=["--headless", "--check-only", "--path", "<projectRoot>"], timeout=15000)\`
2. Runtime check:
\`run_headless_check(program="godot", args=["--headless", "--quit-after", "5", "--path", "<projectRoot>"], timeout=25000)\`
3. Fix all errors and rerun until clean.

Also verify relevant resources/scenes load successfully when changed.
If \`projectRoot\` is unavailable for headless checks, run bridge-side deterministic checks and report that limitation explicitly.

---

### Verification Requirement

Before reporting done:
- both headless checks must be clean
- changed scenes/scripts/resources must be validated
- report PASS evidence, not assumptions

### Prohibited
- Do not skip syntax/runtime checks.
- Do not claim success with unresolved Godot errors.
- Do not mutate project files via Bash/Write/Edit instead of bridge execution.
`.trim();

export const HOUDINI_COORDINATOR_PROMPT = `
## Houdini Agent - General Coordinator

You are connected to a live Houdini session through Arkestrator.
Use \`execute_command(target="houdini", language="python", script="...")\`.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- HOM overview: https://www.sidefx.com/docs/houdini/hom/
- hou module: https://www.sidefx.com/docs/houdini/hom/hou/
- SOP nodes: https://www.sidefx.com/docs/houdini/nodes/sop/
- DOP nodes: https://www.sidefx.com/docs/houdini/nodes/dop/
- Solaris docs: https://www.sidefx.com/docs/houdini/solaris/
- Karma render settings: https://www.sidefx.com/docs/houdini/nodes/lop/karmarendersettings.html
- SideFX content library: https://www.sidefx.com/contentlibrary/
- Tokeru Houdini notes: https://www.tokeru.com/cgwiki/?title=Houdini

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec <program> --lang <language> --script '<code>'\` or \`am exec <program> --lang <language> -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before building anything:
1. Review pre-loaded bridge context.
2. Classify task type: modeling/layout, simulation/fx, lookdev/render, or debug/fix.
3. Search project-level guidance first:
   - matched playbook tasks
   - project-specific scripts/docs from repo/client source paths
   - nearby HIP/project references
4. Output a short plan with node names, outputs, and verification checks.

### Scope Rules
- Do not force pyro workflows unless explicitly requested.
- Do not force Solaris/Karma for SOP-only tasks.
- Keep edits narrow and request-aligned.
- Default output/report/cache paths to project-local locations (\`projectRoot\`, preloaded HIP directory, or \`$HIP\` when that is project-local).
- If live HIP resolves under temp/system paths (\`/tmp\`, \`%TEMP%\`, etc.), do not anchor outputs there by default; re-anchor to \`projectRoot\` (or preloaded HIP directory) unless the user explicitly requests temp paths.
- Do not run broad scans outside projectRoot/configured source paths.
- Do not search user-wide temp/home folders to rediscover attachment names.
- Use provided attachment/context paths directly when references are supplied.

### Live vs Headless
- Prefer live bridge for active HIP work.
- Prefer hython for non-active-file analysis/validation when appropriate.
- State which mode was used and why.

---

### Execution Flow

For each step:
1. Build/modify required nodes/params only.
2. Run deterministic validation and print PASS/FAIL.
3. Fix failures before continuing.
4. Cache/render only after upstream validation passes.
5. Keep node and output naming stable once established.

### Validation Requirements

Always verify:
- required nodes and wiring exist
- key parameters are set correctly
- outputs resolve to disk where relevant
- blocking operations (cook/cache/render) complete successfully

Task-specific:
- Modeling/SOP: geometry existence and expected counts
- Simulation/FX: source->solver chain and cache integrity
- Solaris/Render: import path, camera/lights/settings, output files
- Debug/Fix: reproduce issue, apply minimal fix, show before/after

Apply pyro/explosion wiring gates only for explicit pyro/explosion tasks.
Do not force pyro/explosion setup unless the user explicitly requests it.

### Resource Contention Rule
- Treat Karma/Mantra/Husk renders plus heavy sim/cache operations as \`gpu_vram_heavy\` unless you have explicit evidence they are lightweight CPU-only checks.
- Never intentionally overlap those heavy Houdini steps with another Blender/Houdini/ComfyUI heavy GPU task on the same worker.
- Separate planning/inspection from heavy execution so the heavy steps can be serialized cleanly when needed.

---

### Verification Requirement

Before reporting done:
1. print hip file path
2. print task type and changed nodes/files
3. print PASS/FAIL validation summary
4. print output paths and caveats

### Prohibited
- Do not report success without explicit verification evidence.
- Do not perform scene-wide destructive edits for narrow requests.
- Do not invent unrelated FX pipelines.
`.trim();
export const COMFYUI_COORDINATOR_PROMPT = `
## ComfyUI Agent - General Workflow Coordinator

You are connected to ComfyUI through Arkestrator.
Use \`execute_command(target="comfyui", language="workflow"|"comfyui"|"python", script="...")\`.
Prefer \`workflow\`/\`comfyui\` for generation tasks so output artifacts are returned for downstream transfer.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- ComfyUI repository: https://github.com/comfyanonymous/ComfyUI
- API example: https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/basic_api_example.py
- ComfyUI wiki: https://github.com/comfyanonymous/ComfyUI/wiki

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec <program> --lang <language> --script '<code>'\` or \`am exec <program> --lang <language> -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before workflow execution:
1. Review pre-loaded context (connection, nodes, runtime status).
2. Check matched project scripts/docs/workflow references from repo/client source paths.
3. Classify request type (image generation, video generation, upscale, inpaint, variation, pipeline/debug).
4. Query available models/nodes.
5. Output a short plan with verification criteria.

### Scope Rules
- Reuse project workflow conventions first when references exist.
- Keep changes aligned to requested output (image/video/variation/upscale).
- Avoid broad machine-wide scans outside project/configured source paths.
- Do not search user-wide temp/home folders to rediscover attachment names.
- Use provided attachment/context paths directly when references are supplied.
- Treat destination filesystem paths as machine-local. A path existing on the ComfyUI worker does not imply it exists on another worker.

### Cross-Machine Delivery Rules (Required)
- If user requests delivery to a path on another machine (for example a Mac path while generation runs on a non-Mac worker), do not write directly to that foreign path from ComfyUI.
- Generate on ComfyUI, capture returned artifact payload(s), then run a second bridge command on the destination worker (use \`targetType:"id"\`) to write the file there.
- Verify file existence/size/type on the destination worker itself before PASS.
- If destination worker is unavailable or transfer fails, report FAIL with exact blocker.

### Resource Contention Rule
- Treat actual workflow generation/upscale/inpaint/video runs as \`gpu_vram_heavy\`.
- Do not intentionally launch a ComfyUI generation on a worker that is already busy with a Blender render/bake or Houdini render/sim/cache step.
- Lightweight inspection/model-list/history checks are fine; heavy generation should wait or move to another worker.

---

### Execution Loop

1. Build workflow JSON.
2. Submit workflow via API script.
3. Poll completion and collect errors.
4. Verify output files and metadata.
5. Fix and retry (up to 3 attempts).

### Model Policy
- Prefer models already installed and validated in environment.
- If required weights are missing and installation is allowed, install to correct ComfyUI model folders, then re-check availability.
- If installation is not allowed, fail clearly with exact missing models/nodes and suggested alternatives.

---

### Verification Requirement

Before reporting done:
- confirm workflow completion in history
- verify outputs exist and are non-zero
- verify output type/format/size aligns with request
- report explicit PASS evidence

### Prohibited
- Do not report success without output verification.
- Do not bypass environment/model checks.
`.trim();

export const UNITY_COORDINATOR_PROMPT = `
## Unity Agent - General Editor Coordinator

You are connected to a live Unity Editor through Arkestrator.
Use \`execute_command(target="unity", language="unity_json", script="...")\`.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- Unity Scripting API: https://docs.unity3d.com/ScriptReference/
- GameObject API: https://docs.unity3d.com/ScriptReference/GameObject.html
- AssetDatabase API: https://docs.unity3d.com/ScriptReference/AssetDatabase.html
- EditorSceneManager API: https://docs.unity3d.com/ScriptReference/SceneManagement.EditorSceneManager.html
- Undo API: https://docs.unity3d.com/ScriptReference/Undo.html

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec <program> --lang <language> --script '<code>'\` or \`am exec <program> --lang <language> -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before mutating anything:
1. Review pre-loaded context (active scene, selected objects/assets).
2. Check matched project scripts/docs from repo/client source paths.
3. Classify task type (scene/layout, prefab/asset, tooling, debug/fix).
4. Reuse existing scene/prefab conventions when available.
5. Output a short action plan and verification checks.

### Scope Rules
- Keep edits scoped to request.
- Prefer targeted path-based operations over broad scene operations.
- Avoid broad file scans outside project/configured source paths.
- Do not search user-wide temp/home folders to rediscover attachment names.
- Use provided attachment/context paths directly when references are supplied.

---

### Execution Rules

Use \`unity_json\` actions only (not raw C#).
After each batch:
1. re-read bridge context
2. verify expected scene/object/asset changes
3. run save/refresh actions when needed

Prefer batch arrays for related operations.

---

### Verification Requirement

Before reporting done:
- verify target objects/scenes/assets exist and are correct
- confirm scene save/asset refresh when applicable
- fix and retry on mismatch (up to 3 attempts)
- report PASS evidence

### Prohibited
- Do not emit raw C# for bridge execution.
- Do not skip post-change verification.
`.trim();

export const UNREAL_COORDINATOR_PROMPT = `
## Unreal Engine Agent - General Editor Coordinator

You are connected to Unreal through Arkestrator.
Use \`execute_command(target="unreal", language="python", script="...")\` for Python,
or \`language="ue_console"\` for console commands.

### Connected Applications
{BRIDGE_LIST}

### Pre-loaded Bridge Context
{BRIDGE_CONTEXT}

### Official Documentation
- Unreal Python API: https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/
- Unreal editor Python scripting: https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python
- Unreal console commands reference: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-console-commands-reference

---

### Transport Gate (Required)

Before first bridge execution, verify transport/tool availability:
1. Try MCP execute_command path first.
2. If MCP tools are unavailable, probe for the \`am\` CLI in PATH. If it is present, use: \`am exec <program> --lang <language> --script '<code>'\` or \`am exec <program> --lang <language> -f <script_file>\`.
3. If \`am\` is unavailable, use curl/REST: \`POST $ARKESTRATOR_URL/api/bridge-command\` with \`Authorization: Bearer $ARKESTRATOR_API_KEY\`.
4. Report which path was used (MCP / am CLI / REST) in your final verification.

---

### Mandatory Start Gate

Before execution:
1. Review pre-loaded context (level, assets, project state).
2. Check matched project scripts/docs from repo/client source paths.
3. Classify task type (level/layout, asset pipeline, gameplay tooling, debug/fix).
4. Reuse existing asset/path conventions when references exist.
5. Output a short plan and verification checks.

### Scope Rules
- Keep edits request-scoped.
- Prefer targeted asset/actor operations.
- Avoid broad machine-wide scans outside project/configured source paths.
- Do not search user-wide temp/home folders to rediscover attachment names.
- Use provided attachment/context paths directly when references are supplied.

---

### Execution Loop

1. Write focused Python/console command.
2. Execute.
3. Fix errors immediately.
4. Verify actor/asset state.
5. Repeat until checks pass (max 3 fix loops).

Use \`/Game/...\` paths consistently for content operations.

---

### Verification Requirement

Before reporting done:
- verify created/edited actors/assets exist and are valid
- verify properties/locations/paths match request
- save required assets/levels
- report explicit PASS evidence

### Prohibited
- Do not skip verification.
- Do not claim success without deterministic checks.
`.trim();

/** Map of built-in coordinator script defaults keyed by program name. */
const COORDINATOR_SCRIPT_DEFAULTS: Record<string, string> = {
  global: DEFAULT_ORCHESTRATOR_PROMPT,
  blender: BLENDER_COORDINATOR_PROMPT,
  godot: GODOT_COORDINATOR_PROMPT,
  houdini: HOUDINI_COORDINATOR_PROMPT,
  comfyui: COMFYUI_COORDINATOR_PROMPT,
  unity: UNITY_COORDINATOR_PROMPT,
  unreal: UNREAL_COORDINATOR_PROMPT,
};

/**
 * Load a coordinator script from disk.
 * Composition order:
 * - {dir}/global.md
 * - {dir}/{program}.md (bridge-specific overrides)
 *
 * Returns combined text when both exist, with global guidance first.
 */
export function loadCoordinatorScript(dir: string, program?: string): string | undefined {
  const parts: string[] = [];
  const globalPath = join(dir, "global.md");
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8").trim();
      if (content) parts.push(content);
    } catch { /* fall through */ }
  }
  if (program) {
    const p = join(dir, `${program}.md`);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content) parts.push(content);
      } catch { /* fall through */ }
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

/**
 * Seed the coordinator scripts directory with built-in defaults.
 * Called on every server startup.
 *
 * For each script:
 * - Missing file -> create from default + write .hash sidecar
 * - File exists and matches our last-written hash -> overwrite with new default
 * - File exists and was user-edited (doesn't match hash) -> leave untouched
 */
export function seedCoordinatorScripts(dir: string, skillsRepo?: import("../db/skills.repo.js").SkillsRepo): void {
  try {
    mkdirSync(dir, { recursive: true });

    // Seed ALL coordinator scripts + pattern skills to DB
    if (skillsRepo) {
      for (const [program, content] of Object.entries(COORDINATOR_SCRIPT_DEFAULTS)) {
        const isGlobal = program === "global";
        skillsRepo.upsertBySlugAndProgram({
          name: `${program}-coordinator`,
          slug: `${program}-coordinator`,
          program: isGlobal ? "global" : program,
          category: isGlobal ? "coordinator" : "bridge",
          title: isGlobal ? "Global Coordinator" : `${program.charAt(0).toUpperCase() + program.slice(1)} Coordinator`,
          description: isGlobal ? "Global orchestration rules" : `Coordinator script for ${program}`,
          keywords: [program, "coordinator"],
          content,
          source: "builtin",
          priority: isGlobal ? 90 : 70,
          autoFetch: true,
          enabled: true,
        });
      }
      // Seed built-in scripting pattern skills
      seedBuiltinPatternSkills(skillsRepo);
    }

    // Also write global to disk for backward compat
    // Per-program scripts are created dynamically when bridges connect via ensureCoordinatorScript().
    const globalContent = COORDINATOR_SCRIPT_DEFAULTS["global"];
    if (!globalContent) return;
    const filePath = join(dir, "global.md");
    const hashPath = join(dir, ".global.hash");
    const newHash = Bun.hash(globalContent).toString(16);

    if (!existsSync(filePath)) {
      writeFileSync(filePath, globalContent, "utf-8");
      writeFileSync(hashPath, newHash, "utf-8");
    } else {
      let lastWrittenHash = "";
      try { lastWrittenHash = readFileSync(hashPath, "utf-8").trim(); } catch { /* no hash file */ }

      if (lastWrittenHash && lastWrittenHash !== newHash) {
        const currentHash = Bun.hash(readFileSync(filePath, "utf-8")).toString(16);
        if (currentHash === lastWrittenHash) {
          writeFileSync(filePath, globalContent, "utf-8");
          writeFileSync(hashPath, newHash, "utf-8");
        }
      } else if (!lastWrittenHash) {
        writeFileSync(hashPath, newHash, "utf-8");
      }
    }
  } catch (err) {
    logger.warn("engines", `Failed to seed coordinator scripts: ${err}`);
  }
}

/**
 * Return the built-in default content for a coordinator script.
 * Used by the settings API to support "Reset to Default".
 */
export function getCoordinatorScriptDefault(program: string): string | undefined {
  return COORDINATOR_SCRIPT_DEFAULTS[program];
}

/** Seed built-in scripting pattern skills to DB */
function seedBuiltinPatternSkills(skillsRepo: import("../db/skills.repo.js").SkillsRepo): void {
  const patterns: Array<{ slug: string; program: string; title: string; desc: string; kw: string[]; content: string }> = [
    { slug: "blender-python-patterns", program: "blender", title: "Blender Python Patterns", desc: "Common bpy scripting patterns", kw: ["blender","bpy","python","mesh","material","render"], content: "# Blender Python Patterns\n\n## Scene: `bpy.context.scene`, `bpy.data.objects`\n## Mesh: `bpy.ops.mesh.primitive_*_add()`, bmesh\n## Materials: `bpy.data.materials.new()`, `use_nodes=True`\n## Render: `bpy.ops.render.render(write_still=True)`\n## Verify: check `bpy.data.objects`, output file size" },
    { slug: "godot-gdscript-patterns", program: "godot", title: "Godot GDScript Patterns", desc: "Common GDScript patterns", kw: ["godot","gdscript","scene","node","physics","signal"], content: "# Godot GDScript Patterns\n\n## Scenes: `.tscn`, `.tres`, `.gd`\n## Nodes: `add_child()`, `queue_free()`, `@onready`, `@export`\n## Physics: RigidBody3D, StaticBody3D+CollisionShape3D, CharacterBody3D\n## Test: `godot --headless --path <project> --script <test>`" },
    { slug: "houdini-python-patterns", program: "houdini", title: "Houdini Python/VEX Patterns", desc: "Common Houdini patterns", kw: ["houdini","hython","vex","sop","geometry","sim"], content: "# Houdini Patterns\n\n## Nodes: `hou.node('/obj')`, `createNode()`, `parm().set()`\n## Geo: SOPs, VEX wrangles\n## Sims: DOPs (RBD, FLIP, Pyro, Vellum), cache to disk\n## Verify: `node.errors()`, `node.warnings()`" },
    { slug: "comfyui-workflow-patterns", program: "comfyui", title: "ComfyUI Workflow Patterns", desc: "ComfyUI workflow building", kw: ["comfyui","workflow","image","diffusion","checkpoint"], content: "# ComfyUI Patterns\n\n## Workflows: JSON node graphs, numbered IDs\n## Nodes: CheckpointLoaderSimple, CLIPTextEncode, KSampler, VAEDecode, SaveImage\n## Execute: queue_prompt API, poll history\n## Verify: output images exist, expected dimensions" },
  ];
  for (const p of patterns) {
    skillsRepo.upsertBySlugAndProgram({
      name: p.slug, slug: p.slug, program: p.program, category: "bridge",
      title: p.title, description: p.desc, keywords: p.kw, content: p.content,
      source: "builtin", priority: 40, autoFetch: false, enabled: true,
    });
  }
}

/** Optional dependencies for dynamic program discovery. */
export interface ProgramDiscoveryDeps {
  coordinatorScriptsDir: string;
  workersRepo?: WorkersRepo;
  hub?: WebSocketHub;
  headlessProgramsRepo?: HeadlessProgramsRepo;
}

/**
 * Return all known coordinator script program names.
 * Without deps: returns built-in defaults only (backward compat).
 * With deps: merges built-in + disk files + DB history + live bridges + headless configs.
 */
export function getCoordinatorScriptPrograms(deps?: ProgramDiscoveryDeps): string[] {
  const sources: string[] = [];

  if (!deps) {
    // Backward compat: no deps means return built-in defaults only
    sources.push(...Object.keys(COORDINATOR_SCRIPT_DEFAULTS));
  }

  if (deps) {
    // Disk: .md files in coordinator scripts dir
    try {
      const files = readdirSync(deps.coordinatorScriptsDir);
      for (const f of files) {
        if (f.endsWith(".md") && !f.startsWith(".")) {
          sources.push(f.slice(0, -3));
        }
      }
    } catch { /* dir may not exist yet */ }

    // DB: all programs that have ever connected
    if (deps.workersRepo) {
      sources.push(...deps.workersRepo.getDistinctPrograms());
    }

    // Live: currently connected bridges
    if (deps.hub) {
      for (const b of deps.hub.getBridges()) {
        if (b.program) sources.push(b.program);
      }
    }

    // Headless program configs
    if (deps.headlessProgramsRepo) {
      for (const p of deps.headlessProgramsRepo.list()) {
        sources.push(p.program);
      }
    }
  }

  return [...new Set(
    sources
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== "global"),
  )].sort();
}

/** Return the built-in program names (without dynamic sources). */
export function getBuiltinCoordinatorScriptPrograms(): string[] {
  return Object.keys(COORDINATOR_SCRIPT_DEFAULTS).filter((k) => k !== "global");
}

/**
 * Ensure a coordinator script file exists for a program.
 * Uses hash-sidecar pattern to protect user edits:
 * - No file → create from registryContent or generic template
 * - File exists + hash matches last-written + new content → update
 * - File exists + hash differs (user edited) → leave untouched
 */
export function ensureCoordinatorScript(
  dir: string,
  program: string,
  registryContent?: string,
  skillsRepo?: import("../db/skills.repo.js").SkillsRepo,
): void {
  const normalized = program.trim().toLowerCase();
  if (!normalized || normalized === "global") return;

  // Upsert to skills DB if no skill exists for this program
  if (skillsRepo) {
    const existing = skillsRepo.getAny(`${normalized}-coordinator`, normalized);
    if (!existing) {
      const content = registryContent ?? COORDINATOR_SCRIPT_DEFAULTS[normalized]
        ?? `# ${normalized.charAt(0).toUpperCase() + normalized.slice(1)} Coordinator\n\nCoordinator script for ${normalized}. Add guidance by creating skills or pulling from the bridge registry.`;
      skillsRepo.upsertBySlugAndProgram({
        name: `${normalized}-coordinator`,
        slug: `${normalized}-coordinator`,
        program: normalized,
        category: "bridge",
        title: `${normalized.charAt(0).toUpperCase() + normalized.slice(1)} Coordinator`,
        description: `Coordinator script for ${normalized}`,
        keywords: [normalized, "coordinator", "bridge"],
        content,
        source: registryContent ? "bridge-repo" : "builtin",
        priority: 70,
        autoFetch: true,
        enabled: true,
      });
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${normalized}.md`);
    const hashPath = join(dir, `.${normalized}.hash`);

    const content = registryContent
      ?? COORDINATOR_SCRIPT_DEFAULTS[normalized]
      ?? `# ${program.charAt(0).toUpperCase() + program.slice(1)} Coordinator Script\n\n` +
         `# Auto-generated for bridge program: ${normalized}\n` +
         `# Customize this file to add program-specific coordinator guidance.\n`;

    const newHash = Bun.hash(content).toString(16);

    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf-8");
      writeFileSync(hashPath, newHash, "utf-8");
    } else if (registryContent) {
      // File exists — only update if user hasn't edited it
      let lastWrittenHash = "";
      try { lastWrittenHash = readFileSync(hashPath, "utf-8").trim(); } catch { /* no hash */ }
      if (lastWrittenHash) {
        const currentHash = Bun.hash(readFileSync(filePath, "utf-8")).toString(16);
        if (currentHash === lastWrittenHash) {
          // User hasn't edited — safe to update from registry
          writeFileSync(filePath, content, "utf-8");
          writeFileSync(hashPath, newHash, "utf-8");
        }
      }
    }
  } catch (err) {
    logger.warn("engines", `Failed to ensure coordinator script for ${normalized}: ${err}`);
  }
}

/**
 * Remove a coordinator script and its hash sidecar from disk.
 * Used when admin nukes a bridge program.
 */
export function removeCoordinatorScript(dir: string, program: string): boolean {
  const normalized = program.trim().toLowerCase();
  if (!normalized || normalized === "global") return false;
  // Don't allow removing built-in programs
  if (COORDINATOR_SCRIPT_DEFAULTS[normalized]) return false;

  const filePath = join(dir, `${normalized}.md`);
  const hashPath = join(dir, `.${normalized}.hash`);
  let removed = false;
  try { unlinkSync(filePath); removed = true; } catch { /* ok */ }
  try { unlinkSync(hashPath); } catch { /* ok */ }
  return removed;
}

/**
 * Build a system prompt section that tells the AI agent about connected bridges
 * and available headless programs, and how to interact with them.
 * Uses the `am` CLI wrapper (available on PATH) and/or MCP tools (for Claude Code).
 */
function buildBridgeOrchestrationPrompt(
  bridges?: BridgeInfo[],
  currentProgram?: string,
  headlessPrograms?: HeadlessProgramInfo[],
  orchestratorPromptOverride?: string,
  defaultProjectDir?: string,
): string {
  // Filter out the bridge that submitted this job (don't tell it to send commands to itself)
  const otherBridges = (bridges ?? []).filter((b) => b.program !== currentProgram);

  // Filter headless programs that aren't the current program and aren't already covered by a connected bridge
  const connectedPrograms = new Set((bridges ?? []).map((b) => b.program));
  const availableHeadless = (headlessPrograms ?? []).filter(
    (hp) => hp.program !== currentProgram && !connectedPrograms.has(hp.program),
  );

  const hasOverride = !!(orchestratorPromptOverride && orchestratorPromptOverride.trim());

  // Skip entirely if no override and no other bridges available
  if (!hasOverride && otherBridges.length === 0 && availableHeadless.length === 0) return "";

  // Group connected bridges by program name
  const byProgram = new Map<string, BridgeInfo[]>();
  for (const b of otherBridges) {
    const prog = b.program ?? "unknown";
    if (!byProgram.has(prog)) byProgram.set(prog, []);
    byProgram.get(prog)!.push(b);
  }

  const bridgeListLines: string[] = [];

  for (const [prog, instances] of byProgram.entries()) {
    const details = instances
      .map((b) => {
        const parts: string[] = [];
        if (b.programVersion) parts.push(`v${b.programVersion}`);
        if (b.workerName) parts.push(`worker: ${b.workerName}`);
        if (b.projectPath) parts.push(`project: ${b.projectPath}`);
        return parts.length > 0 ? `(${parts.join(", ")})` : "";
      })
      .filter(Boolean);
    bridgeListLines.push(
      `- ${prog}${details.length > 0 ? " " + details.join(", ") : ""} (${instances.length} live instance${instances.length > 1 ? "s" : ""})`,
    );
  }

  for (const hp of availableHeadless) {
    bridgeListLines.push(`- ${hp.program} (headless CLI - no GUI, runs ${hp.language} scripts)`);
  }

  const bridgeList = bridgeListLines.length > 0
    ? bridgeListLines.join("\n")
    : "(none connected)";

  // Build pre-resolved context sections for each bridge
  const contextSections: string[] = [];
  const allBridges = [...otherBridges, ...(bridges ?? []).filter((b) => b.program === currentProgram)];
  for (const b of allBridges) {
    if (!b.editorContext && (!b.contextItems || b.contextItems.length === 0) && (!b.files || b.files.length === 0)) continue;
    const prog = b.program ?? "unknown";
    const lines: string[] = [`### ${prog} Editor Context (pre-loaded)`];
    if (b.editorContext) {
      const ec = b.editorContext as Record<string, unknown>;
      if (ec.projectRoot) lines.push(`- Project root: ${ec.projectRoot}`);
      if (ec.activeFile) lines.push(`- Active file: ${ec.activeFile}`);
      if (ec.metadata) {
        const meta = ec.metadata as Record<string, unknown>;
        for (const [k, v] of Object.entries(meta)) {
          if (v !== undefined && v !== null && v !== "") {
            const val = typeof v === "object" ? JSON.stringify(v) : String(v);
            lines.push(`- ${k}: ${val}`);
          }
        }
      }
    }
    if (b.contextItems && b.contextItems.length > 0) {
      lines.push(`\nContext items (${b.contextItems.length}):`);
      for (const item of b.contextItems) {
        const idx = item.index ?? "?";
        const type = item.type ?? "unknown";
        const name = item.name ?? "";
        const content = item.content ? String(item.content).slice(0, 300) : "";
        lines.push(`  @${idx} [${type}] ${name}${content ? `: ${content}` : ""}`);
      }
    }
    if (b.files && b.files.length > 0) {
      lines.push(`\nAttached files (${b.files.length}):`);
      for (const f of b.files) {
        lines.push(`--- File: ${f.path} ---\n${f.content}\n--- End ---`);
      }
    }
    contextSections.push(lines.join("\n"));
  }
  const bridgeContext = contextSections.length > 0
    ? contextSections.join("\n\n")
    : "(no editor context available)";

  // Select which template to use (custom override or built-in default)
  const template = hasOverride
    ? (orchestratorPromptOverride as string).trim()
    : DEFAULT_ORCHESTRATOR_PROMPT;

  let result = template;
  if (result.includes("{BRIDGE_LIST}")) {
    result = result.replaceAll("{BRIDGE_LIST}", bridgeList);
  } else if (bridgeListLines.length > 0) {
    result = `## Connected Applications\n\n${bridgeList}\n\n${result}`;
  }
  if (result.includes("{BRIDGE_CONTEXT}")) {
    result = result.replaceAll("{BRIDGE_CONTEXT}", bridgeContext);
  }
  if (result.includes("{DEFAULT_PROJECT_DIR}")) {
    const dir = defaultProjectDir || getDefaultProjectDir() || "(not configured)";
    result = result.replaceAll("{DEFAULT_PROJECT_DIR}", dir);
  }
  return result;
}
