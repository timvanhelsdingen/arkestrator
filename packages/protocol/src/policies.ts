import { z } from "zod";

export const PolicyScope = z.enum(["global", "user"]);
export type PolicyScope = z.infer<typeof PolicyScope>;

export const PolicyType = z.enum([
  "file_path",
  "tool",
  "prompt_filter",
  "engine_model",
  "command_filter",
]);
export type PolicyType = z.infer<typeof PolicyType>;

export const PolicyAction = z.enum(["block", "warn"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyCreate = z.object({
  scope: PolicyScope.default("global"),
  userId: z.string().uuid().optional(),
  type: PolicyType,
  pattern: z.string().min(1),
  action: PolicyAction.default("block"),
  description: z.string().optional(),
});
export type PolicyCreate = z.infer<typeof PolicyCreate>;

export const Policy = z.object({
  id: z.string().uuid(),
  scope: PolicyScope,
  userId: z.string().uuid().nullable(),
  type: PolicyType,
  pattern: z.string(),
  action: PolicyAction,
  description: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Policy = z.infer<typeof Policy>;
