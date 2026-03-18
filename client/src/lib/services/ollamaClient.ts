/**
 * Thin wrapper around the Ollama HTTP API for local model inference.
 *
 * The client calls localhost Ollama directly — no need for the `ollama` CLI
 * binary to be in PATH. Works out of the box as long as the Ollama service
 * is running on the default port.
 */

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

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
