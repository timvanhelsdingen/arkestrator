# Server & API

## Starting the Server

```bash
# Dev mode (auto-restarts on file changes)
pnpm server

# Or standalone binary
./arkestrator-server-linux-x64
```

Health check: `GET /health` — returns JSON with server status, version, and capabilities.

The server starts on port 7800 by default. On first run, bootstrap admin credentials are written to `bootstrap-admin.txt` in the data directory.

## REST API Reference

All API requests require authentication via session token (`Authorization: Bearer <token>`) or API key (`Authorization: Bearer <api-key>`).

### Authentication

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/login` | POST | Login with username/password. Returns session token. |
| `/api/auth/login` | POST | If 2FA enabled, returns a challenge token. Follow with verify-totp. |
| `/api/auth/verify-totp` | POST | Complete 2FA login with TOTP code or recovery code |
| `/api/auth/logout` | POST | End current session |
| `/api/auth/me` | GET | Get current user info and permissions |
| `/api/auth/change-password` | POST | Change password (requires current password) |
| `/api/auth/client-coordination` | PUT | Set per-user client coordination opt-in |

### Jobs

| Endpoint | Method | Description |
|---|---|---|
| `/api/jobs` | GET | List jobs (supports `status`, `limit`, `offset` query params) |
| `/api/jobs` | POST | Create a new job |
| `/api/jobs/:id` | GET | Get job details |
| `/api/jobs/:id` | DELETE | Delete a job (cancels if running) |
| `/api/jobs/:id/cancel` | POST | Cancel a running or queued job |
| `/api/jobs/:id/resume` | POST | Resume a paused job |
| `/api/jobs/:id/requeue` | POST | Requeue a completed/failed job (optional `targetWorkerName`) |
| `/api/jobs/:id/reprioritize` | POST | Change job priority |
| `/api/jobs/:id/outcome` | PUT | Set outcome feedback (good/average/poor + notes) |
| `/api/jobs/:id/interventions` | GET | List interventions for a job |
| `/api/jobs/:id/interventions` | POST | Send guidance to a running job |

#### Job Creation Payload

```json
{
  "prompt": "add a health bar to the player HUD",
  "agentConfigId": "<uuid or 'auto'>",
  "projectRoot": "/path/to/project",
  "projectId": "<uuid>",
  "targetWorkerName": "workstation-1",
  "priority": "normal",
  "startPaused": false,
  "dependsOn": "<parent-job-id>",
  "preferredMode": "command",
  "bridgeProgram": "godot",
  "contextItems": [...],
  "files": [...],
  "runtimeOptions": {
    "model": "claude-sonnet-4-6",
    "reasoningLevel": "high",
    "verificationMode": "optional",
    "verificationWeight": 50,
    "bridgeExecutionMode": "live",
    "coordinationScripts": {
      "coordinator": "enabled",
      "bridge": "enabled",
      "training": "auto"
    }
  }
}
```

### Agent Configs

| Endpoint | Method | Description |
|---|---|---|
| `/api/agent-configs` | GET | List all agent configurations |
| `/api/agent-configs` | POST | Create a new agent config |
| `/api/agent-configs/:id` | PUT | Update an agent config |
| `/api/agent-configs/:id` | DELETE | Delete an agent config |
| `/api/agent-configs/templates` | GET | List available agent templates |
| `/api/agent-configs/cli-auth/*` | Various | CLI auth management (login status, start, cancel) |
| `/api/agent-configs/local-models` | GET | List local model catalog |
| `/api/agent-configs/local-models/pull/stream` | POST | Pull/download a local model with streaming progress |
| `/api/agent-configs/model-catalogs` | GET | Get provider model catalogs (Claude, Codex, Gemini) |

### Projects

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET | List project mappings |
| `/api/projects` | POST | Create a project mapping |
| `/api/projects/:id` | PUT | Update a project mapping |
| `/api/projects/:id` | DELETE | Delete a project mapping |

### Bridge Commands

| Endpoint | Method | Description |
|---|---|---|
| `/api/bridge-command` | POST | Send commands to connected bridges (bypasses job queue) |
| `/api/bridge-command/headless-check` | POST | Execute a headless command check |

Bridge command payload:

```json
{
  "target": "blender",
  "targetType": "program",
  "commands": [
    { "language": "python", "script": "import bpy; bpy.ops.mesh.primitive_cube_add()", "description": "Add a cube" }
  ],
  "projectPath": "/path/to/project",
  "timeout": 60000,
  "executionMode": "live",
  "targetWorkerName": "worker1"
}
```

### Users (Admin)

| Endpoint | Method | Description |
|---|---|---|
| `/api/users` | GET | List all users |
| `/api/users` | POST | Create a new user |
| `/api/users/:id` | PUT | Update user (role, permissions, token limits) |
| `/api/users/:id` | DELETE | Delete a user |
| `/api/users/:id/insights` | GET | User usage insights (token totals, job counts) |

### API Keys (Admin)

| Endpoint | Method | Description |
|---|---|---|
| `/api/keys` | GET | List API keys |
| `/api/keys` | POST | Create a new API key (admin/worker/client role) |
| `/api/keys/:id` | DELETE | Revoke an API key |

### Policies (Admin)

| Endpoint | Method | Description |
|---|---|---|
| `/api/policies` | GET | List policies |
| `/api/policies` | POST | Create a policy |
| `/api/policies/:id` | PUT | Update a policy |
| `/api/policies/:id` | DELETE | Delete a policy |

Policy types: `prompt_filter`, `command_filter`, `file_path`, `engine_model`. Actions: `block` or `warn`.

### Workers

| Endpoint | Method | Description |
|---|---|---|
| `/api/workers` | GET | List workers with bridge info |
| `/api/workers/:id` | DELETE | Delete a worker record |
| `/api/workers/:id/rules` | PUT | Update per-worker rules |
| `/api/workers/:id/local-llm-check` | GET | Check worker's local LLM endpoint health |

### Connections

| Endpoint | Method | Description |
|---|---|---|
| `/api/connections` | GET | List active WebSocket connections |
| `/api/connections/:id/kick` | POST | Force-disconnect a connection |

### Settings

| Endpoint | Method | Description |
|---|---|---|
| `/api/settings` | GET | Get all server settings |
| `/api/settings/*` | PUT | Update specific settings (CORS, workspace mode, coordination policy, etc.) |
| `/api/settings/export-snapshot` | GET | Export full server config snapshot |
| `/api/settings/import-snapshot` | POST | Import/restore a config snapshot |

### Coordinator & Training

| Endpoint | Method | Description |
|---|---|---|
| `/api/settings/coordinator-scripts` | GET | List all coordinator scripts |
| `/api/settings/coordinator-scripts/:program` | GET/PUT/DELETE | Manage per-program scripts |
| `/api/settings/coordinator-playbooks/*` | Various | Playbook source management, analysis, training |
| `/api/settings/coordinator-training-schedule` | GET/PUT | Scheduled training configuration |
| `/api/settings/coordinator-training/run-now` | POST | Trigger immediate training run |
| `/api/settings/coordinator-training-files/*` | Various | Training vault file management |
| `/api/settings/training-repository-*` | Various | Training repository policy, records, metrics |

### Headless Programs

| Endpoint | Method | Description |
|---|---|---|
| `/api/headless-programs` | GET | List registered headless program definitions |
| `/api/headless-programs` | POST | Register a headless program |
| `/api/headless-programs/:id` | PUT/DELETE | Update or remove a headless program |

### Chat (SSE)

| Endpoint | Method | Description |
|---|---|---|
| `/api/chat` | POST | Stream a conversational response (SSE). Separate from job queue. |

### Audit Log

| Endpoint | Method | Description |
|---|---|---|
| `/api/audit-log` | GET | Query audit log entries (supports user/action/date filters) |

## WebSocket Protocol

Connect to `/ws` with these query parameters:

| Param | Required | Description |
|---|---|---|
| `type` | Yes | `client` or `bridge` |
| `program` | Bridges only | DCC program identifier: `godot`, `blender`, `houdini`, `comfyui`, `unity`, `unreal` |
| `programVersion` | Bridges only | DCC app version string |
| `bridgeVersion` | Bridges only | Bridge plugin version |
| `protocolVersion` | Bridges only | Protocol version |
| `projectPath` | Bridges only | Current project path in the DCC app |
| `workerName` | Optional | Machine name for worker tracking |
| `machineId` | Optional | Persistent UUID for machine identity |
| `osUser` | Optional | OS user running the bridge |

Authentication is via the WebSocket subprotocol: `arkestrator.auth.<API_KEY>`.

### Message Envelope

All messages follow: `{ type: string, id: uuid, payload: object }`

### Key Message Types

| Type | Direction | Purpose |
|---|---|---|
| `job_submit` | Client/Bridge → Server | Submit a new job |
| `job_updated` | Server → All | Job state change broadcast |
| `job_log` | Server → Clients | Live log line from running agent |
| `job_complete` | Server → Bridges | Job finished, deliver results |
| `bridge_command` | Server → Bridge | Execute commands in DCC app |
| `bridge_command_result` | Bridge → Server | Command execution results |
| `bridge_context_item_add` | Bridge → Server | Push a context item |
| `bridge_editor_context` | Bridge → Server | Push editor state snapshot |
| `bridge_context_sync` | Server → Client | Full bridge context state on connect |
| `bridge_status` | Server → Clients | Bridge connection/disconnection |
| `worker_status` | Server → Clients | Worker state changes |
| `job_intervention_submit` | Client → Server | Send guidance to running job |
| `error` | Server → Client/Bridge | Error notification |

See the protocol package (`packages/protocol/src/messages.ts`) for the complete list of 40+ message types.

## MCP Integration

The server exposes an MCP endpoint at `/mcp` for external AI clients.

### Authentication

```
Authorization: Bearer <arkestrator-api-key>
X-Job-Id: <job-id>  (optional, for job-scoped operations)
```

### Available MCP Tools

- `create_job` — Submit a new job to the queue
- `list_jobs` — Query job list with filters
- `get_job_status` — Get status of a specific job
- `get_job_logs` — Retrieve job output logs
- `cancel_job` — Cancel a running job
- `list_bridges` — List connected bridges
- `list_targets` — List available bridge targets by program
- `execute_command` — Send commands directly to a bridge
- `client_api_request` — Proxy arbitrary API calls through Arkestrator

### MCP Config Injection

When the server spawns an AI agent, it writes `.mcp.json` in the working directory so the agent can call back to Arkestrator:

```json
{
  "mcpServers": {
    "arkestrator": {
      "type": "http",
      "url": "http://localhost:7800/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>",
        "X-Job-Id": "<JOB_ID>"
      }
    }
  }
}
```

This means spawned agents (Claude Code, Codex) automatically have access to Arkestrator's MCP tools during execution.

## Workspace Mode Control

You can influence which workspace mode the resolver picks:

- **Per-job:** Set `preferredMode` in the job payload (`command`, `repo`, `sync`)
- **Server default:** Set `DEFAULT_WORKSPACE_MODE` env var
- **Project mapping:** Create mappings in Admin > Projects so bridge paths resolve to server-local paths (enables `repo` mode)
- **Bridge targeting:** Bridge-targeted jobs from Chat default to `command` mode

## Operational Notes

- **Queue concurrency** is controlled by `MAX_CONCURRENT_AGENTS` (default 8)
- **Job timeouts** default to 30 minutes. The `ProcessTracker` kills jobs exceeding `JOB_TIMEOUT_MS`.
- **Worker records** persist across server restarts. A bridge reconnecting with the same `workerName`/`machineId` resumes the existing record.
- **Rate limiting**: Per-API-key job submission rate (default 10/minute) and per-IP login rate (default 10/5min)
- **Token limits**: Per-user daily/monthly/unlimited quotas checked before job dispatch
- **Headless fallback**: When a target bridge is offline, the server can execute commands via headless executables if registered
- **Port retry**: On startup, the server retries port binding with exponential backoff (handles Windows orphaned sockets)
- **Database recovery**: If the SQLite database is corrupted, the server moves it to a backup and creates a fresh one
