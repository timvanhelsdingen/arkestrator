import * as vscode from "vscode";
import { registerChatParticipant } from "./chat-participant";
import { ChatPanel } from "./webview/panel";
import { getConfig } from "./config";
import { createRestClient } from "./api/rest";

let statusBarItem: vscode.StatusBarItem;
const COMMANDS = {
  openChat: "arkestrator.openChat",
  submitJob: "arkestrator.submitJob",
  showStatus: "arkestrator.showStatus",
  configure: "arkestrator.configure",
} as const;
function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  handler: (...args: any[]) => any,
): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, handler));
}

export function activate(context: vscode.ExtensionContext) {
  // Register Chat Participant
  registerChatParticipant(context);

  // Register commands
  registerCommand(context, COMMANDS.openChat, () => {
    ChatPanel.createOrShow(context.extensionUri);
  });

  registerCommand(context, COMMANDS.submitJob, async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Enter job prompt",
        placeHolder: "e.g. Add a health bar to the player scene",
      });
      if (!prompt) return;

      const config = getConfig();
      if (!config.apiKey) {
        vscode.window.showErrorMessage("Arkestrator: Not configured. Set serverUrl and apiKey in settings.");
        return;
      }

      const rest = createRestClient(config);
      try {
        const configs = await rest.agents.list();
        if (!configs || configs.length === 0) {
          vscode.window.showErrorMessage("Arkestrator: No agent configs found.");
          return;
        }

        const job = await rest.jobs.create({
          prompt,
          agentConfigId: configs[0].id,
          priority: "normal",
          files: [],
          contextItems: [],
        });
        vscode.window.showInformationMessage(`Job submitted: ${job.id}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Arkestrator: ${e.message}`);
      }
    });

  registerCommand(context, COMMANDS.showStatus, async () => {
      const config = getConfig();
      const rest = createRestClient(config);

      // Check connection status
      let connected = false;
      let serverInfo = "";
      let workerCount = 0;
      let bridgeCount = 0;
      try {
        const [health, workers, bridges] = await Promise.all([
          rest.health(),
          rest.workers.list(),
          rest.bridges.list(),
        ]);
        connected = true;
        serverInfo = health.version ?? "connected";
        workerCount = workers?.length ?? 0;
        bridgeCount = bridges?.length ?? 0;
      } catch {}

      const statusIcon = connected ? "$(check)" : "$(error)";
      const statusLabel = connected ? `Connected (${serverInfo})` : "Disconnected";

      const items: vscode.QuickPickItem[] = [
        {
          label: `${statusIcon} ${statusLabel}`,
          description: connected ? `${workerCount} worker(s), ${bridgeCount} bridge(s)` : "Server unreachable",
          kind: vscode.QuickPickItemKind.Separator,
        },
        { label: "$(comment-discussion) Open Chat Panel", description: "Chat with AI via Arkestrator" },
        { label: "$(play) Submit Job", description: "Send a prompt to the job queue" },
        { label: "$(gear) Configure Connection", description: "Open Arkestrator settings" },
        { label: "$(refresh) Refresh Status", description: "Re-check server connection" },
      ];

      const pick = await vscode.window.showQuickPick(items, {
        title: "Arkestrator",
        placeHolder: "Select an action",
      });

      if (!pick) return;

      if (pick.label.includes("Open Chat Panel")) {
        vscode.commands.executeCommand(COMMANDS.openChat);
      } else if (pick.label.includes("Submit Job")) {
        vscode.commands.executeCommand(COMMANDS.submitJob);
      } else if (pick.label.includes("Configure Connection")) {
        vscode.commands.executeCommand(COMMANDS.configure);
      } else if (pick.label.includes("Refresh Status")) {
        await updateStatusBar();
        vscode.window.showInformationMessage(`Arkestrator: ${statusBarItem.tooltip}`);
      }
    });

  registerCommand(context, COMMANDS.configure, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "arkestrator",
      );
    });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = COMMANDS.showStatus;
  statusBarItem.text = "$(robot) Arkestrator";
  statusBarItem.tooltip = "Click to show Arkestrator status";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Check connection on activation
  updateStatusBar();
}

async function updateStatusBar() {
  const config = getConfig();
  if (!config.apiKey) {
    statusBarItem.text = "$(robot) Ark: Not configured";
    statusBarItem.tooltip = "Arkestrator: No API key configured";
    return;
  }

  const rest = createRestClient(config);
  try {
    const [health, workers] = await Promise.all([
      rest.health(),
      rest.workers.list(),
    ]);
    statusBarItem.text = `$(robot) Ark: Connected`;
    statusBarItem.tooltip = `Arkestrator: ${health.version ?? "connected"} (${workers.length} worker(s))`;
  } catch {
    statusBarItem.text = "$(robot) Ark: Disconnected";
    statusBarItem.tooltip = "Arkestrator: Cannot reach server or API key is invalid";
  }
}

export function deactivate() {}
