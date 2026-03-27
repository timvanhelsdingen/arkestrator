/**
 * Claude Code `--output-format stream-json` NDJSON parser for chat.
 *
 * Claude outputs newline-delimited JSON events:
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}],...}}
 *   {"type":"result","subtype":"success","session_id":"...","result":"Hello!","total_cost_usd":...}
 *
 * We extract text from assistant message content blocks and capture the session_id
 * from init/result events for session resumption via `--resume <sessionId>`.
 */

export interface ClaudeJsonStreamState {
  buffer: string;
  /** Accumulated full text so far (for delta computation on accumulated assistant text) */
  lastText: string;
}

export function createClaudeJsonStreamState(): ClaudeJsonStreamState {
  return { buffer: "", lastText: "" };
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  /** Result event: accumulated plain text output */
  result?: string;
  /** Result event: whether it's an error */
  is_error?: boolean;
  /** Result event: error messages */
  errors?: string[];
  /** Assistant event: message with content blocks */
  message?: {
    content?: ContentBlock[];
  };
}

function processClaudeLine(
  line: string,
  state: ClaudeJsonStreamState,
): { textChunks: string[]; sessionId?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { textChunks: [] };

  let parsed: ClaudeStreamEvent;
  try {
    parsed = JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    // Not JSON — treat as plain text output (fallback)
    return { textChunks: [line] };
  }

  const textChunks: string[] = [];
  let sessionId: string | undefined;

  // Capture session_id from init or result events
  if (parsed.session_id && typeof parsed.session_id === "string") {
    sessionId = parsed.session_id.trim() || undefined;
  }

  // Extract text from assistant message content blocks
  // Format: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
  if (parsed.type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        // Claude sends the full accumulated text per content block.
        // For chat streaming, the assistant event typically arrives once
        // with the complete text (not incremental deltas), so emit it as-is
        // after removing any portion we've already sent.
        const fullText = block.text;
        if (fullText.length > state.lastText.length && fullText.startsWith(state.lastText)) {
          textChunks.push(fullText.slice(state.lastText.length));
        } else if (fullText !== state.lastText) {
          // New content block or replaced text — emit full
          textChunks.push(fullText);
        }
        state.lastText = fullText;
      }
    }
  }

  // Handle result events — extract final text or error messages
  if (parsed.type === "result") {
    // Surface error messages from failed runs (e.g. stale --resume session)
    if (parsed.is_error && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      textChunks.push(parsed.errors.join("\n"));
    } else if (typeof parsed.result === "string") {
      const resultText = parsed.result;
      // Only emit if we haven't already streamed this text via assistant events
      if (resultText.length > state.lastText.length && resultText.startsWith(state.lastText)) {
        textChunks.push(resultText.slice(state.lastText.length));
      } else if (resultText !== state.lastText && !state.lastText) {
        // No assistant text was received — emit the result directly
        textChunks.push(resultText);
      }
      state.lastText = resultText;
    }
  }

  return { textChunks, sessionId };
}

export function consumeClaudeJsonChunk(
  state: ClaudeJsonStreamState,
  chunk: string,
): { textChunks: string[]; sessionId?: string } {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  const textChunks: string[] = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    const result = processClaudeLine(line, state);
    textChunks.push(...result.textChunks);
    if (result.sessionId) sessionId = result.sessionId;
  }
  return { textChunks, sessionId };
}

export function flushClaudeJsonChunk(
  state: ClaudeJsonStreamState,
): { textChunks: string[]; sessionId?: string } {
  if (!state.buffer.trim()) {
    state.buffer = "";
    return { textChunks: [] };
  }
  const result = processClaudeLine(state.buffer, state);
  state.buffer = "";
  return result;
}
