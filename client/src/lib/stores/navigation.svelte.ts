export type Page = "chat" | "jobs" | "admin" | "workers" | "projects" | "coordinator" | "settings";

class NavigationState {
  current = $state<Page>("chat");
}

export const nav = new NavigationState();
