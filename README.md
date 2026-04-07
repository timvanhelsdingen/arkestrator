# Arkestrator

![Arkestrator](docs/assets/arkestrator-logo_brandname.svg)

**Tell an AI to build a health bar in Godot, rig an explosion in Houdini, model a donut in Blender — and watch it happen inside the editor, using your project's own conventions, getting smarter every time it learns how you work.**

Arkestrator is an open-source orchestration layer that puts AI agents to work directly inside your creative tools. Connect any application that has a bridge to the network, and the AI can operate across them — even across different machines. The server handles queuing, routing, and context; your clients connect to submit tasks and receive results.

> Pre-release software. See [DISCLAIMER.md](DISCLAIMER.md).

## It Gets Better the More You Use It

Most AI coding tools are stateless — they forget everything between sessions. Arkestrator learns from every job:

```
  ┌─────────────┐     ┌──────────────┐     ┌────────────────┐
  │  You submit  │────▶│  Agent runs   │────▶│  You rate the  │
  │  a prompt    │     │  with skills  │     │  outcome       │
  └─────────────┘     └──────────────┘     └───────┬────────┘
        ▲                                          │
        │                                          ▼
  ┌─────┴─────────┐                       ┌────────────────┐
  │  Next prompt   │◀─────────────────────│  Training       │
  │  gets better   │                      │  extracts       │
  │  context       │                      │  patterns into  │
  └───────────────┘                       │  new skills     │
                                          └────────────────┘
```

**Skills** are learned patterns — naming conventions, tool usage, project structure, common patterns — stored in a searchable knowledge base. When you submit a job, Arkestrator automatically finds and injects relevant skills into the agent's context. Rate the outcome, and the system learns what works and what doesn't.

Point Arkestrator at a project folder and it analyzes your existing work to bootstrap skills before you even submit your first job. See [Skills](docs/skills.md) and [Coordinator](docs/coordinator.md) for the full picture.

## Why Not Just Use Claude Code / Codex / MCP Directly?

Those tools are great — Arkestrator makes them better:

| | Raw CLI Agent | MCP-Only | Arkestrator |
|---|---|---|---|
| Works inside DCC apps | No | Limited | Yes — official + community bridge plugins |
| Job queue with priorities | No | No | Yes — dependencies, retries, pause/resume |
| Multi-machine routing | No | No | Yes — DCC on workstation, AI on server |
| Live editor context | No | Manual | Automatic — selected nodes, open scenes, scripts |
| Learns from your projects | No | No | Yes — skills, training, effectiveness tracking |
| Multiple AI engines | One at a time | One at a time | Any engine, hot-swap per job |
| Team controls | No | No | Users, API keys, policies, audit log |

Arkestrator also exposes its own **MCP endpoint**, so external AI clients (like Claude Code) can submit jobs and execute bridge commands through the standard protocol.

## How It Works

Three components, connected over WebSocket:

1. **Server** — Manages the job queue, spawns AI agents, routes commands, enforces policies
2. **Client** — Desktop app. Submit prompts, monitor jobs, manage agents, train skills
3. **Bridges** — Lightweight plugins inside each DCC app that push editor context and apply results

```
                    ┌──────────────────────┐
                    │   Desktop Client     │
                    │  (Tauri + Svelte 5)  │
                    │                      │
                    │  Chat · Jobs · Admin │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   Arkestrator Server  │
                    │  (Bun + Hono + SQLite)│
                    │                      │
                    │  Queue · Route · Run │
                    │  Skills · Training   │
                    └──────────┬───────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │           │           │           │
     ┌─────▼─────┐ ┌──▼──┐ ┌─────▼─────┐ ┌──▼──────┐
     │   Godot   │ │Blender│ │  Houdini  │ │  More   │
     │  (bridge) │ │(bridge)│ │  (bridge) │ │ bridges │
     └───────────┘ └───────┘ └───────────┘ └─────────┘

  AI Engines: Claude Code · Codex · Gemini · Grok · Ollama · Any CLI
```

1. **Install a bridge** in your DCC app. It auto-discovers the server and connects.
2. **Submit a prompt** from the desktop client. Pick an AI engine and target bridge.
3. **The agent executes** with full context: your prompt, editor state, coordinator scripts, and matched skills.
4. **Results flow back** — file changes applied in your DCC app, commands executed in the editor, logs streaming live.

## Key Features

**Orchestration** — Multi-engine support (Claude Code, Codex, Gemini, Grok, Ollama, any CLI), auto-routing, job queue with priorities/dependencies/retries, multi-machine routing, three workspace modes, headless execution. [Details](docs/how-it-works.md)

