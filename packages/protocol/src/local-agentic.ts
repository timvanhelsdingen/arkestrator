import { z } from "zod";

/** Known tool names for heuristic extraction. No longer used for validation — MCP server validates. */
export const KNOWN_LOCAL_AGENTIC_TOOLS = [
  "list_bridges",
  "get_bridge_context",
  "execute_command",
  "execute_multiple_commands",
  "execute_local",
  "run_headless_check",
  "search_skills",
  "get_skill",
  "create_skill",
  "rate_skill",
  "list_agent_configs",
  "create_job",
  "get_job_status",
  "list_jobs",
] as const;

/** Accept any tool name string — MCP server validates names at call time. */
export const LocalAgenticToolName = z.string().min(1);
export type LocalAgenticToolName = string;

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
  if (!toolName) return undefined;
  // Accept any tool name that looks valid (MCP server validates at call time)
  // Known tools get heuristic arg extraction; unknown tools get empty args
  const isKnown = (KNOWN_LOCAL_AGENTIC_TOOLS as readonly string[]).includes(toolName);

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

  // Only extract args heuristically for known tools
  if (!isKnown) {
    try {
      return LocalAgenticToolCall.parse({ type: "tool_call", tool: toolName, args });
    } catch {
      return undefined;
    }
  }

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
    "- search_skills(query, program?) — search learned skills for patterns, techniques, known pitfalls",
    "- get_skill(slug, program?) — load full skill content",
    "- create_skill(slug, title, program, content, keywords?, category?) — save something you learned",
    "- rate_skill(slug, rating: useful|not_useful|partial, notes?, relevance?: relevant|partial|irrelevant, accuracy?: accurate|partially_accurate|inaccurate, completeness?: complete|incomplete|missing_critical) — rate a skill after using it",
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
    "## Skills — search before executing",
    "- FIRST call search_skills with your task type (e.g. 'blender donut', 'houdini terrain').",
    "- If results found, call get_skill to load patterns and known pitfalls BEFORE writing code.",
    "- After completing work, call create_skill if you learned something non-trivial.",
    "- Rate skills you used with rate_skill(slug, 'useful'|'not_useful'|'partial').",
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
  MAX_TURNS: 300,
  DEFAULT_TURNS: 12,
  /** Default per-turn timeout when not configured on agent config. */
  DEFAULT_TURN_TIMEOUT_MS: 300_000,
  /** Absolute max per-turn timeout (20 minutes). */
  MAX_TURN_TIMEOUT_MS: 1_200_000,
  /** First turn gets extra time for model loading / cold start. */
  FIRST_TURN_MIN_TIMEOUT_MS: 300_000,
  /** Floor: no turn can be shorter than 3 minutes. */
  MIN_TURN_TIMEOUT_MS: 180_000,
  MAX_INVALID_PROTOCOL_TURNS: 3,
  MAX_CONSECUTIVE_ERRORS: 5,
} as const;

