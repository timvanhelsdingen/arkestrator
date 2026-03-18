import type {
  AgentConfig,
  BridgeExecutionMode,
  CoordinationScriptMode,
  CoordinationScripts,
  JobRuntimeOptions,
  RuntimeReasoningLevel,
  RuntimeVerificationMode,
} from "@arkestrator/protocol";

const RUNTIME_REASONING_LEVELS = new Set<RuntimeReasoningLevel>(["low", "medium", "high", "xhigh"]);
const RUNTIME_VERIFICATION_MODES = new Set<RuntimeVerificationMode>(["required", "optional", "disabled"]);
const BRIDGE_EXECUTION_MODES = new Set<BridgeExecutionMode>(["live", "headless"]);
const COORDINATION_SCRIPT_MODES = new Set<CoordinationScriptMode>(["enabled", "disabled", "auto"]);

function normalizeModelValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeReasoningLevel(value: unknown): RuntimeReasoningLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!RUNTIME_REASONING_LEVELS.has(normalized as RuntimeReasoningLevel)) return undefined;
  return normalized as RuntimeReasoningLevel;
}

export function normalizeVerificationMode(value: unknown): RuntimeVerificationMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!RUNTIME_VERIFICATION_MODES.has(normalized as RuntimeVerificationMode)) return undefined;
  return normalized as RuntimeVerificationMode;
}

export function normalizeBridgeExecutionMode(value: unknown): BridgeExecutionMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!BRIDGE_EXECUTION_MODES.has(normalized as BridgeExecutionMode)) return undefined;
  return normalized as BridgeExecutionMode;
}

function normalizeVerificationWeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) return undefined;
  return rounded;
}

function normalizeCoordinationScriptMode(value: unknown): CoordinationScriptMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!COORDINATION_SCRIPT_MODES.has(normalized as CoordinationScriptMode)) return undefined;
  return normalized as CoordinationScriptMode;
}

export function normalizeCoordinationScripts(
  value: unknown,
): CoordinationScripts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const coordinator = normalizeCoordinationScriptMode(obj.coordinator);
  const bridge = normalizeCoordinationScriptMode(obj.bridge);
  const training = normalizeCoordinationScriptMode(obj.training);
  if (!coordinator && !bridge && !training) return undefined;
  return {
    coordinator: coordinator ?? "enabled",
    bridge: bridge ?? "enabled",
    training: training ?? "enabled",
  };
}

export function normalizeJobRuntimeOptions(
  runtimeOptions: JobRuntimeOptions | undefined,
): JobRuntimeOptions | undefined {
  if (!runtimeOptions) return undefined;
  const model = normalizeModelValue(runtimeOptions.model);
  const reasoningLevel = normalizeReasoningLevel(runtimeOptions.reasoningLevel);
  const verificationMode = normalizeVerificationMode(runtimeOptions.verificationMode);
  const verificationWeight = normalizeVerificationWeight(runtimeOptions.verificationWeight);
  const bridgeExecutionMode = normalizeBridgeExecutionMode(runtimeOptions.bridgeExecutionMode);
  const coordinationScripts = normalizeCoordinationScripts(runtimeOptions.coordinationScripts);
  if (
    !model
    && !reasoningLevel
    && !verificationMode
    && verificationWeight === undefined
    && !bridgeExecutionMode
    && !coordinationScripts
  ) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(verificationMode ? { verificationMode } : {}),
    ...(verificationWeight !== undefined ? { verificationWeight } : {}),
    ...(bridgeExecutionMode ? { bridgeExecutionMode } : {}),
    ...(coordinationScripts ? { coordinationScripts } : {}),
  };
}

const BRIDGE_HEADLESS_HINT_PATTERNS: RegExp[] = [
  /\b(?:use|run|execute|launch|start|open|do|perform)\b[^.!?\n]{0,60}\b(?:headless|cli|command\s*line|commandline|background(?:\s+process|\s+mode)?|separate\s+process|hython)\b/i,
  /\b(?:in|via|through|as)\b[^.!?\n]{0,20}\b(?:headless|cli|command\s*line|commandline|background(?:\s+process|\s+mode)?|separate\s+process|hython)\b/i,
  /\b(?:without|not|don't|do not)\s+touch(?:ing)?\b[^.!?\n]{0,40}\b(?:my|the)?\s*(?:active|current|live)\s+(?:session|scene|instance)\b/i,
  /\b(?:leave|keep)\b[^.!?\n]{0,30}\b(?:my|the)?\s*(?:active|current|live)\s+(?:session|scene|instance)\s+alone\b/i,
  /\bseparate\s+process\b/i,
  /\bhython\b/i,
];

export function inferPromptBridgeExecutionMode(
  prompt: string | undefined,
): BridgeExecutionMode | undefined {
  const text = String(prompt ?? "").trim();
  if (!text) return undefined;
  return BRIDGE_HEADLESS_HINT_PATTERNS.some((pattern) => pattern.test(text))
    ? "headless"
    : undefined;
}

export function applyPromptBridgeExecutionMode(
  prompt: string | undefined,
  runtimeOptions: JobRuntimeOptions | undefined,
): JobRuntimeOptions | undefined {
  const normalized = normalizeJobRuntimeOptions(runtimeOptions);
  const explicit = normalizeBridgeExecutionMode(normalized?.bridgeExecutionMode);
  const inferred = explicit ?? inferPromptBridgeExecutionMode(prompt);
  if (!normalized && !inferred) return undefined;
  return {
    ...(normalized ?? {}),
    ...(inferred ? { bridgeExecutionMode: inferred } : {}),
  };
}

export function resolveModelForRun(
  configModel: string | undefined,
  runtimeOptions: JobRuntimeOptions | undefined,
): string | undefined {
  const runtimeModel = normalizeModelValue(runtimeOptions?.model);
  if (runtimeModel) return runtimeModel;
  return normalizeModelValue(configModel);
}

function stripCodexReasoningArgs(rawArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--reasoning-effort") {
      i++;
      continue;
    }
    if (arg.startsWith("--reasoning-effort=")) {
      continue;
    }
    if (arg === "-c") {
      const next = rawArgs[i + 1];
      if (
        typeof next === "string"
        && next.trim().toLowerCase().startsWith("model_reasoning_effort")
      ) {
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/**
 * Apply per-job runtime options to an agent config without mutating persisted config rows.
 */
export function applyRuntimeOptionsToConfig(
  config: AgentConfig,
  runtimeOptions: JobRuntimeOptions | undefined,
): AgentConfig {
  const normalized = normalizeJobRuntimeOptions(runtimeOptions);
  const hasExecutionOverride = !!normalized?.model || !!normalized?.reasoningLevel;
  if (!normalized || !hasExecutionOverride) {
    return {
      ...config,
      model: resolveModelForRun(config.model, undefined),
    };
  }

  const resolvedModel = resolveModelForRun(config.model, normalized);
  let resolvedArgs = [...config.args];

  if (config.engine === "codex") {
    resolvedArgs = stripCodexReasoningArgs(resolvedArgs);
    if (normalized.reasoningLevel) {
      resolvedArgs.push("-c", `model_reasoning_effort="${normalized.reasoningLevel}"`);
    }
  }

  return {
    ...config,
    args: resolvedArgs,
    model: resolvedModel,
  };
}
