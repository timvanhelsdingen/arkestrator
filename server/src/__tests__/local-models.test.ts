import { describe, expect, test } from "bun:test";
import { listOllamaModels, pullOllamaModel, streamPullOllamaModel } from "../local-models/ollama.js";

describe("ollama local model utilities", () => {
  test("lists models from /api/tags payload", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "llama3.2:latest", size: 4_200_000_000, modified_at: "2026-02-20T10:00:00Z", digest: "sha256:abc" },
            { name: "qwen2.5-coder:7b" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as any;

    const models = await listOllamaModels(mockFetch, "http://127.0.0.1:11434");
    expect(models.length).toBe(2);
    expect(models[0]?.name).toBe("llama3.2:latest");
    expect(models[0]?.sizeBytes).toBe(4_200_000_000);
    expect(models[1]?.name).toBe("qwen2.5-coder:7b");
  });

  test("throws with clear message when list endpoint fails", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "daemon unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as any;

    await expect(listOllamaModels(mockFetch, "http://127.0.0.1:11434")).rejects.toThrow(
      "Failed to list models from Ollama (503): daemon unavailable",
    );
  });

  test("pulls model via /api/pull with stream=false", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = String(init?.method ?? "");
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ status: "success", digest: "sha256:def" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await pullOllamaModel("llama3.2:latest", mockFetch, "http://127.0.0.1:11434");
    expect(seenUrl).toBe("http://127.0.0.1:11434/api/pull");
    expect(seenMethod).toBe("POST");
    expect(seenBody).toContain('"model":"llama3.2:latest"');
    expect(seenBody).toContain('"stream":false');
    expect(result.status).toBe("success");
  });

  test("streams pull progress from /api/pull when stream=true", async () => {
    let seenBody = "";
    const encoder = new TextEncoder();
    const mockFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body ?? "");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"status":"pulling manifest"}\n'));
          controller.enqueue(encoder.encode('{"status":"pulling","total":100,"completed":40}\n'));
          controller.enqueue(encoder.encode('{"status":"success","total":100,"completed":100}\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }) as any;

    const progress: Array<{ status?: string; total?: number; completed?: number }> = [];
    const last = await streamPullOllamaModel(
      "llama3.2:latest",
      (event) => {
        progress.push({
          status: event.status,
          total: event.total,
          completed: event.completed,
        });
      },
      mockFetch,
      "http://127.0.0.1:11434",
    );

    expect(seenBody).toContain('"stream":true');
    expect(progress.length).toBe(3);
    expect(progress[1]?.completed).toBe(40);
    expect(last?.status).toBe("success");
    expect(last?.completed).toBe(100);
  });
});
