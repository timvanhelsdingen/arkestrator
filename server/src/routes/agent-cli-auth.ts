import { existsSync } from "fs";
import type { Hono } from "hono";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { AuditRepo } from "../db/audit.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import { requirePermission, getClientIp } from "../middleware/auth.js";
import { spawnWithFallback } from "../utils/spawn.js";
import { errorResponse } from "../utils/errors.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

type CliAuthProvider = "claude-code" | "codex";
type CliAuthCommandSource = "agent_config" | "default";
type CliAuthSessionStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
type CliAuthState = "authenticated" | "unauthenticated" | "unknown" | "missing";

interface ProviderSpec {
  provider: CliAuthProvider;
  label: string;
  defaultCommand: string;
  statusArgs: string[];
  loginArgs: string[];
  docsUrl: string;
}

interface CommandResolution {
  command: string;
  source: CliAuthCommandSource;
}

interface CommandRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  resolvedCommand?: string;
  error?: string;
}

interface CliAuthStatusItem {
  provider: CliAuthProvider;
  label: string;
  command: string;
  commandSource: CliAuthCommandSource;
  available: boolean;
  authenticated: boolean | null;
  state: CliAuthState;
  details: string;
  docsUrl: string;
  statusCommand: string[];
  outputPreview: string[];
  lastCheckedAt: string;
}

interface CliAuthStatusResponse {
  serverUser: string | null;
  homeDir: string | null;
  providers: CliAuthStatusItem[];
}

interface CliAuthSession {
  id: string;
  provider: CliAuthProvider;
  label: string;
  command: string;
  args: string[];
  status: CliAuthSessionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  urls: string[];
  codes: string[];
  output: string[];
  docsUrl: string;
}

interface CliAuthSessionEnvelope {
  session: CliAuthSession | null;
}

interface CliAuthSessionRuntime {
  session: CliAuthSession;
  proc: ReturnType<typeof Bun.spawn> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  streamPromises: Promise<void>[];
}

const LOG_LINE_LIMIT = 400;
const URL_LIMIT = 8;
const CODE_LIMIT = 8;
const STATUS_TIMEOUT_MS = 8_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const PROVIDERS: ProviderSpec[] = [
  {
    provider: "claude-code",
    label: "Claude Code",
    defaultCommand: "claude",
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  },
  {
    provider: "codex",
    label: "Codex CLI",
    defaultCommand: "codex",
    statusArgs: ["login", "status"],
    loginArgs: ["login", "--device-auth"],
    docsUrl: "https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt",
  },
];

const providerMap = new Map<CliAuthProvider, ProviderSpec>(PROVIDERS.map((provider) => [provider.provider, provider]));
const sessionRuntimes = new Map<CliAuthProvider, CliAuthSessionRuntime>();

function providerFromParam(raw: string): ProviderSpec | null {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return providerMap.get("claude-code") ?? null;
  if (normalized === "codex") return providerMap.get("codex") ?? null;
  return null;
}

function sanitizeLine(line: string): string {
  return line.replace(/\x1B\[[0-9;]*m/g, "").trim();
}

function appendUnique(target: string[], value: string, limit: number) {
  if (!value) return;
  if (target.includes(value)) return;
  if (target.length >= limit) return;
  target.push(value);
}

function extractHints(session: CliAuthSession, line: string) {
  const clean = sanitizeLine(line);
  if (!clean) return;

  const urlMatches = clean.match(/https?:\/\/[^\s)]+/g) ?? [];
  for (const url of urlMatches) appendUnique(session.urls, url, URL_LIMIT);

  const codePatterns = [
    /\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2})\b/g,
    /\b([A-Z0-9]{8})\b/g,
  ];
  for (const pattern of codePatterns) {
    const matches = clean.match(pattern) ?? [];
    for (const match of matches) appendUnique(session.codes, match, CODE_LIMIT);
  }
}

