# Desktop Client

The Arkestrator desktop client is a Tauri v2 + Svelte 5 app. It connects to the server via REST and WebSocket and serves as the primary interface for submitting jobs, monitoring agents, managing workers, and configuring the coordinator.

## Getting Started

### First Launch

1. Launch the desktop app. It starts a local server automatically (port 7800, configurable).
2. The setup page shows your bootstrap credentials file path. Log in with those credentials.
3. After login, the client writes `~/.arkestrator/config.json` so bridges on the same machine auto-discover the server.

### Connecting to a Remote Server

1. On the setup page, enter the remote server URL (e.g., `https://arkestrator.example.com`)
2. Log in with your credentials
3. The client starts a localhost relay so same-machine bridges can connect via `127.0.0.1` instead of needing direct access to the remote server

## Pages

### Chat (Default Page)

The main prompt interface. Supports multiple independent tabs, each with its own:

- **Prompt composer** with file attachment support
- **Agent selection** — pick a specific agent config (Claude Code, Codex, Ollama) or "Auto" for automatic routing
- **Runtime overrides** — model, reasoning level (low/medium/high/xhigh), verification mode, coordinator script selection
- **Worker targeting** — route to specific machines or leave on "Auto"
- **Project selection** — `None` (no project context) or a specific project mapping
- **Priority** — low, normal, high, critical
- **Dependencies** — chain jobs so one waits for another to complete
- **Job name** — optional custom name for the job

#### Actions

- **Send** — Conversational chat (streams SSE, no job created). Good for quick questions.
- **Improve** — Rewrites your prompt using AI, replacing the text in the composer
- **Add to Queue** — Creates a job in paused state
- **Queue and Start** — Creates a job and starts it immediately

When a job is running, typing in the composer sends **running-job guidance** (interventions) to the active agent instead of creating a new job.

#### Context Panel

A resizable right sidebar showing live bridge context:
- Editor state from connected bridges (active scene, selected nodes, open files)
- Context items added via right-click in DCC apps
- Items are grouped by machine and bridge
- Drag items into the prompt for `@N` references

### Jobs

Resizable split panel with job list on the left and detail panel on the right.

**Job List:**
- Filterable by status (all/queued/paused/running/completed/failed/cancelled)
- Searchable by machine, bridge, user, text
- Dependency tree with indented child jobs
- Agent/model chips, program icons, token/cost display
- Bulk selection with checkboxes for batch operations

**Detail Panel:**
- Full job metadata (agent, model, worker, duration, tokens, cost)
- Actions: start, cancel, requeue, delete, reprioritize
- Outcome feedback (Good/Average/Poor + notes) for completed root jobs — used by the training system
- Running job guidance composer and timeline
- Prompt display with copy/expand controls
- Log viewer with auto-scroll modes (Live/Slow/Paused) and log export

### Admin

Embeds the server's web admin panel via iframe. Auto-passes your session token so you don't log in twice. Gives access to:

- **Users** — account management, roles, permissions, 2FA, token limits
- **API Keys** — create/revoke keys with role-based access
- **Agent Configs** — create/edit AI engine configurations, CLI auth, local model management, fallback chains
- **Machines** — worker inventory, per-machine rules, local LLM endpoint configuration
- **Policies** — prompt/command/file/engine filter rules
- **Training Vault** — coordinator training data explorer, export/import, scheduled training
- **Audit Log** — all administrative actions with user/IP/timestamp

### Workers

Machine-centric view showing all registered workers:
- Online/offline status per worker
- Connected bridges with program badges, versions, and active projects
- Same-program sessions grouped into one row
- Your local machine is highlighted with your account name
- 5-second polling for status updates

### Projects

Project CRUD with:
- Path mappings (bridge path pattern → server source path)
- Project folders and files
- GitHub repository links
- Per-project system prompts injected into agent runs

### Coordinator

Three scopes accessible from the left sidebar:

**Server Config:**
- Edit global and per-program coordinator scripts (injected into every agent prompt)
- Bridge readiness status
- Two-column workspace: script list + editor pane

**Training:**
- Queue training runs with source paths, file/zip uploads, training objectives
- Select training agent/model and target compute worker
- Admin-only schedule controls for automated training
- Non-admin users can queue client-initiated runs when policy allows

**Client Config:**
- Client-local bridge prompt overrides (global + per-program)
- Appended at job submit time without modifying server scripts

### Settings

- **Server connection** — URL, test connection, sign out
- **Local server management** — configurable port, start/stop, status
- **Desktop startup** — auto-launch on system boot
- **Client-side coordination** — local capability summary (CPU/RAM/GPU/models), opt-in toggle
- **Local Models (Ollama)** — browse/pull models on desktop or server, endpoint diagnostics

## Key Features

### Local Server Mode

The desktop app bundles the server as a compiled sidecar binary. No Bun or Node.js needed in production. It auto-starts on launch and auto-detects if a server is already running on the configured port.

You can also run the server externally (`pnpm server` or standalone binary) and the client will detect and connect to it.

### System Tray

- Close-to-tray behavior (window hides instead of quitting)
- Tray menu: Show/Hide/Quit
- Left-click restores the window

### Auto-Updates

The client checks for updates on startup and provides a download/install flow when a new version is available.

### Shared Config

On every successful login, the client writes `~/.arkestrator/config.json` containing the server URL, API key, worker name, and machine ID. All bridges on the same machine read this file to auto-connect — no manual bridge configuration needed.

For remote server connections, the client also starts a localhost relay so bridges only need to reach `127.0.0.1`.
