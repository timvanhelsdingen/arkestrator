import type { SettingsRepo } from "../db/settings.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import { getWorkerRule, listWorkerRules } from "../security/worker-rules.js";
import { listOllamaModels } from "./ollama.js";

export interface WorkerLocalLlmResolution {
  workerName: string;
  enabled: boolean;
  baseUrl: string | null;
  source: "rule" | "worker-ip" | "none";
  workerIp: string | null;
  reason?: string;
}

export interface WorkerLocalLlmHealth {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  modelCount: number;
  models: string[];
  error?: string;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function resolveFromWorkerIp(ip: string | undefined | null): string | null {
  const candidate = String(ip ?? "").trim();
  if (!candidate) return null;
  // Keep default Ollama port unless explicitly configured in worker rule.
  if (candidate.includes(":")) {
    // Likely IPv6 or host:port. Use as-is and let URL parser/fetch validate.
    return normalizeBaseUrl(candidate);
  }
  return `http://${candidate}:11434`;
}

export function resolveWorkerLocalLlmEndpoint(
  settingsRepo: SettingsRepo,
  workersRepo: WorkersRepo,
  workerNameRaw: string,
): WorkerLocalLlmResolution {
  const workerName = String(workerNameRaw ?? "").trim().toLowerCase();
  if (!workerName) {
    return {
      workerName: "",
      enabled: false,
      baseUrl: null,
      source: "none",
      workerIp: null,
      reason: "Missing worker name",
    };
  }
  const rule = getWorkerRule(settingsRepo, workerName);
  const worker = workersRepo.getByName(workerName);
  const workerIp = String(worker?.lastIp ?? "").trim() || null;
  if (!rule.localLlmEnabled) {
    return {
      workerName,
      enabled: false,
      baseUrl: null,
      source: "none",
      workerIp,
      reason: "Worker local LLM is disabled in worker rules",
    };
  }

  const fromRule = normalizeBaseUrl(rule.localLlmBaseUrl);
  if (fromRule) {
    return {
      workerName,
      enabled: true,
      baseUrl: fromRule,
      source: "rule",
      workerIp,
    };
  }

  const fromIp = resolveFromWorkerIp(workerIp);
  if (fromIp) {
    return {
      workerName,
      enabled: true,
      baseUrl: fromIp,
      source: "worker-ip",
      workerIp,
    };
  }

  return {
    workerName,
    enabled: true,
    baseUrl: null,
    source: "none",
    workerIp,
    reason: "No local LLM base URL configured and worker has no known IP",
  };
}

export async function checkWorkerLocalLlmHealth(
  baseUrl: string,
  timeoutMs = 4_000,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerLocalLlmHealth> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(300, timeoutMs));
  const startedAt = Date.now();
  try {
    const models = await listOllamaModels(
      ((input: any, init: any) => fetchImpl(input, { ...init, signal: controller.signal })) as typeof fetch,
      normalizedBaseUrl,
    );
    return {
      ok: true,
      baseUrl: normalizedBaseUrl,
      latencyMs: Date.now() - startedAt,
      modelCount: models.length,
      models: models.map((model) => model.name).slice(0, 128),
    };
  } catch (err: any) {
    return {
      ok: false,
      baseUrl: normalizedBaseUrl,
      latencyMs: Date.now() - startedAt,
      modelCount: 0,
      models: [],
      error: String(err?.message ?? err ?? "Unknown local LLM error"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Find any online worker that has `localLlmEnabled` and a reachable Ollama.
 * If `preferWorkerName` is given, that worker is tried first.
 * Returns the first healthy resolution, or `null` if none found.
 *
 * When `skipHealthCheck` is true, returns the first enabled worker without
 * verifying server-side Ollama reachability.  This is used for client-dispatch
 * where the Tauri client talks to its own localhost Ollama — the server
 * doesn't need to reach the worker's Ollama endpoint.
 */
export async function resolveAnyAvailableWorkerLlm(
  settingsRepo: SettingsRepo,
  workersRepo: WorkersRepo,
  hub: WebSocketHub,
  preferWorkerName?: string,
  skipHealthCheck?: boolean,
): Promise<WorkerLocalLlmResolution | null> {
  // Collect unique worker names from connected sockets (bridges + clients)
  const connectedWorkers = new Set<string>();
  for (const ws of hub.getAll()) {
    const name = String(ws.workerName ?? "").trim().toLowerCase();
    if (name) connectedWorkers.add(name);
  }

  // Get all worker rules with localLlmEnabled
  const allRules = listWorkerRules(settingsRepo);
  console.log(`[resolveAnyAvailableWorkerLlm] connectedWorkers=[${[...connectedWorkers].join(",")}] rules=${JSON.stringify(allRules.map(r => ({ name: r.workerName, llm: r.localLlmEnabled })))}`);
  const candidates = allRules
    .filter((r) => r.localLlmEnabled && connectedWorkers.has(r.workerName.toLowerCase()))
    .map((r) => r.workerName);
  console.log(`[resolveAnyAvailableWorkerLlm] candidates=[${candidates.join(",")}] skipHealthCheck=${skipHealthCheck}`);

  // If a preferred worker was given and is in the candidates, try it first
  if (preferWorkerName) {
    const preferred = preferWorkerName.trim().toLowerCase();
    const idx = candidates.findIndex((c) => c.toLowerCase() === preferred);
    if (idx > 0) {
      candidates.unshift(candidates.splice(idx, 1)[0]);
    }
  }

  for (const workerName of candidates) {
    const resolution = resolveWorkerLocalLlmEndpoint(settingsRepo, workersRepo, workerName);
    if (!resolution.enabled) continue;

    // When skipHealthCheck is true (client-dispatch), baseUrl is optional —
    // the Tauri client runs Ollama locally and doesn't need server-reachable URL.
    if (skipHealthCheck) return resolution;

    if (!resolution.baseUrl) continue;

    // Quick health check
    const health = await checkWorkerLocalLlmHealth(resolution.baseUrl, 3_000);
    if (health.ok) return resolution;
  }

  return null;
}
