# Module: Protocol (`packages/protocol/`)

## Purpose
Shared Zod schema definitions that serve as the single source of truth for all TypeScript types across server, client, and admin. Compiled to JS+DTS via `tsc`, consumed as `@arkestrator/protocol` workspace dependency.

## Files
| File | Purpose |
|------|---------|
| `common.ts` | Base enums + shared types: `JobStatus`, `JobPriority`, `CoordinationMode` (`server`/`client`), `AgentEngine`, `FileChange` (with optional `binaryContent` base64 + `encoding`), `EditorContext`, `FileAttachment`, `ContextItemType`, `ContextItem` |
| `agents.ts` | `AgentConfig` (full) and `AgentConfigCreate` (omits id/timestamps) schemas; includes optional `fallbackConfigId` for AUTO routing escalation and optional `localModelHost` (`"server"` \| `"client"`) for local-oss model host routing (`"server"` = use server's own Ollama, `"client"` = auto-distribute to any online worker with `localLlmEnabled`) |
| `interventions.ts` | Running-job intervention schemas: `JobIntervention`, `JobInterventionCreate`, source/status enums, and `JobInterventionSupport` capability payloads shared across REST/WS/MCP/UI |
| `jobs.ts` | `Job` / `JobSubmit` schemas plus runtime override schemas (`RuntimeReasoningLevel`, `RuntimeVerificationMode`, `BridgeExecutionMode`, `CoordinationScriptMode`, `CoordinationScripts`, `JobRuntimeOptions`), AUTO target (`AgentConfigTarget`), routing metadata (`requestedAgentConfigId`, `actualAgentConfigId`, `actualModel`, `routingReason`), manual outcome feedback fields (`JobOutcomeRating`, `outcomeRating`, `outcomeNotes`, `outcomeMarkedAt`, `outcomeMarkedBy`), and job-identity/usage display metadata (`submittedByUsername`, `tokenUsage.costUsd`) |
| `messages.ts` | All 40 WebSocket message types + `Message` discriminated union. Includes running-job intervention list/submit/update envelopes, cross-bridge command payloads with optional `projectPath`, worker-owned headless execution messages (`worker_headless_command`, `worker_headless_result`) for desktop-client CLI runs, and client-dispatched local LLM job messages (`client_job_dispatch`, `client_tool_request`, `client_tool_result`, `client_job_log`, `client_job_complete`, `client_job_cancel`). |
| `policies.ts` | `PolicyScope`, `PolicyType`, `PolicyAction`, `PolicyCreate`, `Policy` schemas |
| `projects.ts` | `WorkspaceMode`, `CommandResult`, `PathMappingEntry`, `PathMapping`, `ProjectFolder`, `ProjectFile`, `GitHubRepo`, `Project` (prompt, pathMappings, folders, files, githubRepos), `ProjectCreate` schemas |
| `workers.ts` | `WorkerStatus`, `Worker` (includes optional `machineId` + `knownPrograms: string[]`), `BridgeInfo` (includes optional `machineId`, `osUser` + `activeProjects: string[]`) schemas |
| `local-agentic.ts` | Shared local agentic protocol (moved from server). Contains `LocalAgenticToolName`, `LocalAgenticToolCall`, `LocalAgenticFinal`, `LocalAgenticAction`, `LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS`, `LOCAL_AGENTIC_DEFAULTS` (default max turns/timeout/token limits), `LOCAL_AGENTIC_DELEGATION_TOOLS` (tool names requiring delegation gate), `parseLocalAgenticAction()`, `buildLocalAgenticTurnPrompt()`, `promptRequestsDelegation()`, `compactJson()`, and `LocalAgenticHistoryEntry` interface |
| `local-agentic-loop.ts` | Shared agentic loop runner used by both server and client. Exports `runAgenticLoop()` with dependency-injection interfaces (`AgenticLoopConfig`, `AgenticLoopDeps`, `AgenticLoopResult`) so the same turn/tool/completion logic runs identically on server (via Ollama HTTP) and client (via Tauri Ollama). Handles turn iteration, tool call routing, delegation gating, token tracking, timeout enforcement, and final-action detection |
| `index.ts` | Re-exports everything from all modules (including `local-agentic.js` and `local-agentic-loop.js`) |

## Key Enums
- **JobStatus**: `queued | paused | running | completed | failed | cancelled`
- **JobPriority**: `low | normal | high | critical`
- **CoordinationMode**: `server | client`
- **AgentEngine**: `claude-code | codex | gemini | local-oss`
- **RuntimeReasoningLevel**: `low | medium | high | xhigh`
- **RuntimeVerificationMode**: `required | optional | disabled`
- **BridgeExecutionMode**: `live | headless`
- **CoordinationScriptMode**: `all | none | selected`
- **JobOutcomeRating**: `positive | average | negative`
- **WorkspaceMode**: `command | repo | sync`
- **JobInterventionSource**: `jobs | chat | mcp`
- **JobInterventionStatus**: `pending | delivered | superseded | rejected`
- **PolicyType**: `file_path | tool | prompt_filter | engine_model | command_filter`
- **PolicyAction**: `block | warn`

## WebSocket Messages (40 types)
- **Bridge→Server**: `job_submit`
- **Server→Bridge+Clients**: `job_accepted`, `job_started`, `job_log`, `job_complete`, `job_updated`
- **Client↔Server**: `job_list`/`job_list_response`, `job_cancel`, `job_reprioritize`, `job_intervention_list`/`job_intervention_list_response`, `job_intervention_submit`, `job_intervention_updated`, `agent_config_list`/`_response`, `agent_config_create`/`update`/`delete`, `bridge_status`, `worker_status`, `project_list`/`_response`, `job_dependency_blocked`, `error`
- **Cross-bridge commands**: `bridge_command_send` (sender→server), `bridge_command` (server→target bridge), `bridge_command_result` (target→server→sender)
- **Worker-owned headless execution**: `worker_headless_command` (server→desktop client), `worker_headless_result` (desktop client→server)
- **Bridge Context**: `bridge_context_item_add` (bridge→server→client), `bridge_context_clear` (bridge→server→client), `bridge_editor_context` (bridge→server→client), `bridge_context_sync` (server→client)
- **Client-dispatched local LLM jobs**: `client_job_dispatch` (server→client), `client_tool_request` (client→server), `client_tool_result` (server→client), `client_job_log` (client→server), `client_job_complete` (client→server), `client_job_cancel` (server→client)

## Message Envelope Pattern
All messages use `makeMessage(type, payloadSchema)` → `{ type: literal, id: uuid, payload: T }`. Validated via `Message` discriminated union on `type` field.

## Build
- `pnpm --filter @arkestrator/protocol build` → runs `tsc` → outputs to `dist/`
- `pnpm --filter @arkestrator/protocol test` → runs `bun test src/__tests__`
- Must rebuild after any schema change
- Deps: `zod` only

## Key Design Decisions
- Zod schemas define both runtime validation AND TypeScript types (via `z.infer`)
- All IDs are UUID strings; timestamps are ISO datetime strings
- `Job` has optional `tokenUsage` object (inputTokens, outputTokens, durationMs, optional `costUsd`)
- `Job` has optional `submittedBy` (UUID of the user who submitted the job)
- `Job` has optional `submittedByUsername` (resolved username for display/filtering)
- `Job` has optional `parentJobId` (UUID of the orchestrator job that spawned this sub-job via MCP)
- `Job` has `coordinationMode` (`server` by default) to indicate where orchestration decisions were made
- `Job` and `JobSubmit` both support optional `runtimeOptions` for per-run overrides (`model`, `reasoningLevel`, `verificationMode`, `verificationWeight`, `bridgeExecutionMode`, `coordinationScripts`)
- `JobSubmit.agentConfigId` accepts either a concrete UUID or `"auto"` (`AgentConfigTarget`)
- `Job` stores both requested vs resolved agent routing metadata for AUTO mode (`requestedAgentConfigId`, `actualAgentConfigId`, `actualModel`, `routingReason`)
- `Job` includes optional user-marked outcome feedback (`outcomeRating`, `outcomeNotes`, `outcomeMarkedAt`, `outcomeMarkedBy`) used for coordinator learning
- `JobIntervention` records are first-class typed objects with author/source/status/timestamp metadata so delivery state can be shared consistently across server, client, admin, and MCP surfaces
- `AgentConfig` supports optional `fallbackConfigId` for explicit escalation chains in AUTO routing
- `AgentConfig` supports optional `localModelHost` (`"server"` | `"client"`) for local-oss model host routing. `"server"` uses the server's own Ollama endpoint; `"client"` auto-distributes to any online worker with `localLlmEnabled` and a reachable Ollama instance
- `JobSubmit` supports `startPaused`, `dependsOn`, `targetWorkerName`, `projectId`, `contextItems`
- `JobSubmit` supports `coordinationMode` (`server` default; `client` when local-client coordination is enabled)
- `JobSubmit` supports optional `bridgeProgram` for explicit target routing when no live editor context is attached (offline/headless bridge selections)
- `runtimeOptions.bridgeExecutionMode = "headless"` is used to require separate-process bridge execution on the target worker/client even when a live GUI bridge is online
- `Worker` and `BridgeInfo` optionally carry a persistent client-owned `machineId` so servers, clients, and bridges can match same-machine connections even if `workerName` changes
- `ContextItem` has `index` (1-based, for @N references), `type`, `name`, `path`, optional `content` and `metadata`
- `ContextItemType`: `node | script | asset | resource | scene`
- `EditorContext.metadata` is `Record<string, unknown>` for DCC-specific data
- `FileChange` supports binary files via optional `binaryContent` (base64 string) + `encoding` (`"utf8"` | `"base64"`) fields. Gated behind `binary_files` capability in `/health`.

## Known Inconsistencies
- ~~`CreatePolicy` uses prefix naming~~ - FIXED: `PolicyCreate` is now canonical; deprecated alias removed
- ~~`Policy.createdAt/updatedAt` use `z.string()`~~ - FIXED: now `z.string().datetime()` like all other schemas
- ~~`BridgeStatusMessage` payload is inline~~ - FIXED: extracted `BridgeInfo` standalone schema in `workers.ts`
- ~~Admin app declares `@arkestrator/protocol` dependency but has zero actual imports~~ - FIXED: removed unused dependency

## WS-Only vs REST-Only Operations
- **WS + REST**: job list, job cancel, job reprioritize, job interventions, agent config CRUD
- **WS only**: job_submit (bridge), job_log, job_started, job_complete, job_updated, bridge_status, worker_status, bridge_context_item_add, bridge_context_clear, bridge_editor_context, bridge_context_sync
- **REST only**: policies CRUD, project CRUD (beyond list), job delete, job resume, job requeue, users, API keys, audit log
- **No WS messages for**: pause/resume, delete, policy management, user/auth
