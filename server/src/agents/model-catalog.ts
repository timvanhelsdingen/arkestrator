import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEngine } from "@arkestrator/protocol";

export interface ProviderModelCatalog {
  engine: AgentEngine;
  models: string[];
  reasoningLevels: string[];
  source: "claude-local-state" | "claude-app" | "codex-cache" | "official-static";
  preferredDefaultModel?: string;
}

interface CodexCacheReasoningLevel {
  effort?: string;
}

interface CodexCacheModel {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
  supported_reasoning_levels?: CodexCacheReasoningLevel[];
  priority?: number;
}

interface CodexModelsCache {
  models?: CodexCacheModel[];
}

const DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const MODEL_CATALOG_TTL_MS = 30_000;
const CLAUDE_APP_ASAR_PATH = "/Applications/Claude.app/Contents/Resources/app.asar";
const CLAUDE_MODEL_PATTERN = /\bclaude-(?:opus|sonnet|haiku)-[a-z0-9.-]{2,80}\b/gi;

const STATIC_PROVIDER_CATALOGS: Record<AgentEngine, ProviderModelCatalog> = {
  "claude-code": {
    engine: "claude-code",
    models: [],
    reasoningLevels: [],
    source: "official-static",
  },
  codex: {
    engine: "codex",
    models: [
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ],
    reasoningLevels: [...DEFAULT_REASONING_LEVELS],
    source: "official-static",
    preferredDefaultModel: "gpt-5.4",
  },
  gemini: {
    engine: "gemini",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ],
    reasoningLevels: [],
    source: "official-static",
    preferredDefaultModel: "gemini-2.5-pro",
  },
  grok: {
    engine: "grok",
    models: [],
    reasoningLevels: [],
    source: "official-static",
  },
  "local-oss": {
    engine: "local-oss",
    models: [],
    reasoningLevels: [],
    source: "official-static",
  },
};

let cachedProviderCatalogs:
  | { expiresAt: number; catalogs: Record<AgentEngine, ProviderModelCatalog> }
  | null = null;

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(rootPath: string, maxFiles: number, out: string[]) {
  if (!rootPath || out.length >= maxFiles || !isDirectory(rootPath)) return;

  const stack = [rootPath];
  while (stack.length > 0 && out.length < maxFiles) {
    const current = stack.pop();
    if (!current) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const fullPath = join(current, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          stack.push(fullPath);
          continue;
        }
      } catch {
        continue;
      }

      if (!/\.(txt|json|jsonl|md)$/i.test(entry)) continue;
      out.push(fullPath);
    }
  }
}

function normalizeClaudeModelName(value: string): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized.startsWith("claude-")) return null;
  if (!/(?:opus|sonnet|haiku)/.test(normalized)) return null;
  if (normalized.includes("migration")) return null;
  const withoutVariant = normalized.replace(/-v\d+$/, "");
  if (!/\d/.test(withoutVariant)) return null;
  return withoutVariant;
}

function parseClaudeVersion(value: string): { major: number; minor: number; patch: number; date: number } {
  const familyMatch = value.match(/claude-(?:opus|sonnet|haiku)-(.+)$/);
  const tail = familyMatch?.[1] ?? "";
  const parts = tail.split("-").filter(Boolean);
  const major = Number(parts[0] ?? -1);
  let minor = 0;
  let patch = 0;
  let date = 0;

  if (parts.length >= 2) {
    if (/^\d{8}$/.test(parts[1] ?? "")) {
      date = Number(parts[1]);
    } else {
      minor = Number(parts[1] ?? 0);
    }
  }
  if (parts.length >= 3) {
    if (/^\d{8}$/.test(parts[2] ?? "")) {
      date = Number(parts[2]);
    } else {
      patch = Number(parts[2] ?? 0);
    }
  }
  if (parts.length >= 4 && /^\d{8}$/.test(parts[3] ?? "")) {
    date = Number(parts[3]);
  }

  return { major, minor, patch, date };
}

function compareClaudeModelsDesc(a: string, b: string): number {
  const familyRank = (value: string): number => {
    if (value.includes("-opus-")) return 3;
    if (value.includes("-sonnet-")) return 2;
    if (value.includes("-haiku-")) return 1;
    return 0;
  };

  const familyDiff = familyRank(b) - familyRank(a);
  if (familyDiff !== 0) return familyDiff;

  const aVersion = parseClaudeVersion(a);
  const bVersion = parseClaudeVersion(b);
  if (aVersion.major !== bVersion.major) return bVersion.major - aVersion.major;
  if (aVersion.minor !== bVersion.minor) return bVersion.minor - aVersion.minor;
  if (aVersion.patch !== bVersion.patch) return bVersion.patch - aVersion.patch;
  if (aVersion.date !== bVersion.date) return bVersion.date - aVersion.date;

  return a.localeCompare(b);
}

