/**
 * Parser for JSONL output from Claude Code and Codex CLI.
 *
 * Claude Code event types (`--output-format stream-json --verbose`):
 * - system: init info (tools, model, session)
 * - assistant: model response with content blocks (text, tool_use)
 * - tool_use: agent is calling a tool
 * - tool_result: result from a tool call
 * - result: final summary with accumulated text, cost, duration
 *
 * Codex CLI event types (`--json`):
 * - thread.started: session init
 * - turn.started: new turn
 * - item.completed: completed item (agent_message with text, function_call, etc.)
 * - turn.completed: turn done with usage (input_tokens, output_tokens)
 *
 * This parser extracts human-readable log messages for real-time streaming
 * and accumulates the plain text output for downstream parsing (e.g., code blocks).
 */

export interface StreamJsonState {
  /** Partial line buffer for incomplete chunks */
  lineBuf: string;
  /** Accumulated plain text from assistant responses (for parseCommandOutput) */
  plainText: string;
  /** Last tool that was called (for context in log messages) */
  lastTool: string;
  /** Token usage extracted from the final `result` event */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  /** Set to true when the final `result` event is received — signals the agent is done */
  resultReceived: boolean;
  /** Claude CLI session ID for --resume support */
  sessionId: string;
}

export function createStreamJsonState(): StreamJsonState {
  return { lineBuf: "", plainText: "", lastTool: "", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, resultReceived: false, sessionId: "" };
}

export interface ParsedLogLine {
  /** Human-readable message to send via job_log WS message */
  display: string;
  /** Set when a tool call violates a command_filter policy — spawner should kill the agent */
  policyViolation?: string;
}

/**
 * Callback to check a command script against active policies.
 * Returns a violation message string if blocked, or null if allowed.
 */
export type CommandPolicyChecker = (command: string) => string | null;

/**
 * Process a chunk of stream-json stdout data.
 * Returns an array of human-readable log lines to send to the client.
 *
 * @param commandChecker — optional callback that checks Bash commands against
 *   command_filter policies in real time. When a violation is detected, the
 *   returned ParsedLogLine will include a `policyViolation` field.
 */
export function processStreamJsonChunk(
  state: StreamJsonState,
  chunk: string,
  commandChecker?: CommandPolicyChecker,
): ParsedLogLine[] {
  const results: ParsedLogLine[] = [];

  // Append chunk to line buffer and split on newlines
  state.lineBuf += chunk;
  const lines = state.lineBuf.split("\n");
  // Last element is either empty (if chunk ended with \n) or an incomplete line
  state.lineBuf = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Not valid JSON — pass through as raw text
      results.push({ display: trimmed });
      continue;
    }

    const parsed = parseEvent(state, event, commandChecker);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

