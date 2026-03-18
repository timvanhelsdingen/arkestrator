import { describe, test, expect } from "bun:test";
import {
  JobStatus,
  JobPriority,
  AgentEngine,
  FileChange,
  EditorContext,
  ContextItem,
} from "../common";
import { Job, JobSubmit } from "../jobs";
import { AgentConfig, AgentConfigCreate } from "../agents";
import { WorkspaceMode, CommandResult, Project } from "../projects";
import { Message } from "../messages";
import { JobIntervention, JobInterventionCreate, JobInterventionSupport } from "../interventions";

describe("Enum schemas", () => {
  test("JobStatus accepts all valid values", () => {
    for (const status of [
      "queued",
      "paused",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(JobStatus.parse(status)).toBe(status);
    }
  });

  test("JobStatus rejects invalid values", () => {
    expect(() => JobStatus.parse("pending")).toThrow();
    expect(() => JobStatus.parse("")).toThrow();
    expect(() => JobStatus.parse(123)).toThrow();
  });

  test("JobPriority accepts all valid values", () => {
    for (const p of ["low", "normal", "high", "critical"]) {
      expect(JobPriority.parse(p)).toBe(p);
    }
  });

  test("JobPriority rejects invalid values", () => {
    expect(() => JobPriority.parse("urgent")).toThrow();
  });

  test("AgentEngine accepts all valid values", () => {
    for (const e of ["claude-code", "codex", "gemini", "local-oss"]) {
      expect(AgentEngine.parse(e)).toBe(e);
    }
  });

  test("AgentEngine rejects invalid values", () => {
    expect(() => AgentEngine.parse("openai")).toThrow();
  });

  test("WorkspaceMode accepts all valid values", () => {
    for (const m of ["command", "repo", "sync"]) {
      expect(WorkspaceMode.parse(m)).toBe(m);
    }
  });
});

describe("FileChange schema", () => {
  test("parses valid file change", () => {
    const result = FileChange.parse({
      path: "test.txt",
      content: "hello",
      action: "create",
    });
    expect(result.path).toBe("test.txt");
    expect(result.action).toBe("create");
  });

  test("parses binary file change", () => {
    const result = FileChange.parse({
      path: "image.png",
      content: "",
      action: "create",
      binaryContent: "aGVsbG8=",
      encoding: "base64",
    });
    expect(result.encoding).toBe("base64");
    expect(result.binaryContent).toBe("aGVsbG8=");
  });

  test("optional fields are truly optional", () => {
    const result = FileChange.parse({
      path: "file.txt",
      content: "data",
      action: "modify",
    });
    expect(result.binaryContent).toBeUndefined();
    expect(result.encoding).toBeUndefined();
  });

  test("rejects invalid action", () => {
    expect(() =>
      FileChange.parse({ path: "f", content: "c", action: "update" }),
    ).toThrow();
  });
});

describe("EditorContext schema", () => {
  test("parses valid context", () => {
    const result = EditorContext.parse({
      projectRoot: "/home/user/project",
      activeFile: "main.gd",
      metadata: { active_scene: "main.tscn" },
    });
    expect(result.projectRoot).toBe("/home/user/project");
  });

  test("requires projectRoot", () => {
    expect(() =>
      EditorContext.parse({ activeFile: "test.gd" }),
    ).toThrow();
  });
});

describe("JobSubmit schema", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  test("parses minimal valid submission", () => {
    const result = JobSubmit.parse({
      prompt: "add a health bar",
      agentConfigId: validUuid,
    });
    expect(result.prompt).toBe("add a health bar");
    expect(result.priority).toBe("normal"); // default
    expect(result.coordinationMode).toBe("server"); // default
    expect(result.files).toEqual([]); // default
  });

  test("accepts auto agent target", () => {
    const result = JobSubmit.parse({
      prompt: "pick best route",
      agentConfigId: "auto",
    });
    expect(result.agentConfigId).toBe("auto");
  });

  test("parses full submission with all optional fields", () => {
    const result = JobSubmit.parse({
      name: "Health bar job",
      prompt: "add a health bar",
      agentConfigId: validUuid,
      priority: "high",
      preferredMode: "command",
      dependsOn: [validUuid],
      targetWorkerName: "my-pc",
      startPaused: true,
      projectId: validUuid,
      coordinationMode: "client",
      runtimeOptions: {
        model: "qwen2.5-coder:14b",
        reasoningLevel: "xhigh",
        verificationMode: "optional",
        verificationWeight: 65,
        bridgeExecutionMode: "headless",
      },
    });
    expect(result.name).toBe("Health bar job");
    expect(result.priority).toBe("high");
    expect(result.startPaused).toBe(true);
    expect(result.coordinationMode).toBe("client");
    expect(result.runtimeOptions?.model).toBe("qwen2.5-coder:14b");
    expect(result.runtimeOptions?.reasoningLevel).toBe("xhigh");
    expect(result.runtimeOptions?.verificationMode).toBe("optional");
    expect(result.runtimeOptions?.verificationWeight).toBe(65);
    expect(result.runtimeOptions?.bridgeExecutionMode).toBe("headless");
  });

  test("rejects missing prompt", () => {
    expect(() =>
      JobSubmit.parse({ agentConfigId: validUuid }),
    ).toThrow();
  });

  test("rejects invalid priority", () => {
    expect(() =>
      JobSubmit.parse({
        prompt: "test",
        agentConfigId: validUuid,
        priority: "urgent",
      }),
    ).toThrow();
  });

  test("rejects invalid runtime reasoning level", () => {
    expect(() =>
      JobSubmit.parse({
        prompt: "test",
        agentConfigId: validUuid,
        runtimeOptions: { reasoningLevel: "max" },
      }),
    ).toThrow();
  });

  test("rejects invalid verification runtime values", () => {
    expect(() =>
      JobSubmit.parse({
        prompt: "test",
        agentConfigId: validUuid,
        runtimeOptions: { verificationMode: "always" },
      }),
    ).toThrow();

    expect(() =>
      JobSubmit.parse({
        prompt: "test",
        agentConfigId: validUuid,
        runtimeOptions: { verificationWeight: 140 },
      }),
    ).toThrow();
  });

  test("rejects invalid bridge execution runtime values", () => {
    expect(() =>
      JobSubmit.parse({
        prompt: "test",
        agentConfigId: validUuid,
        runtimeOptions: { bridgeExecutionMode: "background" },
      }),
    ).toThrow();
  });

  test("strips unknown fields", () => {
    const result = JobSubmit.parse({
      prompt: "test",
      agentConfigId: validUuid,
      unknownField: "should be stripped",
    });
    expect((result as any).unknownField).toBeUndefined();
  });
});

