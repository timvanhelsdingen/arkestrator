import type { AgentManagerConfig } from "../config";

async function request(config: AgentManagerConfig, path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const res = await fetch(`${config.serverUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed?.error || parsed?.message || `${res.status}: ${text}`);
      } catch {
        throw new Error(`${res.status}: ${text}`);
      }
    }
    throw new Error(`${res.status}: ${res.statusText}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type WorkerInfo = {
  id: string;
  name: string;
  knownPrograms?: string[];
  status?: "online" | "offline";
  activeBridgeCount?: number;
};

type BridgeInfo = {
  id: string;
  program?: string;
  workerName?: string;
  projectPath?: string;
  connectedAt?: string;
};

function normalizeWorkers(payload: any): WorkerInfo[] {
  if (Array.isArray(payload)) return payload as WorkerInfo[];
  if (payload && Array.isArray(payload.workers)) return payload.workers as WorkerInfo[];
  return [];
}

function normalizeBridges(payload: any): BridgeInfo[] {
  if (Array.isArray(payload)) return payload as BridgeInfo[];
  if (payload && Array.isArray(payload.bridges)) return payload.bridges as BridgeInfo[];
  return [];
}

export function createRestClient(config: AgentManagerConfig) {
  return {
    health: () => request(config, "/health"),

    jobs: {
      create: (data: any) =>
        request(config, "/api/jobs", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      list: (status?: string[]) =>
        request(config, `/api/jobs${status ? `?status=${status.join(",")}` : ""}`),
      get: (id: string) => request(config, `/api/jobs/${id}`),
      cancel: (id: string) =>
        request(config, `/api/jobs/${id}/cancel`, { method: "POST" }),
    },

    agents: {
      list: () => request(config, "/api/agent-configs"),
    },

    workers: {
      list: async () => normalizeWorkers(await request(config, "/api/workers")),
    },

    bridges: {
      list: async () => normalizeBridges(await request(config, "/api/bridge-command/bridges")),
    },
  };
}
