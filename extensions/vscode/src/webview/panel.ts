import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getConfig } from "../config";
import { streamChat } from "../api/sse";
import { createRestClient } from "../api/rest";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;

    this.panel.webview.html = this.getWebviewContent(extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );
  }

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.Beside;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "arkestratorChat",
      "Arkestrator Chat",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
  }

  private async handleMessage(msg: any) {
    switch (msg.type) {
      case "chat": {
        const config = getConfig();
        if (!config.apiKey) {
          this.panel.webview.postMessage({
            type: "error",
            text: "Not connected. Configure arkestrator settings (legacy agentManager works) or log in via Tauri client.",
          });
          return;
        }

        const rest = createRestClient(config);
        let agentConfigId: string;
        try {
          const configs = await rest.agents.list();
          agentConfigId = configs[0]?.id;
          if (!agentConfigId) throw new Error("No agent configs");
        } catch (e: any) {
          this.panel.webview.postMessage({
            type: "error",
            text: `Error: ${e.message}`,
          });
          return;
        }

        this.panel.webview.postMessage({ type: "start" });

        try {
          await streamChat(
            config,
            {
              prompt: msg.prompt,
              agentConfigId,
              history: msg.history,
            },
            (chunk) => {
              this.panel.webview.postMessage({ type: "chunk", text: chunk });
            },
          );
          this.panel.webview.postMessage({ type: "done" });
        } catch (e: any) {
          this.panel.webview.postMessage({
            type: "error",
            text: e.message,
          });
        }
        break;
      }

      case "getStatus": {
        const config = getConfig();
        const rest = createRestClient(config);
        try {
          const [health, workers] = await Promise.all([
            rest.health(),
            rest.workers.list(),
          ]);
          this.panel.webview.postMessage({
            type: "status",
            connected: true,
            version: health.version,
            workerCount: workers.length,
          });
        } catch {
          this.panel.webview.postMessage({
            type: "status",
            connected: false,
          });
        }
        break;
      }
    }
  }

  private getWebviewContent(extensionUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, "src", "webview", "index.html");
    try {
      return fs.readFileSync(htmlPath, "utf-8");
    } catch {
      return `<!DOCTYPE html>
<html><body><p>Error: Could not load webview HTML</p></body></html>`;
    }
  }

  private dispose() {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
