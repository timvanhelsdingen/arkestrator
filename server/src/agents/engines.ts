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

/**
 * Write a base64-encoded image attachment to a temp directory so the agent
 * can read it with the Read tool. Returns the absolute path on success.
 */
function writeImageAttachment(jobId: string, filename: string, dataUrl: string): string | null {
  try {
    const match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!match) return null;
    const dir = join(tmpdir(), "arkestrator-job-attachments", jobId);
    mkdirSync(dir, { recursive: true });
    // Sanitize filename
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(dir, safe);
    const buf = Buffer.from(match[1], "base64");
    writeFileSync(path, buf);
    logger.info("engines", `Wrote image attachment ${safe} (${buf.length} bytes) for job ${jobId}`);
    return path;
  } catch (err) {
    logger.warn("engines", `Failed to write image attachment: ${err}`);
    return null;
  }
}

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
  resumeSessionId?: string,
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
        resumeSessionId,
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
      const textFiles: string[] = [];
      const imageFiles: string[] = [];
      for (const f of job.files as FileAttachment[]) {
        if (f.content.startsWith("data:image/")) {
          // Base64-encoded image — write to temp dir so agent can Read it
          const savedPath = writeImageAttachment(job.id, f.path, f.content);
          if (savedPath) {
            imageFiles.push(`Image saved to: ${savedPath}\nUse the Read tool to view this image file for visual reference.`);
          }
        } else {
          textFiles.push(`--- File: ${f.path} ---\n${f.content}\n--- End ---`);
        }
      }
      if (textFiles.length > 0) {
        prompt = `${prompt}\n\nHere are the relevant project files for context:\n\n${textFiles.join("\n\n")}`;
      }
      if (imageFiles.length > 0) {
        prompt = `${prompt}\n\n## Attached Images\n${imageFiles.join("\n\n")}`;
      }
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
  resumeSessionId?: string,
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

  // Resume mode: reconnect to existing conversation, skip prompt/system-prompt
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
    // MCP config, tool restrictions, and cwd are still needed
    for (const arg of config.args ?? []) {
      if (arg === "-p" || arg === "--print") continue;
      args.push(arg);
    }
    if (toolRestrictions?.length) {
      for (const tool of toolRestrictions) {
        args.push("--allowedTools", tool);
      }
    }
    return {
      command: config.command || "claude",
      args,
      env,
      cwd,
    };
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
    // OS ARG_MAX is ~262KB on macOS, ~2MB on Linux. When the system prompt
    // (skills + playbooks + coordinator + bridge context) exceeds a safe
    // threshold, write it to CLAUDE.md in the job's cwd so the CLI picks
    // it up automatically as project instructions — no --system-prompt needed.
    const SYSTEM_PROMPT_ARG_SAFE = 100_000; // ~100KB safe threshold
    if (Buffer.byteLength(systemPrompt, "utf-8") > SYSTEM_PROMPT_ARG_SAFE) {
      mkdirSync(cwd, { recursive: true });
      const claudeMdPath = join(cwd, "CLAUDE.md");
      writeFileSync(claudeMdPath, systemPrompt, "utf-8");
      env.__ARKESTRATOR_SYSTEM_PROMPT_FILE = claudeMdPath;
      logger.info("engines", `System prompt too large for CLI args (${Buffer.byteLength(systemPrompt, "utf-8")} bytes), wrote to ${claudeMdPath}`);
    } else {
      args.push("--system-prompt", systemPrompt);
    }
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

  // Pass prompt with -p flag to avoid shell escaping issues on Windows.
  // On Windows, CreateProcess has a 32767-char command-line limit. When the
  // total argument size exceeds a safe threshold, write the prompt to a file
  // in the job's cwd and pass a short reference via -p instead.
  const prompt = buildPrompt(job, workspace);
  const PROMPT_ARG_SAFE = 30_000; // ~30KB — safe for Windows CreateProcess limit
  const totalArgBytes = args.reduce((n, a) => n + Buffer.byteLength(a, "utf-8"), 0)
    + Buffer.byteLength(prompt, "utf-8");

  if (totalArgBytes > PROMPT_ARG_SAFE) {
    mkdirSync(cwd, { recursive: true });
    const promptFilePath = join(cwd, ".arkestrator-prompt.md");
    writeFileSync(promptFilePath, prompt, "utf-8");
    env.__ARKESTRATOR_PROMPT_FILE = promptFilePath;
    // Tell Claude to read the full task from the file
    args.push("-p", `Read and execute the task described in the file: ${promptFilePath}`);
    logger.info("engines", `Prompt too large for CLI args (${totalArgBytes} bytes), wrote to ${promptFilePath}`);
  } else {
    args.push("-p", prompt);
  }

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
    job.id,
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
    lines.push("");
    lines.push("CRITICAL VERIFICATION RULES:");
    lines.push("1. For visual/render tasks: use read_client_file to load the output image, then Read to visually inspect it. You are a vision model — use your visual understanding to verify:");
    lines.push("   - Content matches what was requested (correct subject, composition, style)");
    lines.push("   - Quality is acceptable (no artifacts, noise, banding, generation failures)");
    lines.push("   - Exposure and colors look correct — NOT overexposed/blown out, NOT too dark, NOT color-shifted or washed out");
    lines.push("   - If compositing (Nuke/Fusion/Blender compositor): check that color management is correct. Linear EXR data written to JPEG/PNG without a proper view transform will look overexposed and washed out — this is WRONG, not acceptable");
    lines.push("   - If a reference image was provided, load BOTH your final output AND the reference side by side and compare — tone, contrast, color, and content must be similar");
    lines.push("   - For multi-stage pipelines (render → composite → export): compare the FINAL output against the EARLIER stage input. If your Blender render looked correct but the Nuke/compositor output looks different (overexposed, color-shifted, etc.), the compositing step broke it — fix it");
    lines.push("   - If textures should be seamless/tileable, check for visible seams or blend artifacts");
    lines.push("2. If you loaded verification skills earlier, follow their patterns. Otherwise use the bridge's built-in verification tools.");
    lines.push("3. For non-visual tasks (game dev, compositing, procedural): run the bridge's deterministic validation checks (syntax check, runtime check, scene tree validation, node graph validation).");
    lines.push("4. Do NOT mark clearly wrong output as successful. If the output doesn't match the request, fix it before reporting success.");
    lines.push("5. Include explicit VERIFY PASS/FAIL lines with evidence in your final report.");
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
- \`am skills search '<query>'\` — search learned skills
- \`am skills get <slug>\` — load a skill's content
- \`am skills create --slug <slug> --title '<title>' --program <program> --content '<content>'\` — save a new skill
- \`am skills rate <slug> <useful|not_useful|partial>\` — rate a skill after using it

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

  // Infer target bridge from prompt when not explicitly set — helps local models
  // (14-32B) that struggle to figure out the right bridge from the coordinator prompt.
  const connectedPrograms = bridges.map((b) => String(b.program ?? "").toLowerCase()).filter(Boolean);
  const explicitBridge = String(job.bridgeProgram ?? "").trim().toLowerCase();
  if (!explicitBridge && connectedPrograms.length > 0) {
    const promptLower = job.prompt.toLowerCase();
    const matches = connectedPrograms.filter((p) => promptLower.includes(p));
    if (matches.length === 1) {
      sections.push(`Target bridge: ${matches[0]} — use execute_command with target="${matches[0]}" for this task.`);
    }
  } else if (explicitBridge) {
    sections.push(`Target bridge: ${explicitBridge} — use execute_command with target="${explicitBridge}" for this task.`);
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

Temporary file organization:
- When creating temporary files (test renders, intermediate outputs, debug exports), save them in a \`_arkestrator/{JOB_ID}/\` subfolder inside the project root.
- Example: \`{projectRoot}/_arkestrator/{JOB_ID}/test_render_01.png\`
- Create the folder with \`os.makedirs(..., exist_ok=True)\` before writing.
- Final deliverables go in the project's standard output folders (renders/, exports/, etc.), not the temp folder.
- This keeps the project root clean and makes cleanup easy.

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

### Task Decomposition (Required — evaluate BEFORE executing)

Before starting execution, analyze the task for parallelism:

1. **Identify programs involved.** List every DCC program the task touches (Blender, Godot, Houdini, ComfyUI, etc.).
2. **If 2+ programs are involved AND their work is independent**, split into per-program sub-jobs using \`create_jobs\` (batch) or \`create_job\` with \`target_program\`. Do NOT execute program A, wait, then execute program B when they can run in parallel.
3. **Dependent branches use \`depends_on_job_ids\`.** If program B needs output from program A, chain them: create A first, then create B with \`depends_on_job_ids: [A.id]\`.
4. **Same-program work stays in one job.** Don't split a single program's work across sub-jobs unless it's genuinely large and independent.
5. **Small or fast tasks stay in one job.** If the entire task takes <2 minutes across all programs, just execute sequentially — splitting overhead isn't worth it.

Prefer direct \`execute_command\` for focused single-bridge tasks.
Treat renders, sims, bakes, caches, exports, and asset generation as good fanout candidates.

### Handoff Protocol (Required)

- At task START: call \`get_handoff\` to see what other agents did on this project.
- After each significant step: call \`post_handoff\` with what you did and key file paths.
- If you modify project files: include \`file_hashes\` so the next agent can detect changes.
- Before modifying files another agent touched: call \`check_project_changes\` first.

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
- **paths to upstream outputs** (renders, textures, intermediate files) so the sub-job can visually compare its output against the input it received. If the upstream render was correct, the sub-job's output must not degrade it.

**Pipeline verification**: When a sub-job is part of a pipeline (e.g. Blender render → Nuke composite), tell the sub-job to load and visually compare its final output against the upstream input. If the sub-job's output looks worse (overexposed, color-shifted, artifacts), it must fix the issue before reporting success.

---

### Skill Discipline (Required)

**Before execution:**
1. \`search_skills\` with keywords relevant to the task (materials, lighting, export, node setup, API, etc.)
2. \`get_skill\` on the top matches and follow their patterns
3. Do NOT guess API parameters or node setups when a skill might already document them

**During execution:**
- When you discover a workaround, API quirk, or non-obvious parameter: \`create_skill\` immediately
- Focus each skill on ONE specific technique (e.g. "blender-5-compositor-setup", not "blender-general-tips")
- Include the exact code/parameters that work

**When stuck, hitting limitations, or retrying (MANDATORY):**
- If something fails, errors, or produces unexpected results: STOP and \`search_skills\` for that specific problem
- If you hit a tool/software limitation (e.g. "Nuke NC 10-node limit", "Blender API changed", "Houdini apprentice restrictions"): STOP and \`search_skills\` for workarounds BEFORE simplifying or skipping work
- Search with specific keywords (e.g. "nuke nc 10-node workaround", "nuke shuffle2 blank output", "blender compositor none")
- If a technique isn't working after 2 attempts, you MUST search skills before trying a 3rd time
- Do NOT simplify or drop requested work because of limitations — search for a workaround skill first
- After finding and using a fix from a skill, \`rate_skill\` it

**After completion:**
- Ask: "What would save the next agent time on a similar task?"
- If the answer is non-trivial, create or update a skill

### Bridge Script Output (Important)

Bridge \`execute_command\` does NOT return stdout/print output — it only returns success/failure.
To read variable values, parameter names, or debug info, write to a JSON file and use \`read_client_file\`:

\`\`\`python
import json
result = {"params": {p.name(): str(p.eval()) for p in node.parms()}}
with open(f"{project_dir}/_arkestrator/{job_id}/debug.json", "w") as f:
    json.dump(result, f, indent=2)
\`\`\`

Do NOT waste turns guessing parameter names — dump them all in one call.

### Native File Saving (Required)

Every job that creates or modifies a scene MUST save the native file:
- Blender: \`.blend\`
- Houdini: \`.hip\` / \`.hiplc\` / \`.hipnc\`
- Nuke: \`.nk\` / \`.nknc\`

Save to \`{projectRoot}/scenes/\` or the bridge's current project path.
Organize render outputs in \`{projectRoot}/renders/{bridge}/\`, not flat in the root.

**Create a skill when you:**
- Built a multi-step workflow (node graph, script sequence, modifier stack)
- Used specific parameter values that matter (IOR, roughness, resolution, thresholds)
- Discovered version-specific behavior or API quirks
- Wrote a reusable script/snippet (>10 lines) for a bridge
- Had to retry or debug something — the fix is worth preserving
- Combined multiple techniques in a non-obvious way

**Skip skill creation for:** trivial one-liners, obvious operations, tasks with no reusable pattern.

**How to create:**
1. Call \`create_skill(slug, title, program, content, keywords)\`
2. Content must include **concrete code/parameters**, not just descriptions
3. Use rich keywords for searchability: \`["glass", "caustics", "ior", "bsdf", "wine-glass"]\`

**Before starting work**, call \`search_skills\` once to check if relevant skills exist.
If you find one, call \`get_skill\` to read it. If it's outdated or incomplete, \`update_skill\` it.
When you learn something non-trivial, \`create_skill\` so future tasks benefit.

---

### Exit Protocol

When all required direct work and sub-jobs are complete or intentionally dispatched:
1. Summarize completed work and any dispatched job dependency flow.
2. Include explicit PASS/FAIL verification evidence.
3. Include a **Skills Report** section:
   - **Created**: list any skills you created with \`create_skill\` (slug + one-line summary)
   - **Updated**: list any skills you improved with \`update_skill\`
   - **Used**: list skills you pulled with \`get_skill\` and how useful they were
   - **Rated**: list skills you rated with \`rate_skill\` and the rating
   - Omit sections with no entries. If no skill activity, omit the entire report.
4. Print: **All sub-jobs dispatched - pipeline complete** only when that state is true.
5. Exit cleanly.

---

### Prohibited

- Do not run broad machine-wide file scans for convenience.
- Do not skip plan output before first execution.
- Do not skip verification before reporting done.
- Do not claim success without evidence.
- Do not perform unrelated refactors or scene-wide rewrites for narrow requests.
- Do not rely on assumptions when context/tool output can verify state.
- Do NOT simplify or skip requested work because of tool limitations. If the user asked for a beauty rebuild from AOV passes, you must do it — not just pass through the Combined pass. If you loaded skills that document workarounds for limitations (e.g. Nuke NC 10-node limit), USE those workarounds instead of dropping the work.

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
- \`search_skills(query, program?, category?)\`
- \`get_skill(slug, program?)\`
- \`create_skill(slug, title, program, content, keywords?)\`
- \`update_skill(slug, program?, content?, title?, keywords?)\`
- \`rate_skill(slug, rating, notes?)\`

CLI equivalents:
- \`am bridges\`, \`am context <program>\`, \`am exec <program> -f <script>\`
- \`am jobs create -f <job.json>\`, \`am jobs status <jobId>\`, \`am jobs list\`
- \`am headless-check <program> --args '["--headless", ...]'\`
`.trim();

