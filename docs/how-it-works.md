# How It Works

## The Hub-and-Spoke Model

Arkestrator has three components that work together:

- **Server** — The central hub. Manages the job queue, spawns AI agents as subprocesses, routes results to bridges, handles authentication and policies. Runs on Bun + Hono + SQLite.
- **Desktop Client** — Your control panel. A native Tauri + Svelte 5 app where you submit prompts, monitor jobs, configure agents, and manage your setup. Connects to the server via REST + WebSocket.
- **Bridges** — Thin plugins inside each DCC app (Godot, Blender, Houdini, etc.). They push editor context to the server and execute results (file changes, scripts) when jobs complete. Bridges have no job submission UI — all orchestration happens through the desktop client.

The client writes `~/.arkestrator/config.json` on login. Bridges on the same machine auto-discover this file to get the server URL, API key, worker name, and machine identity. No manual bridge configuration needed.

## A Job From Start to Finish

Here's what happens when you submit a prompt:

**1. Bridges push context continuously**

Your DCC app's bridge plugin connects to the server on startup and pushes editor context every few seconds — active scene, selected nodes, open scripts, project path. This context is stored in memory on the server, ready for any job.

**2. Submit from the desktop client**

In the Chat page, you write a prompt like *"add a health bar to the player HUD"*. You pick an agent config (Claude Code, Codex, Ollama, or Auto), optionally target a specific worker/bridge, set priority, and hit **Add to Queue** or **Queue and Start**.

The client sends a REST request to `POST /api/jobs` with the prompt, selected agent, bridge context, attached files, runtime options (model override, reasoning level, verification mode), and any coordinator scripts.

**3. Server validates and queues**

The server checks your auth token, validates the payload against Zod schemas, runs policy checks (prompt filters, allowed engines/models, file path rules), and persists the job in SQLite with status `queued`.

**4. Worker loop claims the job**

The server's worker loop polls every 500ms for eligible jobs. It checks priority ordering, dependency chains, concurrency limits (`MAX_CONCURRENT_AGENTS`, default 8), and per-user token quotas. When a slot opens, it claims the job (status → `running`).

**5. Workspace mode resolution**

