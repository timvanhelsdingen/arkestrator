/**
 * Claude Code `--output-format stream-json` NDJSON parser.
 *
 * Claude outputs newline-delimited JSON events:
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
 *   {"type":"assistant","subtype":"text","text":"Hello!"}
 *   {"type":"result","subtype":"success","session_id":"...","cost_usd":...}
 *
 * We extract text deltas from assistant messages and capture the session_id
 * from init/result events for session resumption via `--resume <sessionId>`.
 */

export interface ClaudeJsonStreamState {
  buffer: string;
  /** Accumulated full text per message (for delta computation) */
  lastText: string;
}

export function createClaudeJsonStreamState(): ClaudeJsonStreamState {
  return { buffer: "", lastText: "" };
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  text?: string;
  content?: string;
  message?: string;
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

  // Extract text from assistant messages
  if (parsed.type === "assistant" && typeof parsed.text === "string") {
    // Claude sends full accumulated text — compute delta
    const fullText = parsed.text;
    if (fullText.length > state.lastText.length && fullText.startsWith(state.lastText)) {
      textChunks.push(fullText.slice(state.lastText.length));
    } else if (fullText !== state.lastText) {
      // Text was replaced (shouldn't happen, but handle gracefully)
      textChunks.push(fullText);
    }
    state.lastText = fullText;
  }

  // Also handle content_block_delta style events (Claude API format)
  if (parsed.type === "content_block_delta" && typeof parsed.content === "string") {
    textChunks.push(parsed.content);
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