/**
 * Generic coordinator stub for bridge programs without repo-provided content.
 * Real coordinator scripts come from the arkestrator-bridges repo (pulled on bridge connect)
 * or are created by users via the Skills admin page.
 */
function genericCoordinatorStub(program: string): string {
  const label = program.charAt(0).toUpperCase() + program.slice(1);
  return `# ${label} Coordinator

You are connected to a live ${label} session through Arkestrator.

Use \`execute_command(target="${program}", ...)\` to run scripts in the ${label} environment.

## Guidelines
- Always verify your work before reporting success.
- Use the bridge's native scripting language.
- Check available context items and files from the bridge.

## Skills
Use \`search_skills("${program}")\` to find relevant guidance and patterns for this program.
Additional coordinator content can be pulled from the bridge registry or created via the admin Skills page.`.trim();
}

/* -- Bridge-specific prompts removed in v0.1.61 --
 * Coordinator content for individual programs (blender, godot, houdini, etc.)
 * now lives in the arkestrator-bridges repo as coordinator.md files.
 * The server pulls them on bridge connect via the skill-registry system.
 * See: server/src/skills/skill-registry.ts
 */

/** Map of built-in coordinator script defaults keyed by program name.
 * Only the global orchestrator is shipped as a built-in.
 * Bridge-specific coordinators come from the arkestrator-bridges repo
 * (pulled on bridge connect) or are created by users via the Skills page.
 */
