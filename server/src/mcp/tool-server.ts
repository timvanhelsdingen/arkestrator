import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketHub } from "../ws/hub.js";
import type { PoliciesRepo } from "../db/policies.repo.js";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { DependenciesRepo } from "../db/dependencies.repo.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { Config } from "../config.js";
import type { ProcessTracker } from "../agents/process-tracker.js";
import { resolveBridgeTargets, type WorkerResourceLeaseManager } from "../agents/resource-control.js";
import { executeBridgeCommand, listConnectedBridges, runHeadlessCheck } from "../routes/bridge-commands.js";
import { newId } from "../utils/id.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { principalHasPermission, type AuthPrincipal } from "../middleware/auth.js";
import type { UserPermissionKey } from "../utils/user-permissions.js";

export interface McpDeps {
  hub: WebSocketHub;
  policiesRepo: PoliciesRepo;
  headlessProgramsRepo: HeadlessProgramsRepo;
  config: Config;
  resourceLeaseManager: WorkerResourceLeaseManager;
  // Job management — needed for orchestrator agents to spawn sub-jobs
  jobsRepo: JobsRepo;
  jobInterventionsRepo: JobInterventionsRepo;
  agentsRepo: AgentsRepo;
  depsRepo: DependenciesRepo;
  /** Job ID of the agent that is making this MCP call (for parent-child tracking) */
  callerJobId?: string;
  /** Optional subprocess tracker so MCP cancel can terminate running jobs safely. */
  processTracker?: ProcessTracker;
  /** Origin of the incoming MCP request (used for scoped internal client-API forwarding). */
  requestOrigin?: string;
  /** Authorization header from the incoming MCP request, forwarded to client API calls. */
  requestAuthHeader?: string;
  /** Cookie header from the incoming MCP request, forwarded to client API calls. */
  requestCookieHeader?: string;
  /** Authenticated principal making this MCP request (for per-tool permission checks). */
  principal?: AuthPrincipal;
  /** Skill index for lazy-loading prompt context via MCP. */
  skillIndex?: import("../skills/skill-index.js").SkillIndex;
  /** Settings repo for reading server preferences (e.g. prefer_headless_bridges). */
  settingsRepo?: import("../db/settings.repo.js").SettingsRepo;
}

const CLIENT_API_ALLOW_PREFIXES = [
  "/api/jobs",
  "/api/chat",
  "/api/agent-configs",
  "/api/headless-programs",
  "/api/skills",
  "/api/bridge-command",
  "/api/workers",
  "/api/projects",
  "/api/settings/coordinator-scripts",
  "/api/settings/coordinator-reference-paths",
  "/api/settings/coordinator-playbook-sources",
  "/api/settings/coordinator-playbooks",
  "/api/settings/coordinator-training-schedule",
  "/api/settings/coordinator-training/run-now",
  "/api/settings/coordinator-editors",
  "/api/settings/coordinator-analyze-agent",
] as const;

