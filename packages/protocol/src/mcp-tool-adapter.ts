/**
 * Adapters for converting between MCP tool definitions/results and the
 * formats used by the local agentic loop (Ollama tool schemas, loop results).
 */

import type { OllamaToolSchema } from "./local-agentic.js";
import type { AgenticLoopToolResult, AgenticLoopCommandRecord } from "./local-agentic-loop.js";

// ---------------------------------------------------------------------------
// MCP types (minimal — we don't import the MCP SDK in the protocol package)
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, {
      type?: string;
      description?: string;
      enum?: string[];
      [key: string]: unknown;
    }>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// MCP tool definitions → Ollama tool schemas
// ---------------------------------------------------------------------------

/**
 * Convert MCP tool definitions to Ollama-compatible tool schemas
 * for the `/api/chat` tools parameter.
 */
export function mcpToolsToOllamaSchemas(tools: McpToolDefinition[]): OllamaToolSchema[] {
  return tools.map((tool) => {
    const props: Record<string, { type: string; description: string; enum?: string[] }> = {};
    const inputProps = tool.inputSchema.properties ?? {};

    for (const [key, schema] of Object.entries(inputProps)) {
      // Map JSON Schema types to simple Ollama types
      let type = String(schema.type ?? "string");
      // Ollama expects simple types; flatten arrays/objects to string for small models
      if (type === "array" || type === "object") type = "string";

      props[key] = {
        type,
        description: String(schema.description ?? key),
        ...(schema.enum ? { enum: schema.enum as string[] } : {}),
      };
    }

    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: props,
          required: (tool.inputSchema.required ?? []) as string[],
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions → text prompt (for hybrid/text-prompt mode)
// ---------------------------------------------------------------------------

/**
 * Convert MCP tool definitions to readable text descriptions for embedding
 * in system prompts (hybrid mode where the model outputs JSON text).
 */
export function mcpToolsToTextPrompt(tools: McpToolDefinition[]): string {
  return tools.map((tool) => {
    const inputProps = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);

    const paramList = Object.entries(inputProps)
      .map(([name, schema]) => {
        const type = String(schema.type ?? "string");
        return `${name}: ${type}${required.has(name) ? "" : "?"}`;
      })
      .join(", ");

    return `- ${tool.name}(${paramList})\n  ${tool.description}`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// MCP tool call result → agentic loop result
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tools/call response into the AgenticLoopToolResult
 * format expected by the agentic loop.
 */
export function mcpResultToLoopResult(result: McpToolCallResult): AgenticLoopToolResult {
  const textParts = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text);
  const combined = textParts.join("\n");

  if (result.isError) {
    return {
      ok: false,
      error: combined || "Unknown MCP error",
    };
  }

  // Try to parse as JSON to extract structured data (bridgesUsed, commandResults, etc.)
  // The MCP tool server often wraps results in JSON.stringify()
  let data: unknown = combined;
  let bridgesUsed: string[] | undefined;
  let commandResults: AgenticLoopCommandRecord[] | undefined;

  try {
    const parsed = JSON.parse(combined);
    data = parsed;

    // Extract bridgesUsed if present in the result JSON
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.bridgesUsed)) {
        bridgesUsed = parsed.bridgesUsed;
      }
      // Command results may be nested in a results array
      if (Array.isArray(parsed.results)) {
        commandResults = parsed.results
          .filter((r: any) => r && (r.language || r.script))
          .map((r: any) => ({
            language: r.language ?? "unknown",
            script: r.script ?? "",
            success: r.success ?? r.executed ?? false,
            output: r.stdout ?? r.output ?? "",
            error: r.stderr ?? r.error ?? undefined,
          }));
      }
    }
  } catch {
    // Not JSON — use as plain text data (common for simple text responses)
  }

  return {
    ok: true,
    data,
    bridgesUsed,
    commandResults,
  };
}