const COORDINATOR_SCRIPT_DEFAULTS: Record<string, string> = {
  global: DEFAULT_ORCHESTRATOR_PROMPT,
};

// ---- Bridge-specific prompts removed in v0.1.61 ----
// Coordinator content for blender, godot, houdini, comfyui, unity, unreal
// now lives in the arkestrator-bridges repo as coordinator.md files.
// The server pulls them on bridge connect via skill-registry.ts.
// New/unknown bridges get a generic stub from genericCoordinatorStub().
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
      // Pattern skills come from bridge repos — no longer seeded as built-in.
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

// seedBuiltinPatternSkills removed in v0.1.61 — pattern skills come from bridge repos.

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
      const content = registryContent ?? genericCoordinatorStub(normalized);
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

    const content = registryContent ?? genericCoordinatorStub(normalized);

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
  jobId?: string,
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
  if (result.includes("{JOB_ID}") && jobId) {
    result = result.replaceAll("{JOB_ID}", jobId);
  }

  // Add file access hint when bridges are available
  if (bridgeListLines.length > 0) {
    result += "\n\n## Reading Client Files\n" +
      "You can read files from the client machine (renders, project files, textures) using the " +
      "`read_client_file` MCP tool. This reads files via the bridge connection — no file syncing needed. " +
      "For images, the file is saved locally and you can then use the Read tool to view it visually.";
  }

  return result;
}
