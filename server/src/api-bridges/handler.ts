import type {
  ApiBridgeAction,
  ApiBridgeConfig,
  ApiBridgeResult,
} from "@arkestrator/protocol";

/**
 * Context provided to handlers during execution.
 * Allows progress reporting, logging, and cancellation.
 */
export interface ApiBridgeExecContext {
  /** Report progress (percent 0-100 or null for indeterminate, plus status text). */
  onProgress?: (percent: number | null, statusText: string) => void;
  /** Log a message (forwarded to job logs). */
  onLog?: (text: string) => void;
  /** Abort signal for cancellation support. */
  signal?: AbortSignal;
}

/**
 * Interface that all API bridge handlers must implement.
 * Preset handlers (Meshy, Stability, etc.) are TypeScript classes.
 * Custom bridges use the generic CustomApiBridgeHandler.
 */
export interface ApiBridgeHandler {
  /** Unique preset identifier (e.g. "meshy", "stability"). */
  readonly presetId: string;
  /** Human-readable name for the preset. */
  readonly displayName: string;
  /** Default base URL for the API. */
  readonly defaultBaseUrl: string;
  /** List of actions this handler supports with parameter schemas. */
  getActions(): ApiBridgeAction[];
  /** Execute an action against the API. */
  execute(
    config: ApiBridgeConfig,
    apiKey: string,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult>;
}

/**
 * Helper to make an authenticated HTTP request to an API bridge.
 */
export function buildAuthHeaders(
  config: ApiBridgeConfig,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (config.authType) {
    case "bearer":
      headers[config.authHeader] = `${config.authPrefix}${apiKey}`;
      break;
    case "header":
      headers[config.authHeader] = apiKey;
      break;
    case "query":
      // Query param auth is handled at the URL level, not headers
      break;
    case "none":
      break;
  }

  return headers;
}

/**
 * Helper to append API key as query parameter (for authType="query").
 */
export function buildUrl(
  config: ApiBridgeConfig,
  path: string,
  apiKey?: string,
): string {
  const base = (config.baseUrl ?? "").replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  if (config.authType === "query" && apiKey) {
    url.searchParams.set("api_key", apiKey);
  }
  return url.toString();
}

/**
 * Sleep utility for polling loops, respects abort signals.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
