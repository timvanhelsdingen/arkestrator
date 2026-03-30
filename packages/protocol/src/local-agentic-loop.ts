/**
 * Shared local agentic loop.
 *
 * Platform-agnostic turn loop used by both the server (subprocess-based LLM)
 * and the client (Ollama HTTP API). All platform-specific concerns are
 * injected via the `AgenticLoopDeps` interface.
 */

import {
  parseLocalAgenticAction,
  buildLocalAgenticTurnPrompt,
  compactJson,
  LOCAL_AGENTIC_DEFAULTS,
  LOCAL_AGENTIC_DELEGATION_TOOLS,
  type LocalAgenticToolCall,
  type LocalAgenticHistoryEntry,
} from "./local-agentic.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AgenticLoopCommandRecord {
  language: string;
  script: string;
  success: boolean;
  output?: string;
  error?: string;
  executionTimeMs?: number;
}

export interface AgenticLoopResult {
  success: boolean;
  error?: string;
  commands: AgenticLoopCommandRecord[];
  durationMs: number;
  /** True if the loop detected legacy (non-protocol) output on turn 1. */
  fallbackToLegacy?: boolean;
  /** True if the job was cancelled mid-loop. */
  cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Dependency injection interfaces
// ---------------------------------------------------------------------------

export interface AgenticLoopLlmResponse {
  response: string;
  error?: string;
  timedOut?: boolean;
  /** Subprocess exit code (server-only). */
  exitCode?: number;
}

export interface AgenticLoopToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Bridge programs used by this tool call. */
  bridgesUsed?: string[];
  /** Command execution records from this tool call. */
  commandResults?: AgenticLoopCommandRecord[];
}

export interface AgenticLoopDeps {
  /** Call the LLM with a prompt and timeout, return the raw text response. */
  generateResponse(prompt: string, timeoutMs: number): Promise<AgenticLoopLlmResponse>;

  /** Execute a tool call and return the result. */
  executeTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<AgenticLoopToolResult>;

  /** Emit a log line. */
  log(message: string): void;

  /** Check if the job has been cancelled. Return true to abort. */
  isCancelled(): boolean | Promise<boolean>;

  // --- Optional hooks for server-specific concerns ---

  /** Called on first valid protocol parse (activation). */
  onActivated?(): void;

  /** Called when a bridge program is used by a tool call. */
  onBridgeUsed?(programs: string[]): void;

  /**
   * Return extra text to append to the task prompt (e.g. operator interventions).
   * Called once per turn, before building the prompt.
   */
  getTurnPromptSuffix?(turn: number): string;

  /**
   * Check for overall job timeout (server tracks this independently).
   * Return an error string to abort, or undefined to continue.
   */
  checkTimeout?(): string | undefined;

  /**
   * Called on turn 1 when non-protocol output is detected.
   * If returns true, the loop returns `fallbackToLegacy: true`.
   * Server uses this for legacy CLI-style fallback.
   */
  shouldFallbackToLegacy?(rawOutput: string): boolean;
}

