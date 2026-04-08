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
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { principalHasPermission, type AuthPrincipal } from "../middleware/auth.js";
import type { UserPermissionKey } from "../utils/user-permissions.js";
import { checkCommandScripts, checkFilePaths, checkScriptFilePaths } from "../policies/enforcer.js";
import { validateSkill } from "../skills/skill-validator.js";

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
  /** Skill effectiveness repo for agent self-assessment of skill usefulness. */
  skillEffectivenessRepo?: import("../db/skill-effectiveness.repo.js").SkillEffectivenessRepo;
  /** Skills repo for creating/updating skills from agents. */
  skillsRepo?: import("../db/skills.repo.js").SkillsRepo;
  /** SkillStore facade for dual-write (SQLite + disk) skill mutations. */
  skillStore?: import("../skills/skill-store.js").SkillStore;
  /** Handoff notes repo for inter-agent communication. */
  handoffRepo?: import("../db/handoff.repo.js").HandoffRepo;
  /** API bridges repo for external REST API integrations. */
  apiBridgesRepo?: import("../db/api-bridges.repo.js").ApiBridgesRepo;
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
  "/api/api-bridges",
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

/**
 * Kill the calling agent job when a policy violation is detected in an MCP tool.
 * This prevents the agent from retrying with creative workarounds.
 */
