# Multi-Machine Deployment

Guide for running Arkestrator across multiple machines — server on one box, DCC apps on others, AI engines wherever you want.

## Architecture Recap

Arkestrator uses a hub-and-spoke model. The server is the central hub; desktop clients and DCC bridges connect to it over WebSocket.

```
                          ┌───────────────────────┐
                          │   Central Server      │
                          │   (Bun + SQLite)      │
                          │   AI CLIs installed    │
                          │   Port 7800            │
                          └──────┬───────┬────────┘
                                 │  WS   │
                ┌────────────────┘       └────────────────┐
                │                                         │
     ┌──────────▼──────────┐               ┌──────────────▼──────────┐
     │  Workstation A      │               │  Workstation B          │
     │  Desktop Client     │               │  Desktop Client         │
     │  Godot (bridge)     │               │  Blender (bridge)       │
     │  Blender (bridge)   │               │  Houdini (bridge)       │
     └─────────────────────┘               └─────────────────────────┘
```

All job orchestration flows through the server. Bridges are execution endpoints only — they push editor context and apply results. Desktop clients are the control panel where you submit prompts and monitor jobs.

## Step 1: Deploy the Server

The server needs to be reachable by all machines on your network (or over the internet). Two options:

### Docker (recommended)

```bash
docker compose up -d --build
```

The server listens on port `7800` by default. Set the `PORT` env var to change it.

For internet-facing deployments with HTTPS, see [Production Deployment (VPS + Caddy)](deployment-vps-caddy.md). Key settings when behind a reverse proxy:

```env
TRUST_PROXY_HEADERS=true
CORS_ORIGINS=https://your-domain.com,tauri://localhost,http://tauri.localhost
```

### Standalone Binary

Run directly with Bun on any machine:

```bash
bun run server/src/index.ts
```

Or use the production build. The server creates its data directory at `./data` by default (override with `DATA_DIR`).

### Verify

```bash
curl http://<server-ip>:7800/health
```

You should get a JSON health payload with HTTP 200.

## Step 2: Connect Desktop Clients

On each workstation that needs to interact with Arkestrator:

1. Launch the desktop client (Tauri app)
2. Open **Settings** and enter the server URL: `http://<server-ip>:7800` (or `https://your-domain.com` for HTTPS setups)
3. Log in with your credentials

On login, the client writes `~/.arkestrator/config.json`:

```json
{
  "serverUrl": "http://192.168.1.50:7800",
  "wsUrl": "ws://192.168.1.50:7800/ws",
  "apiKey": "am_...",
  "machineId": "a1b2c3d4-...",
  "workerName": "artist-workstation"
}
```

This file is the shared config that bridges on the same machine read automatically. No manual bridge configuration needed.

## Step 3: Connect Bridges on Remote Machines

Bridges auto-discover the server from `~/.arkestrator/config.json`. Once a desktop client is logged in on a machine, every bridge on that machine picks up the connection details automatically.

### Localhost Relay

When the desktop client connects to a **remote** server, it starts a localhost relay on `127.0.0.1`. Bridges connect to this relay instead of reaching the remote server directly. This solves two problems:

- DCC apps with restricted networking (sandboxed Python, corporate firewalls) only need localhost access
- No need to configure each bridge with the remote server URL

The relay is transparent — bridges see `ws://127.0.0.1:7800/ws` in the config and connect through the desktop client's relay, which forwards to the actual server.

If the relay goes down (e.g., desktop client closes), bridges fall back to the remote server URL directly with exponential backoff.

### Manual Bridge Configuration

If no desktop client is running on a machine (e.g., a headless render node), create `~/.arkestrator/config.json` manually:

```json
{
  "serverUrl": "http://192.168.1.50:7800",
  "wsUrl": "ws://192.168.1.50:7800/ws",
  "apiKey": "am_your-worker-api-key",
  "machineId": "render-node-01-uuid",
  "workerName": "render-node-01"
}
```

Generate an API key with the `worker` role from the Admin panel (**Admin > API Keys**).

## Workers and Machine Identity

All connections from a single machine appear as one **worker** in the Arkestrator UI.

| Field | Source | Purpose |
|---|---|---|
| `workerName` | Set in desktop client Settings | Human-readable name shown in the UI and used for job targeting |
| `machineId` | Auto-generated UUID | Stable identifier that survives renames; written to `config.json` on first login |

The desktop client writes both values to `~/.arkestrator/config.json`. Every bridge on that machine reads the same file, so a Godot bridge and a Blender bridge on the same workstation share one worker identity.

Workers are persistent records in the database. They survive server restarts. Online/offline status is computed from active WebSocket connections — a worker is online when any bridge or desktop client from that machine is connected.

## Job Targeting

Jobs can target a specific worker by name. The scheduler only dispatches targeted jobs to matching workers.

Use cases:

- Route Blender renders to a machine with a powerful GPU
- Keep Godot editing jobs on the workstation where the project lives
- Send batch processing to a headless render node
- Isolate experimental work to a test machine

Set the target worker when submitting a job from the Chat page or via the API. Untargeted jobs run on the server itself (using whatever AI CLIs are installed there).

## Workspace Mode Considerations

The workspace mode determines how the AI agent interacts with project files. In a multi-machine setup, the mode matters more:

| Mode | When it applies | Multi-machine behavior |
|---|---|---|
| **repo** | Project directory exists on the server's filesystem | Agent edits files directly. Only works when the project is local to the server. |
| **command** | Bridge is on a remote machine, or no project path is accessible | Agent outputs scripts (GDScript, Python, HScript) that the bridge executes inside the DCC app. Default for remote bridges. |
| **sync** | Files were attached to the job but no local project path exists | Files are staged on the server, agent edits them, diffs are sent back to the bridge. |

For remote workstations, most jobs will use **command** mode. The agent generates scripts that the bridge runs inside the DCC app. If you need **repo** mode across machines, the project must be on a shared filesystem that the server can access.

## Example Topologies

### Solo Workstation (All Local)

Everything on one machine. Server, desktop client, DCC apps, and AI CLIs all run locally.

```
┌─────────────────────────────┐
│  Your Machine               │
│  Server (localhost:7800)    │
│  Desktop Client             │
│  Godot + bridge             │
│  Blender + bridge           │
│  Claude Code, Codex, etc.   │
└─────────────────────────────┘
```

Bridges connect via `127.0.0.1`. Repo mode works because everything shares the same filesystem. This is the default out-of-the-box experience.

### Home Network (Server on NAS)

Server runs on a NAS or always-on machine. Workstations connect over the local network.

```
┌──────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│  NAS / Server    │  LAN  │  Desktop (macOS)   │  LAN  │  Laptop (Windows)  │
│  Docker          │◄──────┤  Client + Godot    │       │  Client + Blender  │
│  AI CLIs         │◄──────┼────────────────────┼───────┤                    │
│  Port 7800       │       └────────────────────┘       └────────────────────┘
└──────────────────┘
```

- Server URL: `http://nas-hostname:7800`
- Command mode for most jobs (projects live on workstations, not the NAS)
- Repo mode if you mount a shared NFS/SMB volume on both the server and the workstation

### Studio (Central Server + Render Farm)

Central server with multiple artist workstations and dedicated render nodes.

```
                    ┌───────────────────────┐
                    │  Production Server    │
                    │  Docker + Caddy HTTPS │
                    │  All AI CLIs          │
                    │  studio.internal:443  │
                    └──┬────┬────┬────┬─────┘
                       │    │    │    │
          ┌────────────┘    │    │    └────────────┐
          │                 │    │                  │
┌─────────▼──────┐  ┌──────▼────▼──────┐  ┌───────▼──────────┐
│ Artist WS 1    │  │ Artist WS 2      │  │ Render Nodes     │
│ Godot + Client │  │ Blender + Client │  │ Blender headless │
│ "ws-artist-1"  │  │ "ws-artist-2"    │  │ "render-farm-01" │
└────────────────┘  └──────────────────┘  └──────────────────┘
```

- HTTPS via Caddy reverse proxy (see [deployment guide](deployment-vps-caddy.md))
- Render nodes have no desktop client — `config.json` is created manually with a `worker` API key
- Job targeting routes GPU-heavy work to render nodes by worker name
- Artists submit all jobs from their desktop clients

## Networking

### Ports

| Port | Protocol | Purpose |
|---|---|---|
| `7800` | HTTP + WebSocket | Default server port. REST API, WebSocket (`/ws`), Admin panel (`/admin`), MCP (`/mcp`) |
| `80` / `443` | HTTP / HTTPS | When using a reverse proxy (Caddy, nginx) for TLS termination |

Change the server port with the `PORT` environment variable.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7800` | Server listen port |
| `CORS_ORIGINS` | (empty) | Comma-separated allowed origins. Set to your domain + `tauri://localhost` for remote clients |
| `TRUST_PROXY_HEADERS` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` headers. Enable only behind a trusted reverse proxy |
| `TLS_CERT_PATH` | (none) | Path to TLS certificate for direct HTTPS (no reverse proxy) |
| `TLS_KEY_PATH` | (none) | Path to TLS private key |
| `NO_SHARED_CONFIG` | (none) | Set to `1` to prevent the server from writing `~/.arkestrator/config.json`. Useful for dev servers that shouldn't steal bridges from a primary instance |

### Firewall Rules

For LAN deployments, open port `7800` (TCP) on the server machine. All communication is HTTP + WebSocket on this single port.

For internet-facing deployments behind a reverse proxy, open ports `80` and `443` instead and keep `7800` firewalled to localhost only.

### DNS and mDNS

On a home network, the server writes `os.hostname()` into the shared config so bridges on other machines can resolve it via mDNS (e.g., `my-nas.local`). If mDNS is unreliable, use the server's static IP address in the desktop client's server URL setting.

## Troubleshooting

**Bridges won't connect to a remote server**
Check that `~/.arkestrator/config.json` has the correct `serverUrl` and `wsUrl`. If the desktop client is running, it should handle this automatically via the localhost relay. Verify the server port is reachable: `curl http://<server-ip>:7800/health`.

**Worker shows as offline**
The worker status is based on active WebSocket connections. If all bridges and the desktop client disconnect, the worker goes offline. Check bridge logs in the DCC app for connection errors.

**Repo mode not available for remote projects**
Repo mode requires the project directory to exist on the server's filesystem. For cross-machine setups, use command mode (default) or mount a shared filesystem.

**Multiple servers on one machine**
Each server checks if it "owns" `~/.arkestrator/config.json` by matching the port. If you run a second server on a different port, it skips writing the config to avoid stealing bridges. Set `NO_SHARED_CONFIG=1` on dev/secondary instances.
