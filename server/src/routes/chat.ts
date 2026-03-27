import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { JobRuntimeOptions } from "@arkestrator/protocol";
import { z } from "zod";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { UsersRepo } from "../db/users.repo.js";
import type { ApiKeysRepo } from "../db/apikeys.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { WebSocketHub } from "../ws/hub.js";
import type { Config } from "../config.js";
import { getAuthPrincipal } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { errorResponse } from "../utils/errors.js";
import { spawnWithFallback } from "../utils/spawn.js";
import { normalizeCodexArgs } from "../utils/codex-args.js";
import { encodeCodexPromptArg } from "../utils/codex-prompt.js";
import { applyRuntimeOptionsToConfig, normalizeJobRuntimeOptions } from "../agents/runtime-options.js";
import { buildLocalCliArgs } from "../agents/local-args.js";
import { isModelAllowedByStoredAllowlist } from "../local-models/catalog.js";
import { getConfiguredOllamaBaseUrl, streamOllamaChat } from "../local-models/ollama.js";
import type { OllamaChatMessage } from "../local-models/ollama.js";
import { resolveWorkerLocalLlmEndpoint, resolveAnyAvailableWorkerLlm } from "../local-models/distributed.js";
import { resolveAutoAgentByPriority } from "../agents/auto-routing.js";
import { getClaudeRuntimeDecision } from "../utils/claude-runtime.js";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChatSessionKey,
  CodexChatSessionManager,
  createCodexJsonStreamState,
  consumeCodexJsonChunk,
  flushCodexJsonChunk,
} from "../chat/codex-sessions.js";
import {
  createClaudeJsonStreamState,
  consumeClaudeJsonChunk,
  flushClaudeJsonChunk,
} from "../chat/claude-sessions.js";

const CLAUDE_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

interface ChatDeps {
  agentsRepo: AgentsRepo;
  usersRepo: UsersRepo;
  apiKeysRepo: ApiKeysRepo;
  settingsRepo: SettingsRepo;
  workersRepo: WorkersRepo;
  jobsRepo: JobsRepo;
  hub: WebSocketHub;
  config: Config;
  chatSessions: CodexChatSessionManager;
}

const ChatRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  agentConfigId: z.string().trim().min(1),
  history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional(),
  improve: z.boolean().optional(),
  bridgePrograms: z.array(z.string()).optional(),
  conversationKey: z.string().trim().min(1).max(200).optional(),
  runtimeOptions: z.unknown().optional(),
  targetWorkerName: z.string().trim().optional(),
  jobIds: z.array(z.string()).max(20).optional(),
});