describe("Job schema", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  test("parses valid job", () => {
    const result = Job.parse({
      id: validUuid,
      status: "queued",
      priority: "normal",
      prompt: "test",
      files: [],
      contextItems: [],
      coordinationMode: "client",
      agentConfigId: validUuid,
      createdAt: new Date().toISOString(),
    });
    expect(result.id).toBe(validUuid);
    expect(result.status).toBe("queued");
    expect(result.coordinationMode).toBe("client");
  });

  test("parses job with token usage", () => {
    const result = Job.parse({
      id: validUuid,
      status: "completed",
      priority: "normal",
      prompt: "test",
      files: [],
      contextItems: [],
      agentConfigId: validUuid,
      createdAt: new Date().toISOString(),
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 5000,
      },
    });
    expect(result.tokenUsage!.inputTokens).toBe(1000);
  });

  test("parses job with outcome feedback", () => {
    const result = Job.parse({
      id: validUuid,
      status: "completed",
      priority: "normal",
      prompt: "test",
      files: [],
      contextItems: [],
      agentConfigId: validUuid,
      createdAt: new Date().toISOString(),
      outcomeRating: "average",
      outcomeNotes: "Mostly good but missed one edge case",
      outcomeMarkedAt: new Date().toISOString(),
      outcomeMarkedBy: validUuid,
    });
    expect(result.outcomeRating).toBe("average");
    expect(result.outcomeNotes).toContain("Mostly good");
  });
});

describe("Job intervention schemas", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  test("parses intervention creation payload", () => {
    const result = JobInterventionCreate.parse({
      text: "Keep the roof pitch steeper and tighten the door trim.",
      source: "jobs",
    });
    expect(result.text).toContain("roof pitch");
    expect(result.source).toBe("jobs");
  });

  test("parses intervention records with delivery metadata", () => {
    const result = JobIntervention.parse({
      id: validUuid,
      jobId: validUuid,
      source: "chat",
      status: "delivered",
      text: "Use darker shingles.",
      authorUsername: "tim",
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      deliveryMetadata: {
        channel: "local-agentic-turn",
        turn: 2,
      },
    });
    expect(result.status).toBe("delivered");
    expect(result.deliveryMetadata?.channel).toBe("local-agentic-turn");
  });

  test("parses intervention support payload", () => {
    const result = JobInterventionSupport.parse({
      acceptsQueuedNotes: true,
      acceptsLiveNotes: false,
      liveReason: "This job is not currently running.",
    });
    expect(result.acceptsQueuedNotes).toBe(true);
    expect(result.acceptsLiveNotes).toBe(false);
  });
});

