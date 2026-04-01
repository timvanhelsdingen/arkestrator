export function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return "";
  const diff = now - then;
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Show a Tauri save-file dialog and write content to the chosen path.
 * Returns the saved path, or null if the user cancelled.
 */
export async function saveFileWithDialog(
  defaultName: string,
  content: Blob | Uint8Array | string,
  filters?: Array<{ name: string; extensions: string[] }>,
  title?: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { invoke } = await import("@tauri-apps/api/core");

  const ext = defaultName.split(".").pop() ?? "";
  const savePath = await save({
    defaultPath: defaultName,
    filters: filters ?? [{ name: ext.toUpperCase() + " file", extensions: [ext] }],
    title: title ?? "Save File",
  });
  if (!savePath) return null;

  let base64: string;
  if (typeof content === "string") {
    // Text content — write directly
    await invoke("fs_write_file", { path: savePath, content });
    return savePath;
  } else if (content instanceof Blob) {
    const buf = await content.arrayBuffer();
    base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  } else {
    base64 = btoa(String.fromCharCode(...content));
  }
  await invoke("fs_write_file", { path: savePath, content: base64, encoding: "base64" });
  return savePath;
}
