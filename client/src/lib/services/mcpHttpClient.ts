/**
 * HTTP MCP client for the Tauri desktop client.
 *
 * When a local LLM job is dispatched to the client, tool calls are routed
 * through the server's MCP endpoint (`POST /mcp`) instead of the legacy
 * WebSocket client_tool_request pathway. This gives local models access
 * to the same tools as cloud agents.
 */

import type { McpToolDefinition, McpToolCallResult } from "@arkestrator/protocol";

let nextRequestId = 1;

async function sendMcpRequest(
  serverUrl: string,
  apiKey: string,
  jobId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = nextRequestId++;
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Job-Id": jobId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  return json.result;
}

export async function listMcpTools(
  serverUrl: string,
  apiKey: string,
  jobId: string,
): Promise<McpToolDefinition[]> {
  const result = await sendMcpRequest(serverUrl, apiKey, jobId, "tools/list", {}) as {
    tools: McpToolDefinition[];
  };
  return result.tools ?? [];
}

export async function callMcpTool(
  serverUrl: string,
  apiKey: string,
  jobId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const result = await sendMcpRequest(serverUrl, apiKey, jobId, "tools/call", {
    name: toolName,
    arguments: args,
  }) as McpToolCallResult;
  return result;
}
