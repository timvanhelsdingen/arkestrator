import type { SettingsRepo } from "../db/settings.repo.js";

export interface LocalModelInfo {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
}

export interface PullModelResult {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface PullModelProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

const OLLAMA_LIST_TIMEOUT_MS = 8_000;
/** Default Ollama API base URL. Used as fallback when no env/setting is configured. */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const OLLAMA_PULL_TIMEOUT_MS = 20_000;
const OLLAMA_CHAT_CONNECT_TIMEOUT_MS = 15_000;

function normalizeOllamaBaseUrl(raw?: string): string {
  const fallback = DEFAULT_OLLAMA_BASE_URL;
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  return value.replace(/\/+$/, "");
}

export const SERVER_LOCAL_LLM_BASE_URL_SETTINGS_KEY = "server_local_llm_base_url";

function parseErrorBody(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // noop
  }
  return text.trim();
}

function toLocalModelInfo(input: unknown): LocalModelInfo | null {
  const row = input as Record<string, unknown> | null;
  if (!row) return null;
  const name = String(row.name ?? "").trim();
  if (!name) return null;
  const sizeRaw = row.size;
  const modifiedRaw = row.modified_at;
  const digestRaw = row.digest;

  return {
    name,
    sizeBytes: typeof sizeRaw === "number" ? sizeRaw : undefined,
    modifiedAt: typeof modifiedRaw === "string" ? modifiedRaw : undefined,
    digest: typeof digestRaw === "string" ? digestRaw : undefined,
  };
}

export function getOllamaBaseUrl(): string {
  return normalizeOllamaBaseUrl(process.env.OLLAMA_BASE_URL);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && "name" in err && (err as any).name === "AbortError";
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function getConfiguredOllamaBaseUrl(settingsRepo?: SettingsRepo | null): string {
  const stored = String(settingsRepo?.get(SERVER_LOCAL_LLM_BASE_URL_SETTINGS_KEY) ?? "").trim();
  if (stored) return normalizeOllamaBaseUrl(stored);
  return getOllamaBaseUrl();
}

export async function listOllamaModels(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = getOllamaBaseUrl(),
): Promise<LocalModelInfo[]> {
  const res = await fetchWithTimeout(
    fetchImpl,
    `${normalizeOllamaBaseUrl(baseUrl)}/api/tags`,
    {},
    OLLAMA_LIST_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = parseErrorBody(await res.text());
    throw new Error(
      detail
        ? `Failed to list models from Ollama (${res.status}): ${detail}`
        : `Failed to list models from Ollama (${res.status})`,
    );
  }

  const payload = await res.json().catch(() => ({}));
  const rows = Array.isArray((payload as Record<string, unknown>).models)
    ? ((payload as Record<string, unknown>).models as unknown[])
    : [];

  return rows
    .map((row) => toLocalModelInfo(row))
    .filter((row): row is LocalModelInfo => !!row);
}

export async function pullOllamaModel(
  model: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = getOllamaBaseUrl(),
): Promise<PullModelResult> {
  const trimmed = model.trim();
  if (!trimmed) throw new Error("Model name is required");

  const res = await fetchWithTimeout(
    fetchImpl,
    `${normalizeOllamaBaseUrl(baseUrl)}/api/pull`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: trimmed,
        stream: false,
      }),
    },
    OLLAMA_PULL_TIMEOUT_MS,
  );

  if (!res.ok) {
    const detail = parseErrorBody(await res.text());
    throw new Error(
      detail
        ? `Failed to pull model from Ollama (${res.status}): ${detail}`
        : `Failed to pull model from Ollama (${res.status})`,
    );
  }

  const payload = await res.json().catch(() => ({}));
  const out = payload as Record<string, unknown>;
  return {
    status: typeof out.status === "string" ? out.status : undefined,
    digest: typeof out.digest === "string" ? out.digest : undefined,
    total: typeof out.total === "number" ? out.total : undefined,
    completed: typeof out.completed === "number" ? out.completed : undefined,
  };
}

function toPullProgress(payload: unknown): PullModelProgress {
  const out = (payload ?? {}) as Record<string, unknown>;
  return {
    status: typeof out.status === "string" ? out.status : undefined,
    digest: typeof out.digest === "string" ? out.digest : undefined,
    total: typeof out.total === "number" ? out.total : undefined,
    completed: typeof out.completed === "number" ? out.completed : undefined,
  };
}

