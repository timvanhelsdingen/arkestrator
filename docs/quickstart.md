# Quickstart

A 10-minute walkthrough from first launch to your first AI-driven change in a DCC app.

## Prerequisites

Before starting, you need:

1. **A DCC application** with an Arkestrator bridge available. This guide uses **Godot** as the example, but Blender, Houdini, Unreal, Unity, Fusion/DaVinci Resolve, and ComfyUI are also supported.
2. **An AI CLI tool** installed on the machine running the server. This guide uses **Claude Code** (`claude`). Codex (`codex`), Gemini (`gemini`), Grok (`grok`), and local models via Ollama are also supported.
3. **API credentials** for your chosen AI provider (e.g., an Anthropic API key for Claude Code, or an OpenAI key for Codex).

## 1. Launch the App

Download the desktop app from [GitHub Releases](https://github.com/timvanhelsdingen/arkestrator/releases) for your platform (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`/`.rpm`).

On first launch:

1. The app starts the server automatically on port 7800.
2. The setup page shows the path to `bootstrap-admin.txt` containing your initial admin credentials.
3. Log in with those credentials.

After login, the client writes `~/.arkestrator/config.json`. Bridges on the same machine auto-discover this file to connect to the server.

## 2. Set Up an Agent

Navigate to **Admin > Agent Configs** and create your first agent:

1. Click **Add from Template**.
2. Select **Claude Code**.
3. The template pre-fills the engine, command (`claude`), and default arguments.
4. Set a model (e.g., `claude-sonnet-4-6`) or leave the default.
5. Under **CLI Auth**, add your `ANTHROPIC_API_KEY` environment variable so the agent subprocess can authenticate.
6. Click **Save**.

Your agent config is now ready. You can create additional configs for other engines (Codex, Gemini, local-oss) later.

## 3. Install a Bridge

Bridges connect your DCC apps to Arkestrator. For Godot:

1. Download the bridge plugin from the [arkestrator-bridges repo](https://github.com/timvanhelsdingen/arkestrator-bridges).
2. Copy `godot/addons/arkestrator_bridge/` into your Godot project's `addons/` directory.
3. In Godot, go to **Project > Project Settings > Plugins** and enable **Godot Arkestrator Bridge**.
4. The bridge panel appears in the editor dock. With auto-connect enabled (default), it connects immediately.

You should see the bridge appear in the **Workers** page of the desktop client. A green indicator confirms the connection.

> **Tip:** The desktop client writes connection details to `~/.arkestrator/config.json`. Bridges auto-discover this file, so no manual URL or API key entry is needed.

## 4. Submit Your First Prompt

Go to the **Chat** page in the desktop client:

1. Type a prompt in the composer, for example:
   ```
   Add a health bar to the player HUD. Use a ProgressBar node, set it to
   show 100 HP, and style it with a red-to-green gradient.
   ```
2. Select your **Claude Code** agent config from the agent dropdown.
3. The bridge context panel on the right shows your Godot project's active scene, selected nodes, and open scripts. This context is automatically included with the job.
4. Optionally configure:
   - **Project** — select your Godot project if you have project mappings configured
   - **Worker** — leave on "Auto" to let the scheduler pick, or target a specific machine
   - **Priority** — normal is fine for most tasks; use high or critical to jump the queue
5. Click **Queue and Start**.

The job enters the queue and starts immediately if a worker slot is available.

### What Happens Behind the Scenes

When you submit a prompt:

1. The server validates your request and creates a job in the queue.
2. The worker loop claims the job and spawns a Claude Code subprocess.
3. The agent gets an auto-injected `.mcp.json` pointing back to the server, giving it access to bridge tools.
4. The agent reads bridge context (your scene tree, selected nodes, open scripts) and works on the task.
5. Depending on workspace mode, the agent either edits files directly (`repo`), sends scripts to execute in Godot (`command`), or syncs file diffs (`sync`).

## 5. Watch It Work

Once the job starts running:

- **Live logs** stream into the Chat page in real time. You see the agent's reasoning, tool calls, and file edits as they happen.
- The **Jobs** page shows a job card with status, agent, model, and duration.
- If the agent needs to execute scripts in Godot, it calls back to the bridge via MCP tools. You will see script execution results in the logs.

While the job is running, you can type additional guidance in the Chat composer. This sends **interventions** to the running agent, letting you steer its work mid-execution.

## 6. Review the Result

When the job completes:

- **Repo mode**: Files were edited directly in your project. Godot's bridge detects changes and reloads the scene.
- **Command mode**: The agent's output scripts were executed inside Godot via the bridge.
- Check the job detail panel in the **Jobs** page for a full log, file changes, and any commands executed.

## 7. Rate the Outcome

On the completed job in the **Jobs** page:

1. Click the outcome rating section (Good / Average / Poor).
2. Select a rating and optionally add notes about what worked or what could improve.
3. Click **Save**.

This feedback feeds the **training system**. Over time, Arkestrator learns from rated outcomes to generate better coordinator scripts, playbook guidance, and prompt improvements for future jobs. The more you rate, the better the system gets.

### Why Rating Matters

Arkestrator's coordinator system uses outcome data to:

- Identify which prompting patterns produce good results for specific bridge programs
- Generate playbook entries that guide future agents on similar tasks
- Refine per-program coordinator scripts (e.g., GDScript best practices for Godot)
- Build training data that can be exported and shared across instances

Even a quick Good/Poor click without notes provides valuable signal. Notes like "the node hierarchy was wrong" or "perfect script output" help the training system learn specific patterns.

## 8. Next Steps

Now that you have a working setup, explore these topics:

- **[How It Works](how-it-works.md)** — Understand workspace modes, the coordinator system, and multi-machine setups
- **[Local Models](local-models.md)** — Run models locally via Ollama without cloud API keys
- **[MCP Integration](mcp-integration.md)** — Use Arkestrator's MCP endpoint from external tools
- **[Desktop Client](usage-client.md)** — Full reference for all Chat, Jobs, Admin, and Settings features
- **[Bridge Usage](usage-bridges.md)** — Detailed bridge installation for all supported DCC apps
- **[Configuration](configuration.md)** — Environment variables and server settings reference
- **[Troubleshooting](troubleshooting.md)** — Common issues and solutions
