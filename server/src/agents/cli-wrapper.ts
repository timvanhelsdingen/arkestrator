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
  console.log("  am file-push <target> <local-path> [remote-path] [--target-type program|worker|id] [--project-path <path>]");
  console.log("  am agent-configs");
  console.log("  am jobs list [status] [limit]");
  console.log("  am jobs status <jobId>");
  console.log("  am jobs interventions <jobId>");
  console.log("  am jobs create -f <job.json>");
  console.log("  am jobs rate <good|average|poor> [notes]");
  console.log("  am headless-check <program> --args '[\\"--headless\\",\\"--path\\",\\"/project\\"]'");
  console.log("  am headless-check <program> -f <headless-check.json>");
  console.log("  am skills search <query> [--program <program>]");
  console.log("  am skills get <slug> [--program <program>]");
  console.log("  am skills create --slug <slug> --title <title> --program <program> --content <content> [--keywords <k1,k2>]");
  console.log("  am skills create -f <skill.json>");
  console.log("  am skills update <slug> [--program <program>] [--content <content>] [--title <title>] [--keywords <k1,k2>]");
  console.log("  am skills rate <slug> <useful|not_useful|partial> [--program <program>]");
  console.log("  am skills list [--program <program>]");
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
  return { godot: "gdscript", blender: "python", houdini: "python", comfyui: "python", unreal: "python", nuke: "python", fusion: "python" }[target] || "python";
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
    console.log("  am jobs rate <good|average|poor> [notes]");
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

  if (sub === "rate") {
    const rating = rest[1];
    if (!rating || !["good", "average", "poor"].includes(rating)) {
      throw new Error("Usage: am jobs rate <good|average|poor> [notes]");
    }
    const notes = rest.slice(2).join(" ") || "";
    if (!JOB_ID) {
      console.error("Warning: ARKESTRATOR_JOB_ID not set, cannot rate job");
      return;
    }
    const data = await request("/api/jobs/" + encodeURIComponent(JOB_ID) + "/outcome", {
      method: "POST",
      body: JSON.stringify({ rating, notes }),
    });
    console.log("Job rated: " + rating + (notes ? " — " + notes : ""));
    return;
  }

  throw new Error("Unknown jobs subcommand: " + sub);
}

async function cmdFilePush(rest) {
  const args = [...rest];
  const target = args.shift();
  if (!target) throw new Error("Usage: am file-push <target> <local-path> [remote-path] [--target-type program|worker|id] [--project-path <path>]");

  const targetType = takeOption(args, ["--target-type", "--type"]) || "program";
  const projectPath = takeOption(args, ["--project-path", "--project"]) || PROJECT_PATH;

  const localPath = args.shift();
  if (!localPath) throw new Error("Missing <local-path> argument");
  const remotePath = args.shift() || require("path").basename(localPath);

  const buffer = fs.readFileSync(localPath);
  const HTTP_THRESHOLD = 5 * 1024 * 1024; // 5 MB

  // Large files use HTTP streaming transfer
  if (buffer.length > HTTP_THRESHOLD) {
    // 1. Create transfer
    const transfer = await request("/api/transfers", {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: remotePath, size: buffer.length }],
        target,
        targetType,
        projectPath,
        source: "am file-push (job " + JOB_ID + ")",
      }),
    });

    // 2. Upload file as raw binary via HTTP PUT
    const uploadUrl = SERVER + transfer.files[0].uploadUrl;
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/octet-stream",
        ...(JOB_ID ? { "X-Job-Id": JOB_ID } : {}),
      },
      body: buffer,
    });
    if (!uploadRes.ok) {
      throw new Error("Upload failed (" + uploadRes.status + "): " + (await uploadRes.text()));
    }
    const result = await uploadRes.json();
    console.log(JSON.stringify({ transferId: transfer.transferId, ...result }, null, 2));
    return;
  }

  // Small files use existing base64 WebSocket path
  const isText = !buffer.some((b, i) => i < Math.min(buffer.length, 1024) && b === 0);
  const fileChange = {
    path: remotePath,
    action: "create",
  };
  if (isText) {
    fileChange.content = buffer.toString("utf-8");
    fileChange.encoding = "utf8";
  } else {
    fileChange.binaryContent = buffer.toString("base64");
    fileChange.encoding = "base64";
  }

  const body = {
    target,
    targetType,
    projectPath,
    files: [fileChange],
    source: "am file-push (job " + JOB_ID + ")",
  };
  const data = await request("/api/bridge-command/file-deliver", { method: "POST", body: JSON.stringify(body) });
  console.log(JSON.stringify(data, null, 2));
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

