import type { AgentManagerConfig } from "../config";

export interface ChatStreamOptions {
  prompt: string;
  agentConfigId: string;
  history?: { role: string; content: string }[];
}

/**
 * Stream a chat response via SSE from POST /api/chat.
 * Calls onChunk for each text chunk. Returns the full response.
 * Supports cancellation via AbortSignal.
 */
export async function streamChat(
  config: AgentManagerConfig,
  options: ChatStreamOptions,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const res = await fetch(`${config.serverUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(options),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat error ${res.status}: ${text}`);
  }

  let fullResponse = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const msg = JSON.parse(jsonStr);
          if (msg.type === "text") {
            fullResponse += msg.content;
            onChunk(msg.content);
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        } catch (e: any) {
          if (e.message && !e.message.includes("JSON")) throw e;
        }
      }
    }
  }

  return fullResponse;
}
