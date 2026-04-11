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
import { logger } from "../utils/logger.js";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { tmpdir, homedir } from "os";
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
  /** Users repo — needed to look up per-user community session tokens for MCP tools that call arkestrator.com. */
  usersRepo?: import("../db/users.repo.js").UsersRepo;
}

const CLIENT_API_ALLOW_PREFIXES = [
  "/api/jobs",
  "/api/chat",
  "/api/agent-configs",
  "/api/headless-programs",
  "/api/skills",
  "/api/bridge-command",
  "/api/transfers",
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
    "List ALL currently available bridges visible to the agent, including: " +
      "real DCC bridges (Godot, Blender, Houdini, Fusion, Fusion360), virtual HTTP bridges " +
      "(ComfyUI), and enabled API bridges (Meshy, etc.). Each entry has a `kind` field " +
      "('ws' | 'virtual' | 'api') and `canExecuteBridgeCommands` to tell you if it accepts " +
      "execute_command or needs dedicated tools (comfyui_*, invoke_api_bridge). Virtual/API " +
      "bridges have no editor context.",
    {},
    async () => {
      const bridges = deps.hub.findAgentBridges();
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
    "Get the current editor context (active file, project root, open files, context items) " +
      "from a bridge. Works for real DCC bridges (Godot/Blender/Houdini/Fusion) AND for virtual " +
      "HTTP bridges like ComfyUI (returns identity + url, no editor context) AND for API bridges " +
      "like Meshy (returns identity + available actions). If nothing matches the program, reports " +
      "not connected.",
    {
      target: z.string().describe('Target bridge program name, e.g. "godot", "blender", "comfyui", "meshy"'),
    },
    async ({ target }) => {
      const views = deps.hub.findAgentBridges(target);
      if (views.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No bridge connected for: ${target}` }],
          isError: true,
        };
      }

      const results: any[] = [];
      for (const view of views) {
        if (view.kind === "ws") {
          const ctx = deps.hub.getBridgeContext(view.id);
          results.push({
            bridgeId: view.id,
            kind: "ws",
            program: view.program,
            workerName: view.workerName,
            projectPath: view.projectPath,
            editorContext: ctx?.editorContext ?? null,
            files: ctx?.files ?? [],
            contextItems: ctx?.items ?? [],
          });
        } else {
          // Virtual + API bridges: no editor context. Return identity + hint so
          // agents know the bridge IS available and how to invoke it.
          results.push({
            bridgeId: view.id,
            kind: view.kind,
            program: view.program,
            programVersion: view.programVersion,
            workerName: view.workerName,
            url: view.url,
            apiActions: view.apiActions,
            editorContext: null,
            files: [],
            contextItems: [],
            note: view.usageHint,
          });
        }
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
        } else if (!deps.hub.hasAnyBridgeForProgram(target_program)) {
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
            } else if (!deps.hub.hasAnyBridgeForProgram(spec.target_program)) {
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
      // Cap caller-supplied limit so agents can't request huge result sets.
      const safeLimit = Math.min(Math.max(1, limit ?? 10), 25);
      let results = deps.skillIndex.search(query, { program: program || undefined, category: category || undefined, limit: safeLimit });
      // Hide verification helper skills entirely when the caller's job has
      // verification disabled — otherwise agents see them, try to rate them,
      // and pollute the stats for a skill that couldn't possibly have helped.
      const callerJobForFilter = deps.callerJobId && deps.jobsRepo ? deps.jobsRepo.getById(deps.callerJobId) : null;
      const verificationDisabled = callerJobForFilter?.runtimeOptions?.verificationMode === "disabled";
      if (verificationDisabled) {
        results = results.filter((r) => r.slug !== "verification" && r.category !== "verification");
      }
      // Deliberately do NOT record usage rows here. Previously every returned
      // result was counted as "used" on the assumption that agents might act
      // on title+description alone, but that inflated totalUsed on skills the
      // agent never opened AND — worse — let the rate_job fallback stamp an
      // outcome onto skills that were never actually consulted. Usage is only
      // recorded when the agent calls `get_skill` (below), which is the
      // point at which the content is actually inspected.
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
        // Don't track verification helper skills on verification-disabled jobs
        // — the skill had no chance to help, so any usage row would be used
        // by rate_job fallback to stamp an undeserved outcome.
        const verificationDisabled = callerJob?.runtimeOptions?.verificationMode === "disabled";
        const isVerificationSkill = skill.slug === "verification" || skill.category === "verification";
        if (!isSystem && !(verificationDisabled && isVerificationSkill)) {
          deps.skillEffectivenessRepo.recordUsageOnce(skill.id, deps.callerJobId);
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
      const rateReminder = `\n\n---\n_After using this skill, call \`rate_skill("${slug}", "useful"|"not_useful"|"partial", notes: "<short reason>")\` — always include a one-sentence \`notes\` reason so humans can see why you rated it that way._`;

      // Layer 2: untrusted-content framing for community-sourced skills.
      // The skill body is concatenated directly into the agent's tool result
      // and effectively becomes part of its context. Without framing, a
      // malicious community submitter could embed prompt-injection payloads
      // (jailbreaks, "ignore previous instructions", calls to destructive
      // tools) and have them executed as if they came from the user. The
      // framing tells the model the content is third-party advisory and
      // surfaces the trust tier, flagged status, and author so it can weigh
      // credibility.
      let renderedBody = content;
      if (skill.source === "community") {
        const { frameUntrustedSkillContent } = await import("../skills/skill-validator.js");
        const { resolveCommunityPolicy } = await import("../skills/community-install.js");
        const extraCaution = resolveCommunityPolicy(deps.settingsRepo).extraCaution;
        renderedBody = frameUntrustedSkillContent(
          {
            slug: skill.slug,
            title: skill.title,
            source: skill.source,
            trustTier: skill.trustTier,
            flagged: skill.flagged,
            flaggedReasons: skill.flaggedReasons,
            authorLogin: skill.authorLogin,
            authorVerified: skill.authorVerified,
          },
          content,
          extraCaution,
        );
      }

      return { content: [{ type: "text" as const, text: `# ${skill.title}\n\n${renderedBody}${rateReminder}` }] };
    },
  );

  // ── Community skill tools (arkestrator.com registry) ────────────────
  // These let agents search and install skills from the public community
  // registry during a job, as a fallback when local search_skills returns
  // nothing relevant. During the free beta phase, any GH-authenticated user
  // can install. Post-beta, the server-side endpoint enforces subscription
  // tier checks and returns 402 for non-subscribers.

  server.tool(
    "search_community_skills",
    "Search the Arkestrator community skill registry at arkestrator.com. " +
      "Use this as a FALLBACK only when search_skills returns no relevant local skills for your task. " +
      "Results include an 'alreadyInstalledLocally' flag — if true, the skill is already available via get_skill with the local slug, so DO NOT call install_community_skill for it. " +
      "Free for all users. Returns { skills: [{ id, slug, title, description, program, category, alreadyInstalledLocally }], unreachable?: true }. " +
      "If unreachable is true, the community registry is temporarily offline — proceed with whatever local skills you have.",
    {
      query: z.string().describe("Natural language description of the skill or guidance you need"),
      program: z.string().optional().describe("Filter by bridge program (e.g. 'blender', 'godot', 'houdini')"),
      limit: z.number().optional().default(10).describe("Max results to return (default 10, max 25)"),
    },
    async ({ query, program, limit }) => {
      const { searchCommunitySkills, resolveCommunityBaseUrl, isAgentCommunityEnabled } = await import("../skills/community-install.js");

      if (!isAgentCommunityEnabled(deps.settingsRepo)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              skills: [],
              error: "community_disabled",
              message: "Agent community skill search is disabled on this server. Ask your admin to enable it in the admin panel.",
            }),
          }],
        };
      }

      const baseUrl = resolveCommunityBaseUrl(deps.settingsRepo);
      const result = await searchCommunitySkills({
        baseUrl,
        query,
        program,
        limit: Math.min(Math.max(1, limit ?? 10), 25),
      });

      // Enrich with alreadyInstalledLocally flag — saves the agent from reinstalling
      // skills that are already in the local index under source='community'.
      let enriched = result.skills.map((s) => ({ ...s, alreadyInstalledLocally: false }));
      if (deps.skillsRepo && result.skills.length > 0) {
        try {
          const localCommunity = deps.skillsRepo.listBySource("community");
          const localSlugs = new Set(localCommunity.map((sk: any) => sk.slug));
          enriched = result.skills.map((s) => ({
            ...s,
            alreadyInstalledLocally: localSlugs.has(s.slug),
          }));
        } catch {
          // Non-fatal — flag is optional
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            skills: enriched,
            ...(result.unreachable ? { unreachable: true } : {}),
          }),
        }],
      };
    },
  );

  server.tool(
    "install_community_skill",
    "Install a skill from the Arkestrator community registry into the local skill store. " +
      "Call search_community_skills first to find a candidate id. After install, the skill is immediately available via search_skills and get_skill using the returned local slug. " +
      "REQUIRES the user to be logged into arkestrator.com via the client Community tab (for usage attribution during the free beta). " +
      "If installation fails, the response includes a structured error with an 'error' code and 'message' field — relay the message field to the user verbatim. " +
      "Possible error codes: 'community_disabled' (admin killswitch), 'not_logged_in' (user needs to connect in Community tab), 'sponsorship_required' (post-beta paywall), 'slots_exhausted' (post-beta seat cap), 'not_found', 'unreachable', 'rate_limited'.",
    {
      communityId: z.string().describe("The id from search_community_skills results"),
    },
    async ({ communityId }) => {
      const { installCommunitySkill, resolveCommunityBaseUrl, isAgentCommunityEnabled } = await import("../skills/community-install.js");

      if (!isAgentCommunityEnabled(deps.settingsRepo)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "community_disabled",
              message: "Agent community skill install is disabled on this server. Ask your admin to enable it in the admin panel.",
            }),
          }],
          isError: true,
        };
      }

      if (!deps.skillsRepo) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "internal",
              message: "Skills system not initialized",
            }),
          }],
          isError: true,
        };
      }

      // Resolve the acting user from the current job
      let sessionToken: string | null = null;
      let actingUserId: string | null = null;
      if (deps.callerJobId && deps.jobsRepo) {
        const job = deps.jobsRepo.getById(deps.callerJobId);
        const submittedBy = (job as any)?.submittedBy ?? null;
        if (submittedBy && deps.usersRepo) {
          actingUserId = submittedBy;
          sessionToken = deps.usersRepo.getCommunitySessionToken(submittedBy);
        }
      }

      if (!sessionToken) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "not_logged_in",
              message: "You are not logged in to arkestrator.com. Open the Community tab in the Arkestrator client settings and sign in with GitHub to enable agent community skill install.",
            }),
          }],
          isError: true,
        };
      }

      const baseUrl = resolveCommunityBaseUrl(deps.settingsRepo);
      const result = await installCommunitySkill({
        communityId,
        baseUrl,
        sessionToken,
        agentDriven: true,
        skillsRepo: deps.skillsRepo,
        skillIndex: deps.skillIndex,
        skillStore: deps.skillStore,
      });

      if (!result.ok) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result),
          }],
          isError: true,
        };
      }

      // DO NOT record usage on install — the agent hasn't actually used
      // the content yet, and stamping it here would let the rate_job
      // fallback mark the new skill with an outcome it never earned.
      // Usage is recorded only when the agent calls get_skill.

      // Audit trail so operators can trace where installed community skills came from.
      logger.info(
        "mcp",
        `Community skill installed by agent (job=${deps.callerJobId ?? "?"}, actingUser=${actingUserId ?? "?"}): ${result.slug} [${result.program}] (communityId=${communityId})`,
      );

      const betaNote = result.beta ? " (free during beta — will become a paid feature later)" : "";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            slug: result.slug,
            program: result.program,
            title: result.skill.title,
            description: result.skill.description,
            message: `Installed community skill '${result.slug}' for program '${result.program}'${betaNote}. Call get_skill("${result.slug}") to read its content.`,
          }),
        }],
      };
    },
  );

  server.tool(
    "rate_skill",
    "Rate how useful a skill was for your current task. Call this after completing work to improve skill effectiveness tracking. " +
      "Rate each auto-fetched skill that was injected into your prompt. " +
      "Always include a short `notes` reason (one sentence is fine) — this is shown in the admin UI and is the primary way humans see *why* a skill was rated the way it was.",
    {
      slug: z.string().describe("The skill slug"),
      rating: z.enum(["useful", "not_useful", "partial"]).describe("How useful was this skill for the current task"),
      notes: z.string().max(500).optional().describe("Short reason for the rating (~1 sentence). Examples: 'naming conventions matched perfectly', 'wrong bridge — meant for Blender, I was in Godot', 'outdated API reference'. Keep it terse; this is persisted and surfaced to humans."),
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
      // Ignore ratings for verification helper skills when this job had
      // verification turned off — the skill never had a chance to be useful,
      // so any rating (usually "not_useful") would unfairly pollute its stats.
      // Also wipe any usage row that may have been recorded earlier in the job.
      const callerJob = deps.jobsRepo?.getById(deps.callerJobId);
      const verificationDisabled = callerJob?.runtimeOptions?.verificationMode === "disabled";
      const isVerificationSkill = skill.slug === "verification" || skill.category === "verification";
      if (verificationDisabled && isVerificationSkill) {
        // Remove any pending usage row so the rate_job fallback doesn't
        // later mark it with the job's outcome either.
        deps.skillEffectivenessRepo.deleteForSkillAndJob(skill.id, deps.callerJobId);
        return { content: [{ type: "text" as const, text: `Skipped: ${slug} — verification was disabled for this job, so this skill's effectiveness isn't tracked here.` }] };
      }
      const outcomeMap: Record<string, string> = { useful: "positive", not_useful: "negative", partial: "average" };
      // Strict mapping — Zod already enforced the enum at the tool boundary,
      // but fall through to an error rather than a silent `"average"` default
      // if an unknown value somehow slips past.
      const outcome = outcomeMap[rating];
      if (!outcome) {
        return { content: [{ type: "text" as const, text: `Invalid rating "${rating}" — expected useful | not_useful | partial` }], isError: true };
      }
      deps.skillEffectivenessRepo.recordSkillOutcome(skill.id, deps.callerJobId, outcome, notes ?? null);
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
      // Update skill effectiveness for unrated skills. On verification-disabled
      // jobs, exclude verification helper skills from the stamp — they had no
      // chance to help and their row should be dropped, not marked. We look
      // up verification skills via the index and pass their ids to
      // recordOutcomeExcluding (which also deletes pending rows for them).
      if (deps.skillEffectivenessRepo) {
        const skillOutcome = rating === "good" ? "positive" : rating === "poor" ? "negative" : "average";
        const verificationDisabled = job.runtimeOptions?.verificationMode === "disabled";
        if (verificationDisabled && deps.skillIndex) {
          const allSkills = deps.skillIndex.list({ includeDisabled: true });
          const verificationIds = allSkills
            .filter((s) => s.slug === "verification" || s.category === "verification")
            .map((s) => s.id);
          deps.skillEffectivenessRepo.recordOutcomeExcluding(deps.callerJobId, skillOutcome, verificationIds);
        } else {
          deps.skillEffectivenessRepo.recordOutcome(deps.callerJobId, skillOutcome);
        }
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
    "retarget_job",
    "Change this job's bridge_program tag and reload coordinator/bridge skills for the new program. " +
      "Call this when you discover the job was mis-tagged (e.g. tagged 'houdini' but the user actually wants Blender). " +
      "Returns the auto-fetch Coordinator Knowledge for the new program so you can use it inline without re-searching. " +
      "Effectiveness stats for skills used before the retarget are preserved; new skill usage will be attributed to the new program.",
    {
      program: z.string().describe("The correct bridge program for this job (e.g. 'blender', 'houdini', 'comfyui', 'godot')"),
      reason: z.string().describe("Short explanation of why the retarget is needed — helps review mis-tagged jobs"),
    },
    async ({ program, reason }) => {
      if (!deps.callerJobId) {
        return { content: [{ type: "text" as const, text: "No job context — retarget_job can only be called by an agent running a job" }], isError: true };
      }
      const job = deps.jobsRepo.getById(deps.callerJobId);
      if (!job) {
        return { content: [{ type: "text" as const, text: `Job not found: ${deps.callerJobId}` }], isError: true };
      }
      const normalized = (program || "").trim().toLowerCase();
      if (!normalized) {
        return { content: [{ type: "text" as const, text: "program is required" }], isError: true };
      }
      const previous = (job.bridgeProgram || "").trim().toLowerCase();
      if (previous === normalized) {
        return { content: [{ type: "text" as const, text: `Job is already tagged as ${normalized} — no change.` }] };
      }
      // Persist the new tag so downstream ranking, stats, and audits align.
      deps.jobsRepo.setBridgeProgram(deps.callerJobId, normalized);

      // Reload auto-fetch coordinator/bridge skills for the new program and
      // return their content inline so the agent can use them immediately
      // without a second round-trip. Record usage rows under the current job.
      const skillLines: string[] = [];
      let injectedSlugs: string[] = [];
      if (deps.skillsRepo && deps.skillIndex) {
        try {
          const { SkillIndex: SkillIndexCls } = await import("../skills/skill-index.js");
          const allEnabled = deps.skillsRepo.listAll({ enabled: true });
          const verificationDisabled = job.runtimeOptions?.verificationMode === "disabled";
          const matching = allEnabled
            .filter((s: any) => {
              if (!s.autoFetch) return false;
              if (verificationDisabled && (s.slug === "verification" || s.category === "verification")) return false;
              const sp = (s.program || "").trim().toLowerCase();
              return !sp || sp === "global" || sp === normalized;
            })
            // Priority DESC so coordinators (90) come before bridges (70).
            .sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0));
          // Dedupe by slug in case a global + program-specific skill collide.
          const seen = new Set<string>();
          const MAX_TOTAL = 15_000;
          let total = 0;
          skillLines.push(`## Coordinator Knowledge (retargeted → ${normalized})`);
          for (const s of matching) {
            if (seen.has(s.slug)) continue;
            seen.add(s.slug);
            if (total >= MAX_TOTAL) break;
            const header = s.title || (s as any).name || s.slug;
            const tag = s.program && s.program !== "global" ? ` [${s.program}]` : "";
            skillLines.push(`### ${header}${tag}`);
            if (s.description) skillLines.push(s.description);
            if (s.content) {
              const budget = Math.min(4000, MAX_TOTAL - total);
              const capped = SkillIndexCls.truncateMarkdown(s.content, budget);
              skillLines.push(capped);
              total += capped.length;
            }
            skillLines.push("");
            injectedSlugs.push(s.slug);
            if (deps.skillEffectivenessRepo) {
              deps.skillEffectivenessRepo.recordUsageOnce((s as any).id, deps.callerJobId);
            }
          }
        } catch {
          // Best-effort — retarget still succeeds even if skill reload fails
        }
      }

      // Broadcast the updated job so clients see the new program tag live.
      try {
        const updated = deps.jobsRepo.getById(deps.callerJobId);
        if (updated) {
          deps.hub.broadcastToType("client", { type: "job_updated", id: newId(), payload: { job: updated } });
        }
      } catch {}

      const header = `Job retargeted: ${previous || "(untagged)"} → ${normalized}\nReason: ${reason}\n`;
      const ratingReminder = injectedSlugs.length > 0
        ? `\n\n---\n**Remember:** rate these newly loaded skills via \`rate_skill\` before exiting: ${injectedSlugs.map((s) => `\`${s}\``).join(", ")}.`
        : "";
      const body = skillLines.length > 0 ? `\n\n${skillLines.join("\n").trim()}` : "\n\n(No auto-fetch skills found for this program.)";
      return { content: [{ type: "text" as const, text: `${header}${body}${ratingReminder}` }] };
    },
  );

  server.tool(
    "create_skill",
    "Create a new skill from something you learned during this task. " +
      "Use this whenever you discover a non-trivial technique, workaround, or pattern that would save time on future similar tasks. " +
      "Classification rule: if the knowledge is about how a DCC program works (Houdini, Blender, etc.) set `program` and leave `mcpPresetId` empty. " +
      "If the knowledge is about how to use a specific MCP server effectively (query syntax, rate limits, state quirks), set `mcpPresetId` and leave `program` empty (or set it to 'global'). " +
      "Never set both — a hybrid skill like 'how to use Context7 for Houdini docs' must be split into two skills or dropped.",
    {
      slug: z.string().describe("URL-friendly identifier (e.g. 'blender-procedural-rock', 'houdini-vdb-from-particles'). MCP-scoped skills should use a preset-prefixed slug like 'context7-query-tips'."),
      title: z.string().describe("Human-readable title (e.g. 'Procedural Rock Material in Blender')"),
      program: z.string().describe("Target program (e.g. 'blender', 'houdini', 'comfyui', 'global'). Use 'global' when the skill is MCP-scoped via mcpPresetId."),
      mcpPresetId: z.string().optional().describe("MCP preset ID for tool-usage skills (e.g. 'context7', 'filesystem'). When set, this skill teaches the agent how to use that specific MCP server. Program must be 'global' when mcpPresetId is set."),
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
    async ({ slug, title, program, mcpPresetId, content, keywords, category, relatedSkills, playbooks }) => {
      if (!deps.skillsRepo && !deps.skillStore) {
        return { content: [{ type: "text" as const, text: "Skills system not available" }], isError: true };
      }
      // Refuse to clobber a locked skill via the upsert path. update_skill
      // already guards this, but create_skill ends up at
      // upsertBySlugAndProgram which blindly overwrites — so agents can
      // silently stomp curated content by "creating" over an existing slug.
      // Checked via skillIndex (refreshed on every write) for the live state.
      if (deps.skillIndex) {
        const existing = deps.skillIndex.get(slug, program || undefined);
        if (existing?.locked) {
          return {
            content: [{
              type: "text" as const,
              text: `Skill "${slug}" is locked and cannot be edited by agents. Only humans can unlock it via the UI.`,
            }],
            isError: true,
          };
        }
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

        // Exactly-one rule: if mcpPresetId is set, coerce program to 'global'
        // so the validator's cross-check and the DB unique constraint both
        // agree. If program was something else, the validator below will
        // flag it, but we also normalize here for clarity.
        const normalizedProgram = mcpPresetId ? "global" : program;
        const input = {
          name: slug,
          slug,
          program: normalizedProgram,
          mcpPresetId: mcpPresetId ?? null,
          category: category || "custom",
          title,
          description: title,
          keywords: keywords || [mcpPresetId ?? normalizedProgram, slug],
          content,
          relatedSkills: validatedRelated,
          playbooks: playbooks || [],
          source: "agent",
          priority: 50,
          autoFetch: false,
          enabled: true,
        };
        // Final pre-write semantic validation. Rejects empty content, bad
        // regex keywords, missing title. Agents creating garbage skills used
        // to silently succeed and then pollute ranking — now they get a
        // clear error so they can retry with a real body.
        const validation = validateSkill(input as any, (s) => deps.skillIndex?.get(s) != null);
        const validationErrors = validation.issues.filter((i) => i.severity === "error");
        if (validationErrors.length > 0) {
          return { content: [{ type: "text" as const, text: `Skill rejected: ${validationErrors.map((i) => i.message).join("; ")}` }], isError: true };
        }
        if (deps.skillStore) {
          await deps.skillStore.upsertBySlugAndProgram(input);
        } else {
          deps.skillsRepo!.upsertBySlugAndProgram(input);
          deps.skillIndex?.refresh();
        }
        const scopeLabel = mcpPresetId ? `mcp:${mcpPresetId}` : normalizedProgram;
        const msg = `Skill created: ${slug} [${scopeLabel}] — "${title}"`;
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
        const isMcp = !!b.mcpConfig;
        const handler = b.type === "preset" && b.presetId ? getPresetHandler(b.presetId) : undefined;
        return {
          name: b.name,
          display_name: b.displayName,
          type: isMcp ? "mcp" : b.type,
          preset_id: b.presetId,
          base_url: b.baseUrl,
          mcp_transport: b.mcpConfig?.transport,
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
    "Execute an action on an API bridge (external REST API). Blocks until the API call completes (including polling for async APIs). " +
    "Output files are AUTOMATICALLY DOWNLOADED to disk — the response includes local file paths. " +
    "Pass download_dir to control where files are saved, otherwise they go to the default project directory.",
    {
      bridge: z.string().describe('API bridge name (e.g. "meshy")'),
      action: z.string().describe('Action to execute (e.g. "text_to_3d_preview", "image_to_3d")'),
      params: z.record(z.string(), z.unknown()).default({}).describe("Action parameters (see list_api_bridges for schemas)"),
      download_dir: z.string().optional().describe("Directory to save output files to. If omitted, uses default project directory."),
    },
    async ({ bridge, action, params, download_dir }) => {
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

        // Auto-download output files to disk (fire-and-forget to avoid HTTP timeout)
        if (result.outputFiles && result.outputFiles.length > 0) {
          const { getDefaultProjectDir } = await import("../agents/engines.js");
          const baseDir = download_dir
            || deps.settingsRepo?.get("default_project_dir")
            || getDefaultProjectDir()
            || join(homedir(), "Documents", "Arkestrator");
          const downloadDir = download_dir
            ? download_dir
            : join(baseDir, "downloads", bridge, action);

          mkdirSync(downloadDir, { recursive: true });

          // Return file info with expected local paths immediately
          compact.outputFiles = result.outputFiles.map((f) => ({
            filename: f.filename,
            localPath: join(downloadDir, f.filename),
            mimeType: f.mimeType,
          }));
          compact.downloadedTo = downloadDir;
          compact.downloadStatus = "downloading";

          // Fire-and-forget: download files in the background so the MCP
          // response returns fast and doesn't time out the HTTP transport.
          const filesToDownload = result.outputFiles.map((f) => ({
            url: f.url,
            localPath: join(downloadDir, f.filename),
          }));
          (async () => {
            for (const f of filesToDownload) {
              try {
                const resp = await fetch(f.url);
                if (resp.ok) {
                  const buffer = Buffer.from(await resp.arrayBuffer());
                  writeFileSync(f.localPath, buffer);
                }
              } catch {
                // Best-effort download — agent can verify with ls
              }
            }
          })();
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
