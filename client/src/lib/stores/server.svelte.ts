import { Command, type Child } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "error";

const LOCAL_SERVER_SETTINGS_KEY = "arkestrator-local-server-settings";
export const DEFAULT_LOCAL_SERVER_PORT = 7800;

function loadSavedPort(): number {
  try {
    const raw = localStorage.getItem(LOCAL_SERVER_SETTINGS_KEY);
    if (!raw) return DEFAULT_LOCAL_SERVER_PORT;
    const parsed = JSON.parse(raw);
    return normalizeLocalServerPort(parsed?.port);
  } catch {
    return DEFAULT_LOCAL_SERVER_PORT;
  }
}

function savePort(port: number) {
  localStorage.setItem(
    LOCAL_SERVER_SETTINGS_KEY,
    JSON.stringify({ port: normalizeLocalServerPort(port) }),
  );
}

export function normalizeLocalServerPort(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_LOCAL_SERVER_PORT;
  }
  return parsed;
}

export function parseLocalServerPortInput(
  value: string,
): { ok: true; port: number } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "Port is required." };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Port must be a whole number." };
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > 65535) {
    return { ok: false, error: "Port must be between 1 and 65535." };
  }
  return { ok: true, port: parsed };
}

export function buildLocalServerUrl(port: number): string {
  return `http://localhost:${normalizeLocalServerPort(port)}`;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

class ServerState {
  status = $state<ServerStatus>("stopped");
  logs = $state<string[]>([]);
  error = $state("");
  message = $state("");
  pid = $state<number | null>(null);
  dataDir = $state("");
  port = $state(loadSavedPort());

  private child: Child | null = null;
  private maxLogLines = 500;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbeInFlight = false;
  private isExternalLocalServer = false;
  private restartRequested = false;

  constructor() {
    this.startLocalServerMonitor();
  }

  get isRunning() {
    return this.status === "running";
  }

  get bootstrapCredentialsPath() {
    if (!this.dataDir) return "";
    const normalized = this.dataDir.replace(/[\\\/]+$/, "");
    const sep = normalized.includes("\\") ? "\\" : "/";
    return `${normalized}${sep}data${sep}db${sep}bootstrap-admin.txt`;
  }

  get canStart() {
    return this.status === "stopped" || this.status === "error";
  }

  get canStop() {
    return (this.status === "running" || this.status === "starting") &&
      (!!this.child || this.isExternalLocalServer);
  }

  get localUrl() {
    return buildLocalServerUrl(this.port);
  }

  async ensureDataDir() {
    if (this.dataDir) return this.dataDir;
    const base = await invoke<string>("ensure_app_data_dir");
    this.dataDir = base;
    return base;
  }

  setPort(nextPort: number) {
    const normalized = normalizeLocalServerPort(nextPort);
    this.port = normalized;
    savePort(normalized);
    void this.refreshLocalServerStatus();
  }

  async applyPort(nextPort: number): Promise<{
    restarted: boolean;
    manualRestartRequired: boolean;
    message: string;
  }> {
    const previousPort = this.port;
    const normalized = normalizeLocalServerPort(nextPort);
    this.error = "";
    this.message = "";
    this.setPort(normalized);

    if (normalized === previousPort) {
      const message = `Local server port remains ${normalized}.`;
      this.message = message;
      return { restarted: false, manualRestartRequired: false, message };
    }

    if (this.child && (this.status === "running" || this.status === "starting")) {
      const message = `Restarting local server on ${this.localUrl}...`;
      this.message = message;
      this.restartRequested = true;
      await this.stop();
      return { restarted: true, manualRestartRequired: false, message };
    }

    if (this.isExternalLocalServer && this.status === "running") {
      const message =
        `Saved local port ${normalized}. The current server was not started by this app, so stop it manually and start again on ${this.localUrl}.`;
      this.status = "stopped";
      this.isExternalLocalServer = false;
      this.message = message;
      return { restarted: false, manualRestartRequired: true, message };
    }

    const message = `Saved local port ${normalized}.`;
    this.message = message;
    return { restarted: false, manualRestartRequired: false, message };
  }

  async start() {
    if (!this.canStart) return;

    this.status = "starting";
    this.error = "";
    this.message = "";
    this.logs = [];

    try {
      // In dev, reuse an already running local server instead of spawning a duplicate.
      if (await this.isLocalServerAlreadyRunning()) {
        this.status = "running";
        this.pid = null;
        this.error = "";
        this.isExternalLocalServer = true;
        this.appendLog(`Using existing local server on ${this.localUrl}`);
        return;
      }

      const command = import.meta.env.DEV
        ? this.createDevCommand()
        : await this.createSidecarCommand();

      command.stdout.on("data", (line) => {
        this.appendLog(line);
        // Only mark as running when server is actually listening for connections
        if (this.status === "starting" && line.includes("Server listening")) {
          this.status = "running";
          // Parse the actual port from the log line in case the server fell back
          // to a different port (e.g. ghost socket on the configured port)
          const portMatch = line.match(/localhost:(\d+)/);
          if (portMatch) {
            const actualPort = parseInt(portMatch[1], 10);
            if (actualPort !== this.port) {
              this.appendLog(`⚠ Port ${this.port} was unavailable — server started on ${actualPort}`);
              this.port = actualPort;
              savePort(actualPort);
            }
          }
        }
        // Also catch fallback port messages from the server
        if (line.includes("Using fallback port")) {
          const match = line.match(/fallback port (\d+)/);
          if (match) {
            const fallbackPort = parseInt(match[1], 10);
            this.appendLog(`⚠ Port ${this.port} was unavailable — using fallback port ${fallbackPort}`);
            this.port = fallbackPort;
            savePort(fallbackPort);
          }
        }
      });

      command.stderr.on("data", (line) => {
        this.appendLog(`[stderr] ${line}`);
      });

      command.on("close", (data) => {
        const shouldRestart = this.restartRequested;
        this.restartRequested = false;
        this.child = null;
        this.pid = null;
        this.isExternalLocalServer = false;
        if (shouldRestart) {
          this.status = "stopped";
          this.appendLog(`Restarting local server on ${this.localUrl}`);
          void this.start();
          return;
        }
        if (this.status === "stopping") {
          this.status = "stopped";
          this.appendLog("Server stopped.");
        } else if (data.code !== 0) {
          this.status = "error";
          this.error = `Server exited with code ${data.code}`;
          this.appendLog(`Server exited with code ${data.code}`);
        } else {
          this.status = "stopped";
          this.appendLog("Server exited.");
        }
      });

      command.on("error", (err) => {
        this.status = "error";
        this.error = err;
        this.appendLog(`Error: ${err}`);
        this.child = null;
        this.pid = null;
      });

      this.child = await command.spawn();
      this.pid = this.child.pid;
      this.isExternalLocalServer = false;
      this.appendLog(`Server process started (PID: ${this.child.pid})`);
    } catch (err) {
      this.status = "error";
      const msg = String(err);
      if (import.meta.env.DEV && msg.includes("program not found")) {
        this.error = "Bun not found. Install from https://bun.sh";
      } else if (!import.meta.env.DEV && msg.includes("program not found")) {
        this.error = "Server binary not found. Run 'pnpm build:sidecar' to compile the Arkestrator sidecar.";
      } else {
        this.error = `Failed to start server: ${err}`;
      }
      this.appendLog(this.error);
    }
  }

  /** Dev mode: run server source via Bun */
  private createDevCommand() {
    return Command.create("bun", ["src/index.ts"], {
      cwd: __DEV_SERVER_DIR__,
      env: { PORT: String(this.port) },
    });
  }

  /** Production mode: run compiled sidecar binary */
  private async createSidecarCommand() {
    const dataPath = await this.ensureDataDir();
    const adminDistPath = await invoke<string>("resolve_admin_dist_path");
    const env: Record<string, string> = { PORT: String(this.port) };
    if (adminDistPath) {
      env.ARKESTRATOR_ADMIN_DIST = adminDistPath;
    }
    return Command.sidecar("binaries/arkestrator-server", [], {
      cwd: dataPath,
      env,
    });
  }

  async stop() {
    if (!this.canStop) return;

    this.status = "stopping";
    this.message = "";
    try {
      if (this.child) {
        await this.child.kill();
      } else if (this.isExternalLocalServer) {
        // Stop an external local server via its shutdown endpoint
        const res = await fetch(`${this.localUrl}/api/server/shutdown`, {
          method: "POST",
        });
        if (!res.ok) {
          throw new Error(`Shutdown request failed: ${res.status}`);
        }
        this.status = "stopped";
        this.isExternalLocalServer = false;
        this.appendLog("Local server stopped via shutdown request");
      }
    } catch (err) {
      this.status = "error";
      this.error = `Failed to stop server: ${err}`;
    }
  }

  clearLogs() {
    this.logs = [];
  }

  private appendLog(text: string) {
    this.logs = [...this.logs, text].slice(-this.maxLogLines);
  }

  private startLocalServerMonitor() {
    if (this.monitorTimer) return;
    // Detect localhost server state even when it was started outside the client.
    void this.refreshLocalServerStatus();
    this.monitorTimer = setInterval(() => {
      void this.refreshLocalServerStatus();
    }, 3000);
  }

  private async refreshLocalServerStatus() {
    if (this.healthProbeInFlight) return;
    if (this.child) return;
    if (this.status === "starting" || this.status === "stopping") return;

    this.healthProbeInFlight = true;
    try {
      const running = await this.isLocalServerAlreadyRunning();
      if (running) {
        if (this.status !== "running") {
          this.status = "running";
          this.error = "";
          this.appendLog(`Detected local server on ${this.localUrl}`);
        }
        this.isExternalLocalServer = true;
        return;
      }

      if (this.status === "running" && this.isExternalLocalServer) {
        this.status = "stopped";
        this.appendLog(`Local server on ${this.localUrl} is no longer reachable`);
      }
      this.isExternalLocalServer = false;
    } finally {
      this.healthProbeInFlight = false;
    }
  }

  private async isLocalServerAlreadyRunning(): Promise<boolean> {
    // First try the configured port
    if (await this.probeHealth(this.localUrl)) return true;

    // If configured port doesn't respond, check shared config for a fallback port
    try {
      const sharedConfig = await invoke<{ serverUrl?: string }>("read_shared_config");
      const sharedUrl = sharedConfig?.serverUrl;
      if (sharedUrl && sharedUrl !== this.localUrl && isLoopbackUrl(sharedUrl)) {
        if (await this.probeHealth(sharedUrl)) {
          // Server is running on a different port — update our state
          const portMatch = sharedUrl.match(/:(\d+)/);
          if (portMatch) {
            const discoveredPort = parseInt(portMatch[1], 10);
            if (discoveredPort !== this.port) {
              this.appendLog(`Discovered server on port ${discoveredPort} (configured: ${this.port})`);
              this.port = discoveredPort;
              savePort(discoveredPort);
            }
          }
          return true;
        }
      }
    } catch {
      // read_shared_config not available or failed — ignore
    }
    return false;
  }

  private async probeHealth(baseUrl: string): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctrl = new AbortController();
      timeout = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const serverState = new ServerState();
