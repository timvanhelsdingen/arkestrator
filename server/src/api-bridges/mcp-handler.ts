/**
 * MCP Bridge Handler — connects to external MCP servers (stdio or SSE/HTTP)
 * and exposes their tools as API bridge actions.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ApiBridgeAction,
  ApiBridgeConfig,
  ApiBridgeResult,
  McpConfig,
} from "@arkestrator/protocol";
import type { ApiBridgeExecContext } from "./handler.js";

/**
 * Connect to an MCP server based on config, run a callback, then disconnect.
 * Handles both stdio (subprocess) and SSE/HTTP (remote) transports.
 */
async function withMcpClient<T>(
  mcpConfig: McpConfig,
  fn: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = new Client({ name: "arkestrator", version: "1.0.0" });

  let transport;
  if (mcpConfig.transport === "stdio") {
    if (!mcpConfig.command) throw new Error("MCP stdio transport requires a command");
    transport = new StdioClientTransport({
      command: mcpConfig.command,
      args: mcpConfig.args ?? [],
      env: mcpConfig.env ? { ...process.env, ...mcpConfig.env } as Record<string, string> : undefined,
    });
  } else {
    // SSE / streamable HTTP
    if (!mcpConfig.url) throw new Error("MCP SSE transport requires a URL");
    const url = new URL(mcpConfig.url);
    const extraHeaders = mcpConfig.headers ?? {};

    // Try streamable HTTP first, fall back to SSE
    try {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: extraHeaders,
        },
      });
      await client.connect(transport);
      // If connect succeeded, use this transport
      try {
        return await fn(client);
      } finally {
        await client.close().catch(() => {});
      }
    } catch {
      // Streamable HTTP failed, try SSE
      transport = new SSEClientTransport(url, {
        requestInit: {
          headers: extraHeaders,
        },
      });
    }
  }

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Convert MCP tool JSON schema to ApiBridgeAction parameter map.
 */
function mcpToolToAction(tool: {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}): ApiBridgeAction {
  const parameters: ApiBridgeAction["parameters"] = {};
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];

  for (const [key, schema] of Object.entries(props)) {
    parameters[key] = {
      type: (schema.type as any) ?? "string",
      description: schema.description ?? "",
      required: required.includes(key),
      ...(schema.enum ? { enum: schema.enum } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
    };
  }

  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters,
  };
}

export class McpBridgeHandler {
  /**
   * List tools from an MCP server (for test/actions endpoints).
   * Creates a temporary connection, lists tools, then disconnects.
   */
  async getActionsForConfig(mcpConfig: McpConfig): Promise<ApiBridgeAction[]> {
    return withMcpClient(mcpConfig, async (client) => {
      const result = await client.listTools();
      return (result.tools ?? []).map(mcpToolToAction);
    });
  }

  /**
   * Execute an MCP tool call on a bridge.
   */
  async execute(
    config: ApiBridgeConfig,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    if (!config.mcpConfig) {
      return { bridgeName: config.name, action, success: false, error: "No MCP config" };
    }

    context.onLog?.(`Connecting to MCP server...`);
    context.onProgress?.(null, "Connecting...");

    try {
      const result = await withMcpClient(
        config.mcpConfig,
        async (client) => {
          context.onLog?.(`Calling tool: ${action}`);
          context.onProgress?.(null, `Calling ${action}...`);
          return client.callTool({ name: action, arguments: params });
        },
        context.signal,
      );

      context.onProgress?.(100, "Complete");

      // Extract text content from MCP result
      const content = result.content as Array<{ type: string; text?: string }>;
      const textParts = content
        ?.filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!) ?? [];

      return {
        bridgeName: config.name,
        action,
        success: !result.isError,
        data: textParts.length === 1 ? textParts[0] : textParts.length > 0 ? textParts : result.content,
        error: result.isError ? textParts.join("\n") || "Tool call failed" : undefined,
      };
    } catch (err: any) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: err.message ?? String(err),
      };
    }
  }
}
