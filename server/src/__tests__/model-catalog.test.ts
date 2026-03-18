import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadClaudeModelCatalogFromLocalState,
  loadCodexModelCatalogFromCache,
} from "../agents/model-catalog.js";

describe("provider model catalog", () => {
  test("loads Claude model suggestions from local Claude runtime state and prefers the newest best model", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-claude-model-catalog-"));
    const debugDir = join(dir, "debug");
    const projectsDir = join(dir, "projects");
    const appAsarPath = join(dir, "app.asar");
    mkdirSync(debugDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    writeFileSync(join(debugDir, "recent.txt"), [
      "Using model claude-opus-4-6 for this session",
      "Fallback model claude-sonnet-4-6 also available",
      "Ignore claude-opus-4-5-migration internal marker",
    ].join("\n"), "utf8");
    writeFileSync(join(projectsDir, "session.jsonl"), [
      "{\"model\":\"claude-sonnet-4-5-20250929\"}",
      "{\"model\":\"claude-haiku-4-5-20251001\"}",
    ].join("\n"), "utf8");
    writeFileSync(appAsarPath, Buffer.from("claude-opus-4-1-20250805-v1\nclaude-opus-4-20250514", "utf8"));

    try {
      const catalog = loadClaudeModelCatalogFromLocalState({
        claudeDir: dir,
        appAsarPath,
      });
      expect(catalog).not.toBeNull();
      expect(catalog?.models).toEqual([
        "claude-opus-4-6",
        "claude-opus-4-1-20250805",
        "claude-opus-4-20250514",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
      ]);
      expect(catalog?.preferredDefaultModel).toBe("claude-opus-4-6");
      expect(catalog?.source).toBe("claude-local-state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads codex model suggestions and reasoning levels from the local cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-model-catalog-"));
    const cachePath = join(dir, "models_cache.json");
    writeFileSync(cachePath, JSON.stringify({
      models: [
        {
          slug: "gpt-5.3-codex",
          visibility: "list",
          supported_in_api: true,
          priority: 2,
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.4",
          visibility: "list",
          supported_in_api: true,
          priority: 0,
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        {
          slug: "hidden-model",
          visibility: "hidden",
          supported_in_api: true,
        },
      ],
    }), "utf8");

    try {
      const catalog = loadCodexModelCatalogFromCache(cachePath);
      expect(catalog).not.toBeNull();
      expect(catalog?.models).toEqual(["gpt-5.3-codex", "gpt-5.4"]);
      expect(catalog?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh"]);
      expect(catalog?.source).toBe("codex-cache");
      expect(catalog?.preferredDefaultModel).toBe("gpt-5.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the codex cache cannot be parsed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-model-catalog-"));
    const cachePath = join(dir, "models_cache.json");
    writeFileSync(cachePath, "{ invalid json", "utf8");

    try {
      expect(loadCodexModelCatalogFromCache(cachePath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
