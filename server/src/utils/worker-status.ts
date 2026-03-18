import type { Worker } from "@arkestrator/protocol";

export interface WorkerPresenceBridge {
  machineId?: string | null;
  workerName?: string | null;
}

export interface WorkerPresenceClient {
  machineId?: string | null;
  workerName?: string | null;
  workerMode?: boolean;
}

function normalizeWorkerKey(machineId?: string | null, workerName?: string | null): string {
  const machine = String(machineId ?? "").trim().toLowerCase();
  if (machine) return `machine:${machine}`;
  const worker = String(workerName ?? "").trim().toLowerCase();
  return worker ? `name:${worker}` : "";
}

/**
 * Worker online status represents machine presence, not only bridge presence:
 * - online when at least one bridge is connected for that worker
 * - online when at least one client socket is connected for that worker machine
 *   by explicit workerName match
 */
export function enrichWorkersWithLivePresence(
  workers: Worker[],
  bridges: WorkerPresenceBridge[],
  clients: WorkerPresenceClient[],
): Worker[] {
  const bridgeCounts = new Map<string, number>();
  for (const bridge of bridges) {
    const key = normalizeWorkerKey(bridge.machineId, bridge.workerName);
    if (!key) continue;
    bridgeCounts.set(key, (bridgeCounts.get(key) ?? 0) + 1);
  }

  const clientWorkerKeys = new Set<string>();
  const workerModeDisabled = new Set<string>();
  for (const client of clients) {
    const workerKey = normalizeWorkerKey(client.machineId, client.workerName);
    if (workerKey) {
      clientWorkerKeys.add(workerKey);
      if (client.workerMode === false) workerModeDisabled.add(workerKey);
    }
  }

  return workers.map((worker) => {
    const workerKey = normalizeWorkerKey(worker.machineId, worker.name);
    const activeBridgeCount = bridgeCounts.get(workerKey) ?? 0;
    const hasClientPresence = clientWorkerKeys.has(workerKey);
    const isWorkerModeOff = workerModeDisabled.has(workerKey);

    return {
      ...worker,
      status: (activeBridgeCount > 0 || hasClientPresence) && !isWorkerModeOff ? "online" : "offline",
      activeBridgeCount,
      workerModeEnabled: !isWorkerModeOff,
    };
  });
}
