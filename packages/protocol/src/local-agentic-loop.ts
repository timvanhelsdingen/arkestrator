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
  LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
  getOllamaToolSchemas,
  buildOllamaSystemMessage,
  buildOllamaHybridSystemMessage,
  type LocalAgenticToolCall,
  type LocalAgenticHistoryEntry,
  type OllamaChatMessage,
  type OllamaToolSchema,
  type OllamaToolCall,
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

export interface AgenticLoopChatResponse {
  message?: OllamaChatMessage;
  error?: string;
  timedOut?: boolean;
}

export interface AgenticLoopDeps {
  /** Call the LLM with a prompt and timeout, return the raw text response (text-prompt mode). */
  generateResponse(prompt: string, timeoutMs: number): Promise<AgenticLoopLlmResponse>;

  /** Call the LLM with chat messages + tools (Ollama native tool calling mode).
   *  When provided, the loop prefers this over generateResponse.
   *  @param think — when set, controls whether the model uses thinking/reasoning mode.
   *    true = enable thinking (for planning/evaluation), false = disable (for tool calls). */
  generateChatResponse?(
    messages: OllamaChatMessage[],
    tools: OllamaToolSchema[],
    timeoutMs: number,
    think?: boolean,
  ): Promise<AgenticLoopChatResponse>;

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
  /** External tool schemas (e.g. from MCP). When provided, overrides hardcoded schemas. */
  toolSchemas?: OllamaToolSchema[];
  /**
   * Reasoning mode for multi-phase turns.
   * - "disabled" — no thinking, tool calls only (default, fastest)
   * - "plan-act" — think before each tool call
   * - "plan-act-evaluate" — think before AND after each tool call
   */
  reasoningMode?: "disabled" | "plan-act" | "plan-act-evaluate";
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

    // Consecutive error tracking (before history push so skill hints appear in result)
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
      // Always suggest skill search on errors — a skill may document the fix
      (historyResult as Record<string, unknown>).skill_hint =
        "Before retrying, call search_skills with keywords from this error to check if a documented fix exists.";
    } else {
      consecutiveErrorCount = 0;
      lastErrorMessage = "";
      successfulToolCalls++;
      deps.log(
        `${prefix} tool_ok(${action.tool}): ${compactJson(toolResult.data, 800)}`,
      );
    }

    history.push({
      turn,
      action: compactJson(action, 3000),
      result: compactJson(historyResult, 5000),
    });
  }

  // Exhausted all turns
  deps.log(`${prefix} max turns (${config.maxTurns}) reached without final response`);
  return mkResult({
    success: false,
    error: `Local agentic loop hit max turns (${config.maxTurns}) without final response`,
  });
}

// ---------------------------------------------------------------------------
// Chat-mode agentic loop (Ollama native tool calling)
// ---------------------------------------------------------------------------

/**
 * Run the agentic loop using Ollama's native `/api/chat` with the `tools`
 * parameter. Models produce structured `tool_calls` responses instead of
 * our custom JSON protocol. Falls back to the text-prompt loop if the model
 * doesn't support tool calling.
 */
