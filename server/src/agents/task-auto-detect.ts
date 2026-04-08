/**
 * Task Auto-Detection: Recognizes deterministic operations at job submission
 * time and converts them to non-agentic task jobs, skipping the AI agent entirely.
 *
 * Conservative by design — false negatives (missed auto-detect) are fine,
 * false positives (incorrectly auto-detecting) would break user experience.
 */

import type {
  ContextItem,
  EditorContext,
  TaskSpec,
  TaskExecutionType,
  CommandResult,
} from "@arkestrator/protocol";
import type { JobRuntimeOptions } from "@arkestrator/protocol";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoDetectResult {
  taskSpec: TaskSpec;
  /** Display name for the job (e.g. "Cache filecache1") */
  name: string;
  /** Resolved bridge program (e.g. "houdini") */
  bridgeProgram: string;
  /** Which pattern matched (for logging) */
  patternId: string;
}

// ---------------------------------------------------------------------------
// Pattern registry
// ---------------------------------------------------------------------------

interface DeterministicPattern {
  id: string;
  /** Bridge programs this pattern applies to */
  programs: string[];
  /** At least one must match the prompt */
  promptPatterns: RegExp[];
  /** Checks the resolved context item — must return true */
  contextPredicate: (item: ContextItem) => boolean;
  /** Generate the bridge command(s) from the matched context item */
  generateCommands: (item: ContextItem) => CommandResult[];
  /** Generate a display name */
  generateName: (item: ContextItem) => string;
}

const PATTERNS: DeterministicPattern[] = [
  // Houdini FileCache — "run/execute/cache/sim this filecache node"
  {
    id: "houdini_filecache",
    programs: ["houdini"],
    promptPatterns: [/\b(?:run|execute|cache|sim|simulate|cook|start)\b/i],
    contextPredicate: (item) => {
      if (item.type !== "node") return false;
      const nodeType = String(item.metadata?.node_type ?? "").toLowerCase();
      return nodeType.includes("filecache");
    },
    generateCommands: (item) => [{
      language: "python",
      script: `hou.node('${item.path}').parm('execute').pressButton()`,
      description: `Execute file cache ${item.name}`,
    }],
    generateName: (item) => `Cache ${item.name}`,
  },

  // Houdini ROP render — "render this ROP node"
  {
    id: "houdini_rop",
    programs: ["houdini"],
    promptPatterns: [/\b(?:render|run|execute|start)\b/i],
    contextPredicate: (item) => {
      if (item.type !== "node") return false;
      const nodeType = String(item.metadata?.node_type ?? "").toLowerCase();
      const category = String(item.metadata?.network_category ?? "").toLowerCase();
      return category === "driver" || /\b(?:rop|render)\b/.test(nodeType);
    },
    generateCommands: (item) => [{
      language: "python",
      script: `hou.node('${item.path}').render()`,
      description: `Render ${item.name}`,
    }],
    generateName: (item) => `Render ${item.name}`,
  },
];

// ---------------------------------------------------------------------------
// Bail-out heuristics
// ---------------------------------------------------------------------------

/** Verbs that suggest the user wants AI reasoning, not blind execution */
const MODIFICATION_VERBS =
  /\b(?:change|set|modify|adjust|configure|connect|disconnect|analyze|help|explain|debug|fix|figure|think|check|inspect|look|review|compare|tweak|update|create|add|remove|delete|wire|rewire|reroute|optimize)\b/i;

/** Max prompt length (characters) for auto-detection. Longer prompts likely need reasoning. */
const MAX_PROMPT_LENGTH = 200;

/** Extract @N references from prompt text, return matched indices (1-based). */
function extractContextRefs(prompt: string): number[] {
  const matches = [...prompt.matchAll(/@(\d+)/g)];
  return matches.map((m) => parseInt(m[1], 10));
}

/**
 * Resolve the single target context item from the prompt.
 * Returns null if zero or multiple items are referenced (too ambiguous).
 * If no @N reference but exactly one context item exists, uses that.
 */
function resolveTarget(
  prompt: string,
  contextItems: ContextItem[],
): ContextItem | null {
  const refs = extractContextRefs(prompt);

  if (refs.length === 1) {
    // Explicit @N reference
    return contextItems.find((ci) => ci.index === refs[0]) ?? null;
  }

  if (refs.length === 0 && contextItems.length === 1) {
    // No explicit ref but only one context item — implicit target
    return contextItems[0];
  }

  // Multiple refs or no items → ambiguous
  return null;
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-detect a deterministic task from the job submission payload.
 * Returns an AutoDetectResult if confident, null otherwise.
 */
export function autoDetectTaskJob(
  prompt: string,
  contextItems: ContextItem[],
  editorContext?: EditorContext,
  bridgeProgram?: string,
  runtimeOptions?: JobRuntimeOptions,
): AutoDetectResult | null {
  // --- Bail-out checks ---

  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return null;
  if (!bridgeProgram) return null;
  if (contextItems.length === 0) return null;
  if (MODIFICATION_VERBS.test(prompt)) return null;

  // Resolve the single target context item
  const target = resolveTarget(prompt, contextItems);
  if (!target) return null;

  // --- Pattern matching ---
  const normalizedProgram = bridgeProgram.toLowerCase();

  for (const pattern of PATTERNS) {
    // Check program match
    if (!pattern.programs.includes(normalizedProgram)) continue;

    // Check prompt pattern
    if (!pattern.promptPatterns.some((re) => re.test(prompt))) continue;

    // Check context predicate
    if (!pattern.contextPredicate(target)) continue;

    // Match found — generate TaskSpec
    const executionType: TaskExecutionType =
      runtimeOptions?.bridgeExecutionMode === "headless"
        ? "worker_headless"
        : "bridge_command";

    const commands = pattern.generateCommands(target);
    const name = pattern.generateName(target);

    const taskSpec: TaskSpec = {
      executionType,
      targetProgram: bridgeProgram,
      commands,
      timeoutMs: 600_000,
      label: name,
    };

    logger.info(
      "auto-detect",
      `Matched pattern "${pattern.id}" for prompt "${prompt.slice(0, 80)}" → task job "${name}"`,
    );

    return { taskSpec, name, bridgeProgram, patternId: pattern.id };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Soft hint detection (for agent prompt injection)
// ---------------------------------------------------------------------------

/** Loose action verbs — broader than the strict patterns above */
const HINT_ACTION_VERBS =
  /\b(?:run|execute|cache|sim|simulate|cook|render|bake|export|start)\b/i;

/**
 * Looser check: does the prompt *look like* it might be a deterministic operation?
 * Used to inject a hint into the agent's system prompt when auto-detect didn't
 * trigger (e.g., no context items, or the pattern wasn't confident enough).
 */
export function isDeterministicHint(
  prompt: string,
  contextItems: ContextItem[],
  bridgeProgram?: string,
): boolean {
  if (!prompt || !bridgeProgram) return false;

  // Must have action verbs
  if (!HINT_ACTION_VERBS.test(prompt)) return false;

  // If modification verbs are present, not a simple deterministic op
  if (MODIFICATION_VERBS.test(prompt)) return false;

  // Must reference a context item or have context items
  const refs = extractContextRefs(prompt);
  if (refs.length === 0 && contextItems.length === 0) return false;

  // Check if any context item looks like a deterministic target (node type)
  const hasNodeTarget = contextItems.some((ci) => {
    if (ci.type !== "node") return false;
    const nodeType = String(ci.metadata?.node_type ?? "").toLowerCase();
    return /filecache|rop|render|cache|sim|export|bake/.test(nodeType);
  });

  return hasNodeTarget;
}
