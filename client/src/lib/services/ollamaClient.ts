/**
 * Thin wrapper around the Ollama HTTP API for local model inference.
 *
 * The client calls localhost Ollama directly — no need for the `ollama` CLI
 * binary to be in PATH. Works out of the box as long as the Ollama service
 * is running on the default port.
 */

/** Default Ollama API base URL. Used as fallback when no setting is configured. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface OllamaGenerateOptions {
  model: string;
  prompt: string;
  /** Base URL for Ollama API. Defaults to http://127.0.0.1:11434 */
  baseUrl?: string;
  /** Timeout in milliseconds for the HTTP request. */
  timeoutMs?: number;
}

export interface OllamaGenerateResult {
  response: string;
  error?: string;
  timedOut?: boolean;
}

/**
 * Call Ollama's /api/generate endpoint (non-streaming).
 * Returns the model's response text, or an error.
 */
export async function ollamaGenerate(options: OllamaGenerateOptions): Promise<OllamaGenerateResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/api/generate`;

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  if (options.timeoutMs && options.timeoutMs > 0) {
    timerId = setTimeout(() => controller.abort(), options.timeoutMs);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { response: "", error: `Ollama HTTP ${res.status}: ${body}`.trim() };
    }

    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) {
      return { response: "", error: data.error };
    }
    return { response: data.response ?? "" };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { response: "", timedOut: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { response: "", error: `Ollama request failed: ${msg}` };
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

// ---------------------------------------------------------------------------
// Native tool calling via /api/chat
// ---------------------------------------------------------------------------

export interface OllamaChatWithToolsOptions {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  }>;
  tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface OllamaChatWithToolsResult {
  message?: {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  error?: string;
  timedOut?: boolean;
}

/**
 * Call Ollama's /api/chat with native tool calling (non-streaming).
 * Returns the assistant's response which may contain tool_calls.
 */
export async function ollamaChatWithTools(
  options: OllamaChatWithToolsOptions,
): Promise<OllamaChatWithToolsResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/api/chat`;

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timerId = setTimeout(() => controller.abort(), options.timeoutMs);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        // Omit tools key entirely when empty — avoids triggering Ollama's
        // broken tool serialization for thinking models (qwen3, etc.)
        ...(options.tools?.length ? { tools: options.tools } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `Ollama HTTP ${res.status}: ${body}`.trim() };
    }

    const data = (await res.json()) as any;
    if (data.error) return { error: data.error };

    const msg = data.message;
    if (!msg) return { error: "No message in Ollama response" };

    // Normalize tool_calls arguments
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (typeof tc.function?.arguments === "string") {
          try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch { tc.function.arguments = {}; }
        }
      }
    }

    return { message: msg };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { timedOut: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Ollama chat request failed: ${msg}` };
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

/**
 * Quick health check — pings the Ollama API root.
 * Returns true if Ollama is reachable.
 */
export async function ollamaHealthCheck(baseUrl?: string): Promise<boolean> {
  const url = ((baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, ""));
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