function appendLog(session: CliAuthSession, source: "stdout" | "stderr", chunk: string) {
  const lines = chunk.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = sanitizeLine(lineRaw);
    if (!line) continue;
    const tagged = `[${source}] ${line}`;
    session.output.push(tagged);
    if (session.output.length > LOG_LINE_LIMIT) {
      session.output.splice(0, session.output.length - LOG_LINE_LIMIT);
    }
    extractHints(session, line);
  }
  session.updatedAt = new Date().toISOString();
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  source: "stdout" | "stderr",
  session: CliAuthSession,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        appendLog(session, source, text);
      }
    }
    const tail = decoder.decode();
    if (tail) appendLog(session, source, tail);
  } catch (err) {
    appendLog(session, "stderr", `Stream read failure: ${String(err)}`);
  }
}

function resolveCommand(provider: ProviderSpec, agentsRepo: AgentsRepo): CommandResolution {
  const config = agentsRepo
    .list()
    .find((entry) => entry.engine === provider.provider && entry.command.trim().length > 0);
  if (config) {
    return { command: config.command.trim(), source: "agent_config" };
  }
  return { command: provider.defaultCommand, source: "default" };
}

async function runCommandWithTimeout(
  _provider: ProviderSpec,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandRunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  let resolvedCommand = command;
  try {
    const spawned = spawnWithFallback(command, args, {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    });
    proc = spawned.proc;
    resolvedCommand = spawned.resolvedCommand;
  } catch (err: any) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: err?.message ?? String(err),
    };
  }

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // best effort
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout,
      stderr,
      timedOut,
      resolvedCommand,
    };
  } catch (err: any) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      resolvedCommand,
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(killTimer);
  }
}

function classifyStatus(
  provider: ProviderSpec,
  command: string,
  commandSource: CliAuthCommandSource,
  result: CommandRunResult,
): CliAuthStatusItem {
  const now = new Date().toISOString();
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const lower = output.toLowerCase();
  const preview = output
    .split(/\r?\n/)
    .map((line) => sanitizeLine(line))
    .filter(Boolean)
    .slice(-12);

  if (result.error) {
    const missing = /not found|enoent|executable/i.test(result.error);
    return {
      provider: provider.provider,
      label: provider.label,
      command,
      commandSource,
      available: !missing,
      authenticated: null,
      state: missing ? "missing" : "unknown",
      details: missing
        ? `Command not found in runtime PATH: ${command}`
        : `Status check failed: ${result.error}`,
      docsUrl: provider.docsUrl,
      statusCommand: provider.statusArgs,
      outputPreview: preview,
      lastCheckedAt: now,
    };
  }

  if (result.timedOut) {
    return {
      provider: provider.provider,
      label: provider.label,
      command,
      commandSource,
      available: true,
      authenticated: null,
      state: "unknown",
      details: `Status check timed out after ${STATUS_TIMEOUT_MS}ms`,
      docsUrl: provider.docsUrl,
      statusCommand: provider.statusArgs,
      outputPreview: preview,
      lastCheckedAt: now,
    };
  }

  const isAuthenticated = /logged in|authenticated|active session|chatgpt/i.test(lower);
  const isUnauthenticated = /not logged in|logged out|unauthorized|unauthenticated|please (log in|login)/i.test(lower);
  const statusUnsupported = /unknown command|unrecognized|invalid subcommand|usage:/i.test(lower) && !isAuthenticated;

  if (isAuthenticated) {
    return {
      provider: provider.provider,
      label: provider.label,
      command,
      commandSource,
      available: true,
      authenticated: true,
      state: "authenticated",
      details: "Authenticated in server runtime context.",
      docsUrl: provider.docsUrl,
      statusCommand: provider.statusArgs,
      outputPreview: preview,
      lastCheckedAt: now,
    };
  }

  if (isUnauthenticated) {
    return {
      provider: provider.provider,
      label: provider.label,
      command,
      commandSource,
      available: true,
      authenticated: false,
      state: "unauthenticated",
      details: "Not authenticated in server runtime context.",
      docsUrl: provider.docsUrl,
      statusCommand: provider.statusArgs,
      outputPreview: preview,
      lastCheckedAt: now,
    };
  }

  let details = "CLI status is reachable but auth state could not be determined.";
  if (statusUnsupported) {
    const homeDir = process.env.HOME ?? "";
    const hasLikelyAuthArtifacts = homeDir
      ? (
        existsSync(`${homeDir}/.codex/auth.json`)
        || existsSync(`${homeDir}/.codex/auth.json.bak`)
        || existsSync(`${homeDir}/.claude`)
        || existsSync(`${homeDir}/.config/claude`)
      )
      : false;
    details = hasLikelyAuthArtifacts
      ? "Status command unsupported; auth artifacts exist for this runtime user."
      : "Status command unsupported; start login to verify auth in this runtime.";
  }

  return {
    provider: provider.provider,
    label: provider.label,
    command,
    commandSource,
    available: true,
    authenticated: null,
    state: "unknown",
    details,
    docsUrl: provider.docsUrl,
    statusCommand: provider.statusArgs,
    outputPreview: preview,
    lastCheckedAt: now,
  };
}