export async function runChatAgenticLoop(
  config: AgenticLoopConfig,
  deps: AgenticLoopDeps,
): Promise<AgenticLoopResult> {
  if (!deps.generateChatResponse) {
    // No chat mode available — fall back to text-prompt mode
    return runAgenticLoop(config, deps);
  }

  const startTime = Date.now();
  const prefix = config.logPrefix ?? "[chat-agentic]";
  const executedCommands: AgenticLoopCommandRecord[] = [];
  let delegatedWorkCreated = false;
  let activated = false;
  let successfulToolCalls = 0;
  let consecutiveErrorCount = 0;
  let lastErrorMessage = "";
  let lastToolCallKey = "";
  let sameToolCallCount = 0;
  let hybridMode = false;

  const mkResult = (
    partial: Omit<AgenticLoopResult, "commands" | "durationMs">,
  ): AgenticLoopResult => ({
    ...partial,
    commands: executedCommands,
    durationMs: Date.now() - startTime,
  });

  // Build tool schemas — prefer externally provided (MCP) schemas over hardcoded
  const toolSchemas = config.toolSchemas ?? getOllamaToolSchemas({
    allowDelegation: config.allowDelegationTools,
    allowSkills: true,
  });

  // Build initial messages
  const systemMsg: OllamaChatMessage = {
    role: "system",
    content: buildOllamaSystemMessage(config.systemPrompt),
  };
  const userMsg: OllamaChatMessage = {
    role: "user",
    content: config.basePrompt,
  };
  const messages: OllamaChatMessage[] = [systemMsg, userMsg];

  deps.log(`${prefix} Starting chat loop: maxTurns=${config.maxTurns} tools=${toolSchemas.length}`);

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    // 1. Check cancellation
    if (await deps.isCancelled()) {
      return mkResult({ success: false, cancelled: true, error: "Job cancelled" });
    }

    // 2. Check overall timeout
    const timeoutError = deps.checkTimeout?.();
    if (timeoutError) return mkResult({ success: false, error: timeoutError });

    // 3. Add operator intervention notes if any
    const suffix = deps.getTurnPromptSuffix?.(turn) ?? "";
    if (suffix) {
      messages.push({ role: "user", content: suffix });
    }

    // 4. Calculate turn timeout
    const turnTimeoutMs = turn === 1
      ? Math.min(
          Math.max(config.turnTimeoutMs, LOCAL_AGENTIC_DEFAULTS.FIRST_TURN_MIN_TIMEOUT_MS),
          LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS,
        )
      : Math.min(config.turnTimeoutMs, LOCAL_AGENTIC_DEFAULTS.MAX_TURN_TIMEOUT_MS);

    const reasoning = config.reasoningMode ?? "disabled";
    deps.log(`${prefix} turn ${turn}/${config.maxTurns} (timeout: ${turnTimeoutMs}ms${reasoning !== "disabled" ? `, reasoning: ${reasoning}` : ""})`);

    // 5a. PLAN phase: if reasoning mode is active, call LLM with think=true + no tools
    // to let it reason about the next step before making a tool call.
    if (reasoning !== "disabled" && !hybridMode) {
      const planResult = await deps.generateChatResponse(messages, [], turnTimeoutMs, true);
      if (planResult.message?.content) {
        const planText = planResult.message.content.trim();
        if (planText) {
          deps.log(`${prefix} [plan] ${planText.length > 500 ? planText.slice(0, 500) + "..." : planText}`);
          // Add the plan as an assistant message so the model has context for the tool call
          messages.push({ role: "assistant", content: planText });
          messages.push({ role: "user", content: "Now execute your plan. Call a tool with the JSON format." });
        }
      }
    }

    // 5b. ACT phase: Call LLM with tools (think=false) to get structured tool calls
    const chatResult = await deps.generateChatResponse(messages, hybridMode ? [] : toolSchemas, turnTimeoutMs, false);

    // Check cancellation after LLM call (can take 30-60s for large models)
    if (await deps.isCancelled()) {
      return mkResult({ success: false, cancelled: true, error: "Job cancelled" });
    }

    if (chatResult.error) {
      // If first turn fails with tool-related error, fall back to text-prompt
      if (turn === 1 && /tool|function|not supported/i.test(chatResult.error)) {
        deps.log(`${prefix} Chat mode not supported by model, falling back to text-prompt mode`);
        return runAgenticLoop(config, deps);
      }
      return mkResult({ success: false, error: chatResult.error });
    }
    if (chatResult.timedOut) {
      if (executedCommands.length > 0) {
        deps.log(`${prefix} Turn ${turn} timed out but commands already executed — treating as done`);
        return mkResult({ success: true });
      }
      return mkResult({ success: false, error: `Chat turn ${turn} timed out after ${turnTimeoutMs}ms` });
    }

    const msg = chatResult.message;
    if (!msg) {
      if (executedCommands.length > 0) {
        deps.log(`${prefix} Empty response after commands — treating as done`);
        return mkResult({ success: true });
      }
      return mkResult({ success: false, error: "Empty chat response" });
    }

    // 6. Activation signal
    if (!activated) {
      activated = true;
      deps.onActivated?.();
      deps.log(`${prefix} chat mode activated`);
    }

    // -------------------------------------------------------------------
    // Shared tool execution helper (used by both native and hybrid paths)
    // Returns "abort" result or undefined (continue loop).
    // -------------------------------------------------------------------
    const executeAndTrack = async (
      toolName: string,
      toolArgs: Record<string, unknown>,
      assistantMsg: OllamaChatMessage,
      resultRole: "tool" | "user",
    ): Promise<AgenticLoopResult | "continue"> => {
      // Delegation restriction
      if (!config.allowDelegationTools && LOCAL_AGENTIC_DELEGATION_TOOLS.has(toolName as any)) {
        const reason = `tool ${toolName} is disabled for this task`;
        deps.log(`${prefix} tool_error(${toolName}): ${reason}`);
        messages.push(assistantMsg);
        const errContent = JSON.stringify({ ok: false, error: reason });
        messages.push({ role: resultRole, content: resultRole === "user" ? `Tool result: ${errContent}\n\nContinue with the next JSON action.` : errContent });
        return "continue";
      }

      // Loop detection
      const callKey = `${toolName}:${compactJson(toolArgs, 500)}`;
      if (callKey === lastToolCallKey) {
        sameToolCallCount++;
        if (sameToolCallCount >= 3) {
          deps.log(`${prefix} aborting: model stuck calling ${toolName} with same args ${sameToolCallCount} times`);
          if (executedCommands.length > 0) return mkResult({ success: true });
          return mkResult({ success: false, error: `Model stuck calling ${toolName} ${sameToolCallCount} times` });
        }
      } else {
        sameToolCallCount = 1;
        lastToolCallKey = callKey;
      }

      deps.log(`${prefix} turn ${turn} tool_call: ${toolName}(${compactJson(toolArgs, 200)})`);

      const toolResult = await deps.executeTool(toolName, toolArgs);

      // Check cancellation after tool execution (tools can be long-running)
      if (await deps.isCancelled()) {
        return mkResult({ success: false, cancelled: true, error: "Job cancelled" });
      }

      // Track bridges and commands
      if (toolResult.bridgesUsed?.length) deps.onBridgeUsed?.(toolResult.bridgesUsed);
      if (toolResult.commandResults?.length) executedCommands.push(...toolResult.commandResults);
      if (toolName === "create_job" && toolResult.ok) delegatedWorkCreated = true;

      // Build result string
      const resultStr = toolResult.ok
        ? JSON.stringify({ ok: true, data: toolResult.data })
        : JSON.stringify({ ok: false, error: toolResult.error ?? "unknown error" });
      const truncatedResult = resultStr.length > 4000
        ? resultStr.slice(0, 4000) + "...(truncated)"
        : resultStr;

      // Append to messages
      messages.push(assistantMsg);
      if (resultRole === "tool") {
        messages.push({ role: "tool", content: truncatedResult });
      } else {
        messages.push({ role: "user", content: `Tool result: ${truncatedResult}\n\nRespond with exactly one JSON object for the next action.` });
      }

      // Error tracking
      if (!toolResult.ok) {
        const errMsg = toolResult.error ?? "unknown error";
        deps.log(`${prefix} tool_error(${toolName}): ${errMsg}`);
        if (errMsg === lastErrorMessage) {
          consecutiveErrorCount++;
          if (consecutiveErrorCount >= LOCAL_AGENTIC_DEFAULTS.MAX_CONSECUTIVE_ERRORS) {
            return mkResult({ success: false, error: `Stuck in error loop (${consecutiveErrorCount}x): ${errMsg}` });
          }
        } else {
          consecutiveErrorCount = 1;
          lastErrorMessage = errMsg;
        }
        // Always suggest skill search on errors
        const skillHint = "\n\nBefore retrying, call search_skills with keywords from this error to check if a documented fix exists.";
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && typeof lastMsg.content === "string") {
          lastMsg.content += skillHint;
        }
      } else {
        consecutiveErrorCount = 0;
        lastErrorMessage = "";
        successfulToolCalls++;
        deps.log(`${prefix} tool_ok(${toolName}): ${compactJson(toolResult.data, 800)}`);
      }

      // EVALUATE phase: if plan-act-evaluate mode, let the model reason about
      // the tool result before the next turn. This helps it understand errors
      // and change approach instead of repeating the same failing command.
      const evalReasoning = config.reasoningMode ?? "disabled";
      if (evalReasoning === "plan-act-evaluate" && deps.generateChatResponse) {
        const evalResult = await deps.generateChatResponse(messages, [], 60_000, true);
        if (evalResult.message?.content) {
          const evalText = evalResult.message.content.trim();
          if (evalText) {
            deps.log(`${prefix} [eval] ${evalText.length > 500 ? evalText.slice(0, 500) + "..." : evalText}`);
            messages.push({ role: "assistant", content: evalText });
          }
        }
      }

      // Slide window
      if (messages.length > 42) {
        const preserved = [messages[0], messages[1]];
        messages.splice(0, messages.length, ...preserved, ...messages.slice(-40));
      }

      return "continue";
    };

    // 7. Check for native tool calls
    const toolCalls = msg.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const call = toolCalls[0];
      const toolName = call.function.name;
      const toolArgs: Record<string, unknown> = typeof call.function.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call.function.arguments ?? {};

      const execResult = await executeAndTrack(toolName, toolArgs, msg, "tool");
      if (execResult !== "continue") return execResult;
      continue;
    }

    // 8. No native tool calls — check content
    const content = msg.content?.trim() ?? "";

    // 8a. In hybrid mode, parse tool calls from text content
    if (hybridMode && content) {
      const parsed = parseLocalAgenticAction(content);

      if (parsed.action?.type === "tool_call") {
        const action = parsed.action as LocalAgenticToolCall;
        const execResult = await executeAndTrack(
          action.tool,
          action.args as Record<string, unknown>,
          msg,
          "user", // hybrid: results go as user messages, not tool role
        );
        if (execResult !== "continue") return execResult;
        continue;
      }

      if (parsed.action?.type === "final") {
        // Reject premature final if no work done
        if (executedCommands.length === 0 && !delegatedWorkCreated && successfulToolCalls === 0) {
          deps.log(`${prefix} turn ${turn}: hybrid premature final rejected — no tools called yet`);
          messages.push(msg);
          messages.push({
            role: "user",
            content: 'You have not called any tools yet. You MUST call a tool first. Start with: {"type":"tool_call","tool":"list_bridges","args":{}}',
          });
          if (turn < config.maxTurns) continue;
          return mkResult({ success: false, error: "Model completed without calling any tools (hybrid mode)" });
        }

        const status = parsed.action.status;
        deps.log(`${prefix} hybrid final(${status}): ${parsed.action.summary}`);
        return mkResult({
          success: status === "completed",
          error: status === "completed" ? undefined : parsed.action.summary,
        });
      }

      // Could not parse — remind the model of the protocol
      deps.log(`${prefix} turn ${turn}: hybrid parse failed — ${parsed.error}`);
      messages.push(msg);
      messages.push({
        role: "user",
        content: 'Invalid response. You must reply with exactly one JSON object. Example: {"type":"tool_call","tool":"list_bridges","args":{}}',
      });
      if (turn < config.maxTurns) continue;
      return mkResult({ success: false, error: "Model could not produce valid JSON in hybrid mode" });
    }

    // 8b. Empty response after commands — done
    if (!content && executedCommands.length > 0) {
      deps.log(`${prefix} Empty final response after commands — treating as done`);
      return mkResult({ success: true });
    }

    // 8c. No tools called yet — detect if we need hybrid mode
    if (executedCommands.length === 0 && !delegatedWorkCreated && successfulToolCalls === 0) {
      if (!hybridMode) {
        // First time: switch to hybrid mode (tools embedded in system prompt)
        hybridMode = true;
        deps.log(`${prefix} No tool_calls from model — switching to hybrid mode (tools in system prompt)`);

        // Replace system message with hybrid prompt that includes JSON protocol + tool defs
        messages[0] = {
          role: "system",
          content: config.toolSchemas
            ? buildHybridSystemFromSchemas(config.toolSchemas, config.systemPrompt)
            : buildOllamaHybridSystemMessage({
                allowDelegation: config.allowDelegationTools,
                allowSkills: true,
                customInstructions: config.systemPrompt,
              }),
        };

        // Try to parse the model's current text output — it might already contain a tool call
        if (content) {
          const parsed = parseLocalAgenticAction(content);
          if (parsed.action?.type === "tool_call") {
            const action = parsed.action as LocalAgenticToolCall;
            const execResult = await executeAndTrack(
              action.tool,
              action.args as Record<string, unknown>,
              msg,
              "user",
            );
            if (execResult !== "continue") return execResult;
            continue;
          }
        }

        // Model didn't produce a parseable tool call — prompt for JSON format
        messages.push(msg);
        messages.push({
          role: "user",
          content: 'You must respond with exactly one JSON object to call a tool. Do NOT describe code. Example: {"type":"tool_call","tool":"list_bridges","args":{}}',
        });
        if (turn < config.maxTurns) continue;
      }

      // Already in hybrid mode and still no tools — stern retry
      deps.log(`${prefix} turn ${turn}: premature completion rejected — no tools called yet`);
      messages.push({
        role: "user",
        content: 'STOP. Do NOT describe code or write plans. Respond with ONLY a JSON object: {"type":"tool_call","tool":"list_bridges","args":{}}',
      });
      if (turn < config.maxTurns) continue;
      return mkResult({ success: false, error: "Model completed without calling any tools" });
    }

    // 8d. Tools were called, model is done — determine status from content.
    // Only mark as failed when the model clearly reports task failure, not
    // incidental use of common words like "need" or "missing" in a summary.
    const lower = content.toLowerCase();
    // Require strong failure signals: "the task failed", "I was unable to", etc.
    // Avoid matching conversational phrases like "let me know if you need"
    const failed =
      /\b(task failed|execution failed|could not complete|unable to (?:complete|finish|execute|perform))\b/.test(lower) ||
      /\b(?:fatal|critical) error\b/.test(lower);
    const status = failed ? "failed" : "completed";

    deps.log(`${prefix} final(${status}): ${content.slice(0, 300)}`);
    return mkResult({
      success: status === "completed",
      error: status === "completed" ? undefined : content,
    });
  }

  // Exhausted all turns
  deps.log(`${prefix} max turns (${config.maxTurns}) reached`);
  return mkResult({
    success: executedCommands.length > 0,
    error: executedCommands.length > 0 ? undefined : `Chat loop hit max turns (${config.maxTurns})`,
  });
}

