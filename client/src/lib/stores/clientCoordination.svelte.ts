import { invoke } from "@tauri-apps/api/core";

export interface LocalDesktopOllamaModel {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
}

export interface LocalDesktopOllamaModelsResult {
  reachable: boolean;
  models: LocalDesktopOllamaModel[];
}

export interface LocalAiCapabilityReport {
  checkedAt: string;
  cpuCores: number | null;
  memoryGb: number | null;
  gpuRenderer: string | null;
  ollamaReachable: boolean;
  localModelCount: number;
  capable: boolean;
  reasons: string[];
  probeFingerprint?: string;
}

const STORAGE_KEY = "arkestrator-client-coordination-capability";
const OLLAMA_URL_KEY = "arkestrator-client-ollama-url";
const CHAT_MODEL_KEY = "arkestrator-default-chat-model";
const JOB_MODEL_KEY = "arkestrator-default-job-model";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_PROBE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function buildProbeFingerprint(): string {
  if (typeof navigator === "undefined") return "server";
  return [
    String(navigator.userAgent ?? ""),
    String((navigator as any).platform ?? ""),
    String(navigator.hardwareConcurrency ?? ""),
  ].join("|");
}

function loadSavedCapability(): LocalAiCapabilityReport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalAiCapabilityReport;
    const expected = buildProbeFingerprint();
    if (parsed?.probeFingerprint && parsed.probeFingerprint !== expected) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCapability(report: LocalAiCapabilityReport): void {
  try {
    const payload = JSON.stringify(report);
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // best effort
  }
}

function detectGpuRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return null;

    const debugInfo = (gl as any).getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      const renderer = (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (renderer && typeof renderer === "string") return renderer;
    }
    const fallback = (gl as any).getParameter((gl as any).RENDERER);
    return typeof fallback === "string" ? fallback : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLocalOllamaModels(raw: unknown): LocalDesktopOllamaModel[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: LocalDesktopOllamaModel[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    const obj = entry as Record<string, unknown>;
    const name = String(obj?.name ?? obj?.model ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const sizeRaw = obj?.sizeBytes ?? obj?.size_bytes ?? obj?.size;
    const sizeBytes = typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw > 0
      ? sizeRaw
      : undefined;
    const modifiedRaw = String(obj?.modifiedAt ?? obj?.modified_at ?? "").trim();
    const modifiedAt = modifiedRaw || undefined;
    const digestRaw = String(obj?.digest ?? "").trim();
    const digest = digestRaw || undefined;

    out.push({ name, sizeBytes, modifiedAt, digest });
  }

  return out;
}

async function probeLocalOllamaModels(baseUrl: string = DEFAULT_OLLAMA_URL): Promise<LocalDesktopOllamaModelsResult> {
  let httpResult: LocalDesktopOllamaModelsResult | null = null;
  try {
    const res = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/api/tags`, 2500);
    if (res.ok) {
      const payload = await res.json().catch(() => ({}));
      const models = normalizeLocalOllamaModels((payload as any)?.models);
      httpResult = { reachable: true, models };
      if (models.length > 0) return httpResult;
    }
  } catch {
    // Ignore and fall through to desktop command fallback.
  }

  try {
    const fallback = await invoke<{
      reachable?: boolean;
      models?: unknown[];
    }>("list_local_ollama_models");
    const models = normalizeLocalOllamaModels(fallback?.models);
    const reachable = !!fallback?.reachable || models.length > 0;
    if (reachable || models.length > 0) {
      return { reachable, models };
    }
  } catch {
    // No native Ollama runtime command available.
  }

  return httpResult ?? { reachable: false, models: [] };
}

type DesktopHardwareCapability = {
  cpuCores: number | null;
  memoryGb: number | null;
  gpuRenderer: string | null;
};

async function detectDesktopHardware(): Promise<DesktopHardwareCapability | null> {
  try {
    const result = await invoke<{
      cpuCores?: number | null;
      memoryGb?: number | null;
      gpuRenderer?: string | null;
    }>("get_local_hardware_capability");
    const cpuCores = typeof result?.cpuCores === "number" && Number.isFinite(result.cpuCores)
      ? Math.max(1, Math.round(result.cpuCores))
      : null;
    const memoryGb = typeof result?.memoryGb === "number" && Number.isFinite(result.memoryGb)
      ? Math.max(1, Math.round(result.memoryGb))
      : null;
    const gpuRenderer = typeof result?.gpuRenderer === "string" && result.gpuRenderer.trim().length > 0
      ? result.gpuRenderer.trim()
      : null;
    return { cpuCores, memoryGb, gpuRenderer };
  } catch {
    return null;
  }
}

class ClientCoordinationState {
  capability = $state<LocalAiCapabilityReport | null>(loadSavedCapability());
  probing = $state(false);
  lastError = $state("");
  ollamaBaseUrl = $state(localStorage.getItem(OLLAMA_URL_KEY) || DEFAULT_OLLAMA_URL);
  defaultChatModel = $state(localStorage.getItem(CHAT_MODEL_KEY) || "");
  defaultJobModel = $state(localStorage.getItem(JOB_MODEL_KEY) || "");

  get isCapable(): boolean {
    return this.capability?.capable ?? false;
  }

  get hasLocalModels(): boolean {
    return (this.capability?.localModelCount ?? 0) > 0;
  }

  setOllamaBaseUrl(url: string) {
    const trimmed = url.trim() || DEFAULT_OLLAMA_URL;
    this.ollamaBaseUrl = trimmed;
    try {
      if (trimmed === DEFAULT_OLLAMA_URL) {
        localStorage.removeItem(OLLAMA_URL_KEY);
      } else {
        localStorage.setItem(OLLAMA_URL_KEY, trimmed);
      }
    } catch { /* best effort */ }
  }

  setDefaultChatModel(model: string) {
    this.defaultChatModel = model;
    try {
      model ? localStorage.setItem(CHAT_MODEL_KEY, model) : localStorage.removeItem(CHAT_MODEL_KEY);
    } catch { /* best effort */ }
  }

  setDefaultJobModel(model: string) {
    this.defaultJobModel = model;
    try {
      model ? localStorage.setItem(JOB_MODEL_KEY, model) : localStorage.removeItem(JOB_MODEL_KEY);
    } catch { /* best effort */ }
  }

  async listLocalOllamaModels(): Promise<LocalDesktopOllamaModelsResult> {
    return probeLocalOllamaModels(this.ollamaBaseUrl);
  }

  isProbeStale(maxAgeMs: number = DEFAULT_PROBE_TTL_MS): boolean {
    if (!this.capability) return true;
    const checkedAt = Date.parse(this.capability.checkedAt);
    if (!Number.isFinite(checkedAt)) return true;
    return Date.now() - checkedAt > maxAgeMs;
  }

  async probe(): Promise<LocalAiCapabilityReport> {
    this.probing = true;
    this.lastError = "";
    try {
      const desktopHardware = await detectDesktopHardware();
      const browserCpuCores =
        typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
          ? navigator.hardwareConcurrency
          : null;
      const memoryRaw =
        typeof navigator !== "undefined" && typeof (navigator as any).deviceMemory === "number"
          ? Number((navigator as any).deviceMemory)
          : null;
      const browserMemoryGb = memoryRaw !== null && Number.isFinite(memoryRaw) ? memoryRaw : null;
      const browserGpuRenderer = typeof document !== "undefined" ? detectGpuRenderer() : null;
      const cpuCores = desktopHardware?.cpuCores ?? browserCpuCores ?? null;
      const memoryGb = desktopHardware?.memoryGb ?? browserMemoryGb ?? null;
      const gpuRenderer = desktopHardware?.gpuRenderer ?? browserGpuRenderer ?? null;
      const localOllama = await probeLocalOllamaModels(this.ollamaBaseUrl);
      const ollamaReachable = localOllama.reachable;
      const localModelCount = localOllama.models.length;

      const reasons: string[] = [];
      if (localModelCount === 0) reasons.push("No local Ollama models detected on this machine");
      if (cpuCores !== null && cpuCores < 8) reasons.push(`CPU cores below recommended minimum (detected ${cpuCores}, recommend 8+)`);
      if (memoryGb !== null && memoryGb < 8) reasons.push(`System memory below recommended minimum (detected ${memoryGb}GB, recommend 8GB+)`);

      const capable =
        localModelCount > 0
        && (cpuCores === null || cpuCores >= 8)
        && (memoryGb === null || memoryGb >= 8);

      const report: LocalAiCapabilityReport = {
        checkedAt: new Date().toISOString(),
        cpuCores,
        memoryGb,
        gpuRenderer,
        ollamaReachable,
        localModelCount,
        capable,
        reasons,
        probeFingerprint: buildProbeFingerprint(),
      };

      this.capability = report;
      saveCapability(report);
      return report;
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      throw err;
    } finally {
      this.probing = false;
    }
  }

  async probeIfStale(maxAgeMs: number = DEFAULT_PROBE_TTL_MS): Promise<void> {
    if (!this.isProbeStale(maxAgeMs) || this.probing) return;
    try {
      await this.probe();
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.probing = false;
    }
  }
}

export const clientCoordination = new ClientCoordinationState();
