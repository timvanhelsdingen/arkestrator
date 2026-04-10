import type { ApiBridgesRepo } from "../db/api-bridges.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { getWorkerRule, type WorkerRule } from "../security/worker-rules.js";

/**
 * Stable sentinel id + display name for the virtual worker that represents
 * the Arkestrator server itself (host of REST/MCP API bridges like Meshy,
 * Stability, etc.). A fixed UUID is used so the Worker schema validates on
 * both REST responses and WebSocket broadcasts.
 */
export const SERVER_WORKER_ID = "00000000-0000-4000-8000-000000000001";
export const SERVER_WORKER_NAME = "Arkestrator Server";

export interface ServerWorkerEntry {
  id: string;
  name: string;
  status: "online";
  activeBridgeCount: number;
  knownPrograms: string[];
  workerModeEnabled: boolean;
  isServerWorker: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  rule?: WorkerRule;
}

export interface ServerApiBridgeEntry {
  id: string;
  name: string;
  type: "bridge";
  connected: boolean;
  lastSeen: string;
  program: string;
  bridgeVersion: string;
  workerName: string;
  connectedAt?: string;
  activeProjects: string[];
}

export interface ServerWorkerAndBridges {
  worker: ServerWorkerEntry | null;
  bridges: ServerApiBridgeEntry[];
}

/**
 * Build the synthetic "Arkestrator Server" worker and its associated
 * api-bridge entries from the configured API bridges. Used by both the REST
 * `/api/workers` endpoint and the WebSocket broadcast path so they return a
 * consistent shape (the WS path previously omitted these, causing the server
 * worker to flicker in and out of the client UI whenever any unrelated bridge
 * event triggered `broadcastBridgeStatus`).
 *
 * API bridges whose `name` matches an existing virtual bridge program (e.g.
 * ComfyUI) are excluded so they surface under the machine worker that hosts
 * them instead of the virtual server worker.
 */
export function buildServerWorkerAndBridges(params: {
  apiBridgesRepo?: ApiBridgesRepo;
  settingsRepo?: SettingsRepo;
  virtualBridgePrograms: Set<string>;
}): ServerWorkerAndBridges {
  const { apiBridgesRepo, settingsRepo, virtualBridgePrograms } = params;
  if (!apiBridgesRepo) return { worker: null, bridges: [] };

  const enabled = apiBridgesRepo.listEnabled();
  const serverOnly = enabled.filter(
    (ab) => !virtualBridgePrograms.has(ab.name.toLowerCase()),
  );
  if (serverOnly.length === 0) return { worker: null, bridges: [] };

  const now = new Date().toISOString();
  const worker: ServerWorkerEntry = {
    id: SERVER_WORKER_ID,
    name: SERVER_WORKER_NAME,
    status: "online",
    activeBridgeCount: serverOnly.length,
    knownPrograms: serverOnly.map((b) => b.displayName),
    workerModeEnabled: true,
    isServerWorker: true,
    firstSeenAt: now,
    lastSeenAt: now,
    rule: settingsRepo ? getWorkerRule(settingsRepo, SERVER_WORKER_NAME) : undefined,
  };

  const bridges: ServerApiBridgeEntry[] = serverOnly.map((ab) => {
    const hasKey = !!apiBridgesRepo.getApiKey(ab.id);
    const connected = ab.enabled && hasKey;
    return {
      id: `api-bridge:${ab.name}`,
      name: ab.displayName,
      type: "bridge",
      connected,
      lastSeen: ab.updatedAt,
      program: ab.displayName,
      bridgeVersion: "api-bridge",
      workerName: SERVER_WORKER_NAME,
      connectedAt: connected ? ab.updatedAt : undefined,
      activeProjects: [],
    };
  });

  return { worker, bridges };
}
