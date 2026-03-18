import { describe, expect, test } from "bun:test";
import { buildLocalCliArgs } from "../agents/local-args.js";

describe("buildLocalCliArgs", () => {
  test("replaces model placeholder and appends prompt when prompt placeholder is absent", () => {
    const prompt = "hello world";
    expect(buildLocalCliArgs(["run", "{{MODEL}}"], prompt, "llama3.2:latest")).toEqual([
      "run",
      "llama3.2:latest",
      prompt,
    ]);
  });

  test("replaces prompt placeholder and does not append trailing prompt", () => {
    const prompt = "summarize this";
    expect(
      buildLocalCliArgs(["--model", "{{MODEL}}", "--prompt", "{{PROMPT}}"], prompt, "qwen2.5-coder"),
    ).toEqual(["--model", "qwen2.5-coder", "--prompt", prompt]);
  });

  test("drops empty model placeholder args instead of passing literal placeholder", () => {
    const prompt = "test prompt";
    expect(buildLocalCliArgs(["run", "{{MODEL}}"], prompt)).toEqual(["run", prompt]);
  });
});