export function createChatRoutes(deps: ChatDeps) {
  const app = new Hono();

  // POST /api/chat — Conversational chat (no job created)
  // Spawns agent CLI with prompt, streams stdout back as SSE
  app.post("/", async (c) => {
    logger.info("chat", "Incoming chat request");

    try {
      const principal = await getAuthPrincipal(c, deps.usersRepo, deps.apiKeysRepo);
      if (!principal) {
        return errorResponse(c, 401, "Unauthorized", "UNAUTHORIZED");
      }

      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return errorResponse(c, 400, "Invalid JSON body", "INVALID_JSON");
      }
      const parsedBody = ChatRequestSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        return errorResponse(c, 400, "Validation failed", "VALIDATION_ERROR", {
          details: parsedBody.error.flatten(),
        });
      }
      const body = parsedBody.data as {
        prompt: string;
        agentConfigId: string;
        history?: { role: string; content: string }[];
        improve?: boolean;
        bridgePrograms?: string[];
        conversationKey?: string;
        runtimeOptions?: JobRuntimeOptions;
        targetWorkerName?: string;
        jobIds?: string[];
      };

      const runtimeOptions = normalizeJobRuntimeOptions(body.runtimeOptions);
      let agentConfig = null as ReturnType<typeof deps.agentsRepo.getById>;
      if (body.agentConfigId === "auto") {
        try {
          agentConfig = resolveAutoAgentByPriority(
            body.prompt,
            runtimeOptions,
            deps.agentsRepo,
            deps.settingsRepo,
          ).config;
        } catch (err: any) {
          return errorResponse(c, 400, err?.message ?? "No agent config available for AUTO routing", "CONFIG_NOT_FOUND");
        }
      } else {
        agentConfig = deps.agentsRepo.getById(body.agentConfigId);
      }
      if (!agentConfig) {
        return errorResponse(c, 404, "Agent config not found", "CONFIG_NOT_FOUND");
      }
      const effectiveConfig = applyRuntimeOptionsToConfig(agentConfig, runtimeOptions);
      if (
        effectiveConfig.engine === "local-oss"
        && !isModelAllowedByStoredAllowlist(deps.settingsRepo, "ollama", effectiveConfig.model)
      ) {
        return errorResponse(c, 403, `Local model "${effectiveConfig.model}" is not in the allowed model list`, "POLICY_BLOCKED");
      }

      const improveMode = body.improve === true;
      const principalKey = principal.kind === "user"
        ? `user:${principal.user.id}`
        : `apiKey:${principal.apiKey.id}`;
      const bridgePrograms = Array.isArray(body.bridgePrograms)
        ? [...new Set(
            body.bridgePrograms
              .map((program) => String(program ?? "").trim().toLowerCase())
              .filter(Boolean),
          )]
        : [];
      const bridgeProgramLabel = bridgePrograms.length > 0
        ? bridgePrograms.join(", ")
        : "selected bridge(s)";
      const agentLabel = `${effectiveConfig.name} (${effectiveConfig.engine})`;

    // Build a chat-only prompt with optional conversation history.
    // Codex chat is kept stateless because transcript stitching can degrade
    // prompt-following quality for short one-shot exec calls.
      // Whether to skip history is determined after session lookup (see below)
      let useHistory = effectiveConfig.engine !== "codex" && !improveMode;
      let fullPrompt = "";
      if (useHistory && body.history && body.history.length > 0) {
        const historyText = body.history
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n\n");
        fullPrompt = `${historyText}\n\nUser: ${body.prompt}`;
      } else {
        fullPrompt = body.prompt;
      }

    const improveSystemPrompt = [
      "You are a prompt engineer.",
      `Rewrite the following user prompt to be more specific, detailed, and actionable for AI coding agent ${agentLabel} working in ${bridgeProgramLabel}.`,
      "Keep the user's intent but add: specific file paths where possible, step-by-step breakdown, expected outputs, and verification steps.",
      "Return ONLY the improved prompt, no explanation.",
    ].join(" ");

    // Build command based on engine
    const command = effectiveConfig.command || "claude";
    const args: string[] = [];
    let runAsUser: { username: string; preserveEnvironment?: boolean } | undefined;
    // Session management — reuse conversation context across messages
    const hasConversationKey = typeof body.conversationKey === "string"
      && body.conversationKey.trim().length > 0;

    const canReuseCodexSession = effectiveConfig.engine === "codex"
      && !improveMode && hasConversationKey;
    const canReuseClaudeSession = effectiveConfig.engine === "claude-code"
      && !improveMode && hasConversationKey;

    const sessionKeyInput = hasConversationKey ? {
      principalKey,
      conversationKey: body.conversationKey!.trim(),
      agentConfigId: effectiveConfig.id,
      command,
      model: effectiveConfig.model,
      runtimeOptions,
    } : null;

    const codexSessionKey = canReuseCodexSession && sessionKeyInput
      ? buildChatSessionKey(sessionKeyInput) : null;
    const claudeSessionKey = canReuseClaudeSession && sessionKeyInput
      ? `claude:${buildChatSessionKey(sessionKeyInput)}` : null;

    const existingCodexSession = codexSessionKey
      ? deps.chatSessions.get(codexSessionKey)
      : null;
    const existingClaudeSession = claudeSessionKey
      ? deps.chatSessions.get(claudeSessionKey)
      : null;

    // Skip history when resuming a Claude session (Claude maintains its own context)
    if (existingClaudeSession?.threadId) {
      useHistory = false;
    }

    // Build dynamic context about connected bridges for the system prompt
    const bridges = deps.hub.getBridges();
    let bridgeContext = "";
    if (!improveMode && bridges.length > 0) {
      const bridgeLines = bridges.map((b) => {
        const parts = [b.program ?? "unknown"];
        if (b.workerName) parts.push(`worker: ${b.workerName}`);
        if (b.projectPath) parts.push(`project: ${b.projectPath}`);
        if (b.programVersion) parts.push(`v${b.programVersion}`);
        return `  - ${parts.join(", ")}`;
      });
      bridgeContext = `\n\nCurrently connected bridges:\n${bridgeLines.join("\n")}`;
    } else if (!improveMode) {
      bridgeContext = "\n\nNo bridges are currently connected.";
    }

    // Build job context for recent jobs in this conversation
    let jobContext = "";
    if (!improveMode && Array.isArray(body.jobIds) && body.jobIds.length > 0) {
      const summaries: string[] = [];
      for (const jobId of body.jobIds.slice(-10)) {
        try {
          const job = deps.jobsRepo.getById(jobId);
          if (!job) continue;
          const id = `#${job.id.slice(0, 8)}`;
          const prompt = (job.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          const changes = Array.isArray(job.result) ? `${job.result.length} file change${job.result.length !== 1 ? "s" : ""}` : "";
          const commands = Array.isArray(job.commands) ? `${job.commands.length} command${job.commands.length !== 1 ? "s" : ""}` : "";
          const err = job.error ? `error: ${job.error.slice(0, 100)}` : "";
          const parts = [id, job.status, `"${prompt}"`, changes, commands, err].filter(Boolean);
          summaries.push(`  - ${parts.join(" | ")}`);
        } catch { /* skip bad IDs */ }
      }
      if (summaries.length > 0) {
        jobContext = `\n\nRecent jobs in this conversation:\n${summaries.join("\n")}`;
      }
    }

    switch (effectiveConfig.engine) {
      case "claude-code": {
        const claudeRuntime = getClaudeRuntimeDecision();
        runAsUser = claudeRuntime.runAsUser;
        if (claudeRuntime.allowSkipPermissionsFlag) {
          args.push(CLAUDE_SKIP_PERMISSIONS_FLAG);
        }

        args.push("--max-turns", "1");

        {
          // TODO: Add --resume session support once stream-json format is verified
          if (effectiveConfig.model) args.push("--model", effectiveConfig.model);
          args.push(
            "--system-prompt",
            improveMode
              ? improveSystemPrompt
              : (
                "You are a chat assistant inside the Arkestrator desktop client. " +
                "The user is chatting with you to brainstorm, refine prompts, and plan work before submitting jobs. " +
                "The client has three actions: 'Send' (chat with you), 'Add to Queue' (submit a paused job), " +
                "and 'Queue and Start' (submit and run immediately). " +
                "When jobs are submitted, they are run by an AI agent (like you) that HAS full tool access — " +
                "it can edit files, run scripts, and interact with connected DCC applications via bridge plugins. " +
                "The user selects which bridges to target in the bridge dropdown before submitting. " +
                "YOUR role here is chat-only: answer conversationally, help refine prompts, suggest approaches. " +
                "Do NOT create, edit, or delete any files. Do NOT use any tools. Just respond with text. " +
                "When the user asks you to write a prompt, write it so they can copy-paste it into the prompt " +
                "box and submit it as a job. Make prompts detailed and actionable for the agent that will execute them. " +
                "You can see summaries of recent jobs below. Use them to answer questions about what was done, " +
                "whether jobs succeeded or failed, what errors occurred, what files changed, and what commands ran. " +
                "If the user wants to send guidance to a running job, suggest they use the guidance composer in the Jobs page." +
                bridgeContext +
                jobContext
              ),
          );
        }
        args.push("-p", fullPrompt);
        break;
      }
      case "codex":
        args.push("exec");
        if (existingCodexSession?.threadId) {
          args.push("resume", existingCodexSession.threadId);
        }
        if (effectiveConfig.model) args.push("--model", effectiveConfig.model);
        args.push("--full-auto");
        args.push("--skip-git-repo-check");
        args.push("--json");
        args.push(...normalizeCodexArgs(effectiveConfig.args ?? []));
        const codexChatInstructions = improveMode
          ? improveSystemPrompt
          : [
            "You are the chat assistant inside the Arkestrator desktop client.",
            "Respond to the user's latest message directly with useful content.",
            "Do not reply with meta acknowledgements like 'Understood', 'I will', or 'Send your task'.",
            "Do not ask generic setup questions unless required to complete the request.",
            "When the user asks to improve, rewrite, or refine a prompt, immediately return an improved prompt they can copy-paste.",
            "If the user already provided task text, do not ask them to paste it again.",
            "Keep the response concise and actionable.",
          ].join(" ");
        const codexPrompt = `${codexChatInstructions}${bridgeContext}${jobContext}\n\nUser request:\n${fullPrompt}`;
        args.push(
          encodeCodexPromptArg(codexPrompt),
        );
        break;
      case "gemini":
        if (effectiveConfig.model) args.push("--model", effectiveConfig.model);
        args.push(improveMode ? `${improveSystemPrompt}\n\n${fullPrompt}` : fullPrompt);
        break;
      case "local-oss": {
        const localPrompt = improveMode ? `${improveSystemPrompt}\n\n${fullPrompt}` : fullPrompt;
        args.push(...buildLocalCliArgs(effectiveConfig.args, localPrompt, effectiveConfig.model));
        break;
      }
      default:
        args.push(...(effectiveConfig.args || []), improveMode ? `${improveSystemPrompt}\n\n${fullPrompt}` : fullPrompt);
        break;
    }

    const spawnArgv = [command, ...args];
    logger.info("chat", `Spawning chat: ${spawnArgv.join(" ")} (engine: ${effectiveConfig.engine})`);
    logger.debug("chat", `Chat spawn argv: ${JSON.stringify(spawnArgv)}`);
    const isCodexJsonChat = effectiveConfig.engine === "codex";

    // Strip nested-agent session env vars so spawned CLIs do not inherit
    // sandbox/session constraints from parent shells.
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      const upper = key.toUpperCase();
      if (
        value !== undefined &&
        !upper.startsWith("CLAUDE") &&
        !upper.startsWith("MCP_")
      ) {
        cleanEnv[key] = value;
      }
    }
    if (effectiveConfig.engine === "codex") {
      delete cleanEnv.CODEX_SANDBOX;
      delete cleanEnv.CODEX_SANDBOX_NETWORK_DISABLED;
      delete cleanEnv.CODEX_THREAD_ID;
      delete cleanEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    }

    const spawnCwd = effectiveConfig.engine === "codex"
      ? join(tmpdir(), "arkestrator-codex-chat")
      : process.cwd();
    if (effectiveConfig.engine === "codex") {
      mkdirSync(spawnCwd, { recursive: true });
    }

    // Distributed Ollama endpoint resolution for local-oss chat
    let ollamaHttpBaseUrl: string | null = null;
    if (effectiveConfig.engine === "local-oss") {
      const effectiveHost = effectiveConfig.localModelHost ?? "client";

      if (effectiveHost === "client") {
        let targetWorker = String(body.targetWorkerName ?? "").trim().toLowerCase();
        let resolution: Awaited<ReturnType<typeof resolveWorkerLocalLlmEndpoint>> | null = null;

        if (targetWorker) {
          resolution = resolveWorkerLocalLlmEndpoint(deps.settingsRepo, deps.workersRepo, targetWorker);
        } else {
          // First try hub-based resolution (connected workers)
          resolution = await resolveAnyAvailableWorkerLlm(
            deps.settingsRepo,
            deps.workersRepo,
            deps.hub,
            undefined,
            true, // skipHealthCheck — server may not be able to reach worker Ollama directly
          );
          if (resolution) {
            targetWorker = resolution.workerName;
          } else {
            // Fallback: try any worker with localLlmEnabled in rules, even if not
            // connected via WebSocket.  For HTTP API chat we only need the URL.
            const { listWorkerRules } = await import("../security/worker-rules.js");
            const allRules = listWorkerRules(deps.settingsRepo);
            for (const rule of allRules) {
              if (!rule.localLlmEnabled) continue;
              const direct = resolveWorkerLocalLlmEndpoint(deps.settingsRepo, deps.workersRepo, rule.workerName);
              if (direct.enabled && direct.baseUrl) {
                resolution = direct;
                targetWorker = rule.workerName;
                break;
              }
            }
          }
        }

        if (resolution?.enabled && resolution.baseUrl) {
          cleanEnv.OLLAMA_HOST = resolution.baseUrl;
          cleanEnv.OLLAMA_BASE_URL = resolution.baseUrl;
          ollamaHttpBaseUrl = resolution.baseUrl;
          logger.info("chat", `Distributed Ollama: using worker "${targetWorker}" at ${resolution.baseUrl}`);
        } else if (resolution && !resolution.enabled) {
          logger.warn("chat", `Worker "${targetWorker}" is not enabled for local LLM. Falling back to server Ollama.`);
          const fallback = getConfiguredOllamaBaseUrl(deps.settingsRepo);
          cleanEnv.OLLAMA_HOST = fallback;
          cleanEnv.OLLAMA_BASE_URL = fallback;
        } else {
          // No worker found or no baseUrl — fall back to server-configured Ollama
          const fallback = getConfiguredOllamaBaseUrl(deps.settingsRepo);
          cleanEnv.OLLAMA_HOST = fallback;
          cleanEnv.OLLAMA_BASE_URL = fallback;
        }
      } else {
        // Host mode is "server" — use the server's configured Ollama endpoint
        const serverUrl = getConfiguredOllamaBaseUrl(deps.settingsRepo);
        cleanEnv.OLLAMA_HOST = serverUrl;
        cleanEnv.OLLAMA_BASE_URL = serverUrl;
      }
    }

    // -----------------------------------------------------------------------
    // HTTP API streaming path for local-oss when CLI is unavailable (Docker)
    // -----------------------------------------------------------------------
    if (effectiveConfig.engine === "local-oss" && ollamaHttpBaseUrl) {
      const chatModel = effectiveConfig.model ?? "llama3.2:latest";
      const chatMessages: OllamaChatMessage[] = [];

      // System context with bridge/job info
      const systemContext = `You are a chat assistant inside the Arkestrator desktop client. Answer conversationally and help the user plan work.${bridgeContext}${jobContext}`;
      chatMessages.push({ role: "system", content: systemContext });

      // Include conversation history if provided
      if (body.history?.length) {
        for (const msg of body.history) {
          chatMessages.push({
            role: msg.role as OllamaChatMessage["role"],
            content: msg.content,
          });
        }
      }
      chatMessages.push({ role: "user", content: fullPrompt });

      logger.info(
        "chat",
        `Streaming local-oss chat via Ollama HTTP API: ${ollamaHttpBaseUrl} model=${chatModel}`,
      );

      const CHAT_HTTP_TIMEOUT_MS = 5 * 60 * 1000;
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController();
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: "status", status: "thinking" }),
            event: "message",
          });

          let gotFirstChunk = false;
          heartbeatTimer = setInterval(async () => {
            if (gotFirstChunk) return;
            try {
              await stream.writeSSE({
                data: JSON.stringify({ type: "status", status: "thinking" }),
                event: "message",
              });
            } catch { /* stream closed */ }
          }, 5000);

          timeoutTimer = setTimeout(() => {
            logger.warn("chat", `Ollama HTTP chat timed out after ${CHAT_HTTP_TIMEOUT_MS}ms`);
            abortController.abort();
          }, CHAT_HTTP_TIMEOUT_MS);

          stream.onAbort(() => {
            clearTimeout(timeoutTimer);
            clearInterval(heartbeatTimer);
            abortController.abort();
          });

          for await (const chunk of streamOllamaChat(
            ollamaHttpBaseUrl!,
            chatModel,
            chatMessages,
            abortController.signal,
          )) {
            gotFirstChunk = true;
            await stream.writeSSE({
              data: JSON.stringify({ type: "text", content: chunk }),
              event: "message",
            });
          }

          clearInterval(heartbeatTimer);
          clearTimeout(timeoutTimer);

          logger.info("chat", "Ollama HTTP chat stream completed");
          await stream.writeSSE({
            data: JSON.stringify({ type: "done" }),
            event: "message",
          });
        } catch (err: any) {
          clearInterval(heartbeatTimer);
          clearTimeout(timeoutTimer);
          const msg = err?.message ?? String(err);
          logger.warn("chat", `Ollama HTTP chat failed: ${msg}`);
          try {
            await stream.writeSSE({
              data: JSON.stringify({ type: "error", error: msg }),
              event: "message",
            });
          } catch { /* stream closed */ }
        }
      });
    }

    const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    // Only parse as stream-json when resuming a Claude session (first message uses plain text)
    const isClaudeJsonChat = effectiveConfig.engine === "claude-code"
      && !!existingClaudeSession?.threadId;

    return streamSSE(c, async (stream) => {
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let aborted = false;
      let codexThreadId = existingCodexSession?.threadId;
      let claudeSessionId = existingClaudeSession?.threadId;
      const codexJsonState = isCodexJsonChat ? createCodexJsonStreamState() : null;
      const claudeJsonState = isClaudeJsonChat ? createClaudeJsonStreamState() : null;

      try {
        // Send an immediate status event so the connection is never idle
        // (prevents proxy/browser timeouts during the agent's thinking phase)
        await stream.writeSSE({ data: JSON.stringify({ type: "status", status: "thinking" }), event: "message" });

        const { proc: spawnedProc, resolvedCommand } = spawnWithFallback(command, args, {
          stdout: "pipe",
          stderr: "pipe",
          cwd: spawnCwd,
          env: cleanEnv,
          runAsUser,
        });
        proc = spawnedProc;
        if (resolvedCommand !== command) {
          logger.info("chat", `Resolved chat command '${command}' -> '${resolvedCommand}'`);
        }

        // Send periodic heartbeats to keep the connection alive while the
        // agent is thinking (before first output). Stops once data flows.
        let gotFirstChunk = false;
        heartbeatTimer = setInterval(async () => {
          if (gotFirstChunk || aborted) return;
          try {
            await stream.writeSSE({ data: JSON.stringify({ type: "status", status: "thinking" }), event: "message" });
          } catch {
            // Stream already closed
          }
        }, 5000);

        // Kill process on timeout
        timeoutTimer = setTimeout(() => {
          if (proc) {
            logger.warn("chat", `Chat process timed out after ${CHAT_TIMEOUT_MS}ms, killing`);
            try { proc.kill(); } catch {}
          }
        }, CHAT_TIMEOUT_MS);

        // Kill process if client disconnects
        stream.onAbort(() => {
          aborted = true;
          clearTimeout(timeoutTimer);
          clearInterval(heartbeatTimer);
          if (proc) {
            logger.info("chat", "Client disconnected, killing chat process");
            try { proc.kill(); } catch {}
          }
        });

        // Read stdout and stderr concurrently to avoid pipe buffer deadlocks
        let bytesStreamed = 0;
        let stderrText = "";

        const stdoutPromise = (async () => {
          const stdout = proc!.stdout;
          if (!stdout || typeof stdout === "number") return;
          const reader = stdout.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (text) {
                gotFirstChunk = true;
                bytesStreamed += value.byteLength;
                if (isCodexJsonChat && codexJsonState) {
                  const parsed = consumeCodexJsonChunk(codexJsonState, text);
                  if (parsed.threadId) {
                    codexThreadId = parsed.threadId;
                  }
                  for (const chunk of parsed.textChunks) {
                    if (!chunk) continue;
                    await stream.writeSSE({ data: JSON.stringify({ type: "text", content: chunk }), event: "message" });
                  }
                } else if (isClaudeJsonChat && claudeJsonState) {
                  const parsed = consumeClaudeJsonChunk(claudeJsonState, text);
                  if (parsed.sessionId) {
                    claudeSessionId = parsed.sessionId;
                  }
                  for (const chunk of parsed.textChunks) {
                    if (!chunk) continue;
                    await stream.writeSSE({ data: JSON.stringify({ type: "text", content: chunk }), event: "message" });
                  }
                } else {
                  await stream.writeSSE({ data: JSON.stringify({ type: "text", content: text }), event: "message" });
                }
              }
            }
            if (isCodexJsonChat && codexJsonState) {
              const parsed = flushCodexJsonChunk(codexJsonState);
              if (parsed.threadId) {
                codexThreadId = parsed.threadId;
              }
              for (const chunk of parsed.textChunks) {
                if (!chunk) continue;
                await stream.writeSSE({ data: JSON.stringify({ type: "text", content: chunk }), event: "message" });
              }
            }
            if (isClaudeJsonChat && claudeJsonState) {
              const parsed = flushClaudeJsonChunk(claudeJsonState);
              if (parsed.sessionId) {
                claudeSessionId = parsed.sessionId;
              }
              for (const chunk of parsed.textChunks) {
                if (!chunk) continue;
                await stream.writeSSE({ data: JSON.stringify({ type: "text", content: chunk }), event: "message" });
              }
            }
          } catch {
            // Stream closed (e.g. client disconnect)
          }
        })();

        const stderrPromise = (async () => {
          const stderr = proc!.stderr;
          if (!stderr || typeof stderr === "number") return;
          const reader = stderr.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              stderrText += decoder.decode(value, { stream: true });
            }
          } catch {
            // Stream closed
          }
        })();

        await Promise.all([stdoutPromise, stderrPromise]);
        clearInterval(heartbeatTimer);

        const exitCode = await proc.exited;
        clearTimeout(timeoutTimer);

        // Structured debug logging
        logger.info("chat", `Chat process done: exit=${exitCode}, bytes=${bytesStreamed}, aborted=${aborted}, stderr=${stderrText.length > 0 ? stderrText.slice(0, 500) : "(none)"}`);

        if (codexSessionKey) {
          if (exitCode === 0 && codexThreadId) {
            deps.chatSessions.set(codexSessionKey, codexThreadId);
          } else {
            deps.chatSessions.delete(codexSessionKey);
          }
        }

        if (claudeSessionKey) {
          if (exitCode === 0 && claudeSessionId) {
            deps.chatSessions.set(claudeSessionKey, claudeSessionId);
            logger.info("chat", `Stored Claude session: ${claudeSessionId.slice(0, 12)}...`);
          } else if (exitCode !== 0) {
            deps.chatSessions.delete(claudeSessionKey);
          }
        }

        if (exitCode !== 0 && stderrText) {
          logger.warn("chat", `Chat process failed (exit ${exitCode}): ${stderrText.slice(0, 500)}`);
        }

        await stream.writeSSE({ data: JSON.stringify({ type: "done", exitCode }), event: "message" });
      } catch (err: any) {
        clearTimeout(timeoutTimer);
        clearInterval(heartbeatTimer);
        if (codexSessionKey) {
          deps.chatSessions.delete(codexSessionKey);
        }
        if (claudeSessionKey) {
          deps.chatSessions.delete(claudeSessionKey);
        }
        logger.error("chat", `Chat error: ${err?.message ?? err}`);
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: "error", message: err?.message ?? String(err) }),
            event: "message",
          });
        } catch (writeErr) {
          logger.error("chat", `Failed to write error SSE: ${writeErr}`);
        }
      }
    });
    } catch (err: any) {
      logger.error("chat", `Chat handler error: ${err?.message ?? err}`);
      return errorResponse(c, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  return app;
}