The resolver decides how the agent should interact with files:
- **`repo`** — Direct file access (project is on the server's filesystem)
- **`command`** — Execute scripts inside the DCC app via the bridge
- **`sync`** — Upload files to a temp directory, agent edits there, diff sent back

See [Workspace Modes](#workspace-modes) below for details.

**6. Agent spawned as subprocess**

The server builds a CLI command for the configured engine and spawns it via `Bun.spawn`:

```bash
# Example for Claude Code
claude -p "..." --model claude-sonnet-4-6 --mcp-config .mcp.json

# Example for Codex
codex --prompt "..." --model o4-mini
```

The agent runs with the project directory as cwd (in repo mode), or a temp sync directory, and gets injected MCP configuration pointing back to the Arkestrator server so it can call bridge commands and other tools.

**7. Live log streaming**

Agent stdout/stderr are piped in real-time to all connected clients via WebSocket `job_log` messages. You see the agent's thinking and actions live in the desktop client's Chat or Jobs page.

**8. Results delivered**

When the agent exits, the server records the result and sends `job_complete` to relevant bridges. Depending on workspace mode:
- **Repo**: Files were edited directly — the bridge reloads the scene
- **Command**: The bridge executes the agent's output scripts (GDScript, Python, HScript) inside the DCC app
- **Sync**: File diffs are sent to the bridge for application

Token usage (input/output/cost) is recorded for auditing.

## The Self-Improvement Loop

What makes Arkestrator different from a one-shot AI tool is the feedback cycle. Every job contributes to a growing knowledge base that makes future jobs better.

```
  Submit prompt ──▶ Agent runs with ──▶ You rate the
                    matched skills       outcome
        ▲                                    │
        │                                    ▼
  Next prompt gets              Training extracts
  better context ◀──────────── patterns into skills
```

### How It Works

1. **Skills are injected at job time.** When a job is spawned, the server's skill index searches for relevant skills by program, keywords, and content similarity. Matched skills are injected into the agent's context alongside coordinator scripts and playbook guidance.

2. **You rate outcomes.** After a job completes, you can rate it (positive, average, negative) and optionally add notes. This takes a couple seconds and has outsized impact.

3. **Ratings propagate to skills.** Every skill that was injected into a job gets tagged with that job's outcome. Over time, each skill accumulates a success rate. Skills that consistently help produce good outcomes rise in priority; skills correlated with poor outcomes can be flagged or disabled.

4. **Training creates new skills.** Point Arkestrator at a project folder, and the training pipeline analyzes your existing code to extract conventions, patterns, and tool usage. These become new skills that future agents receive automatically.

5. **The cycle repeats.** Each new job gets the benefit of all previous outcomes. The more you use Arkestrator, the more it knows about how you work.

See [Skills System](skills.md) for skill structure and management, and [Coordinator & Training](coordinator.md) for the full training pipeline.

## Workspace Modes

### `repo` — Direct File Editing

The agent works directly in a project directory on the server's filesystem. Fastest mode — no file transfer overhead.

**When selected:** Project path exists on the server filesystem, or a project mapping resolves to a local path.

**Example:** Godot and the server run on the same workstation. The agent edits `player/hud.gd` directly. The bridge detects changes and reloads the scene.

### `command` — In-App Script Execution

The agent outputs commands (GDScript, Python, HScript) that the bridge executes inside the DCC app's runtime.

**When selected:** No project path is accessible on the server, bridge is on a different machine, or explicitly requested. Bridge-targeted jobs from the Chat page default to this mode.

**Example:** Your Blender is on a laptop, the server is remote. The agent outputs Python commands that Blender's bridge executes via `exec()`, creating objects and modifying the scene directly.

### `sync` — Upload, Edit, Diff Back

Files are uploaded to a staging directory on the server. The agent edits there. Changes are diffed and sent back to the bridge.

**When selected:** Job has attached files but no project path is accessible. Useful for remote editing of specific files.

**Example:** You attach a few scripts from Houdini. The server copies them to `sync-tmp/<jobId>/`, the agent edits them, and only the changed portions are sent back.

### Mode Resolution Order

The workspace resolver follows this priority:

1. Job explicitly requests a `preferredMode` → use it
2. Server has a non-auto `DEFAULT_WORKSPACE_MODE` → use it
3. No `projectRoot` provided → `command`
4. Bridge-targeted job without explicit project selection → `command`
5. `projectRoot` exists on the server filesystem → `repo`
6. Job has attached files → `sync`
7. Fallback → `command`

## Multi-Machine Setup

Arkestrator is designed for distributed setups where your DCC apps, AI engines, and server run on different machines.

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────┐
│  Workstation │  WS     │  Build Server    │  WS     │  Render Node │
│              ├────────►│                  │◄────────┤              │
│  Godot       │         │  Arkestrator     │         │  Blender     │
│  Client      │         │  Server + AI CLIs│         │  (bridge)    │
│  (bridge)    │         │                  │         │              │
└──────────────┘         └──────────────────┘         └──────────────┘
```

### Workers

- **Workers** are persistent records identified by machine name and a UUID-based `machineId`. They survive server restarts.
- **Status** is computed from active connections — a worker is online when any bridge or desktop client from that machine is connected.
- The desktop client writes the canonical `workerName` and `machineId` to `~/.arkestrator/config.json`. All bridges on the same machine follow this identity, so they appear as one worker in the UI.

### Job Targeting

Jobs can target specific workers by name. The scheduler only dispatches targeted jobs to matching workers. This lets you:
- Run Blender jobs only on the machine with Blender installed
- Route GPU-heavy work to your render node
- Keep certain operations on specific machines

### Localhost Relay

When the desktop client connects to a remote server, it starts a localhost relay so same-machine bridges can connect via `127.0.0.1` instead of needing direct access to the remote server. This solves cases where DCC apps can't easily reach external hosts.

## Auto-Routing

When you set the agent to "Auto", the server picks the best engine based on prompt complexity:

- **Simple prompts** (short, single-task) → routed to local-oss (Ollama) if available
- **Complex prompts** (multi-file, architectural, security-related) → routed to cloud engines
- **Fallback chains** — each agent config can specify a fallback, creating escalation paths (e.g., try local first, fall back to Claude Code)

## Running-Job Guidance (Interventions)

You can send notes to running agents mid-execution:

- **From the Chat page**: Type guidance in the same composer while a job is running
- **From the Jobs page**: Use the dedicated guidance composer in the job detail panel
- **From MCP**: External tools can send interventions via the MCP endpoint

For local-oss agents, guidance is piped to process stdin in real-time. For cloud agents (Claude Code, Codex), the agent polls for new interventions during execution.

## Coordinator System

The coordinator improves agent quality by injecting context and learned patterns into prompts:

### Scripts
Global and per-program instructions prepended to every agent run. Example: "Always use @export annotations in GDScript" or "In Houdini, use VEX for performance-critical operations."

### Playbooks
Task-specific guidance organized by program. Playbooks contain tasks, reference paths, and examples. The server semantically matches playbook content to the job prompt.

### Training
The training system learns from job outcomes:
- Users mark completed jobs as Good/Average/Poor with optional notes
- Training runs analyze outcomes and refine playbook guidance
- Training data can be exported, imported, and shared across instances
- Scheduled training runs can be configured by admins

### Client-Side Coordination
Admins can enable client-side coordination, which lets the desktop client run parts of the orchestration locally (e.g., running local LLM agentic loops on the desktop machine's GPU) instead of everything going through the server.

## Security Model

### Authentication
- **User accounts** with Argon2 password hashing and optional TOTP 2FA
- **Session tokens** for REST/WebSocket access (configurable TTL, default 30 days)
- **API keys** with role-based access: `admin`, `worker`, or `client`
- Bridges auto-discover API keys from the shared config — no manual key entry

### Policies
Four types of regex-based restrictions:
- **Prompt filters** — Block or warn on specific prompt patterns
- **Command filters** — Restrict what scripts can be executed
- **File path rules** — Control which files agents can access
- **Engine/model restrictions** — Limit which AI engines or models can be used

### Worker Rules
Per-machine controls: ban specific workers, restrict client coordination, configure IP allow/deny lists, enable/disable local LLM routing.

### Audit Logging
All administrative actions (user management, settings changes, policy updates, connection kicks) are logged with username, IP, timestamp, and action details.

### Resource Control
- **GPU gating**: One local-oss job per worker to prevent GPU OOM
- **Token limits**: Per-user daily/monthly/unlimited quotas
- **Concurrency limits**: Configurable max parallel agents
- **Job timeouts**: Auto-kill after configurable timeout (default 30 minutes)
- **Rate limiting**: Per-key job submission rate limits

## Headless Execution

Bridges normally run inside a GUI DCC app. But Arkestrator also supports headless execution — running Blender, Houdini, or Godot CLI commands without a GUI bridge being connected.

The server can dispatch headless commands to the desktop client, which runs them locally (e.g., `blender --headless --python script.py`). This is useful for batch rendering, automated exports, or operations that don't need the DCC app's UI.

## Cross-Bridge Commands

Bridges can send commands to each other through the server. For example:
- A Blender bridge can send GDScript to a Godot bridge
- An AI agent can execute Python in Blender and GDScript in Godot as part of the same job
- ComfyUI workflows can be triggered from any bridge

Commands are routed by program name, and the server handles matching, multicasting, and collecting results.

## MCP Integration

The server exposes an MCP endpoint at `/mcp` that external AI clients can use. This means:
- Claude Code or Codex sessions (spawned by Arkestrator or running independently) can call back into Arkestrator to submit jobs, list bridges, execute bridge commands, and query job status
- Any MCP-compatible tool can integrate with Arkestrator
- Authentication is via Bearer token + Job ID header