async function buildProviderStatus(provider: ProviderSpec, agentsRepo: AgentsRepo): Promise<CliAuthStatusItem> {
  const resolution = resolveCommand(provider, agentsRepo);
  const result = await runCommandWithTimeout(
    provider,
    resolution.command,
    provider.statusArgs,
    STATUS_TIMEOUT_MS,
  );
  return classifyStatus(provider, resolution.command, resolution.source, result);
}

function getSession(provider: CliAuthProvider): CliAuthSession | null {
  const runtime = sessionRuntimes.get(provider);
  return runtime?.session ?? null;
}

function finalizeSession(runtime: CliAuthSessionRuntime, status: CliAuthSessionStatus, exitCode: number | null) {
  const session = runtime.session;
  session.status = status;
  session.exitCode = exitCode;
  session.updatedAt = new Date().toISOString();
  session.finishedAt = session.updatedAt;
  if (runtime.timeoutTimer) {
    clearTimeout(runtime.timeoutTimer);
    runtime.timeoutTimer = null;
  }
  runtime.proc = null;
}

function startLoginSession(provider: ProviderSpec, command: string): CliAuthSessionRuntime {
  const now = new Date().toISOString();
  const session: CliAuthSession = {
    id: newId(),
    provider: provider.provider,
    label: provider.label,
    command,
    args: [...provider.loginArgs],
    status: "running",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    urls: [],
    codes: [],
    output: [],
    docsUrl: provider.docsUrl,
  };

  const runtime: CliAuthSessionRuntime = {
    session,
    proc: null,
    timeoutTimer: null,
    streamPromises: [],
  };
  sessionRuntimes.set(provider.provider, runtime);

  try {
    const spawned = spawnWithFallback(command, provider.loginArgs, {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    });
    runtime.proc = spawned.proc;
    session.command = spawned.resolvedCommand;
  } catch (err: any) {
    appendLog(session, "stderr", `Failed to launch login: ${err?.message ?? String(err)}`);
    finalizeSession(runtime, "failed", null);
    return runtime;
  }

  runtime.timeoutTimer = setTimeout(() => {
    session.timedOut = true;
    appendLog(session, "stderr", `Login session timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)} seconds`);
    try {
      runtime.proc?.kill();
    } catch {
      // best effort
    }
  }, LOGIN_TIMEOUT_MS);

  runtime.streamPromises = [
    consumeStream(runtime.proc.stdout as ReadableStream<Uint8Array> | null, "stdout", session),
    consumeStream(runtime.proc.stderr as ReadableStream<Uint8Array> | null, "stderr", session),
  ];

  void (async () => {
    const exitCode = await runtime.proc!.exited;
    await Promise.allSettled(runtime.streamPromises);
    if (session.status === "cancelled") {
      finalizeSession(runtime, "cancelled", exitCode);
      return;
    }
    if (session.timedOut) {
      finalizeSession(runtime, "timed_out", exitCode);
      return;
    }
    if (exitCode === 0) {
      finalizeSession(runtime, "succeeded", exitCode);
    } else {
      finalizeSession(runtime, "failed", exitCode);
    }
  })().catch((err) => {
    appendLog(session, "stderr", `Login watcher failed: ${String(err)}`);
    finalizeSession(runtime, "failed", null);
  });

  return runtime;
}

