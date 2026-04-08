import { z } from "zod";

// --- API Bridge Types ---

export const ApiBridgeType = z.enum(["preset", "custom"]);
export type ApiBridgeType = z.infer<typeof ApiBridgeType>;

export const ApiBridgeAuthType = z.enum(["bearer", "header", "query", "none"]);
export type ApiBridgeAuthType = z.infer<typeof ApiBridgeAuthType>;

// --- Endpoint Definition (for custom bridges) ---

export const ApiBridgeEndpointMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
export type ApiBridgeEndpointMethod = z.infer<typeof ApiBridgeEndpointMethod>;

export const ApiBridgeEndpoint = z.object({
  /** HTTP method */
  method: ApiBridgeEndpointMethod,
  /** URL path with {{variable}} placeholders (e.g. "/v2/tasks/{{taskId}}") */
  path: z.string(),
  /** Request body template with {{variable}} placeholders. Null for GET/DELETE. */
  bodyTemplate: z.record(z.string(), z.unknown()).optional(),
  /** Additional headers for this endpoint */
  headers: z.record(z.string(), z.string()).optional(),
});
export type ApiBridgeEndpoint = z.infer<typeof ApiBridgeEndpoint>;

// --- Polling Configuration (for async APIs) ---

export const ApiBridgePollConfig = z.object({
  /** Endpoint name (from endpoints map) to call for status checks */
  statusEndpoint: z.string(),
  /** JSON path to the status field in the response (dot notation, e.g. "status") */
  statusField: z.string().default("status"),
  /** Value(s) that indicate completion */
  completedValues: z.array(z.string()).default(["SUCCEEDED", "completed", "done"]),
  /** Value(s) that indicate failure */
  failedValues: z.array(z.string()).default(["FAILED", "failed", "error"]),
  /** Field containing the external task ID in the submit response */
  taskIdField: z.string().default("result"),
  /** Polling interval in milliseconds */
  intervalMs: z.number().int().positive().default(2000),
  /** Maximum polling time before timeout */
  maxTimeMs: z.number().int().positive().default(300_000),
});
export type ApiBridgePollConfig = z.infer<typeof ApiBridgePollConfig>;

// --- Action Definition ---

export const ApiBridgeActionParam = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string(),
  required: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  default: z.unknown().optional(),
});
export type ApiBridgeActionParam = z.infer<typeof ApiBridgeActionParam>;

export const ApiBridgeAction = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), ApiBridgeActionParam),
});
export type ApiBridgeAction = z.infer<typeof ApiBridgeAction>;

// --- Output File ---

export const ApiBridgeOutputFile = z.object({
  url: z.string().url(),
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type ApiBridgeOutputFile = z.infer<typeof ApiBridgeOutputFile>;

// --- Execution Result ---

export const ApiBridgeResult = z.object({
  bridgeName: z.string(),
  action: z.string(),
  success: z.boolean(),
  /** Raw response data from the API */
  data: z.unknown().optional(),
  /** Error message if failed */
  error: z.string().optional(),
  /** External task/job ID for async APIs */
  externalTaskId: z.string().optional(),
  /** Final status from the external API */
  externalStatus: z.string().optional(),
  /** Downloadable output files (models, textures, images, etc.) */
  outputFiles: z.array(ApiBridgeOutputFile).optional(),
});
export type ApiBridgeResult = z.infer<typeof ApiBridgeResult>;

// --- Bridge Configuration ---

export const ApiBridgeConfig = z.object({
  id: z.string().uuid(),
  /** Unique slug identifier (e.g. "meshy", "stability", "my-custom-api") */
  name: z.string().min(1).max(64).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  /** Human-readable display name */
  displayName: z.string().min(1).max(128),
  /** Whether this is a built-in preset or user-configured custom bridge */
  type: ApiBridgeType,
  /** Preset handler ID (e.g. "meshy") — only for type="preset" */
  presetId: z.string().optional(),
  /** Base URL for the API (e.g. "https://api.meshy.ai") */
  baseUrl: z.string().url(),
  /** Authentication method */
  authType: ApiBridgeAuthType.default("bearer"),
  /** Header name for auth (default: "Authorization") */
  authHeader: z.string().default("Authorization"),
  /** Prefix before the key value (default: "Bearer ") */
  authPrefix: z.string().default("Bearer "),
  /** Endpoint definitions (for custom bridges) */
  endpoints: z.record(z.string(), ApiBridgeEndpoint).default({}),
  /** Default options passed to every request */
  defaultOptions: z.record(z.string(), z.unknown()).default({}),
  /** Polling configuration for async APIs */
  pollConfig: ApiBridgePollConfig.optional(),
  /** Whether this bridge is active */
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ApiBridgeConfig = z.infer<typeof ApiBridgeConfig>;

export const ApiBridgeConfigCreate = ApiBridgeConfig.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ApiBridgeConfigCreate = z.infer<typeof ApiBridgeConfigCreate>;

export const ApiBridgeConfigUpdate = ApiBridgeConfigCreate.partial();
export type ApiBridgeConfigUpdate = z.infer<typeof ApiBridgeConfigUpdate>;

// --- Preset Info (returned by list presets endpoint) ---

export const ApiBridgePresetInfo = z.object({
  presetId: z.string(),
  displayName: z.string(),
  defaultBaseUrl: z.string(),
  actions: z.array(ApiBridgeAction),
});
export type ApiBridgePresetInfo = z.infer<typeof ApiBridgePresetInfo>;
