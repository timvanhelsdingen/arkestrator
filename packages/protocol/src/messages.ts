import { z } from "zod";
import { JobSubmit, Job } from "./jobs.js";
import {
  JobIntervention,
  JobInterventionCreate,
  JobInterventionSupport,
} from "./interventions.js";
import { AgentConfig, AgentConfigCreate } from "./agents.js";
import { ContextItem, EditorContext, FileChange, JobPriority } from "./common.js";
import { CommandResult, WorkspaceMode, Project } from "./projects.js";
import { Worker, BridgeInfo } from "./workers.js";

// --- Base message wrapper ---

const makeMessage = <T extends string, P extends z.ZodTypeAny>(
  type: T,
  payload: P,
) =>
  z.object({
    type: z.literal(type),
    id: z.string().uuid().describe("Message ID for request/response correlation"),
    payload,
  });

// --- Bridge -> Server ---

export const JobSubmitMessage = makeMessage("job_submit", JobSubmit);
export type JobSubmitMessage = z.infer<typeof JobSubmitMessage>;

// --- Server -> Bridge ---

export const JobAcceptedMessage = makeMessage(
  "job_accepted",
  z.object({ jobId: z.string().uuid() }),
);
export type JobAcceptedMessage = z.infer<typeof JobAcceptedMessage>;

export const JobStartedMessage = makeMessage(
  "job_started",
  z.object({ jobId: z.string().uuid() }),
);
export type JobStartedMessage = z.infer<typeof JobStartedMessage>;

export const JobLogMessage = makeMessage(
  "job_log",
  z.object({
    jobId: z.string().uuid(),
    text: z.string(),
  }),
);
export type JobLogMessage = z.infer<typeof JobLogMessage>;

export const JobCompleteMessage = makeMessage(
  "job_complete",
  z.object({
    jobId: z.string().uuid(),
    success: z.boolean(),
    files: z.array(FileChange).default([]),
    commands: z.array(CommandResult).default([]),
    workspaceMode: WorkspaceMode.optional(),
    error: z.string().optional(),
  }),
);
export type JobCompleteMessage = z.infer<typeof JobCompleteMessage>;

// --- Client <-> Server ---

