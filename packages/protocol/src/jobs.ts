import { z } from "zod";
import {
  JobStatus,
  JobPriority,
  CoordinationMode,
  EditorContext,
  FileAttachment,
  FileChange,
  ContextItem,
} from "./common.js";
import { WorkspaceMode, CommandResult } from "./projects.js";
export const AgentConfigTarget = z.union([z.string().uuid(), z.literal("auto")]);
export type AgentConfigTarget = z.infer<typeof AgentConfigTarget>;

export const JobRoutingReason = z.enum(["local", "cloud"]);
export type JobRoutingReason = z.infer<typeof JobRoutingReason>;

export const RuntimeReasoningLevel = z.enum(["low", "medium", "high", "xhigh"]);
export type RuntimeReasoningLevel = z.infer<typeof RuntimeReasoningLevel>;

export const RuntimeVerificationMode = z.enum(["required", "optional", "disabled"]);
export type RuntimeVerificationMode = z.infer<typeof RuntimeVerificationMode>;

export const BridgeExecutionMode = z.enum(["live", "headless"]);
export type BridgeExecutionMode = z.infer<typeof BridgeExecutionMode>;

export const JobOutcomeRating = z.enum(["positive", "average", "negative"]);
export type JobOutcomeRating = z.infer<typeof JobOutcomeRating>;

export const CoordinationScriptMode = z.enum(["enabled", "disabled", "auto"]);
export type CoordinationScriptMode = z.infer<typeof CoordinationScriptMode>;

export const CoordinationScripts = z.object({
  /** Playbook matching and project guidance. */
  coordinator: CoordinationScriptMode.default("enabled"),
  /** Per-program coordinator scripts (godot.md, blender.md, etc.). */
  bridge: CoordinationScriptMode.default("enabled"),
  /** Auto-generated training blocks within coordinator scripts. */
  training: CoordinationScriptMode.default("enabled"),
});
export type CoordinationScripts = z.infer<typeof CoordinationScripts>;

export const JobRuntimeOptions = z.object({
  /** Optional per-run model override (engine-specific model name). */
  model: z.string().optional(),
  /** Optional reasoning effort override (currently used by Codex). */
  reasoningLevel: RuntimeReasoningLevel.optional(),
  /** Optional verification policy override for coordinator workflows. */
  verificationMode: RuntimeVerificationMode.optional(),
  /** Optional verification rigor weight (0-100). */
  verificationWeight: z.number().min(0).max(100).optional(),
  /** Optional bridge execution preference: live GUI bridge or separate headless/CLI process. */
  bridgeExecutionMode: BridgeExecutionMode.optional(),
  /** Granular control over which coordination scripts are included. All enabled by default. */
  coordinationScripts: CoordinationScripts.optional(),
  /** Enable skills mode: injects matched skills into agent prompts. */
  skillsMode: z.boolean().optional(),
});
export type JobRuntimeOptions = z.infer<typeof JobRuntimeOptions>;

export const Job = z.object({
  id: z.string().uuid(),
  status: JobStatus,
  priority: JobPriority,
  /** Optional short display name for the job */
  name: z.string().optional(),
  prompt: z.string(),
  editorContext: EditorContext.optional(),
  files: z.array(FileAttachment).default([]),
  /** User-curated context items (nodes, scripts, assets) referenced via @N in prompt */
  contextItems: z.array(ContextItem).default([]),
  /** Where orchestration decisions were made */
  coordinationMode: CoordinationMode.default("server"),
  agentConfigId: z.string().uuid(),
  /** Requested agent target from client (uuid or "auto"). */
  requestedAgentConfigId: AgentConfigTarget.optional(),
  /** Resolved/actual agent config selected by server routing. */
  actualAgentConfigId: z.string().uuid().optional(),
  /** Effective model used for execution after runtime overrides. */
  actualModel: z.string().optional(),
  /** High-level routing surface: local runtime or cloud/runtime CLI. */
  routingReason: JobRoutingReason.optional(),
  /** ID of the bridge that submitted the job */
  bridgeId: z.string().optional(),
  /** Program that submitted the job (e.g. "godot", "blender") */
  bridgeProgram: z.string().optional(),
  /** Name of the machine/worker that submitted the job */
  workerName: z.string().optional(),
  /** Target worker for this job (set from client submission) */
  targetWorkerName: z.string().optional(),
  /** File changes produced by the agent */
  result: z.array(FileChange).optional(),
  /** Command/script results from command mode */
  commands: z.array(CommandResult).optional(),
  /** Which workspace mode was used */
  workspaceMode: WorkspaceMode.optional(),
  /** Log output from the agent process */
  logs: z.string().optional(),
  /** Error message if the job failed */
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** Token usage stats from the agent run */
  tokenUsage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  /** IDs of jobs this job depends on */
  dependsOn: z.array(z.string().uuid()).optional(),
  /** Per-run runtime overrides (model, reasoning, etc.). */
  runtimeOptions: JobRuntimeOptions.optional(),
  /** Explicit project ID (if user selected one) */
  projectId: z.string().uuid().optional(),
  /** User ID who submitted the job */
  submittedBy: z.string().uuid().optional(),
  /** Username of the user who submitted the job */
  submittedByUsername: z.string().optional(),
  /** ID of the orchestrator/parent job that spawned this sub-job via MCP */
  parentJobId: z.string().uuid().optional(),
  /** Bridge programs used by this job (e.g. ["godot", "blender"]) — populated at submit and updated as execute_command calls are made */
  usedBridges: z.array(z.string()).default([]),
  /** Timestamp when the job was archived (soft-archive). */
  archivedAt: z.string().datetime().optional(),
  /** Timestamp when the job was soft-deleted (trashed). */
  deletedAt: z.string().datetime().optional(),
  /** User feedback on job quality, used for coordinator learning bias. */
  outcomeRating: JobOutcomeRating.optional(),
  /** Optional notes describing what worked/failed. */
  outcomeNotes: z.string().optional(),
  /** Timestamp of the latest outcome mark/update. */
  outcomeMarkedAt: z.string().datetime().optional(),
  /** User ID that marked outcome (if marked from a user session). */
  outcomeMarkedBy: z.string().uuid().optional(),
});
export type Job = z.infer<typeof Job>;

export const JobSubmit = z.object({
  /** Optional short display name for the job */
  name: z.string().optional(),
  prompt: z.string(),
  editorContext: EditorContext.optional(),
  files: z.array(FileAttachment).default([]),
  /** User-curated context items (nodes, scripts, assets) referenced via @N in prompt */
  contextItems: z.array(ContextItem).default([]),
  /** Where orchestration decisions should be made */
  coordinationMode: CoordinationMode.default("server"),
  agentConfigId: AgentConfigTarget,
  priority: JobPriority.default("normal"),
  /** Preferred workspace mode (optional, server may override) */
  preferredMode: WorkspaceMode.optional(),
  /** IDs of jobs this job depends on */
  dependsOn: z.array(z.string().uuid()).optional(),
  /** Per-run runtime overrides (model, reasoning, etc.). */
  runtimeOptions: JobRuntimeOptions.optional(),
  /** Target worker name — job will use this worker's project context */
  targetWorkerName: z.string().optional(),
  /** If true, job is created with 'paused' status instead of 'queued' */
  startPaused: z.boolean().optional(),
  /** Explicit project ID to use for workspace resolution */
  projectId: z.string().uuid().optional(),
  /**
   * Explicit target bridge program when no live editor context is available
   * (for example offline/headless bridge selections from client UI).
   */
  bridgeProgram: z.string().optional(),
});
export type JobSubmit = z.infer<typeof JobSubmit>;
