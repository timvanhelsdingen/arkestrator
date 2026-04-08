import type {
  ApiBridgeAction,
  ApiBridgeConfig,
  ApiBridgeResult,
} from "@arkestrator/protocol";
import type { ApiBridgeExecContext, ApiBridgeHandler } from "./handler.js";
import { buildAuthHeaders, buildUrl, sleep } from "./handler.js";

/**
 * Substitute {{variable}} placeholders in a string with values from a params map.
 */
function substituteTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = params[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

/**
 * Deep-substitute {{variable}} placeholders in an object/array structure.
 */
function substituteObject(obj: unknown, params: Record<string, unknown>): unknown {
  if (typeof obj === "string") return substituteTemplate(obj, params);
  if (Array.isArray(obj)) return obj.map((item) => substituteObject(item, params));
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteObject(value, params);
    }
    return result;
  }
  return obj;
}

/**
 * Generic handler for custom API bridges.
 * Reads endpoint templates from the bridge config, substitutes placeholders,
 * makes HTTP requests, and optionally polls for async completion.
 */
export class CustomApiBridgeHandler implements ApiBridgeHandler {
  readonly presetId = "custom";
  readonly displayName = "Custom API";
  readonly defaultBaseUrl = "";

  getActions(): ApiBridgeAction[] {
    // Custom bridges define actions implicitly via their endpoint names
    return [];
  }

  async execute(
    config: ApiBridgeConfig,
    apiKey: string,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const endpoint = config.endpoints[action];
    if (!endpoint) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: `Unknown action "${action}". Available: ${Object.keys(config.endpoints).join(", ")}`,
      };
    }

    const headers = buildAuthHeaders(config, apiKey);
    if (endpoint.headers) {
      Object.assign(headers, endpoint.headers);
    }

    const path = substituteTemplate(endpoint.path, params);
    const url = buildUrl(config, path, apiKey);

    context.onLog?.(`${endpoint.method} ${url}`);
    context.onProgress?.(null, `Calling ${action}...`);

    try {
      const fetchOpts: RequestInit = {
        method: endpoint.method,
        headers,
        signal: context.signal,
      };

      if (endpoint.bodyTemplate && !["GET", "DELETE"].includes(endpoint.method)) {
        const body = substituteObject(endpoint.bodyTemplate, params);
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOpts);
      const responseData = await response.json().catch(() => null);

      if (!response.ok) {
        return {
          bridgeName: config.name,
          action,
          success: false,
          error: `HTTP ${response.status}: ${JSON.stringify(responseData)}`,
          data: responseData,
        };
      }

      // If polling is configured, enter the poll loop
      if (config.pollConfig) {
        return this.pollForCompletion(config, apiKey, action, responseData, context);
      }

      return {
        bridgeName: config.name,
        action,
        success: true,
        data: responseData,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return {
          bridgeName: config.name,
          action,
          success: false,
          error: "Request cancelled",
        };
      }
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: err.message ?? String(err),
      };
    }
  }

  private async pollForCompletion(
    config: ApiBridgeConfig,
    apiKey: string,
    action: string,
    submitResponse: unknown,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const poll = config.pollConfig!;
    const statusEndpoint = config.endpoints[poll.statusEndpoint];
    if (!statusEndpoint) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: `Poll status endpoint "${poll.statusEndpoint}" not found in endpoints`,
      };
    }

    // Extract the external task ID from the submit response
    const taskId = getNestedField(submitResponse, poll.taskIdField);
    if (!taskId) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: `Could not find task ID field "${poll.taskIdField}" in submit response`,
        data: submitResponse,
      };
    }

    const headers = buildAuthHeaders(config, apiKey);
    const startTime = Date.now();

    context.onLog?.(`Polling for completion (task: ${taskId})...`);

    while (Date.now() - startTime < poll.maxTimeMs) {
      await sleep(poll.intervalMs, context.signal);

      const path = substituteTemplate(statusEndpoint.path, { taskId: String(taskId), ...config.defaultOptions });
      const url = buildUrl(config, path, apiKey);

      const response = await fetch(url, { headers, signal: context.signal });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        context.onLog?.(`Poll error: HTTP ${response.status}`);
        continue;
      }

      const status = String(getNestedField(data, poll.statusField) ?? "");
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      context.onProgress?.(null, `Status: ${status} (${elapsed}s)`);
      context.onLog?.(`Poll: status=${status} (${elapsed}s)`);

      if (poll.completedValues.includes(status)) {
        return {
          bridgeName: config.name,
          action,
          success: true,
          data,
          externalTaskId: String(taskId),
          externalStatus: status,
        };
      }

      if (poll.failedValues.includes(status)) {
        return {
          bridgeName: config.name,
          action,
          success: false,
          data,
          externalTaskId: String(taskId),
          externalStatus: status,
          error: `External task failed with status: ${status}`,
        };
      }
    }

    return {
      bridgeName: config.name,
      action,
      success: false,
      externalTaskId: String(taskId),
      error: `Polling timed out after ${poll.maxTimeMs}ms`,
    };
  }
}

/** Get a nested field from an object using dot notation (e.g. "result.id"). */
function getNestedField(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
