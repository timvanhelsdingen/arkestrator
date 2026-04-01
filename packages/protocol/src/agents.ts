import { z } from "zod";
import { AgentEngine } from "./common.js";

export const AgentConfig = z.object({
  id: z.string().uuid(),
  name: z.string(),
  engine: AgentEngine,
  command: z.string(),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Optional fallback config used by AUTO routing when this config should escalate. */
  fallbackConfigId: z.string().uuid().optional(),
  maxTurns: z.number().int().positive().default(300),
  systemPrompt: z.string().optional(),
  /**
   * Per-model system prompt overrides.  Map of model name → custom prompt text.
   * @deprecated Use `modelOverrides` instead. The server merges this into
   * `modelOverrides` at read time, so consumers only need to check `modelOverrides`.
   * Will be removed in a future major version.
   */
  modelSystemPrompts: z.record(z.string(), z.string()).optional(),
  /**
   * Structured per-model overrides.  Map of model name → override settings.
   * Allows overriding system prompt, max turns, etc. per model.
   */
  modelOverrides: z.record(z.string(), z.object({
    systemPrompt: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
  })).optional(),
  priority: z.number().int().min(0).max(100).default(50),
  /**
   * Per-turn timeout in milliseconds for local-oss agentic loop.
   * Controls how long the server waits for the LLM to respond per turn.
   * Larger models (14B-32B) on consumer GPUs need higher values (180-600s).
   * Defaults to 180s when unset. Only meaningful for `engine === "local-oss"`.
   */
  turnTimeoutMs: z.number().int().min(30_000).max(1_200_000).optional(),
  /**
   * Reasoning mode for local-oss agentic loop.
   * - `"disabled"` — no thinking, tool calls only (fastest, least capable)
   * - `"plan-act"` — think before each tool call (good balance)
   * - `"plan-act-evaluate"` — think before AND after each tool call (best quality, 3x slower)
   * Defaults to `"plan-act"` when unset. Only meaningful for `engine === "local-oss"`.
   */
  reasoningMode: z.enum(["disabled", "plan-act", "plan-act-evaluate"]).optional(),
  /**
   * Where local-oss (Ollama) models are hosted.
   * - `"server"` — use Ollama on the server machine itself
   * - `"client"` — auto-distribute to any online worker with localLlmEnabled
   * Defaults to `"client"` when unset.  Only meaningful for `engine === "local-oss"`.
   */
  localModelHost: z.enum(["server", "client"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const AgentConfigCreate = AgentConfig.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type AgentConfigCreate = z.infer<typeof AgentConfigCreate>;