function normalizeClientPath(input: string): { fullPath: string; pathname: string } | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const candidate = raw.startsWith("/") ? raw : `/${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate, "http://arkestrator.local");
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  if (!pathname.startsWith("/")) return null;
  if (pathname.includes("..")) return null;
  return {
    fullPath: `${pathname}${parsed.search}`,
    pathname,
  };
}

function isAllowedClientApiPath(pathname: string): boolean {
  if (pathname === "/health") return true;
  return CLIENT_API_ALLOW_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

async function forwardClientApiRequest(
  deps: McpDeps,
  method: string,
  fullPath: string,
  body?: unknown,
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  if (!deps.requestOrigin) {
    return {
      ok: false,
      status: 500,
      body: { error: "MCP request origin unavailable for client API forwarding" },
    };
  }

  const url = `${deps.requestOrigin}${fullPath}`;
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
  };
  if (deps.requestAuthHeader) headers.Authorization = deps.requestAuthHeader;
  if (deps.requestCookieHeader) headers.Cookie = deps.requestCookieHeader;
  if (deps.callerJobId) headers["X-Job-Id"] = deps.callerJobId;

  let requestBody: string | undefined;
  if (body !== undefined && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
    });
    const responseText = await response.text();
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    let responseBody: unknown = responseText;
    if (contentType.includes("application/json") && responseText.trim()) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      body: { error: `Client API forwarding failed: ${err?.message ?? String(err)}` },
    };
  }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({
    name: "arkestrator",
    version: "1.0.0",
  });

  /** Check if the MCP caller has a specific permission. Returns an error result if denied, null if allowed. */
  function checkPermission(permission: UserPermissionKey): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
    if (!deps.principal) return null; // No principal available (legacy path) — allow
    if (principalHasPermission(deps.principal, permission)) return null;
    return {
      content: [{ type: "text" as const, text: `Permission denied: missing '${permission}' permission` }],
      isError: true,
    };
  }

  // ─── Bridge command tools ──────────────────────────────────────────────────

  // Tool: client_api_request
  // This gives MCP parity with non-admin client routes while keeping a strict path allowlist.
  server.tool(
    "client_api_request",
    "Call an Arkestrator client-safe REST endpoint through MCP. " +
      "Use this for full client parity actions such as rich job submission payloads " +
      "(runtime model/reasoning/verification options), training-job queueing, reprioritization, resume/requeue, and project/worker queries. " +
      "Admin-only routes are blocked by MCP allowlist and server permissions.",
    {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method"),
      path: z.string().describe("Absolute server path, e.g. /api/jobs or /api/settings/coordinator-playbooks/houdini/train-script-job"),
      body: z.any().optional().describe("JSON body for POST/PUT requests"),
    },
    async ({ method, path, body }) => {
      const normalized = normalizeClientPath(path);
      if (!normalized) {
        return {
          content: [{ type: "text" as const, text: `Invalid path: ${path}` }],
          isError: true,
        };
      }
      if (!isAllowedClientApiPath(normalized.pathname)) {
        return {
          content: [{
            type: "text" as const,
            text: `Path is not allowed via MCP client_api_request: ${normalized.pathname}`,
          }],
          isError: true,
        };
      }

      const result = await forwardClientApiRequest(deps, method, normalized.fullPath, body);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: result.ok,
            status: result.status,
            path: normalized.fullPath,
            method,
            body: result.body,
          }, null, 2),
        }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    "submit_job_intervention",
    "Submit operator guidance for a queued, paused, or supported running job. " +
      "Queued/paused jobs store the note for the next launch/resume. " +
      "Supported running jobs receive it when the active agent next checks its live guidance queue.",
    {
      job_id: z.string().describe("The job ID to guide"),
      text: z.string().describe("Operator note text"),
      source: z.enum(["jobs", "chat", "mcp"]).optional().describe("Submission surface label"),
    },
    async ({ job_id, text, source }) => {
      const denied = checkPermission("interveneJobs");
      if (denied) return denied;
      const result = await forwardClientApiRequest(
        deps,
        "POST",
        `/api/jobs/${job_id}/interventions`,
        { text, source: source ?? "mcp" },
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: result.ok,
            status: result.status,
            job_id,
            body: result.body,
          }, null, 2),
        }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    "list_job_interventions",
    "List intervention history and delivery state for a job. When the caller is that same running job, pending notes are marked delivered on fetch.",
    {
      job_id: z.string().describe("The job ID to inspect"),
    },
    async ({ job_id }) => {
      const result = await forwardClientApiRequest(
        deps,
        "GET",
        `/api/jobs/${job_id}/interventions`,
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: result.ok,
            status: result.status,
            job_id,
            body: result.body,
          }, null, 2),
        }],
        isError: !result.ok,
      };
    },
  );

  // Tool: execute_command
  server.tool(
    "execute_command",
    "Execute a script/command in a connected DCC bridge (Godot, Blender, Houdini). " +
      'Use "gdscript" language for Godot, "python" for Blender/Houdini. ' +
      "The command runs directly in the target application's scripting environment. " +
      "Blocks until execution completes (up to timeout).",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender", "houdini"'),
      language: z.string().describe('Script language: "gdscript" for Godot, "python" for Blender/Houdini'),
      script: z.string().describe("The script code to execute"),
      description: z.string().optional().describe("Optional description of what the script does"),
      timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
    },
    async ({ target, language, script, description, timeout }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const result = await executeBridgeCommand(
        deps.hub,
        deps.policiesRepo,
        deps.headlessProgramsRepo,
        deps.config,
        {
          target,
          commands: [{ language, script, description }],
          timeout,
          executionMode: callerJob?.runtimeOptions?.bridgeExecutionMode,
          targetWorkerName: callerJob?.targetWorkerName,
        },
        deps.resourceLeaseManager,
        deps.settingsRepo,
      );

      // Track which bridges were used by this job
      if (result.bridgesUsed?.length && deps.callerJobId) {
        for (const program of result.bridgesUsed) {
          deps.jobsRepo.addUsedBridge(deps.callerJobId, program);
        }
        const updatedJob = deps.jobsRepo.getById(deps.callerJobId);
        if (updatedJob) {
          deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: updatedJob } });
        }
      }

      if (result.error) {
        const parts = [`Error: ${result.error}`];
        if (result.result?.stdout) parts.push(`stdout:\n${result.result.stdout}`);
        if (result.result?.stderr) parts.push(`stderr:\n${result.result.stderr}`);
        if (result.result) parts.push(JSON.stringify(result.result, null, 2));
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          isError: true,
        };
      }

      // Include stdout prominently in the response so the agent can see script output
      const parts: string[] = [];
      if (result.result?.stdout) {
        parts.push(`stdout:\n${result.result.stdout}`);
      }
      if (result.result?.stderr) {
        parts.push(`stderr:\n${result.result.stderr}`);
      }
      parts.push(JSON.stringify(result.result, null, 2));
      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
      };
    },
  );

  // Tool: execute_multiple_commands
  server.tool(
    "execute_multiple_commands",
    "Execute multiple scripts in sequence on a bridge. Useful for batch operations.",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender"'),
      commands: z.array(z.object({
        language: z.string().describe('Script language: "gdscript" or "python"'),
        script: z.string().describe("The script code to execute"),
        description: z.string().optional().describe("What this script does"),
      })).describe("Array of commands to execute in order"),
      timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
    },
    async ({ target, commands, timeout }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const result = await executeBridgeCommand(
        deps.hub,
        deps.policiesRepo,
        deps.headlessProgramsRepo,
        deps.config,
        {
          target,
          commands,
          timeout,
          executionMode: callerJob?.runtimeOptions?.bridgeExecutionMode,
          targetWorkerName: callerJob?.targetWorkerName,
        },
        deps.resourceLeaseManager,
        deps.settingsRepo,
      );

      // Track which bridges were used by this job
      if (result.bridgesUsed?.length && deps.callerJobId) {
        for (const program of result.bridgesUsed) {
          deps.jobsRepo.addUsedBridge(deps.callerJobId, program);
        }
        const updatedJob = deps.jobsRepo.getById(deps.callerJobId);
        if (updatedJob) {
          deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: updatedJob } });
        }
      }

      if (result.error) {
        const parts = [`Error: ${result.error}`];
        if (result.result?.stdout) parts.push(`stdout:\n${result.result.stdout}`);
        if (result.result?.stderr) parts.push(`stderr:\n${result.result.stderr}`);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          isError: true,
        };
      }

      const parts: string[] = [];
      if (result.result?.stdout) parts.push(`stdout:\n${result.result.stdout}`);
      if (result.result?.stderr) parts.push(`stderr:\n${result.result.stderr}`);
      parts.push(JSON.stringify(result.result, null, 2));
      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
      };
    },
  );

  // Tool: read_client_file — read files from the client machine via bridge
  server.tool(
    "read_client_file",
    "Read a file from the client machine where a bridge is running. " +
      "Use this to analyze renders, project files, textures, or any file on the client's disk. " +
      "For images (png, jpg, exr, etc.), the file is saved locally and you can Read it visually. " +
      "For text files, the content is returned directly.",
    {
      path: z.string().describe("Absolute path to the file on the client machine"),
      target: z.string().optional().describe('Bridge program name (e.g. "blender") or bridge ID. Defaults to any connected bridge.'),
      targetWorkerName: z.string().optional().describe("Specific worker/machine name if multiple are connected"),
    },
    async ({ path: filePath, target, targetWorkerName: workerName }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;

      // Resolve target bridge
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const effectiveTarget = target || callerJob?.bridgeProgram || "";
      const effectiveWorker = workerName || callerJob?.targetWorkerName;

      let targetWs: import("bun").ServerWebSocket<import("../ws/hub.js").WsData> | undefined;
      if (effectiveTarget) {
        const resolution = resolveBridgeTargets(deps.hub, effectiveTarget, "program", effectiveWorker);
        targetWs = resolution.targets[0];
      }
      if (!targetWs) {
        // Fallback: try any connected bridge
        const bridges = deps.hub.getBridges();
        if (effectiveWorker) {
          targetWs = bridges.find((b) => (b.workerName ?? "").toLowerCase() === effectiveWorker.toLowerCase());
        }
        targetWs ??= bridges[0];
      }
      if (!targetWs) {
        return {
          content: [{ type: "text" as const, text: "Error: No bridge connected. Cannot read client files without a bridge connection." }],
          isError: true,
        };
      }

      // Send file read request via correlation pattern
      const correlationId = newId();
      const timeoutMs = 30_000;
      const resultPromise = deps.hub.registerPendingCommand(correlationId, timeoutMs);

      targetWs.send(JSON.stringify({
        type: "bridge_file_read_request",
        id: newId(),
        payload: { paths: [filePath], correlationId },
      }));

      try {
        const response = await resultPromise as {
          files: Array<{ path: string; content: string; encoding: string; size: number; error?: string }>;
        };

        if (!response?.files?.length) {
          return { content: [{ type: "text" as const, text: `Error: No response for file ${filePath}` }], isError: true };
        }

        const file = response.files[0];
        if (file.error) {
          return { content: [{ type: "text" as const, text: `Error reading ${filePath}: ${file.error}` }], isError: true };
        }

        // For binary/image files: write to temp dir so agent can use Read tool to see them visually
        const imageExts = [".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".exr", ".hdr", ".webp", ".gif"];
        const ext = filePath.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
        if (file.encoding === "base64" || imageExts.includes(ext)) {
          const dir = join(tmpdir(), "arkestrator-client-files", deps.callerJobId ?? "shared");
          mkdirSync(dir, { recursive: true });
          const safeName = filePath.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "");
          const localPath = join(dir, safeName);
          const buf = Buffer.from(file.content, "base64");
          writeFileSync(localPath, buf);
          return {
            content: [{
              type: "text" as const,
              text: `File saved to: ${localPath}\nSize: ${file.size} bytes\nUse the Read tool to view this file.`,
            }],
          };
        }

        // Text file: return content directly
        return {
          content: [{
            type: "text" as const,
            text: `File: ${filePath} (${file.size} bytes)\n\n${file.content}`,
          }],
        };
      } catch (err: any) {
        const msg = err?.message?.includes("timed out")
          ? `Timed out reading ${filePath} — bridge may not support file reading. Ensure bridge plugin is updated.`
          : `Error reading ${filePath}: ${err?.message ?? err}`;
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
    },
  );

  // Tool: list_bridges
  server.tool(
    "list_bridges",
    "List all currently connected DCC bridges (Godot, Blender, Houdini instances).",
    {},
    async () => {
      const bridges = listConnectedBridges(deps.hub);
      if (bridges.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No bridges currently connected." }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(bridges, null, 2) }],
      };
    },
  );

  // Tool: list_targets
  server.tool(
    "list_targets",
    "List available execution targets for orchestration: connected bridge instances by program and enabled headless programs.",
    {},
    async () => {
      const bridges = listConnectedBridges(deps.hub);
      const headlessPrograms = deps.headlessProgramsRepo.list()
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          program: entry.program,
          display_name: entry.displayName,
          language: entry.language,
        }));

      const targetPrograms = [...new Set([
        ...bridges.map((b) => String(b.program ?? "").trim()).filter(Boolean),
        ...headlessPrograms.map((h) => String(h.program ?? "").trim()).filter(Boolean),
      ])].sort();

      const groupedLiveBridges = Object.fromEntries(
        targetPrograms.map((program) => [
          program,
          bridges.filter((bridge) => bridge.program === program),
        ]),
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              target_programs: targetPrograms,
              live_bridges_by_program: groupedLiveBridges,
              headless_programs: headlessPrograms,
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  // Tool: get_bridge_context
  server.tool(
    "get_bridge_context",
    "Get the current editor context from a connected bridge — active file, project root, open files, and user-selected context items.",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender"'),
    },
    async ({ target }) => {
      const bridges = deps.hub.getBridgesByProgram(target);
      if (bridges.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No bridge connected for: ${target}` }],
          isError: true,
        };
      }

      const results: any[] = [];
      for (const ws of bridges) {
        const ctx = deps.hub.getBridgeContext(ws.data.id);
        results.push({
          bridgeId: ws.data.id,
          program: ws.data.program,
          workerName: ws.data.workerName,
          projectPath: ws.data.projectPath,
          editorContext: ctx?.editorContext ?? null,
          files: ctx?.files ?? [],
          contextItems: ctx?.items ?? [],
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ─── Job management tools ─────────────────────────────────────────────────
  // These tools allow an orchestrator agent to spawn sub-jobs targeting specific
  // DCC bridges, chain them with dependencies, and poll their status.
  // This enables multi-bridge workflows like:
  //   Blender → model assets → Godot → build game around them.

  // Tool: list_agent_configs
  server.tool(
    "list_agent_configs",
    "List available agent configurations (Claude Code, Codex, Gemini, etc.). " +
      "Use the returned IDs with create_job to choose which AI engine handles a sub-job.",
    {},
    async () => {
      const configs = deps.agentsRepo.list();
      if (configs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agent configs found. Create one in the Arkestrator client first." }],
          isError: true,
        };
      }
      const summary = configs.map((c: any) => ({
        id: c.id,
        name: c.name,
        engine: c.engine,
        model: c.model ?? null,
        priority: c.priority,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  // Tool: create_job
  server.tool(
    "create_job",
    "Create a new agent sub-job targeting a specific DCC bridge or worker. " +
      "Use this to delegate work to Blender, Godot, Houdini, etc. and optionally chain " +
      "jobs sequentially with dependency links. Returns the new job ID immediately. " +
      "The job enters the queue and starts as soon as a slot is free and all dependencies are done. " +
      "PARALLEL: create multiple jobs at once (no depends_on), poll all with get_job_status. " +
      "SEQUENTIAL: create_job → poll until done → verify → create next with depends_on_job_ids.",
    {
      prompt: z.string().describe("Task instructions for the sub-agent"),
      handover_notes: z.string().optional().describe(
        "Context from the parent job. Include: what was already done, what files exist, " +
        "project structure, decisions made. Gets prepended to the sub-job's prompt so it has full context.",
      ),
      agent_config_id: z.string().optional().describe(
        "Which agent config to use (ID from list_agent_configs). Defaults to the first claude-code config.",
      ),
      target_program: z.string().optional().describe(
        'Route to a specific DCC bridge: "blender", "godot", "houdini". ' +
        "The job targets the first connected bridge running that program.",
      ),
      target_worker: z.string().optional().describe(
        "Route to a specific worker machine by name (from list_bridges workerName field).",
      ),
      depends_on_job_ids: z.array(z.string()).optional().describe(
        "Job IDs that must complete before this job starts. " +
        "Scheduler holds this job until all listed jobs are in 'completed' state.",
      ),
      priority: z.enum(["low", "normal", "high", "critical"]).optional().describe(
        "Queue priority (default: normal).",
      ),
      name: z.string().optional().describe("Short label shown in the job list"),
      coordination_scripts: z.object({
        coordinator: z.enum(["enabled", "disabled", "auto"]).optional().describe(
          "Playbook matching and project guidance. Default: enabled.",
        ),
        bridge: z.enum(["enabled", "disabled", "auto"]).optional().describe(
          "Per-program coordinator scripts (godot.md, blender.md). Default: enabled.",
        ),
        training: z.enum(["enabled", "disabled", "auto"]).optional().describe(
          "Auto-generated training blocks. Default: enabled.",
        ),
      }).optional().describe(
        "Control which coordination scripts are included. All enabled by default. " +
        "Set to { coordinator: 'disabled', bridge: 'disabled', training: 'disabled' } for MCP-only mode.",
      ),
    },
    async ({ prompt, handover_notes, agent_config_id, target_program, target_worker, depends_on_job_ids, priority, name, coordination_scripts }) => {
      const denied = checkPermission("submitJobs");
      if (denied) return denied;
      // Resolve agent config — prefer provided ID, else first claude-code, else first available
      let configId = agent_config_id;
      if (!configId) {
        const configs = deps.agentsRepo.list();
        if (configs.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No agent configs available. Create one in the Arkestrator client." }],
            isError: true,
          };
        }
        const preferred = configs.find((c: any) => c.engine === "claude-code") ?? configs[0];
        configId = preferred.id;
      } else {
        const config = deps.agentsRepo.getById(configId);
        if (!config) {
          return {
            content: [{ type: "text" as const, text: `Agent config not found: ${configId}` }],
            isError: true,
          };
        }
      }

      // Resolve bridge info for target_program.
      // If a specific program is requested and no live bridge is connected, fail fast
      // instead of creating a queued job that will never be routed to the bridge. This
      // prevents the orchestrator from exiting with orphaned pending children.
      // Exception: headless programs can run without a live bridge (they use a local CLI).
      let bridgeId: string | undefined;
      let bridgeProgram: string | undefined;
      if (target_program) {
        bridgeProgram = target_program;
        const bridges = deps.hub.getBridgesByProgram(target_program);
        if (bridges.length > 0) {
          bridgeId = bridges[0].data.id;
        } else {
          // Check if a headless program is registered for this target (allows CLI-only execution)
          const headless = deps.headlessProgramsRepo?.list()
            .find((hp) => hp.program === target_program && hp.enabled);
          if (!headless) {
            return {
              content: [{
                type: "text" as const,
                text: `No "${target_program}" bridge is currently connected and no headless program is registered for it. ` +
                  `Start ${target_program} and enable the Arkestrator bridge plugin, then retry. ` +
                  `Alternatively, use execute_command once the bridge connects, or create the job without target_program to run it headlessly.`,
              }],
              isError: true,
            };
          }
        }
      }

      // Create the job (starts as queued — worker picks it up as soon as a slot is free
      // and all dependencies are satisfied)
      // Prepend handover notes to prompt so the sub-agent has full context from the parent
      const fullPrompt = handover_notes
        ? `## Context from Coordinator\n\n${handover_notes}\n\n---\n\n## Your Task\n\n${prompt}`
        : prompt;
      // Build runtime options if coordination overrides were provided
      const runtimeOptions = coordination_scripts
        ? {
            coordinationScripts: {
              coordinator: coordination_scripts.coordinator ?? "enabled" as const,
              bridge: coordination_scripts.bridge ?? "enabled" as const,
              training: coordination_scripts.training ?? "enabled" as const,
            },
          }
        : undefined;

      const job = deps.jobsRepo.create(
        {
          prompt: fullPrompt,
          agentConfigId: configId,
          priority: priority ?? "normal",
          coordinationMode: "server",
          name,
          files: [],
          contextItems: [],
          startPaused: false,
          runtimeOptions,
        },
        bridgeId,
        bridgeProgram,
        undefined,          // workerName (auto-detected by bridge)
        target_worker,      // targetWorkerName (optional explicit worker)
        undefined,          // submittedBy (system / orchestrator agent)
        deps.callerJobId,   // parentJobId — links sub-job to the orchestrator's chat tab
      );

      // Wire up dependency links so the scheduler holds this job until deps complete
      if (depends_on_job_ids && depends_on_job_ids.length > 0) {
        for (const depId of depends_on_job_ids) {
          try {
            deps.depsRepo.add(job.id, depId);
          } catch {
            // Ignore invalid or duplicate dep references
          }
        }
      }

      // Notify all connected clients so the UI shows the new job immediately
      const freshJob = deps.jobsRepo.getById(job.id);
      if (freshJob) {
        deps.hub.broadcastToType("client", {
          type: "job_updated",
          id: newId(),
          payload: { job: freshJob },
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            job_id: job.id,
            status: job.status,
            target_program: bridgeProgram ?? null,
            target_worker: target_worker ?? null,
            depends_on: depends_on_job_ids ?? [],
            message: depends_on_job_ids?.length
              ? `Job queued. Waiting for ${depends_on_job_ids.length} dependency job(s) to complete before starting.`
              : "Job queued. Will start as soon as a worker slot is free.",
          }, null, 2),
        }],
      };
    },
  );

  // Tool: get_job_status
  server.tool(
    "get_job_status",
    "Check the current status of a job. Poll this to know when a sub-job has finished " +
      "so you can proceed with dependent work or verify results. " +
      "Status values: queued | running | completed | failed | cancelled | paused.",
    {
      job_id: z.string().describe("The job ID returned by create_job"),
    },
    async ({ job_id }) => {
      const job = deps.jobsRepo.getById(job_id);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Job not found: ${job_id}` }],
          isError: true,
        };
      }

      const result: Record<string, any> = {
        job_id: job.id,
        status: job.status,
        created_at: job.createdAt,
        started_at: job.startedAt ?? null,
        completed_at: job.completedAt ?? null,
      };

      if (job.error) result.error = job.error;

      if (job.status === "completed") {
        if (job.result && Array.isArray(job.result) && job.result.length > 0) {
          result.files_changed = job.result.length;
          result.file_paths = (job.result as any[]).map((f) => `${f.action}: ${f.path}`);
        }
        if (job.commands && Array.isArray(job.commands) && job.commands.length > 0) {
          result.commands_executed = job.commands.length;
        }
        // Include last 20 lines of logs as summary for the parent coordinator
        if (job.logs) {
          const logLines = job.logs.split("\n").filter((l: string) => l.trim());
          result.output_summary = logLines.slice(-20).join("\n");
        }
      }

      if (job.status === "failed") {
        // Include last 10 lines of logs for failed jobs to help diagnose
        if (job.logs) {
          const logLines = job.logs.split("\n").filter((l: string) => l.trim());
          result.output_summary = logLines.slice(-10).join("\n");
        }
      }

      // Show which dependency jobs are still blocking this job
      try {
        const blocking = deps.depsRepo.getBlockingDeps(job_id);
        if (blocking.length > 0) {
          result.waiting_on_job_ids = blocking;
        }
      } catch {
        // ignore
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // Tool: get_job_logs
  server.tool(
    "get_job_logs",
    "Fetch recent log lines for a job. Use this when status is running/failed/completed and you need fuller output than get_job_status summary.",
    {
      job_id: z.string().describe("The job ID returned by create_job"),
      lines: z.number().optional().describe("How many trailing lines to return (default 120, max 2000)"),
    },
    async ({ job_id, lines }) => {
      const job = deps.jobsRepo.getById(job_id);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Job not found: ${job_id}` }],
          isError: true,
        };
      }

      const requestedLines = typeof lines === "number" && Number.isFinite(lines)
        ? Math.floor(lines)
        : 120;
      const maxLines = Math.min(Math.max(requestedLines, 1), 2000);
      const allLines = (job.logs ?? "")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      const tail = allLines.slice(-maxLines);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              job_id: job.id,
              status: job.status,
              total_lines: allLines.length,
              returned_lines: tail.length,
              logs: tail.join("\n"),
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  // Tool: list_jobs
  server.tool(
    "list_jobs",
    "List recent jobs and their statuses. Useful for an overview of what sub-jobs are " +
      "queued, running, or completed in the current session.",
    {
      status: z.enum(["queued", "running", "completed", "failed", "cancelled", "paused"]).optional().describe(
        "Filter by status. Omit to list all recent jobs.",
      ),
      limit: z.number().optional().describe("Max results (default 20, max 50)"),
    },
    async ({ status, limit }) => {
      const cap = Math.min(limit ?? 20, 50);
      const { jobs } = deps.jobsRepo.list(
        status ? [status] : [],
        cap,
        0,
      );

      const summary = jobs.map((j) => ({
        job_id: j.id,
        name: j.name ?? j.prompt?.slice(0, 60),
        status: j.status,
        target: j.bridgeProgram ?? j.targetWorkerName ?? "any",
        created_at: j.createdAt,
        started_at: j.startedAt ?? null,
        completed_at: j.completedAt ?? null,
        error: j.error ?? null,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  // Tool: cancel_job
  server.tool(
    "cancel_job",
    "Cancel a queued/paused/running job. Running jobs are terminated first when process tracking is available.",
    {
      job_id: z.string().describe("The job ID to cancel"),
    },
    async ({ job_id }) => {
      const denied = checkPermission("submitJobs"); // cancel requires same perm as submit
      if (denied) return denied;
      const job = deps.jobsRepo.getById(job_id);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Job not found: ${job_id}` }],
          isError: true,
        };
      }
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return {
          content: [{
            type: "text" as const,
            text: `Job ${job_id} is already terminal with status "${job.status}".`,
          }],
          isError: true,
        };
      }

      if (job.status === "running") {
        deps.processTracker?.kill(job_id);
      }
      const cancelled = deps.jobsRepo.cancel(job_id);
      if (!cancelled) {
        return {
          content: [{ type: "text" as const, text: `Cannot cancel job ${job_id} from status "${job.status}".` }],
          isError: true,
        };
      }

      const updatedJob = deps.jobsRepo.getById(job_id);
      if (updatedJob) {
        deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: updatedJob } });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              job_id: job_id,
              previous_status: job.status,
              status: "cancelled",
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  // Tool: run_headless_check
  server.tool(
    "run_headless_check",
    "Run a DCC application in headless/CLI mode and capture its output. " +
      "Use this to verify a Godot project can load and start without errors, " +
      "or to run a Blender Python script non-interactively. " +
      "Returns full stdout + stderr for analysis. " +
      "Requires the program to be registered in Headless Programs settings with its executable path.",
    {
      program: z.string().describe(
        'Program to run: "godot", "blender", "houdini". Must be registered in Headless Programs settings.',
      ),
      args: z.array(z.string()).describe(
        'Command-line arguments. Examples: ' +
        'Godot error check: ["--headless", "--quit", "--path", "/path/to/project"] ' +
        'Godot parse-only: ["--headless", "--check-only", "--script", "res://verify.gd", "--path", "/path/to/project"] ' +
        'Blender script: ["--background", "--python", "/path/to/script.py"]',
      ),
      project_path: z.string().optional().describe(
        "Working directory for the process (usually the project root). " +
        "For Godot, pass the project directory here if not in --path arg.",
      ),
      timeout: z.number().optional().describe("Timeout in ms (default 30000, max 120000)"),
    },
    async ({ program, args, project_path, timeout }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const result = await runHeadlessCheck(deps.hub, deps.headlessProgramsRepo, deps.resourceLeaseManager, {
        program,
        args,
        projectPath: project_path,
        timeout,
        targetWorkerName: callerJob?.targetWorkerName,
      });
      if (result.error) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.output ?? "(no output)" }],
      };
    },
  );

  // ── Skills tools ─────────────────────────────────────────────────────

  server.tool(
    "search_skills",
    "Search for relevant skills and guidance by query. Returns matching skills ranked by relevance. " +
      "Use this to find execution patterns, training insights, playbooks, and task-specific guidance before starting work.",
    {
      query: z.string().describe("Search query — describe what you need guidance on"),
      program: z.string().optional().describe("Filter by bridge program (e.g. 'blender', 'godot')"),
      category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "project-reference", "housekeeping", "custom"]).optional().describe("Filter by skill category"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, program, category, limit }) => {
      if (!deps.skillIndex) {
        return { content: [{ type: "text" as const, text: "Skills system not initialized" }], isError: true };
      }
      const results = deps.skillIndex.search(query, { program: program || undefined, category: category || undefined, limit });
      const text = results.length === 0
        ? "No matching skills found."
        : results.map((r) => `- **${r.slug}** (${r.category}/${r.program}) score=${r.relevanceScore.toFixed(2)}\n  ${r.title}: ${r.description}`).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "get_skill",
    "Fetch the full content of a specific skill by its slug. Call this after search_skills to get detailed instructions, " +
      "patterns, and guidance for your task.",
    {
      slug: z.string().describe("The skill slug from search results or auto-fetch list"),
      program: z.string().optional().describe("Filter by program if slug exists for multiple programs"),
    },
    async ({ slug, program }) => {
      if (!deps.skillIndex) {
        return { content: [{ type: "text" as const, text: "Skills system not initialized" }], isError: true };
      }
      const skill = deps.skillIndex.get(slug, program || undefined);
      if (!skill) {
        return { content: [{ type: "text" as const, text: `Skill not found: ${slug}` }], isError: true };
      }
      // Resolve template variables using live bridge state
      let content = skill.content;
      try {
        const { resolveSkillTemplateVars } = await import("../skills/skill-templates.js");
        const bridges = deps.hub.getConnections().filter((c) => c.type === "bridge");
        const bridgeList = bridges.length > 0
          ? bridges.map((b) => `${b.program ?? "unknown"} (${b.workerName ?? "?"})`).join(", ")
          : "No bridges connected";
        content = resolveSkillTemplateVars(content, bridgeList, "", "");
      } catch {}
      return { content: [{ type: "text" as const, text: `# ${skill.title}\n\n${content}` }] };
    },
  );

  server.tool(
    "list_skills",
    "List all available skills, optionally filtered by program or category. " +
      "Use to discover what guidance is available before searching.",
    {
      program: z.string().optional().describe("Filter by bridge program"),
      category: z.enum(["coordinator", "bridge", "training", "playbook", "verification", "project", "project-reference", "housekeeping", "custom"]).optional().describe("Filter by category"),
    },
    async ({ program, category }) => {
      if (!deps.skillIndex) {
        return { content: [{ type: "text" as const, text: "Skills system not initialized" }], isError: true };
      }
      const results = deps.skillIndex.list({ program: program || undefined, category: category || undefined });
      const text = results.length === 0
        ? "No skills available."
        : results.map((r) => `- **${r.slug}** (${r.category}/${r.program}) ${r.autoFetch ? "[auto-fetch]" : ""}\n  ${r.title}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}