export const LOCAL_AGENTIC_DELEGATION_TOOLS = new Set<string>([
  "list_agent_configs",
  "create_job",
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

// ---------------------------------------------------------------------------
// Ollama native tool calling types & schemas
// ---------------------------------------------------------------------------

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

const CORE_TOOL_SCHEMAS: OllamaToolSchema[] = [
  {
    type: "function",
    function: {
      name: "list_bridges",
      description: "List all connected bridge programs (Blender, Houdini, Godot, ComfyUI, etc.)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bridge_context",
      description: "Get the current editor context from a connected bridge (open files, scene state, etc.)",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Bridge program name (e.g. blender, houdini, godot, comfyui)" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Execute a script in a connected application. Write one complete self-contained script. Each command runs in isolated scope — variables do NOT persist between calls.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Bridge program name (e.g. blender, houdini, godot, comfyui)" },
          language: { type: "string", description: "Script language (e.g. python, gdscript, vex)" },
          script: { type: "string", description: "Complete self-contained script to execute. For Blender: colors must be RGBA (4 values). For Godot: use func run(editor: EditorInterface) -> void: as entrypoint." },
          description: { type: "string", description: "Brief description of what this script does" },
        },
        required: ["target", "language", "script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_multiple_commands",
      description: "Execute multiple scripts in sequence in a connected application",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Bridge program name" },
          commands: { type: "string", description: "JSON array of {language, script, description} objects" },
        },
        required: ["target", "commands"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_headless_check",
      description: "Validate that a headless program can run (e.g. blender --background)",
      parameters: {
        type: "object",
        properties: {
          program: { type: "string", description: "Program name (blender, godot, houdini)" },
          args: { type: "string", description: "JSON array of command-line arguments" },
          project_path: { type: "string", description: "Optional project path" },
        },
        required: ["program", "args"],
      },
    },
  },
];

const SKILL_TOOL_SCHEMAS: OllamaToolSchema[] = [
  {
    type: "function",
    function: {
      name: "search_skills",
      description: "Search learned skills for patterns, techniques, and known pitfalls. Call this BEFORE writing code to find relevant knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (e.g. 'blender donut', 'houdini terrain', 'procedural rock material')" },
          program: { type: "string", description: "Optional program filter (blender, houdini, comfyui, etc.)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_skill",
      description: "Load the full content of a skill by its slug. Use after search_skills returns results.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Skill slug from search results" },
          program: { type: "string", description: "Optional program filter" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_skill",
      description: "Save something you learned as a skill for future tasks. Use when you discover a non-trivial technique, workaround, or pattern.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "URL-friendly identifier (e.g. 'blender5-donut-icing')" },
          title: { type: "string", description: "Human-readable title" },
          program: { type: "string", description: "Target program (blender, houdini, comfyui, global)" },
          content: { type: "string", description: "Step-by-step instructions, code snippets, key parameters, gotchas" },
          category: { type: "string", description: "Skill category (default: custom)" },
        },
        required: ["slug", "title", "program", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rate_skill",
      description: "Rate how useful a skill was for your current task. Optionally provide detailed feedback on relevance, accuracy, and completeness.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Skill slug" },
          rating: { type: "string", description: "How useful was this skill", enum: ["useful", "not_useful", "partial"] },
          notes: { type: "string", description: "Free text explaining why you gave this rating" },
          relevance: { type: "string", description: "Was the skill relevant to the task", enum: ["relevant", "partial", "irrelevant"] },
          accuracy: { type: "string", description: "Was the skill content accurate", enum: ["accurate", "partially_accurate", "inaccurate"] },
          completeness: { type: "string", description: "Was the skill content complete", enum: ["complete", "incomplete", "missing_critical"] },
        },
        required: ["slug", "rating"],
      },
    },
  },
];

const DELEGATION_TOOL_SCHEMAS: OllamaToolSchema[] = [
  {
    type: "function",
    function: {
      name: "list_agent_configs",
      description: "List available AI agent configurations",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_job",
      description: "Create a sub-job to delegate work to another agent or bridge",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task description for the sub-job" },
          agent_config_id: { type: "string", description: "Agent config to use (from list_agent_configs)" },
          target_program: { type: "string", description: "Target bridge program" },
          name: { type: "string", description: "Job name" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_job_status",
      description: "Check the status of a sub-job",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID to check" },
        },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_jobs",
      description: "List jobs with optional status filter",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (queued, running, completed, failed)" },
          limit: { type: "string", description: "Max results (default 20)" },
        },
        required: [],
      },
    },
  },
];

/** Get Ollama-compatible tool schemas for the native /api/chat tools parameter. */
export function getOllamaToolSchemas(options: {
  allowDelegation?: boolean;
  allowSkills?: boolean;
} = {}): OllamaToolSchema[] {
  const tools = [...CORE_TOOL_SCHEMAS];
  if (options.allowSkills !== false) tools.push(...SKILL_TOOL_SCHEMAS);
  if (options.allowDelegation) tools.push(...DELEGATION_TOOL_SCHEMAS);
  return tools;
}

