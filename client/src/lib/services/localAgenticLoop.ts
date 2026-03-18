/**
 * Client-side local agentic loop.
 *
 * Thin adapter around the shared `runAgenticLoop()` from @arkestrator/protocol.
 * Calls localhost Ollama directly via HTTP and proxies tool calls back to the
 * server via WebSocket callbacks.
 */

import {
  runAgenticLoop,
  promptRequestsDelegation,
  type AgenticLoopDeps,
  type AgenticLoopConfig,
} from "@arkestrator/protocol";

import { ollamaGenerate } from "./ollamaClient.js";

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
}

export interface ClientJobCallbacks {
  /** Send a tool_request to the server and await the result. */
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

    async executeTool(tool, args) {
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
    allowDelegationTools: promptRequestsDelegation(dispatch.basePrompt),
    systemPrompt: dispatch.systemPrompt,
    logPrefix: "[client-agentic]",
  };

  const result = await runAgenticLoop(loopConfig, loopDeps);

  callbacks.sendComplete({
    success: result.success,
    error: result.error,
    commands: result.commands,
    durationMs: result.durationMs,
  });
}