**Bridges** — Various availble bridges for all types of different applications with a library that keeps growing. =  live editor context, cross-bridge commands, context menu integration, built-in bridge installer. [Details](docs/usage-bridges.md) Bridges are easy to build yourself with some technical knowhow, or with help of AI. Submit your own to the bridge repo, or improve ones that already exist.

**Skills & Training** — Self-improving skill system, training pipeline from project analysis, coordinator scripts per DCC app, playbook task templates, effectiveness tracking. [Details](docs/skills.md)

**Admin & Security** — Web admin panel, MCP endpoint, fine-grained permissions per user and API key, 2FA, audit logging. [Details](docs/usage-server.md)

## Install

### Desktop App

Download from [GitHub Releases](https://github.com/timvanhelsdingen/arkestrator/releases):

| Platform | Format |
|---|---|
| Windows | `.exe` installer (NSIS) |
| macOS | `.dmg` disk image |
| Linux | `.rpm`, `.deb`, `.AppImage` |

The desktop app bundles the server. Install, launch, and you're running.

### Linux Package Repos

Add the Arkestrator repo to your system for automatic updates via your package manager:

```bash
# Auto-detect distro and add repo
curl -fsSL https://timvanhelsdingen.github.io/arkestrator/install.sh | sudo bash
```

Or manually:

| Distro | Command |
|---|---|
| Fedora / RHEL | `sudo dnf config-manager addrepo --from-repofile=https://timvanhelsdingen.github.io/arkestrator/arkestrator.repo` |
| Debian / Ubuntu | See [setup instructions](https://timvanhelsdingen.github.io/arkestrator/) |
| Arch (AUR) | `yay -S arkestrator-bin` |

After adding the repo, install with `dnf install arkestrator`, `apt install arkestrator`, etc. Updates arrive automatically with your system updates.

### Other Options

- **Docker:** `docker pull ghcr.io/timvanhelsdingen/arkestrator:latest` — see [deployment docs](docs/deployment-vps-caddy.md)
- **Build from source:** requires Node.js 20+, pnpm, Bun, Rust — see [installation docs](docs/installation.md)

## First Run

1. Launch the app. The server starts automatically on port 7800.
2. Log in with the bootstrap credentials shown on the setup page.
3. Go to **Admin > Agents > Add from Template** to create your first agent.
4. Install a bridge in your DCC app — it auto-connects.
5. Submit your first prompt from the Chat page.

New to Arkestrator? Follow the **[Quick Start Guide](docs/quickstart.md)** for a 10-minute walkthrough.

## Documentation

**Start Here**
- [Quick Start Guide](docs/quickstart.md) — 10 minutes from install to your first AI-driven edit
- [How It Works](docs/how-it-works.md) — Hub-and-spoke model, job lifecycle, workspace modes

**Core Concepts**
- [Skills System](docs/skills.md) — How Arkestrator learns and improves
- [Coordinator & Training](docs/coordinator.md) — Scripts, playbooks, and the training pipeline

**Usage**
- [Desktop Client](docs/usage-client.md) — Using the Tauri desktop app
- [Server & API](docs/usage-server.md) — REST API, WebSocket protocol
- [Bridges](docs/usage-bridges.md) — Installing and using bridge plugins

**Advanced**
- [Local Models (Ollama)](docs/local-models.md) — Run AI locally with GPU gating
- [MCP Integration](docs/mcp-integration.md) — Use Arkestrator from Claude Code or other MCP clients
- [Multi-Machine Setup](docs/multi-machine.md) — Distributed deployments across workstations
- [Deployment](docs/deployment-vps-caddy.md) — Production Docker with HTTPS

**Reference**
- [Architecture](docs/architecture.md) — Component design and tech choices
- [Configuration](docs/configuration.md) — Environment variables reference
- [Troubleshooting](docs/troubleshooting.md) — Common issues and solutions
- [Bridge Development](docs/bridge-development.md) — Build a bridge for a new tool
- [Contributing](docs/contributing.md) — Developer workflow and standards

## Support the Project

If Arkestrator is useful to you, consider supporting development:

- [GitHub Sponsors](https://github.com/sponsors/timvanhelsdingen)
- [Ko-fi](https://ko-fi.com/timvanhelsdingen)
- [Patreon](https://patreon.com/timvanhelsdingen)

## License

MIT License. Provided "AS IS", without warranty. See [DISCLAIMER.md](DISCLAIMER.md).
