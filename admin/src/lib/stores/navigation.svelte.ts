export type Page =
  | "users"
  | "api-keys"
  | "agents"
  | "machines"
  | "policies"
  | "coordinator-training"
  | "audit-log";

class NavigationState {
  current = $state<Page>("users");
}

export const nav = new NavigationState();
