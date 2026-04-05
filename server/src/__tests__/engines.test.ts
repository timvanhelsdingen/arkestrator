import { describe, test, expect } from "bun:test";
import type { AgentConfig, Job } from "@arkestrator/protocol";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_ORCHESTRATOR_PROMPT,
  buildCommand,
} from "../agents/engines";
import { existsSync } from "node:fs";
import { writeInjectedMcpConfig } from "../agents/spawner.js";

function getResolvedPrompt(spec: { args: string[] }): string {
  const lastArg = spec.args[spec.args.length - 1] ?? "";
  if (!lastArg.includes("Read the full user request from this UTF-8 file")) {
    return lastArg;
  }
  const lines = lastArg.split("\\n");
  const promptPath = lines[1] ?? "";
  if (!promptPath || !existsSync(promptPath)) return lastArg;
  return readFileSync(promptPath, "utf-8");
}

function withMockedGetuid(value: number | undefined, fn: () => void): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  if (value === undefined) {
    delete (process as NodeJS.Process & { getuid?: () => number }).getuid;
  } else {
    Object.defineProperty(process, "getuid", {
      value: () => value,
      configurable: true,
    });
  }

  try {
    fn();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, "getuid", originalDescriptor);
    } else {
      delete (process as NodeJS.Process & { getuid?: () => number }).getuid;
    }
  }
}

