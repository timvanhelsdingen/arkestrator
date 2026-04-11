# Module: Protocol (`packages/protocol/`)

## Purpose
Shared Zod schema definitions that serve as the single source of truth for all TypeScript types across server, client, and admin. Compiled to JS+DTS via `tsc`, consumed as `@arkestrator/protocol` workspace dependency.

## Files
| File | Purpose |
|------|---------|
| `common.ts` | Base enums + shared types: `JobStatus`, `JobPriority`, `CoordinationMode` (`server`/`client`), `AgentEngine`, `FileChange` (with optional `binaryContent` base64 + `encoding`), `EditorContext`, `FileAttachment`, `ContextItemType`, `ContextItem`, `ApiErrorResponseSchema` / `ApiErrorResponse` (standardized API error envelope) |
| `agents.ts` | `AgentConfig` (full) and `AgentConfigCreate` (omits id/timestamps) schemas; includes optional `fallbackConfigId` for AUTO routing escalation and optional `localModelHost` (`"server"` \| `"client"`) for local-oss model host routing (`"server"` = use server's own Ollama, `"client"` = auto-distribute to any online worker with `localLlmEnabled`) |
| `interventions.ts` | Running-job intervention schemas: `JobIntervention`, `JobInterventionCreate`, source/status enums, and `JobInterventionSupport` capability payloads shared across REST/WS/MCP/UI |
| `jobs.ts` | `Job` / `JobSubmit` schemas plus runtime override schemas (`RuntimeReasoningLevel`, `RuntimeVerificationMode`, `BridgeExecutionMode`, `CoordinationScriptMode`, `CoordinationScripts`, `JobRuntimeOptions` including optional `timeoutMinutes`), AUTO target (`AgentConfigTarget`), routing metadata (`requestedAgentConfigId`, `actualAgentConfigId`, `actualModel`, `routingReason`), manual outcome feedback fields (`JobOutcomeRating`, `outcomeRating`, `outcomeNotes`, `outcomeMarkedAt`, `outcomeMarkedBy`), job-identity/usage display metadata (`submittedByUsername`, `tokenUsage.costUsd`), optional `requestedSkills` (`z.array(z.string()).optional()`) on both `Job` and `JobSubmit` for user-requested skill slugs via `/skill:slug` syntax, and non-agentic task job schemas: `JobMode` (`"agentic" \| "task"`), `TaskExecutionType` (`"bridge_command" \| "worker_local" \| "worker_headless" \| "api_call"`), `TaskSpec` (execution type, command, args, program, target worker, timeout, plus optional `apiBridgeName`/`apiBridgeAction`/`apiBridgeParams` for API bridge tasks). `Job` has optional `mode`, `taskSpec`, `taskProgress`, `taskStatusText`, `taskRef` fields. `JobSubmit` has optional `mode`, `taskSpec`, `track` fields. |
| `api-bridges.ts` | Zod schemas for API bridge configuration and execution. `ApiBridgeAuthType` (`none \| api_key \| bearer_token \| basic`), `ApiBridgeAuth` (type + credentials), `ApiBridgeAction` (name, method, endpoint, optional body/headers/polling config), `ApiBridgeActionResult` (status, data, optional outputFiles), `ApiBridgeOutputFile` (url, filename, type), `ApiBridgePreset` (id, name, description, actions, requiredAuth), `ApiBridgePresetInfo` (id, name, optional `authType`, `description`, `hasHandler` — extended metadata for preset listing that includes both local handler presets and remote-only presets from GitHub), `McpConfig` (transport + command/args/env or url/headers), `McpPresetInfo` (presetId, displayName, description, category, mcpConfig, optional setupNote and homepage — curated MCP server presets shown in settings gallery and bootstrap wizard), `ApiBridgeConfig` / `ApiBridgeConfigCreate` (name, type `preset \| custom`, baseUrl, auth, actions, optional presetId, optional mcpConfig, enabled flag, timestamps). Used by server API bridge executor and client settings UI. |
| `messages.ts` | All 51 WebSocket message types + `Message` discriminated union. Includes running-job intervention list/submit/update envelopes, cross-bridge command payloads with optional `projectPath`, worker-owned headless execution messages (`worker_headless_command`, `worker_headless_result`) for desktop-client CLI runs, client headless capability reporting (`client_headless_capabilities` with `ClientHeadlessCapability` schema — program/path/version auto-detected on desktop), client-dispatched local LLM job messages (`client_job_dispatch`, `client_tool_request`, `client_tool_result`, `client_job_log`, `client_job_complete`, `client_job_cancel`), `FileDeliverMessage` (type: `file_deliver`) for server->bridge/client file delivery, `TransferInitiateMessage` (type: `transfer_initiate`, extended with optional `p2pUrl` for P2P direct downloads) for server→client HTTP file transfer initiation, `TransferProgressMessage` (type: `transfer_progress`) for client→server transfer progress reporting, `TransferServeRequestMessage` (type: `transfer_serve_request`) for server→client P2P file serve requests (transferId, files, tokens), `TransferServeReadyMessage` (type: `transfer_serve_ready`) for client→server P2P serve readiness notification (transferId, host, port, tokens, optional error), client→server context management messages (`client_context_item_remove`, `client_context_items_clear`), bridge file access messages (`bridge_file_read_request`, `bridge_file_read_response`) for server-side agents to read files on client machines via bridge/client connections, and `TaskProgressMessage` (type: `task_progress`) for non-agentic task job progress reporting (percent, statusText, optional output). |
| `policies.ts` | `PolicyScope`, `PolicyType`, `PolicyAction`, `PolicyCreate`, `Policy` schemas |
| `projects.ts` | `WorkspaceMode`, `CommandResult`, `PathMappingEntry`, `PathMapping`, `ProjectFolder`, `ProjectFile`, `GitHubRepo`, `Project` (prompt, pathMappings, folders, files, githubRepos), `ProjectCreate` schemas |
| `workers.ts` | `WorkerStatus`, `Worker` (includes optional `machineId` + `knownPrograms: string[]` + optional `isServerWorker` boolean), `BridgeInfo` (includes optional `machineId`, `osUser` + `activeProjects: string[]`) schemas |
| `local-agentic.ts` | Shared local agentic protocol (moved from server). Contains `LocalAgenticToolName` (relaxed from strict enum to `z.string().min(1)` — MCP server validates tool names), `KNOWN_LOCAL_AGENTIC_TOOLS` (array of known built-in tool names), `LocalAgenticToolCall`, `LocalAgenticFinal`, `LocalAgenticAction`, `LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS`, `LOCAL_AGENTIC_DEFAULTS` (default max turns/timeout/token limits), `LOCAL_AGENTIC_DELEGATION_TOOLS` (tool names requiring delegation gate), `parseLocalAgenticAction()` (heuristic extraction now accepts unknown tool names), `buildLocalAgenticTurnPrompt()`, `buildOllamaSystemMessage()`, `buildOllamaHybridSystemMessage()` (for thinking models — embeds tool defs + JSON protocol in system prompt), `getOllamaToolSchemas()`, `promptRequestsDelegation()`, `compactJson()`, and `LocalAgenticHistoryEntry` interface |
| `local-agentic-loop.ts` | Shared agentic loop runner used by both server and client. Exports `runAgenticLoop()` (text-prompt mode) and `runChatAgenticLoop()` (native Ollama tool calling with auto-fallback to hybrid mode for thinking models) with dependency-injection interfaces (`AgenticLoopConfig`, `AgenticLoopDeps`, `AgenticLoopResult`). `AgenticLoopConfig` now accepts optional `toolSchemas?: OllamaToolSchema[]` for externally-provided tool definitions (e.g. from MCP). Loop uses external schemas when provided instead of built-in defaults. `buildHybridSystemFromSchemas()` builds hybrid mode system prompts from MCP-derived schemas. Handles turn iteration, tool call routing, delegation gating, timeout enforcement, hybrid mode detection (auto-switches when model returns text instead of tool_calls), and final-action detection |
| `mcp-tool-adapter.ts` | Adapters converting MCP tool definitions/results to Ollama format and agentic loop format. Exports: `mcpToolsToOllamaSchemas()` (MCP tool defs → Ollama native tool calling schemas), `mcpToolsToTextPrompt()` (MCP tool defs → text-prompt mode tool descriptions), `mcpResultToLoopResult()` (MCP call results → agentic loop result format). Types: `McpToolDefinition`, `McpToolCallResult` |
| `index.ts` | Re-exports everything from all modules (including `local-agentic.js`, `local-agentic-loop.js`, `mcp-tool-adapter.js`, and `api-bridges.js`) |

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
- **JobMode**: `agentic | task`
- **TaskExecutionType**: `bridge_command | worker_local | worker_headless | api_call`
- **ApiBridgeAuthType**: `none | api_key | bearer_token | basic`

## WebSocket Messages (51 types)
- **Bridge→Server**: `job_submit`
- **Server→Bridge+Clients**: `job_accepted`, `job_started`, `job_log`, `job_complete`, `job_updated`
- **Client↔Server**: `job_list`/`job_list_response`, `job_cancel`, `job_reprioritize`, `job_intervention_list`/`job_intervention_list_response`, `job_intervention_submit`, `job_intervention_updated`, `agent_config_list`/`_response`, `agent_config_create`/`update`/`delete`, `bridge_status`, `worker_status`, `project_list`/`_response`, `job_dependency_blocked`, `error`
- **Cross-bridge commands**: `bridge_command_send` (sender→server), `bridge_command` (server→target bridge), `bridge_command_result` (target→server→sender, includes optional `stdout`/`stderr` for script output relay)
- **Worker-owned headless execution**: `worker_headless_command` (server→desktop client), `worker_headless_result` (desktop client→server)
- **Client headless auto-discovery**: `client_headless_capabilities` (desktop client→server, reports detected headless programs with path/version)
- **Bridge Context**: `bridge_context_item_add` (bridge→server→client), `bridge_context_clear` (bridge→server→client), `bridge_editor_context` (bridge→server→client), `bridge_context_sync` (server→client), `client_context_item_remove` (client→server), `client_context_items_clear` (client→server)
- **Client-dispatched local LLM jobs**: `client_job_dispatch` (server→client), `client_tool_request` (client→server), `client_tool_result` (server→client), `client_job_log` (client→server), `client_job_complete` (client→server), `client_job_cancel` (server→client)
- **File delivery**: `file_deliver` (server→bridge/client)
- **HTTP file transfer**: `transfer_initiate` (server→client, initiates HTTP upload/download; extended with optional `p2pUrl` for P2P direct downloads), `transfer_progress` (client→server, reports transfer progress/completion), `transfer_serve_request` (server→client, asks source client to start P2P file server), `transfer_serve_ready` (client→server, source client reports P2P server readiness with host/port/tokens)
- **Task jobs**: `task_progress` (server→clients, reports non-agentic task job progress with percent/statusText/output)

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
- `Job` and `JobSubmit` both support optional `runtimeOptions` for per-run overrides (`model`, `reasoningLevel`, `verificationMode`, `verificationWeight`, `bridgeExecutionMode`, `coordinationScripts`, `timeoutMinutes`)
- `JobSubmit.agentConfigId` accepts either a concrete UUID or `"auto"` (`AgentConfigTarget`)
- `Job` stores both requested vs resolved agent routing metadata for AUTO mode (`requestedAgentConfigId`, `actualAgentConfigId`, `actualModel`, `routingReason`)
- `Job` includes optional user-marked outcome feedback (`outcomeRating`, `outcomeNotes`, `outcomeMarkedAt`, `outcomeMarkedBy`) used for coordinator learning
- `JobIntervention` records are first-class typed objects with author/source/status/timestamp metadata so delivery state can be shared consistently across server, client, admin, and MCP surfaces
- `AgentConfig` supports optional `fallbackConfigId` for explicit escalation chains in AUTO routing
- `AgentConfig` supports optional `localModelHost` (`"server"` | `"client"`) for local-oss model host routing. `"server"` uses the server's own Ollama endpoint; `"client"` auto-distributes to any online worker with `localLlmEnabled` and a reachable Ollama instance
- `Job` has optional `mode` (`"agentic"` default, `"task"` for non-agentic task jobs), `taskSpec` (TaskSpec), `taskProgress` (0-100), `taskStatusText`, and `taskRef` (`#T<N>` short reference)
- `JobSubmit` supports optional `mode` (`"agentic"` | `"task"`), `taskSpec` (TaskSpec for task mode), and `track` (boolean for task ref assignment)
- `JobSubmit` supports `startPaused`, `dependsOn`, `targetWorkerName`, `projectId`, `contextItems`
- `JobSubmit` supports `coordinationMode` (`server` default; `client` when local-client coordination is enabled)
- `JobSubmit` supports optional `bridgeProgram` for explicit target routing when no live editor context is attached (offline/headless bridge selections)
- `Job` and `JobSubmit` both support optional `requestedSkills` (`z.array(z.string()).optional()`) for user-requested skill slugs via `/skill:slug` syntax in prompts
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
- **WS only**: job_submit (bridge), job_log, job_started, job_complete, job_updated, bridge_status, worker_status, bridge_context_item_add, bridge_context_clear, bridge_editor_context, bridge_context_sync, client_context_item_remove, client_context_items_clear, **bridge_command_cancel** (server→bridge, best-effort abort for in-flight `bridge_command` matched by `correlationId`; sent on timeout, explicit cancel, or task-job cancel/timeout)
- **REST only**: policies CRUD, project CRUD (beyond list), job delete, job resume, job requeue, users, API keys, audit log
- **No WS messages for**: pause/resume, delete, policy management, user/auth
