import { describe, expect, it } from "bun:test";
import { createTestDb } from "./setup.js";
import { updateWorkerRule } from "../security/worker-rules.js";
import {
  checkWorkerLocalLlmHealth,
  resolveWorkerLocalLlmEndpoint,
} from "../local-models/distributed.js";

describe("distributed local LLM routing", () => {
  it("keeps worker routing disabled by default", () => {
    const ctx = createTestDb();
    ctx.workersRepo.upsert("Node-A", "houdini", "/projects/demo", "10.0.0.8");

    const resolution = resolveWorkerLocalLlmEndpoint(
      ctx.settingsRepo,
      ctx.workersRepo,
      "node-a",
    );
    expect(resolution.enabled).toBe(false);
    expect(resolution.baseUrl).toBeNull();
  });

  it("resolves worker endpoint from worker IP when enabled without explicit URL", () => {
    const ctx = createTestDb();
    ctx.workersRepo.upsert("Node-B", "houdini", "/projects/demo", "10.0.0.9");
    updateWorkerRule(ctx.settingsRepo, "node-b", { localLlmEnabled: true });

    const resolution = resolveWorkerLocalLlmEndpoint(
      ctx.settingsRepo,
      ctx.workersRepo,
      "node-b",
    );
    expect(resolution.enabled).toBe(true);
    expect(resolution.source).toBe("worker-ip");
    expect(resolution.baseUrl).toBe("http://10.0.0.9:11434");
  });

  it("prefers explicit base URL from worker rules", () => {
    const ctx = createTestDb();
    ctx.workersRepo.upsert("Node-C", "houdini", "/projects/demo", "10.0.0.10");
    updateWorkerRule(ctx.settingsRepo, "node-c", {
      localLlmEnabled: true,
      localLlmBaseUrl: "192.168.1.44:11500/",
    });

    const resolution = resolveWorkerLocalLlmEndpoint(
      ctx.settingsRepo,
      ctx.workersRepo,
      "node-c",
    );
    expect(resolution.enabled).toBe(true);
    expect(resolution.source).toBe("rule");
    expect(resolution.baseUrl).toBe("http://192.168.1.44:11500");
  });

  it("checks worker local LLM health via ollama tags endpoint", async () => {
    let seenUrl = "";
    const result = await checkWorkerLocalLlmHealth(
      "http://127.0.0.1:11434",
      2_000,
      ((input: any) => {
        seenUrl = String(input);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [{ name: "llama3.2:latest" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }) as typeof fetch,
    );
    expect(seenUrl).toContain("/api/tags");
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(result.models[0]).toBe("llama3.2:latest");
  });

  it("reports endpoint errors in health checks", async () => {
    const result = await checkWorkerLocalLlmHealth(
      "http://127.0.0.1:11434",
      2_000,
      (() => Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to list models from Ollama");
  });
});