export const JobListMessage = makeMessage(
  "job_list",
  z.object({
    status: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
);
export type JobListMessage = z.infer<typeof JobListMessage>;

export const JobListResponseMessage = makeMessage(
  "job_list_response",
  z.object({
    jobs: z.array(Job),
    total: z.number().int().nonnegative().optional(),
  }),
);
export type JobListResponseMessage = z.infer<typeof JobListResponseMessage>;

export const JobUpdatedMessage = makeMessage(
  "job_updated",
  z.object({
    job: Job,
  }),
);
export type JobUpdatedMessage = z.infer<typeof JobUpdatedMessage>;

export const JobCancelMessage = makeMessage(
  "job_cancel",
  z.object({ jobId: z.string().uuid() }),
);
export type JobCancelMessage = z.infer<typeof JobCancelMessage>;

export const JobReprioritizeMessage = makeMessage(
  "job_reprioritize",
  z.object({
    jobId: z.string().uuid(),
    priority: JobPriority,
  }),
);
export type JobReprioritizeMessage = z.infer<typeof JobReprioritizeMessage>;

export const JobInterventionListMessage = makeMessage(
  "job_intervention_list",
  z.object({ jobId: z.string().uuid() }),
);
export type JobInterventionListMessage = z.infer<typeof JobInterventionListMessage>;

export const JobInterventionListResponseMessage = makeMessage(
  "job_intervention_list_response",
  z.object({
    jobId: z.string().uuid(),
    interventions: z.array(JobIntervention),
    support: JobInterventionSupport,
  }),
);
export type JobInterventionListResponseMessage = z.infer<typeof JobInterventionListResponseMessage>;

export const JobInterventionSubmitMessage = makeMessage(
  "job_intervention_submit",
  z.object({
    jobId: z.string().uuid(),
    intervention: JobInterventionCreate,
  }),
);
export type JobInterventionSubmitMessage = z.infer<typeof JobInterventionSubmitMessage>;

export const JobInterventionUpdatedMessage = makeMessage(
  "job_intervention_updated",
  z.object({
    jobId: z.string().uuid(),
    intervention: JobIntervention,
    support: JobInterventionSupport.optional(),
  }),
);
export type JobInterventionUpdatedMessage = z.infer<typeof JobInterventionUpdatedMessage>;

export const AgentConfigListMessage = makeMessage(
  "agent_config_list",
  z.object({}),
);
export type AgentConfigListMessage = z.infer<typeof AgentConfigListMessage>;

export const AgentConfigListResponseMessage = makeMessage(
  "agent_config_list_response",
  z.object({ configs: z.array(AgentConfig) }),
);
export type AgentConfigListResponseMessage = z.infer<
  typeof AgentConfigListResponseMessage
>;

export const AgentConfigCreateMessage = makeMessage(
  "agent_config_create",
  AgentConfigCreate,
);
export type AgentConfigCreateMessage = z.infer<
  typeof AgentConfigCreateMessage
>;

export const AgentConfigUpdateMessage = makeMessage(
  "agent_config_update",
  AgentConfig,
);
export type AgentConfigUpdateMessage = z.infer<
  typeof AgentConfigUpdateMessage
>;

export const AgentConfigDeleteMessage = makeMessage(
  "agent_config_delete",
  z.object({ id: z.string().uuid() }),
);
export type AgentConfigDeleteMessage = z.infer<
  typeof AgentConfigDeleteMessage
>;

export const BridgeStatusMessage = makeMessage(
  "bridge_status",
  z.object({
    bridges: z.array(BridgeInfo),
  }),
);
export type BridgeStatusMessage = z.infer<typeof BridgeStatusMessage>;

export const WorkerStatusMessage = makeMessage(
  "worker_status",
  z.object({
    workers: z.array(Worker),
  }),
);
export type WorkerStatusMessage = z.infer<typeof WorkerStatusMessage>;

// --- Projects ---

export const ProjectListMessage = makeMessage(
  "project_list",
  z.object({}),
);
export type ProjectListMessage = z.infer<typeof ProjectListMessage>;

export const ProjectListResponseMessage = makeMessage(
  "project_list_response",
  z.object({ projects: z.array(Project) }),
);
export type ProjectListResponseMessage = z.infer<
  typeof ProjectListResponseMessage
>;

// --- Cross-Bridge Commands ---

export const BridgeCommandSendMessage = makeMessage(
  "bridge_command_send",
  z.object({
    /** Target bridge by program name ("blender", "godot") or specific bridge connection ID */
    target: z.string(),
    /** How to interpret target: "program" matches by program name, "id" matches exact bridge ID */
    targetType: z.enum(["program", "id"]).default("program"),
    /** Commands to execute on the target bridge */
    commands: z.array(CommandResult),
    /** Optional correlation ID so the sender can match responses */
    correlationId: z.string().optional(),
    /** Optional project path being operated on by this command request */
    projectPath: z.string().optional(),
  }),
);
export type BridgeCommandSendMessage = z.infer<typeof BridgeCommandSendMessage>;

export const BridgeCommandMessage = makeMessage(
  "bridge_command",
  z.object({
    /** Who sent the command (connection ID, for routing result back) */
    senderId: z.string(),
    /** Commands to execute */
    commands: z.array(CommandResult),
    /** Correlation ID passed through from sender */
    correlationId: z.string().optional(),
    /** Optional project path being operated on */
    projectPath: z.string().optional(),
  }),
);
export type BridgeCommandMessage = z.infer<typeof BridgeCommandMessage>;

export const BridgeCommandResultMessage = makeMessage(
  "bridge_command_result",
  z.object({
    /** The bridge that executed the commands */
    bridgeId: z.string().optional(),
    /** Program name of the executing bridge */
    program: z.string().optional(),
    /** Correlation ID passed through */
    correlationId: z.string().optional(),
    /** Overall success */
    success: z.boolean(),
    /** Execution counts */
    executed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** Error messages */
    errors: z.array(z.string()).default([]),
    /** Optional artifact metadata (e.g. ComfyUI outputs). */
    outputs: z.array(
      z.object({
        nodeId: z.string().optional(),
        kind: z.enum(["image", "video", "gif", "audio", "file"]).optional(),
        filename: z.string(),
        subfolder: z.string().optional(),
        type: z.string().optional(),
        mimeType: z.string().optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        base64: z.string().optional(),
      }),
    ).optional(),
    /** Original sender ID (for server routing) */
    senderId: z.string().optional(),
  }),
);
export type BridgeCommandResultMessage = z.infer<typeof BridgeCommandResultMessage>;

const WorkerHeadlessProgramConfig = z.object({
  executable: z.string(),
  argsTemplate: z.array(z.string()),
  language: z.string(),
});

const WorkerHeadlessExecution = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("commands"),
    config: WorkerHeadlessProgramConfig,
    commands: z.array(CommandResult),
  }),
  z.object({
    mode: z.literal("raw_args"),
    executable: z.string(),
    args: z.array(z.string()),
  }),
]);

