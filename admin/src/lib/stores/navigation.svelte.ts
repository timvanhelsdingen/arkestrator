export type Page =
  | "users"
  | "api-keys"
  | "agents"
  | "machines"
  | "bridges"
  | "policies"
  | "knowledge"
  | "audit-log"
  | "system";

class NavigationState {
  current = $state<Page>("users");
}

export const nav = new NavigationState();
