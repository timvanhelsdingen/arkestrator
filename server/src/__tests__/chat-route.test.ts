import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createChatRoutes } from "../routes/chat.js";
import { CodexChatSessionManager } from "../chat/codex-sessions.js";
import { loadConfig } from "../config.js";
import { WebSocketHub } from "../ws/hub.js";
import { createTestAgentConfig, createTestDb, createTestSession, createTestUser, type TestContext } from "./setup.js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestDb();
});

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function makeChatApp() {
  const app = new Hono();
  app.route("/api/chat", createChatRoutes({
    agentsRepo: ctx.agentsRepo,
    usersRepo: ctx.usersRepo,
    apiKeysRepo: ctx.apiKeysRepo,
    settingsRepo: ctx.settingsRepo,
    workersRepo: ctx.workersRepo,
    hub: new WebSocketHub(),
    config: loadConfig(),
    chatSessions: new CodexChatSessionManager(),
  }));
  return app;
}

describe("chat route local-oss placeholder handling", () => {
  it("returns INVALID_JSON for malformed chat payloads", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "chat-json-user",
      password: "chat-json-pass",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const app = makeChatApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_JSON",
      error: "Invalid JSON body",
    });
  });

  it("returns VALIDATION_ERROR for malformed chat fields", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "chat-schema-user",
      password: "chat-schema-pass",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const app = makeChatApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "   ",
        agentConfigId: 42,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      error: "Validation failed",
    });
  });

  it("resolves {{MODEL}} placeholder before spawning local chat command", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "chat-local-user",
      password: "chat-local-pass",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const agent = createTestAgentConfig(ctx.agentsRepo, {
      name: "Local Echo",
      engine: "local-oss",
      command: "bun",
      args: ["-e", "process.stdout.write(process.argv.slice(1).join('::'))", "{{MODEL}}"],
      model: "llama3.2:latest",
    });

    const app = makeChatApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        ...authHeader(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "hello local model",
        agentConfigId: agent.id,
      }),
    });

    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain("llama3.2:latest::hello local model");
    expect(sse).not.toContain("{{MODEL}}");
  });

  it.skipIf(process.platform === "win32")("reuses persisted Codex chat sessions per conversation key", async () => {
    const user = await createTestUser(ctx.usersRepo, {
      username: "chat-codex-user",
      password: "chat-codex-pass",
    });
    const session = createTestSession(ctx.usersRepo, user.id);

    const tmpDir = mkdtempSync(join(tmpdir(), "arkestrator-chat-codex-test-"));
    const logPath = join(tmpDir, "argv.log");
    const fakeCodexPath = join(tmpDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "exec" ] && [ "\${2:-}" = "resume" ]; then
  thread_id="$3"
else
  thread_id="thread-test-123"
fi
printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"\${thread_id}\\"}"
printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_0\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"chat reply\\"}}"
printf '%s\\n' "{\\"type\\":\\"turn.completed\\",\\"usage\\":{\\"input_tokens\\":1,\\"cached_input_tokens\\":0,\\"output_tokens\\":1}}"
`,
    );
    chmodSync(fakeCodexPath, 0o755);

    try {
      const agent = createTestAgentConfig(ctx.agentsRepo, {
        name: "Fake Codex",
        engine: "codex",
        command: fakeCodexPath,
        model: "gpt-5.4",
      });

      const app = makeChatApp();

      const first = await app.request("/api/chat", {
        method: "POST",
        headers: {
          ...authHeader(session.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: "hello once",
          agentConfigId: agent.id,
          conversationKey: "conv-a",
        }),
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("chat reply");

      const second = await app.request("/api/chat", {
        method: "POST",
        headers: {
          ...authHeader(session.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: "hello twice",
          agentConfigId: agent.id,
          conversationKey: "conv-a",
        }),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("chat reply");

      const argvLog = readFileSync(logPath, "utf8");
      expect(argvLog).toContain("exec --model gpt-5.4 --full-auto --skip-git-repo-check --json");
      expect(argvLog).toContain("exec resume thread-test-123 --model gpt-5.4 --full-auto --skip-git-repo-check --json");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
