# Local Models

Run AI agents locally via Ollama with no cloud API keys required.

## Overview

Arkestrator supports running jobs with local open-source models through Ollama. The `local-oss` engine connects to an Ollama instance, pulls models on demand, and executes an agentic tool-calling loop that lets local models interact with bridges just like cloud-hosted agents.

Local models are useful when:

- You want to keep data on-premises with no external API calls
- You have a capable GPU and want to avoid per-token costs
- You want to prototype quickly without API key setup
- Simple, single-bridge tasks that do not need frontier-model reasoning

## Installing Ollama

The desktop client includes a built-in **Ollama setup guide** (accessible from Settings > Local Models) that walks you through installation and configuration. The client handles model pulling and endpoint detection automatically.

Manual setup:

1. Download and install from [ollama.com](https://ollama.com).
2. Ollama runs on port **11434** by default.
3. Pull a model to get started:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```

Verify it is running:

```bash
curl http://127.0.0.1:11434/api/tags
```

## Server-Side Setup

When the Arkestrator server runs on the same machine as Ollama (or can reach it over the network), configure the endpoint:

### Environment Variable

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

This is the default, so if Ollama runs locally on the server machine, no configuration is needed.

### Admin Panel

Go to **Admin > Settings** and set the **Local LLM Base URL** to your Ollama endpoint. This overrides the environment variable and is stored in the database.

### Model Allowlist

The server maintains an allowlist of models that agents are permitted to use. By default, all downloaded models are allowed. To restrict the list:

1. Go to **Admin > Agent Configs** and open a `local-oss` agent config.
2. The model catalog shows downloaded, allowed, and recommended models.
3. Toggle models on or off in the allowlist.

The default recommended catalog includes:

| Model | Parameters | Use Case |
|---|---|---|
| `qwen2.5-coder:7b` | 7B | Fast code generation, simple tasks |
| `qwen2.5-coder:14b` | 14B | Balanced speed and quality |
| `qwen2.5-coder:32b` | 32B | Best local code quality |
| `llama3.2:3b` | 3B | Ultra-fast, very simple tasks |
| `deepseek-coder-v2:16b` | 16B | Strong code reasoning |
| `codellama:13b` | 13B | Code completion and infill |

## Desktop-Side Setup

The desktop client can also manage local models and run agentic loops on the client machine's GPU:

1. Open **Settings > Local Models** in the desktop client.
2. Browse available models and pull new ones directly.
3. The client communicates with its own local Ollama instance.

When **client-side coordination** is enabled by an admin, the desktop client can execute the local agentic loop directly, using the client machine's GPU instead of routing through the server.

## GPU Gating

To prevent out-of-memory crashes, Arkestrator enforces **one local-oss job per worker** at a time. This is separate from the cloud agent concurrency limit (`MAX_CONCURRENT_AGENTS`).

How it works:

- Each worker machine has a local LLM slot.
- When a `local-oss` job starts on a worker, that slot is occupied.
- Additional `local-oss` jobs targeting the same worker wait in the queue.
- Cloud-engine jobs are unaffected and can run concurrently.

### Distributed Workers

In multi-machine setups, each worker can have its own Ollama endpoint:

1. Go to **Admin > Machines** and select a worker.
2. Enable **Local LLM** for that worker.
3. Set the **Local LLM Base URL** if it differs from the default.

If no explicit URL is set, the server derives the endpoint from the worker's known IP address (using port 11434). The server runs a health check to verify Ollama is reachable before dispatching jobs.

## The Agentic Loop

Unlike cloud engines (Claude Code, Codex) that handle tool calling natively, local models use an agentic tool-calling loop built into Arkestrator.

### Tool Execution via MCP

Local model agents execute tools through the **MCP protocol**. Tool schemas are fetched dynamically from `tools/list`, so any tool registered on the MCP server is automatically available to local models — no hardcoded tool lists.

- **Server-side loops** use an in-process MCP client (`in-process-client.ts`) wrapping the existing MCP tool server.
- **Client-dispatched loops** (Tauri) call `POST /mcp` over HTTP via an MCP HTTP client.

The MCP adapter (`mcp-tool-adapter.ts`) converts between MCP tool definitions/results and Ollama formats.

### Two Calling Modes

**Native tool calling** — For models that support Ollama's native tool calling API (e.g., `llama3.2`, `qwen2.5-coder`). The model receives structured tool definitions and returns `tool_calls` objects directly. This is the default mode.

**Hybrid mode** — For thinking/reasoning models (e.g., `qwen3`) where Ollama's native tool calling conflicts with the thinking token stream. The loop auto-detects when a model returns text instead of `tool_calls` and switches to hybrid mode: tool definitions are embedded in the system prompt as text, and tool calls are parsed from the model's content output. This preserves the model's reasoning while still enabling tool use.

### Reasoning Mode

Local models support a **plan-act-evaluate** reasoning loop for complex tasks:

1. **Plan** — The agent analyzes the task and plans its approach
2. **Act** — Execute tools according to the plan
3. **Evaluate** — Assess the results before proceeding to the next step

This improves task completion quality for multi-step jobs compared to simple sequential tool calling.

### Auto-Infer Target Bridge

Local LLM jobs analyze the prompt content to **auto-detect the target bridge program**, so you don't need to manually select a bridge for straightforward prompts (e.g., "add a cube in Blender" automatically targets the Blender bridge).

### Available Tools

Tools are dynamically discovered from the MCP server. The standard set includes:

| Tool | Description |
|---|---|
| `list_bridges` | List connected DCC bridges |
| `get_bridge_context` | Get editor context from a bridge |
| `execute_command` | Run a script in a bridge (GDScript, Python) |
| `execute_multiple_commands` | Run multiple scripts in sequence |
| `run_headless_check` | Run a DCC app in headless/CLI mode |
| `search_skills` | Search the skill knowledge base |
| `get_skill` | Retrieve a specific skill's content |
| `create_skill` | Create a new skill from learned patterns |
| `rate_skill` | Rate a skill's effectiveness |
| `list_agent_configs` | List available agent configurations (delegation) |
| `create_job` | Spawn a sub-job (delegation) |
| `get_job_status` | Poll a sub-job's status (delegation) |
| `list_jobs` | List recent jobs (delegation) |

Delegation tools are automatically enabled when the prompt implies multi-agent or cross-bridge work. Skill tools are always available so local models can search and contribute to the knowledge base.

### Loop Limits

| Setting | Default | Description |
|---|---|---|
| Max turns | 12 | Maximum agentic loop iterations per job |
| Hard max turns | 300 | Absolute ceiling even with overrides |
| Turn timeout | 120s | Time limit for each model response (configurable per agent) |
| Max consecutive errors | 5 | Abort after repeated identical errors |
| Max invalid protocol turns | 3 | Abort after repeated unparseable output |

Turn timeouts are **configurable per agent config** via the `turnTimeout` setting. Larger models (32B+) may need extended timeouts. The loop includes safety features: duplicate tool-call detection (aborts after 3 identical calls), error escalation, cancellation checks after both LLM calls and tool execution, and automatic normalization of common model output deviations.

## Creating an Agent Config

To set up a `local-oss` agent:

1. Go to **Admin > Agent Configs**.
2. Click **Add from Template** and select **Local/OSS (Ollama)**.
3. Configure:
   - **Engine**: `local-oss`
   - **Command**: `ollama` (the CLI binary)
   - **Model**: A model from your allowlist (e.g., `qwen2.5-coder:14b`) or `auto` for automatic selection
   - **Dispatch**: `client` (runs on the desktop machine's GPU) or `server` (runs on the server's Ollama)
4. Optionally set a **Fallback** agent — if the local model fails or times out, the job retries with the fallback config (e.g., a Claude Code agent).
5. Click **Save**.

## Auto-Routing

When the agent selector is set to "Auto" in the Chat page, the server evaluates prompt complexity to pick the best engine:

- **Simple prompts** (short, single-task, single-bridge) are routed to `local-oss` if a local model is available and a worker has Ollama running.
- **Complex prompts** (multi-file, architectural, multi-bridge, security-related) are routed to cloud engines (Claude Code, Codex, Gemini).
- **Fallback chains** are followed if the primary engine fails — e.g., try local first, escalate to Claude Code on failure.

The routing considers:

- Whether any worker has `localLlmEnabled` and a reachable Ollama endpoint
- The prompt's estimated complexity (keyword and pattern analysis)
- Available agent configs and their priorities
- Whether the prompt mentions multiple bridge programs (implies orchestration)