function cancelLoginSession(provider: CliAuthProvider): CliAuthSession | null {
  const runtime = sessionRuntimes.get(provider);
  if (!runtime) return null;
  if (runtime.session.status !== "running") return runtime.session;
  runtime.session.status = "cancelled";
  runtime.session.updatedAt = new Date().toISOString();
  runtime.session.finishedAt = runtime.session.updatedAt;
  try {
    runtime.proc?.kill();
  } catch {
    // best effort
  }
  return runtime.session;
}

export function registerAgentCliAuthRoutes(
  router: Hono,
  agentsRepo: AgentsRepo,
  usersRepo: UsersRepo,
  auditRepo: AuditRepo,
) {
  router.get("/cli-auth/status", async (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const statuses = await Promise.all(PROVIDERS.map((provider) => buildProviderStatus(provider, agentsRepo)));
    const response: CliAuthStatusResponse = {
      serverUser: process.env.USER ?? process.env.LOGNAME ?? null,
      homeDir: process.env.HOME ?? null,
      providers: statuses,
    };
    return c.json(response);
  });

  router.post("/cli-auth/:provider/login/start", (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const provider = providerFromParam(c.req.param("provider"));
    if (!provider) {
      return errorResponse(c, 400, "Invalid provider. Use 'claude-code' or 'codex'.", "INVALID_INPUT");
    }

    const running = getSession(provider.provider);
    if (running && running.status === "running") {
      return errorResponse(c, 409, `${provider.label} login is already running`, "CONFLICT");
    }

    const resolution = resolveCommand(provider, agentsRepo);
    const runtime = startLoginSession(provider, resolution.command);

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "start_cli_login",
      resource: "agent_cli_auth",
      resourceId: provider.provider,
      details: JSON.stringify({
        provider: provider.provider,
        command: runtime.session.command,
        args: runtime.session.args,
      }),
      ipAddress: getClientIp(c),
    });

    return c.json({ session: runtime.session } satisfies CliAuthSessionEnvelope, 201);
  });

  router.get("/cli-auth/:provider/login/session", (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const provider = providerFromParam(c.req.param("provider"));
    if (!provider) {
      return errorResponse(c, 400, "Invalid provider. Use 'claude-code' or 'codex'.", "INVALID_INPUT");
    }

    return c.json({ session: getSession(provider.provider) } satisfies CliAuthSessionEnvelope);
  });

  router.post("/cli-auth/:provider/login/cancel", (c) => {
    const user = requirePermission(c, usersRepo, "manageAgents");
    if (!user) return errorResponse(c, 403, "Forbidden", "FORBIDDEN");

    const provider = providerFromParam(c.req.param("provider"));
    if (!provider) {
      return errorResponse(c, 400, "Invalid provider. Use 'claude-code' or 'codex'.", "INVALID_INPUT");
    }

    const session = cancelLoginSession(provider.provider);
    if (!session) {
      return errorResponse(c, 404, "No login session found for provider", "NOT_FOUND");
    }

    auditRepo.log({
      userId: user.id,
      username: user.username,
      action: "cancel_cli_login",
      resource: "agent_cli_auth",
      resourceId: provider.provider,
      details: JSON.stringify({ provider: provider.provider }),
      ipAddress: getClientIp(c),
    });

    logger.info("cli-auth", `Cancelled ${provider.provider} login session ${session.id}`);
    return c.json({ session } satisfies CliAuthSessionEnvelope);
  });
}