// ---------------------------------------------------------------------------
// Hybrid system message builder from external tool schemas
// ---------------------------------------------------------------------------

function buildHybridSystemFromSchemas(schemas: OllamaToolSchema[], customInstructions?: string): string {
  const toolDefs = schemas.map((s) => {
    const fn = s.function;
    const props = fn.parameters.properties;
    const required = new Set(fn.parameters.required);
    const paramList = Object.entries(props)
      .map(([name, p]) => `${name}: ${p.type}${required.has(name) ? "" : "?"}`)
      .join(", ");
    return `- ${fn.name}(${paramList})\n  ${fn.description}`;
  }).join("\n");

  const lines = [
    LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
    "",
    "## Available Tools",
    toolDefs,
    "",
    "## CRITICAL: You MUST use tools to execute code",
    "- You are connected to live applications (Blender, Houdini, Godot, ComfyUI) via bridges.",
    "- To make changes, you MUST call execute_command with actual executable code.",
    "- NEVER just describe code or write instructions. Always call the tool.",
    "- Each command runs in its own isolated scope. Variables do NOT persist between commands.",
    "- Write one complete self-contained script per execute_command call.",
    "- For Godot/GDScript: entrypoint must be `func run(editor: EditorInterface) -> void:`",
    "",
    "## Workflow",
    "1. Call list_bridges to see connected apps",
    "2. Call search_skills to find relevant patterns",
    "3. Call execute_command with the actual script to run in the app",
    "4. If it fails, fix the script and try again with a DIFFERENT approach",
    '5. When done, return {"type":"final","status":"completed","summary":"what you did"}',
    "",
    "## Skills",
    "- FIRST search_skills for your task type before writing code.",
    "- After completing work, call create_skill if you learned something non-trivial.",
    "- Rate skills you used with rate_skill.",
  ];

  if (customInstructions) {
    lines.push("", "## Additional Context", customInstructions);
  }

  return lines.join("\n");
}
