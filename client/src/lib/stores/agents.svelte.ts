import type { AgentConfig } from "@arkestrator/protocol";

class AgentsState {
  all = $state<AgentConfig[]>([]);
}

export const agents = new AgentsState();
