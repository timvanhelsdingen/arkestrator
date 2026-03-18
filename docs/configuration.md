# Configuration

All server configuration is through environment variables. For Docker, set these in your `.env` file or container environment. For local dev, export them in your shell or use a `.env` file in the server directory.

## Example Production Config

```env
PORT=7800
DB_PATH=/data/arkestrator.db
MAX_CONCURRENT_AGENTS=4
JOB_TIMEOUT_MS=1800000
LOG_LEVEL=info
DEFAULT_WORKSPACE_MODE=auto
COORDINATOR_SCRIPTS_DIR=/data/coordinator-scripts
COORDINATOR_PLAYBOOKS_DIR=/data/coordinator-playbooks
TRUST_PROXY_HEADERS=true
CORS_ORIGINS=https://your-domain.com,tauri://localhost
```

## Core Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7800` | HTTP/WebSocket listen port |
| `DATA_DIR` | `./data` | Base directory for database, sync temp, coordinator data |
| `DB_PATH` | `{DATA_DIR}/db/arkestrator.db` | SQLite database file path |
| `MAX_CONCURRENT_AGENTS` | `8` | Maximum simultaneous agent subprocesses |
| `WORKER_POLL_MS` | `500` | Queue polling interval in milliseconds (adaptive: 250ms-4000ms) |
| `JOB_TIMEOUT_MS` | `1800000` (30 min) | Maximum time for a single job before it is killed |
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |

## Workspace and File Sync

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_WORKSPACE_MODE` | `auto` | Default mode for jobs: `auto`, `command`, `repo`, or `sync` |
| `SYNC_TEMP_DIR` | `{DATA_DIR}/sync-tmp` | Directory for sync mode temp workspaces |
| `SYNC_TTL_MS` | `1800000` (30 min) | How long sync temp files are kept before cleanup |
| `SYNC_MAX_SIZE_MB` | `500` | Max total size of uploaded files per sync job |

## Headless Execution

| Variable | Default | Description |
|---|---|---|
| `HEADLESS_TEMP_DIR` | `{DATA_DIR}/headless-tmp` | Temp directory for headless program execution |
| `COMFYUI_URL` | — | ComfyUI server URL for headless ComfyUI execution |
| `SEED_EXAMPLE_HEADLESS_PROGRAMS` | `false` | Create example headless program entries on first startup |
| `HEADLESS_EXECUTABLE_HINTS_JSON` | — | JSON map of program names to executable paths |

Example `HEADLESS_EXECUTABLE_HINTS_JSON`:

```json
{
  "godot": ["/usr/bin/godot"],
  "blender": ["/usr/bin/blender"],
  "houdini": ["/opt/hfs21.0/bin/hython"]
}
```

## Coordinator

| Variable | Default | Description |
|---|---|---|
| `COORDINATOR_SCRIPTS_DIR` | `{DATA_DIR}/coordinator-scripts` | Directory for global and per-program coordinator scripts |
| `COORDINATOR_PLAYBOOKS_DIR` | `{DATA_DIR}/coordinator-playbooks` | Directory for playbook manifests and task guidance |
| `COORDINATOR_REFERENCE_PATHS` | — | Additional reference paths for coordinator context |
| `COORDINATOR_PLAYBOOK_SOURCE_PATHS` | — | Source paths for playbook discovery |

## Security and Networking

| Variable | Default | Description |
|---|---|---|
| `TLS_CERT_PATH` | — | TLS certificate path (for direct HTTPS without a reverse proxy) |
| `TLS_KEY_PATH` | — | TLS private key path |
| `CORS_ORIGINS` | `localhost:1420,localhost:5173,tauri://localhost` | Comma-separated allowed origins for CORS |
| `TRUST_PROXY_HEADERS` | `false` | Trust `X-Forwarded-*` headers. **Only enable behind a trusted reverse proxy** (Caddy, nginx). |

## Bootstrap

| Variable | Default | Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | Username for the auto-created admin account |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(random)* | Password for the admin account. If not set, a random password is generated and written to `bootstrap-admin.txt` beside the database. |

## Runtime Settings (Admin Panel)

In addition to environment variables, many settings can be changed at runtime through the Admin panel or the `/api/settings` API:

- **CORS origins** — allowed origins for cross-origin requests
- **Default workspace mode** — override the env var at runtime
- **Allow client-side coordination** — enable/disable client-dispatched local LLM jobs
- **Training repository policy** — controls for coordinator training data
- **Worker rules** — per-machine configuration (local LLM endpoints, bans, IP lists)
- **Server local LLM endpoint** — base URL for the server's own Ollama instance

## Secret Handling

- Never commit API keys, tokens, or `.mcp.json` files to the repository
- Bridge config files (`~/.arkestrator/config.json`) are local machine artifacts — don't share them
- In production, use environment variables or a secret manager for sensitive values
- The bootstrap password file (`bootstrap-admin.txt`) is created with `0600` permissions
