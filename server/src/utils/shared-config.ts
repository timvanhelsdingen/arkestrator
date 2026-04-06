import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir, hostname } from "os";

const CONFIG_DIR = ".arkestrator";
const CONFIG_FILE = "config.json";

export interface SharedConfig {
  serverUrl: string;
  wsUrl: string;
  apiKey: string;
  machineId?: string;
  workerName?: string;
}

/**
 * Resolve the server URL that spawned agent processes should use.
 *
 * Jobs spawned by the server run on the same host as the API, so loopback is
 * the most reliable target even when the shared client config points at an
 * externally-routable hostname or container name.
 */
export function resolveSpawnedAgentServerUrl(port: number, shared?: SharedConfig | null): string {
  const configured = String(shared?.serverUrl ?? "").trim();
  if (configured && isLocalhostUrl(configured)) {
    // The configured URL may point at the client relay port (e.g. 17800) rather
    // than the server's actual port. Always use the real server port so spawned
    // agents reach the API directly instead of going through the bridge relay.
    const configuredPort = extractPort(configured);
    if (configuredPort === port) {
      return configured;
    }
  }
  return `http://127.0.0.1:${port}`;
}

/** Get the primary shared config path (~/.arkestrator/config.json) */
export function getSharedConfigPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE);
}

/** Read the shared config file (returns null if not found or invalid) */
export function readSharedConfig(): SharedConfig | null {
  try {
    const raw = readFileSync(getSharedConfigPath(), "utf-8");
    return JSON.parse(raw) as SharedConfig;
  } catch {
    return null;
  }
}

/** Read the raw config JSON preserving all fields (including client-written ones like bridgeRelay) */
function readRawConfig(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(getSharedConfigPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeConfigFile(configPath: string, config: SharedConfig) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600 }, // Owner-only read/write for security
  );
}

/** Check if a URL points to localhost/127.0.0.1 */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return true;
  }
}

/** Extract the port from a URL string, returning null on failure. */
function extractPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    // Default ports when none is explicit
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return 443;
    return 80;
  } catch {
    return null;
  }
}

/**
 * Determine whether this server instance "owns" the existing shared config.
 *
 * Ownership means the config either:
 *   - does not exist (fresh install)
 *   - has a serverUrl whose port matches this server's port
 *
 * If another server is already configured (different port), this instance
 * must NOT overwrite the config or it will steal bridges from the primary.
 */
function isConfigOwnedByThisServer(existing: SharedConfig | null, port: number): boolean {
  if (!existing) return true; // no config yet — we own it
  const existingServer = (existing.serverUrl ?? "").trim();
  if (!existingServer) return true; // empty URL — treat as unclaimed
  const existingPort = extractPort(existingServer);
  if (existingPort === null) return true; // malformed URL — safe to overwrite
  return existingPort === port;
}

/** Write the shared config file so bridges can auto-discover the API key.
 *
 * Preserves existing non-localhost URLs from the config (typically written by
 * the client with the actual server address the user connected to). This
 * ensures bridges always match the hostname the client is logged in to,
 * even after server restarts.
 *
 * For fresh configs (or configs still pointing to localhost), uses
 * os.hostname() so remote bridges can discover the server without manual
 * configuration.
 *
 * **Multi-instance safety:** If the config already points at a different
 * server (different port), this function is a no-op so secondary/dev servers
 * don't steal bridges from the primary. Set `NO_SHARED_CONFIG=1` to disable
 * config writing entirely (useful for local dev servers).
 *
 * @returns `"written"` if the config was updated, `"skipped"` if it was left unchanged.
 */
export function writeSharedConfig(port: number, apiKey: string): "written" | "skipped" {
  // Allow completely disabling shared config writes via env var
  if (process.env.NO_SHARED_CONFIG === "1" || process.env.SKIP_SHARED_CONFIG === "1") {
    return "skipped";
  }

  const existing = readSharedConfig();

  // If another server instance owns the config, do not overwrite it
  if (!isConfigOwnedByThisServer(existing, port)) {
    return "skipped";
  }

  // Read the raw config to preserve client-written fields (e.g. bridgeRelay)
  // that aren't part of the server's SharedConfig interface.
  const rawExisting = readRawConfig() ?? {};

  // If the config already has a non-localhost URL (written by the client),
  // preserve it — the client knows the exact address used to reach the server.
  const existingWs = (existing?.wsUrl ?? "").trim();
  const existingServer = (existing?.serverUrl ?? "").trim();
  const hasClientUrl = existingWs && !isLocalhostUrl(existingWs);

  let serverUrl: string;
  let wsUrl: string;

  if (hasClientUrl) {
    serverUrl = existingServer;
    wsUrl = existingWs;
  } else {
    // Fresh config or still at localhost — use actual hostname so bridges
    // on other machines can discover the server via mDNS/DNS.
    const host = hostname() || "localhost";
    serverUrl = `http://${host}:${port}`;
    wsUrl = `ws://${host}:${port}/ws`;
  }

  const workerName = String(existing?.workerName ?? "").trim();
  const machineId = String(existing?.machineId ?? "").trim();
  const config: SharedConfig = {
    // Spread raw config first to preserve client-written fields (bridgeRelay, etc.)
    ...rawExisting,
    serverUrl,
    wsUrl,
    apiKey,
    ...(machineId ? { machineId } : {}),
    ...(workerName ? { workerName } : {}),
  } as SharedConfig;
  writeConfigFile(getSharedConfigPath(), config);
  return "written";
}