async function cmdSkills(rest) {
  const sub = rest[0];
  if (!sub) throw new Error("Usage: am skills <search|get|create|update|rate|list> ...");

  if (sub === "list") {
    const program = takeOption(rest.slice(1), ["--program", "-p"]);
    const qs = program ? "?program=" + encodeURIComponent(program) : "";
    const data = await request("/api/skills" + qs);
    const skills = data.skills || data || [];
    for (const s of skills) {
      console.log(s.slug + " [" + s.program + "] " + (s.title || s.name));
    }
    return;
  }

  if (sub === "search") {
    const query = rest.slice(1).filter(a => !a.startsWith("--")).join(" ");
    const args = rest.slice(1);
    const program = takeOption(args, ["--program", "-p"]);
    if (!query) throw new Error("Usage: am skills search <query> [--program <program>]");
    const body = { query, limit: 10 };
    if (program) body.program = program;
    const data = await request("/api/skills/search", { method: "POST", body: JSON.stringify(body) });
    const results = data.results || [];
    if (results.length === 0) { console.log("No matching skills found."); return; }
    for (const r of results) {
      console.log(r.slug + " [" + r.program + "] score=" + (r.score || 0).toFixed(2) + " — " + (r.title || r.name));
    }
    return;
  }

  if (sub === "get") {
    const slug = rest[1];
    const args = rest.slice(1);
    const program = takeOption(args, ["--program", "-p"]);
    if (!slug) throw new Error("Usage: am skills get <slug> [--program <program>]");
    const qs = program ? "?program=" + encodeURIComponent(program) : "";
    const data = await request("/api/skills/" + encodeURIComponent(slug) + qs);
    if (data.content) {
      console.log("# " + (data.title || data.slug) + " [" + data.program + "]");
      console.log(data.content);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (sub === "create") {
    const args = rest.slice(1);
    const file = takeOption(args, ["-f", "--file"]);
    let body;
    if (file) {
      body = JSON.parse(fs.readFileSync(file, "utf-8"));
    } else {
      const slug = takeOption(args, ["--slug"]);
      const title = takeOption(args, ["--title"]);
      const program = takeOption(args, ["--program"]);
      const content = takeOption(args, ["--content"]);
      const keywordsRaw = takeOption(args, ["--keywords"]);
      const category = takeOption(args, ["--category"]) || "custom";
      if (!slug || !title || !program || !content) {
        throw new Error("Usage: am skills create --slug <slug> --title <title> --program <program> --content <content>");
      }
      body = { slug, title, program, content, category, keywords: keywordsRaw ? keywordsRaw.split(",") : [program, slug] };
    }
    const data = await request("/api/skills", { method: "POST", body: JSON.stringify(body) });
    console.log("Skill created: " + (data.slug || body.slug));
    return;
  }

  if (sub === "update") {
    const slug = rest[1];
    if (!slug) throw new Error("Usage: am skills update <slug> [--content <content>] [--title <title>]");
    const args = rest.slice(2);
    const program = takeOption(args, ["--program", "-p"]);
    const content = takeOption(args, ["--content"]);
    const title = takeOption(args, ["--title"]);
    const keywordsRaw = takeOption(args, ["--keywords"]);
    const body = {};
    if (content) body.content = content;
    if (title) body.title = title;
    if (keywordsRaw) body.keywords = keywordsRaw.split(",");
    if (program) body.program = program;
    const qs = program ? "?program=" + encodeURIComponent(program) : "";
    const data = await request("/api/skills/" + encodeURIComponent(slug) + qs, { method: "PUT", body: JSON.stringify(body) });
    console.log("Skill updated: " + slug);
    return;
  }

  if (sub === "rate") {
    const slug = rest[1];
    const rating = rest[2]; // useful, not_useful, partial
    if (!slug || !rating) throw new Error("Usage: am skills rate <slug> <useful|not_useful|partial> [--program <program>]");
    const args = rest.slice(3);
    const program = takeOption(args, ["--program", "-p"]);
    const body = { rating, jobId: JOB_ID, program: program || undefined };
    if (!JOB_ID) {
      console.error("Warning: ARKESTRATOR_JOB_ID not set, rating may not be linked to a job");
    }
    const data = await request("/api/skills/" + encodeURIComponent(slug) + "/rate", { method: "POST", body: JSON.stringify(body) });
    console.log("Rated: " + slug + " → " + rating);
    return;
  }

  throw new Error("Unknown skills subcommand: " + sub + ". Use: search, get, create, update, rate, list");
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
    if (cmd === "file-push" || cmd === "push") return await cmdFilePush(rest);
    if (cmd === "agent-configs" || cmd === "configs") return await cmdAgentConfigs();
    if (cmd === "jobs") return await cmdJobs(rest);
    if (cmd === "headless-check") return await cmdHeadlessCheck(rest);
    if (cmd === "skills" || cmd === "skill") return await cmdSkills(rest);

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

  writeFileSync(join(dir, scriptName), script, { encoding: "utf-8", mode: 0o600 });

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
