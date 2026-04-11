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
      mode: "agentic" as const,
      prompt: "Test Houdini command execution",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      bridgeProgram: "houdini",
      files: [],
      contextItems: [],
      usedBridges: ["houdini"],
      retryCount: 0,
      maxRetries: 3,
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
      pathMappings: [],
      folders: [],
      files: [],
      githubRepos: [],
    });

    const job: Job = {
      id: "26d8988b-7d66-4ec7-b5bb-12099ec4a2d6",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Test project prompt injection",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      bridgeProgram: "houdini",
      files: [],
      contextItems: [],
      usedBridges: ["houdini"],
      retryCount: 0,
      maxRetries: 3,
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
      mode: "agentic" as const,
      prompt: "Use sync mode with attached files",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [{ path: "notes.txt", content: "hello" }],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
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
      mode: "agentic" as const,
      prompt: "Fallback test",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: "/nonexistent/path/that/doesnt/exist",
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    expect(resolved.mode).toBe("command");
    expect(resolved.resolutionReason).toBe("fallback_command_mode");
  });

  // Regression: on 2026-04-11 a Blender bridge reported
  // `lastProjectPath = <home dir>` (because the session was Untitled with
  // no project), the worker injected that into the job's editorContext,
  // and every Claude Code subprocess spawned with `cwd = <home dir>`.
  // Four parallel agents indexing the home tree raced against the server's
  // own writes to `server/data/db/arkestrator.db` and corrupted it within
  // 20 s. The fix: resolver step 5 refuses a candidate cwd that is the
  // home directory itself OR contains the server's data dir.
  test("refuses repo mode when projectRoot is the user home directory", () => {
    const { homedir } = require("node:os") as typeof import("node:os");
    const ctx = createTestDb();
    const home = homedir();

    const job: Job = {
      id: "4f6bba52-0d4f-4f5d-9a6b-7b6a65d3a2c4",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Bad projectRoot",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: home,
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, testConfig);
    // Must NOT be repo mode at home dir. Falls through to step 6 (sync, needs files)
    // or step 7 (command fallback).
    expect(resolved.mode).not.toBe("repo");
    expect(resolved.cwd).not.toBe(home);
  });

  test("refuses repo mode when projectRoot contains the server data dir", () => {
    const ctx = createTestDb();
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");

    // Build a fake "home-like" tree that contains a data dir
    const homeLike = mkdtempSync(pathJoin(tmpdir(), "ark-resolver-home-"));
    const dataDir = pathJoin(homeLike, "nested", "data");
    require("node:fs").mkdirSync(dataDir, { recursive: true });

    const configWithData = { ...testConfig, dataDir };

    const job: Job = {
      id: "b0a78c8e-5a44-4f2b-8a1c-dc7b6cdb2b90",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Candidate contains the server data dir",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: homeLike,
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, configWithData);
    // Refused — must NOT be repo mode at homeLike because it contains dataDir
    expect(resolved.mode).not.toBe("repo");
    expect(resolved.cwd).not.toBe(homeLike);
  });

  test("allows repo mode for a legitimate project directory", () => {
    const ctx = createTestDb();
    const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");

    // A sibling project dir (not containing dataDir, not home). Must contain
    // a project marker (package.json) to satisfy the step-5 guard — a bare
    // tmp dir is intentionally rejected now because it looks like a random
    // directory, not a real project root.
    const projectDir = mkdtempSync(pathJoin(tmpdir(), "ark-legit-project-"));
    writeFileSync(pathJoin(projectDir, "package.json"), '{"name":"legit"}');
    const otherDataDir = mkdtempSync(pathJoin(tmpdir(), "ark-unrelated-data-"));

    const configWithData = { ...testConfig, dataDir: otherDataDir };

    const job: Job = {
      id: "8c15ee73-ab97-4b7d-9f4e-2fbe9e1a1334",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Real project",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: projectDir,
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, configWithData);
    expect(resolved.mode).toBe("repo");
    expect(resolved.cwd).toBe(projectDir);
  });

  // Regression: bare existsSync is not enough — a directory that exists
  // but has no project marker (no .git, no package.json, no .blend, no
  // arkestrator.coordinator.json, etc.) must be rejected so we don't
  // point an agent at a random arbitrary directory just because the
  // filesystem call succeeds.
  test("refuses repo mode when projectRoot has no project marker", () => {
    const ctx = createTestDb();
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");

    // Empty tmp dir — exists, not home, not containing dataDir, but has
    // no marker files.
    const bareDir = mkdtempSync(pathJoin(tmpdir(), "ark-bare-dir-"));
    const otherDataDir = mkdtempSync(pathJoin(tmpdir(), "ark-unrelated-data2-"));

    const configWithData = { ...testConfig, dataDir: otherDataDir };

    const job: Job = {
      id: "d4db9ad1-6e9c-4a1b-8b80-29e3a32db1b5",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Bare dir, no marker",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: bareDir,
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, configWithData);
    expect(resolved.mode).not.toBe("repo");
    expect(resolved.cwd).not.toBe(bareDir);
  });

  test("allows repo mode for DCC-style project dirs (.blend file present)", () => {
    const ctx = createTestDb();
    const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");

    const projectDir = mkdtempSync(pathJoin(tmpdir(), "ark-blender-project-"));
    writeFileSync(pathJoin(projectDir, "scene.blend"), ""); // empty file is fine for marker check
    const otherDataDir = mkdtempSync(pathJoin(tmpdir(), "ark-unrelated-data3-"));

    const configWithData = { ...testConfig, dataDir: otherDataDir };

    const job: Job = {
      id: "f5ab3b00-30be-4f2d-bff9-b86b4a7c7e99",
      status: "queued",
      priority: "normal",
      mode: "agentic" as const,
      prompt: "Real blender project",
      coordinationMode: "server",
      agentConfigId: agentConfig.id,
      files: [],
      contextItems: [],
      usedBridges: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      editorContext: {
        projectRoot: projectDir,
      },
    };

    const resolved = resolveWorkspace(job, agentConfig, ctx.projectsRepo, configWithData);
    expect(resolved.mode).toBe("repo");
    expect(resolved.cwd).toBe(projectDir);
  });
});
