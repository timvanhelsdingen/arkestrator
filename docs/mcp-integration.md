# MCP Integration

Arkestrator exposes a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that allows external AI tools to interact with bridges, manage jobs, and query skills.

## What Is the MCP Endpoint

The server mounts an MCP endpoint at `POST /mcp`. Any MCP-compatible client (Claude Code, Codex, or custom tooling) can connect to it and call tools that execute scripts in DCC apps, spawn sub-jobs, read files from client machines, and more.

The MCP implementation is **stateless** — each request creates a fresh MCP server and transport. There are no persistent sessions or SSE streams. This avoids shared-state issues with concurrent connections.

## Authentication

All MCP requests require authentication via a Bearer token in the `Authorization` header.

### API Key

Create an API key with the **MCP** role in **Admin > API Keys**:

```
Authorization: Bearer ark_your_api_key_here
```

The API key must have the `useMcp` permission enabled. Additional tool-level permissions are checked per call (e.g., `executeCommands` for bridge tools, `submitJobs` for job creation).

### Session Token

Logged-in users can also authenticate with their session cookie. The desktop client uses this path when embedding MCP calls.

### Auto-User Keys

When Arkestrator spawns an agent as a subprocess, it generates a scoped API key (`auto:user:<userId>`) that inherits the owning user's `useMcp` permission. This key is injected into the agent's `.mcp.json` and automatically cleaned up after the job completes.

## Available Tools

The MCP server exposes the following tools:

### Bridge Command Tools

| Tool | Description | Permission |
|---|---|---|
| `execute_command` | Execute a script in a connected DCC bridge (GDScript for Godot, Python for Blender/Houdini). Blocks until completion. | `executeCommands` |
| `execute_multiple_commands` | Execute multiple scripts in sequence on a bridge. | `executeCommands` |
| `read_client_file` | Read a file from the client machine where a bridge is running. Images are saved locally; text is returned directly. | `executeCommands` |
| `list_bridges` | List all currently connected DCC bridges. | -- |
| `list_targets` | List available execution targets: connected bridges and enabled headless programs. | -- |
| `get_bridge_context` | Get editor context from a bridge — active file, selected nodes, project path, context items. | -- |
| `run_headless_check` | Run a DCC app in headless/CLI mode and capture stdout/stderr. Requires headless program registration. | `executeCommands` |

### Job Management Tools

| Tool | Description | Permission |
|---|---|---|
| `create_job` | Create a sub-job targeting a bridge or worker. Supports dependency chains, priority, and coordination script overrides. | `submitJobs` |
| `get_job_status` | Check a job's current status, duration, file changes, and output summary. | -- |
| `get_job_logs` | Fetch trailing log lines from a job (default 120, max 2000). | -- |
| `list_jobs` | List recent jobs with status, target, and timestamps. | -- |
| `cancel_job` | Cancel a queued, paused, or running job. Running jobs are terminated. | `submitJobs` |
| `list_agent_configs` | List available agent configurations (engine, model, priority). | -- |

### Intervention Tools

| Tool | Description | Permission |
|---|---|---|
| `submit_job_intervention` | Send operator guidance to a queued, paused, or running job. | `interveneJobs` |
| `list_job_interventions` | List intervention history and delivery state for a job. | -- |

### Skills Tools

| Tool | Description | Permission |
|---|---|---|
| `search_skills` | Search for skills and guidance by query, optionally filtered by program or category. | -- |
| `get_skill` | Fetch the full content of a skill by slug. | -- |
| `list_skills` | List all available skills, optionally filtered by program or category. | -- |

### Client API Forwarding

| Tool | Description | Permission |
|---|---|---|
| `client_api_request` | Call any client-safe REST endpoint through MCP. Supports job submission, training, project queries, and more. Restricted to an allowlist of safe paths. | varies |

## Using from Claude Code

To use Arkestrator's MCP tools from Claude Code, add the server to your `.mcp.json`:

```json
{
  "mcpServers": {
    "arkestrator": {
      "type": "http",
      "url": "http://localhost:7800/mcp",
      "headers": {
        "Authorization": "Bearer ark_your_api_key_here"
      }
    }
  }
}
```

Then Claude Code can call tools like `execute_command`, `list_bridges`, and `create_job` directly.

## Auto-Injected MCP

When Arkestrator spawns an agent subprocess (Claude Code, Codex, etc.), it **automatically writes a `.mcp.json`** in the agent's working directory. This file configures the `arkestrator` MCP server with:

- The server URL (`http://localhost:7800/mcp` or the appropriate endpoint)
- A scoped Bearer token tied to the job
- The job ID in an `X-Job-Id` header for parent-child tracking

This means agents spawned by Arkestrator can call back to the server to:

- Execute scripts in bridges (`execute_command`)
- Read files from client machines (`read_client_file`)
- Spawn sub-jobs for multi-bridge orchestration (`create_job`)
- Query skills for task-specific guidance (`search_skills`, `get_skill`)
- Send and receive interventions

If a `.mcp.json` already existed in the working directory, Arkestrator preserves the original content and merges the `arkestrator` server entry. The original is restored after the job completes.

## Security

### Permission Checks

Each MCP tool checks the caller's permissions before executing. The principal (user or API key) must have the relevant permission:

- `useMcp` — Required to access the MCP endpoint at all
- `executeCommands` — Required for bridge command execution and file reading
- `submitJobs` — Required for job creation and cancellation
- `interveneJobs` — Required for submitting job interventions

### Path Allowlist

The `client_api_request` tool restricts which server paths can be called. Only client-safe routes are allowed:

- `/api/jobs`, `/api/chat`, `/api/agent-configs`
- `/api/headless-programs`, `/api/skills`
- `/api/bridge-command`, `/api/workers`, `/api/projects`
- `/api/settings/coordinator-*` (scripts, playbooks, training)
- `/health`

Admin-only routes (user management, API key creation, policy changes) are blocked.

### Scoped Access

Auto-generated job API keys are scoped to the owning user's permissions. If the user does not have `useMcp`, the spawned agent cannot call MCP tools. Keys are cleaned up when the job completes.