export const WorkerHeadlessCommandMessage = makeMessage(
  "worker_headless_command",
  z.object({
    /** Who requested the execution (for correlation/routing). */
    senderId: z.string(),
    /** Correlation ID resolved by the server when the client reports back. */
    correlationId: z.string(),
    /** Target program being executed locally on the worker. */
    program: z.string(),
    /** Optional project path / cwd for local execution. */
    projectPath: z.string().optional(),
    /** Maximum runtime before the client kills the process. */
    timeoutMs: z.number().int().positive().optional(),
    /** Execution payload: templated bridge commands or raw args probe. */
    execution: WorkerHeadlessExecution,
  }),
);
export type WorkerHeadlessCommandMessage = z.infer<typeof WorkerHeadlessCommandMessage>;

export const WorkerHeadlessResultMessage = makeMessage(
  "worker_headless_result",
  z.object({
    correlationId: z.string(),
    program: z.string(),
    success: z.boolean(),
    executed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.array(z.string()).default([]),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    headless: z.boolean().default(true),
    senderId: z.string().optional(),
  }),
);
export type WorkerHeadlessResultMessage = z.infer<typeof WorkerHeadlessResultMessage>;

// --- Bridge Context (bridge -> server -> client) ---

/** Bridge pushes a single context item (user right-clicked "Add to Agent Context") */
export const BridgeContextItemAddMessage = makeMessage(
  "bridge_context_item_add",
  z.object({
    /** Set by server when relaying to clients */
    bridgeId: z.string().optional(),
    /** Set by server when relaying to clients */
    bridgeName: z.string().optional(),
    /** Set by server when relaying to clients (godot/blender/etc) */
    program: z.string().optional(),
    /** The context item being added */
    item: ContextItem,
  }),
);
export type BridgeContextItemAddMessage = z.infer<typeof BridgeContextItemAddMessage>;

/** Bridge clears its entire context bag */
export const BridgeContextClearMessage = makeMessage(
  "bridge_context_clear",
  z.object({
    /** Set by server when relaying to clients */
    bridgeId: z.string().optional(),
    /** Set by server when relaying to clients */
    program: z.string().optional(),
  }),
);
export type BridgeContextClearMessage = z.infer<typeof BridgeContextClearMessage>;

/** Bridge pushes its current editor context snapshot */
export const BridgeEditorContextMessage = makeMessage(
  "bridge_editor_context",
  z.object({
    /** Set by server when relaying to clients */
    bridgeId: z.string().optional(),
    /** Set by server when relaying to clients */
    bridgeName: z.string().optional(),
    /** Set by server when relaying to clients */
    program: z.string().optional(),
    /** The editor context snapshot */
    editorContext: EditorContext,
    /** File attachments (open/selected scripts) */
    files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
  }),
);
export type BridgeEditorContextMessage = z.infer<typeof BridgeEditorContextMessage>;

