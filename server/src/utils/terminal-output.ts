/**
 * Strip terminal control sequences from streamed subprocess output so persisted
 * logs stay readable in UI and DB.
 */
const ANSI_ESCAPE_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export function sanitizeTerminalChunk(text: string): string {
  if (!text) return "";
  // Remove ANSI/OSC control sequences and carriage-return rewrites.
  return text
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r/g, "");
}

