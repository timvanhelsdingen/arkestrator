import { describe, expect, it } from "bun:test";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpDeps } from "../mcp/tool-server.js";
import { createTestAgentConfig, createTestDb, createTestJob } from "./setup.js";
import { WebSocketHub } from "../ws/hub.js";
import { WorkerResourceLeaseManager } from "../agents/resource-control.js";

class TestTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  private responseResolve?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.responseResolve?.(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  async request(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    const hasId = "id" in message && message.id !== undefined && message.id !== null;
    if (!hasId) {
      this.onmessage?.(message);
      return { jsonrpc: "2.0", id: null as unknown as number, result: { ok: true } } as JSONRPCMessage;
    }
    const response = new Promise<JSONRPCMessage>((resolve) => {
      this.responseResolve = resolve;
    });
    this.onmessage?.(message);
    return response;
  }
}

function bridgeWs(id: string, program: string, workerName: string, projectPath: string): any {
  return {
    data: {
      id,
      type: "bridge",
      role: "bridge",
      connectedAt: new Date().toISOString(),
      program,
      workerName,
      projectPath,
    },
    send: () => {},
    close: () => {},
  };
}

async function createInitializedServer(deps: McpDeps): Promise<{ transport: TestTransport }> {
  const server = createMcpServer(deps);
  const transport = new TestTransport();
  await server.connect(transport);

  await transport.request({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arkestrator-test", version: "1.0.0" },
    },
  } as JSONRPCMessage);
  await transport.request({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  } as JSONRPCMessage);

  return { transport };
}

async function callTool(transport: TestTransport, id: string, name: string, args: Record<string, unknown>) {
  return transport.request({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  } as JSONRPCMessage) as Promise<any>;
}

