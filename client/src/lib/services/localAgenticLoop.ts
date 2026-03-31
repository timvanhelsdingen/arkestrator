/**
 * Client-side local agentic loop.
 *
 * Thin adapter around the shared `runChatAgenticLoop()` from @arkestrator/protocol.
 * Calls localhost Ollama directly via HTTP. Tool calls are routed through the
 * server's MCP endpoint when available, falling back to WebSocket proxy.
 */

import {
  runChatAgenticLoop,
  promptRequestsDelegation,
  mcpToolsToOllamaSchemas,
  mcpResultToLoopResult,
  LOCAL_AGENTIC_DELEGATION_TOOLS,
  type AgenticLoopDeps,
  type AgenticLoopConfig,
} from "@arkestrator/protocol";

import { ollamaGenerate, ollamaChatWithTools } from "./ollamaClient.js";
import { listMcpTools, callMcpTool } from "./mcpHttpClient.js";

// ---------------------------------------------------------------------------
// Types (public API for callers)
// ---------------------------------------------------------------------------

export interface ClientJobDispatch {
  jobId: string;
  basePrompt: string;
  model: string;
  maxTurns: number;
  turnTimeoutMs: number;
  systemPrompt?: string;
  /** MCP endpoint on the server — when provided, tool calls go via MCP HTTP. */
  mcpEndpoint?: { url: string; apiKey: string };
}

export interface ClientJobCallbacks {
  /** Send a tool_request to the server and await the result (legacy WS proxy). */
  requestTool: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

  /** Stream a log line to the server. */
  sendLog: (text: string) => void;

  /** Report job completion to the server. */
  sendComplete: (result: {
    success: boolean;
    error?: string;
    commands: Array<{
      language: string;
      script: string;
      success: boolean;
      output?: string;
      error?: string;
      executionTimeMs?: number;
    }>;
    durationMs: number;
  }) => void;

  /** Check if the job was cancelled. */
  isCancelled: () => boolean;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runClientAgenticLoop(
  dispatch: ClientJobDispatch,
  callbacks: ClientJobCallbacks,
): Promise<void> {
  const useMcp = !!dispatch.mcpEndpoint;
  const allowDelegation = promptRequestsDelegation(dispatch.basePrompt);

  // Fetch MCP tool schemas when endpoint is available
  let mcpToolSchemas: import("@arkestrator/protocol").OllamaToolSchema[] | undefined;
  if (useMcp) {
    try {
      const { url, apiKey } = dispatch.mcpEndpoint!;
      const allTools = await listMcpTools(url, apiKey, dispatch.jobId);
      // Filter out internal-only tools and delegation tools when not needed
      const filtered = allTools.filter((t) => {
        if (t.name === "client_api_request") return false;
        if (t.name === "submit_job_intervention") return false;
        if (t.name === "list_job_interventions") return false;
        if (t.name === "read_client_file") return false;
        if (!allowDelegation && LOCAL_AGENTIC_DELEGATION_TOOLS.has(t.name)) return false;
        return true;
      });
      mcpToolSchemas = mcpToolsToOllamaSchemas(filtered);
    } catch (err) {
      callbacks.sendLog(`[client-agentic] MCP tool fetch failed, falling back to WS proxy: ${err}\n`);
    }
  }

  const loopDeps: AgenticLoopDeps = {
    async generateResponse(prompt, timeoutMs) {
      const result = await ollamaGenerate({
        model: dispatch.model,
        prompt,
        timeoutMs,
      });
      return {
        response: result.response,
        error: result.error,
        timedOut: result.timedOut,
      };
    },

    async generateChatResponse(messages, tools, timeoutMs) {
      return ollamaChatWithTools({
        model: dispatch.model,
        messages,
        tools,
        timeoutMs,
      });
    },

    async executeTool(tool, args) {
      // MCP path: call server's MCP endpoint directly via HTTP
      if (useMcp && dispatch.mcpEndpoint) {
        const { url, apiKey } = dispatch.mcpEndpoint;
        const mcpResult = await callMcpTool(url, apiKey, dispatch.jobId, tool, args);
        return mcpResultToLoopResult(mcpResult);
      }

      // Legacy fallback: proxy via WebSocket
      const result = await callbacks.requestTool(tool, args);
      let commandResults: undefined | Array<{ language: string; script: string; success: boolean; output?: string; error?: string; executionTimeMs?: number }>;
      if (result.ok && result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        if (Array.isArray(data.commandResults)) {
          commandResults = data.commandResults;
        }
      }
      return { ok: result.ok, data: result.data, error: result.error, commandResults };
    },

    log(message) {
      const text = message.endsWith("\n") ? message : `${message}\n`;
      callbacks.sendLog(text);
    },

    isCancelled: () => callbacks.isCancelled(),
  };

  const loopConfig: AgenticLoopConfig = {
    basePrompt: dispatch.basePrompt,
    maxTurns: dispatch.maxTurns,
    turnTimeoutMs: dispatch.turnTimeoutMs,
    allowDelegationTools: allowDelegation,
    systemPrompt: dispatch.systemPrompt,
    logPrefix: "[client-agentic]",
    toolSchemas: mcpToolSchemas,
  };

  const result = await runChatAgenticLoop(loopConfig, loopDeps);

  callbacks.sendComplete({
    success: result.success,
    error: result.error,
    commands: result.commands,
    durationMs: result.durationMs,
  });
}
