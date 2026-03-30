import { z } from "zod";

export const LocalAgenticToolName = z.enum([
  "list_bridges",
  "get_bridge_context",
  "execute_command",
  "execute_multiple_commands",
  "run_headless_check",
  "list_agent_configs",
  "create_job",
  "get_job_status",
  "list_jobs",
]);
export type LocalAgenticToolName = z.infer<typeof LocalAgenticToolName>;

export const LocalAgenticToolCall = z.object({
  type: z.literal("tool_call"),
  tool: LocalAgenticToolName,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type LocalAgenticToolCall = z.infer<typeof LocalAgenticToolCall>;

export const LocalAgenticFinal = z.object({
  type: z.literal("final"),
  status: z.enum(["completed", "blocked", "failed"]).default("completed"),
  summary: z.string().min(1),
});
export type LocalAgenticFinal = z.infer<typeof LocalAgenticFinal>;

export const LocalAgenticAction = z.union([LocalAgenticToolCall, LocalAgenticFinal]);
export type LocalAgenticAction = z.infer<typeof LocalAgenticAction>;

export interface ParsedLocalAgenticAction {
  action?: LocalAgenticAction;
  candidate?: string;
  error?: string;
}

export const LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS = `
## Local Agentic Tool Protocol (Strict)

You must reply with exactly one JSON object and nothing else.

Allowed response shapes:
1) Tool call:
{"type":"tool_call","tool":"<tool_name>","args":{...}}
2) Final result:
{"type":"final","status":"completed|blocked|failed","summary":"..."}

Rules:
- Do not output markdown or code fences.
- Do not output prose before/after JSON.
- Call one tool at a time, wait for result, then choose next action.
- IMPORTANT: When the task is done, you MUST return: {"type":"final","status":"completed","summary":"what you did"}
- After calling a tool and getting a successful result that answers the question, IMMEDIATELY return a final response. Do NOT call the same tool again.
- Never use type="message" or type="response" — only type="tool_call" or type="final".
- In Blender scripts: colors must be RGBA (4 values), e.g. (0.8, 0.2, 0.1, 1.0), NOT RGB (3 values).
- If a command fails with an error, try a DIFFERENT approach — do not repeat the exact same code.
- When you receive an error about "Invalid node type name", use get_bridge_context to learn correct node types, or try different names.
`.trim();

/**
 * Normalize common model output deviations to the expected protocol format.
 * Local models sometimes output {"type":"message","text":"..."} or
 * {"type":"response","content":"..."} instead of the strict {"type":"final",...}
 */
function normalizeModelOutput(parsed: Record<string, unknown>): Record<string, unknown> {
  const type = String(parsed.type ?? "").toLowerCase();
  if (type === "message" || type === "response" || type === "result" || type === "answer") {
    const summary = String(parsed.text ?? parsed.content ?? parsed.message ?? parsed.summary ?? "Task completed");
    const status = String(parsed.status ?? "completed");
    return {
      type: "final",
      status: ["completed", "blocked", "failed"].includes(status) ? status : "completed",
      summary,
    };
  }
  return parsed;
}

export function parseLocalAgenticAction(raw: string): ParsedLocalAgenticAction {
  const text = String(raw ?? "").trim();
  if (!text) return { error: "Empty model output" };

  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      // First try strict parse
      try {
        const action = LocalAgenticAction.parse(parsed);
        return { action, candidate };
      } catch {
        // Try after normalization (handles type:"message" etc.)
        const normalized = normalizeModelOutput(parsed);
        const action = LocalAgenticAction.parse(normalized);
        return { action, candidate: "[normalized]" };
      }
    } catch {
      // try next candidate
    }
  }

  const heuristic = extractHeuristicAction(text);
  if (heuristic) {
    return { action: heuristic, candidate: "[heuristic]" };
  }

  return {
    candidate: candidates[0],
    error: "Could not parse a valid local agentic JSON action",
  };
}

