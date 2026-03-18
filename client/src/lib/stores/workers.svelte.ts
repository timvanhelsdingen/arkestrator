import type { Worker } from "@arkestrator/protocol";

interface BridgeInfo {
  id: string;
  machineId?: string;
  name: string;
  type: string;
  connected: boolean;
  lastSeen?: string;
  program?: string;
  programVersion?: string;
  bridgeVersion?: string;
  projectPath?: string;
  activeProjects?: string[];
  workerName?: string;
  ip?: string;
  connectedAt?: string;
  osUser?: string;
}

class WorkersState {
  workers = $state<Worker[]>([]);
  bridges = $state<BridgeInfo[]>([]);
}

export const workersStore = new WorkersState();
export type { BridgeInfo };
