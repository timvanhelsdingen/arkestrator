# Troubleshooting

Common issues and how to resolve them.

## Bridge Won't Connect

### Symptoms

Bridge plugin shows "Disconnected" or "Connection failed" in the DCC app's panel.

### Checks

1. **Server is running.** Verify at `http://localhost:7800/health` — it should return a JSON response.

2. **Config file exists.** The desktop client writes `~/.arkestrator/config.json` on login. Bridges auto-discover this file. If missing:
   - Log in to the desktop client first.
   - Check the file contains `serverUrl`, `apiKey`, and `workerName`.

3. **API key role.** The API key in `config.json` must have the **Bridge** role (or **Admin**). If it only has a User or MCP role, the WebSocket handshake will be rejected. Re-log in from the desktop client to regenerate a valid key.

4. **Network reachability.** If the server is remote:
   - Ensure the bridge machine can reach the server URL on port 7800.
   - If using the desktop client's localhost relay, make sure the client is running on the same machine as the bridge.
   - Firewalls must allow WebSocket connections (TCP on the configured port).

5. **Bridge plugin enabled.** In Godot, check **Project > Project Settings > Plugins**. In Blender, check **Edit > Preferences > Add-ons**. The plugin must be enabled, not just installed.

6. **Manual override.** If auto-discovery fails, some bridges allow setting the server URL manually in their settings panel. Use `ws://localhost:7800/ws` for local or `wss://your-domain.com/ws` for remote with TLS.

## Agent Fails Immediately

### Symptoms

Job transitions from `running` to `failed` within seconds. Logs show command-not-found or authentication errors.

### Checks

1. **CLI tool installed.** The agent engine's CLI must be in the system PATH on the machine running the server:
   - Claude Code: `claude --version`
   - Codex: `codex --version`
   - Gemini: `gemini --version`
   - Ollama: `ollama --version`

2. **API key configured.** Each agent config needs its provider's API key set in **CLI Auth** (Admin > Agent Configs):
   - Claude Code: `ANTHROPIC_API_KEY`
   - Codex: `OPENAI_API_KEY`
   - Gemini: `GOOGLE_API_KEY` or `GEMINI_API_KEY`

   These are passed as environment variables to the subprocess. If missing, the CLI tool exits immediately with an auth error.

3. **Model exists.** If you specified a model override, verify it is a valid model name for the provider. Typos like `claude-sonnet-4` instead of `claude-sonnet-4-6` cause immediate failures.

4. **Permissions.** The server process must have permission to spawn subprocesses. On some systems, sandboxing (SELinux, AppArmor) may block `Bun.spawn`.

## Jobs Stuck in Queued

### Symptoms

Jobs remain in `queued` status and never transition to `running`.

### Checks

1. **Concurrency limit.** The server has a maximum concurrent agent count (default 8, configurable via `MAX_CONCURRENT_AGENTS`). If all slots are occupied, new jobs wait. Check the Jobs page — if 8 jobs are running, the queue is full.

2. **Worker targeting.** If a job targets a specific worker (`targetWorkerName`), the scheduler only dispatches it when that worker is online. Verify the target worker is connected in the Workers page.

3. **Dependencies.** Jobs with `depends_on_job_ids` wait until all dependency jobs reach `completed` status. If a dependency is stuck, failed, or cancelled, the dependent job will never start. Check the dependency chain in the job detail panel.

4. **Bridge availability.** Jobs targeting a specific bridge program (e.g., `godot`) require that bridge to be connected. If the bridge is disconnected, the job waits. For headless programs, the program must be registered and enabled in Admin > Headless Programs.

5. **Paused jobs.** Jobs created with **Add to Queue** (not **Queue and Start**) start in `paused` status. Click **Start** on the job to move it to `queued`.

## Ollama / GPU Issues

### Symptoms

Local-oss jobs fail with connection timeouts, model not found errors, or out-of-memory crashes.

### Checks

1. **Ollama running.** Verify Ollama is accepting requests:
   ```bash
   curl http://127.0.0.1:11434/api/tags
   ```
   If this fails, start Ollama (`ollama serve`).

2. **Wrong endpoint.** If Ollama runs on a different host or port, update the endpoint in:
   - Environment: `OLLAMA_BASE_URL=http://host:port`
   - Admin > Settings > Local LLM Base URL
   - Admin > Machines > Worker > Local LLM Base URL (for distributed setups)

3. **Model not pulled.** The server auto-pulls models when a job starts, but this can time out for large models. Pre-pull models manually:
   ```bash
   ollama pull qwen2.5-coder:14b
   ```

4. **GPU memory.** Large models require significant VRAM. If you see OOM errors:
   - Use a smaller model variant (7B instead of 32B).
   - Ensure no other GPU-heavy processes are running.
   - The GPU gating system limits one local-oss job per worker, but other applications sharing the GPU can still cause issues.

