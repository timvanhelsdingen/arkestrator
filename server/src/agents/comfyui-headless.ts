import type { CommandResult } from "@arkestrator/protocol";

export interface ComfyUiArtifact {
  nodeId: string;
  kind: "image" | "video" | "gif" | "audio" | "file";
  filename: string;
  subfolder?: string;
  type?: string;
  mimeType?: string;
  sizeBytes?: number;
  base64?: string;
}

export interface ComfyUiHeadlessResult {
  success: boolean;
  executed: number;
  failed: number;
  skipped: number;
  errors: string[];
  outputs?: ComfyUiArtifact[];
  stdout?: string;
  program: "comfyui";
  headless: true;
}

type ComfyHistoryEntry = {
  outputs?: Record<string, Record<string, any>>;
  status?: {
    completed?: boolean;
    status_str?: string;
  };
};

type ComfyHistoryResponse = Record<string, ComfyHistoryEntry>;

type ExecuteOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxInlineArtifactBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 800;
const DEFAULT_MAX_INLINE_ARTIFACT_BYTES = 512_000;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinary(
  url: string,
  timeoutMs = 30_000,
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    const mimeType = res.headers.get("content-type") ?? undefined;
    const buffer = new Uint8Array(await res.arrayBuffer());
    return { bytes: buffer, mimeType };
  } finally {
    clearTimeout(timeout);
  }
}

function buildViewUrl(baseUrl: string, filename: string, subfolder?: string, type?: string): string {
  const params = new URLSearchParams();
  params.set("filename", filename);
  params.set("type", type || "output");
  if (subfolder) params.set("subfolder", subfolder);
  return `${baseUrl}/view?${params.toString()}`;
}

async function pollHistoryEntry(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ComfyHistoryEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`) as ComfyHistoryResponse;
    const entry = history?.[promptId];
    if (entry) {
      const completed = !!entry.status?.completed || entry.status?.status_str === "success";
      const hasOutputs = !!entry.outputs && Object.keys(entry.outputs).length > 0;
      if (completed || hasOutputs) return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Workflow ${promptId} timed out after ${timeoutMs}ms`);
}

function normalizeCommandLanguage(language: string): string {
  return String(language || "").trim().toLowerCase();
}

function inferArtifactKind(
  filename: string,
  hintedKind: ComfyUiArtifact["kind"],
  mimeType?: string,
): ComfyUiArtifact["kind"] {
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("video/")) return "video";
  if (lowerMime.startsWith("audio/")) return "audio";

  const lowerName = String(filename || "").toLowerCase();
  if (/\.(png|jpe?g|webp|bmp|tiff?|exr)$/i.test(lowerName)) return "image";
  if (/\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(lowerName)) return "video";
  if (/\.(gif)$/i.test(lowerName)) return "gif";
  if (/\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(lowerName)) return "audio";
  return hintedKind;
}

function collectNodeArtifacts(nodeOutput: Record<string, any>): Array<{ kind: ComfyUiArtifact["kind"]; info: any }> {
  const out: Array<{ kind: ComfyUiArtifact["kind"]; info: any }> = [];
  const pairs: Array<{ key: string; kind: ComfyUiArtifact["kind"] }> = [
    { key: "images", kind: "image" },
    { key: "gifs", kind: "gif" },
    { key: "videos", kind: "video" },
    { key: "audio", kind: "audio" },
    { key: "files", kind: "file" },
  ];
  for (const { key, kind } of pairs) {
    const arr = nodeOutput?.[key];
    if (!Array.isArray(arr)) continue;
    for (const info of arr) out.push({ kind, info });
  }
  return out;
}

export async function executeComfyUiHeadless(
  commands: CommandResult[],
  comfyUiUrl: string,
  options?: ExecuteOptions,
): Promise<ComfyUiHeadlessResult> {
  const baseUrl = String(comfyUiUrl || "").trim().replace(/\/+$/, "") || "http://127.0.0.1:8188";
  const timeoutMs = Math.max(5_000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const maxInlineArtifactBytes = Math.max(0, options?.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES);

  let executed = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const outputs: ComfyUiArtifact[] = [];
  const summaryLines: string[] = [];

  for (const command of commands ?? []) {
    const language = normalizeCommandLanguage(command?.language);
    const script = String(command?.script ?? "");
    const description = String(command?.description ?? "workflow").trim() || "workflow";

    if (!script.trim()) {
      skipped += 1;
      summaryLines.push(`Skipped empty command: ${description}`);
      continue;
    }
    if (language !== "workflow" && language !== "comfyui") {
      skipped += 1;
      errors.push(`Unsupported ComfyUI command language: ${language || "(empty)"}`);
      continue;
    }

    let workflow: Record<string, any>;
    try {
      workflow = JSON.parse(script);
      if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
        throw new Error("workflow JSON must be an object");
      }
    } catch (err: any) {
      failed += 1;
      errors.push(`Invalid workflow JSON (${description}): ${err?.message ?? err}`);
      continue;
    }

    try {
      const submit = await fetchJson(
        `${baseUrl}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: workflow,
            client_id: `arkestrator-${Math.random().toString(16).slice(2)}`,
          }),
        },
        Math.min(timeoutMs, 30_000),
      );

      const promptId = String(submit?.prompt_id ?? "").trim();
      if (!promptId) throw new Error("ComfyUI returned no prompt_id");

      const entry = await pollHistoryEntry(baseUrl, promptId, timeoutMs, pollIntervalMs);
      const nodeOutputs = entry.outputs ?? {};
      let commandArtifacts = 0;

      for (const [nodeId, nodeOutput] of Object.entries(nodeOutputs)) {
        for (const artifact of collectNodeArtifacts(nodeOutput as Record<string, any>)) {
          const filename = String(artifact.info?.filename ?? "").trim();
          if (!filename) continue;
          const subfolder = String(artifact.info?.subfolder ?? "").trim() || undefined;
          const type = String(artifact.info?.type ?? "").trim() || undefined;
          const viewUrl = buildViewUrl(baseUrl, filename, subfolder, type);

          let sizeBytes: number | undefined;
          let mimeType: string | undefined;
          let base64: string | undefined;
          try {
            const fetched = await fetchBinary(viewUrl, Math.min(timeoutMs, 30_000));
            sizeBytes = fetched.bytes.byteLength;
            mimeType = fetched.mimeType;
            if (sizeBytes <= maxInlineArtifactBytes) {
              base64 = Buffer.from(fetched.bytes).toString("base64");
            }
          } catch (err: any) {
            errors.push(`Artifact fetch failed (${filename}): ${err?.message ?? err}`);
          }

          outputs.push({
            nodeId,
            kind: inferArtifactKind(filename, artifact.kind, mimeType),
            filename,
            subfolder,
            type,
            mimeType,
            sizeBytes,
            base64,
          });
          commandArtifacts += 1;
        }
      }

      executed += 1;
      summaryLines.push(
        `ComfyUI workflow '${description}' executed (prompt_id=${promptId}, artifacts=${commandArtifacts})`,
      );
    } catch (err: any) {
      failed += 1;
      errors.push(`ComfyUI workflow failed (${description}): ${err?.message ?? err}`);
    }
  }

  return {
    success: failed === 0,
    executed,
    failed,
    skipped,
    errors,
    outputs: outputs.length > 0 ? outputs : undefined,
    stdout: summaryLines.join("\n") || undefined,
    program: "comfyui",
    headless: true,
  };
}