export interface AgenticLoopConfig {
  basePrompt: string;
  maxTurns: number;
  turnTimeoutMs: number;
  allowDelegationTools: boolean;
  systemPrompt?: string;
  /** Prefix for log lines, e.g. "[local-agentic]" or "[client-agentic]". */
  logPrefix?: string;
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

export async function runAgenticLoop(
  config: AgenticLoopConfig,
  deps: AgenticLoopDeps,
): Promise<AgenticLoopResult> {
  const startTime = Date.now();
  const prefix = config.logPrefix ?? "[agentic]";

  const history: LocalAgenticHistoryEntry[] = [];
  const executedCommands: AgenticLoopCommandRecord[] = [];
  let invalidProtocolTurns = 0;
  let consecutiveErrorCount = 0;
  let lastErrorMessage = "";
  let delegatedWorkCreated = false;
  let activated = false;
  let lastToolCallKey = "";
  let sameToolCallCount = 0;
  let successfulToolCalls = 0;

  const mkResult = (
    partial: Omit<AgenticLoopResult, "commands" | "durationMs">,
  ): AgenticLoopResult => ({
    ...partial,
    commands: executedCommands,
    durationMs: Date.now() - startTime,
  });

  deps.log(`${prefix} Starting loop: maxTurns=${config.maxTurns}`);

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    // 1. Check cancellation
    const cancelled = await deps.isCancelled();
    if (cancelled) {
      return mkResult({ success: false, cancelled: true, error: "Job cancelled" });
    }

    // 2. Check overall timeout (server-specific)
    const timeoutError = deps.checkTimeout?.();
    if (timeoutError) {
      return mkResult({ success: false, error: timeoutError });
    }

    // 3. Build prompt (with optional turn suffix for operator notes)
    const promptSuffix = deps.getTurnPromptSuffix?.(turn) ?? "";
    const effectiveBasePrompt = promptSuffix
      ? `${config.basePrompt}\n\n${promptSuffix}`
      : config.basePrompt;

    const turnPrompt = buildLocalAgenticTurnPrompt(
      effectiveBasePrompt,
      history,
      turn,
      config.maxTurns,
      config.allowDelegationTools,
      config.systemPrompt,
    );

    // 4. Calculate turn timeout — first turn gets extra time for model loading
    const turnTimeoutMs = turn === 1
      ? Math.min(
          Math.max(config.turnTimeoutMs, LOCAL_AGENTIC_DEFAULTS.FIRST_TURN_MIN_TIMEOUT_MS),
          LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS,
        )
      : Math.min(config.turnTimeoutMs, LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS);

    deps.log(`${prefix} turn ${turn}/${config.maxTurns} (timeout: ${turnTimeoutMs}ms)`);

    // 5. Call LLM
    const llmResult = await deps.generateResponse(turnPrompt, turnTimeoutMs);

    if (llmResult.error) {
      return mkResult({ success: false, error: llmResult.error });
    }
    if (llmResult.timedOut) {
      // If we already executed commands successfully, a timeout on a follow-up
      // turn is likely just the model being slow to produce a summary. Treat as
      // success rather than failing a job that actually did its work.
      if (executedCommands.length > 0) {
        deps.log(`${prefix} Turn ${turn} timed out after ${turnTimeoutMs}ms but commands already executed — treating as done`);
        return mkResult({ success: true });
      }
      return mkResult({
        success: false,
        error: `Local runtime turn ${turn} timed out after ${turnTimeoutMs}ms`,
      });
    }

    const rawOutput = llmResult.response.trim();
    if (!rawOutput) {
      // Server checks exitCode; client treats empty-after-commands as success
      if (llmResult.exitCode !== undefined && llmResult.exitCode !== 0) {
        return mkResult({
          success: false,
          error: `Local runtime exited with code ${llmResult.exitCode} and produced no output`,
        });
      }
      if (executedCommands.length > 0) {
        deps.log(`${prefix} Empty model output after executing commands — treating as done`);
        return mkResult({ success: true });
      }
      return mkResult({ success: false, error: "Local runtime produced no output" });
    }

    // 6. Parse protocol action
    const parsed = parseLocalAgenticAction(rawOutput);

    if (!parsed.action) {
      // Legacy fallback check (server turn 1 only)
      if (turn === 1 && !activated && deps.shouldFallbackToLegacy?.(rawOutput)) {
        return mkResult({
          success: false,
          fallbackToLegacy: true,
          error: parsed.error ?? "Unable to parse local agentic protocol",
        });
      }

      deps.log(`${prefix} turn ${turn}: invalid protocol output: ${rawOutput.slice(0, 1000)}`);
      history.push({
        turn,
        action: "invalid_output",
        result: compactJson(
          {
            ok: false,
            error: parsed.error ?? "Invalid local protocol output",
            output: rawOutput.slice(0, 1200),
            instruction: "Reply with exactly one valid JSON object matching the protocol.",
          },
          5000,
        ),
      });
      invalidProtocolTurns += 1;
      if (
        invalidProtocolTurns <= LOCAL_AGENTIC_DEFAULTS.MAX_INVALID_PROTOCOL_TURNS
        && turn < config.maxTurns
      ) {
        continue;
      }
      return mkResult({
        success: false,
        error: parsed.error ?? "Invalid local protocol output",
      });
    }
    invalidProtocolTurns = 0;

    // 7. Activation signal
    if (!activated) {
      activated = true;
      deps.onActivated?.();
      deps.log(`${prefix} protocol mode activated`);
    }

    // 8. Handle final action
    if (parsed.action.type === "final") {
      if (
        parsed.action.status === "completed"
        && executedCommands.length === 0
        && !delegatedWorkCreated
        && successfulToolCalls === 0
      ) {
        const message =
          "Final 'completed' rejected: no tools called yet. Call a tool first (e.g. list_bridges, execute_command).";
        deps.log(`${prefix} turn ${turn}: ${message}`);
        history.push({
          turn,
          action: compactJson(parsed.action, 3000),
          result: compactJson(
            {
              ok: false,
              error: message,
              instruction:
                "Call a tool first, then return final when done.",
            },
            5000,
          ),
        });
        if (turn < config.maxTurns) continue;
        return mkResult({ success: false, error: message });
      }

      deps.log(`${prefix} final(${parsed.action.status}): ${parsed.action.summary}`);
      return mkResult({
        success: parsed.action.status === "completed",
        error: parsed.action.status === "completed" ? undefined : parsed.action.summary,
      });
    }

    // 9. Handle tool call
    const action = parsed.action as LocalAgenticToolCall;

    // Check delegation tool restriction
    if (
      !config.allowDelegationTools
      && LOCAL_AGENTIC_DELEGATION_TOOLS.has(action.tool)
    ) {
      const reason = `tool ${action.tool} is disabled for this task; use execute_command/execute_multiple_commands`;
      deps.log(`${prefix} tool_error(${action.tool}): ${reason}`);
      history.push({
        turn,
        action: compactJson(action, 3000),
        result: compactJson({ ok: false, error: reason }, 5000),
      });
      continue;
    }

    // Loop detection: if the model keeps calling the same tool with the same
    // args, it's stuck. Force a final response after 3 repeats.
    const toolCallKey = `${action.tool}:${compactJson(action.args, 500)}`;
    if (toolCallKey === lastToolCallKey) {
      sameToolCallCount++;
      if (sameToolCallCount >= 3) {
        deps.log(`${prefix} aborting: model stuck in loop calling ${action.tool} with same args ${sameToolCallCount} times`);
        // Tell the model to stop
        history.push({
          turn,
          action: compactJson(action, 3000),
          result: compactJson({
            ok: false,
            error: `You already called ${action.tool} with the same arguments ${sameToolCallCount} times. You MUST now respond with {"type":"final","status":"completed","summary":"..."} to finish.`,
          }, 5000),
        });
        // Give one more chance to produce final
        if (turn < config.maxTurns) continue;
        return mkResult({
          success: executedCommands.length > 0,
          error: `Model stuck in loop calling ${action.tool} ${sameToolCallCount} times`,
        });
      }
    } else {
      sameToolCallCount = 1;
      lastToolCallKey = toolCallKey;
    }

    deps.log(
      `${prefix} turn ${turn} tool_call: ${action.tool}(${compactJson(action.args, 200)})`,
    );

    const toolResult = await deps.executeTool(
      action.tool,
      action.args as Record<string, unknown>,
    );

    // Track bridges
    if (toolResult.bridgesUsed?.length) {
      deps.onBridgeUsed?.(toolResult.bridgesUsed);
    }
    // Track commands
    if (toolResult.commandResults?.length) {
      executedCommands.push(...toolResult.commandResults);
    }
    // Track delegation
    if (action.tool === "create_job" && toolResult.ok) {
      delegatedWorkCreated = true;
    }

    // Build history entry with GDScript error hints
    const historyResult = toolResult.ok
      ? { ok: true, data: toolResult.data }
      : (() => {
          const payload: Record<string, unknown> = {
            ok: false,
            error: toolResult.error ?? "unknown tool error",
          };
          const language = String(
            (action.args as Record<string, unknown>)?.language ?? "",
          ).toLowerCase();
          if (
            (action.tool === "execute_command"
              || action.tool === "execute_multiple_commands")
            && language === "gdscript"
            && String(toolResult.error ?? "")
              .toLowerCase()
              .includes("compile gdscript")
          ) {
            payload.hint =
              "Use valid GDScript only. Include exact entrypoint: func run(editor: EditorInterface) -> void:";
            payload.example =
              "func run(editor: EditorInterface) -> void:\\n\\tvar selected = editor.get_selection().get_selected_nodes()\\n\\tif selected.is_empty():\\n\\t\\tpush_error(\"No selected node\")\\n\\t\\treturn\\n\\tvar label = Label.new()\\n\\tlabel.text = \"cheese\"\\n\\tselected[0].add_child(label)";
          }
          return payload;
        })();

    history.push({
      turn,
      action: compactJson(action, 3000),
      result: compactJson(historyResult, 5000),
    });

    // Consecutive error tracking
    if (!toolResult.ok) {
      const errMsg = toolResult.error ?? "unknown error";
      deps.log(`${prefix} tool_error(${action.tool}): ${errMsg}`);
      if (errMsg === lastErrorMessage) {
        consecutiveErrorCount++;
        if (consecutiveErrorCount >= LOCAL_AGENTIC_DEFAULTS.MAX_CONSECUTIVE_ERRORS) {
          deps.log(
            `${prefix} aborting: same error repeated ${consecutiveErrorCount} times`,
          );
          return mkResult({
            success: false,
            error: `Local model stuck in error loop (${consecutiveErrorCount}x): ${errMsg}`,
          });
        }
      } else {
        consecutiveErrorCount = 1;
        lastErrorMessage = errMsg;
      }
    } else {
      consecutiveErrorCount = 0;
      lastErrorMessage = "";
      successfulToolCalls++;
      deps.log(
        `${prefix} tool_ok(${action.tool}): ${compactJson(toolResult.data, 800)}`,
      );
    }
  }

  // Exhausted all turns
  deps.log(`${prefix} max turns (${config.maxTurns}) reached without final response`);
  return mkResult({
    success: false,
    error: `Local agentic loop hit max turns (${config.maxTurns}) without final response`,
  });
}
