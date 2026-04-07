import { Hono } from "hono";

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

export function createHealthRoutes() {
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
