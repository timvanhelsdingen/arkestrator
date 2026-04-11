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

**Skills** are learned patterns — naming conventions, tool usage, project structure, common workflows — stored in a searchable knowledge base. When you submit a job, Arkestrator automatically finds and injects relevant skills into the agent's context. Rate the outcome, and the system learns what works and what doesn't.

Point Arkestrator at a project folder and it analyzes your existing work to bootstrap skills before you even submit your first job. Browse and install community-contributed skills from [arkestrator.com](https://arkestrator.com), or publish your own. See [Skills](docs/skills.md) and [Coordinator](docs/coordinator.md) for the full picture.

## Why Not Just Use Claude Code / Codex / MCP Directly?

Those tools are great — Arkestrator makes them better:

| | Raw CLI Agent | MCP-Only | Arkestrator |
|---|---|---|---|
| Works inside DCC apps | No | Limited | Yes — DCC bridges + API bridges |
| Job queue with priorities | No | No | Yes — dependencies, retries, sub-jobs, pause/resume |
| Multi-machine routing | No | No | Yes — DCC on workstation, AI on server |
| Live editor context | No | Manual | Automatic — selected nodes, open scenes, scripts |
| Learns from your projects | No | No | Yes — skills, training, effectiveness tracking |
| Multiple AI engines | One at a time | One at a time | Any engine, hot-swap per job, auto-routing |
| Generative API services | No | No | Yes — Meshy, Runway, Flux, ComfyUI, and more |
| Community skills | No | No | Yes — browse, install, and share from arkestrator.com |
| Team controls | No | No | Users, API keys, 2FA, policies, audit log |

Arkestrator also exposes its own **MCP endpoint**, so external AI clients (like Claude Code) can submit jobs and execute bridge commands through the standard protocol.

## How It Works

Three components, connected over WebSocket:

1. **Server** — Manages the job queue, spawns AI agents, routes commands, enforces policies, runs training
2. **Client** — Desktop app. Submit prompts, chat with agents, monitor jobs, manage skills, train on your projects
3. **Bridges** — Lightweight plugins inside each DCC app (or API integrations for generative services) that push context and apply results

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
                    └─────┬────────┬───────┘
                          │        │
          ┌───────────────┘        └───────────────┐
          │            DCC Bridges                  │       API Bridges
          │                                        │
    ┌─────┴─────┐ ┌────────┐ ┌─────────┐    ┌─────┴──────┐ ┌─────────┐
    │  Godot    │ │Blender │ │Houdini  │    │  Unreal    │ │  Unity  │
    │  (bridge) │ │(bridge)│ │(bridge) │    │  (bridge)  │ │ (bridge)│
    └───────────┘ └────────┘ └─────────┘    └────────────┘ └─────────┘
    ┌───────────┐ ┌────────┐ ┌─────────────────────────────────────────┐
    │  Fusion   │ │ComfyUI │ │  Meshy · Runway · Flux · Kling · Luma  │
    │  (bridge) │ │(bridge)│ │  Ideogram · Tripo · ElevenLabs · Suno  │
    └───────────┘ └────────┘ └─────────────────────────────────────────┘

  AI Engines: Claude Code · Codex · Gemini · Grok · Ollama · Any CLI
```

1. **Install a bridge** in your DCC app. It auto-discovers the server and connects.
2. **Submit a prompt** from the desktop client. Pick an AI engine and target bridge.
3. **The agent executes** with full context: your prompt, editor state, coordinator scripts, and matched skills.
4. **Results flow back** — file changes applied in your DCC app, commands executed in the editor, logs streaming live.

## Key Features

### Orchestration

Multi-engine support (Claude Code, Codex, Gemini, Grok, Ollama, any CLI agent), auto-routing that picks the right engine based on prompt complexity, fallback chains for escalation from local to cloud, job queue with priorities, dependencies, sub-jobs, retries, and pause/resume. Agents can spawn child jobs and coordinate across multiple bridges. Three workspace modes (`repo`, `command`, `sync`) for different execution strategies. Headless execution for background/CLI workflows. [Details](docs/how-it-works.md)

### Bridges

Seven DCC bridges — Godot, Blender, Houdini, Unreal Engine, Unity, Fusion/DaVinci Resolve, and ComfyUI — with a growing library. Bridges push live editor context (selected nodes, open scenes, active scripts) every few seconds, support right-click context menu integration, and enable cross-bridge commands so an agent working in one app can trigger actions in another. The desktop client includes a built-in bridge installer that auto-detects your DCC installations for one-click setup. Bridges are straightforward to build, and contributions are welcome at the [bridge repo](https://github.com/timvanhelsdingen/arkestrator-bridges). [Details](docs/usage-bridges.md)

### API Bridges

Webhook integrations for generative AI services — Meshy (3D), Runway (video), Flux (images), Kling AI (video), Luma AI (video & 3D), Ideogram (images), Tripo (3D), ElevenLabs (audio), Suno (music), and ComfyUI (generative workflows). API bridges support async polling for long-running generation tasks and return downloadable output files. Configure preset or custom integrations with flexible auth and endpoint templates.

### MCP Server Presets

One-click install for common Model Context Protocol servers — Filesystem (scoped asset access), GitHub (issues/PRs/releases), Context7 (up-to-date library docs), Fetch (web pages), Memory (knowledge graph), and Brave Search — alongside the custom MCP bridge form. Presets pre-fill the command, args, and env, show inline setup notes and upstream docs links, and are available from both the bootstrap wizard and the Settings → Bridges → MCP tab.

### Skills & Training

A self-improving skill system that learns from your projects. Skills are ranked using a hybrid algorithm (50% lexical, 30% semantic, 20% effectiveness) and automatically injected into agent context at job time. The training pipeline analyzes your project files and extracts patterns into new skills, with three intensity levels and configurable scheduling. Coordinator scripts (global and per-program) define execution policies, and playbooks provide per-program task libraries matched semantically against your prompts. Effectiveness tracking records how well each skill performs, with a graduated confidence model that balances exploration and exploitation. [Details](docs/skills.md)

### Community Skills

Browse, search, and install community-contributed skills from [arkestrator.com](https://arkestrator.com). Multi-select batch installation with automatic dependency resolution. Publish your own skills back to the community. Update detection keeps your installed skills current.

**Prompt-injection defense.** Community skills are submitted by third parties on GitHub and skill content lands directly in agent prompts, so each one is treated as an untrusted prompt-injection vector. Arkestrator applies a layered defense out of the box: (1) the publisher-side scanner on arkestrator.com blocks obvious jailbreak / shell-pipe-to-exec / credential-exfiltration patterns at submission and queues skills from low-trust authors for manual review; (2) on install, the local server re-runs a heuristic scanner as belt-and-suspenders, refuses skills with `pending_review`/`quarantined` trust tier, and refuses any response missing the trust-tier signal entirely (fail-closed); (3) community skills are never auto-injected into the system prompt — they only reach an agent via an explicit `search_skills`/`get_skill` call, and their content is wrapped in an "untrusted community content" frame telling the model to treat the body as advisory and refuse instructions to bypass safety; (4) admins can hard-disable community skills server-wide via the Admin panel — when on, the per-user toggle in every client is locked off and every community code path becomes a no-op. Community skills are **disabled by default** on the user side; opt in via `Settings → Community` after reading the in-app warning. The Admin → System page exposes the full policy, an effective-state banner, a counts strip (total / flagged / by trust tier), and a triage table to delete individual flagged skills or bulk-delete every flagged skill at once.

### Chat & Guidance

A conversational chat mode (SSE-based) for quick interactions without creating jobs — useful for brainstorming, asking questions, or getting suggestions with optional context from recent jobs. For running jobs, send real-time guidance (interventions) to steer the agent mid-execution.

### Client-Side Coordination

Run AI inference locally on your machine using Ollama models. The desktop client detects local hardware capabilities (CPU, RAM, GPU) and can run the agentic loop entirely on your machine — prompts never leave your network. Tool calls are still routed through the server's MCP endpoint for bridge access.

### Admin & Security

Web-based admin panel with user management, role-based API keys (admin/worker/client), TOTP 2FA with recovery codes, regex-based security policies (prompt filters, command filters, file path rules, engine restrictions), per-worker rules, token usage limits, and a full audit log. Configuration snapshots for backup and restore. [Details](docs/usage-server.md)

### MCP Integration

Arkestrator exposes an MCP endpoint with 18 tools covering bridge commands, job management, interventions, skills, and client API forwarding. Add Arkestrator to your Claude Code `.mcp.json` and submit jobs, execute DCC commands, or search skills from any MCP-compatible client. Spawned agents automatically get an MCP config injected so they can interact with bridges and create sub-jobs. [Details](docs/mcp-integration.md)

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
