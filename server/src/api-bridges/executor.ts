import type { Job, ApiBridgeResult } from "@arkestrator/protocol";
import type { ApiBridgesRepo } from "../db/api-bridges.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { ApiBridgeExecContext } from "./handler.js";
import { getPresetHandler } from "./registry.js";
import { CustomApiBridgeHandler } from "./custom-handler.js";
import { McpBridgeHandler } from "./mcp-handler.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

export interface ApiBridgeExecutorDeps {
  apiBridgesRepo: ApiBridgesRepo;
  jobsRepo: JobsRepo;
  hub: WebSocketHub;
}

// Per-bridge rate limiter: max 30 requests per 60s per bridge to prevent API abuse
const API_BRIDGE_RATE_WINDOW_MS = 60_000;
const API_BRIDGE_RATE_MAX = 30;
const bridgeRates = new Map<string, { count: number; resetAt: number }>();

function checkBridgeRateLimit(bridgeName: string): boolean {
  const now = Date.now();
  const entry = bridgeRates.get(bridgeName);
  if (!entry || now > entry.resetAt) {
    bridgeRates.set(bridgeName, { count: 1, resetAt: now + API_BRIDGE_RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= API_BRIDGE_RATE_MAX;
}

/**
 * Executes API bridge calls for task jobs (mode="task", executionType="api_call").
 * Runs entirely server-side — no WebSocket correlation needed.
 */
export class ApiBridgeExecutor {
  private running = new Map<string, AbortController>();

  constructor(private deps: ApiBridgeExecutorDeps) {}

  /** Number of in-flight API bridge jobs. */
  get count(): number {
    return this.running.size;
  }

  /**
   * Dispatch a task job to an API bridge.
   * The job must already be claimed (status = 'running').
   */
  async dispatch(job: Job): Promise<{ ok: boolean; error?: string }> {
    const spec = job.taskSpec;
    if (!spec?.apiBridgeName) {
      return { ok: false, error: "api_call task requires apiBridgeName in taskSpec" };
    }
    if (!spec.apiBridgeAction) {
      return { ok: false, error: "api_call task requires apiBridgeAction in taskSpec" };
    }

    // Rate limit per bridge to prevent external API abuse
    if (!checkBridgeRateLimit(spec.apiBridgeName)) {
      this.failJob(job.id, `Rate limit exceeded for API bridge "${spec.apiBridgeName}"`);
      return { ok: false, error: "Rate limit exceeded" };
    }

    const bridgeConfig = this.deps.apiBridgesRepo.getByName(spec.apiBridgeName);
    if (!bridgeConfig) {
      this.failJob(job.id, `API bridge "${spec.apiBridgeName}" not found`);
      return { ok: false, error: `API bridge "${spec.apiBridgeName}" not found` };
    }
    if (!bridgeConfig.enabled) {
      this.failJob(job.id, `API bridge "${spec.apiBridgeName}" is disabled`);
      return { ok: false, error: `API bridge "${spec.apiBridgeName}" is disabled` };
    }

    // MCP bridges don't need API keys
    const isMcp = !!bridgeConfig.mcpConfig;
    const apiKey = this.deps.apiBridgesRepo.getApiKey(bridgeConfig.id);
    if (!isMcp && !apiKey && bridgeConfig.authType !== "none") {
      this.failJob(job.id, `API bridge "${spec.apiBridgeName}" has no API key configured`);
      return { ok: false, error: "No API key configured" };
    }

    // Resolve handler — MCP bridges use McpBridgeHandler
    const handler = isMcp
      ? new McpBridgeHandler()
      : bridgeConfig.type === "preset" && bridgeConfig.presetId
        ? getPresetHandler(bridgeConfig.presetId)
        : new CustomApiBridgeHandler();

    if (!handler) {
      this.failJob(job.id, `No handler found for preset "${bridgeConfig.presetId}"`);
      return { ok: false, error: `Unknown preset: ${bridgeConfig.presetId}` };
    }

    // Set up cancellation
    const abortController = new AbortController();
    this.running.set(job.id, abortController);

    // Build execution context with progress/log callbacks
    const logParts: string[] = [];
    const context: ApiBridgeExecContext = {
      onProgress: (percent, statusText) => {
        this.deps.jobsRepo.updateTaskProgress(job.id, percent, statusText);
        this.broadcastJobUpdated(job.id);
      },
      onLog: (text) => {
        logParts.push(text);
      },
      signal: abortController.signal,
    };

    logger.info("api-bridge-executor", `Dispatching ${spec.apiBridgeAction} on ${spec.apiBridgeName} for job ${job.id}`);

    // Execute asynchronously (don't block the caller)
    this.executeAsync(job.id, handler, bridgeConfig, apiKey ?? "", spec.apiBridgeAction, spec.apiBridgeParams ?? {}, context, logParts);

    return { ok: true };
  }

  /** Cancel a running API bridge job. */
  cancel(jobId: string): boolean {
    const controller = this.running.get(jobId);
    if (!controller) return false;
    controller.abort();
    this.running.delete(jobId);
    return true;
  }

  private async executeAsync(
    jobId: string,
    handler: { execute: (...args: any[]) => Promise<ApiBridgeResult> },
    bridgeConfig: any,
    apiKey: string,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
    logParts: string[],
  ): Promise<void> {
    try {
      const result = await handler.execute(bridgeConfig, apiKey, action, params, context);
      const logs = logParts.join("\n");

      if (result.success) {
        // Append the result summary to logs for visibility
        const resultSummary = JSON.stringify(result, null, 2);
        const fullLogs = logs ? `${logs}\n\n--- Result ---\n${resultSummary}` : resultSummary;
        this.deps.jobsRepo.complete(jobId, [], fullLogs);
        logger.info("api-bridge-executor", `Job ${jobId} completed successfully`);
      } else {
        this.deps.jobsRepo.fail(jobId, result.error ?? "API bridge execution failed", logs);
        logger.warn("api-bridge-executor", `Job ${jobId} failed: ${result.error}`);
      }
    } catch (err: any) {
      const logs = logParts.join("\n");
      if (err.name === "AbortError") {
        this.deps.jobsRepo.fail(jobId, "Cancelled", logs);
        logger.info("api-bridge-executor", `Job ${jobId} cancelled`);
      } else {
        this.deps.jobsRepo.fail(jobId, err.message ?? String(err), logs);
        logger.error("api-bridge-executor", `Job ${jobId} error: ${err.message}`);
      }
    } finally {
      this.running.delete(jobId);
      this.broadcastJobUpdated(jobId);
    }
  }

  private failJob(jobId: string, error: string) {
    this.deps.jobsRepo.fail(jobId, error, "");
    this.broadcastJobUpdated(jobId);
  }

  private broadcastJobUpdated(jobId: string) {
    const job = this.deps.jobsRepo.getById(jobId);
    if (job) {
      this.deps.hub.broadcastToType("client", {
        type: "job_updated",
        id: newId(),
        payload: { job },
      });
    }
  }
}
