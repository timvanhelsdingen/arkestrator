import { Hono } from "hono";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpDeps } from "./tool-server.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import { getAuthPrincipal, principalHasPermission, type AuthPrincipal } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";

/**
 * A simple in-memory transport for stateless MCP request handling.
 * Works with Bun (no Node.js http.ServerResponse dependency).
 * Each request creates a fresh transport, sends the message through,
 * captures the response, and disconnects.
 *
 * Important: MCP notifications (messages with no "id") never produce a
 * JSON-RPC response. handleMessage returns null for notifications so the
 * HTTP handler can respond with 202 Accepted without hanging.
 */
class StatelessTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  private responseResolve?: (message: JSONRPCMessage) => void;
  private responsePromise?: Promise<JSONRPCMessage>;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    // Server is sending a response — capture it
    if (this.responseResolve) {
      this.responseResolve(message);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Deliver an incoming JSON-RPC message and wait for the server's response.
   * Returns null for notifications (no "id") — they have no JSON-RPC response.
   */
  async handleMessage(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    // Notifications have no id — the MCP server never calls send() for them.
    // Return null immediately so the HTTP handler can respond with 202.
    const hasId = "id" in message && message.id !== undefined && message.id !== null;
    if (!hasId) {
      this.onmessage?.(message);
      return null;
    }

    this.responsePromise = new Promise<JSONRPCMessage>((resolve) => {
      this.responseResolve = resolve;
    });

    // Deliver to the MCP server
    this.onmessage?.(message);

    // Wait for the server to call send() with the response
    return this.responsePromise;
  }
}

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

      const response = await transport.handleMessage(body);

      await transport.close();

      // Notifications (no id) produce no JSON-RPC response — return 202 Accepted
      if (response === null) {
        return c.body(null, 202);
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
