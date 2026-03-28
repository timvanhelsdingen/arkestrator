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

Unlike cloud engines (Claude Code, Codex) that handle tool calling natively, local models use a structured agentic protocol built into Arkestrator.

### How It Works

1. The server builds a prompt containing the user's task, available tools, and a strict JSON protocol specification.
2. The model responds with exactly one JSON object per turn — either a **tool call** or a **final result**.
3. The server executes the tool (e.g., `execute_command` on a bridge) and feeds the result back.
4. This loop repeats until the model returns a `final` action or hits the turn limit.

### Protocol Format

Tool call:
```json
{"type": "tool_call", "tool": "execute_command", "args": {"target": "blender", "language": "python", "script": "import bpy; bpy.ops.mesh.primitive_cube_add()"}}
```

Final result:
```json
{"type": "final", "status": "completed", "summary": "Added a cube to the scene"}
```

### Available Tools in the Agentic Loop

| Tool | Description |
|---|---|
| `list_bridges` | List connected DCC bridges |
| `get_bridge_context` | Get editor context from a bridge |
| `execute_command` | Run a script in a bridge (GDScript, Python) |
| `execute_multiple_commands` | Run multiple scripts in sequence |
| `run_headless_check` | Run a DCC app in headless/CLI mode |
| `list_agent_configs` | List available agent configurations (delegation) |
| `create_job` | Spawn a sub-job (delegation) |
| `get_job_status` | Poll a sub-job's status (delegation) |
| `list_jobs` | List recent jobs (delegation) |

Delegation tools (`create_job`, `get_job_status`, `list_jobs`, `list_agent_configs`) are automatically enabled when the prompt implies multi-agent or cross-bridge work.

### Loop Limits

| Setting | Default | Description |
|---|---|---|
| Max turns | 12 | Maximum agentic loop iterations per job |
| Hard max turns | 40 | Absolute ceiling even with overrides |
| Turn timeout | 120s | Time limit for each model response |
| Max consecutive errors | 5 | Abort after repeated identical errors |
| Max invalid protocol turns | 3 | Abort after repeated unparseable output |

The loop includes safety features: duplicate tool-call detection (aborts after 3 identical calls), error escalation, and automatic normalization of common model output deviations.

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
