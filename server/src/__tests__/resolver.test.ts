import { describe, expect, test } from "bun:test";
import type { AgentConfig, Job } from "@arkestrator/protocol";
import { resolveWorkspace } from "../workspace/resolver.js";
import { createTestDb } from "./setup.js";

const testConfig = {
  defaultWorkspaceMode: "auto",
  syncTempDir: "/tmp/arkestrator-sync",
} as any;

const agentConfig: AgentConfig = {
  id: "6ffb5df2-0b2d-4d57-a4f0-6f503f7d0a61",
  name: "Codex",
  engine: "codex",
  command: "codex",
  args: [],
  maxTurns: 300,
  priority: 50,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("workspace resolver", () => {
  test("defaults bridge-targeted jobs to command mode", () => {
    const ctx = createTestDb();
    const job: Job = {
      id: "6ec993a1-9956-4da7-8f4f-4968a20f3708",
      status: "queued",
      priority: "normal",
      prompt: "Test Houdini command execution",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      bridgeProgram: "houdini",
      files: [],
      contextItems: [],
      usedBridges: ["houdini"],
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: process.cwd(),
        metadata: {
          bridge_type: "houdini",
          target_bridges: ["houdini"],
          bridge_count: 1,
        },
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    expect(resolved.mode).toBe("command");
  });

  test("attaches project for prompt injection without affecting workspace mode", () => {
    const ctx = createTestDb();
    const project = ctx.projectsRepo.create({
      name: "Prompt-Only Project",
      prompt: "Custom project instructions",
    });

    const job: Job = {
      id: "26d8988b-7d66-4ec7-b5bb-12099ec4a2d6",
      status: "queued",
      priority: "normal",
      prompt: "Test project prompt injection",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      bridgeProgram: "houdini",
      files: [],
      contextItems: [],
      usedBridges: ["houdini"],
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: process.cwd(),
        metadata: {
          bridge_type: "houdini",
          target_bridges: ["houdini"],
          bridge_count: 1,
        },
      },
      projectId: project.id,
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    // Project is attached for prompt injection but doesn't force repo mode
    expect(resolved.mode).toBe("command");
    expect(resolved.project).toBeDefined();
    expect(resolved.project!.name).toBe("Prompt-Only Project");
    expect(resolved.project!.prompt).toBe("Custom project instructions");
  });

  test("sync mode works with attached files", () => {
    const ctx = createTestDb();

    const job: Job = {
      id: "c1928c74-5de1-49f0-8a4e-1c20cb74d466",
      status: "queued",
      priority: "normal",
      prompt: "Use sync mode with attached files",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [{ path: "notes.txt", content: "hello" }],
      contextItems: [],
      usedBridges: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: "/nonexistent/path",
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    expect(resolved.mode).toBe("sync");
    expect(resolved.resolutionReason).toBe("attached_files_sync_mode");
  });

  test("falls back to command mode when no local path or files", () => {
    const ctx = createTestDb();

    const job: Job = {
      id: "6ac53b16-e623-4b57-a2cc-e54d8d55f8c0",
      status: "queued",
      priority: "normal",
      prompt: "Fallback test",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: "/nonexistent/path/that/doesnt/exist",
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    expect(resolved.mode).toBe("command");
    expect(resolved.resolutionReason).toBe("fallback_command_mode");
  });
});
