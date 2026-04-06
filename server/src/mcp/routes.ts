import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpDeps } from "./tool-server.js";
import { StatelessTransport } from "./stateless-transport.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import { getAuthPrincipal, principalHasPermission, type AuthPrincipal } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import { newId } from "../utils/id.js";

/**
 * Create Hono routes for MCP.
 * Mounted at /mcp on the main app.
 * Stateless: each request creates a fresh McpServer + transport to avoid
 * shared-state issues with concurrent connections.
 */
export function createMcpRoutes(
  mcpDeps: McpDeps,
  apiKeysRepo: ApiKeysRepo,
  usersRepo?: UsersRepo,
) {
  const app = new Hono();

  async function authenticate(c: any): Promise<AuthPrincipal | null> {
    if (!usersRepo) {
      const auth = c.req.header("authorization");
      if (!auth?.startsWith("Bearer ")) return null;
      const apiKey = await apiKeysRepo.validate(auth.slice(7));
      if (!apiKey) return null;
      const principal: AuthPrincipal = { kind: "apiKey", apiKey, source: "header" };
      if (!principalHasPermission(principal, "useMcp")) return null;
      return principal;
    }

    const principal = await getAuthPrincipal(c, usersRepo, apiKeysRepo);
    if (!principal) return null;

    // Special case: auto-user API keys inherit useMcp from the owning user,
    // regardless of the key's own default permissions.
    if (principal.kind === "apiKey") {
      const autoUserPrefix = "auto:user:";
      if (principal.apiKey.name.startsWith(autoUserPrefix)) {
        const userId = principal.apiKey.name.slice(autoUserPrefix.length).trim();
        if (!userId) return null;
        const owner = usersRepo.getById(userId);
        if (!owner || owner.permissions.useMcp !== true) return null;
        return principal;
      }
    }

    // Check useMcp permission uniformly for both users and non-auto API keys
    if (!principalHasPermission(principal, "useMcp")) {
      return null;
    }
    return principal;
  }

  // POST /mcp — main MCP message endpoint
  app.post("/", async (c) => {
    const principal = await authenticate(c);
    if (!principal) {
      return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
    }

    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(c, 400, "Invalid MCP request body", "INVALID_INPUT");
      }

      // Create a fresh McpServer + transport per request.
      // This avoids concurrent connection issues — McpServer.connect()
      // overwrites internal state and can't handle parallel callers.
      const callerJobId = c.req.header("x-job-id");
      const requestOrigin = new URL(c.req.url).origin;
      const requestAuthHeader = c.req.header("authorization");
      const requestCookieHeader = c.req.header("cookie");
      const server = createMcpServer({
        ...mcpDeps,
        callerJobId,
        requestOrigin,
        requestAuthHeader,
        requestCookieHeader,
        principal,
      });
      const transport = new StatelessTransport();
      await server.connect(transport);

      const response = await transport.handleMessage(body as JSONRPCMessage);

      await transport.close();

      // Notifications (no id) produce no JSON-RPC response — return 202 Accepted
      if (response === null) {
        return c.body(null, 202);
      }

      // Piggyback pending operator guidance onto every tool call response.
      // This ensures agents receive guidance ASAP regardless of engine type,
      // without needing to explicitly poll list_job_interventions.
      if (callerJobId && mcpDeps.jobInterventionsRepo) {
        injectPendingGuidance(response, callerJobId, mcpDeps);
      }

      return c.json(response);
    } catch (err: any) {
      logger.error("mcp", `MCP request error: ${err.message}`);
      return errorResponse(c, 500, "MCP request failed", "INTERNAL_ERROR");
    }
  });

  // GET /mcp — SSE endpoint (required by spec, returns method not allowed for stateless)
  app.get("/", (c) => {
    return errorResponse(c, 405, "SSE not supported in stateless mode", "INVALID_INPUT");
  });

  // DELETE /mcp — session termination (no-op for stateless)
  app.delete("/", (c) => {
    return c.json({ ok: true }, 200);
  });

  return app;
}

/**
 * Append pending operator guidance to a tool call response so agents
 * receive guidance immediately with any MCP tool call, regardless of
 * engine type (claude-code, codex, local-oss).
 */
function injectPendingGuidance(
  response: JSONRPCMessage,
  jobId: string,
  deps: McpDeps,
): void {
  const repo = deps.jobInterventionsRepo;
  if (!repo) return;

  // Only inject into successful tool call results (JSON-RPC result with content array)
  const res = response as any;
  if (!res?.result?.content || !Array.isArray(res.result.content)) return;

  const pending = repo.listPending(jobId);
  if (pending.length === 0) return;

  // Build guidance text
  const notes = pending.map((p) => `- ${p.text}`).join("\n");
  const guidanceBlock = `\n\n---\n## ⚡ Operator Guidance (act on this immediately)\n${notes}`;

  // Append to the last text content item
  const lastText = res.result.content.findLast((c: any) => c.type === "text");
  if (lastText) {
    lastText.text += guidanceBlock;
  } else {
    res.result.content.push({ type: "text", text: guidanceBlock });
  }

  // Mark as delivered
  const delivered = repo.markDelivered(
    pending.map((p) => p.id),
    { channel: "mcp-piggyback" },
    "Piggybacked onto MCP tool response.",
  );
  if (delivered.length > 0) {
    logger.info("mcp", `Guidance delivered to job ${jobId} via MCP piggyback (${delivered.length} interventions)`);
    // Broadcast delivery status to clients so the UI updates
    const job = deps.jobsRepo.getById(jobId);
    if (job) {
      for (const entry of delivered) {
        const updated = repo.getById(entry.id);
        if (updated) {
          deps.hub.broadcastToType("client", {
            type: "job_intervention_updated",
            id: newId(),
            payload: { jobId, intervention: updated },
          });
        }
      }
    }
  }
}
