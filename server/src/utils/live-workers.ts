import type { WorkersRepo } from "../db/workers.repo.js";

type LivePresence = {
  machineId?: string | null;
  workerName?: string | null;
  program?: string | null;
  projectPath?: string | null;
  ip?: string | null;
  programVersion?: string | null;
  bridgeVersion?: string | null;
};

function clean(value?: string | null): string {
  return String(value ?? "").trim();
}

/**
 * Recreate worker rows when live bridges/clients exist but the persisted worker
 * record was deleted manually. This keeps Workers UI and bridge inventory
 * coherent without requiring a reconnect.
 */
export function ensureLiveWorkersPersisted(
  workersRepo: WorkersRepo,
  bridges: LivePresence[],
  clients: LivePresence[],
): void {
  for (const bridge of bridges) {
    const workerName = clean(bridge.workerName).toLowerCase();
    const machineId = clean(bridge.machineId).toLowerCase() || undefined;
    if (!workerName && !machineId) continue;
    if (!(machineId ? workersRepo.getByMachineId(machineId) : workersRepo.getByName(workerName))) {
      workersRepo.upsert(
        workerName || `machine-${machineId}`,
        clean(bridge.program) || undefined,
        clean(bridge.projectPath) || undefined,
        clean(bridge.ip) || undefined,
        machineId,
      );
    }
    const program = clean(bridge.program);
    if (program && workerName) {
      workersRepo.upsertBridge(
        workerName,
        program,
        clean(bridge.programVersion) || undefined,
        clean(bridge.bridgeVersion) || undefined,
        clean(bridge.projectPath) || undefined,
        machineId,
      );
    }
  }

  for (const client of clients) {
    const workerName = clean(client.workerName).toLowerCase();
    const machineId = clean(client.machineId).toLowerCase() || undefined;
    if (!workerName && !machineId) continue;
    if (!(machineId ? workersRepo.getByMachineId(machineId) : workersRepo.getByName(workerName))) {
      workersRepo.upsert(
        workerName || `machine-${machineId}`,
        undefined,
        undefined,
        clean(client.ip) || undefined,
        machineId,
      );
    }
  }
}
