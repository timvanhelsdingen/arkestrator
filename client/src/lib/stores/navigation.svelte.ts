export type Page = "chat" | "jobs" | "admin" | "workers" | "projects" | "skills" | "coordinator-scripts" | "training" | "settings";

class NavigationState {
  current = $state<Page>("chat");
}

export const nav = new NavigationState();