function parseEvent(state: StreamJsonState, event: any, commandChecker?: CommandPolicyChecker): ParsedLogLine | null {
  switch (event.type) {
    case "system":
      if (event.session_id && typeof event.session_id === "string") {
        state.sessionId = event.session_id.trim() || state.sessionId;
      }
      if (event.subtype === "init") {
        return { display: `[init] model=${event.model} tools=${event.tools?.length ?? 0}` };
      }
      return null;

    case "assistant": {
      // Assistant message with content blocks
      const msg = event.message;
      if (!msg?.content) return null;
      // Accumulate per-turn token usage from assistant message events
      const msgUsage = msg.usage ?? event.usage;
      if (msgUsage) {
        if (typeof msgUsage.input_tokens === "number") state.inputTokens += msgUsage.input_tokens;
        if (typeof msgUsage.output_tokens === "number") state.outputTokens += msgUsage.output_tokens;
      }
      const parts: string[] = [];
      let violation: string | undefined;
      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinking) {
          // Extended thinking / reasoning block — show a preview so logs
          // surface the model's reasoning chain.
          const preview = block.thinking.length > 800
            ? block.thinking.slice(0, 800) + "..."
            : block.thinking;
          parts.push(`[thinking] ${preview}`);
        } else if (block.type === "text" && block.text) {
          state.plainText += block.text;
          // Show a generous preview of assistant text (500 chars)
          const preview = block.text.length > 500
            ? block.text.slice(0, 500) + "..."
            : block.text;
          parts.push(preview);
        } else if (block.type === "tool_use") {
          state.lastTool = block.name ?? "unknown";
          const input = block.input ?? {};
          const toolDisplay = formatToolUse(block.name, input);
          parts.push(toolDisplay);
          // Real-time policy check for Bash commands
          if (commandChecker && block.name === "Bash" && input.command) {
            const v = commandChecker(input.command);
            if (v) violation = v;
          }
        }
      }
      if (parts.length > 0) {
        const result: ParsedLogLine = { display: parts.join("\n") };
        if (violation) result.policyViolation = violation;
        return result;
      }
      return null;
    }

    case "tool_use": {
      state.lastTool = event.name ?? "unknown";
      const input = event.input ?? {};
      const toolDisplay = formatToolUse(event.name, input);
      const result: ParsedLogLine = { display: toolDisplay };
      // Real-time policy check for Bash commands
      if (commandChecker && event.name === "Bash" && input.command) {
        const v = commandChecker(input.command);
        if (v) result.policyViolation = v;
      }
      return result;
    }

    case "tool_result": {
      // Show a brief summary of tool results
      const content = event.content ?? event.output ?? "";
      const text = typeof content === "string"
        ? content
        : JSON.stringify(content);
      if (text.length > 0) {
        const preview = text.length > 500
          ? text.slice(0, 500) + `... (${text.length} chars)`
          : text;
        return { display: `[${state.lastTool} result] ${preview}` };
      }
      return null;
    }

    case "result": {
      // Final result — extract text for parseCommandOutput
      state.resultReceived = true;
      if (event.session_id && typeof event.session_id === "string") {
        state.sessionId = event.session_id.trim() || state.sessionId;
      }
      if (event.result && typeof event.result === "string") {
        state.plainText += event.result;
      }
      // Capture token usage from the result event.
      // Claude Code puts tokens at top-level (input_tokens, output_tokens) or
      // in a nested `usage` object (usage.input_tokens, usage.output_tokens).
      const usage = event.usage ?? {};
      state.inputTokens =
        event.input_tokens ?? event.inputTokens ??
        usage.input_tokens ?? usage.inputTokens ??
        state.inputTokens;
      state.outputTokens =
        event.output_tokens ?? event.outputTokens ??
        usage.output_tokens ?? usage.outputTokens ??
        state.outputTokens;
      state.costUsd = event.total_cost_usd ?? event.total_cost ?? event.cost_usd ?? state.costUsd;
      state.durationMs = event.duration_ms ?? event.duration_api_ms ?? state.durationMs;
      const cost = state.costUsd
        ? `$${state.costUsd.toFixed(4)}`
        : "";
      const duration = state.durationMs
        ? `${(state.durationMs / 1000).toFixed(1)}s`
        : "";
      const turns = event.num_turns ? `${event.num_turns} turns` : "";
      const parts = [turns, duration, cost].filter(Boolean);
      return { display: `[done] ${parts.join(", ")}` };
    }

    // ── Codex CLI event types ──
    case "thread.started":
      return { display: `[init] thread=${event.thread_id ?? "?"}` };

    case "turn.started":
      return null; // No useful info to display

    case "item.completed": {
      const item = event.item;
      if (!item) return null;
      if (item.type === "agent_message" && item.text) {
        state.plainText += item.text;
        const preview = item.text.length > 500
          ? item.text.slice(0, 500) + "..."
          : item.text;
        return { display: preview };
      }
      if (item.type === "function_call" || item.type === "tool_call") {
        const name = item.name ?? item.function?.name ?? "tool";
        state.lastTool = name;
        return { display: `[${name}]` };
      }
      if (item.type === "function_call_output" || item.type === "tool_call_output") {
        const output = item.output ?? item.text ?? "";
        const preview = typeof output === "string"
          ? (output.length > 500 ? output.slice(0, 500) + "..." : output)
          : JSON.stringify(output).slice(0, 500);
        return { display: `[${state.lastTool} result] ${preview}` };
      }
      return null;
    }

    case "turn.completed": {
      // Codex emits token usage per turn
      const usage = event.usage;
      if (usage) {
        if (typeof usage.input_tokens === "number") state.inputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === "number") state.outputTokens += usage.output_tokens;
      }
      return null;
    }

    default:
      return null;
  }
}

/** Format a tool use event into a concise human-readable string */
function formatToolUse(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read":
      return `[Read] ${input.file_path ?? ""}`;
    case "Write":
      return `[Write] ${input.file_path ?? ""}`;
    case "Edit":
      return `[Edit] ${input.file_path ?? ""}`;
    case "Bash":
      return `[Bash] ${(input.command ?? "").slice(0, 200)}`;
    case "Glob":
      return `[Glob] ${input.pattern ?? ""}`;
    case "Grep":
      return `[Grep] ${input.pattern ?? ""} in ${input.path ?? "."}`;
    case "WebSearch":
      return `[WebSearch] ${input.query ?? ""}`;
    case "WebFetch":
      return `[WebFetch] ${input.url ?? ""}`;
    case "Task":
      return `[Task] ${input.description ?? input.prompt?.slice(0, 100) ?? ""}`;
    case "Skill":
      return `[Skill] ${input.skill ?? ""}`;
    // MCP tools from Arkestrator
    case "arkestrator__execute_command":
      return `[execute_command] ${input.target ?? ""}/${input.language ?? ""}: ${(input.script ?? "").slice(0, 200)}`;
    case "arkestrator__execute_multiple_commands":
      return `[execute_multiple_commands] ${input.target ?? ""}: ${input.commands?.length ?? 0} commands`;
    case "arkestrator__create_job":
      return `[create_job] ${input.name ?? input.target_program ?? "sub-job"}: ${(input.prompt ?? "").slice(0, 150)}`;
    case "arkestrator__get_job_status":
      return `[get_job_status] ${input.job_id ?? ""}`;
    case "arkestrator__list_bridges":
      return `[list_bridges]`;
    case "arkestrator__get_bridge_context":
      return `[get_bridge_context] ${input.target ?? ""}`;
    case "arkestrator__run_headless_check":
      return `[run_headless_check] ${input.program ?? ""}`;
    case "arkestrator__list_agent_configs":
      return `[list_agent_configs]`;
    case "arkestrator__list_jobs":
      return `[list_jobs] ${input.status ?? "all"}`;
    default:
      return `[${name}]`;
  }
}
