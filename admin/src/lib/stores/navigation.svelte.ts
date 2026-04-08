export type Page =
  | "users"
  | "api-keys"
  | "agents"
  | "machines"
  | "bridges"
  | "api-bridges"
  | "policies"
  | "knowledge"
  | "templates"
  | "audit-log"
  | "system";

class NavigationState {
  current = $state<Page>("users");
}

export const nav = new NavigationState();