function extractHeuristicAction(text: string): LocalAgenticAction | undefined {
  const toolNameMatch = /"tool"\s*:\s*"([a-z_]+)"/i.exec(text);
  const toolName = toolNameMatch?.[1]?.trim();
  if (!toolName || !LocalAgenticToolName.options.includes(toolName as LocalAgenticToolName)) {
    return undefined;
  }

  const args: Record<string, unknown> = {};
  const unescapeJsonString = (value: string): string =>
    value
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  const pushStringArg = (key: string, ...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      const value = match?.[1];
      if (value !== undefined && value !== "") {
        args[key] = unescapeJsonString(value);
        return;
      }
    }
  };

  switch (toolName) {
    case "list_bridges":
    case "list_agent_configs":
    case "list_jobs":
      break;
    case "get_bridge_context":
      pushStringArg("target", /"target"\s*:\s*"([^"]+)"/i, /target\s*=\s*"([^"]+)"/i);
      break;
    case "get_job_status":
      pushStringArg("job_id", /"job_id"\s*:\s*"([^"]+)"/i, /job_id\s*=\s*"([^"]+)"/i);
      break;
    case "execute_command":
      pushStringArg("target", /"target"\s*:\s*"([^"]+)"/i, /target\s*=\s*"([^"]+)"/i);
      pushStringArg("language", /"language"\s*:\s*"([^"]+)"/i, /language\s*=\s*"([^"]+)"/i);
      pushStringArg("script", /"script"\s*:\s*"((?:[^"\\]|\\.)*)"/i, /script\s*=\s*"((?:[^"\\]|\\.)*)"/i);
      pushStringArg("description", /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i, /description\s*=\s*"((?:[^"\\]|\\.)*)"/i);
      break;
    case "execute_multiple_commands":
      pushStringArg("target", /"target"\s*:\s*"([^"]+)"/i, /target\s*=\s*"([^"]+)"/i);
      break;
    case "run_headless_check":
      pushStringArg("program", /"program"\s*:\s*"([^"]+)"/i, /program\s*=\s*"([^"]+)"/i);
      break;
    case "create_job":
      pushStringArg("prompt", /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/i, /prompt\s*=\s*"((?:[^"\\]|\\.)*)"/i);
      pushStringArg("target_program", /"target_program"\s*:\s*"([^"]+)"/i, /target_program\s*=\s*"([^"]+)"/i);
      break;
    default:
      break;
  }

  try {
    return LocalAgenticToolCall.parse({
      type: "tool_call",
      tool: toolName,
      args,
    });
  } catch {
    return undefined;
  }
}

function collectJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  push(text);

  // Fenced JSON blocks
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null = null;
  while ((fenceMatch = fenced.exec(text)) !== null) {
    push(fenceMatch[1] ?? "");
  }

  // First balanced object/array from plain text
  const balanced = extractBalancedJson(text);
  if (balanced) push(balanced);

  return out;
}

// ---------------------------------------------------------------------------
// Shared prompt building helpers (used by both server and client agentic loops)
// ---------------------------------------------------------------------------

export interface LocalAgenticHistoryEntry {
  turn: number;
  action: string;
  result: string;
}

/**
 * Build the full prompt for a single agentic turn.
 * Shared between server-side and client-side agentic loops.
 */