describe("buildCommand (codex orchestration)", () => {
  test("injects orchestration instructions and Codex CLI bridge guidance", () => {
    const config: AgentConfig = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Codex",
      engine: "codex",
      command: "codex",
      args: [],
      model: "gpt-5-codex",
      maxTurns: 300,
      systemPrompt: "Config-level instructions.",
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "22222222-2222-4222-8222-222222222222",
      status: "queued",
      priority: "normal",
      prompt: "Build a marble material and apply it to the sphere.",
      agentConfigId: config.id,
      coordinationMode: "server",
      bridgeProgram: "godot",
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const workspace: any = {
      mode: "repo",
      cwd: process.cwd(),
      needsSync: false,
      project: {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Demo",
        prompt: "Project-level instructions.",
        pathMappings: [],
        folders: [],
        files: [],
        githubRepos: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const spec = buildCommand(
      config,
      job,
      [],
      workspace,
      [{ program: "blender", workerName: "ws-01", projectPath: "/tmp/demo" }],
      [],
      undefined,
    );

    expect(spec.command).toBe("codex");
    expect(spec.args[0]).toBe("exec");
    expect(spec.args).toContain("--full-auto");

    const prompt = getResolvedPrompt(spec);
    expect(prompt).toContain("## Execution Instructions");
    expect(prompt).toContain("Project-level instructions.");
    expect(prompt).toContain("Config-level instructions.");
    expect(prompt).toContain("Global Coordinator");
    expect(prompt).toContain("Bridge Execution");
    expect(prompt).toContain("REST API fallback");
    expect(prompt).toContain("am bridges");
    expect(prompt).toContain("## User Request");
    expect(prompt).toContain(job.prompt);
  });

  test("does not force single-script command-mode prompt for multi-bridge jobs", () => {
    const config: AgentConfig = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Codex",
      engine: "codex",
      command: "codex",
      args: [],
      model: "gpt-5-codex",
      maxTurns: 300,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "queued",
      priority: "normal",
      prompt: "Build Blender assets and then set up Godot scene.",
      agentConfigId: config.id,
      coordinationMode: "server",
      bridgeProgram: "blender",
      editorContext: {
        metadata: {
          bridge_type: "blender",
          target_bridges: ["blender", "godot"],
          bridge_count: 2,
        },
      } as any,
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const workspace: any = {
      mode: "command",
      cwd: process.cwd(),
      needsSync: false,
    };

    const spec = buildCommand(
      config,
      job,
      [],
      workspace,
      [{ program: "godot", workerName: "ws-02", projectPath: "/tmp/godot" }],
      [],
      undefined,
    );

    const prompt = getResolvedPrompt(spec);
    expect(prompt).toContain("Global Coordinator");
    expect(prompt).not.toContain("single executable python script");
    expect(spec.args).toContain("--sandbox");
    expect(spec.args).toContain("danger-full-access");
    expect(spec.args).toContain("--skip-git-repo-check");
    expect(spec.args).not.toContain("--full-auto");
  });

  test("appends runtime verification override instructions when provided", () => {
    const config: AgentConfig = {
      id: "12345678-1234-4234-8234-123456789012",
      name: "Codex",
      engine: "codex",
      command: "codex",
      args: [],
      model: "gpt-5-codex",
      maxTurns: 300,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "12345678-1234-4234-8234-123456789013",
      status: "queued",
      priority: "normal",
      prompt: "Update the blender material setup.",
      agentConfigId: config.id,
      coordinationMode: "server",
      bridgeProgram: "blender",
      runtimeOptions: {
        verificationMode: "disabled",
        verificationWeight: 10,
      },
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const workspace: any = {
      mode: "command",
      cwd: process.cwd(),
      needsSync: false,
    };

    const spec = buildCommand(config, job, [], workspace, [], [], undefined);
    const prompt = getResolvedPrompt(spec);
    expect(prompt).toContain("Job Runtime Override: Verification");
    expect(prompt).toContain("Mode: DISABLED");
    expect(prompt).toContain("Weight: 10/100");
  });

  test("injects Arkestrator MCP config into Codex command-mode cwd", () => {
    const runDir = mkdtempSync(join(tmpdir(), "arkestrator-codex-mcp-"));
    try {
      const config: AgentConfig = {
        id: "33333333-1234-4234-8234-123456789013",
        name: "Codex",
        engine: "codex",
        command: "codex",
        args: [],
        model: "gpt-5.4",
        maxTurns: 300,
        systemPrompt: undefined,
        priority: 50,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const job: Job = {
        id: "44444444-1234-4234-8234-123456789013",
        status: "queued",
        priority: "normal",
        prompt: "Inspect the connected Blender bridge through MCP first.",
        agentConfigId: config.id,
        coordinationMode: "server",
        bridgeProgram: "blender",
        files: [],
        contextItems: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        usedBridges: [],
        retryCount: 0,
        maxRetries: 3,
      };
      const workspace: any = {
        mode: "command",
        cwd: "/repo/root",
        needsSync: false,
      };

      const spec = buildCommand(config, job, [], workspace, [], [], undefined);
      expect(spec.cwd.replaceAll("\\", "/")).toContain(`/arkestrator-codex/${job.id}`);

      const existingDir = join(runDir, "with-existing");
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(
        join(existingDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { type: "stdio", command: "demo" } } }, null, 2),
        "utf-8",
      );

      const injected = writeInjectedMcpConfig(existingDir, "http://127.0.0.1:7800", "test-key", job.id);
      const written = JSON.parse(readFileSync(injected.path, "utf-8"));

      expect(injected.path).toBe(join(existingDir, ".mcp.json"));
      expect(injected.backup).toContain("\"other\"");
      expect(written.mcpServers.other.command).toBe("demo");
      expect(written.mcpServers.arkestrator.url).toBe("http://127.0.0.1:7800/mcp");
      expect(written.mcpServers.arkestrator.headers.Authorization).toBe("Bearer test-key");
      expect(written.mcpServers.arkestrator.headers["X-Job-Id"]).toBe(job.id);
      expect(written.__arkestrator_injected).toBe(true);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("uses unity_json command-mode prompt for unity bridge jobs", () => {
    const config: AgentConfig = {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Codex",
      engine: "codex",
      command: "codex",
      args: [],
      model: "gpt-5-codex",
      maxTurns: 300,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "77777777-7777-4777-8777-777777777777",
      status: "queued",
      priority: "normal",
      prompt: "Create a marker object in the active scene.",
      agentConfigId: config.id,
      coordinationMode: "server",
      bridgeProgram: "unity",
      editorContext: {
        metadata: {
          bridge_type: "unity",
        },
      } as any,
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const workspace: any = {
      mode: "command",
      cwd: process.cwd(),
      needsSync: false,
    };

    const spec = buildCommand(config, job, [], workspace, [], [], undefined);
    const prompt = getResolvedPrompt(spec);
    expect(prompt).toContain("single executable unity_json script");
    expect(prompt).toContain("Unity Editor");
  });

  test("global coordinator prompt is a minimal template with core rules", () => {
    expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("Global Coordinator");
    expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("execute_command");
    expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("Verification");
    expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("stdout");
    expect(DEFAULT_ORCHESTRATOR_PROMPT).toContain("{MULTI_BRIDGE_SECTION}");
    // Bridge-specific prompts are no longer hardcoded — they come from the bridge repo
  });
});

describe("buildCommand (claude root compatibility)", () => {
  test("still includes dangerously-skip-permissions when running as root (required for headless mode)", () => {
    const config: AgentConfig = {
      id: "ce111111-1111-4111-8111-111111111111",
      name: "Claude",
      engine: "claude-code",
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      model: "claude-sonnet-4-5-20250929",
      maxTurns: 5,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const job: Job = {
      id: "ce222222-2222-4222-8222-222222222222",
      status: "queued",
      priority: "normal",
      prompt: "hello",
      agentConfigId: config.id,
      coordinationMode: "server",
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    // The runtime decision always allows the flag now (even for root),
    // because without it Claude CLI cannot function in headless mode.
    withMockedGetuid(0, () => {
      const spec = buildCommand(config, job);
      expect(spec.args).toContain("--dangerously-skip-permissions");
    });
  });

  test("includes dangerously-skip-permissions for non-root runs", () => {
    const config: AgentConfig = {
      id: "ce333333-3333-4333-8333-333333333333",
      name: "Claude",
      engine: "claude-code",
      command: "claude",
      args: [],
      model: "claude-sonnet-4-5-20250929",
      maxTurns: 5,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const job: Job = {
      id: "ce444444-4444-4444-8444-444444444444",
      status: "queued",
      priority: "normal",
      prompt: "hello",
      agentConfigId: config.id,
      coordinationMode: "server",
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    withMockedGetuid(1000, () => {
      const spec = buildCommand(config, job);
      expect(spec.args).toContain("--dangerously-skip-permissions");
    });
  });
});

describe("buildCommand (local-oss placeholders)", () => {
  test("replaces model placeholder and appends prompt when not explicitly provided", () => {
    const config: AgentConfig = {
      id: "88888888-8888-4888-8888-888888888888",
      name: "Ollama Local",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "llama3.2:latest",
      maxTurns: 300,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "99999999-9999-4999-8999-999999999999",
      status: "queued",
      priority: "normal",
      prompt: "Write a utility function for slug generation.",
      agentConfigId: config.id,
      coordinationMode: "server",
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const spec = buildCommand(config, job);
    expect(spec.command).toBe("ollama");
    expect(spec.args).toEqual(["run", "llama3.2:latest", job.prompt]);
  });

  test("does not append trailing prompt when prompt placeholder is explicitly used", () => {
    const config: AgentConfig = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Custom Local",
      engine: "local-oss",
      command: "my-local-cli",
      args: ["--model", "{{MODEL}}", "--prompt", "{{PROMPT}}"],
      model: "custom-weight-v2",
      maxTurns: 300,
      systemPrompt: undefined,
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "queued",
      priority: "normal",
      prompt: "Generate a concise commit message.",
      agentConfigId: config.id,
      coordinationMode: "server",
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const spec = buildCommand(config, job);
    expect(spec.args).toEqual(["--model", "custom-weight-v2", "--prompt", job.prompt]);
  });

  test("injects execution instructions for command-mode local runs", () => {
    const config: AgentConfig = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Local Command Agent",
      engine: "local-oss",
      command: "ollama",
      args: ["run", "{{MODEL}}"],
      model: "qwen2.5:14b",
      maxTurns: 300,
      systemPrompt: "Always respond with executable bridge scripts only.",
      priority: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const job: Job = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      status: "queued",
      priority: "normal",
      prompt: "Add a label in the middle of the current scene with text hello.",
      agentConfigId: config.id,
      coordinationMode: "server",
      bridgeProgram: "godot",
      editorContext: {
        metadata: {
          bridge_type: "godot",
          target_bridges: ["godot"],
        },
      } as any,
      files: [],
      contextItems: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
    };

    const workspace: any = {
      mode: "command",
      cwd: process.cwd(),
      resolutionStep: 4,
      resolutionReason: "bridge_program_command_default",
      needsSync: false,
    };

    const spec = buildCommand(
      config,
      job,
      [],
      workspace,
      [{ program: "blender", workerName: "ws-01", projectPath: "/tmp/blender-proj" }],
      [],
      undefined,
    );

    expect(spec.args[0]).toBe("run");
    expect(spec.args[1]).toBe("qwen2.5:14b");
    const prompt = spec.args[2] ?? "";
    expect(prompt).toContain("## Execution Instructions");
    expect(prompt).toContain("Always respond with executable bridge scripts only.");
    expect(prompt).toContain("single executable gdscript script");
    expect(prompt).toContain("Global Coordinator");
    expect(prompt).toContain("## User Request");
    expect(prompt).toContain(job.prompt);
  });
});
