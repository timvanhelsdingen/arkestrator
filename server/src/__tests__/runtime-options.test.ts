import { describe, expect, test } from "bun:test";
import type { AgentConfig, JobRuntimeOptions } from "@arkestrator/protocol";
import {
  applyPromptBridgeExecutionMode,
  applyRuntimeOptionsToConfig,
  inferPromptBridgeExecutionMode,
  normalizeJobRuntimeOptions,
  resolveModelForRun,
} from "../agents/runtime-options.js";

const baseConfig: AgentConfig = {
  id: crypto.randomUUID(),
  name: "Codex Base",
  engine: "codex",
  command: "codex",
  args: ["--full-auto", "-c", "model_reasoning_effort=\"low\""],
  model: "gpt-5-codex",
  maxTurns: 200,
  priority: 50,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("runtime options", () => {
  test("normalizes runtime options and trims model", () => {
    const runtime: JobRuntimeOptions = {
      model: "  qwen2.5-coder:14b  ",
      reasoningLevel: "xhigh",
      verificationMode: "optional",
      verificationWeight: 64.7,
      bridgeExecutionMode: "headless",
    };
    const normalized = normalizeJobRuntimeOptions(runtime);
    expect(normalized).toEqual({
      model: "qwen2.5-coder:14b",
      reasoningLevel: "xhigh",
      verificationMode: "optional",
      verificationWeight: 65,
      bridgeExecutionMode: "headless",
    });
  });

  test("drops invalid runtime reasoning values", () => {
    const normalized = normalizeJobRuntimeOptions({
      model: " ",
      reasoningLevel: "max" as any,
    });
    expect(normalized).toBeUndefined();
  });

  test("drops invalid verification values while preserving valid runtime fields", () => {
    const normalized = normalizeJobRuntimeOptions({
      model: "gpt-5",
      verificationMode: "strict" as any,
      verificationWeight: 999 as any,
    });
    expect(normalized).toEqual({ model: "gpt-5" });
  });

  test("resolves model override over config model", () => {
    const runtime: JobRuntimeOptions = { model: "llama3.2:8b" };
    expect(resolveModelForRun("gpt-5-codex", runtime)).toBe("llama3.2:8b");
    expect(resolveModelForRun("gpt-5-codex", undefined)).toBe("gpt-5-codex");
  });

  test("applies codex reasoning override and removes stale reasoning args", () => {
    const effective = applyRuntimeOptionsToConfig(baseConfig, {
      reasoningLevel: "medium",
      model: "gpt-5",
    });
    expect(effective.model).toBe("gpt-5");
    expect(effective.args).toContain("--full-auto");
    expect(effective.args).toContain("-c");
    expect(effective.args).toContain("model_reasoning_effort=\"medium\"");
    expect(effective.args).not.toContain("model_reasoning_effort=\"low\"");
  });

  test("leaves non-codex args unchanged while applying model override", () => {
    const claudeConfig: AgentConfig = {
      ...baseConfig,
      engine: "claude-code",
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      model: "claude-sonnet-4-5-20250929",
    };
    const effective = applyRuntimeOptionsToConfig(claudeConfig, {
      model: "claude-opus-4-1",
      reasoningLevel: "high",
    });
    expect(effective.model).toBe("claude-opus-4-1");
    expect(effective.args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("does not rewrite codex args for verification-only runtime overrides", () => {
    const effective = applyRuntimeOptionsToConfig(baseConfig, {
      verificationMode: "disabled",
      verificationWeight: 5,
    });
    expect(effective.model).toBe("gpt-5-codex");
    expect(effective.args).toEqual(baseConfig.args);
  });

  test("infers headless bridge execution from prompt wording", () => {
    expect(
      inferPromptBridgeExecutionMode("Use headless Blender in a separate background process and do not touch my active session."),
    ).toBe("headless");
    expect(
      inferPromptBridgeExecutionMode("Build me a CLI exporter for this project."),
    ).toBeUndefined();
  });

  test("applies prompt-derived bridge execution mode without overwriting explicit runtime choice", () => {
    expect(
      applyPromptBridgeExecutionMode(
        "Use CLI/headless mode for this run.",
        { model: "gpt-5" },
      ),
    ).toEqual({
      model: "gpt-5",
      bridgeExecutionMode: "headless",
    });

    expect(
      applyPromptBridgeExecutionMode(
        "Use headless mode.",
        { bridgeExecutionMode: "live" },
      ),
    ).toEqual({
      bridgeExecutionMode: "live",
    });
  });
});