describe("MCP tool server", () => {
  it("lists available orchestration targets (live bridges + headless programs)", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    hub.register(bridgeWs("bridge-godot-1", "godot", "ws-a", "/project/godot-a"));
    ctx.headlessProgramsRepo.create({
      program: "houdini",
      displayName: "Houdini CLI",
      executable: "hython",
      argsTemplate: ["{{SCRIPT}}"],
      language: "python",
      enabled: true,
    });
    ctx.headlessProgramsRepo.create({
      program: "unreal",
      displayName: "Unreal CLI",
      executable: "unreal-cli",
      argsTemplate: ["{{SCRIPT}}"],
      language: "python",
      enabled: false,
    });

    const { transport } = await createInitializedServer({
      hub,
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    });
    const response = await callTool(transport, "list-targets", "list_targets", {});
    const parsed = JSON.parse(response.result.content[0].text);

    expect(parsed.target_programs).toContain("godot");
    expect(parsed.target_programs).toContain("houdini");
    expect(parsed.target_programs).not.toContain("unreal");
    expect(parsed.live_bridges_by_program.godot.length).toBe(1);
    expect(parsed.headless_programs.some((p: any) => p.program === "houdini")).toBeTrue();
  });

  it("returns tailed logs for get_job_logs", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    const config = createTestAgentConfig(ctx.agentsRepo);
    const job = createTestJob(ctx.jobsRepo, config.id);
    ctx.jobsRepo.complete(job.id, [], ["line1", "line2", "line3", "line4"].join("\n"));

    const { transport } = await createInitializedServer({
      hub,
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
    });
    const response = await callTool(transport, "get-logs", "get_job_logs", { job_id: job.id, lines: 2 });
    const parsed = JSON.parse(response.result.content[0].text);

    expect(parsed.job_id).toBe(job.id);
    expect(parsed.returned_lines).toBe(2);
    expect(parsed.logs).toBe("line3\nline4");
  });

  it("cancels running jobs and invokes process tracker kill", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    const config = createTestAgentConfig(ctx.agentsRepo);
    const job = createTestJob(ctx.jobsRepo, config.id);
    ctx.jobsRepo.claim(job.id);

    const killed: string[] = [];
    const { transport } = await createInitializedServer({
      hub,
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
      processTracker: {
        kill: (jobId: string) => {
          killed.push(jobId);
        },
      } as any,
    });
    const response = await callTool(transport, "cancel-job", "cancel_job", { job_id: job.id });
    const parsed = JSON.parse(response.result.content[0].text);

    expect(parsed.status).toBe("cancelled");
    expect(parsed.previous_status).toBe("running");
    expect(killed).toEqual([job.id]);
    expect(ctx.jobsRepo.getById(job.id)?.status).toBe("cancelled");
  });

  it("forwards allowed client API requests", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; method: string; auth?: string | null }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        auth: init?.headers && typeof init.headers === "object"
          ? (init.headers as Record<string, string>)["Authorization"]
          : undefined,
      });
      return new Response(JSON.stringify({ ok: true, echoed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    try {
      const { transport } = await createInitializedServer({
        hub,
        policiesRepo: ctx.policiesRepo,
        headlessProgramsRepo: ctx.headlessProgramsRepo,
        config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
        resourceLeaseManager: new WorkerResourceLeaseManager(),
        jobsRepo: ctx.jobsRepo,
        jobInterventionsRepo: ctx.jobInterventionsRepo,
        agentsRepo: ctx.agentsRepo,
        depsRepo: ctx.depsRepo,
        requestOrigin: "http://localhost:7800",
        requestAuthHeader: "Bearer test-token",
      });

      const response = await callTool(transport, "client-api", "client_api_request", {
        method: "POST",
        path: "/api/jobs",
        body: { prompt: "hello" },
      });
      const parsed = JSON.parse(response.result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe(200);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe("http://localhost:7800/api/jobs");
      expect(fetchCalls[0].method).toBe("POST");
      expect(fetchCalls[0].auth).toBe("Bearer test-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks disallowed client API paths", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    const { transport } = await createInitializedServer({
      hub,
      policiesRepo: ctx.policiesRepo,
      headlessProgramsRepo: ctx.headlessProgramsRepo,
      config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
      resourceLeaseManager: new WorkerResourceLeaseManager(),
      jobsRepo: ctx.jobsRepo,
      jobInterventionsRepo: ctx.jobInterventionsRepo,
      agentsRepo: ctx.agentsRepo,
      depsRepo: ctx.depsRepo,
      requestOrigin: "http://localhost:7800",
    });

    const response = await callTool(transport, "client-api-blocked", "client_api_request", {
      method: "GET",
      path: "/api/users",
    });
    expect(response.result.isError).toBeTrue();
    expect(String(response.result.content?.[0]?.text ?? "")).toContain("not allowed");
  });

  it("forwards intervention submit/list tool calls through the client API", async () => {
    const ctx = createTestDb();
    const hub = new WebSocketHub();
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true, echoed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    try {
      const { transport } = await createInitializedServer({
        hub,
        policiesRepo: ctx.policiesRepo,
        headlessProgramsRepo: ctx.headlessProgramsRepo,
        config: { comfyuiUrl: "http://127.0.0.1:8188" } as any,
        resourceLeaseManager: new WorkerResourceLeaseManager(),
        jobsRepo: ctx.jobsRepo,
        jobInterventionsRepo: ctx.jobInterventionsRepo,
        agentsRepo: ctx.agentsRepo,
        depsRepo: ctx.depsRepo,
        requestOrigin: "http://localhost:7800",
      });

      const submitResponse = await callTool(transport, "submit-intervention", "submit_job_intervention", {
        job_id: "job-123",
        text: "Tighten the beam spacing.",
      });
      const submitParsed = JSON.parse(submitResponse.result.content[0].text);
      expect(submitParsed.ok).toBe(true);

      const listResponse = await callTool(transport, "list-intervention", "list_job_interventions", {
        job_id: "job-123",
      });
      const listParsed = JSON.parse(listResponse.result.content[0].text);
      expect(listParsed.ok).toBe(true);

      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0].url).toBe("http://localhost:7800/api/jobs/job-123/interventions");
      expect(fetchCalls[0].method).toBe("POST");
      expect(fetchCalls[0].body).toContain("\"source\":\"mcp\"");
      expect(fetchCalls[1].url).toBe("http://localhost:7800/api/jobs/job-123/interventions");
      expect(fetchCalls[1].method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