export async function streamPullOllamaModel(
  model: string,
  onProgress: (event: PullModelProgress) => void | Promise<void>,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = getOllamaBaseUrl(),
): Promise<PullModelProgress | null> {
  const trimmed = model.trim();
  if (!trimmed) throw new Error("Model name is required");

  const res = await fetchWithTimeout(
    fetchImpl,
    `${normalizeOllamaBaseUrl(baseUrl)}/api/pull`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: trimmed,
        stream: true,
      }),
    },
    OLLAMA_PULL_TIMEOUT_MS,
  );

  if (!res.ok) {
    const detail = parseErrorBody(await res.text());
    throw new Error(
      detail
        ? `Failed to pull model from Ollama (${res.status}): ${detail}`
        : `Failed to pull model from Ollama (${res.status})`,
    );
  }

  if (!res.body) {
    throw new Error("Ollama pull stream did not return a response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEvent: PullModelProgress | null = null;

  async function emit(line: string) {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      const event = toPullProgress(parsed);
      lastEvent = event;
      await onProgress(event);
    } catch {
      // Ignore malformed stream fragments.
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      await emit(line);
      nl = buffer.indexOf("\n");
    }
  }

  if (buffer.trim()) {
    await emit(buffer.trim());
  }

  return lastEvent;
}

// ---------------------------------------------------------------------------
// Ollama chat streaming via HTTP API
// ---------------------------------------------------------------------------

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * Stream a chat completion from a remote Ollama instance via its HTTP API.
 *
 * This is used when the server can't run the `ollama` CLI directly (e.g.
 * running inside Docker) but can reach the worker's Ollama endpoint over
 * the network.
 *
 * Calls `POST {baseUrl}/api/chat` with streaming enabled.
 * Yields text chunks as they arrive.
 */
export async function* streamOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const url = `${normalizeOllamaBaseUrl(baseUrl)}/api/chat`;

  const controller = new AbortController();
  const connectTimeout = setTimeout(
    () => controller.abort(),
    OLLAMA_CHAT_CONNECT_TIMEOUT_MS,
  );

  // Chain caller's abort signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(connectTimeout);
    if (isAbortError(err)) {
      throw new Error(
        `Ollama chat connection timed out after ${OLLAMA_CHAT_CONNECT_TIMEOUT_MS}ms (${url})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(connectTimeout);
  }

  if (!res.ok) {
    const detail = parseErrorBody(await res.text());
    throw new Error(
      detail
        ? `Ollama chat error (${res.status}): ${detail}`
        : `Ollama chat error (${res.status})`,
    );
  }

  if (!res.body) {
    throw new Error("Ollama chat stream did not return a response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            const content = parsed?.message?.content;
            if (content) {
              yield content;
            }
          } catch {
            // Ignore malformed JSON fragments
          }
        }
        nl = buffer.indexOf("\n");
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim()) as {
          message?: { content?: string };
          done?: boolean;
        };
        const content = parsed?.message?.content;
        if (content) {
          yield content;
        }
      } catch {
        // Ignore
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released
    }
  }
}

// ---------------------------------------------------------------------------
// Non-streaming chat with native tool calling
// ---------------------------------------------------------------------------

export interface OllamaChatWithToolsOptions {
  baseUrl: string;
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  }>;
  /** Explicit thinking mode control. true = enable reasoning, false = disable, undefined = auto. */
  think?: boolean;
  tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  timeoutMs: number;
}

export interface OllamaChatWithToolsResult {
  message?: OllamaChatMessage;
  error?: string;
  timedOut?: boolean;
}

/**
 * Call Ollama `/api/chat` with native tool calling support (non-streaming).
 * Returns the assistant's response which may contain `tool_calls`.
 */
export async function ollamaChatWithTools(
  options: OllamaChatWithToolsOptions,
): Promise<OllamaChatWithToolsResult> {
  const url = `${normalizeOllamaBaseUrl(options.baseUrl)}/api/chat`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const hasTools = !!options.tools?.length;
    // think param: explicit value from caller, or auto (false when tools active)
    const thinkValue = options.think !== undefined ? options.think : (hasTools ? false : undefined);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        // Omit tools key entirely when empty — avoids triggering Ollama's
        // broken tool serialization for thinking models (qwen3, etc.)
        ...(hasTools ? { tools: options.tools } : {}),
        stream: false,
        ...(thinkValue !== undefined ? { think: thinkValue } : {}),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `Ollama returned ${res.status}: ${text.slice(0, 500)}` };
    }

    const data = await res.json() as any;
    if (data.error) {
      return { error: `Ollama error: ${data.error}` };
    }

    const msg = data.message;
    if (!msg) {
      return { error: "No message in Ollama response" };
    }

    // Normalize tool_calls arguments — Ollama may return string or object
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (typeof tc.function?.arguments === "string") {
          try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch { tc.function.arguments = {}; }
        }
      }
    }

    return { message: msg };
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError" || controller.signal.aborted) {
      return { timedOut: true };
    }
    return { error: `Ollama chat request failed: ${err?.message ?? err}` };
  }
}
