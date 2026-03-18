import { describe, expect, test } from "bun:test";
import { createTestDb } from "./setup.js";
import {
  buildLocalModelCatalog,
  getEffectiveLocalModelAllowlist,
  getStoredLocalModelAllowlist,
  setStoredLocalModelAllowlist,
} from "../local-models/catalog.js";

describe("local model catalog + allowlist", () => {
  test("defaults allowlist to downloaded models when no stored allowlist exists", () => {
    const ctx = createTestDb();
    const downloaded = [
      { name: "qwen2.5-coder:7b" },
      { name: "qwen2.5-coder:14b" },
    ];

    const stored = getStoredLocalModelAllowlist(ctx.settingsRepo, "ollama");
    expect(stored.hasStored).toBe(false);
    expect(stored.models).toEqual([]);

    expect(getEffectiveLocalModelAllowlist(ctx.settingsRepo, "ollama", downloaded)).toEqual([
      "qwen2.5-coder:14b",
      "qwen2.5-coder:7b",
    ]);
  });

  test("persists explicit allowlist and builds catalog download/allow flags", () => {
    const ctx = createTestDb();
    const allowed = setStoredLocalModelAllowlist(ctx.settingsRepo, "ollama", [
      "qwen2.5-coder:14b",
      "qwen2.5-coder:32b",
    ]);
    expect(allowed).toEqual(["qwen2.5-coder:14b", "qwen2.5-coder:32b"]);

    const downloaded = [
      { name: "qwen2.5-coder:14b", sizeBytes: 8_000_000_000 },
      { name: "llama3.2:latest", sizeBytes: 4_200_000_000 },
    ];
    const catalog = buildLocalModelCatalog(downloaded, allowed);

    const fourteen = catalog.find((entry) => entry.name === "qwen2.5-coder:14b");
    const thirtyTwo = catalog.find((entry) => entry.name === "qwen2.5-coder:32b");
    const llama = catalog.find((entry) => entry.name === "llama3.2:latest");

    expect(fourteen?.allowed).toBe(true);
    expect(fourteen?.downloaded).toBe(true);
    expect(thirtyTwo?.allowed).toBe(true);
    expect(thirtyTwo?.downloaded).toBe(false);
    expect(llama?.allowed).toBe(false);
    expect(llama?.downloaded).toBe(true);
  });
});
