# Architecture

Arkestrator uses a hub-and-spoke model. The server is the hub — it owns the job queue, spawns AI agents, enforces auth/policies, and persists all state. Bridges are thin spokes running inside DCC apps that push context and execute results. The desktop client is the user's control panel.

## System Diagram

```
                         ┌────────────────┐
                         │ Desktop Client │
                         │ (Tauri+Svelte) │
                         │                │
                         │ Chat · Jobs    │
                         │ Admin · Workers│
                         └───────┬────────┘
                                 │ REST + WS
                                 │
┌────────────────────────────────▼──────────────────────────────────┐
│                        Arkestrator Server                        │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐             │
│  │  REST    │  │  WebSocket   │  │  MCP Endpoint  │             │
│  │  API     │  │  Gateway     │  │  (/mcp)        │             │
│  └────┬─────┘  └──────┬───────┘  └───────┬────────┘             │
│       │               │                  │                       │
│  ┌────▼────────────────▼──────────────────▼───────────────┐      │
│  │                    Job Queue                           │      │
│  │  priority ordering · dependency chains · worker claims │      │
│  └────────────────────────┬───────────────────────────────┘      │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────┐      │
│  │              Workspace Resolver                        │      │
│  │  repo (direct files) · command (in-app) · sync (temp) │      │
│  └────────────────────────┬───────────────────────────────┘      │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────┐      │
│  │              Agent Spawner                             │      │
│  │  Bun.spawn → claude | codex | gemini | ollama | any   │      │
│  │  + skill injection (TF-IDF search → matched skills)   │      │
│  │  + coordinator context + playbook guidance injection   │      │
│  │  + MCP config injection for agent ↔ server callbacks  │      │
│  └────────────────────────┬───────────────────────────────┘      │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────┐      │
│  │              Skills & Training                         │      │
│  │  skill index (search) · effectiveness tracking         │      │
│  │  training pipeline · coordinator scripts · playbooks   │      │
│  └────────────────────────┬───────────────────────────────┘      │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────┐      │
│  │              SQLite Database                           │      │
│  │  jobs · users · workers · agents · policies · skills   │      │
│  │  skill_versions · skill_effectiveness · settings       │      │
│  │  audit · usage · headless programs                     │      │
│  └────────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐      │
│  │              Admin SPA (served at /admin)              │      │
│  └────────────────────────────────────────────────────────┘      │
└──────────────────────────┬───────────────────────────────────────┘
                           │ WS
           ┌───────────────┼───────────────────────┐
           │               │               │       │
     ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼────┐  │
     │  Godot    │  │  Blender  │  │  Houdini │  ...
     │  Bridge   │  │  Bridge   │  │  Bridge  │
     │ GDScript  │  │  Python   │  │  Python  │
     └───────────┘  └───────────┘  └──────────┘
```

## Components

| Component | Tech | Role |
|---|---|---|
| **Server** | Bun + Hono + SQLite | Central hub: job queue, agent spawning, workspace resolution, auth, policies, real-time streaming, coordinator |
| **Database** | SQLite (Bun built-in) | All persistent state. Zero-config, single-file, embedded. No external DB needed. |
| **Protocol** | Zod schemas (TypeScript) | Single source of truth for all message types. Runtime validation + TypeScript type inference from one definition. Shared across server, client, and admin. |
| **Desktop Client** | Tauri v2 + Svelte 5 | Native desktop app. Chat interface, job dashboard, worker management, coordinator UI, local server management. |
| **Admin SPA** | Svelte 5 + Vite | Web admin panel served by the server at `/admin`. User management, agent configs, policies, machine inventory, audit log, training vault. Embedded in the desktop client via iframe. |
| **Bridges** | GDScript, Python, C# | Thin DCC plugins using each app's native language. Push editor context, execute commands, apply file changes. No job submission UI. |

## Transport Layers

### REST API
Request/response operations:
- Authentication (login, sessions, 2FA)
- Job CRUD (create, list, cancel, requeue, delete)
- Agent config management
- Project, policy, and settings management
- Bridge command dispatch
- Coordinator and training APIs
- MCP tool interface
- Config snapshot export/import