function collectRegexMatches(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const matches = text.match(pattern) ?? [];
  for (const match of matches) {
    const normalized = normalizeClaudeModelName(match);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function loadClaudeModelCatalogFromLocalState(
  options?: {
    claudeDir?: string;
    appAsarPath?: string;
  },
): ProviderModelCatalog | null {
  const claudeDir = options?.claudeDir ?? join(homedir(), ".claude");
  const appAsarPath = options?.appAsarPath ?? CLAUDE_APP_ASAR_PATH;
  const discovered = new Set<string>();
  let source: ProviderModelCatalog["source"] | null = null;

  const candidateFiles: string[] = [];
  walkFiles(join(claudeDir, "debug"), 50, candidateFiles);
  walkFiles(join(claudeDir, "telemetry"), 50, candidateFiles);
  walkFiles(join(claudeDir, "projects"), 200, candidateFiles);

  for (const filePath of candidateFiles) {
    try {
      const text = readFileSync(filePath, "utf8");
      for (const model of collectRegexMatches(text, CLAUDE_MODEL_PATTERN)) {
        discovered.add(model);
      }
    } catch {
      continue;
    }
  }

  if (discovered.size > 0) {
    source = "claude-local-state";
  }

  if (existsSync(appAsarPath)) {
    try {
      const bytes = readFileSync(appAsarPath);
      const text = bytes.toString("utf8");
      for (const model of collectRegexMatches(text, CLAUDE_MODEL_PATTERN)) {
        discovered.add(model);
      }
      if (source === null && discovered.size > 0) {
        source = "claude-app";
      }
    } catch {
      // Ignore unreadable app bundles.
    }
  }

  const models = [...discovered].sort(compareClaudeModelsDesc);
  if (models.length === 0 || source === null) return null;

  return {
    engine: "claude-code",
    models,
    reasoningLevels: [],
    source,
    preferredDefaultModel: models[0],
  };
}

export function loadCodexModelCatalogFromCache(
  cachePath = join(homedir(), ".codex", "models_cache.json"),
): ProviderModelCatalog | null {
  if (!existsSync(cachePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as CodexModelsCache;
    const models = Array.isArray(raw?.models) ? raw.models : [];
    const slugs: string[] = [];
    const seen = new Set<string>();
    const reasoningLevels: string[] = [];
    const reasoningSeen = new Set<string>();
    let preferredDefaultModel: string | null = null;
    let preferredPriority = Number.POSITIVE_INFINITY;

    for (const model of models) {
      const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
      if (!slug) continue;
      if (model?.supported_in_api === false) continue;
      if (model?.visibility && String(model.visibility).trim().toLowerCase() === "hidden") continue;
      if (!seen.has(slug)) {
        seen.add(slug);
        slugs.push(slug);
      }

      const priority = typeof model?.priority === "number" && Number.isFinite(model.priority)
        ? model.priority
        : Number.POSITIVE_INFINITY;
      if (preferredDefaultModel === null || priority < preferredPriority) {
        preferredDefaultModel = slug;
        preferredPriority = priority;
      }

      const supportedReasoningLevels = Array.isArray(model?.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : [];
      for (const entry of supportedReasoningLevels) {
        const effort = normalizeReasoningEffort(entry?.effort);
        if (!effort || reasoningSeen.has(effort)) continue;
        reasoningSeen.add(effort);
        reasoningLevels.push(effort);
      }
    }

    if (slugs.length === 0) return null;
    return {
      engine: "codex",
      models: slugs,
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : [...DEFAULT_REASONING_LEVELS],
      source: "codex-cache",
      preferredDefaultModel: preferredDefaultModel ?? slugs[0],
    };
  } catch {
    return null;
  }
}

export function getProviderModelCatalogs(): Record<AgentEngine, ProviderModelCatalog> {
  const now = Date.now();
  if (cachedProviderCatalogs && cachedProviderCatalogs.expiresAt > now) {
    return cachedProviderCatalogs.catalogs;
  }

  const claudeCatalog = loadClaudeModelCatalogFromLocalState();
  const codexCatalog = loadCodexModelCatalogFromCache();
  const catalogs: Record<AgentEngine, ProviderModelCatalog> = {
    ...STATIC_PROVIDER_CATALOGS,
    ...(claudeCatalog ? { "claude-code": claudeCatalog } : {}),
    ...(codexCatalog ? { codex: codexCatalog } : {}),
  };

  cachedProviderCatalogs = {
    expiresAt: now + MODEL_CATALOG_TTL_MS,
    catalogs,
  };
  return catalogs;
}

export function getPreferredProviderModel(engine: AgentEngine): string | null {
  return getProviderModelCatalogs()[engine]?.preferredDefaultModel ?? null;
}

export function injectPreferredTemplateModel<T extends { engine: string; model?: string }>(template: T): T {
  const engine = String(template.engine ?? "").trim() as AgentEngine;
  const preferred = getPreferredProviderModel(engine);
  if (!preferred) return template;
  return {
    ...template,
    model: preferred,
  };
}
