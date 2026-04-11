import { Hono } from "hono";
import type { WebSocketHub } from "../ws/hub.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { ProcessTracker } from "../agents/process-tracker.js";

export { SERVER_VERSION } from "../utils/version.js";
import { SERVER_VERSION } from "../utils/version.js";

const startTime = Date.now();

/**
 * Protocol version (integer). Increment when the WS/REST protocol changes
 * in ways that require updated bridges/SDKs. Additive-only changes
 * (new optional fields) do NOT require a bump — only structural changes do.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Capability flags advertised to bridges and SDKs.
 * SDKs check these before using optional features (e.g. binary file uploads).
 * Add strings here as new gated features ship.
 */
export const CAPABILITIES: string[] = ["binary_files"];

export function createHealthRoutes(deps?: {
  hub?: WebSocketHub;
  jobsRepo?: JobsRepo;
  processTracker?: ProcessTracker;
}) {
  const router = new Hono();

  router.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    });
  });

  /**
   * Operational metrics endpoint. Exposes hub + queue counters so operators
   * can monitor bridges_connected, backpressure events, pending commands,
   * running jobs, etc. from any HTTP client. Not authenticated — intended
   * for localhost / reverse-proxy scraping. If you put the server on the
   * open internet, gate this behind your proxy.
   */
  router.get("/api/metrics", (c) => {
    const hub = deps?.hub;
    const jobsRepo = deps?.jobsRepo;
    const processTracker = deps?.processTracker;
    const hubMetrics = hub?.getMetrics();
    const queuedJobs = jobsRepo ? jobsRepo.list(["queued"]).jobs.length : 0;
    const runningJobs = jobsRepo ? jobsRepo.list(["running"]).jobs.length : 0;
    return c.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: SERVER_VERSION,
      hub: hubMetrics ?? null,
      queue: {
        queued: queuedJobs,
        running: runningJobs,
        processes: processTracker?.count ?? 0,
      },
    });
  });

  /**
   * Graceful shutdown — only allowed from loopback (localhost).
   * Used by the Tauri client to stop a local sidecar server.
   */
  router.post("/api/server/shutdown", (c) => {
    const forwarded = c.req.header("x-forwarded-for") ?? "";
    const host = new URL(c.req.url).hostname;
    const isLoopback =
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !forwarded;
    if (!isLoopback) {
      return c.json({ error: "Shutdown is only allowed from localhost" }, 403);
    }
    c.header("Connection", "close");
    setTimeout(() => process.exit(0), 200);
    return c.json({ status: "shutting_down" });
  });

  return router;
}