/**
 * Build a system message for hybrid mode — tool definitions embedded in text
 * so thinking models (qwen3, etc.) can reason AND call tools via JSON protocol.
 *
 * Unlike native tool calling, the model outputs `{"type":"tool_call",...}` as text
 * which is parsed by `parseLocalAgenticAction()`.
 */
export function buildOllamaHybridSystemMessage(options: {
  allowDelegation?: boolean;
  allowSkills?: boolean;
  customInstructions?: string;
} = {}): string {
  const schemas = getOllamaToolSchemas({
    allowDelegation: options.allowDelegation,
    allowSkills: options.allowSkills,
  });

  // Format each tool as a readable signature with descriptions
  const toolDefs = schemas.map((s) => {
    const fn = s.function;
    const props = fn.parameters.properties;
    const required = new Set(fn.parameters.required);
    const paramList = Object.entries(props)
      .map(([name, p]) => `${name}: ${p.type}${required.has(name) ? "" : "?"}`)
      .join(", ");
    return `- ${fn.name}(${paramList})\n  ${fn.description}`;
  }).join("\n");

  const lines = [
    LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
    "",
    "## Available Tools",
    toolDefs,
    "",
    "## CRITICAL: You MUST use tools to execute code",
    "- You are connected to live applications (Blender, Houdini, Godot, ComfyUI) via bridges.",
    "- To make changes, you MUST call execute_command with actual executable code.",
    "- NEVER just describe code or write instructions. Always call the tool.",
    "- Each command runs in its own isolated scope. Variables do NOT persist between commands.",
    "- Write one complete self-contained script per execute_command call.",
    "- For Godot/GDScript: entrypoint must be `func run(editor: EditorInterface) -> void:`",
    "",
    "## Workflow",
    "1. Call list_bridges to see connected apps",
    "2. Call search_skills to find relevant patterns",
    "3. Call execute_command with the actual script to run in the app",
    "4. If it fails, fix the script and try again with a DIFFERENT approach",
    '5. When done, return {"type":"final","status":"completed","summary":"what you did"}',
    "",
    "## Skills",
    "- FIRST search_skills for your task type before writing code.",
    "- After completing work, call create_skill if you learned something non-trivial.",
    "- Rate skills you used with rate_skill.",
  ];

  if (options.allowDelegation) {
    lines.push(
      "",
      "## Delegation",
      "Use create_job/list_jobs/get_job_status when work splits across bridges or agents.",
    );
  }

  if (options.customInstructions) {
    lines.push("", "## Additional Context", options.customInstructions);
  }

  return lines.join("\n");
}

/** Build a concise system message for Ollama native tool calling (no protocol instructions needed). */
export function buildOllamaSystemMessage(customInstructions?: string): string {
  const lines = [
    "You are an AI agent that EXECUTES tasks in creative applications (Blender, Houdini, Godot, ComfyUI) by calling tools.",
    "",
    "CRITICAL: You MUST call tools to do work. Do NOT write code in your response text.",
    "Do NOT describe what you would do. Do NOT output scripts as text. CALL the execute_command tool.",
    "",
    "Workflow:",
    "1. Call list_bridges() to see connected apps",
    "2. Call search_skills() to find relevant patterns",
    "3. Call execute_command() with the actual script to run in the app",
    "4. If it fails, fix the script and call execute_command() again",
    "5. When done, reply with a short summary (no tool call = task complete)",
    "",
    "Rules for execute_command scripts:",
    "- Write one complete self-contained script per call",
    "- Variables do NOT persist between calls",
    "- Blender: colors must be RGBA (4 values), e.g. (0.8, 0.2, 0.1, 1.0)",
    "- Godot: entrypoint must be func run(editor: EditorInterface) -> void:",
    "- If a command fails, try a DIFFERENT approach",
  ];
  if (customInstructions) {
    lines.push("", "## Additional Context", customInstructions);
  }
  return lines.join("\n");
}
