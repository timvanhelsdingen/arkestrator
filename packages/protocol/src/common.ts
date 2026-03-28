import { z } from "zod";

// --- Enums ---

export const JobStatus = z.enum([
  "queued",
  "paused",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobPriority = z.enum(["low", "normal", "high", "critical"]);
export type JobPriority = z.infer<typeof JobPriority>;

export const CoordinationMode = z.enum(["server", "client"]);
export type CoordinationMode = z.infer<typeof CoordinationMode>;

export const AgentEngine = z.enum([
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "local-oss",
]);
export type AgentEngine = z.infer<typeof AgentEngine>;

// --- File Changes ---

export const FileChange = z.object({
  path: z.string(),
  content: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  /** Base64-encoded binary content (for textures, models, .blend/.hip files) */
  binaryContent: z.string().optional(),
  /** Content encoding — "utf8" (default) or "base64" for binary files */
  encoding: z.enum(["utf8", "base64"]).optional(),
});
export type FileChange = z.infer<typeof FileChange>;

// --- Editor Context ---

export const EditorContext = z.object({
  /** Currently open file path */
  activeFile: z.string().optional(),
  /** Selected text in the editor */
  selection: z.string().optional(),
  /** Cursor position */
  cursorLine: z.number().optional(),
  /** Project root path */
  projectRoot: z.string(),
  /** Additional metadata from the DCC app */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type EditorContext = z.infer<typeof EditorContext>;

// --- Context Item ---

export const ContextItemType = z.enum([
  "node",
  "script",
  "asset",
  "resource",
  "scene",
]);
export type ContextItemType = z.infer<typeof ContextItemType>;

export const ContextItem = z.object({
  /** Auto-assigned index (1-based), used for @N references in prompt */
  index: z.number().int().positive(),
  /** Item type */
  type: ContextItemType,
  /** Display name (e.g. "Player", "player.gd") */
  name: z.string(),
  /** Path within the project (e.g. "root/Player", "res://scripts/player.gd") */
  path: z.string(),
  /** Full file content for scripts/text files */
  content: z.string().optional(),
  /** Type-specific metadata (node class, asset dimensions, etc.) */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

// --- File Attachment ---

export const FileAttachment = z.object({
  path: z.string(),
  content: z.string(),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

// --- API Error Response ---

export const ApiErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