5. **Model allowlist.** The server restricts which models agents can use. If a model is downloaded but not in the allowlist, jobs requesting it will fail. Check and update the allowlist in Admin > Agent Configs for your local-oss config.

## Permission Denied

### Symptoms

API calls return 401 or 403. MCP tools return "Permission denied" errors. Jobs fail with authorization errors.

### Checks

1. **User permissions.** Go to **Admin > Users** and verify the user has the required permissions:
   - `submitJobs` — submit and cancel jobs
   - `executeCommands` — run scripts on bridges, read client files
   - `useMcp` — access the MCP endpoint
   - `interveneJobs` — send guidance to running jobs

2. **API key roles.** API keys have roles that determine their access level:
   - **Admin** — full access
   - **User** — standard job submission and monitoring
   - **Bridge** — bridge connections only
   - **MCP** — MCP endpoint access only

   Ensure the key's role matches the operation being attempted.

3. **Policy blocks.** Policies in **Admin > Policies** can block specific engines, models, prompts, commands, or file paths. Check the audit log (Admin > Audit Log) for policy violation entries.

4. **Token quotas.** Users can have per-day token limits. If exceeded, job submission is rejected. Check the user's quota settings in Admin > Users.

## Workspace Mode Issues

### Symptoms

Agent cannot access project files. Changes are not applied. File sync fails.

### Checks

1. **Project path access.** In `repo` mode, the server process must have read/write access to the project directory. Check filesystem permissions.

2. **Project mapping.** If the project is on a different machine than the server, the path may not resolve. Either:
   - Use `command` mode (scripts execute in the DCC app, no file access needed)
   - Set up project mappings in the Admin panel to map remote paths to local paths
   - Use `sync` mode with file attachments

3. **Sync limits.** Sync mode uploads are capped at `SYNC_MAX_SIZE_MB` (default 500 MB). Large projects may exceed this. Use `repo` mode for large projects or increase the limit.

4. **Mode resolution.** If the wrong mode is selected automatically, you can override it:
   - Set `DEFAULT_WORKSPACE_MODE` in the server environment
   - Use the runtime options in the Chat page to force a specific mode

## Desktop Client Issues

### Symptoms

Client shows a blank screen, cannot connect to the server, or the sidecar does not start.

### Checks

1. **Sidecar not starting.** The desktop app bundles the server as a sidecar. If it fails to start:
   - Check the app logs (View > Developer Tools > Console in the Tauri window)
   - Verify port 7800 is not already in use by another process
   - On macOS, check System Preferences for any security blocks on the binary

2. **Port conflict.** If another application uses port 7800:
   ```bash
   lsof -i :7800    # macOS/Linux
   netstat -ano | findstr 7800    # Windows
   ```
   Stop the conflicting process or change the port in the server configuration.

3. **Connection to remote server.** When connecting to a remote server:
   - Verify the URL is correct (include `https://` for TLS)
   - Check that CORS is configured to allow the client's origin (`CORS_ORIGINS` setting)
   - Ensure the server is accessible from the client's network

4. **Data reset.** If the client is in a bad state, use **Settings > Factory Reset** to clear all local data and start fresh. This does not affect the server database.

## Remote / Multi-Machine

### Symptoms

Bridges on remote machines cannot connect. WebSocket drops or timeouts. CORS errors in the browser console.

### Checks

1. **CORS configuration.** The server must include the client's origin in `CORS_ORIGINS`:
   ```
   CORS_ORIGINS=https://your-domain.com,tauri://localhost,http://localhost:1420
   ```
   Missing origins cause the browser to block WebSocket and REST connections.

2. **Proxy headers.** When behind a reverse proxy (Caddy, nginx, Traefik), enable:
   ```
   TRUST_PROXY_HEADERS=true
   ```
   This allows the server to read `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` headers for accurate request routing.

3. **WebSocket upgrades.** Your reverse proxy must support WebSocket upgrades. For Caddy, this works by default. For nginx, add:
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```

4. **TLS termination.** Bridges connect via `wss://` when TLS is enabled. Ensure your proxy terminates TLS and forwards to the server's plain HTTP port. Mixed content (HTTPS page, WS connection) will be blocked by browsers.

5. **Timeout settings.** Long-running WebSocket connections may be dropped by proxies with low idle timeouts. Set proxy timeouts to at least 300 seconds. Bridges auto-reconnect, but frequent drops cause context gaps.

6. **Localhost relay.** The desktop client starts a localhost relay when connected to a remote server. Bridges on the same machine as the client can connect via `127.0.0.1` instead of reaching the remote server directly. If this relay is not working:
   - Ensure the desktop client is running and logged in
   - Check that `~/.arkestrator/config.json` points to `ws://127.0.0.1:...` for local bridges

7. **Docker networking.** When the server runs in Docker:
   - Use `host` networking or expose port 7800
   - Ollama on the host is not reachable via `127.0.0.1` from inside the container — use the host's IP or Docker's `host.docker.internal`
   - Bridges outside Docker connect to the published port
