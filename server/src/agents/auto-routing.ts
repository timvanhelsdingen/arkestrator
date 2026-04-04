import type { AgentConfig, JobRuntimeOptions } from "@arkestrator/protocol";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { RoutingOutcomesRepo } from "../db/routing-outcomes.repo.js";
import { resolveModelForRun } from "./runtime-options.js";
import { isModelAllowedByStoredAllowlist } from "../local-models/catalog.js";
import { classifyTaskPattern } from "./task-classifier.js";

export type RoutingReason = "local" | "cloud";

export interface RoutedAgentSelection {
  requestedAgentConfigId: "auto";
  actualAgentConfigId: string;
  actualModel?: string;
  routingReason: RoutingReason;
  config: AgentConfig;
  note: string;
}

function isLocalEngine(config: AgentConfig): boolean {
  return config.engine === "local-oss";
}

function routingReasonFor(config: AgentConfig): RoutingReason {
  return isLocalEngine(config) ? "local" : "cloud";
}

function complexityScore(prompt: string): number {
  const text = prompt.toLowerCase();
  let score = 0;
  if (prompt.length > 900) score += 2;
  if ((prompt.match(/\n/g)?.length ?? 0) > 8) score += 1;
  const keywords = [
    "architecture",
    "refactor",
    "multi-file",
    "migration",
    "performance",
    "optimize",
    "root cause",
    "security",
    "concurrency",
    "database",
    "integration",
    "test plan",
  ];
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}

function parseModelSizeFromName(model: string | undefined): number | undefined {
  const value = String(model ?? "").toLowerCase();
  if (!value) return undefined;
  const match = value.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function sortedByPriority(configs: AgentConfig[]): AgentConfig[] {
  return configs
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.name.localeCompare(b.name);
    });
}

function findById(configs: AgentConfig[], id: string | undefined): AgentConfig | undefined {
  if (!id) return undefined;
  return configs.find((config) => config.id === id);
}

function followFallbackChain(
  configs: AgentConfig[],
  from: AgentConfig,
): AgentConfig[] {
  const seen = new Set<string>([from.id]);
  const chain: AgentConfig[] = [];
  let current = from;
  for (let i = 0; i < 8; i++) {
    const next = findById(configs, current.fallbackConfigId);
    if (!next || seen.has(next.id)) break;
    chain.push(next);
    seen.add(next.id);
    current = next;
  }
  return chain;
}

function isLocalAllowed(
  config: AgentConfig,
  runtimeOptions: JobRuntimeOptions | undefined,
  settingsRepo: SettingsRepo,
): boolean {
  if (!isLocalEngine(config)) return true;
  const effectiveModel = resolveModelForRun(config.model, runtimeOptions);
  return isModelAllowedByStoredAllowlist(settingsRepo, "ollama", effectiveModel);
}

export function resolveAutoAgentByPriority(
  prompt: string,
  runtimeOptions: JobRuntimeOptions | undefined,
  agentsRepo: AgentsRepo,
  settingsRepo: SettingsRepo,
  routingOutcomesRepo?: RoutingOutcomesRepo,
  bridgeProgram?: string,
): RoutedAgentSelection {
  const configs = sortedByPriority(agentsRepo.list());
  if (configs.length === 0) {
    throw new Error("No agent configs available for AUTO routing");
  }

  const primary = configs[0]!;
  const complexity = complexityScore(prompt);
  const fallbackChain = followFallbackChain(configs, primary);
  const fallbackPool = [
    ...fallbackChain,
    ...configs.filter((candidate) => candidate.id !== primary.id && !fallbackChain.some((chain) => chain.id === candidate.id)),
  ];

  // Start from the highest-priority config.
  let chosen = primary;
  let note = `selected highest-priority config (${primary.name})`;

  // Guard against local model allowlist blocks by following explicit fallback chain.
  if (!isLocalAllowed(primary, runtimeOptions, settingsRepo)) {
    const allowedFallback = fallbackPool.find((candidate) =>
      isLocalAllowed(candidate, runtimeOptions, settingsRepo),
    );
    if (allowedFallback) {
      chosen = allowedFallback;
      note = `primary local model not allowed; used fallback candidate (${allowedFallback.name})`;
    }
  }

  // Complexity-based escalation: when primary is local and prompt is complex,
  // prefer explicit fallback chain (or next priority candidates) if configured.
  if (chosen.id === primary.id && isLocalEngine(primary) && complexity >= 3) {
    const primarySize = parseModelSizeFromName(primary.model);
    const firstEscalationTarget = fallbackPool.find((candidate) => {
      if (!isLocalAllowed(candidate, runtimeOptions, settingsRepo)) return false;
      if (!isLocalEngine(candidate)) return true;
      const candidateSize = parseModelSizeFromName(candidate.model);
      if (primarySize !== undefined && candidateSize !== undefined) return candidateSize > primarySize;
      return false;
    });
    const firstUsableFallback = firstEscalationTarget ?? fallbackPool.find((candidate) =>
      isLocalAllowed(candidate, runtimeOptions, settingsRepo),
    );
    if (firstUsableFallback) {
      chosen = firstUsableFallback;
      note = `complex prompt (score=${complexity}); escalated to fallback candidate (${firstUsableFallback.name})`;
    }
  }

  // Learned routing: check if we have outcome data suggesting a better config
  // within the SAME engine family as the currently chosen config.
  if (routingOutcomesRepo) {
    try {
      const pattern = classifyTaskPattern(prompt, bridgeProgram);
      const best = routingOutcomesRepo.getBestConfigForEngine(pattern, chosen.engine, 5);
      if (
        best &&
        best.configId !== chosen.id &&
        best.successRate > 0.7 &&
        best.totalJobs >= 5
      ) {
        // Only switch if the learned config is available and allowed
        const learnedConfig = configs.find((c) => c.id === best.configId);
        if (learnedConfig && isLocalAllowed(learnedConfig, runtimeOptions, settingsRepo)) {
          const chosenStats = routingOutcomesRepo.getBestConfigForEngine(pattern, chosen.engine, 1);
          const chosenRate = chosenStats?.configId === chosen.id ? chosenStats.successRate : -1;
          // Only override if the learned config is meaningfully better
          if (chosenRate < 0 || best.successRate > chosenRate + 0.1) {
            chosen = learnedConfig;
            note = `learned: ${(best.successRate * 100).toFixed(0)}% success for ${pattern} over ${best.totalJobs} jobs (${learnedConfig.name})`;
          }
        }
      }
    } catch {
      // Routing outcomes unavailable — fall through to heuristic result
    }
  }

  const actualModel = resolveModelForRun(chosen.model, runtimeOptions);
  return {
    requestedAgentConfigId: "auto",
    actualAgentConfigId: chosen.id,
    actualModel,
    routingReason: routingReasonFor(chosen),
    config: chosen,
    note,
  };
}
