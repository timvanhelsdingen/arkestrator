import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ArkestratorConfig {
  serverUrl: string;
  apiKey: string;
}

/** Read shared config (~/.arkestrator/config.json). */
function readSharedConfig(): { serverUrl?: string; wsUrl?: string; apiKey?: string } | null {
  const configPaths = [path.join(os.homedir(), ".arkestrator", "config.json")];
  for (const configPath of configPaths) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      // Try next path
    }
  }
  return null;
}

/** Get the effective config, merging VSCode settings with auto-discovered config */
export function getConfig(): ArkestratorConfig {
  const primary = vscode.workspace.getConfiguration("arkestrator");
  const shared = readSharedConfig();

  // VSCode settings override auto-discovered config.
  let serverUrl = primary.get<string>("serverUrl") || "";
  let apiKey = primary.get<string>("apiKey") || "";

  if (!serverUrl && shared?.serverUrl) {
    serverUrl = shared.serverUrl;
  } else if (!serverUrl && shared?.wsUrl) {
    // Convert ws://host:port/ws to http://host:port
    serverUrl = shared.wsUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/ws$/, "");
  }
  if (!apiKey && shared?.apiKey) {
    apiKey = shared.apiKey;
  }

  // Default fallback
  if (!serverUrl) {
    serverUrl = "http://localhost:7800";
  }

  return { serverUrl, apiKey };
}

