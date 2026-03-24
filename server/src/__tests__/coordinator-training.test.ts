import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WebSocketHub } from "../ws/hub.js";
import { queueCoordinatorTrainingJob } from "../agents/coordinator-training.js";
import { createTestAgentConfig, createTestDb, type TestContext } from "./setup.js";

describe("coordinator training queue", () => {
  let ctx: TestContext;
  let hub: WebSocketHub;
  let coordinatorScriptsDir: string;
  let coordinatorPlaybooksDir: string;

  beforeEach(() => {
    ctx = createTestDb();
    hub = new WebSocketHub();
    coordinatorScriptsDir = mkdtempSync(join(tmpdir(), "am-coord-training-scripts-"));
    coordinatorPlaybooksDir = mkdtempSync(join(tmpdir(), "am-coord-training-playbooks-"));
    createTestAgentConfig(ctx.agentsRepo, {
      name: "Training Agent",
      engine: "codex",
      command: "echo",
    });
  });

  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      // ignore
    }
    rmSync(coordinatorScriptsDir, { recursive: true, force: true });
    rmSync(coordinatorPlaybooksDir, { recursive: true, force: true });
  });

  it("fails training and skips vault artifact writes when analysis reports unauthorized blocker", async () => {
    const program = "godot";
    const playbookProgramDir = join(coordinatorPlaybooksDir, program);
    mkdirSync(playbookProgramDir, { recursive: true });
    writeFileSync(
      join(playbookProgramDir, "playbook.json"),
      JSON.stringify({ version: 1, program, tasks: [] }, null, 2),
      "utf-8",
    );

    const sourceRoot = mkdtempSync(join(tmpdir(), "am-coord-training-source-"));
    const projectDir = join(sourceRoot, "demo_project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project.godot"), "[application]\nconfig/name=\"Demo\"\n", "utf-8");
    writeFileSync(
      join(projectDir, "arkestrator.coordinator.json"),
      JSON.stringify({
        version: 1,
        program,
        projectName: "demo_project",
        projectPath: projectDir,
        prompt: "Use this project conventions.",
      }, null, 2),
      "utf-8",
    );

    // Force manual training to run agentic analysis as a sub-job without requiring a live bridge.
    ctx.headlessProgramsRepo.create({
      program,
      displayName: "Godot (Headless)",
      executable: "godot",
      argsTemplate: ["--headless", "--script", "{{SCRIPT_FILE}}"],
      language: "gdscript",
      enabled: true,
    });

    const queued = queueCoordinatorTrainingJob(
      {
        jobsRepo: ctx.jobsRepo,
        agentsRepo: ctx.agentsRepo,
        settingsRepo: ctx.settingsRepo,
        headlessProgramsRepo: ctx.headlessProgramsRepo,
        hub,
        coordinatorScriptsDir,
        coordinatorPlaybooksDir,
        defaultCoordinatorPlaybookSourcePaths: [],
      },
      {
        program,
        trigger: "manual",
        apply: false,
        sourcePaths: [sourceRoot],
        targetWorkerName: "test-worker",
      },
    );

    // Wait for the child analysis job to be created, then complete it with blocker logs.
    let childJobId = "";
    for (let i = 0; i < 200; i++) {
      const jobs = ctx.jobsRepo.list().jobs;
      const child = jobs.find((job) => job.parentJobId === queued.id);
      if (child) {
        childJobId = child.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(childJobId.length).toBeGreaterThan(0);

    const blockerLogs = [
      "```json",
      JSON.stringify({
        version: 1,
        program,
        projectName: "simplefireball_XPU",
        projectPath: sourceRoot,
        prompt: "Blocked analysis run.",
        contexts: [
          {
            name: "access_blocker",
            pattern: "ARKESTRATOR_API_KEY length = 0, /api/bridge-command/* returns 401",
          },
        ],
      }),
      "```",
      "URL:21 KEY:0 JOB:36",
      "HTTP/1.1 401 Unauthorized",
      "{\"error\":\"Unauthorized\"}",
    ].join("\n");

    ctx.jobsRepo.complete(childJobId, [], blockerLogs);

    // Parent training must fail and skip vault persistence.
    let parentStatus = "";
    let parentError = "";
    for (let i = 0; i < 300; i++) {
      const parent = ctx.jobsRepo.getById(queued.id);
      parentStatus = String(parent?.status ?? "");
      parentError = String(parent?.error ?? "");
      if (parentStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(parentStatus).toBe("failed");
    expect(parentError.toLowerCase()).toContain("analysis");
    expect(parentError.toLowerCase()).toContain("blocker");

    const jobsProgramDir = join(coordinatorPlaybooksDir, "_learning", "jobs", program);
    let artifactWritten = false;
    if (existsSync(jobsProgramDir)) {
      const folders = readdirSync(jobsProgramDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      artifactWritten = folders.some((folder) => {
        const analysisPath = join(jobsProgramDir, folder, "analysis.json");
        if (!existsSync(analysisPath)) return false;
        try {
          const parsed = JSON.parse(readFileSync(analysisPath, "utf-8"));
          return String(parsed?.job?.id ?? "") === queued.id;
        } catch {
          return false;
        }
      });
    }
    expect(artifactWritten).toBe(false);

    rmSync(sourceRoot, { recursive: true, force: true });
  });
});