function killCallerJob(deps: McpDeps, reason: string): void {
  if (!deps.callerJobId) return;
  // Kill the process immediately so the agent can't try again
  if (deps.processTracker) {
    deps.processTracker.kill(deps.callerJobId);
  }
  // Mark the job as failed
  try {
    deps.jobsRepo.fail(deps.callerJobId, `[POLICY VIOLATION] ${reason}`, "");
    deps.hub.broadcastToType("client", {
      type: "job_updated",
      id: newId(),
      payload: { job: deps.jobsRepo.getById(deps.callerJobId) },
    });
  } catch { /* best effort */ }
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

  /**
   * Resolve a #T<N> task reference to a job UUID.
   * Accepts: "#T1", "T1", or a raw UUID (returned as-is).
   */
  function resolveTaskRef(ref: string, deps: McpDeps): string {
    // Strip leading # if present
    const cleaned = ref.startsWith("#") ? ref.slice(1) : ref;
    // Check if it matches T<number> pattern
    const match = cleaned.match(/^T(\d+)$/i);
    if (!match || !deps.callerJobId) return ref; // Return as-is (assume UUID)

    // Look up child jobs of the caller with this task_ref
    const children = deps.jobsRepo.getChildJobs(deps.callerJobId);
    const taskJob = children.find((j: any) => j.taskRef === cleaned.toUpperCase());
    return taskJob?.id ?? ref;
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
    "Execute a script/command in a connected DCC bridge (Godot, Blender, Houdini, ComfyUI). " +
      'Use "gdscript" language for Godot, "python" for Blender/Houdini, "workflow" for ComfyUI (JSON workflow). ' +
      "The command runs directly in the target application's scripting environment. " +
      "For ComfyUI, the script should be a JSON workflow object (API format). " +
      "Blocks until execution completes (up to timeout). " +
      "When multiple bridges of the same program are connected (e.g. Blender on two machines), use worker or bridge_id to target a specific one.",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender", "houdini", "comfyui". When using bridge_id, set this to the program name as a hint (e.g. "blender").'),
      language: z.string().describe('Script language: "gdscript" for Godot, "python" for Blender/Houdini, "workflow" for ComfyUI'),
      script: z.string().describe("The script code to execute"),
      description: z.string().optional().describe("Optional description of what the script does"),
      timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
      worker: z.string().optional().describe('Target a specific machine by worker name, e.g. "tim\'s-macbook-pro" or "tvh-13900k". Use list_bridges to discover worker names.'),
      bridge_id: z.string().optional().describe("Target a specific bridge by its exact ID (from list_bridges). Takes precedence over worker."),
    },
    async ({ target, language, script, description, timeout, worker, bridge_id }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const result = await executeBridgeCommand(
        deps.hub,
        deps.policiesRepo,
        deps.headlessProgramsRepo,
        deps.config,
        {
          target: bridge_id ?? target,
          targetType: bridge_id ? "id" : "program",
          commands: [{ language, script, description }],
          timeout,
          executionMode: callerJob?.runtimeOptions?.bridgeExecutionMode,
          targetWorkerName: worker ?? callerJob?.targetWorkerName,
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
        // Kill the job if it was a policy violation (status 403)
        if (result.status === 403) {
          killCallerJob(deps, result.error);
        }
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
    "Execute multiple scripts in sequence on a bridge. Useful for batch operations. " +
      "When multiple bridges of the same program are connected (e.g. Blender on two machines), use worker or bridge_id to target a specific one.",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender", "comfyui". When using bridge_id, set this to the program name as a hint.'),
      commands: z.array(z.object({
        language: z.string().describe('Script language: "gdscript", "python", or "workflow" (ComfyUI)'),
        script: z.string().describe("The script code to execute"),
        description: z.string().optional().describe("What this script does"),
      })).describe("Array of commands to execute in order"),
      timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
      worker: z.string().optional().describe('Target a specific machine by worker name, e.g. "tim\'s-macbook-pro" or "tvh-13900k". Use list_bridges to discover worker names.'),
      bridge_id: z.string().optional().describe("Target a specific bridge by its exact ID (from list_bridges). Takes precedence over worker."),
    },
    async ({ target, commands, timeout, worker, bridge_id }) => {
      const denied = checkPermission("executeCommands");
      if (denied) return denied;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const result = await executeBridgeCommand(
        deps.hub,
        deps.policiesRepo,
        deps.headlessProgramsRepo,
        deps.config,
        {
          target: bridge_id ?? target,
          targetType: bridge_id ? "id" : "program",
          commands,
          timeout,
          executionMode: callerJob?.runtimeOptions?.bridgeExecutionMode,
          targetWorkerName: worker ?? callerJob?.targetWorkerName,
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
        if (result.status === 403) {
          killCallerJob(deps, result.error);
        }
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

  // Tool: execute_local — run shell commands or Python scripts directly on a worker machine
  server.tool(
    "execute_local",
    "Execute a shell command or Python script directly on a connected worker machine (Tauri desktop client). " +
      "Does NOT require any DCC bridge — use this for filesystem operations, running CLI tools, " +
      "checking paths, or executing Python scripts on the worker's local environment. " +
      'Use mode "shell" for bash/cmd commands, or "python" for Python scripts. ' +
      "Blocks until execution completes (up to timeout).",
    {
      mode: z.enum(["shell", "python"]).describe('Execution mode: "shell" for bash/cmd, "python" for Python scripts'),
      command: z.string().describe("Shell command string or Python script code"),
      cwd: z.string().optional().describe("Working directory for execution"),
      timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
    },
    async ({ mode, command, cwd, timeout }) => {
      const denied = checkPermission("executeLocal");
      if (denied) return denied;

      // Resolve target client (also needed for policy user context)
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;

      // Apply command_filter policies (use job submitter for user-scoped policies)
      const policies = deps.policiesRepo.getEffectiveForUser(callerJob?.submittedBy ?? null);
      const violations = checkCommandScripts([{ language: mode, script: command }], policies);
      const blockers = violations.filter((v) => v.action === "block");
      if (blockers.length > 0) {
        const msg = `Command blocked by policy: ${blockers.map((b) => b.message).join("; ")}`;
        killCallerJob(deps, msg);
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }

      // Apply file_path policies — extract paths from script and check against blocked patterns
      const fpViolations = checkScriptFilePaths(command, policies);
      const fpBlockers = fpViolations.filter((v) => v.action === "block");
      if (fpBlockers.length > 0) {
        const msg = `Command blocked by file_path policy: ${fpBlockers.map((b) => b.message).join("; ")}`;
        killCallerJob(deps, msg);
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }

      const targetWorkerName = callerJob?.targetWorkerName;

      let clientId: string | undefined;
      if (targetWorkerName) {
        const clients = deps.hub.getClientConnectionsByWorker(targetWorkerName);
        if (clients.length === 1) {
          clientId = clients[0].data.id;
        } else if (clients.length > 1) {
          return {
            content: [{ type: "text" as const, text: `Multiple desktop clients connected for worker "${targetWorkerName}"` }],
            isError: true,
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `No connected desktop client for worker "${targetWorkerName}"` }],
            isError: true,
          };
        }
      } else {
        // No explicit worker — use any single connected client
        const allClients = deps.hub.getClients();
        if (allClients.length === 1) {
          clientId = allClients[0].id;
        } else if (allClients.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No desktop client connected. Cannot execute local commands without a connected Arkestrator client." }],
            isError: true,
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Multiple desktop clients connected (${allClients.length}). Specify a targetWorkerName on the job to disambiguate.` }],
            isError: true,
          };
        }
      }

      const timeoutMs = Math.min(Math.max(typeof timeout === "number" ? timeout : 60_000, 1_000), 300_000);
      const correlationId = newId();
      const resultPromise = deps.hub.registerPendingCommand(correlationId, timeoutMs);

      deps.hub.send(clientId, {
        type: "worker_local_command",
        id: newId(),
        payload: {
          senderId: "mcp-tool",
          correlationId,
          mode,
          command,
          cwd,
          timeoutMs,
        },
      });

      try {
        const result = await resultPromise as {
          success: boolean;
          stdout?: string;
          stderr?: string;
          exitCode?: number;
          errors?: string[];
          timedOut?: boolean;
        };

        if (!result.success) {
          const parts: string[] = [];
          if (result.errors?.length) parts.push(...result.errors);
          if (result.stderr?.trim()) parts.push(`stderr: ${result.stderr.trim()}`);
          if (result.timedOut) parts.push(`Timed out after ${timeoutMs}ms`);
          return {
            content: [{ type: "text" as const, text: `Error: ${parts.join("\n") || "Local execution failed"}` }],
            isError: true,
          };
        }

        const parts: string[] = [];
        if (result.stdout?.trim()) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr?.trim()) parts.push(`stderr:\n${result.stderr}`);
        if (result.exitCode !== undefined && result.exitCode !== null) parts.push(`exit code: ${result.exitCode}`);
        if (parts.length === 0) parts.push("(no output)");
        return {
          content: [{ type: "text" as const, text: parts.join("\n\n") }],
        };
      } catch (err: any) {
        const msg = err?.message?.includes("timed out")
          ? `Timed out after ${timeoutMs}ms — the command may still be running on the worker.`
          : `Error: ${err?.message ?? err}`;
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
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

      // Resolve target: try bridges first, then fall back to any connected client
      let targetId: string | undefined;

      if (effectiveTarget) {
        const resolution = resolveBridgeTargets(deps.hub, effectiveTarget, "program", effectiveWorker);
        targetId = resolution.targets[0]?.data.id;
      }
      if (!targetId) {
        // Try any connected bridge (skip virtual bridges — they can't handle file reads)
        const bridges = deps.hub.getBridges().filter((b) => !b.id.startsWith("virtual:"));
        const match = effectiveWorker
          ? bridges.find((b) => (b.workerName ?? "").toLowerCase() === effectiveWorker.toLowerCase())
          : bridges[0];
        targetId = match?.id;
      }
      if (!targetId) {
        // Fall back to any connected client (Tauri app) — it can also read local files
        const clients = deps.hub.getClients();
        const match = effectiveWorker
          ? clients.find((c) => (c.workerName ?? "").toLowerCase() === effectiveWorker.toLowerCase())
          : clients[0];
        targetId = match?.id;
      }
      if (!targetId) {
        return {
          content: [{ type: "text" as const, text: "Error: No bridge or client connected. Cannot read files without a connection to the client machine." }],
          isError: true,
        };
      }

      // Send file read request via correlation pattern
      const correlationId = newId();
      const timeoutMs = 30_000;
      const resultPromise = deps.hub.registerPendingCommand(correlationId, timeoutMs);

      deps.hub.send(targetId, {
        type: "bridge_file_read_request",
        id: newId(),
        payload: { paths: [filePath], correlationId },
      });

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
    "List all currently connected DCC bridges (Godot, Blender, Houdini, ComfyUI instances).",
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

      // Include enabled API bridges
      const apiBridges = deps.apiBridgesRepo
        ? deps.apiBridgesRepo.listEnabled().map((b) => ({
            name: b.name,
            display_name: b.displayName,
            type: b.type,
            preset_id: b.presetId,
          }))
        : [];

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              target_programs: targetPrograms,
              live_bridges_by_program: groupedLiveBridges,
              headless_programs: headlessPrograms,
              api_bridges: apiBridges,
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
        "Context from the parent job. Include: what was already done, what files/renders exist and their paths, " +
        "project structure, decisions made. For pipeline jobs (render → composite → export), " +
        "include paths to upstream outputs so the sub-job can verify its results against them. " +
        "Gets prepended to the sub-job's prompt so it has full context.",
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
        } else if (!deps.hub.hasVirtualBridgeForProgram(target_program)) {
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
      // Build runtime options: inherit everything from parent, then apply
      // sub-job-specific overrides (coordination scripts from create_job args)
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const parentRuntimeOpts = callerJob?.runtimeOptions as Record<string, unknown> | undefined;
      const runtimeOptions: Record<string, unknown> = {
        ...parentRuntimeOpts,
      };
      // Apply coordination script overrides from create_job args
      if (coordination_scripts) {
        runtimeOptions.coordinationScripts = {
          coordinator: coordination_scripts.coordinator ?? "enabled" as const,
          bridge: coordination_scripts.bridge ?? "enabled" as const,
          training: coordination_scripts.training ?? "enabled" as const,
        };
      }

      const job = deps.jobsRepo.create(
        {
          prompt: fullPrompt,
          mode: "agentic" as const,
          agentConfigId: configId,
          priority: priority ?? "normal",
          coordinationMode: "server",
          name,
          files: [],
          contextItems: [],
          startPaused: false,
          runtimeOptions: Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined,
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
    "Check the current status of a job or task. Poll this to know when a sub-job has finished " +
      "so you can proceed with dependent work or verify results. " +
      "Accepts a job UUID or a #T<N> task reference (e.g., '#T1'). " +
      "Status values: queued | running | completed | failed | cancelled | paused.",
    {
      job_id: z.string().describe("Job UUID or #T<N> task reference (e.g., '#T1', 'T1', or a UUID)"),
    },
    async ({ job_id }) => {
      const resolvedId = resolveTaskRef(job_id, deps);
      const job = deps.jobsRepo.getById(resolvedId);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Job not found: ${job_id}` }],
          isError: true,
        };
      }

      const result: Record<string, any> = {
        job_id: job.id,
        status: job.status,
        mode: job.mode ?? "agentic",
        created_at: job.createdAt,
        started_at: job.startedAt ?? null,
        completed_at: job.completedAt ?? null,
      };

      if (job.taskRef) result.task_ref = `#${job.taskRef}`;
      if (job.taskProgress != null) result.progress = job.taskProgress;
      if (job.taskStatusText) result.status_text = job.taskStatusText;
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

  // Tool: create_jobs (batch)
  server.tool(
    "create_jobs",
    "Create multiple sub-jobs at once for parallel execution. " +
      "Use this instead of calling create_job repeatedly when launching independent sub-jobs across different bridges. " +
      "Returns all job IDs immediately. Each job enters the queue independently.",
    {
      jobs: z.array(z.object({
        prompt: z.string().describe("Task instructions for the sub-agent"),
        handover_notes: z.string().optional().describe("Context from the parent job"),
        target_program: z.string().optional().describe("Route to a specific DCC bridge"),
        target_worker: z.string().optional().describe("Route to a specific worker machine"),
        depends_on_job_ids: z.array(z.string()).optional().describe("Job IDs that must complete first"),
        name: z.string().optional().describe("Short label shown in the job list"),
      })).min(1).max(20).describe("Array of jobs to create (max 20)"),
    },
    async ({ jobs: jobSpecs }) => {
      const denied = checkPermission("submitJobs");
      if (denied) return denied;

      // Resolve agent config once for all jobs
      const configs = deps.agentsRepo.list();
      if (configs.length === 0) {
        return { content: [{ type: "text" as const, text: "No agent configs available." }], isError: true };
      }
      const defaultConfigId = (configs.find((c: any) => c.engine === "claude-code") ?? configs[0]).id;
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const parentRuntimeOpts = callerJob?.runtimeOptions as Record<string, unknown> | undefined;

      const results: Array<{ name?: string; job_id: string; status: string; target_program?: string; error?: string }> = [];

      for (const spec of jobSpecs) {
        try {
          let bridgeId: string | undefined;
          let bridgeProgram: string | undefined;
          if (spec.target_program) {
            bridgeProgram = spec.target_program;
            const bridges = deps.hub.getBridgesByProgram(spec.target_program);
            if (bridges.length > 0) {
              bridgeId = bridges[0].data.id;
            } else if (!deps.hub.hasVirtualBridgeForProgram(spec.target_program)) {
              const headless = deps.headlessProgramsRepo?.list()
                ?.find((hp) => hp.program === spec.target_program && hp.enabled);
              if (!headless) {
                results.push({ name: spec.name, job_id: "", status: "error", target_program: spec.target_program, error: `No "${spec.target_program}" bridge connected` });
                continue;
              }
            }
          }

          const fullPrompt = spec.handover_notes
            ? `## Context from Coordinator\n\n${spec.handover_notes}\n\n---\n\n## Your Task\n\n${spec.prompt}`
            : spec.prompt;
          const runtimeOptions: Record<string, unknown> = { ...parentRuntimeOpts };

          const job = deps.jobsRepo.create(
            {
              prompt: fullPrompt,
              mode: "agentic" as const,
              agentConfigId: defaultConfigId,
              priority: "normal",
              coordinationMode: "server",
              name: spec.name,
              files: [],
              contextItems: [],
              startPaused: false,
              runtimeOptions: Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined,
            },
            bridgeId,
            bridgeProgram,
            undefined,
            spec.target_worker,
            undefined,
            deps.callerJobId,
          );

          if (spec.depends_on_job_ids?.length) {
            for (const depId of spec.depends_on_job_ids) {
              try { deps.depsRepo.add(job.id, depId); } catch {}
            }
          }

          const freshJob = deps.jobsRepo.getById(job.id);
          if (freshJob) {
            deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: freshJob } });
          }

          results.push({ name: spec.name, job_id: job.id, status: job.status, target_program: bridgeProgram });
        } catch (err: any) {
          results.push({ name: spec.name, job_id: "", status: "error", error: err?.message ?? String(err) });
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ created: results.filter((r) => r.status !== "error").length, jobs: results }, null, 2) }] };
    },
  );

  // Tool: poll_jobs (batch status check)
  server.tool(
    "poll_jobs",
    "Check status of multiple jobs/tasks at once. Use after create_jobs or create_tasks to wait for completion. " +
      "Accepts job UUIDs or #T<N> task references. Returns status for each. When all are completed/failed, you can proceed.",
    {
      job_ids: z.array(z.string()).min(1).max(50).describe("Job UUIDs or #T<N> task references to check"),
    },
    async ({ job_ids }) => {
      const results: Array<Record<string, any>> = [];
      let allDone = true;

      for (const id of job_ids) {
        const resolvedId = resolveTaskRef(id, deps);
        const job = deps.jobsRepo.getById(resolvedId);
        if (!job) {
          results.push({ job_id: id, status: "not_found" });
          continue;
        }
        const entry: Record<string, any> = {
          job_id: job.id,
          name: job.name ?? null,
          status: job.status,
          started_at: job.startedAt ?? null,
          completed_at: job.completedAt ?? null,
        };
        if (job.taskRef) entry.task_ref = `#${job.taskRef}`;
        if (job.taskProgress != null) entry.progress = job.taskProgress;
        if (job.taskStatusText) entry.status_text = job.taskStatusText;
        if (job.error) entry.error = job.error;
        if (job.status === "completed" && job.logs) {
          const logLines = job.logs.split("\n").filter((l: string) => l.trim());
          entry.output_summary = logLines.slice(-10).join("\n");
        }
        if (!["completed", "failed", "cancelled"].includes(job.status)) {
          allDone = false;
        }
        results.push(entry);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ all_done: allDone, jobs: results }, null, 2),
        }],
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

  // Tool: create_task — non-agentic task job
  server.tool(
    "create_task",
    "MANDATORY for deterministic operations — use this instead of execute_command when you already know the exact script to run. " +
      "Creates a non-agentic task job that runs directly on a bridge or worker without an AI agent. " +
      "Use for renders, caches, simulations, exports, bakes — anything that just runs a known command without needing AI reasoning. " +
      "Saves tokens and gives users progress tracking in the UI. " +
      "Returns a job ID (and #T ref if tracked) — monitor with get_job_status / poll_jobs. " +
      "RENDER FARM: Use create_tasks (batch) to split work across multiple machines.",
    {
      name: z.string().describe("Short display name (e.g., 'Render frames 1-100')"),
      execution_type: z.enum(["bridge_command", "worker_local", "worker_headless"]).describe(
        "How to execute: bridge_command (send to live DCC bridge), worker_local (shell/python on worker), worker_headless (headless DCC CLI)",
      ),
      target_program: z.string().optional().describe(
        'DCC program for bridge_command/worker_headless: "blender", "godot", "houdini", etc.',
      ),
      commands: z.array(z.object({
        language: z.string().describe('Scripting language: "python", "gdscript", etc.'),
        script: z.string().describe("Script code to execute"),
        description: z.string().optional().describe("What this command does"),
      })).optional().describe("Commands for bridge_command/worker_headless execution"),
      command: z.string().optional().describe("Shell command or Python script for worker_local execution"),
      local_mode: z.enum(["shell", "python"]).optional().describe("Execution mode for worker_local (default: shell)"),
      cwd: z.string().optional().describe("Working directory override"),
      target_worker: z.string().optional().describe("Route to specific machine by worker name"),
      timeout_ms: z.number().optional().describe("Max runtime in milliseconds (default: 600000 = 10 min)"),
      priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("Queue priority (default: normal)"),
      depends_on_job_ids: z.array(z.string()).optional().describe("Job IDs that must complete first"),
      track: z.boolean().optional().default(true).describe(
        "Assign a stable #T<N> reference for monitoring. Default: true.",
      ),
    },
    async ({ name, execution_type, target_program, commands, command, local_mode, cwd, target_worker, timeout_ms, priority, depends_on_job_ids, track }) => {
      const denied = checkPermission("submitJobs");
      if (denied) return denied;

      // Resolve a dummy agent config ID (task jobs don't use it, but the column is NOT NULL)
      const configs = deps.agentsRepo.list();
      const fallbackConfigId = configs[0]?.id;
      if (!fallbackConfigId) {
        return {
          content: [{ type: "text" as const, text: "No agent configs available. Create one in the Arkestrator client first." }],
          isError: true,
        };
      }

      const job = deps.jobsRepo.create(
        {
          mode: "task",
          name,
          prompt: `[Task] ${name}`,
          agentConfigId: fallbackConfigId,
          priority: priority ?? "normal",
          coordinationMode: "server",
          files: [],
          contextItems: [],
          startPaused: false,
          targetWorkerName: target_worker,
          taskSpec: {
            executionType: execution_type,
            targetProgram: target_program,
            commands,
            command,
            localMode: local_mode,
            cwd,
            timeoutMs: timeout_ms ?? 600_000,
            label: name,
          },
          track: track !== false,
        },
        undefined,          // bridgeId
        target_program,     // bridgeProgram
        undefined,          // workerName
        target_worker,      // targetWorkerName
        undefined,          // submittedBy
        deps.callerJobId,   // parentJobId
      );

      if (depends_on_job_ids?.length) {
        for (const depId of depends_on_job_ids) {
          try { deps.depsRepo.add(job.id, depId); } catch { /* skip invalid */ }
        }
      }

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
            task_ref: freshJob?.taskRef ? `#${freshJob.taskRef}` : null,
            status: job.status,
            execution_type,
            target_program: target_program ?? null,
            target_worker: target_worker ?? null,
            depends_on: depends_on_job_ids ?? [],
            message: freshJob?.taskRef
              ? `Task ${freshJob.taskRef} queued. Monitor with get_job_status or reference as #${freshJob.taskRef}.`
              : "Task queued. Monitor with get_job_status.",
          }, null, 2),
        }],
      };
    },
  );

  // Tool: create_tasks — batch non-agentic task creation for distributed execution
  server.tool(
    "create_tasks",
    "Create multiple non-agentic task jobs for parallel distributed execution (render farm pattern). " +
      "Splits work across available machines. Each task runs independently. " +
      "Returns all job IDs and #T refs. Poll with poll_jobs to monitor completion.",
    {
      tasks: z.array(z.object({
        name: z.string().describe("Short display name"),
        execution_type: z.enum(["bridge_command", "worker_local", "worker_headless"]),
        target_program: z.string().optional(),
        commands: z.array(z.object({
          language: z.string(),
          script: z.string(),
          description: z.string().optional(),
        })).optional(),
        command: z.string().optional(),
        local_mode: z.enum(["shell", "python"]).optional(),
        cwd: z.string().optional(),
        target_worker: z.string().optional(),
        timeout_ms: z.number().optional(),
      })).min(1).max(50).describe("Array of task specifications"),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      track: z.boolean().optional().default(true),
    },
    async ({ tasks, priority, track }) => {
      const denied = checkPermission("submitJobs");
      if (denied) return denied;

      const configs = deps.agentsRepo.list();
      const fallbackConfigId = configs[0]?.id;
      if (!fallbackConfigId) {
        return {
          content: [{ type: "text" as const, text: "No agent configs available." }],
          isError: true,
        };
      }

      const results: Array<{ job_id: string; task_ref: string | null; name: string; status: string }> = [];

      for (const task of tasks) {
        const job = deps.jobsRepo.create(
          {
            mode: "task",
            name: task.name,
            prompt: `[Task] ${task.name}`,
            agentConfigId: fallbackConfigId,
            priority: priority ?? "normal",
            coordinationMode: "server",
            files: [],
            contextItems: [],
            startPaused: false,
            targetWorkerName: task.target_worker,
            taskSpec: {
              executionType: task.execution_type,
              targetProgram: task.target_program,
              commands: task.commands,
              command: task.command,
              localMode: task.local_mode,
              cwd: task.cwd,
              timeoutMs: task.timeout_ms ?? 600_000,
              label: task.name,
            },
            track: track !== false,
          },
          undefined,
          task.target_program,
          undefined,
          task.target_worker,
          undefined,
          deps.callerJobId,
        );

        const freshJob = deps.jobsRepo.getById(job.id);
        if (freshJob) {
          deps.hub.broadcastToType("client", {
            type: "job_updated",
            id: newId(),
            payload: { job: freshJob },
          });
        }

        results.push({
          job_id: job.id,
          task_ref: freshJob?.taskRef ? `#${freshJob.taskRef}` : null,
          name: task.name,
          status: job.status,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            created: results.length,
            tasks: results,
            message: `${results.length} task(s) queued for distributed execution.`,
          }, null, 2),
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
      // Record usage for effectiveness tracking — skip for system jobs
      // (housekeeping/training review all skills as part of their job)
      if (deps.skillEffectivenessRepo && deps.callerJobId && deps.jobsRepo) {
        const callerJob = deps.jobsRepo.getById(deps.callerJobId);
        const meta = (() => { try { const ctx = callerJob?.editorContext; return (typeof ctx === "object" && ctx !== null ? (ctx as any).metadata : null) || {}; } catch { return {}; } })();
        const isSystem = meta.housekeeping || meta.coordinator_training_job || meta.coordinator_training_orchestrator || meta.coordinator_training_analysis_job;
        if (!isSystem) {
          deps.skillEffectivenessRepo.recordUsage(skill.id, deps.callerJobId);
        }
      }
      // Resolve template variables using live bridge state
      let content = skill.content;
      try {
        const { resolveSkillTemplateVars } = await import("../skills/skill-templates.js");
        const bridges = deps.hub.getBridges();
        const bridgeList = bridges.length > 0
          ? bridges.map((b: { program?: string; workerName?: string }) => `${b.program ?? "unknown"} (${b.workerName ?? "?"})`).join(", ")
          : "No bridges connected";
        content = resolveSkillTemplateVars(content, bridgeList, "", "");
      } catch {}
      // Load playbook content on-demand for skills with artifact references
      if (skill.playbooks?.length > 0 && deps.config?.coordinatorPlaybooksDir) {
        for (const pbPath of skill.playbooks.slice(0, 2)) {
          if (!pbPath.endsWith(".md")) continue;
          try {
            const fullPath = join(deps.config.coordinatorPlaybooksDir, pbPath);
            if (existsSync(fullPath)) {
              const pbContent = readFileSync(fullPath, "utf-8").slice(0, 3000);
              content += `\n\n---\n## Training Analysis\n${pbContent}`;
            }
          } catch {
            // Best-effort — don't fail the skill fetch for playbook loading
          }
        }
      }
      const rateReminder = `\n\n---\n_After using this skill, call \`rate_skill("${slug}", "useful"|"not_useful"|"partial")\` to help improve future recommendations._`;
      return { content: [{ type: "text" as const, text: `# ${skill.title}\n\n${content}${rateReminder}` }] };
    },
  );

  server.tool(
    "rate_skill",
    "Rate how useful a skill was for your current task. Call this after completing work to improve skill effectiveness tracking. " +
      "Rate each auto-fetched skill that was injected into your prompt.",
    {
      slug: z.string().describe("The skill slug"),
      rating: z.enum(["useful", "not_useful", "partial"]).describe("How useful was this skill for the current task"),
      notes: z.string().optional().describe("Brief reason (e.g. 'naming conventions matched perfectly' or 'not relevant to this task')"),
    },
    async ({ slug, rating, notes }) => {
      if (!deps.skillEffectivenessRepo || !deps.callerJobId) {
        return { content: [{ type: "text" as const, text: "Skill effectiveness tracking not available" }], isError: true };
      }
      if (!deps.skillIndex) {
        return { content: [{ type: "text" as const, text: "Skills system not initialized" }], isError: true };
      }
      const skill = deps.skillIndex.get(slug);
      if (!skill) {
        return { content: [{ type: "text" as const, text: `Skill not found: ${slug}` }], isError: true };
      }
      const outcomeMap: Record<string, string> = { useful: "positive", not_useful: "negative", partial: "average" };
      const outcome = outcomeMap[rating] || "average";
      deps.skillEffectivenessRepo.recordSkillOutcome(skill.id, deps.callerJobId, outcome);
      const notesSuffix = notes ? ` — ${notes}` : "";
      return { content: [{ type: "text" as const, text: `Recorded: ${slug} → ${rating}${notesSuffix}` }] };
    },
  );

  server.tool(
    "rate_job",
    "Rate the overall quality of your own job before finishing. " +
      "Call this once near the end of your work to self-assess how well the task went. " +
      "This helps the system learn from successes and failures.",
    {
      rating: z.enum(["good", "average", "poor"]).describe(
        "good = task completed successfully as requested; average = partially completed or with caveats; poor = failed or produced incorrect results",
      ),
      notes: z.string().max(4000).optional().describe(
        "Brief explanation of what went well or what went wrong (e.g. 'completed all requested changes' or 'bridge disconnected mid-task')",
      ),
    },
    async ({ rating, notes }) => {
      if (!deps.callerJobId) {
        return { content: [{ type: "text" as const, text: "No job context — rate_job can only be called by an agent running a job" }], isError: true };
      }
      const job = deps.jobsRepo.getById(deps.callerJobId);
      if (!job) {
        return { content: [{ type: "text" as const, text: `Job not found: ${deps.callerJobId}` }], isError: true };
      }
      // Map input rating to stored outcome
      const storedRating = rating === "good" ? "positive" as const
        : rating === "average" ? "average" as const
        : "negative" as const;
      const notesTrimmed = (notes ?? "").trim();
      deps.jobsRepo.markOutcome(deps.callerJobId, storedRating, notesTrimmed, null);
      // Update skill effectiveness for unrated skills
      if (deps.skillEffectivenessRepo) {
        const skillOutcome = rating === "good" ? "positive" : rating === "poor" ? "negative" : "average";
        deps.skillEffectivenessRepo.recordOutcome(deps.callerJobId, skillOutcome);
      }
      // Broadcast the updated job to clients
      const updated = deps.jobsRepo.getById(deps.callerJobId);
      if (updated) {
        deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: updated } });
      }
      return { content: [{ type: "text" as const, text: `Job rated: ${rating}${notesTrimmed ? ` — ${notesTrimmed}` : ""}` }] };
    },
  );

  server.tool(
    "create_skill",
    "Create a new skill from something you learned during this task. " +
      "Use this whenever you discover a non-trivial technique, workaround, or pattern that would save time on future similar tasks. " +
      "Examples: a tricky API usage pattern, a multi-step workflow, a version-specific workaround, a naming convention.",
    {
      slug: z.string().describe("URL-friendly identifier (e.g. 'blender-procedural-rock', 'houdini-vdb-from-particles')"),
      title: z.string().describe("Human-readable title (e.g. 'Procedural Rock Material in Blender')"),
      program: z.string().describe("Target program (e.g. 'blender', 'houdini', 'comfyui', 'global')"),
      content: z.string().describe("The skill content — step-by-step instructions, code snippets, key parameters, gotchas"),
      keywords: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("Search tags (e.g. ['procedural', 'material', 'shader-nodes', 'rock'])"),
      category: z.string().optional().default("custom").describe("Skill category"),
      relatedSkills: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("Slugs of related skills to link together"),
      playbooks: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("Paths to playbook/training artifact files"),
    },
    async ({ slug, title, program, content, keywords, category, relatedSkills, playbooks }) => {
      if (!deps.skillsRepo && !deps.skillStore) {
        return { content: [{ type: "text" as const, text: "Skills system not available" }], isError: true };
      }
      try {
        // Validate and strip invalid relatedSkills references
        let validatedRelated = relatedSkills || [];
        const warnings: string[] = [];
        if (validatedRelated.length > 0 && deps.skillIndex) {
          const validation = validateSkill(
            { relatedSkills: validatedRelated } as any,
            (s) => deps.skillIndex!.get(s) !== null,
          );
          if (validation.strippedRelatedSkills?.length) {
            validatedRelated = validatedRelated.filter((s) => !validation.strippedRelatedSkills!.includes(s));
            warnings.push(`Stripped non-existent related skills: ${validation.strippedRelatedSkills.join(", ")}`);
          }
        }

        const input = {
          name: slug,
          slug,
          program,
          category: category || "custom",
          title,
          description: title,
          keywords: keywords || [program, slug],
          content,
          relatedSkills: validatedRelated,
          playbooks: playbooks || [],
          source: "agent",
          priority: 50,
          autoFetch: false,
          enabled: true,
        };
        if (deps.skillStore) {
          await deps.skillStore.upsertBySlugAndProgram(input);
        } else {
          deps.skillsRepo!.upsertBySlugAndProgram(input);
          deps.skillIndex?.refresh();
        }
        const msg = `Skill created: ${slug} [${program}] — "${title}"`;
        return { content: [{ type: "text" as const, text: warnings.length > 0 ? `${msg}\nWarnings: ${warnings.join("; ")}` : msg }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed to create skill: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "update_skill",
    "Update an existing skill's content, keywords, or title. " +
      "Use this to improve a skill based on new learnings, fix outdated info, or add better tags.",
    {
      slug: z.string().describe("The skill slug to update"),
      program: z.string().optional().describe("Program filter if slug exists for multiple programs"),
      content: z.string().optional().describe("New content (replaces existing)"),
      title: z.string().optional().describe("New title"),
      keywords: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("New keywords/tags (replaces existing)"),
      relatedSkills: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("Slugs of related skills (replaces existing)"),
      playbooks: z.preprocess(
        (v) => (typeof v === "string" ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string()).optional(),
      ).describe("Paths to playbook/training artifact files (replaces existing)"),
    },
    async ({ slug, program, content, title, keywords, relatedSkills, playbooks }) => {
      if ((!deps.skillsRepo && !deps.skillStore) || !deps.skillIndex) {
        return { content: [{ type: "text" as const, text: "Skills system not available" }], isError: true };
      }
      const skill = deps.skillIndex.get(slug, program || undefined);
      if (!skill) {
        return { content: [{ type: "text" as const, text: `Skill not found: ${slug}` }], isError: true };
      }
      if (skill.locked) {
        return { content: [{ type: "text" as const, text: `Skill "${slug}" is locked and cannot be edited by agents. Only humans can unlock it via the UI.` }], isError: true };
      }
      const updates: Record<string, any> = {};
      const warnings: string[] = [];
      if (content !== undefined) updates.content = content;
      if (title !== undefined) updates.title = title;
      if (keywords !== undefined) updates.keywords = keywords;
      if (relatedSkills !== undefined) {
        // Validate and strip invalid relatedSkills references
        const validation = validateSkill(
          { relatedSkills } as any,
          (s) => deps.skillIndex!.get(s) !== null,
        );
        if (validation.strippedRelatedSkills?.length) {
          updates.relatedSkills = relatedSkills.filter((s: string) => !validation.strippedRelatedSkills!.includes(s));
          warnings.push(`Stripped non-existent related skills: ${validation.strippedRelatedSkills.join(", ")}`);
        } else {
          updates.relatedSkills = relatedSkills;
        }
      }
      if (playbooks !== undefined) updates.playbooks = playbooks;
      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text" as const, text: "No updates provided" }], isError: true };
      }
      try {
        if (deps.skillStore) {
          await deps.skillStore.update(skill.id, updates);
        } else {
          deps.skillsRepo!.update(skill.id, updates);
          deps.skillIndex.refresh();
        }
        const msg = `Updated skill: ${slug} — fields: ${Object.keys(updates).join(", ")}`;
        return { content: [{ type: "text" as const, text: warnings.length > 0 ? `${msg}\nWarnings: ${warnings.join("; ")}` : msg }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed to update skill: ${err.message}` }], isError: true };
      }
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

  // ── Handoff tools ──────────────────────────────────────────────────────────

  server.tool(
    "post_handoff",
    "Leave a handoff note for other agents working on the same project. " +
      "Call this after completing a significant step, hitting a blocker, or when files change. " +
      "Other agents (including future runs on this project) will see your notes via get_handoff.",
    {
      content: z.string().describe("What you did, what changed, what to watch out for"),
      category: z.enum(["progress", "blocker", "done", "warning"]).default("progress")
        .describe("Note type: progress (default), blocker, done, warning"),
      program: z.string().optional().describe("DCC program context (e.g. 'blender', 'godot')"),
      project_path: z.string().optional().describe("Project directory path"),
      file_hashes: z.record(z.string(), z.string()).optional()
        .describe("Map of file path → sha256 hash for files you touched/care about"),
    },
    async ({ content, category, program, project_path, file_hashes }) => {
      if (!deps.handoffRepo) {
        return { content: [{ type: "text" as const, text: "Handoff system not available" }], isError: true };
      }
      const callerJob = deps.callerJobId ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const parentJobId = callerJob?.parentJobId ?? undefined;
      const note = deps.handoffRepo.post(
        deps.callerJobId ?? "unknown",
        program ?? "",
        project_path ?? null,
        category,
        content,
        file_hashes,
        parentJobId,
      );
      return { content: [{ type: "text" as const, text: `Handoff note posted: ${note.id} [${category}]` }] };
    },
  );

  server.tool(
    "get_handoff",
    "Check handoff notes from other agents. Call at the START of your task to see " +
      "what work was done before you, what changed, and what to watch out for.",
    {
      project_path: z.string().optional().describe("Filter by project directory"),
      program: z.string().optional().describe("Filter by DCC program"),
      parent_job_id: z.string().optional().describe("Get notes from sibling sub-jobs (same parent)"),
      limit: z.number().optional().default(10).describe("Max notes to return (default 10)"),
    },
    async ({ project_path, program, parent_job_id, limit }) => {
      if (!deps.handoffRepo) {
        return { content: [{ type: "text" as const, text: "Handoff system not available" }], isError: true };
      }
      let notes;
      if (parent_job_id) {
        notes = deps.handoffRepo.getForParentJob(parent_job_id, limit);
      } else if (project_path) {
        notes = deps.handoffRepo.getForProject(project_path, program, limit);
      } else {
        notes = deps.handoffRepo.getRecent(program, limit);
      }
      if (notes.length === 0) {
        return { content: [{ type: "text" as const, text: "No handoff notes found." }] };
      }
      const formatted = notes.map((n) =>
        `[${n.category}] ${n.createdAt} (job: ${n.jobId.slice(0, 8)})\n${n.content}` +
        (n.fileHashes ? `\nFiles tracked: ${Object.keys(n.fileHashes).join(", ")}` : ""),
      ).join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  server.tool(
    "check_project_changes",
    "Check which project files changed since the last handoff note with file hashes. " +
      "Returns list of added/modified/deleted files. Call this to know if another agent " +
      "or user modified files you care about.",
    {
      project_path: z.string().describe("Project directory to check"),
      program: z.string().optional().describe("Filter by DCC program"),
    },
    async ({ project_path, program }) => {
      if (!deps.handoffRepo) {
        return { content: [{ type: "text" as const, text: "Handoff system not available" }], isError: true };
      }
      const latest = deps.handoffRepo.getLatestHashes(project_path, program);
      if (!latest?.fileHashes) {
        return { content: [{ type: "text" as const, text: "No previous file hashes found for this project. Call post_handoff with file_hashes first." }] };
      }
      const changes: Array<{ path: string; status: "modified" | "deleted" | "unchanged" }> = [];
      for (const [filePath, oldHash] of Object.entries(latest.fileHashes)) {
        const fullPath = join(project_path, filePath);
        try {
          if (!existsSync(fullPath)) {
            changes.push({ path: filePath, status: "deleted" });
          } else {
            const content = readFileSync(fullPath);
            const currentHash = createHash("sha256").update(content).digest("hex");
            if (currentHash !== oldHash) {
              changes.push({ path: filePath, status: "modified" });
            } else {
              changes.push({ path: filePath, status: "unchanged" });
            }
          }
        } catch {
          changes.push({ path: filePath, status: "deleted" });
        }
      }
      const modified = changes.filter((c) => c.status !== "unchanged");
      const text = modified.length === 0
        ? `No changes detected across ${changes.length} tracked file(s) since ${latest.createdAt}.`
        : `${modified.length} change(s) detected since ${latest.createdAt}:\n` +
          modified.map((c) => `  ${c.status}: ${c.path}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ─── API Bridge tools ────────────────────────────────────────────────────

  // Tool: list_api_bridges
  server.tool(
    "list_api_bridges",
    "List all configured API bridges (external REST APIs like Meshy for 3D generation, Stability for images, etc.) with their available actions and parameter schemas.",
    {},
    async () => {
      if (!deps.apiBridgesRepo) {
        return { content: [{ type: "text" as const, text: "API bridges not available." }] };
      }
      const bridges = deps.apiBridgesRepo.listEnabled();
      if (bridges.length === 0) {
        return { content: [{ type: "text" as const, text: "No API bridges configured. Ask the user to set up API bridges in Settings." }] };
      }

      // Dynamically import to avoid circular deps and keep the import lazy
      const { getPresetHandler, listPresets } = await import("../api-bridges/index.js");

      const result = bridges.map((b) => {
        const handler = b.type === "preset" && b.presetId ? getPresetHandler(b.presetId) : undefined;
        return {
          name: b.name,
          display_name: b.displayName,
          type: b.type,
          preset_id: b.presetId,
          base_url: b.baseUrl,
          actions: handler ? handler.getActions() : Object.keys(b.endpoints).map((name) => ({ name, description: `Custom endpoint: ${name}` })),
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // Tool: execute_api_bridge
  server.tool(
    "execute_api_bridge",
    "Execute an action on an API bridge (external REST API). This is synchronous — blocks until the API call completes (including polling for async APIs). " +
    "Use list_api_bridges to discover available bridges and their actions with parameter schemas.",
    {
      bridge: z.string().describe('API bridge name (e.g. "meshy")'),
      action: z.string().describe('Action to execute (e.g. "text_to_3d_preview", "image_to_3d")'),
      params: z.record(z.string(), z.unknown()).default({}).describe("Action parameters (see list_api_bridges for schemas)"),
    },
    async ({ bridge, action, params }) => {
      if (!deps.apiBridgesRepo) {
        return { content: [{ type: "text" as const, text: "API bridges not available." }], isError: true };
      }

      const bridgeConfig = deps.apiBridgesRepo.getByName(bridge);
      if (!bridgeConfig) {
        return { content: [{ type: "text" as const, text: `API bridge "${bridge}" not found. Use list_api_bridges to see available bridges.` }], isError: true };
      }
      if (!bridgeConfig.enabled) {
        return { content: [{ type: "text" as const, text: `API bridge "${bridge}" is disabled.` }], isError: true };
      }

      const apiKey = deps.apiBridgesRepo.getApiKey(bridgeConfig.id);
      if (!apiKey && bridgeConfig.authType !== "none") {
        return { content: [{ type: "text" as const, text: `API bridge "${bridge}" has no API key configured. Ask the user to add one in Settings.` }], isError: true };
      }

      // Resolve handler
      const { getPresetHandler } = await import("../api-bridges/index.js");
      const { CustomApiBridgeHandler } = await import("../api-bridges/custom-handler.js");

      const handler = bridgeConfig.type === "preset" && bridgeConfig.presetId
        ? getPresetHandler(bridgeConfig.presetId)
        : new CustomApiBridgeHandler();

      if (!handler) {
        return { content: [{ type: "text" as const, text: `No handler found for preset "${bridgeConfig.presetId}"` }], isError: true };
      }

      // Execute synchronously (may block for minutes while polling async APIs)
      const logParts: string[] = [];
      try {
        const result = await handler.execute(bridgeConfig, apiKey ?? "", action, params, {
          onLog: (text) => logParts.push(text),
          onProgress: (percent, statusText) => logParts.push(`[${percent ?? "?"}%] ${statusText}`),
        });

        // Build a compact response — full signed URLs can be 10KB+ and may exceed
        // MCP response size limits in some clients, causing "no output" errors.
        const compact: Record<string, unknown> = {
          success: result.success,
          bridgeName: result.bridgeName,
          action: result.action,
        };
        if (result.error) compact.error = result.error;
        if (result.externalTaskId) compact.externalTaskId = result.externalTaskId;
        if (result.externalStatus) compact.externalStatus = result.externalStatus;
        if (result.outputFiles && result.outputFiles.length > 0) {
          compact.outputFiles = result.outputFiles.map((f) => ({
            url: f.url,
            filename: f.filename,
            mimeType: f.mimeType,
            ...(f.sizeBytes != null ? { sizeBytes: f.sizeBytes } : {}),
          }));
          compact.downloadHint = "Use curl or wget to download these files to the desired directory.";
        }
        // Include a summary of the raw API data (omit large nested objects)
        if (result.data && typeof result.data === "object") {
          const d = result.data as Record<string, unknown>;
          if (d.status) compact.apiStatus = d.status;
          if (d.progress != null) compact.apiProgress = d.progress;
          if (d.thumbnail_url) compact.thumbnailUrl = d.thumbnail_url;
        }

        const text = JSON.stringify(compact, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          isError: !result.success,
        };
      } catch (err: any) {
        const logs = logParts.length > 0 ? `\nLogs:\n${logParts.join("\n")}` : "";
        return {
          content: [{ type: "text" as const, text: `API bridge execution failed: ${err.message ?? String(err)}${logs}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