export function buildLocalAgenticTurnPrompt(
  basePrompt: string,
  history: LocalAgenticHistoryEntry[],
  turn: number,
  maxTurns: number,
  allowDelegationTools: boolean,
  customSystemPrompt?: string,
): string {
  const historyLines = history.length > 0
    ? history
      .slice(-8)
      .map((entry) => [
        `Turn ${entry.turn} Action:`,
        entry.action,
        `Turn ${entry.turn} Result:`,
        entry.result,
      ].join("\n"))
      .join("\n\n")
    : "(none yet)";

  const toolLines = [
    "- list_bridges()",
    "- get_bridge_context(target)",
    "- execute_command(target, language, script, description?, timeout?)",
    "- execute_multiple_commands(target, commands[], timeout?)",
    "- run_headless_check(program, args[], project_path?, timeout?)",
  ];
  if (allowDelegationTools) {
    toolLines.push(
      "- list_agent_configs()",
      "- create_job(prompt, handover_notes?, agent_config_id?, target_program?, target_worker?, depends_on_job_ids?, priority?, name?)",
      "- get_job_status(job_id)",
      "- list_jobs(status?, limit?)",
    );
  }

  return [
    LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
    ...(customSystemPrompt ? ["", "## Additional Instructions", customSystemPrompt] : []),
    "",
    "## Available Tools",
    ...toolLines,
    "",
    "## CRITICAL: You MUST use tools to execute code",
    "- You are connected to live applications (Blender, Houdini, Godot, ComfyUI) via bridges.",
    "- To make changes, you MUST call execute_command or execute_multiple_commands with actual executable code.",
    "- NEVER just describe code or write instructions. Always call the tool to run it in the live application.",
    "- Prefer execute_command over execute_multiple_commands — put ALL code in ONE script.",
    "- IMPORTANT: Each command runs in its own isolated scope. Variables do NOT persist between commands.",
    "- So write one complete self-contained Python script per execute_command call.",
    "- For Godot/GDScript: `script` must be valid GDScript with `func run(editor: EditorInterface) -> void:` as the entrypoint.",
    "- Keep `target` as bridge program name (for example `godot`, `blender`, `houdini`).",
    "",
    allowDelegationTools
      ? "Use create_job/list_jobs/get_job_status when work splits cleanly across bridges, agents, workers, or long-running background tasks. If one branch can keep progressing while another renders, simulates, bakes, or generates assets, proactively fan out and then join with get_job_status."
      : "Delegation tools are disabled for this task. Do direct execution with execute_command/execute_multiple_commands.",
    "",
    "## Task",
    basePrompt,
    "",
    `## Turn ${turn}/${maxTurns} Transcript`,
    historyLines,
    "",
    "Return exactly one JSON object for the next action.",
  ].join("\n");
}

/**
 * Compact-serialize data to JSON, truncating to maxLen if needed.
 */
export function compactJson(data: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(data);
    return json.length > maxLen ? json.slice(0, maxLen - 3) + "..." : json;
  } catch {
    return String(data);
  }
}

// ---------------------------------------------------------------------------
// Shared constants for the local agentic loop
// ---------------------------------------------------------------------------

export const LOCAL_AGENTIC_DEFAULTS = {
  MAX_TURNS: 40,
  DEFAULT_TURNS: 12,
  DEFAULT_TURN_TIMEOUT_MS: 120_000,
  MAX_TURN_TIMEOUT_MS: 300_000,
  FIRST_TURN_MIN_TIMEOUT_MS: 300_000,
  MIN_TURN_TIMEOUT_MS: 90_000,
  MAX_INVALID_PROTOCOL_TURNS: 3,
  MAX_CONSECUTIVE_ERRORS: 5,
} as const;

export const LOCAL_AGENTIC_DELEGATION_TOOLS = new Set<LocalAgenticToolCall["tool"]>([
  "list_agent_configs",
  "create_job",
  "get_job_status",
  "list_jobs",
]);

/**
 * Detect whether a task prompt implies multi-agent / delegation work.
 * Shared between server-side and client-side agentic loops.
 */
export function promptRequestsDelegation(
  prompt: string,
  knownPrograms?: string[],
): boolean {
  const text = String(prompt ?? "").toLowerCase();
  if (!text) return false;
  if (/(multi[-\s]?agent|multiple agents|multiple machin|cross[-\s]?machine|delegate|delegation|sub[-\s]?job|fanout|pipeline|parallel|simultaneous|in parallel|background|meanwhile|while)/i.test(text)) {
    return true;
  }
  const programs = knownPrograms ?? ["godot", "blender", "houdini", "comfyui", "unity", "unreal", "nuke", "fusion"];
  const bridgeMentions = programs
    .filter((program) => new RegExp(`\\b${program}\\b`, "i").test(text));
  if (bridgeMentions.length >= 2) return true;
  if (
    bridgeMentions.length >= 1
    && /(render|simulation|simulate|sim\b|cache|bake|texture|generate|generation|upscale|export)/i.test(text)
  ) {
    return true;
  }
  return false;
}

function extractBalancedJson(text: string): string | null {
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (start < 0) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
