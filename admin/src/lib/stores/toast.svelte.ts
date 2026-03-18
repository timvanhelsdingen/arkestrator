interface ToastMessage {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}

let nextId = 0;

class ToastStore {
  messages = $state<ToastMessage[]>([]);

  show(type: ToastMessage["type"], message: string, durationMs = 4000) {
    const id = nextId++;
    this.messages = [...this.messages, { id, type, message }];
    setTimeout(() => {
      this.messages = this.messages.filter((m) => m.id !== id);
    }, durationMs);
  }

  success(message: string) {
    this.show("success", message);
  }

  error(message: string) {
    this.show("error", message, 6000);
  }

  info(message: string) {
    this.show("info", message);
  }
}

export const toast = new ToastStore();
