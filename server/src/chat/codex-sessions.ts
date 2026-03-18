import type { JobRuntimeOptions } from "@arkestrator/protocol";

export interface CodexChatSessionRecord {
  threadId: string;
  updatedAt: number;
}

interface CodexChatSessionManagerOptions {
  ttlMs?: number;
  maxSessions?: number;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForStableJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export function buildCodexChatSessionKey(input: {
  principalKey: string;
  conversationKey: string;
  agentConfigId: string;
  command: string;
  model?: string | null;
  runtimeOptions?: JobRuntimeOptions;
}): string {
  return stableJson({
    principalKey: input.principalKey,
    conversationKey: input.conversationKey,
    agentConfigId: input.agentConfigId,
    command: input.command,
    model: input.model ?? "",
    runtimeOptions: input.runtimeOptions ?? {},
  });
}

export class CodexChatSessionManager {
  private readonly sessions = new Map<string, CodexChatSessionRecord>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(options: CodexChatSessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 256;
  }

  get(key: string, now = Date.now()): CodexChatSessionRecord | null {
    this.purgeExpired(now);
    const session = this.sessions.get(key);
    if (!session) return null;
    session.updatedAt = now;
    return session;
  }

  set(key: string, threadId: string, now = Date.now()) {
    this.purgeExpired(now);
    this.sessions.set(key, { threadId, updatedAt: now });
    this.trimToSize();
  }

  delete(key: string) {
    this.sessions.delete(key);
  }

  private purgeExpired(now: number) {
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  private trimToSize() {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | null = null;
      let oldestUpdatedAt = Number.POSITIVE_INFINITY;
      for (const [key, session] of this.sessions.entries()) {
        if (session.updatedAt < oldestUpdatedAt) {
          oldestUpdatedAt = session.updatedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }
}

interface CodexJsonStreamEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: {
    id?: unknown;
    type?: unknown;
    text?: unknown;
  };
}

export interface CodexJsonStreamState {
  buffer: string;
  sentTextByItemId: Map<string, string>;
}

export function createCodexJsonStreamState(): CodexJsonStreamState {
  return {
    buffer: "",
    sentTextByItemId: new Map(),
  };
}

function extractAgentMessageDelta(
  item: CodexJsonStreamEvent["item"],
  sentTextByItemId: Map<string, string>,
): string | null {
  if (!item || item.type !== "agent_message" || typeof item.text !== "string") {
    return null;
  }
  const itemId = typeof item.id === "string" && item.id.trim() ? item.id : "__agent__";
  const previous = sentTextByItemId.get(itemId) ?? "";
  const next = item.text;
  sentTextByItemId.set(itemId, next);
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function processCodexJsonLine(
  line: string,
  state: CodexJsonStreamState,
): { textChunks: string[]; threadId?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { textChunks: [] };

  let parsed: CodexJsonStreamEvent;
  try {
    parsed = JSON.parse(trimmed) as CodexJsonStreamEvent;
  } catch {
    return { textChunks: [line] };
  }

  const textChunks: string[] = [];
  const delta = extractAgentMessageDelta(parsed.item, state.sentTextByItemId);
  if (delta) {
    textChunks.push(delta);
  }

  return {
    textChunks,
    threadId: typeof parsed.thread_id === "string" && parsed.thread_id.trim()
      ? parsed.thread_id
      : undefined,
  };
}

export function consumeCodexJsonChunk(
  state: CodexJsonStreamState,
  chunk: string,
): { textChunks: string[]; threadId?: string } {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  const textChunks: string[] = [];
  let threadId: string | undefined;
  for (const line of lines) {
    const parsed = processCodexJsonLine(line, state);
    textChunks.push(...parsed.textChunks);
    if (parsed.threadId) {
      threadId = parsed.threadId;
    }
  }
  return { textChunks, threadId };
}

export function flushCodexJsonChunk(
  state: CodexJsonStreamState,
): { textChunks: string[]; threadId?: string } {
  if (!state.buffer.trim()) {
    state.buffer = "";
    return { textChunks: [] };
  }
  const parsed = processCodexJsonLine(state.buffer, state);
  state.buffer = "";
  return parsed;
}
