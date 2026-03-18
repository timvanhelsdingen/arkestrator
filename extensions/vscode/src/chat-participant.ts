import * as vscode from "vscode";
import { getConfig } from "./config";
import { createRestClient } from "./api/rest";
import { streamChat } from "./api/sse";

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant("arkestrator.chat", chatHandler);
  participant.iconPath = new vscode.ThemeIcon("robot");
  context.subscriptions.push(participant);
}

async function chatHandler(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const config = getConfig();

  if (!config.apiKey) {
    response.markdown(
      "**Not connected.** Configure `arkestrator.serverUrl` and `arkestrator.apiKey` in settings, or log in via the Tauri client to auto-discover.",
    );
    return;
  }

  const rest = createRestClient(config);

  // Handle slash commands
  if (request.command === "status") {
    await handleStatus(rest, response);
    return;
  }

  if (request.command === "job") {
    await handleJobSubmit(rest, request, response);
    return;
  }

  if (request.command === "bridge") {
    await handleBridgeCommand(rest, request, response);
    return;
  }

  // Default: stream chat
  await handleChat(config, request, response, token);
}

async function handleChat(
  config: ReturnType<typeof getConfig>,
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  const rest = createRestClient(config);

  // Find agent config
  let agentConfigId: string;
  try {
    const configs = await rest.agents.list();
    if (!configs || configs.length === 0) {
      response.markdown("**No agent configs found.** Create one in the admin panel.");
      return;
    }
    agentConfigId = configs[0].id;
  } catch (e: any) {
    response.markdown(`**Error loading agent configs:** ${e.message}`);
    return;
  }

  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());

  try {
    await streamChat(
      config,
      { prompt: request.prompt, agentConfigId },
      (chunk) => response.markdown(chunk),
      abortController.signal,
    );
  } catch (e: any) {
    if (e.name === "AbortError") return;
    response.markdown(`\n\n**Error:** ${e.message}`);
  }
}

async function handleStatus(
  rest: ReturnType<typeof createRestClient>,
  response: vscode.ChatResponseStream,
) {
  try {
    const [workers, bridges, health] = await Promise.all([
      rest.workers.list(),
      rest.bridges.list(),
      rest.health(),
    ]);

    response.markdown("### Arkestrator Status\n\n");

    response.markdown(`**Server:** ${health.version ?? "connected"}\n\n`);
    response.markdown(`**Connected bridges:** ${bridges.length}\n\n`);

    if (workers && workers.length > 0) {
      response.markdown("**Workers:**\n");
      for (const w of workers) {
        const programs = w.knownPrograms?.join(", ") || "none";
        const status = w.status ?? "unknown";
        const active = w.activeBridgeCount ?? 0;
        response.markdown(`- **${w.name}** (${status}, active bridges: ${active}) — programs: ${programs}\n`);
      }
    } else {
      response.markdown("**Workers:** none connected\n");
    }
  } catch (e: any) {
    response.markdown(`**Error:** ${e.message}`);
  }
}

async function handleJobSubmit(
  rest: ReturnType<typeof createRestClient>,
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
) {
  if (!request.prompt.trim()) {
    response.markdown("**Usage:** `/job <prompt>` — submits a job to the queue");
    return;
  }

  try {
    const configs = await rest.agents.list();
    if (!configs || configs.length === 0) {
      response.markdown("**No agent configs found.**");
      return;
    }

    const job = await rest.jobs.create({
      prompt: request.prompt,
      agentConfigId: configs[0].id,
      priority: "normal",
      files: [],
      contextItems: [],
    });

    response.markdown(`**Job submitted:** \`${job.id}\` (status: ${job.status})`);
  } catch (e: any) {
    response.markdown(`**Error submitting job:** ${e.message}`);
  }
}

async function handleBridgeCommand(
  rest: ReturnType<typeof createRestClient>,
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
) {
  if (!request.prompt.trim()) {
    response.markdown(
      "**Usage:** `/bridge <program> <script>` — e.g. `/bridge godot print('hello')`",
    );
    return;
  }

  const parts = request.prompt.trim().split(/\s+/);
  const program = parts[0];
  const script = parts.slice(1).join(" ");

  if (!script) {
    response.markdown("**Missing script.** Usage: `/bridge godot print('hello')`");
    return;
  }

  try {
    const language =
      program === "godot"
        ? "gdscript"
        : program === "unity"
          ? "unity_json"
          : "python";

    // Use bridge command API
    const res = await fetch(`${getConfig().serverUrl}/api/bridge-command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getConfig().apiKey}`,
      },
      body: JSON.stringify({
        target: program,
        targetType: "program",
        commands: [
          {
            language,
            script,
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    const result = await res.json();
    response.markdown(`**Bridge command sent** to \`${program}\`: ${JSON.stringify(result)}`);
  } catch (e: any) {
    response.markdown(`**Error:** ${e.message}`);
  }
}
