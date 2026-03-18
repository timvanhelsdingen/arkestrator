import { join } from "path";
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "fs";
import { tmpdir, platform } from "os";
import { logger } from "../utils/logger.js";

const isWindows = platform() === "win32";

/**
 * Generate the CLI wrapper script content.
 * This is a standalone Node.js script that wraps the bridge-command REST API.
 */
function generateScript(serverUrl: string, apiKey: string): string {
  return `#!/usr/bin/env node
// Arkestrator CLI — auto-generated, do not edit
const fs = require("fs");
const SERVER = ${JSON.stringify(serverUrl)};
const KEY = ${JSON.stringify(apiKey)};
const JOB_ID = process.env.ARKESTRATOR_JOB_ID || "";
const PROJECT_PATH = process.env.ARKESTRATOR_PROJECT_PATH || process.cwd();
const HEADERS = {
  "Content-Type": "application/json",
  "Authorization": "Bearer " + KEY,
  ...(JOB_ID ? { "X-Job-Id": JOB_ID } : {}),
};

function printUsage() {
  console.log("Usage:");
  console.log("  am bridges");
  console.log("  am context <target>");
  console.log("  am exec <target> [--lang <language>] [--project-path <path>] <script>");
  console.log("  am exec <target> [--lang <language>] [--project-path <path>] -f <file>");
  console.log("  am exec-multi <target> [--project-path <path>] -f <commands.json>");
  console.log("  am agent-configs");
  console.log("  am jobs list [status] [limit]");
  console.log("  am jobs status <jobId>");
  console.log("  am jobs interventions <jobId>");
  console.log("  am jobs create -f <job.json>");
  console.log("  am headless-check <program> --args '[\\"--headless\\",\\"--path\\",\\"/project\\"]'");
  console.log("  am headless-check <program> -f <headless-check.json>");
  console.log("  am help");
}

function takeOption(args, names) {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1) {
      const value = args[idx + 1];
      args.splice(idx, value !== undefined ? 2 : 1);
      return value;
    }
  }
  return undefined;
}

function inferLanguage(target, explicit) {
  if (explicit) return explicit;
  return { godot: "gdscript", blender: "python", houdini: "python", comfyui: "python", unreal: "python" }[target] || "python";
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

async function request(path, init = {}) {
  const res = await fetch(SERVER + path, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || res.statusText;
    const code = data && data.code ? " [" + data.code + "]" : "";
    throw new Error(message + code);
  }
  return data;
}

async function resolveAgentConfigId(explicitId) {
  if (explicitId) return explicitId;
  const data = await request("/api/agent-configs");
  const list = Array.isArray(data) ? data : (data?.configs ?? []);
  if (!list.length) throw new Error("No agent configs available");
  const preferred = list.find((c) => c.engine === "claude-code") || list[0];
  return preferred.id;
}

function normalizeJobPayload(input, fallbackAgentConfigId) {
  if (!input || typeof input !== "object") {
    throw new Error("Job JSON must be an object");
  }

  // Native JobSubmit payload (already server-ready)
  if (typeof input.prompt === "string" && typeof input.agentConfigId === "string") {
    return input;
  }

  // MCP-like payload compatibility (create_job style)
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("Job JSON must include prompt");
  }

  const dependsOn = Array.isArray(input.depends_on_job_ids)
    ? input.depends_on_job_ids
    : (Array.isArray(input.dependsOn) ? input.dependsOn : []);

  const targetProgram = input.target_program || input.targetProgram;
  const projectRoot = input.project_root || input.projectRoot || process.cwd();
  const existingEditorContext = input.editorContext && typeof input.editorContext === "object"
    ? input.editorContext
    : {};
  const existingMetadata = existingEditorContext.metadata && typeof existingEditorContext.metadata === "object"
    ? existingEditorContext.metadata
    : {};

  const metadata = { ...existingMetadata };
  if (typeof targetProgram === "string" && targetProgram) {
    metadata.bridge_type = targetProgram;
    metadata.target_bridges = [targetProgram];
  }

  const handover = typeof input.handover_notes === "string" && input.handover_notes.trim()
    ? ("## Context from Coordinator\\n\\n" + input.handover_notes.trim() + "\\n\\n---\\n\\n## Your Task\\n\\n")
    : "";

  return {
    prompt: handover + input.prompt,
    agentConfigId: input.agent_config_id || input.agentConfigId || fallbackAgentConfigId,
    priority: input.priority || "normal",
    name: input.name,
    startPaused: Boolean(input.startPaused || input.start_paused || false),
    dependsOn,
    targetWorkerName: input.target_worker || input.targetWorkerName,
    editorContext: {
      ...existingEditorContext,
      projectRoot: existingEditorContext.projectRoot || projectRoot,
      metadata,
    },
    files: Array.isArray(input.files) ? input.files : [],
    contextItems: Array.isArray(input.contextItems) ? input.contextItems : [],
  };
}

async function cmdBridges() {
  const data = await request("/api/bridge-command/bridges");
  const bridges = data?.bridges ?? [];
  if (bridges.length === 0) {
    console.log("No bridges connected.");
    return;
  }
  console.log(JSON.stringify(bridges, null, 2));
}

async function cmdContext(rest) {
  const target = rest[0];
  if (!target) throw new Error("Usage: am context <target>");
  const data = await request("/api/bridge-command/context/" + encodeURIComponent(target));
  console.log(JSON.stringify(data?.contexts ?? [], null, 2));
}

async function cmdExec(rest) {
  const args = [...rest];
  const target = args.shift();
  if (!target) throw new Error("Usage: am exec <target> [--lang <language>] [--project-path <path>] <script|-f file>");

  const explicitLang = takeOption(args, ["--lang", "-l"]);
  const explicitProjectPath = takeOption(args, ["--project-path", "--project"]);
  const file = takeOption(args, ["-f", "--file"]);
  const language = inferLanguage(target, explicitLang);
  let script = "";
  if (file) {
    script = fs.readFileSync(file, "utf-8");
  } else {
    script = args.join(" ").trim();
  }
  if (!script) throw new Error("No script provided");

  const body = { target, commands: [{ language, script }] };
  body.projectPath = explicitProjectPath || PROJECT_PATH;
  const data = await request("/api/bridge-command", { method: "POST", body: JSON.stringify(body) });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdExecMulti(rest) {
  const args = [...rest];
  const target = args.shift();
  if (!target) throw new Error("Usage: am exec-multi <target> [--project-path <path>] -f <commands.json>");
  const explicitProjectPath = takeOption(args, ["--project-path", "--project"]);
  const file = takeOption(args, ["-f", "--file"]);
  if (!file) throw new Error("Usage: am exec-multi <target> [--project-path <path>] -f <commands.json>");

  const payload = readJsonFile(file);
  const commands = Array.isArray(payload) ? payload : payload?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("commands.json must contain an array or { commands: [...] }");
  }
  const body = {
    target,
    projectPath: explicitProjectPath || PROJECT_PATH,
    commands: commands.map((c) => ({
      language: c.language || inferLanguage(target),
      script: c.script,
      description: c.description,
    })),
  };
  const data = await request("/api/bridge-command", { method: "POST", body: JSON.stringify(body) });
  console.log(JSON.stringify(data, null, 2));
}

async function cmdAgentConfigs() {
  const data = await request("/api/agent-configs");
  const list = Array.isArray(data) ? data : (data?.configs ?? []);
  console.log(JSON.stringify(list, null, 2));
}

async function cmdJobs(rest) {
  const sub = rest[0];
  if (!sub || sub === "help") {
    console.log("Jobs usage:");
    console.log("  am jobs list [status] [limit]");
    console.log("  am jobs status <jobId>");
    console.log("  am jobs interventions <jobId>");
    console.log("  am jobs create -f <job.json>");
    return;
  }

  if (sub === "list") {
    const status = rest[1];
    const limitRaw = rest[2];
    const qs = new URLSearchParams();
    if (status && status !== "all") qs.set("status", status);
    if (limitRaw) qs.set("limit", String(Number(limitRaw) || 20));
    const q = qs.toString();
    const data = await request("/api/jobs" + (q ? "?" + q : ""));
    console.log(JSON.stringify(data?.jobs ?? data, null, 2));
    return;
  }

  if (sub === "status" || sub === "get") {
    const jobId = rest[1];
    if (!jobId) throw new Error("Usage: am jobs status <jobId>");
    const data = await request("/api/jobs/" + encodeURIComponent(jobId));
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sub === "interventions" || sub === "guidance") {
    const jobId = rest[1];
    if (!jobId) throw new Error("Usage: am jobs interventions <jobId>");
    const data = await request("/api/jobs/" + encodeURIComponent(jobId) + "/interventions");
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sub === "create") {
    const args = rest.slice(1);
    const file = takeOption(args, ["-f", "--file"]);
    if (!file) throw new Error("Usage: am jobs create -f <job.json>");
    const raw = readJsonFile(file);
    const fallbackConfigId = await resolveAgentConfigId(raw.agent_config_id || raw.agentConfigId);
    const payload = normalizeJobPayload(raw, fallbackConfigId);
    const data = await request("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error("Unknown jobs subcommand: " + sub);
}

async function cmdHeadlessCheck(rest) {
  const args = [...rest];
  const program = args.shift();
  if (!program) throw new Error("Usage: am headless-check <program> (--args <json-array> | -f <json-file>)");

  let file = takeOption(args, ["-f", "--file"]);
  let argsJson = takeOption(args, ["--args"]);
  let projectPath = takeOption(args, ["--project-path", "--project"]);
  let timeoutRaw = takeOption(args, ["--timeout"]);
  let payload;

  if (file) {
    const raw = readJsonFile(file);
    if (Array.isArray(raw)) {
      payload = { program, args: raw };
    } else if (raw && typeof raw === "object") {
      payload = {
        program,
        args: raw.args,
        projectPath: raw.projectPath ?? raw.project_path,
        timeout: raw.timeout,
      };
    } else {
      throw new Error("headless-check file must be a JSON array or object");
    }
  } else {
    if (!argsJson) throw new Error("Provide --args '<json-array>' or -f <json-file>");
    payload = { program, args: JSON.parse(argsJson) };
  }

  if (!Array.isArray(payload.args)) {
    throw new Error("headless check args must be a JSON string array");
  }
  if (projectPath && !payload.projectPath) payload.projectPath = projectPath;
  if (timeoutRaw && !payload.timeout) payload.timeout = Number(timeoutRaw);

  const data = await request("/api/bridge-command/headless-check", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (data?.output) console.log(data.output);
  else console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    printUsage();
    return;
  }

  try {
    if (cmd === "bridges" || cmd === "list") return await cmdBridges();
    if (cmd === "context") return await cmdContext(rest);
    if (cmd === "exec" || cmd === "execute") return await cmdExec(rest);
    if (cmd === "exec-multi" || cmd === "execute-multiple") return await cmdExecMulti(rest);
    if (cmd === "agent-configs" || cmd === "configs") return await cmdAgentConfigs();
    if (cmd === "jobs") return await cmdJobs(rest);
    if (cmd === "headless-check") return await cmdHeadlessCheck(rest);

    throw new Error("Unknown command: " + cmd + ". Run 'am help' for usage.");
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
}

main();
`;
}

