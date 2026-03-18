import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadCoordinatorPlaybookContext,
  loadCoordinatorPlaybookContextDetailed,
  parseCoordinatorReferencePaths,
  recordCoordinatorExecutionOutcome,
  seedCoordinatorPlaybooks,
  serializeCoordinatorReferencePaths,
} from "../agents/coordinator-playbooks.js";
import { refreshTrainingRepositoryIndex } from "../agents/training-repository.js";

describe("coordinator playbooks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("seeds default playbook files", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-seed-"));
    dirs.push(root);

    seedCoordinatorPlaybooks(root);

    const manifestPath = join(root, "houdini", "playbook.json");
    const taskPath = join(root, "houdini", "tasks", "general_houdini_workflow.md");

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(taskPath)).toBe(true);
  });

  it("seeds barebones defaults for bridge playbooks", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-bridge-defaults-"));
    dirs.push(root);

    seedCoordinatorPlaybooks(root);

    const bridgePrograms = ["blender", "godot", "houdini", "unity", "unreal", "comfyui"];
    for (const program of bridgePrograms) {
      const manifestPath = join(root, program, "playbook.json");
      expect(existsSync(manifestPath)).toBe(true);

      const text = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(text) as { tasks?: Array<{ examples?: string[] }> };
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(parsed.tasks?.length).toBe(1);
      expect(Array.isArray(parsed.tasks?.[0]?.examples)).toBe(true);
      expect(parsed.tasks?.[0]?.examples ?? []).toEqual([]);
    }
  });

  it("loads matched task instructions and reference example excerpts", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-load-"));
    dirs.push(root);

    const programDir = join(root, "houdini");
    const taskDir = join(programDir, "tasks");
    const exDir = join(programDir, "examples", "houdini", "pyro");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(exDir, { recursive: true });

    writeFileSync(
      join(programDir, "playbook.json"),
      JSON.stringify(
        {
          version: 1,
          program: "houdini",
          tasks: [
            {
              id: "explosion",
              title: "Explosion",
              instruction: "tasks/explosion.md",
              keywords: ["explosion", "pyro"],
              examples: ["examples/houdini/pyro"],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(taskDir, "explosion.md"), "Use mesh -> pyro source -> rasterize -> pyro solver.");
    writeFileSync(join(exDir, "README.md"), "This folder contains pyro reference scenes.");

    const context = loadCoordinatorPlaybookContext({
      dir: root,
      program: "houdini",
      prompt: "Please build a pyro explosion setup.",
    });

    expect(context).toBeTruthy();
    expect(context).toContain("Task Playbooks (Auto-Selected)");
    expect(context).toContain("Use mesh -> pyro source -> rasterize -> pyro solver.");
    expect(context).toContain("pyro reference scenes");
  });

  it("parses and serializes reference path settings", () => {
    const parsed = parseCoordinatorReferencePaths("/a,/b\n/c");
    expect(parsed).toEqual(["/a", "/b", "/c"]);
    expect(serializeCoordinatorReferencePaths(parsed)).toBe("/a\n/b\n/c");
  });

  it("loads tasks from multiple external playbook sources", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-main-"));
    const source = mkdtempSync(join(tmpdir(), "am-playbook-source-"));
    dirs.push(root, source);

    const sourceProgramDir = join(source, "godot");
    const sourceTasksDir = join(sourceProgramDir, "tasks");
    mkdirSync(sourceTasksDir, { recursive: true });

    writeFileSync(
      join(sourceProgramDir, "playbook.json"),
      JSON.stringify(
        {
          version: 1,
          program: "godot",
          tasks: [
            {
              id: "ui_task",
              title: "UI Task",
              instruction: "tasks/ui.md",
              keywords: ["ui", "godot"],
              examples: [],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(sourceTasksDir, "ui.md"), "Use Control nodes and anchors.");

    const context = loadCoordinatorPlaybookContext({
      dir: root,
      program: "godot",
      prompt: "Build a Godot UI screen",
      playbookSourcePaths: [source],
    });

    expect(context).toBeTruthy();
    expect(context).toContain("UI Task");
    expect(context).toContain("Use Control nodes and anchors.");
  });

  it("stores execution outcome metadata with job identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-feedback-"));
    dirs.push(root);

    recordCoordinatorExecutionOutcome({
      dir: root,
      program: "godot",
      prompt: "Add score label",
      signal: "positive",
      outcome: "Worked in one go",
      metadata: {
        jobId: "job-123",
        jobName: "Test Job",
        bridgeProgram: "godot",
        usedBridges: ["godot"],
        submittedByUserId: "user-1",
        submittedByUsername: "tim",
        outcomeMarkedByUserId: "user-1",
        outcomeMarkedByUsername: "tim",
      },
    });

    const path = join(root, "_learning", "godot.experiences.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBe(1);
    expect(parsed.entries[0]?.metadata?.jobId).toBe("job-123");
    expect(parsed.entries[0]?.metadata?.submittedByUsername).toBe("tim");
    expect(parsed.entries[0]?.metadata?.bridgeProgram).toBe("godot");
  });

  it("generates a fallback job name when learning feedback has no explicit job name", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-feedback-name-"));
    dirs.push(root);

    recordCoordinatorExecutionOutcome({
      dir: root,
      program: "houdini",
      prompt: "I want you to build a simple procedural rollercoaster model in Houdini",
      signal: "average",
      outcome: "Built rails but tie orientation needs adjustment.",
      metadata: {
        jobId: "job-rc-1",
      },
      jobSnapshot: {
        id: "job-rc-1",
        name: "",
        prompt: "I want you to build a simple procedural rollercoaster model in Houdini",
      },
    });

    const artifactDir = join(root, "_learning", "jobs", "houdini");
    const artifactName = readdirSync(artifactDir).find((name) => name.endsWith("--job-rc-1.json"));
    expect(Boolean(artifactName)).toBe(true);
    const artifactPath = join(artifactDir, artifactName as string);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
      metadata?: { jobName?: string };
      job?: { name?: string };
    };

    expect(String(artifact?.metadata?.jobName ?? "")).toBe("Build a simple procedural rollercoaster model in Houdini");
    expect(String(artifact?.job?.name ?? "")).toBe("Build a simple procedural rollercoaster model in Houdini");
  });

  it("injects indexed training patterns into playbook context retrieval", () => {
    const root = mkdtempSync(join(tmpdir(), "am-playbook-training-index-"));
    dirs.push(root);

    const jobsDir = join(root, "_learning", "jobs", "houdini");
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(
      join(jobsDir, "job-feedback.json"),
      JSON.stringify(
        {
          version: 1,
          source: "manual_outcome_feedback",
          program: "houdini",
          signal: "positive",
          prompt: "Build a Houdini pyro explosion",
          outcome: "Successful setup with pyro source and solver chain.",
          metadata: {
            jobId: "job-feedback",
            jobName: "Pyro Outcome",
            bridgeProgram: "houdini",
            usedBridges: ["houdini"],
          },
          job: { id: "job-feedback" },
        },
        null,
        2,
      ),
    );

    refreshTrainingRepositoryIndex({
      dir: root,
      program: "houdini",
    });

    const context = loadCoordinatorPlaybookContextDetailed({
      dir: root,
      program: "houdini",
      prompt: "Need a pyro explosion setup",
    });

    expect(context.text ?? "").toContain("Training Repository Patterns (Auto-Retrieved)");
    expect(context.matches.some((match) => match.kind === "training_pattern")).toBe(true);
  });
});