describe("AgentConfig schema", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  test("parses valid config", () => {
    const result = AgentConfig.parse({
      id: validUuid,
      name: "Claude Sonnet",
      engine: "claude-code",
      command: "claude",
      args: ["--model", "sonnet"],
      maxTurns: 20,
      priority: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.name).toBe("Claude Sonnet");
    expect(result.args).toEqual(["--model", "sonnet"]);
  });

  test("AgentConfigCreate omits id and timestamps", () => {
    const result = AgentConfigCreate.parse({
      name: "New Config",
      engine: "gemini",
      command: "gemini",
      args: [],
      maxTurns: 10,
      priority: 50,
    });
    expect(result.name).toBe("New Config");
    expect((result as any).id).toBeUndefined();
  });
});

describe("CommandResult schema", () => {
  test("parses valid command result", () => {
    const result = CommandResult.parse({
      language: "gdscript",
      script: "print('hello')",
      description: "test command",
    });
    expect(result.language).toBe("gdscript");
  });
});

describe("Message discriminated union", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  test("parses job_submit message", () => {
    const result = Message.parse({
      type: "job_submit",
      id: validUuid,
      payload: {
        prompt: "test prompt",
        agentConfigId: validUuid,
      },
    });
    expect(result.type).toBe("job_submit");
  });

  test("parses job_accepted message", () => {
    const result = Message.parse({
      type: "job_accepted",
      id: validUuid,
      payload: { jobId: validUuid },
    });
    expect(result.type).toBe("job_accepted");
  });

  test("parses job_log message", () => {
    const result = Message.parse({
      type: "job_log",
      id: validUuid,
      payload: { jobId: validUuid, text: "Building..." },
    });
    expect(result.type).toBe("job_log");
  });

  test("parses error message", () => {
    const result = Message.parse({
      type: "error",
      id: validUuid,
      payload: { code: "AUTH_FAILED", message: "Invalid credentials" },
    });
    expect(result.type).toBe("error");
  });

  test("parses intervention submit/list/update messages", () => {
    const submit = Message.parse({
      type: "job_intervention_submit",
      id: "550e8400-e29b-41d4-a716-446655440001",
      payload: {
        jobId: validUuid,
        intervention: {
          text: "Adjust the framing width.",
          source: "jobs",
        },
      },
    });
    expect(submit.type).toBe("job_intervention_submit");

    const list = Message.parse({
      type: "job_intervention_list_response",
      id: "550e8400-e29b-41d4-a716-446655440002",
      payload: {
        jobId: validUuid,
        interventions: [],
        support: {
          acceptsQueuedNotes: true,
          acceptsLiveNotes: false,
          liveReason: "This job is not currently running.",
        },
      },
    });
    expect(list.type).toBe("job_intervention_list_response");

    const updated = Message.parse({
      type: "job_intervention_updated",
      id: "550e8400-e29b-41d4-a716-446655440003",
      payload: {
        jobId: validUuid,
        intervention: {
          id: validUuid,
          jobId: validUuid,
          source: "mcp",
          status: "pending",
          text: "Keep the porch posts square.",
          createdAt: new Date().toISOString(),
        },
        support: {
          acceptsQueuedNotes: false,
          acceptsLiveNotes: true,
        },
      },
    });
    expect(updated.type).toBe("job_intervention_updated");
  });

  test("rejects unknown message type", () => {
    const result = Message.safeParse({
      type: "unknown_type",
      id: validUuid,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects message with missing id", () => {
    const result = Message.safeParse({
      type: "job_submit",
      payload: {
        prompt: "test",
        agentConfigId: validUuid,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("ContextItem schema", () => {
  test("parses valid context item", () => {
    const result = ContextItem.parse({
      index: 1,
      type: "node",
      name: "Player",
      path: "/root/Player",
    });
    expect(result.index).toBe(1);
    expect(result.type).toBe("node");
  });

  test("accepts all context item types", () => {
    for (const type of ["node", "script", "asset", "resource", "scene"]) {
      const result = ContextItem.parse({
        index: 1,
        type,
        name: "test",
        path: "/test",
      });
      expect(result.type).toBe(type);
    }
  });
});
