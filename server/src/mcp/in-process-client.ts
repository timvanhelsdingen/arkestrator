/**
 * In-process MCP client for server-side local agentic loops.
 *
 * Instead of making HTTP calls to /mcp, this creates a McpServer + StatelessTransport
 * pair in-process. Zero network overhead — the same code path as the HTTP route
 * but without serialization/deserialization over the wire.
 */

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolDefinition, McpToolCallResult } from "@arkestrator/protocol";
import { createMcpServer, type McpDeps } from "./tool-server.js";
import { StatelessTransport } from "./stateless-transport.js";

export interface InProcessMcpClient {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): void;
}

let nextRequestId = 1;

export async function createInProcessMcpClient(deps: McpDeps): Promise<InProcessMcpClient> {
  const server = createMcpServer(deps);
  const transport = new StatelessTransport();
  await server.connect(transport);

  async function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextRequestId++;
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    } as any;

    const response = await transport.handleMessage(message);
    if (!response) throw new Error(`No response for MCP ${method}`);

    if ("error" in response && (response as any).error) {
      const err = (response as any).error;
      throw new Error(`MCP error: ${err.message ?? JSON.stringify(err)}`);
    }

    return (response as any).result;
  }

  return {
    async listTools(): Promise<McpToolDefinition[]> {
      const result = await sendRequest("tools/list", {}) as { tools: McpToolDefinition[] };
      return result.tools ?? [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
      const result = await sendRequest("tools/call", { name, arguments: args }) as McpToolCallResult;
      return result;
    },

    close() {
      transport.close();
    },
  };
}