### WebSocket
Real-time bidirectional communication:
- Live log streaming from running agents
- Job status broadcasts to all connected clients
- Bridge command relay (server → bridge → result → server)
- Editor context pushes from bridges (every 2-3s)
- Worker/bridge presence detection
- Running-job intervention delivery
- Client-dispatched local LLM job coordination
- Worker headless command dispatch

### SQLite
All persistent state:
- Jobs (queue, status, results, logs, token usage, outcomes)
- Users (accounts, roles, permissions, sessions, 2FA, token limits)
- API keys (role-based: admin/worker/client)
- Workers (persistent registry, bridge history, known programs)
- Agent configs (engine, model, args, fallback chains)
- Policies (prompt/command/file/engine filters)
- Settings (key-value runtime configuration)
- Audit log (all admin actions with user/IP/timestamp)
- Headless program definitions

## Connection Types

The server distinguishes two WebSocket connection types:

**Bridges** (`type=bridge`) — DCC app plugins. Connect with metadata: program name, version, project path, worker name, machine ID. Push editor context. Receive job completions and bridge commands.

**Clients** (`type=client`) — Desktop app or API consumers. Receive job updates, log streams, worker/bridge status. Submit jobs and send interventions.

Both authenticate via API key in the WebSocket subprotocol (`arkestrator.auth.<TOKEN>`).

## Message Envelope

All WebSocket messages follow the same structure:

```json
{
  "type": "job_submit",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": { ... }
}
```

The `type` field is a discriminated union over 40+ message types. The `id` is a UUID for correlation. The `payload` varies by type and is validated against Zod schemas.

## Agent Spawning

The server spawns AI agents as child processes via `Bun.spawn`. The spawner:

1. **Builds the CLI command** based on the agent config (engine, model, args)
2. **Injects coordinator context** — global scripts, per-program scripts, matched playbooks, training data
3. **Writes MCP config** — `.mcp.json` in the working directory so the agent can call back to Arkestrator's MCP endpoint
4. **Sets environment** — working directory, prompt file, bridge list, headless program definitions
5. **Streams output** — stdout/stderr are piped to all connected clients in real-time
6. **Tracks the process** — `ProcessTracker` monitors timeouts and enables cancellation

### Supported Engine Types
- **Claude Code / Codex / Gemini / Grok** — Cloud CLI agents spawned as subprocesses
- **Local-OSS (Ollama)** — Agentic loop that sends turns to a local Ollama instance, parses tool calls, executes them, and iterates until done
- **Headless** — Direct subprocess execution (e.g., `blender --headless --python script.py`) with timeout enforcement

## Database Schema (Key Repositories)

| Repository | Manages |
|---|---|
| JobsRepo | Job lifecycle, queue ordering (priority + created_at), status transitions |
| UsersRepo | Accounts, roles, permissions (bitfield), sessions, TOTP 2FA, Argon2 hashing |
| ApiKeysRepo | API key tokens, role-based access (admin/worker/client) |
| AgentsRepo | Agent configurations with fallback chain resolution, priority scoring |
| WorkersRepo | Persistent worker registry, bridge history, known programs |
| ProjectsRepo | Project metadata, path mappings, system prompts |
| PoliciesRepo | Regex-based enforcement rules (prompt/command/file/engine) |
| SettingsRepo | Key-value runtime configuration |
| AuditRepo | Action logging (user/apiKey/IP/action/resource) |
| UsageRepo | Per-job token metrics (input/output/cost) |
| HeadlessProgramsRepo | Headless program definitions (Blender, Houdini, ComfyUI, Godot) |

## Extensibility

### Adding a new AI engine
Define an agent config with the CLI command and args. The server spawns any CLI tool that accepts a prompt and produces output on stdout. No server code changes needed for cloud CLI agents.

### Adding a new bridge
Implement the WebSocket message envelope in your DCC app's native language. You need: connection with identity metadata, editor context pushing, command execution, and file application. See [Bridge Development](bridge-development.md).

### MCP integration
Any MCP client connects to `/mcp` with a bearer token and gets access to orchestration tools: create jobs, list bridges, execute bridge commands, query status. AI agents spawned by Arkestrator get MCP config injected automatically.

### Adding workspace modes
Implement a resolver case in `server/src/workspace/resolver.ts` and a handler for the new mode's file interaction pattern.
