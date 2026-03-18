import type { SettingsRepo } from "../db/settings.repo.js";
import type { LocalModelInfo } from "./ollama.js";

export interface LocalModelCatalogEntry extends LocalModelInfo {
  allowed: boolean;
  downloaded: boolean;
  recommended: boolean;
  parameterBillions?: number;
}

interface StoredAllowlist {
  hasStored: boolean;
  models: string[];
}

const LOCAL_MODEL_ALLOWLIST_KEY_PREFIX = "local_model_allowlist_v1:";
const DEFAULT_OLLAMA_CATALOG = [
  "qwen2.5-coder:7b",
  "qwen2.5-coder:14b",
  "qwen2.5-coder:32b",
  "qwen2.5:7b",
  "qwen2.5:14b",
  "qwen2.5:32b",
  "llama3.2:3b",
  "llama3.2:latest",
  "deepseek-coder-v2:16b",
  "codellama:13b",
] as const;

function allowlistKey(runtime: string): string {
  return `${LOCAL_MODEL_ALLOWLIST_KEY_PREFIX}${runtime}`;
}

function normalizeModelName(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueSorted(names: string[]): string[] {
  return [...new Set(names.map((name) => normalizeModelName(name)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function parseStoredModelList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueSorted(parsed.map((value) => String(value ?? "")));
  } catch {
    return [];
  }
}

function parseModelSizeFromName(name: string): number | undefined {
  const match = name.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function estimateModelParams(name: string, sizeBytes?: number): number | undefined {
  const parsed = parseModelSizeFromName(name);
  if (parsed) return parsed;
  if (typeof sizeBytes === "number" && sizeBytes > 0) {
    const rough = sizeBytes / 1_000_000_000;
    if (Number.isFinite(rough) && rough > 0) {
      return Number(rough.toFixed(1));
    }
  }
  return undefined;
}

export function getStoredLocalModelAllowlist(
  settingsRepo: SettingsRepo,
  runtime: string,
): StoredAllowlist {
  const key = allowlistKey(runtime);
  const raw = settingsRepo.get(key);
  if (raw === null) {
    return {
      hasStored: false,
      models: [],
    };
  }
  return {
    hasStored: true,
    models: parseStoredModelList(raw),
  };
}

export function setStoredLocalModelAllowlist(
  settingsRepo: SettingsRepo,
  runtime: string,
  models: string[],
): string[] {
  const normalized = uniqueSorted(models);
  settingsRepo.set(allowlistKey(runtime), JSON.stringify(normalized));
  return normalized;
}

export function getEffectiveLocalModelAllowlist(
  settingsRepo: SettingsRepo,
  runtime: string,
  downloadedModels: LocalModelInfo[],
): string[] {
  const stored = getStoredLocalModelAllowlist(settingsRepo, runtime);
  if (stored.hasStored) return stored.models;
  // If no stored allowlist and no downloaded models (e.g., Ollama not running),
  // fall back to the default catalog so admins can still manage the allowlist.
  if (downloadedModels.length === 0) return [...DEFAULT_OLLAMA_CATALOG];
  return uniqueSorted(downloadedModels.map((model) => model.name));
}

export function isModelAllowedByStoredAllowlist(
  settingsRepo: SettingsRepo,
  runtime: string,
  model: string | undefined,
): boolean {
  const requested = normalizeModelName(model);
  if (!requested) return true;
  if (requested.toLowerCase() === "auto") return true;

  const stored = getStoredLocalModelAllowlist(settingsRepo, runtime);
  if (!stored.hasStored) return true;
  return stored.models.includes(requested);
}

export function buildLocalModelCatalog(
  downloadedModels: LocalModelInfo[],
  allowedModels: string[],
): LocalModelCatalogEntry[] {
  const downloadedByName = new Map<string, LocalModelInfo>();
  for (const model of downloadedModels) {
    downloadedByName.set(model.name, model);
  }

  const names = uniqueSorted([
    ...DEFAULT_OLLAMA_CATALOG,
    ...allowedModels,
    ...downloadedModels.map((model) => model.name),
  ]);
  const allowedSet = new Set(uniqueSorted(allowedModels));
  const recommendedSet = new Set(DEFAULT_OLLAMA_CATALOG.map((name) => name.toLowerCase()));

  return names.map((name) => {
    const downloaded = downloadedByName.get(name);
    const sizeBytes = downloaded?.sizeBytes;
    return {
      name,
      sizeBytes,
      modifiedAt: downloaded?.modifiedAt,
      digest: downloaded?.digest,
      allowed: allowedSet.has(name),
      downloaded: !!downloaded,
      recommended: recommendedSet.has(name.toLowerCase()),
      parameterBillions: estimateModelParams(name, sizeBytes),
    };
  });
}