export interface CliWrapperResult {
  /** Directory containing the CLI wrapper (add to PATH) */
  dir: string;
  /** Full path to the CLI script */
  scriptPath: string;
  /** Cleanup function to remove the temp directory */
  cleanup: () => void;
}

/**
 * Write the `am` CLI wrapper to a temp directory.
 * Returns the directory path (to prepend to PATH) and a cleanup function.
 */
export function writeCliWrapper(serverUrl: string, apiKey: string): CliWrapperResult {
  const dir = join(tmpdir(), `am-cli-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const script = generateScript(serverUrl, apiKey);
  const scriptName = isWindows ? "am.js" : "am";
  const scriptPath = join(dir, scriptName);

  writeFileSync(join(dir, scriptName), script, "utf-8");

  if (isWindows) {
    // On Windows: create both a .cmd wrapper (for cmd.exe) and a plain bash
    // wrapper (for Git Bash, which Claude Code uses for shell commands).
    // .cmd files are NOT directly executable in bash — `am` as a bash script
    // with a shebang is needed so `am exec ...` works in Claude's Bash tool.
    const cmdWrapper = `@echo off\nnode "%~dp0am.js" %*\n`;
    writeFileSync(join(dir, "am.cmd"), cmdWrapper, "utf-8");

    const bashWrapper = `#!/bin/sh\nexec node "$(dirname "$0")/am.js" "$@"\n`;
    writeFileSync(join(dir, "am"), bashWrapper, "utf-8");
    try { chmodSync(join(dir, "am"), 0o755); } catch { /* Windows may not support chmod */ }
  } else {
    chmodSync(join(dir, scriptName), 0o755);
  }

  logger.info("cli-wrapper", `Wrote CLI wrapper to ${dir}`);

  return {
    dir,
    scriptPath: join(dir, scriptName),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
        logger.info("cli-wrapper", `Cleaned up CLI wrapper at ${dir}`);
      } catch {
        // Best effort
      }
    },
  };
}