/** Server sends full context state to a newly-connected client */
export const BridgeContextSyncMessage = makeMessage(
  "bridge_context_sync",
  z.object({
    bridges: z.array(z.object({
      bridgeId: z.string(),
      bridgeName: z.string(),
      program: z.string(),
      items: z.array(ContextItem),
      editorContext: EditorContext.optional(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
    })),
  }),
);
export type BridgeContextSyncMessage = z.infer<typeof BridgeContextSyncMessage>;

// --- Dependencies ---

export const JobDependencyBlockedMessage = makeMessage(
  "job_dependency_blocked",
  z.object({
    jobId: z.string().uuid(),
    blockedByJobId: z.string().uuid(),
    reason: z.string(),
  }),
);
export type JobDependencyBlockedMessage = z.infer<typeof JobDependencyBlockedMessage>;

// --- Client-Side Local LLM Execution ---
// These messages enable client-side execution of local-oss jobs.
// The server dispatches jobs to clients that have local Ollama; the client
// runs the agentic loop locally and proxies tool calls (bridge commands,
// sub-jobs, etc.) through the server.

/** Server dispatches a local-oss job to a client for execution. */
export const ClientJobDispatchMessage = makeMessage(
  "client_job_dispatch",
  z.object({
    jobId: z.string().uuid(),
    job: Job,
    agentConfig: AgentConfig,
    /** Pre-built base prompt including coordination scripts and context. */
    basePrompt: z.string(),
    /** Resolved model name to use (e.g. "llama3.2:latest"). */
    model: z.string(),
    maxTurns: z.number().int().positive(),
    turnTimeoutMs: z.number().int().positive(),
    /** Per-model system prompt override, if any. */
    systemPrompt: z.string().optional(),
  }),
);
export type ClientJobDispatchMessage = z.infer<typeof ClientJobDispatchMessage>;

/** Client requests tool execution on the server (bridge commands, sub-jobs, etc.). */
export const ClientToolRequestMessage = makeMessage(
  "client_tool_request",
  z.object({
    jobId: z.string().uuid(),
    correlationId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
);
export type ClientToolRequestMessage = z.infer<typeof ClientToolRequestMessage>;

/** Server returns tool execution result to the client. */
export const ClientToolResultMessage = makeMessage(
  "client_tool_result",
  z.object({
    jobId: z.string().uuid(),
    correlationId: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
);
export type ClientToolResultMessage = z.infer<typeof ClientToolResultMessage>;

/** Client streams a log line back to the server for real-time display. */
export const ClientJobLogMessage = makeMessage(
  "client_job_log",
  z.object({
    jobId: z.string().uuid(),
    text: z.string(),
  }),
);
export type ClientJobLogMessage = z.infer<typeof ClientJobLogMessage>;

/** Client reports job completion (success or failure). */
export const ClientJobCompleteMessage = makeMessage(
  "client_job_complete",
  z.object({
    jobId: z.string().uuid(),
    success: z.boolean(),
    error: z.string().optional(),
    commands: z.array(CommandResult).default([]),
    durationMs: z.number().int().nonnegative(),
  }),
);
export type ClientJobCompleteMessage = z.infer<typeof ClientJobCompleteMessage>;

/** Server tells the client to cancel a running client-dispatched job. */
export const ClientJobCancelMessage = makeMessage(
  "client_job_cancel",
  z.object({
    jobId: z.string().uuid(),
  }),
);
export type ClientJobCancelMessage = z.infer<typeof ClientJobCancelMessage>;

// --- Error ---

export const ErrorMessage = makeMessage(
  "error",
  z.object({
    code: z.string(),
    message: z.string(),
    replyTo: z.string().uuid().optional(),
  }),
);
export type ErrorMessage = z.infer<typeof ErrorMessage>;

// --- Union of all messages ---

export const Message = z.discriminatedUnion("type", [
  JobSubmitMessage,
  JobAcceptedMessage,
  JobStartedMessage,
  JobLogMessage,
  JobCompleteMessage,
  JobListMessage,
  JobListResponseMessage,
  JobUpdatedMessage,
  JobCancelMessage,
  JobReprioritizeMessage,
  JobInterventionListMessage,
  JobInterventionListResponseMessage,
  JobInterventionSubmitMessage,
  JobInterventionUpdatedMessage,
  AgentConfigListMessage,
  AgentConfigListResponseMessage,
  AgentConfigCreateMessage,
  AgentConfigUpdateMessage,
  AgentConfigDeleteMessage,
  BridgeStatusMessage,
  WorkerStatusMessage,
  ProjectListMessage,
  ProjectListResponseMessage,
  BridgeCommandSendMessage,
  BridgeCommandMessage,
  BridgeCommandResultMessage,
  WorkerHeadlessCommandMessage,
  WorkerHeadlessResultMessage,
  BridgeContextItemAddMessage,
  BridgeContextClearMessage,
  BridgeEditorContextMessage,
  BridgeContextSyncMessage,
  JobDependencyBlockedMessage,
  ClientJobDispatchMessage,
  ClientToolRequestMessage,
  ClientToolResultMessage,
  ClientJobLogMessage,
  ClientJobCompleteMessage,
  ClientJobCancelMessage,
  ErrorMessage,
]);
export type Message = z.infer<typeof Message>;
