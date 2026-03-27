# Arkestrator

## Recent Update (2026-03-27)

- **Onboarding wizard enhancements**: Added "Skills & Training" wizard step (explains self-learning loop, configures training schedule), default agent selection in Agents step (radio picker when multiple agents selected, auto-picks Claude as default).
  - **Local server** now 6 steps: Welcome → Security → Agents (+ default pick) → Skills & Training → Bridges → Ready
- **Claude chat session resumption**: Fixed NDJSON parser to use actual `event.message.content[].text` format (was incorrectly checking `event.text`). Re-enabled `--output-format stream-json --verbose` and `--resume <sessionId>` for persistent Claude chat sessions. Skips history passthrough and system prompt on resumed conversations. Parser now surfaces error messages from failed resume attempts.
- **System tray improvements**: Added "Open Dashboard" (opens admin in browser) and "Stop Server" (sends shutdown POST) tray menu items. Cross-platform URL opening (macOS/Windows/Linux). Server base URL read from shared config.

## Recent Update (2026-03-26)

- **Unified Bootstrap Wizard**: Complete first-time onboarding flow that merges server connection, authentication, and setup into one seamless wizard. Replaces the old split Setup→StartupWizard flow.
  - **Local server** (5 steps → 6 steps): Welcome → Security (auto-start server + auto-login with bootstrap credentials + mandatory password change + optional 2FA) → Agents → Skills & Training → Bridges → Ready
  - **Remote server** (4 steps): Welcome → Connect (URL entry + login + optional TOTP) → Bridges → Ready
  - New Tauri command `read_bootstrap_credentials` reads bootstrap-admin.txt automatically — no manual copy-paste
  - Password change is mandatory on first local setup (min 12 chars)
  - 2FA setup is optional but recommended, with inline QR code + recovery codes
  - Agent setup loading now shows "may take a moment while server starts up" hint
  - Setup.svelte now only handles returning-user reconnection
  - New files: `BootstrapWizard.svelte`, `WizardChooseMode.svelte`, `WizardSecurity.svelte`, `WizardConnectRemote.svelte`
  - `NEXT_SESSION.md` and `LESSONS.md` added to `.gitignore` (removed from tracking)

## Recent Update (2026-03-25)

- **First-Time Startup Wizard (v1)**: Initial post-login onboarding (now superseded by unified BootstrapWizard above)
  - Agent setup step fetches server templates + CLI auth status, shows selectable cards with onboarding instructions
  - Bridge step auto-fetches registry from GitHub + auto-detects all DCC install paths, batch installs selected
  - Client REST API: added `agents.templates()` and `agents.cliAuthStatus()` methods

## Recent Update (2026-03-24)

- **Major refactor — 7 phases:**
  - **Phase 1: Client Performance Fix** — Server WS log broadcasts batched at 200ms intervals. Client `jobs.upsert()` uses in-place `Object.assign`. New `replaceAll()` + `listStructureVersion` for coarse-grained derived store updates. `workerOptions`/`bridgeOptions`/`userOptions` only recompute on structural changes. Autoscroll uses RAF polling instead of MutationObserver.
  - **Phase 2: Settings Route Split** — Split `settings.ts` (7743 lines) into 7 files: `settings-shared.ts`, `settings-general.ts`, `settings-coordinator.ts`, `settings-training.ts`, `settings-snapshots.ts`, `settings-housekeeping.ts`, plus thin aggregator.
  - **Phase 3: Training Module Split** — Split `coordinator-training.ts` (2526 lines) into 5 files: `training-extraction.ts`, `training-vault.ts`, `training-scheduling.ts`, `training-discovery.ts`, plus reduced orchestrator.
  - **Phase 4: Job Queue + Retry** — New DB columns (`retry_count`, `max_retries`, `retry_after`, `expires_at`). New `queue/retry-policy.ts`. Worker loop expires stale targeted jobs every 60s. Spawner retries transient failures with exponential backoff (default: maxRetries=2, 30min TTL for targeted).
  - **Phase 5: Skills Improvements** — Versioning (`skill_versions` table, `listVersions`/`rollback`). Validation (`skill-validator.ts`). Effectiveness tracking (`skill_effectiveness` table, usage/outcome in spawner). New routes: versions, rollback, validate, preview, effectiveness.
  - **Phase 6: Process Tracker Concurrency Fix** — `suspend`/`resume` methods on ProcessTracker. Suspended jobs don't count toward concurrency slots. Enables training parent to free slot while polling child analysis.
  - **Phase 7: Admin Build + Semantic Matching** — New `scripts/build-admin.mjs` + `pnpm build:admin`. Semantic similarity added to playbook task ranking (48-dim cosine similarity at 40% weight).

- Training system audit and fix pass:
  - **Run-now trigger fix**: `coordinator-training/run-now` endpoint now uses `trigger: "manual"` instead of `trigger: "scheduled"`.
  - **Scheduled training source paths**: Scheduled training now merges configured source paths with vault learning data.
  - **Headless viability check**: Training mode selection verifies headless dispatch viability before choosing headless mode.
  - **Worker identity dedup**: `resolveClientForHeadlessProgram()` uses `workerName` as canonical bridge identity.
  - **Training output resilience**: `repairTruncatedJson()`, unclosed json block fallback, synthetic seed construction.
  - **Skills injection**: All enabled skills auto-loaded into every job's context under "Learned Skills & Knowledge".
  - **MCP API key role**: `api_keys` table CHECK constraint includes `'mcp'` role.

## Recent Update (2026-03-23)

- Bug-fix audit pass (v0.1.64):
  - **Headless dispatch fix**: Client now passes `correlationId` through to `worker_headless_result` payload. Previously the Tauri command result omitted it, causing all headless commands (hython, blender CLI, godot headless) to timeout because the server could never resolve the pending promise.
  - **Job false-failure fix**: Both local agentic loop and subprocess paths now check for `[done]` marker in logs before marking a job as "failed". If the agent completed its work despite tool timeouts or non-zero exit codes, the job is correctly marked "completed".
  - **INVALID_MESSAGE fix**: Root cause was the missing correlationId (same as headless fix). Also improved Zod validation error messages to include structured issue details and inbound message type.
  - **Training outcome skills**: Outcome skill slugs now include the project name for discoverability. Failed training jobs now record negative outcome skills to the DB.
  - **Headless executable resolver**: Now runs `where`/`which` to verify bare names are on PATH before returning them as fallback.
  - **WebSocket error messages**: Zod validation errors now show field paths and issue messages instead of raw Zod output.

## Recent Update (2026-03-19)

- Blackmagic Fusion bridge plugin: new Python bridge for Fusion Standalone and DaVinci Resolve's Fusion page. Supports all context sources: comp structure, selected/active tools with full settings, flow graph topology, Loaders/Savers with clip paths, 3D scene hierarchy, modifiers/expressions, keyframes, Fuse/RunScript source files, and macros. Dockable UI panel with per-source "Add to Context" buttons. Executes both Python (`exec()`) and Lua (`comp:Execute()`). Includes installer for auto-detection of Fusion/Resolve script directories.

- Fine-grained API key permissions: API keys now carry per-key `permissions` (same shape as user permissions) instead of relying solely on role-based access. Three new permissions added: `executeCommands`, `deliverFiles`, `submitJobs`. Server routes (bridge-commands, jobs, MCP) now use a unified `principalHasPermission()` check for both users and API keys. MCP auth uses permission-based gating instead of role-based for API keys. Admin API Keys page fully rewritten with grouped permission checkboxes on create, role-based defaults, "Edit Permissions" modal for existing keys, and access summary column. Admin Users page includes the 3 new permissions in the Operations group.

- Job execution reliability overhaul (sandbox, guidance, asset transfer, error handling):
  - **Sandbox fix**: `getClaudeRuntimeDecision()` now always allows `--dangerously-skip-permissions` even when running as root without a known drop-user. Added fallback user chain (bun → node → nobody) and configurable `dropUser` option. Prevents bwrap namespace failures on restricted environments (TrueNAS Docker, containers without user namespace support).
  - **Guidance delivery**: claude-code jobs now use `stdin: "pipe"` (was `"ignore"`), enabling `tryDeliverGuidanceViaStdin()` to push guidance directly to running processes. Polling instruction block strengthened to MANDATORY with specific frequency (every 2-3 tool calls).
  - **Cross-machine asset transfer**: New `file_deliver` WebSocket message type and `POST /api/bridge-command/file-deliver` REST endpoint for pushing files to any connected bridge or client. New `am file-push` CLI command. Client (Tauri) now has full filesystem commands (`fs_apply_file_changes`, `fs_create_directory`, `fs_write_file`, `fs_read_file_base64`, `fs_delete_path`, `fs_exists`) and handles `file_deliver` messages to write files locally.
  - **Error handling**: Binary file placeholders now show extension and human-readable size (`[binary:fbx] 2.4MB`). Headless execution errors now include full error arrays + stderr. Bridge command failure responses include the full result object.

## Recent Update (2026-03-16)

- Client-dispatch local-oss stability fixes: `upsertBridge()` UNIQUE constraint conflict resolution prevents server crashes from duplicate bridge registration when `machineId` is provided, spawner skips server-side Ollama model pull when `localModelHost === "client"` (Tauri client handles model availability), and `resolveAnyAvailableWorkerLlm()` accepts `skipHealthCheck` for client-dispatch path to avoid unnecessary Ollama probes.

## Recent Update (2026-03-17)

- Bridge Plugin Installer: desktop client Settings page now includes a Bridge Plugins section with card-based UI for discovering, installing, updating, and uninstalling bridge plugins from GitHub Releases. New `bridges/registry.json` describes all 6 official bridges with metadata, install paths, and auto-detection hints. New Rust module `src-tauri/src/bridges.rs` handles registry fetching, zip download/extraction, program path detection, and install tracking. Release CI (`release.yml`) now packages bridge zips and uploads `registry.json` as release assets. `scripts/bump-version.mjs` now syncs versions for bridge manifests (Godot plugin.cfg, Blender blender_manifest.toml, Unreal .uplugin) and registry. All bridge versions synced to 0.1.44. Release workflow fixed: conditional macOS code signing (only when APPLE_CERTIFICATE secret is set) and Linux APPIMAGE_EXTRACT_AND_RUN for CI runners without FUSE.
- Packaged remote-admin iframe fix: the Tauri desktop CSP now explicitly allows remote `http(s)` frame loads via `frame-src` / `child-src`, which was the actual blocker preventing the embedded Admin page from loading from remote servers like `http://truenas.local:7800/admin` even though direct browser access worked.
- Embedded admin-panel readiness fix: the desktop client `Admin` page no longer depends only on iframe `load` timing to clear `Loading admin panel...`. The embedded `/admin` SPA now posts an explicit `admin_ready` signal after mount and embedded session-token bootstrap, and the client waits for that readiness message while still re-sending the desktop session token into the iframe.

## Recent Update (2026-03-15)

- QA-driven bridge transport hardening: server-spawned agent jobs now use loopback `ARKESTRATOR_URL` (`127.0.0.1`) instead of inheriting an external/shared hostname that may not resolve inside the job shell, bridge-command REST/MCP calls now fail when a bridge reports skipped/failed/zero-executed commands, and coordinator prompts now tell agents to probe `am` instead of assuming it is always present.
- Chat context machine-foldout fix: the desktop chat context panel now groups bridges by stable machine identity (`machineId` with worker-name fallback) instead of the mutable display label and uses the same single-open accordion toggle logic as the bridge foldouts, so clicking a machine header reliably opens/closes it on the Chat page.

## Recent Update (2026-03-13)

- Chat/job-guidance separation fix: the desktop chat composer no longer turns `Send` into `Guide Job` for active tab jobs. Direct interventions stay on the Jobs page, and chat-created jobs now carry bounded prior user chat from that tab into the submitted prompt as soft planning context so job agents can infer guidance from the conversation instead of hijacking chat.
- Worker-scoped heavy-resource control: coordinator defaults now explicitly serialize conflicting GPU/VRAM-heavy steps per worker, and the server now enforces worker-scoped `gpu_vram_heavy` leases across REST/MCP/local-loop bridge execution plus worker-owned headless execution. Blender render/bake tasks, Houdini heavy render/sim/cache steps, and ComfyUI generation now refuse to overlap on the same machine while leaving general agent concurrency unconstrained.
- Bridge auth/reconnect resilience hardening: the desktop client/Tauri shared-config writer now refuses malformed `apiKey` values, and the Godot/Blender/Houdini bridge reconnect loops keep a last known-good key so a bad `~/.arkestrator/config.json` rewrite no longer strands bridges offline on the next reconnect.
- Running-job live guidance delivery fix: running Claude Code and Codex jobs now accept live operator guidance during the same run instead of only before launch. The server now tells those agents to poll Arkestrator for new interventions at safe checkpoints, exposes `am jobs interventions <jobId>` as the CLI fallback, forwards `X-Job-Id` through MCP client-API calls, and marks notes `delivered` only when that same running job actually fetches them.
- Same-machine remote bridge failover: Godot, Blender, Houdini, ComfyUI, and Unreal bridge reconnects now treat the desktop localhost relay as preferred but automatically fall back to shared `remoteWsUrl` if that relay is stale or gone. This prevents all local bridges from dropping offline together after a relay failure during remote-server sessions.
- Sub-job lineage fix: `POST /api/jobs` now inherits the caller's `X-Job-Id` as `parentJobId`, so orchestrators that fan out work through the `am jobs create` CLI path keep the same parent/child graph as MCP-created sub-jobs. The Jobs UI now makes that lineage easier to scan with explicit `from #parent` chips on child rows and a clearer `Spawned From` link in Job Detail.
- Claude root-runtime privilege-drop fix: when Arkestrator itself is running as `root` (for example on TrueNAS), Claude Code subprocesses now automatically drop to the container's non-root `bun` user via `runuser -m` when available, so `--dangerously-skip-permissions` stays enabled for jobs, chat, and CLI-auth flows instead of falling back into interactive approval prompts.
- Container CLI path hardening: Docker images now set a system-wide `BUN_INSTALL` path (`/usr/local/bun/bin`) before running CLI install hooks, so Bun-installed CLIs like Claude/Codex remain executable after the container drops from root to the non-root `bun` runtime user.
- Dynamic provider model discovery refresh: Claude model suggestions are no longer served from a stale hardcoded server list. The server now discovers Claude models from local Claude runtime artifacts (`~/.claude` plus `Claude.app` bundle strings when present), continues to read Codex models from `~/.codex/models_cache.json`, injects the discovered preferred default into agent templates, and the desktop client now keeps provider ordering so newest/best models surface first instead of being alphabetically buried.
- Chat draft remount persistence fix: desktop chat now restores the saved tab `draftPrompt` on page remount without immediately syncing an empty local composer back into storage, so leaving Chat for another page and returning keeps the unsent typed text intact.
- Chat guide-mode capability fix: the desktop chat composer now loads intervention support for the newest tab job and only switches `Send` into `Guide Job` mode when that job can actually accept guidance in its current state. Running jobs on runtimes without server-managed live next-turn support now leave chat in normal message mode and show the server-provided reason instead of failing with a misleading 400.
- Client-owned headless DCC execution routing: Blender/Houdini/Godot headless execution no longer runs on the server. The server now routes `headless` bridge work and headless-check probes to the target desktop client/worker over WebSocket, the desktop client executes the local CLI process through Tauri, and MCP now preserves the caller job's `bridgeExecutionMode`/`targetWorkerName` so a failed headless attempt cannot silently fall through to a live GUI bridge.

## Recent Update (2026-03-12)

- Configurable desktop-local server port: the Tauri client now persists a local server port (default `7800`), Setup lets first-run local installs choose it before startup, Settings/Admin local-server controls can save or apply+restart on a new port, and local-mode boot now rewrites saved localhost URLs to the configured port so the desktop app/admin iframe do not silently drift back to stale `7800`.
- Machine-scoped chat targeting: the desktop chat control now scopes by worker/machine instead of raw bridge IDs. Chat tabs persist `selectedWorkerNames`, `ChatInput` exposes `Machines` (`Auto` or one/many workers), normal chat job submission no longer emits `bridgeProgram`/forced command-mode hints from the UI, and the spawner now filters the coordinator-visible live bridge inventory to the selected worker set so `Auto` no longer silently persists stale bridge targets like ComfyUI.
- Persistent Codex chat sessions: `/api/chat` now reuses Codex CLI threads per authenticated conversation key instead of cold-starting a fresh Codex process context on every turn. Client chat tabs persist a resettable `conversationKey`, server chat stores recent Codex `thread_id`s in memory, and follow-up turns now use `codex exec resume <thread_id>` while `Clear chat` rotates the key so server-side context matches the visible transcript.
- GHCR publish dependency-graph reduction: the server image now leaves the admin SPA out of Docker entirely and reuses tracked `client/resources/admin-dist`, while Docker only installs the reduced server + protocol workspace graph and rebuilds protocol `dist` in-image. `docker/pnpm-workspace-install.sh` still enforces heartbeat logging, bounded retries, reduced pnpm concurrency, and configurable install timeouts, but the publish job now avoids the admin dependency tree that was stalling Buildx.
- Runtime workspace-package link fix: the final server image now creates a root `node_modules/@arkestrator/protocol` symlink to `packages/protocol` after the stage copy, so Bun can resolve the workspace package reliably in container deployments even when the filtered pnpm install only left a `server/node_modules` symlink behind.
- Docker protocol-build config fix: the server-image build again copies the repo-root `tsconfig.json` before rebuilding protocol inside Docker, restoring the `extends ../../tsconfig.json` chain that CI needs for standard library types during `tsc`.
- Docker filtered-install fix: the server-image install step now explicitly filters pnpm to `@arkestrator/server...` plus `@arkestrator/protocol`, so CI keeps the reduced 2-project dependency graph instead of reintroducing the root workspace and hanging again at `pnpm install`.
- Client-owned local bridge relay: the desktop client now starts/restores a localhost TCP relay for remote servers and writes bridge-facing localhost URLs into shared config while preserving `remoteServerUrl` / `remoteWsUrl`. Same-machine DCC bridges can now connect through the desktop relay instead of opening direct sockets to the remote host, fixing app-specific macOS GUI routing failures like Houdini FX not reaching `truenas.local` directly.
- Houdini GUI startup watchdog: the bridge now writes connect/error/disconnect breadcrumbs to `~/Library/Preferences/houdini/21.0/arkestrator_startup.log` and schedules one delayed forced reconnect after UI-ready if the initial GUI socket attempt never reaches connected state.
- Houdini package manifest regression fix: `bridges/houdini/arkestrator_bridge.json` again resolves `ARKESTRATOR_BRIDGE_DIR` relative to the package file via `$HOUDINI_PACKAGE_PATH/arkestrator_bridge`, so package installs from the repo checkout and other non-user-pref locations load the bridge startup hooks correctly.
- Prompt-driven headless bridge routing: bridge-targeted jobs now infer a persisted headless execution preference from prompts that explicitly ask for headless/CLI/background/separate-process execution (`use headless`, `use CLI`, `use hython`, `do not touch my active session`, etc.). The server now honors that preference across normal command-mode completion and `am`/REST bridge commands by routing headless work to the target desktop client/worker even when a live GUI bridge is online, so separate-process Blender/Houdini/Godot runs can write outputs without touching the active session.
- macOS ComfyUI app wrapper: added `scripts/build-comfyui-launcher-app-mac.sh` and AppleScript source under `tools/mac/` so the ComfyUI shortcut can be compiled into `tools/mac/Arkestrator ComfyUI Launcher.app` for normal Finder/Dock launching.
- macOS ComfyUI launcher shortcut: added `pnpm comfyui:mac` plus a Finder-friendly `scripts/start-comfyui-bridge-mac.command` wrapper that opens Terminal sessions for both ComfyUI and the standalone ComfyUI bridge, auto-discovering common local install paths with optional env/shared-config overrides.
- Houdini package portability fix: the bridge package JSON now resolves its install root relative to the package file itself (`$HOUDINI_PACKAGE_PATH/arkestrator_bridge`) instead of hardcoding `HOUDINI_USER_PREF_DIR/packages/arkestrator_bridge`, and the pythonrc fallback no longer assumes a Linux-only `~/houdini21.0` path. This keeps the shipped package layout relocatable across Windows, macOS, and Linux.
- Houdini GUI startup follow-up: added `scripts/ready.py` to the bridge package so GUI launches re-run `arkestrator_bridge.register()` once the UI is ready, improving live auto-connect in the interactive Houdini app path.
- Houdini GUI startup hook placement fix: later startup hooks now also live in `scripts/python/ready.py` and `scripts/python/uiready.py`, matching SideFX-documented startup-script locations used by package-based GUI sessions.
- Houdini startup-path hardening: the bridge package now also ships `python3.11libs/pythonrc.py`, `ready.py`, and `uiready.py`, matching SideFX's primary documented Houdini 21 startup-hook locations for deterministic GUI and hython auto-connect behavior.
- Houdini GUI fallback hardening: the bridge package now also ships `scripts/123.py` and `scripts/456.py` so interactive scene startup/load can re-run registration even if earlier startup hooks are skipped by the app path.
- Houdini package manifest simplification: reverted the bridge package JSON to the same `env` + `HOUDINI_PATH` pattern used by other working local packages on the Mac install, instead of continuing with the less reliable `hpath` experiment.
- Workspace MCP connection hygiene: repo-local `.mcp.json` is now ignored and README MCP docs now call it out as a local-only client config, so Codex/Claude workspace connections can be added without leaking bearer tokens into git.
- README front-page cleanup: condensed the opening docs pitch into a clearer landing page that explains Arkestrator in plain terms (`what it is`, `what it solves`, `why it matters`, `how it works`, `why teams need it`) and keeps the validated AI-engine status table close to the top.
- Branding source-of-truth correction: client/admin brand assets are now re-synced directly from the current canonical SVGs in `docs/assets/` as provided, including the current `arkestrator-logo_brandname.svg` lockup used by README and app login/setup surfaces.
- Documentation accuracy pass: README AI-engine support wording now distinguishes real validation level instead of showing every engine as equally mature. Claude Code and Codex are marked extensively tested, Ollama/local is called out as pre-alpha, and Gemini/Grok/custom CLI remain listed but explicitly untested.
- Branding refresh: synced the new Arkestrator master logo assets into repo docs/README, regenerated the full Tauri desktop icon set from the updated mark, and updated admin browser/login/sidebar branding so packaged/client/admin surfaces all reflect the same latest logo.
- Coordinator fanout + root-outcome propagation pass: coordinator prompts now push harder toward sub-job fanout for bridge-separable/backgroundable work (cross-bridge asset generation, renders, sims, bakes, caches), local agentic delegation tools auto-enable for more obvious multi-bridge/background prompts, and root-job outcome ratings now propagate to finished descendant sub-jobs for learning/UI so users only rate the main job. Jobs UI now visually tints delegated rows and shows root fanout summaries instead of treating delegated work like unrelated peer jobs.
- Blender context-menu coverage follow-up: the addon no longer relies on a small hardcoded menu list. It now discovers Blender `Menu` types at runtime, injects `Add to Arkestrator Context` across all available `*_context_menu` surfaces plus key Outliner submenus, captures File Browser and Asset Browser items directly, and falls back to a serialized editor-context snapshot on RMB menus that do not expose explicit selection APIs.
- Bridge-context coverage + rename pass: the shared bridge action is now `Add to Arkestrator Context` across maintained plugins. Blender now exposes it in viewport/edit/node/outliner/text surfaces (including mesh-component and node-editor capture), Unity adds current-selection plus asset/gameobject/transform entry points, Unreal adds level/content-browser/top-menu entry points with actor/asset/folder/material-node capture, and the chat context panel now supports row-level drag/drop with a desktop-webview-safe MIME fallback.
- Command-mode MCP completion fix: bridge-targeted command-mode jobs that already succeeded through live MCP/REST/CLI bridge execution now complete successfully even if the model finishes with a prose summary instead of emitting a final fenced bridge script. This removes false `failed` statuses like “No executable commands were produced” for successful Blender/bridge runs that executed work live during the session.
- CI shared-config test fix: the server regression test that seeds `~/.arkestrator/config.json` now creates the temp config directory first, matching clean GitHub Actions runners and preventing `ENOENT` failures during merge checks.
- Client-side local LLM job execution: when `localModelHost` is `"client"`, the server now dispatches local-oss jobs to the connected Tauri client via WebSocket instead of trying to reach Ollama over the network. The client runs the agentic loop locally against its own localhost Ollama (`http://127.0.0.1:11434`), parses the JSON protocol responses, and proxies tool calls (bridge commands, sub-jobs) back through the server. This fixes local-oss jobs when the server runs in Docker (e.g., TrueNAS) where it can't reach the client's localhost Ollama. The agentic protocol (prompt builder, parser, types) was moved to the shared protocol package so both server and client can import it. Six new WebSocket message types support the dispatch flow: `client_job_dispatch`, `client_tool_request`, `client_tool_result`, `client_job_log`, `client_job_complete`, `client_job_cancel`. Job lifecycle management includes disconnect handling, cancellation forwarding, and graceful fallback to server-side execution when no client is connected. Stability follow-up: `upsertBridge()` UNIQUE constraint conflict resolution, spawner skips server-side Ollama model pull for client-hosted runs, and `resolveAnyAvailableWorkerLlm()` supports `skipHealthCheck` for client-dispatch.
- Local loopback worker canonicalization fix: the server now treats the desktop client’s shared-config `workerName` as authoritative for loopback bridge sockets (`127.0.0.1` / `::1`) and prunes stale local alias rows such as router-hostname or `host-127.0.0.1` entries once the canonical machine name is known. This collapses stale local bridge/client duplicates back onto one machine row in Workers even if a Blender addon reconnects with an old hostname.
- Local-sidecar Admin 404 fix: the server’s `/admin` static resolver now recognizes the macOS Tauri packaged resource path `Contents/Resources/_up_/resources/admin-dist`, which is where the desktop bundle was actually placing Admin assets. This fixes the local server started through the client returning 404 for Admin despite the SPA being bundled.
- Jobs UI cleanup: removed the aggregate usage summary boxes from the top of the Jobs list. The page still exposes token/cost information per row and in Job Detail, but no longer spends vertical space on unclear visible/checked totals.
- macOS worker identity fix: the desktop client now prefers the Mac `ComputerName` (via `scutil`, with `LocalHostName`/hostname fallback) when populating the canonical `workerName`, writes that value into `~/.arkestrator/config.json`, and the Blender bridge follows that shared `workerName` instead of inventing its own hostname. Workers UI now shows the local Arkestrator account on the matching machine row and moves the OS account into expanded details so machine users are not presented as signed-in app users.
- Worker identity refactor: worker registration now uses a client-owned persistent `machineId` when available, with `workerName` as display label and legacy fallback only. This prevents bridge/client duplicates when hostnames drift and avoids IP-based collisions behind proxies/NAT.
- Durable coordinator storage refactor: server now supports a configurable `DATA_DIR` for durable state, exposes server-owned imported references as a first-class vault root, and imports local reference folders into bounded portable server storage instead of storing raw machine-local folder paths in playbook manifests.
- GHCR branch publish parity: the server image publish workflow now runs on `main` pushes and refreshes both `:main` and `:latest`, preventing the default-branch image tag from drifting behind the newest packaged server image.
- Cross-bridge shared identity parity: Godot, Houdini, ComfyUI, Unreal, and Unity bridges now follow the same client-owned `workerName`/`machineId` shared-config logic as Blender, so one desktop machine no longer registers as multiple workers just because different bridges fall back to different hostnames.
- Admin users-table compact access disclosure: Admin > Users now collapses per-user permission chips behind a default-closed summary toggle so large access lists no longer stretch each row vertically unless expanded.
- Visible frontend build IDs: client and admin builds now expose `<package version>+<git short sha>` directly in the running UI (desktop title/status bars, admin login/header) so operators can verify what build is actually deployed on local, packaged, and TrueNAS-hosted surfaces.
- GitHub Actions pnpm setup resolution fix: CI and release workflows now pin `pnpm/action-setup` to the current published `v4.2.0` tag so main-branch/release jobs stop failing on an unresolved floating `@v4` action reference.
- Blender remote auto-connect fix: the Blender bridge now treats loopback/default WS URLs as shared-config-following, so when the desktop client writes a remote `wsUrl` into `~/.arkestrator/config.json` the addon adopts that TrueNAS/server address for manual connect, deferred auto-connect, and reconnect refresh instead of sticking to localhost.
- CI stabilization follow-up: fixed a strict client TypeScript regression in `client/src/lib/api/ws.ts` (`job.usedBridges` map callback implicit `any`) so GitHub Actions `cd client && npx svelte-check --tsconfig ./tsconfig.json` passes on the merged branch.
- Security audit hardening: auth/user credential endpoints now reject malformed typed payloads consistently, password create/change/reset flows require at least 8 characters, `/api/chat` now returns structured 400s for invalid JSON/body shapes, and workspace dependencies were bumped/pinned to patched Hono/Svelte/MCP transitive versions.
- Security hardening follow-up: tightened non-architectural control-plane validation after the initial audit pass. `/api/keys/share` now rejects bridge/client API keys, worker IP rules require string arrays, MCP routes return structured auth/input errors, project/headless-program/policy writes are schema-validated before persistence, and job requeue now rejects malformed JSON instead of silently treating invalid bodies as empty payloads.
- Active-job delete flow fix: REST delete and bulk-delete now auto-cancel queued/paused/running jobs before removing them, Jobs UI warns that active jobs will be cancelled first, and spawner exit handling skips late terminal writes for jobs cancelled/deleted during shutdown.
- Chat guidance/input UX simplification + Jobs outcome visibility polish: active-job guidance in Chat now uses the main composer `Send` path instead of a second guidance box, while Jobs detail only shows outcome feedback for terminal jobs and places it near the top of the detail panel.
- Local setup bootstrap-path correctness: the desktop Setup hint now points to `{appDataDir}/data/bootstrap-admin.txt`, matching the local sidecar server's actual DB/bootstrap output directory instead of the app-data root.
- Tauri local-dev reboot-loop fix: bundled admin SPA assets now copy into `client/resources/admin-dist` instead of `client/src-tauri/resources/admin-dist`, and server admin-dist resolution includes that path. This keeps mutable admin resources out of the `src-tauri` watch tree so `tauri dev` no longer rebuilds/relaunches the desktop app on every copied asset change.
- Local setup bootstrap-path reliability: the desktop Setup flow now resolves the local app-data directory for localhost login states even when the client did not spawn the server, so first-run guidance shows the concrete `bootstrap-admin.txt` path instead of a vague “next to the DB file” message.
- Actual bridge-attribution fix: jobs still keep `bridgeProgram` internally for explicit routing, but `usedBridges` now starts empty, Jobs/Chat bridge badges/filters only populate after real execution proves bridge use, and auto submissions no longer infer a target bridge from ambient live bridge state. This prevents auto-inferred targets like ComfyUI from showing up as if they already ran.
- Command-mode command extraction hardening: server-side fenced-command parsing now derives the expected bridge script language, strips echoed `am`/curl/PowerShell helper examples from prompt guidance, and fails command-mode jobs when no real executable bridge script remains instead of persisting bogus helper snippets into Job Detail.
- Running-job intervention v1: jobs now accept auditable operator-note interventions over REST, WebSocket, and MCP; queued/paused jobs inject them on next launch/resume, supported running local command-mode jobs receive them on the next turn boundary, and pending notes are terminally marked delivered/rejected with metadata instead of being lost. Client Jobs and Chat now expose live guidance composers/timelines, and Admin exposes the new per-user `interveneJobs` permission.
- Codex MCP parity fix: spawned Codex jobs now get Arkestrator `.mcp.json` injection in the actual runtime cwd used by the child process (including command-mode temp directories), restoring the intended transport order of MCP first and `am`/REST fallback second instead of starting with `mcp startup: no servers`.
- Jobs page identity/usage polish: job payloads now expose `submittedByUsername` and optional `tokenUsage.costUsd`, the client machine filter can fall back to live worker inventory, usage cards use explicit visible/checked row wording, and per-job rows/details surface token totals plus reported run cost when available.
- Bridge context drag fix + server-managed indexing: drag-drop from the bridge context panel to the chat input now works reliably (drop target expanded to the full input area instead of just the textarea). Context item `@N` numbering is now managed server-side so indices stay sequential after removals/clears instead of continuing to increment from the bridge's counter. New protocol messages `client_context_item_remove` and `client_context_items_clear` let the client tell the server when items are removed.
- Jobs archive/trash UI + auto-archive: the Jobs page now has Archived and Trash tabs that display archived and soft-deleted jobs respectively. Active jobs can be archived, archived/trashed jobs can be restored, and trashed jobs can be permanently deleted. Bulk operations (archive, restore, permanent delete) are supported per view. Training and housekeeping jobs are automatically archived when they reach a terminal state.
- Chat system fixes + job awareness: fixed "out of turns" messages (max-turns reduced from 2 to 1 since tools are disabled), fixed duplicate job cards in chat (sub-job/intervention messages no longer carry jobId, plus first-message-per-job dedup), added markdown rendering for assistant messages (via `marked` library with dark-theme styling), and chat is now fully job-aware — the server fetches job summaries from the DB and injects them into the system prompt so the assistant can answer questions about completed jobs, errors, file changes, and commands.

## What Is This?

Arkestrator is a **hub-and-spoke system** that lets you run AI coding agents (Claude Code, Codex, Gemini CLI, etc.) against DCC applications like Godot, Blender, and Houdini - and manage them all from a single dashboard.

The core idea: you're working in Godot on a game. You select some nodes, right-click “Add to Arkestrator Context” to capture your scene state and selections. Then you switch to the Arkestrator client (or a Claude/Codex app connected via MCP) and type your prompt: “add a health bar to the player HUD”. The server picks it up, spawns a Claude Code subprocess against your project files, streams logs back in real-time, and when it's done the bridge plugin applies the file changes directly in your editor.

It also works across machines. You can have Godot running on your workstation, the server running on a beefy build machine, and still submit and receive results seamlessly. The server manages a persistent **worker list** so you can target jobs to specific machines.

## Supported Bridges

| DCC / Tool | Bridge | Status |
|-----------|--------|--------|
| Godot | GDScript addon | Beta |
| Blender | Python addon | Beta |
| Houdini | Python addon | Beta |
| ComfyUI | Python bridge | Beta |
| Fusion / DaVinci Resolve | Python bridge | Beta |
| Unity | C# plugin | Alpha |
| Unreal | Python plugin | Alpha |

Any program that can open a WebSocket, run scripts, and read/write files can be a bridge. See [Bridge Development Guide](docs/bridge-development.md).

## Goals

1. **Unified AI agent management** - One server, one dashboard, multiple DCC apps and AI engines
2. **Context-driven workflow** - Add context from your DCC app, submit prompts from the Arkestrator client or any MCP-connected agent, and receive results applied back into your editor
3. **Multi-machine support** - Server can run on a different machine from the DCC app; workers track machines persistently
4. **Engine-agnostic** - Claude Code, Codex, Gemini CLI, or any local model via CLI
5. **Policy control** - Admins can restrict prompts, file paths, tools, and engines
6. **Production-ready** - User accounts, API keys, audit logging, Docker deployment

## Latest Update (2026-03-04)

Pre-launch audit hardening:

- Fixed corrupted `pnpm-workspace.yaml` `onlyBuiltDependencies` (single-letter entries from bad write).
- Secured CORS defaults: `app.ts` now restricts to localhost/Tauri origins when `CORS_ORIGINS` is unset (was fully permissive).
- Migrated API key prefix from `am_` to `ark_` with backwards-compatible validation (both accepted).
- Standardized error responses across `headless-programs.ts`, `bridge-commands.ts`, and `chat.ts` to use `errorResponse()` helper with structured codes.
- Replaced stray `console.warn` with `logger.warn` in `engines.ts`.
- Aligned Zod dependency versions across protocol + server to `^3.25.76`.
- Expanded `.env.vps.example` with comprehensive env var documentation for all supported settings.
- Fixed `setup.ps1` missing `build:sidecar` step for Windows parity.

Documentation cleanup and positioning refresh:

- Reframed documentation as DCC-first: Arkestrator is built for DCC workflows first, while still supporting non-DCC toolchains through the same bridge architecture.
- Reduced top-level documentation size by removing oversized release-note style sections from core docs and keeping high-signal summaries.
- Kept detailed operational and feature docs in module docs and docs/ pages so implementation details remain available without bloating entry-point docs.
- MCP orchestration expansion for central-server deployments: `/mcp` now includes `list_targets` (connected bridges + enabled headless targets), `get_job_logs` (bounded log tail retrieval), and `cancel_job` (queued/paused/running cancellation). Running-job cancellation now terminates tracked subprocesses via `ProcessTracker` when available.
- MCP client-parity and access governance: added `client_api_request` tool (allowlisted non-admin client route forwarding) so MCP can drive rich client workflows (full job payloads, training queueing, reprioritize/resume/requeue) through existing REST permission checks, plus per-user MCP gate (`permissions.useMcp`) enforced on session-authenticated `/mcp` access.
- Admin API key management restoration: Admin SPA now exposes an `API Keys` page (permission-gated by `manageApiKeys`) so operators can create/revoke MCP-ready `client`/`admin` keys directly in `/admin` without relying on hidden client APIs.
- Admin one-click CLI auth for server runtimes: Admin `Agents` now includes a `CLI Auth (Server Runtime)` panel for Claude/Codex with status probing, one-click login start, live session output, auth URL/code actions, and cancel support, backed by `/api/agent-configs/cli-auth/*` endpoints so container users do not need manual shell login steps for normal setup.

Recent platform highlights (kept concise here):

- Cloud-provider model-catalog centralization: client chat no longer owns hardcoded provider model lists. The server now serves provider catalogs via `/api/agent-configs/model-catalogs`, dynamically reading Codex models/reasoning from local `~/.codex/models_cache.json` when available (so current app models like `gpt-5.4` appear automatically), while Claude/Gemini currently use maintained server fallbacks until a similarly reliable local catalog source is available.
- GHCR publish dependency-stall hardening: Docker base-stage dependency install now runs `pnpm fetch` with retry attempts and then `pnpm install --offline`, wrapped by an internal shell watchdog that prints heartbeat logs and force-terminates timed-out commands even when GNU `timeout` is unavailable.
- GHCR publish timeout hardening: Docker base dependency install no longer uses a fixed 600s timeout. It now honors configurable build arg `ARKESTRATOR_PNPM_INSTALL_TIMEOUT_SECONDS` (default `5400`), and the publish workflow forwards a safe fallback value when the repo variable is unset so CI can tune install windows per dependency footprint without reverting to short timeouts.
- Chat local-runtime completion reliability: client chat SSE now reads `/api/chat` `done` exit codes and treats non-zero exits as errors; when a run returns no assistant text, the UI now shows a concrete fallback message instead of an infinite `Thinking...` placeholder.
- Job cancellation reliability fix: REST cancel (`POST /api/jobs/:id/cancel`) now terminates tracked running subprocesses before marking jobs `cancelled`, preventing late bridge-side effects (for example Blender changes) from jobs cancelled mid-run.
- Client-local local-model control path: client Settings `Local Models (Ollama)` now supports source selection (`Client (This Desktop)` vs `Server/Worker`). In desktop source mode, catalog listing and model pulls run locally via Tauri commands, so users can manage local Ollama/Llama without depending on server loopback/network topology.
- Server-local Ollama endpoint configurability + diagnostics: added admin settings API for server runtime endpoint override (`GET/PUT /api/settings/server-local-llm`, persisted key `server_local_llm_base_url`), wired local-model listing/pull and local-oss `ollama` spawn env to honor this override (defaulting to env/localhost), and improved route errors to include the failing endpoint URL.
- Local-OSS parity hardening: Settings now includes a catalog-based model picker for server/worker local runtimes, client coordination toggle layout was simplified, and local-oss Ollama runs now auto-pull missing selected models before execution (server-local or worker-targeted endpoints).
- Client-local coordination runtime parity: capability probing now uses resilient desktop-local Ollama detection (`/api/tags` with native fallback), and chat `local-oss` model suggestions switch to desktop-local model discovery when client-side coordination is enabled.
- Local-model refresh reliability fix: Settings local-model auto-load now runs once per authenticated load (no retry loop on empty/error), and server Ollama list/pull requests now use bounded timeouts so refresh fails fast with clear endpoint timeout errors instead of hanging.
- Desktop updater boot reliability: fixed Tauri startup panic by making updater plugin config explicit/non-null in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, `plugins.updater.endpoints`) while keeping runtime updater flow unchanged.
- Desktop lifecycle: added Tauri system tray behavior (close-to-tray, tray menu show/hide/quit, left-click restore) and startup auto-update checks with download/install flow.
- Queue/tree behavior: top-level requeue now restarts full descendant job trees.
- Operations: improved container publish/runtime reliability and fail-fast install behavior.
- UX: better Jobs filtering/readability, stronger user insights, and more reliable worker presence/status handling.
- Training/coordinator: stronger artifact persistence, vault indexing/metadata controls, stricter failure gating for blocked analyses, plus zip-first exchange/recovery workflows (full server export/import zip and scoped training-data bundle export/import) with improved per-artifact actor attribution (user/machine context) in Training Vault metadata.

## Architecture Overview

Arkestrator uses a hub-and-spoke model:

- Server (hub): REST + WebSocket gateway, job queue, agent spawning, policy/auth enforcement, persistence.
- Bridges (spokes): thin connectors running inside DCC apps (and other host tools) that send context and execute/apply results.
- Client/Admin: operational and administrative UIs over the same server APIs.

Primary flow: submit job -> queue/claim -> run selected engine in workspace mode (`command`/`repo`/`sync`) -> stream logs -> persist result -> deliver back to bridge/client.

### The Four Components

| Component | Tech | Role |
|-----------|------|------|
| **Server** | Bun + Hono + SQLite | Central hub. Receives jobs, queues them, spawns AI CLI tools as subprocesses, streams results back. Manages all state. |
| **Client** | Tauri v2 + Svelte 5 | Primary desktop dashboard. Users manage jobs, configure agents, view workers. Connects to server via REST + WebSocket. |
| **Admin** | Svelte 5 + Vite (web SPA) | Secondary admin panel served at `/admin` by the server. Security-sensitive operations: users, API keys, policies, audit log. |
| **Bridges** | GDScript (Godot), Python (Blender/Houdini/ComfyUI/Unreal), C# (Unity) | Thin plugins that run inside DCC apps. Send editor context and user selections to the server, execute commands, display streaming logs, and apply file changes back into the editor. |

## How a Job Flows Through the System

```
1. USER adds context from DCC app (selections, scene state, scripts) via bridge â†’
   then submits prompt from Arkestrator client or MCP-connected agent (Claude/Codex)

2. CLIENT/AGENT sends job to server via REST or WebSocket

3. SERVER validates, creates job in SQLite (status: "queued"), replies `job_accepted`

4. WORKER LOOP picks next queued job (by priority, then FIFO), claims it atomically
   (status: "running")

5. WORKSPACE RESOLVER determines how to run the agent:
   - "repo" mode: agent works directly in a project directory
   - "command" mode: agent outputs scripts for the bridge to execute
   - "sync" mode: files uploaded to temp dir, agent works there

6. SPAWNER builds CLI command for the engine (claude --dangerously-skip-permissions
   -p "prompt" --max-turns 20 ...) and spawns it via Bun.spawn

7. STREAMING: stdout/stderr are piped in real-time â†’ `job_log` messages sent to
   bridge + all connected clients

8. COMPLETION: On exit code 0, spawner diffs before/after file snapshots (repo/sync)
   or parses command output (command mode). Stores result in DB, sends `job_complete`.

9. BRIDGE receives `job_complete`:
   - repo/sync mode â†’ applies file changes to the editor project
   - command mode â†’ executes returned scripts (e.g. GDScript) inside the editor
```

## Key Concepts

### Agent Configs

An agent config defines HOW a job gets executed. It wraps a CLI tool:

- **engine**: `claude-code`, `codex`, `gemini`, or `local-oss`
- **command**: The CLI binary (e.g. `claude`, `codex`, `gemini`)
- **args**: Extra CLI arguments (e.g. `["--allowedTools", "Edit,Read,Write,Bash"]`)
- **model**: Optional model override (e.g. `claude-sonnet-4-5-20250929`)
- **maxTurns**: Max agentic turns before stopping
- **systemPrompt**: Prepended to every job using this config
- **priority**: Default priority (0-100)

The server **never calls AI APIs directly** - it always spawns CLI tools as subprocesses. This means any AI CLI tool that accepts a prompt and produces output can be plugged in.

### Workspace Modes

When the server runs an agent, it needs to decide how the agent interacts with files. The **workspace resolver** (`server/src/workspace/resolver.ts`) uses a 7-step fallback:

1. **`command` mode** - Agent cannot edit files. Instead, it outputs fenced code blocks (scripts) that the bridge executes inside the DCC app. Used when: no project path, cross-machine setups, or explicitly requested. The agent's `Edit/Write` tools are blocked.

2. **`repo` mode** - Agent works directly in a project directory on the server's filesystem. Used when: the bridge's project path exists on the server (same machine), or a Project mapping matches. Before/after file snapshots detect changes.

3. **`sync` mode** - Files are uploaded to a temp directory, agent works there, changes are diffed and sent back. Used when: bridge sends attached files but no project path exists on server.

The resolver logic:
```
preferredMode set? â†’ use it
server default != "auto"? â†’ use server default
no projectRoot? â†’ command
explicit projectId? -> repo (at project.sourcePath)
project_selection == "none"? -> skip project mapping/local repo auto-resolution
project mapping matches? â†’ repo (at mapped path)
projectRoot exists locally? â†’ repo (at that path)
job has attached files? â†’ sync (temp dir)
fallback â†’ command
```

### Workers

A **worker** represents a machine running one or more bridge connections. Workers are:
- **Persistent** - stored in SQLite, survive server restarts
- **Auto-created** - when a client or bridge connects with a `workerName` and optional persistent `machineId`, the server upserts a worker record
- **Status is computed** - `online` when machine presence is detected (any bridge connected for that worker OR a desktop client socket from that machine); `activeBridgeCount` still reflects live bridge sockets only.
- **Machine-ID driven** - worker identity follows a client-owned persistent `machineId` when available, with `workerName` used as the display label and legacy fallback for older clients/bridges. Shared IPs are retained as metadata, not used to collapse distinct machines into one worker.
- **Job targeting** - when submitting a job from the client, you can pick a target worker. The server injects that worker's `lastProjectPath` and dispatches results to all bridges on that worker.

Workers are identified by persistent machine identity (`machineId` when present, otherwise legacy `name` fallback), not by transient bridge connection IDs.

### Bridges vs Workers vs Clients

- **Bridge** = a WebSocket connection from a DCC app plugin (transient, disappears on disconnect)
- **Worker** = a persistent DB record representing a machine (identified by `machineId` when available, survives reconnects and host renames)
- **Client** = a WebSocket connection from the Tauri desktop app or admin panel

Multiple bridges can exist per worker (e.g. Godot + Blender on the same machine).

### Job Dependencies

Jobs can depend on other jobs via `dependsOn: ["job-id-1", "job-id-2"]`. The scheduler won't pick a job until all its dependencies have status `completed`. If a dependency fails, the dependent job stays queued and clients receive a `job_dependency_blocked` notification.

When a parent job with `startPaused` dependents completes, the server auto-resumes paused dependents if all their dependencies are now satisfied.

Coordinator-created sub-jobs are also linked via `parentJobId`, which the Jobs UI renders as a nested tree. Root-job outcome feedback is the user-facing rating surface; when the root is marked, finished descendants inherit that outcome for learning/artifact attribution so users do not need to rate each sub-job independently.

### Policies

Admins configure rules that restrict what agents can do:

| Policy Type | What it Matches | Example |
|-------------|----------------|---------|
| `prompt_filter` | Regex against job prompt | `rm -rf\|DROP TABLE` blocks dangerous prompts |
| `engine_model` | Exact match on engine or model | Block `local-oss` engine |
| `file_path` | Glob against changed file paths | `*.env` blocks touching env files |
| `tool` | Agent tool names | Block `Bash` tool for safety |
| `command_filter` | Regex against command scripts | Block dangerous commands sent to bridges |

Policies are checked at three points:
1. **Submission** - prompt_filter and engine_model checked. Job rejected with 403 if blocked.
2. **Post-completion** - file_path policies checked against actual changes. Job failed if a blocked path was modified.
3. **Command execution** - command_filter checked at spawner (command-mode output), REST bridge-command endpoint, and WS bridge_command_send handler.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Monorepo | pnpm workspaces | Lightweight, workspace protocol support |
| Server runtime | Bun | Fast startup, native SQLite, built-in Bun.spawn, TypeScript without transpile step |
| HTTP framework | Hono | Lightweight, Bun-native, middleware support |
| Database | SQLite (via bun:sqlite) | Zero-dependency, single-file, perfect for local tool |
| Schema validation | Zod | Runtime validation + TypeScript type inference from single source |
| Desktop client | Tauri v2 + Svelte 5 | Native performance, tiny bundle, Svelte 5 runes for reactive state |
| Admin dashboard | Svelte 5 + Vite | Same framework as client, served as static SPA by server |
| Godot bridge | GDScript | Native to Godot editor plugin API |
| Auth | Argon2 (via Bun.password) + session tokens + TOTP 2FA (otpauth) | Industry-standard password hashing + two-factor auth |
| Docker | Multi-stage Bun image | Single container deployment |

### Svelte 5 Runes Pattern

Both client and admin use Svelte 5 runes for state management. Stores are class-based:

```ts
class JobsState {
  all = $state<Job[]>([]);       // Reactive state
  selected = $state<string | null>(null);

  get running() {                 // Computed/derived
    return this.all.filter(j => j.status === "running");
  }
}
export const jobs = new JobsState();
```

All WebSocket message types update stores, which reactively update the UI.

## Monorepo Structure

```
arkestrator/
â”œâ”€â”€ packages/
â”‚   â””â”€â”€ protocol/                    # @arkestrator/protocol - shared Zod schemas
â”‚       â””â”€â”€ src/
â”‚           â”œâ”€â”€ common.ts            # JobStatus, JobPriority, AgentEngine, FileChange, EditorContext
â”‚           â”œâ”€â”€ agents.ts            # AgentConfig, AgentConfigCreate
â”‚           â”œâ”€â”€ jobs.ts              # Job, JobSubmit
â”‚           â”œâ”€â”€ messages.ts          # All 41 WebSocket message types + Message union
â”‚           â”œâ”€â”€ workers.ts           # Worker, WorkerStatus
â”‚           â”œâ”€â”€ projects.ts          # WorkspaceMode, CommandResult, Project
â”‚           â”œâ”€â”€ interventions.ts     # JobIntervention, JobInterventionCreate, JobInterventionSupport
â”‚           â”œâ”€â”€ policies.ts          # Policy, PolicyScope, PolicyType, PolicyAction
â”‚           â”œâ”€â”€ local-agentic.ts     # Local agentic protocol types (prompt builder, parser)
â”‚           â”œâ”€â”€ local-agentic-loop.ts # Shared runAgenticLoop() for client/server local-oss execution
â”‚           â””â”€â”€ index.ts             # Re-exports all
â”‚
â”œâ”€â”€ server/                          # Bun + Hono server (default port 7800; configurable via PORT)
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ index.ts                 # Entry point - wires everything, Bun.serve() with optional TLS
â”‚       â”œâ”€â”€ app.ts                   # Hono app factory (mounts all 19 route files + admin SPA)
â”‚       â”œâ”€â”€ config.ts                # Environment variable config loader (incl. TLS paths)
â”‚       â”œâ”€â”€ db/
â”‚       â”‚   â”œâ”€â”€ database.ts          # SQLite open + migration runner
â”‚       â”‚   â”œâ”€â”€ migrations.ts        # All CREATE TABLE + ALTER TABLE statements
â”‚       â”‚   â”œâ”€â”€ jobs.repo.ts         # Job CRUD + queue operations
â”‚       â”‚   â”œâ”€â”€ agents.repo.ts       # Agent config CRUD
â”‚       â”‚   â”œâ”€â”€ workers.repo.ts      # Worker upsert/list/delete + worker_bridges sub-table
â”‚       â”‚   â”œâ”€â”€ projects.repo.ts     # Project CRUD + bridge path matching
â”‚       â”‚   â”œâ”€â”€ users.repo.ts        # User accounts + sessions + TOTP 2FA
â”‚       â”‚   â”œâ”€â”€ apikeys.repo.ts      # API key generation + validation
â”‚       â”‚   â”œâ”€â”€ policies.repo.ts     # Policy CRUD + effective policy resolution
â”‚       â”‚   â”œâ”€â”€ audit.repo.ts        # Audit log insert + query
â”‚       â”‚   â”œâ”€â”€ usage.repo.ts        # Token usage stats
â”‚       â”‚   â”œâ”€â”€ dependencies.repo.ts # Job dependency tracking
â”‚       â”‚   â”œâ”€â”€ settings.repo.ts     # Key-value server settings (enforce_2fa, etc.)
â”‚       â”‚   â”œâ”€â”€ headless-programs.repo.ts # Headless CLI program registry
â”‚       â”‚   â”œâ”€â”€ skills.repo.ts       # Skill CRUD + search + materialization tracking
â”‚       â”‚   â””â”€â”€ job-interventions.repo.ts # Job intervention/guidance persistence
â”‚       â”œâ”€â”€ routes/
â”‚       â”‚   â”œâ”€â”€ health.ts            # Health check
â”‚       â”‚   â”œâ”€â”€ auth.ts              # Login/logout/me + TOTP 2FA (two-phase login, setup, verify, disable)
â”‚       â”‚   â”œâ”€â”€ settings.ts          # Server settings (enforce 2FA toggle, admin only)
â”‚       â”‚   â”œâ”€â”€ users.ts             # User management (admin)
â”‚       â”‚   â”œâ”€â”€ jobs.ts              # Job CRUD, cancel, requeue, dependencies
â”‚       â”‚   â”œâ”€â”€ agents.ts            # Agent config CRUD
â”‚       â”‚   â”œâ”€â”€ apikeys.ts           # API key management
â”‚       â”‚   â”œâ”€â”€ policies.ts          # Policy CRUD
â”‚       â”‚   â”œâ”€â”€ audit.ts             # Audit log query
â”‚       â”‚   â”œâ”€â”€ stats.ts             # Dashboard stats
â”‚       â”‚   â”œâ”€â”€ connections.ts       # WebSocket connection management
â”‚       â”‚   â”œâ”€â”€ sync.ts              # File upload for sync mode
â”‚       â”‚   â”œâ”€â”€ workers.ts           # Worker list + delete
â”‚       â”‚   â”œâ”€â”€ projects.ts          # Project CRUD
â”‚       â”‚   â”œâ”€â”€ chat.ts              # SSE streaming chat (no job created)
â”‚       â”‚   â”œâ”€â”€ bridge-commands.ts   # Send commands to bridges (with worker-owned headless routing)
â”‚       â”‚   â”œâ”€â”€ headless-programs.ts # Headless CLI program config CRUD
â”‚       â”‚   â”œâ”€â”€ skills.ts            # Skill CRUD, registry, install, search
â”‚       â”‚   â””â”€â”€ agent-cli-auth.ts    # One-click CLI auth for server-runtime agent login
â”‚       â”œâ”€â”€ ws/
â”‚       â”‚   â”œâ”€â”€ hub.ts               # WebSocket connection registry + broadcast + bridge context state
â”‚       â”‚   â”œâ”€â”€ handler.ts           # Message router (validates + dispatches 15+ types)
â”‚       â”‚   â””â”€â”€ auth.ts              # WebSocket authentication
â”‚       â”œâ”€â”€ agents/
â”‚       â”‚   â”œâ”€â”€ spawner.ts           # Agent subprocess lifecycle (spawn, stream, diff, complete)
â”‚       â”‚   â”œâ”€â”€ engines.ts           # Per-engine CLI command builders + bridge orchestration prompt
â”‚       â”‚   â”œâ”€â”€ worker-headless.ts   # Route headless Blender/Godot/Houdini execution to desktop clients
â”‚       â”‚   â”œâ”€â”€ headless-executor.ts # Legacy server-local headless executor (no longer active for DCC routing)
â”‚       â”‚   â”œâ”€â”€ process-tracker.ts   # Running process registry + timeout enforcement
â”‚       â”‚   â”œâ”€â”€ file-snapshot.ts     # Before/after directory snapshots for diffing
â”‚       â”‚   â””â”€â”€ token-parser.ts      # Parse token usage from agent stdout
â”‚       â”œâ”€â”€ queue/
â”‚       â”‚   â”œâ”€â”€ worker.ts            # Poll-based job dispatch loop
â”‚       â”‚   â””â”€â”€ scheduler.ts         # Priority-aware job picker
â”‚       â”œâ”€â”€ workspace/
â”‚       â”‚   â”œâ”€â”€ resolver.ts          # 7-step workspace mode resolution
â”‚       â”‚   â”œâ”€â”€ command-mode.ts      # Command mode prompt injection + output parsing
â”‚       â”‚   â””â”€â”€ sync-manager.ts      # Temp directory lifecycle
â”‚       â”œâ”€â”€ policies/
â”‚       â”‚   â””â”€â”€ enforcer.ts          # Policy evaluation (prompt, engine, file path, tool, command)
â”‚       â”œâ”€â”€ mcp/
â”‚       â”‚   â”œâ”€â”€ tool-server.ts       # MCP tool server (orchestration tools, bridge commands, job control)
â”‚       â”‚   â””â”€â”€ routes.ts            # MCP HTTP/SSE transport + session auth
â”‚       â”œâ”€â”€ skills/
â”‚       â”‚   â”œâ”€â”€ skill-index.ts       # Skill search index + relevance matching
â”‚       â”‚   â”œâ”€â”€ skill-materializer.ts # Materialize learned outcomes into reusable skills
â”‚       â”‚   â”œâ”€â”€ skill-migration.ts   # Migrate legacy coordinator learning to skill system
â”‚       â”‚   â”œâ”€â”€ skill-registry.ts    # External skill registry (browse, install)
â”‚       â”‚   â””â”€â”€ skill-templates.ts   # Built-in skill templates
â”‚       â”œâ”€â”€ middleware/
â”‚       â”‚   â””â”€â”€ auth.ts              # Shared auth helpers (getAuthenticatedUser, requireAdmin)
â”‚       â””â”€â”€ utils/
â”‚           â”œâ”€â”€ logger.ts            # Structured logger with levels
â”‚           â”œâ”€â”€ id.ts                # UUID generation
â”‚           â””â”€â”€ shared-config.ts     # Write ~/.arkestrator/config.json for bridge auto-discovery
â”‚
â”œâ”€â”€ client/                          # Tauri v2 + Svelte 5 desktop app
â”‚   â”œâ”€â”€ src/
â”‚   â”‚   â”œâ”€â”€ App.svelte               # Root: TitleBar + (Boot Screen OR Setup OR Shell) + Toast
â”‚   â”‚   â”œâ”€â”€ pages/
â”‚   â”‚   â”‚   â”œâ”€â”€ Chat.svelte          # Multi-tab chat with SSE streaming, bridge targeting, auto-split
â”‚   â”‚   â”‚   â”œâ”€â”€ Jobs.svelte          # Job list (resizable), detail panel, actions, log stream
â”‚   â”‚   â”‚   â”œâ”€â”€ Admin.svelte         # Embedded admin panel via iframe + postMessage auto-login
â”‚   â”‚   â”‚   â”œâ”€â”€ Workers.svelte       # Worker cards with status + bridge sub-list
â”‚   â”‚   â”‚   â”œâ”€â”€ Projects.svelte      # Project mapping CRUD
â”‚   â”‚   â”‚   â”œâ”€â”€ Coordinator.svelte   # Coordinator management (server/client config, training)
â”‚   â”‚   â”‚   â”œâ”€â”€ Settings.svelte      # Server connection, login/logout
â”‚   â”‚   â”‚   â””â”€â”€ Setup.svelte         # First-time setup flow with TOTP 2FA support
â”‚   â”‚   â”‚   â””â”€â”€ StartupWizard.svelte # Post-login first-time onboarding wizard
â”‚   â”‚   â””â”€â”€ lib/
â”‚   â”‚       â”œâ”€â”€ api/
â”‚   â”‚       â”‚   â”œâ”€â”€ rest.ts          # REST API client (fetch + SSE streaming)
â”‚   â”‚       â”‚   â””â”€â”€ ws.ts            # WebSocket manager (connect, dispatch, reconnect)
â”‚   â”‚       â”œâ”€â”€ stores/
â”‚   â”‚       â”‚   â”œâ”€â”€ connection.svelte.ts  # Server URL, session, status, serverMode
â”‚   â”‚       â”‚   â”œâ”€â”€ jobs.svelte.ts        # Job list + log appending
â”‚   â”‚       â”‚   â”œâ”€â”€ agents.svelte.ts      # Agent config list
â”‚   â”‚       â”‚   â”œâ”€â”€ workers.svelte.ts     # Worker list + bridge list + knownPrograms
â”‚   â”‚       â”‚   â”œâ”€â”€ chat.svelte.ts        # Multi-tab chat state (tabs, messages, bridge selection)
â”‚   â”‚       â”‚   â”œâ”€â”€ bridgeContext.svelte.ts # Per-bridge editor context + context items
â”‚   â”‚       â”‚   â”œâ”€â”€ server.svelte.ts      # Local server process management
â”‚   â”‚       â”‚   â”œâ”€â”€ toast.svelte.ts       # Toast notifications
â”‚   â”‚       â”‚   â””â”€â”€ navigation.svelte.ts  # Current page
â”‚   â”‚       â”œâ”€â”€ components/
â”‚   â”‚       â”‚   â”œâ”€â”€ layout/          # TitleBar, Sidebar, StatusBar
â”‚   â”‚       â”‚   â”œâ”€â”€ chat/            # ChatTabBar, ChatInput, ChatMessageList, ChatContextPanel
â”‚   â”‚       â”‚   â”œâ”€â”€ ui/              # Badge, Toast
â”‚   â”‚       â”‚   â””â”€â”€ ServerManager.svelte
â”‚   â”‚       â””â”€â”€ utils/
â”‚   â”‚           â””â”€â”€ format.ts        # timeAgo, etc.
â”‚   â””â”€â”€ src-tauri/
â”‚       â”œâ”€â”€ tauri.conf.json          # Window config (custom titlebar, size)
â”‚       â”œâ”€â”€ src/main.rs              # Tauri entry point
â”‚       â””â”€â”€ src/lib.rs               # Custom commands (write_shared_config)
â”‚
â”œâ”€â”€ admin/                           # Svelte 5 + Vite web SPA (served at /admin)
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ App.svelte               # Root (login guard + shell + postMessage auto-login)
â”‚       â”œâ”€â”€ pages/
â”‚       â”‚   â”œâ”€â”€ Login.svelte         # Two-phase login (password + TOTP 2FA)
â”‚       â”‚   â”œâ”€â”€ Users.svelte         # User CRUD + role management + insights
â”‚       â”‚   â”œâ”€â”€ ApiKeys.svelte       # API key CRUD with grouped permissions
â”‚       â”‚   â”œâ”€â”€ AgentConfigs.svelte  # Agent config CRUD + CLI auth panel
â”‚       â”‚   â”œâ”€â”€ Machines.svelte      # Worker/machine inventory + per-machine rules
â”‚       â”‚   â”œâ”€â”€ Bridges.svelte       # Program-centric bridge management
â”‚       â”‚   â”œâ”€â”€ CoordinatorTraining.svelte # Training Vault explorer + repository + snapshots
â”‚       â”‚   â”œâ”€â”€ Skills.svelte        # Skill management + registry browser
â”‚       â”‚   â”œâ”€â”€ Knowledge.svelte     # Combined Skills & Training tabbed page
â”‚       â”‚   â”œâ”€â”€ Policies.svelte      # Policy CRUD (5 types)
â”‚       â”‚   â””â”€â”€ AuditLog.svelte      # Paginated audit log
â”‚       â””â”€â”€ lib/
â”‚           â”œâ”€â”€ api/client.ts        # REST API client (incl. 2FA + settings endpoints)
â”‚           â”œâ”€â”€ stores/              # auth (with 2FA state), navigation, toast
â”‚           â””â”€â”€ components/          # layout (Sidebar, Header), ui (Toast, Modal)
â”‚
â”œâ”€â”€ Dockerfile                       # Multi-stage: build admin SPA â†’ Bun server image
â”œâ”€â”€ docker-compose.yml               # Single-service deployment
â”œâ”€â”€ CLAUDE.md                        # Instructions for Claude Code agents
â””â”€â”€ AGENTS.md                        # Instructions for Codex agents
```

## Data Model (SQLite)

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `jobs` | All submitted jobs | id, status, priority, name, prompt, editor_context, files, agent_config_id, bridge_id, worker_name, target_worker_name, result, commands, workspace_mode, logs, error, submitted_by, bridge_program, project_id, created_at, started_at, completed_at |
| `agent_configs` | AI agent configurations | id, name, engine, command, args, model, max_turns, system_prompt, priority |
| `workers` | Persistent machine records | id, name (unique), last_program, last_project_path, last_ip, os_user, first_seen_at, last_seen_at |
| `worker_bridges` | Per-worker program history | worker_id, program, first_seen_at, last_seen_at |
| `projects` | Bridge path â†’ server path mappings | id, name, bridge_path_pattern, source_path, system_prompt |
| `job_dependencies` | Jobâ†’Job dependency edges | job_id, depends_on_job_id |
| `headless_programs` | Headless CLI program configs | id, name, program, command, args (template with `{{SCRIPT}}`/`{{SCRIPT_FILE}}`/`{{PROJECT_PATH}}`), enabled |
| `skills` | Learned/materialized skills | id, slug, program, name, description, content, source_type, source_job_id, tags, enabled, created_at, updated_at |
| `job_interventions` | Operator guidance notes for jobs | id, job_id, user_id, type, content, status, created_at, delivered_at |

### Auth & Admin Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts (username, password_hash, role: admin/user/viewer, totp_secret, totp_enabled, recovery_codes) |
| `sessions` | Session tokens (user_id, token, expires_at) |
| `api_keys` | API keys (name, key_hash, role: bridge/client/admin) |
| `policies` | Restriction rules (scope, type: file_path/tool/prompt_filter/engine_model/command_filter, pattern, action: block/warn) |
| `audit_log` | All admin actions (user, action, resource, timestamp) |
| `usage_stats` | Token usage per job (input_tokens, output_tokens, duration_ms) |
| `server_settings` | Key-value config store (e.g. `enforce_2fa`) |

### Job Lifecycle

```
              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚ paused   â”‚ â† startPaused=true
              â””â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜
                   â”‚ resume
                   â–¼
  submit â†’ â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” pick â†’ â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”
           â”‚  queued   â”‚â”€â”€â”€â”€â”€â”€â”€â†’â”‚ running  â”‚
           â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜        â””â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜
                â”‚                   â”‚
                â”‚ cancel            â”œâ”€â”€ exit 0 â†’ completed
                â–¼                   â”œâ”€â”€ exit !0 â†’ failed
           â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”           â””â”€â”€ timeout â†’ failed
           â”‚ cancelled  â”‚
           â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

Deletable statuses: `paused`, `completed`, `failed`, `cancelled`

## REST API Summary

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| **Auth** | | |
| POST | `/api/auth/login` | Login (two-phase: returns session OR `{ requires2fa, challengeToken }`) |
| POST | `/api/auth/verify-totp` | Complete 2FA login (challengeToken + TOTP code or recovery code) |
| GET | `/api/auth/me` | Current user info (includes `totpEnabled`) |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/auth/totp/setup` | Generate TOTP secret + QR URI + recovery codes |
| POST | `/api/auth/totp/verify-setup` | Confirm 2FA setup with code |
| POST | `/api/auth/totp/disable` | Disable 2FA (requires password + TOTP code) |
| **Settings** | | |
| GET | `/api/settings` | Server settings (enforce_2fa) - admin only |
| PUT | `/api/settings/enforce-2fa` | Toggle global 2FA enforcement - admin only |
| **Jobs** | | |
| GET | `/api/jobs` | List jobs (optional `?status=queued,running`) |
| POST | `/api/jobs` | Create job (JobSubmit body, policy checked) |
| POST | `/api/jobs/:id/cancel` | Cancel a job |
| POST | `/api/jobs/:id/requeue` | Requeue failed/cancelled job (optional `targetWorkerName`) |
| POST | `/api/jobs/:id/resume` | Resume a paused job |
| POST | `/api/jobs/:id/reprioritize` | Change priority |
| DELETE | `/api/jobs/:id` | Delete a finished job |
| POST | `/api/jobs/bulk-delete` | Delete multiple jobs |
| GET/POST/DELETE | `/api/jobs/:id/dependencies` | Manage job dependencies |
| **Resources** | | |
| GET/POST/PUT/DELETE | `/api/agent-configs` | Agent config CRUD |
| GET | `/api/workers` | List workers (enriched with live status + knownPrograms) |
| DELETE | `/api/workers/:id` | Remove a worker record |
| GET/POST/PUT/DELETE | `/api/projects` | Project mapping CRUD (includes systemPrompt) |
| GET/POST/DELETE | `/api/keys` | API key management |
| GET/POST/PUT/DELETE | `/api/users` | User management (admin only) |
| GET/POST/PUT/DELETE | `/api/policies` | Policy CRUD + toggle enable/disable |
| GET | `/api/audit-log` | Audit log query (paginated) |
| GET | `/api/stats/dashboard` | Dashboard statistics |
| GET | `/api/connections` | List WebSocket connections |
| POST | `/api/connections/:id/kick` | Disconnect a client |
| **Chat & Bridges** | | |
| POST | `/api/chat` | SSE streaming chat (no job created, `--max-turns 1`) |
| POST | `/api/bridge-command` | Send command to bridge (sync with timeout; routes configured headless programs to the target desktop client when needed) |
| GET | `/api/bridge-command/bridges` | List connected bridges |
| GET | `/api/bridge-command/context/:target` | Get live editor/context payloads for a bridge program |
| POST | `/api/bridge-command/headless-check` | Run a headless verification command and return stdout/stderr |
| GET/POST/PUT/DELETE | `/api/headless-programs` | Headless CLI program config CRUD |
| **Sync** | | |
| POST | `/api/sync` | File upload for sync mode |

## WebSocket Protocol

All messages use `{ type, id, payload }` envelope. The `id` is a UUID for request/response correlation. 41 message types defined in `packages/protocol/src/messages.ts`.

### Bridge â†’ Server
| Type | Payload | Description |
|------|---------|-------------|
| `job_submit` | JobSubmit | Submit a new job with prompt, editor context, files |
| `bridge_context_item_add` | `{ type, name, data, ... }` | Push a context item (node, script, asset, scene) |
| `bridge_context_clear` | `{}` | Clear all context items for this bridge |
| `bridge_editor_context` | `{ editorContext }` | Update editor state (active file, selections, etc.) |
| `bridge_command_result` | `{ requestId, success, result }` | Response to a command sent by the agent |

### Server â†’ Bridge
| Type | Payload | Description |
|------|---------|-------------|
| `bridge_command` | `{ requestId, script, language }` | Execute a command inside the DCC app |

### Server â†’ Bridge + Clients
| Type | Payload | Description |
|------|---------|-------------|
| `job_accepted` | `{ jobId }` | Job was queued |
| `job_started` | `{ jobId }` | Agent started working on the job |
| `job_log` | `{ jobId, text }` | Real-time log output from agent process |
| `job_complete` | `{ jobId, success, files, commands, workspaceMode, error }` | Job finished |
| `job_updated` | `{ job }` | Full job state broadcast (after any state change) |
| `job_dependency_blocked` | `{ jobId, blockedByJobId, reason }` | Dependency failed |

### Server â†’ Clients
| Type | Payload | Description |
|------|---------|-------------|
| `bridge_status` | `{ bridges }` | Connected bridge info (with workerName, optional machineId, program, osUser) |
| `worker_status` | `{ workers }` | Persistent worker list with computed status + knownPrograms |
| `bridge_context_item_add` | `{ bridgeId, bridgeName, program, item }` | Relayed context item from bridge |
| `bridge_context_clear` | `{ bridgeId }` | Bridge disconnected or context reset |
| `bridge_editor_context` | `{ bridgeId, ..., editorContext }` | Relayed editor state from bridge |
| `bridge_context_sync` | `{ bridges: [...] }` | Full context state on client connect |

### Client â†’ Server
| Type | Payload | Description |
|------|---------|-------------|
| `job_list` / `job_list_response` | `{ jobs }` | Request/receive job list |
| `job_cancel` | `{ jobId }` | Cancel a job |
| `job_reprioritize` | `{ jobId, priority }` | Change priority |
| `job_intervention_list` / `_response` | `{ jobId, interventions }` | List interventions for a job |
| `job_intervention_submit` | `{ jobId, intervention }` | Submit guidance/intervention |
| `agent_config_list` / `_response` | `{ configs }` | List agent configs |
| `agent_config_create/update/delete` | AgentConfig | Manage configs |
| `project_list` / `_response` | `{ projects }` | List projects |
| `bridge_command_send` | `{ target, commands, ... }` | Send command to bridge (routed by program or ID) |
| `worker_headless_result` | `{ correlationId, success, stdout, stderr, ... }` | Client reports headless execution result |
| `client_job_log` | `{ jobId, text }` | Client streams log line from local agentic loop |
| `client_job_complete` | `{ jobId, success, error, commands, durationMs }` | Client reports local job completion |
| `client_tool_request` | `{ jobId, correlationId, tool, args }` | Client requests server-side tool execution |
| `error` | `{ code, message }` | Error response |

### Server â†’ Client (Dispatch)
| Type | Payload | Description |
|------|---------|-------------|
| `client_job_dispatch` | `{ jobId, job, agentConfig, basePrompt, model, ... }` | Server dispatches local-oss job to client for execution |
| `client_tool_result` | `{ jobId, correlationId, ok, data, error }` | Server returns tool execution result |
| `client_job_cancel` | `{ jobId }` | Server tells client to cancel a dispatched job |
| `worker_headless_command` | `{ senderId, correlationId, program, execution, ... }` | Server routes headless DCC execution to client |
| `job_intervention_updated` | `{ jobId, intervention, support }` | Intervention state changed |
| `file_deliver` | `{ files, projectPath, source }` | Cross-machine file delivery to client |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7800` | Server HTTP/WS port (desktop local mode can override this per-machine from Setup/Admin/Settings) |
| `DB_PATH` | `./data/arkestrator.db` | SQLite database path |
| `MAX_CONCURRENT_AGENTS` | `2` | Max simultaneous agent subprocesses |
| `WORKER_POLL_MS` | `1000` | How often the worker loop checks for queued jobs |
| `JOB_TIMEOUT_MS` | `1800000` (30 min) | Kill agent after this duration |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DEFAULT_WORKSPACE_MODE` | `auto` | `auto`, `command`, `repo`, `sync` |
| `SYNC_TEMP_DIR` | `./data/sync-tmp` | Temp directory for sync mode |
| `SYNC_TTL_MS` | `1800000` (30 min) | How long to keep sync dirs after completion |
| `SYNC_CLEANUP_INTERVAL_MS` | `300000` (5 min) | Cleanup check interval |
| `SYNC_MAX_SIZE_MB` | `500` | Max total sync storage |
| `TLS_CERT_PATH` | - | Path to TLS certificate file (enables HTTPS) |
| `TLS_KEY_PATH` | - | Path to TLS private key file (requires `TLS_CERT_PATH`) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |

## Development Setup

### Prerequisites
- **Node.js** (for pnpm and npx)
- **pnpm** (`npm install -g pnpm`)
- **Bun** (`npm install -g bun`) - server runtime
- **Rust** (https://rustup.rs) - only needed for building the Tauri client

### Quick Start
```bash
pnpm install                                    # Install all workspace deps
pnpm --filter @arkestrator/protocol build     # Build shared protocol package

# Start the server
cd server && bun src/index.ts

# In another terminal - start the Tauri client
cd client && pnpm tauri dev

# Or start the admin dashboard in dev mode
cd admin && pnpm dev
```

### After Changing Protocol Schemas
```bash
pnpm --filter @arkestrator/protocol build     # Rebuild - required!
```

### Type Checking
```bash
cd client && npx svelte-check     # Client type check
cd admin && npx svelte-check      # Admin type check
```

### First Run
On first server start:
1. Default admin user created: `admin` / `admin` (change immediately!)
2. Admin API key auto-generated
3. Default Claude Code agent config created
4. Default headless programs seeded (blender, godot, houdini)

API keys are auto-provisioned on login - users never see or manage them directly.

## Client vs Admin Responsibility Split

| Feature | Client (Tauri) | Admin (Web) |
|---------|---------------|-------------|
| Chat interface (SSE streaming) | Yes (primary UX) | No |
| Job monitoring + actions | Yes (via Jobs page) | No |
| Agent config CRUD | No (uses embedded admin) | Yes |
| Worker status | Yes (card view) | No |
| Project mappings | Yes | No |
| Embedded admin panel | Yes (iframe at Admin tab) | N/A |
| User management | No | Yes |
| API key management | No | Yes (ApiKeys page, permission-gated) |
| Policy management | No | Yes (Policies page, permission-gated) |
| Skills & Training | No | Yes (Knowledge page - Skills + Training Vault) |
| Bridge management | No | Yes (Bridges page, permission-gated) |
| Audit log | No | Yes (permission-gated) |
| Local server management | Yes (auto-boot) | No |
| Native desktop | Yes (Tauri) | No (web SPA) |

The client embeds the admin panel via iframe with `postMessage` session token handoff, so users access the admin surface (users, agents, filters, and audit log) from within the Tauri app without logging in twice.

## Implementation Status

### Completed
- Protocol package with all Zod schemas (41 message types including client dispatch, headless, file delivery, interventions)
- Server: full REST API (19 route files), WebSocket hub, job queue, agent spawner, workspace resolution
- Server: user accounts, session auth, API keys (with fine-grained per-key permissions), policies, audit logging
- Server: TOTP 2FA (two-phase login, recovery codes, admin enforcement)
- Server: optional TLS/SSL support
- Server: persistent workers with program history (worker_bridges), job-to-worker targeting, multi-bridge dispatch
- Server: headless program execution routed to desktop client/worker (worker-headless.ts)
- Server: cross-bridge command system, SSE chat endpoint
- Server: compiled sidecar binary for Tauri client
- Server: MCP Tool Server (tool-server.ts + routes.ts) with full orchestration tools, bridge commands, job control, client-API forwarding, per-user MCP gating
- Server: Skills/Outcome Learning System (skill-index, skill-registry, skill-materializer, skill-migration, skill-templates, skills.repo.ts, skills.ts route)
- Server: Coordinator system (playbooks, task definitions, training orchestration, source analysis, adaptive guidance matching, outcome learning)
- Server: Training Vault (analysis, outcome capture, skill materialization, zip export/import, artifact attribution)
- Server: Agent CLI auth endpoints (agent-cli-auth.ts) for one-click Claude/Codex login in container/server environments
- Server: Job interventions/guidance system (live operator notes delivered to running jobs, job-interventions.repo.ts)
- Server: Worker-scoped heavy-resource leases (GPU/VRAM serialization per machine)
- Server: Dynamic provider model discovery (Claude from runtime artifacts, Codex from models_cache.json)
- Client: multi-tab chat interface with SSE streaming, smart auto-split, machine-scoped targeting
- Client: full job management, worker monitoring, project viewing
- Client: embedded admin panel via iframe with postMessage auto-login
- Client: auto-boot local server (sidecar in prod, Bun in dev)
- Client: TOTP 2FA login flow, bridge context display
- Client: Coordinator page (server/client config, training, script management)
- Client: Client-dispatch local agentic loop (localAgenticLoop.ts, ollamaClient.ts, clientJobManager.ts) for local-oss job execution via Ollama
- Client: File Delivery System (file_deliver WS message handler, Tauri fs commands: fs_apply_file_changes, fs_create_directory, fs_write_file, fs_read_file_base64, fs_delete_path, fs_exists)
- Client: Headless execution routing (worker_headless_command handler, run_worker_headless Tauri command)
- Client: Bridge Plugin Installer & Distribution (BridgeInstaller.svelte, bridges.rs Rust backend, registry.json, release CI packaging)
- Client: System tray (close-to-tray, tray menu show/hide/quit) + auto-updater (startup check, download/install/restart)
- Client: Configurable local server port (Setup/Settings/Admin controls)
- Client: Local bridge relay for remote server connections
- Admin: full admin scope (Login, Users, ApiKeys, AgentConfigs, Machines, Bridges, Knowledge/Skills/Training, Policies, AuditLog), capability-gated navigation
- Admin: per-user fine-grained capability editing (full matrix including users/agents/projects/policies/security/audit/usage/coordinator/mcp/intervene/executeCommands/deliverFiles/submitJobs) plus per-user settings (`require2fa`, `clientCoordinationEnabled`, token limits)
- Admin: postMessage auto-login from Tauri client iframe
- Admin: Training Vault explorer with repository controls, snapshots, zip export/import, job metadata table
- Admin: Skills page with skill management, registry browser, import/export
- Admin: Bridges page with program-centric management (edit script, kick, remove, add)
- Admin: API Keys page with grouped permission checkboxes, edit permissions modal
- Admin: Agent CLI auth panel for one-click Claude/Codex login
- Godot bridge: context push, file application, command execution, cross-bridge, SDK public API
- Blender bridge: context push, file application, command execution, cross-bridge, SDK public API, runtime context menu discovery
- Houdini bridge: context push, file application, Python+HScript execution, cross-bridge, SDK public API
- Fusion / DaVinci Resolve bridge: comp structure, tool settings, flow graph, Loaders/Savers, 3D scene, modifiers, keyframes, Fuse/RunScript sources, macros; Python + Lua execution
- ComfyUI bridge: standalone Python bridge, workflow execution, image/video artifact collection, system stats
- Unity bridge: context push, file application, `unity_json` command execution, cross-bridge
- Unreal bridge: C++ editor plugin, selected actors/level context, Python/console command execution, file applier
- Version infrastructure: `/health` exports `protocolVersion` + `capabilities`, bridges send `protocolVersion` on WS connect
- Docker support (GHCR publish, multi-stage Bun image, pnpm filtered install)
- Server hardening: JSON parse guards on all POST/PUT routes, invalid regex warning in enforcer, sync max size enforcement, CORS defaults, security audit pass
- Performance: SQL-based dashboard stats, job list pagination (REST + WS), N+1 query fixes (workers JOIN, job enrichment batch), 5 MB log buffer cap, WS log broadcast batching (200ms), client job store in-place updates with coarse-grained derivation, RAF-based autoscroll
- Server: Settings route split (7 sub-modules), Training module split (5 sub-modules)
- Server: Job queue retry system (retry-policy.ts, transient failure detection, exponential backoff, stale job expiry)
- Server: Skills versioning (skill_versions table, rollback), validation (skill-validator.ts), effectiveness tracking (skill_effectiveness table)
- Server: Process tracker suspend/resume for concurrency slot management
- Server: Semantic similarity in playbook task ranking (48-dim cosine similarity)
- Build: cross-platform admin build script (scripts/build-admin.mjs, pnpm build:admin)
- Client UX: error handling + toasts on all Jobs page actions, ConfirmDialog for all delete actions, self-service password change, platform-aware title bar
- Protocol: binary file support in FileChange (`binaryContent` base64 + `encoding` field), `binary_files` capability flag
- Protocol: shared local agentic loop (local-agentic.ts, local-agentic-loop.ts) for server+client local-oss execution
- Bridge fixes: path traversal validation (Blender + Godot), Godot context item payload nesting, Godot reconnection countdown, binary file handling in all bridges
- Structured SDK error codes: all REST error responses include `{ error, code }` with typed ErrorCode enum for programmatic handling
- Agent config templates: preset configs for Claude Sonnet/Opus, Gemini, Codex, Custom Local with "Add from Template" UI
- Job submission rate limiting: 10 jobs/minute per API key
- CI/CD pipeline (GitHub Actions: build protocol, type-check client+admin, run server+protocol tests, release builds for macOS/Windows/Linux)
- VS Code extension (Chat Participant + standalone webview, auto-discovery, status bar)

### Pending
(No major pending items -- all planned v0.1.x features have shipped.)

### Recently Completed
- Bridge Plugin Installer & Distribution: `bridges/registry.json` + `BridgeInstaller.svelte` + `bridges.rs` Rust backend + release CI bridge packaging + version sync across bridge manifests + release workflow fixes (macOS conditional signing, Linux FUSE workaround).
- Documentation positioning update: README now describes Arkestrator as program-agnostic (bridge-first, not DCC-limited), and docs now include a dedicated bridge development guide (`docs/bridge-development.md`) with protocol/handshake/message/checklist details for third-party bridge authors.
- Houdini coordinator generalization: replaced pyro-only coordinator enforcement with task-classified guidance (modeling/fx/render/debug), added explicit instruction to prefer matched project scripts/docs from repo/client sources, and limited pyro wiring gates to explicit pyro/explosion tasks.
- Attachment prompt sanitation: chat `Attach` flow now writes metadata-only attachment references (name/size/type) into prompts and stops inlining raw text/data-url payloads, preventing oversized base64/code blobs from flooding job logs.
- VPS HTTPS deployment path: added `docker-compose.vps.yml` with Caddy TLS reverse proxy, `deploy/caddy/Caddyfile`, `.env.vps.example`, and new deployment runbook (`docs/deployment-vps-caddy.md`).
- Release-readiness verification pass for rebrand: validated `@arkestrator/protocol` build, `@arkestrator/admin` build, `@arkestrator/client` build, full server+protocol test suite (`184` passing), VS Code extension build (`arkestrator-vscode`), sidecar compile, and live `/health` smoke check.
- Startup resilience hardening for migrated DB paths: server DB open now recovers from invalid legacy DB files by quarantining corrupted files (`*.invalid-<timestamp>`) and creating a fresh database automatically.
- VS Code extension Arkestrator identity cleanup: command/chat/config identifiers now use `arkestrator.*` only.
- Arkestrator pre-release hard cutover: package scope renamed to `@arkestrator/*`, runtime naming is now Arkestrator-only before public launch. Shared config uses `~/.arkestrator/config.json`, runtime env vars use `ARKESTRATOR_*`, sidecar outputs use `arkestrator-server-*`, and coordinator config files use `arkestrator.coordinator.json/.md`.
- Core fallback/generalization refactor: disconnected-bridge fallback logic is now centralized in `server/src/agents/fallback-execution.ts` and reused across spawner, REST bridge-command route, and WS bridge-command routing to reduce duplicated hardcoded program logic in core flows.
- Security/hygiene hardening pass: runtime secret artifacts (`server/.mcp.json`, local Claude settings, generated codex prompt files) were removed from tracked files, and ignore rules were tightened to prevent reintroduction.
- Bootstrap credential policy hardening: first-run admin password now comes from `BOOTSTRAP_ADMIN_PASSWORD` (if strong) or a generated secret written to `bootstrap-admin.txt`; raw bootstrap credentials are no longer logged.
- Public launch docs baseline: added top-level `README.md` and structured `docs/` guides (`installation`, `usage`, `architecture`, `how-it-works`, `configuration`, `migration`, `release checklist`) plus explicit readiness reports under `docs/reports/`.
- GitHub docs detailed refresh: README and `docs/` usage guides now explain coordinator scripts, project onboarding on server/client, and training via source analysis; migration-specific nav references were removed from GitHub-facing docs indexes/plans.
- Chat project-selection + resolver fix: chat tabs now default to `none` project mode (`none`/`auto`/project), stale project IDs are auto-cleared, and submitted metadata includes `project_selection`; server resolver honors `project_selection="none"` to skip mapped/local repo auto-resolution and fall through to sync/command.
- Chat duplicate status-line fix: top-level submitted jobs now keep a single chat system entry while sub-jobs still emit transition updates once per status change.
- Jobs log controls (client + admin parity): both Jobs pages now expose auto-scroll modes for logs (`Live`, `Slow`, `Paused`) and a `Save Log` action that downloads the latest full job log to disk as a `.log` file.
- Admin refactor + user capability controls: admin navigation/routing now focuses on core admin ops (Users, AgentConfigs, Filters, Audit Log); users page has explicit list error/loading states and unified `Edit` modal controls for role, per-user 2FA requirement, client coordination toggle, token limits, and full capability matrix; policies page includes `command_filter` support for prompt/command allow-deny controls; server persists capabilities (`users.permissions`) and enforces them on `/api/users` plus permission-gated admin routes.
- Houdini startup compatibility fix: bridge `pythonrc.py` no longer assumes `__file__` exists; package root is now resolved via `HOUDINI_PATH`/`HOUDINI_USER_PREF_DIR` fallback, preventing startup `NameError` in pythonrc execution context.
- Bridge context-menu reliability fix (Houdini + Blender): Blender right-click menu registration now guards against duplicate appends on reload, and Houdini OPmenu action now reports import/callback failures via Houdini dialog with package import fallback (preventing silent no-op clicks).
- Jobs live-state UX refresh: server now broadcasts `job_updated` immediately after workspace resolution and on incremental bridge attribution updates, so running jobs show current `workspaceMode` and source bridge badges without waiting for completion.
- Bridge attribution false-positive fix: spawner `usedBridges` inference now only reads structured execution markers (MCP/tool lines + executed `am` command traces), not generic `target="..."` prose in model output/logs, preventing accidental extra bridge badges.
- Chat prompt composer upgrade: client chat input now supports `Attach` references (text files including `.obj`, plus images as data URLs) and keeps the original prompt visible during Improve streaming with a pulsing `Improving prompt...` hint.
- Context item naming UX: chat context panel now supports per-item client-side `rename` aliases (instead of relying only on `@N`), and renamed labels are included in submitted `contextItems` so prompts can reference meaningful names.
- Bridge key desync fix: login no longer revokes all existing auto-provisioned user API keys before issuing a new one, so already-running bridges keep authenticating after new client logins.
- Offline/headless routing fix: chat submissions now include explicit `bridgeProgram` when a single offline/headless bridge is selected, and job creation prioritizes this field for bridge/fallback targeting.
- ComfyUI execution reliability pass: validated both bridge-online and no-bridge fallback workflows with real image/video generations, added server-side ComfyUI fallback execution path (`/prompt` + `/history` + artifact fetch), and fixed artifact-kind inference so video outputs are reported as `kind: "video"` across bridge and fallback paths.
- Windows CLI spawn hardening for chat/jobs (`spawnWithFallback`): retries `.cmd/.exe/.bat` shims on ENOENT so commands like `codex` resolve reliably on Windows.
- Codex CLI compatibility update: switched server invocation from deprecated `--approval-mode full-auto` to `codex exec --full-auto` for non-interactive runs.
- Server listener hardening: removed `reusePort` to prevent multiple Bun server processes from silently sharing the same port.
- Dev reset command: `pnpm reset:dev` now performs a full local reset (kills dev ports, clears `server/data`, removes `~/.arkestrator/config.json`).
- Client startup guard (dev local mode): before spawning its own Bun server, the client now probes the configured localhost health URL and reuses an existing server on that port if available, preventing duplicate-local-server port conflicts.
- Agent config live sync: REST and WS create/update/delete paths now push full `agent_config_list_response` updates to connected clients, so newly added configs (e.g., Codex) appear in the client without reconnecting.
- Codex compatibility hardening: removed legacy `-p` from Codex template and normalized legacy Codex args (`-p`, `--approval-mode full-auto`) in chat/job command builders so prompts are passed correctly with modern `codex exec`.
- Startup Codex config sanitation: server now auto-normalizes legacy Codex args in existing DB agent configs on boot, preventing stale saved configs from breaking chat prompts.
- Codex chat tuning: `/api/chat` Codex path now uses stateless prompts (no stitched history) plus a direct-response instruction prefix to avoid repeated generic greeting responses.
- Codex orchestration parity: server job spawn path now injects the same instruction chain for Codex as Claude (project/config/command-mode/orchestration) and adds Codex-specific bridge CLI guidance (`am bridges`, `am context`, `am exec`, `/api/jobs` REST) so cross-bridge orchestration works without MCP bindings.
- Codex command-mode bridge-runtime fix: command-mode Codex jobs now run from isolated temp cwd (`$TMPDIR/arkestrator-codex/<jobId>`), use `--sandbox danger-full-access --skip-git-repo-check` (instead of `--full-auto`), and strip inherited Codex sandbox/session env vars in spawner so localhost bridge CLI calls (`am bridges/context/exec`) no longer fail with `fetch failed`.
- Bridge-targeted chat submission mode fix: client now sends `preferredMode: "command"` for bridge-targeted jobs (unless explicit project override is selected), preventing DCC orchestration prompts from being auto-resolved to local repo mode when `projectRoot` exists on disk.
- Workspace resolver bridge-targeted safeguard: server resolver now defaults jobs with bridge-target metadata (`target_bridges` + `bridgeProgram`) to command mode before repo path auto-detection, preventing false-success repo runs for live DCC orchestration.
- Codex command parse hardening: command-mode parsing now prefers tail output for Codex and deduplicates identical fenced scripts, avoiding execution of echoed prompt example code blocks.
- Codex command-mode guidance hardening: added explicit CLI guidance to avoid local `apply_patch`/Write/Edit loops and prefer temp heredoc scripts plus `am exec -f` for multiline bridge commands.
- Codex chat-mode hardening + Windows prompt-arg fix: `/api/chat` Codex instruction prefix now explicitly blocks meta acknowledgements (e.g., "Understood", "Send your task"), avoids generic setup questions and "paste it again" loops, and prioritizes immediate refined-prompt output when users ask to improve/rewrite prompts. Chat route now strips inherited `CODEX_THREAD_ID`/sandbox env vars (plus `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`), runs Codex chat in temp cwd (`$TMPDIR/arkestrator-codex-chat`), adds `--skip-git-repo-check`, and encodes multiline prompt args on Windows (`\n` -> literal `\\n`) so full prompts are not truncated after line 1.
- Codex job-mode Windows command length hardening: `buildCodexCommand()` now detects oversized prompt args on Windows and writes the full prompt to a per-job file (`.arkestrator-codex-prompt-<jobId>.txt`), then passes a short pointer prompt to avoid CreateProcess failures (`[stderr] The command line is too long.`).
- Houdini coordinator synchronization hardening: Houdini orchestrator prompt now enforces blocking gates for long-running stages (sim/cache/render/USD export). Agents must wait for completion and verify file outputs (exists, non-zero, expected frame coverage) before advancing to next pipeline stage.
- Houdini cache-validation hardening: Houdini orchestrator prompt now requires cache integrity checks (file-size sanity across frames + required attribute/content validation). Suspiciously small or attribute-empty caches are treated as failures and must be regenerated before downstream steps.
- Houdini coordinator strict explosion QA loop: prompt now enforces explicit `OUT_SIM -> CACHE_EXPLOSION` wiring validation, cache-readback branch usage (avoid re-sim during render), and iterative frame-30 image scoring gates (`non_black_ratio`, `warm_ratio`, `bright_ratio`, center-vs-border brightness) before success.
- Houdini pyro source rasterization hardening: prompt now enforces the exact pyro SOP chain `MESH_SOURCE -> PYRO_SOURCE -> RASTERIZE_SOURCE -> PYRO_SOLVER`, then cache/readback into render (`OUT_SIM -> CACHE_EXPLOSION -> FILE_FROM_CACHE -> OUT_CACHED -> Karma`), validates rasterized source fields before caching, and includes explicit SideFX + Tokeru references.
- Houdini coordinator reference-search gate: prompt now requires searching the active project and loaded reference/playbook paths for similar setups first, then using SideFX/Tokeru docs only when no close local pattern exists.
- Houdini bridge metadata freshness: Houdini bridge now detects active `.hip` path changes and refreshes WS connection metadata (`name`/`projectPath`) so bridge status no longer stays stale at initial `Untitled` after opening/saving scenes.
- Houdini/ComfyUI reconnect lifecycle fix: bridge `ws_client.connect()` now stops the old socket thread before clearing the stop-event and starting a replacement thread, plus skips reconnect when metadata URL is unchanged. This prevents metadata-refresh reconnect failures that could leave stale bridge names (for example `untitled.hip`).
- Bridge metadata sync without reconnect churn: Houdini bridge now updates active HIP changes through normal editor-context pushes (server derives bridge `name`/`projectPath` from `activeFile`/`projectRoot`) instead of forcing socket reconnects, preventing bridge disappearance on file-open.
- Offline bridge persistence in client lists: WS bridge/worker updates now synthesize offline bridge entries from worker `knownPrograms`, so closing Blender/Houdini no longer removes them from selectable bridge lists.
- Client bridge-state race fix: `worker_status` updates no longer rebuild bridge lists, avoiding cases where Houdini could appear offline during/after HIP metadata updates if worker snapshots arrived out of order with bridge status messages.
- Multi-session bridge visibility fix: WS hub stale-replacement logic now keys by `(program, workerName, projectPath)` instead of `(program, workerName)` so multiple live sessions (for example two Houdini scenes) on one worker stay online simultaneously while true same-project stale sockets are still replaced.
- Workers UI bridge grouping: same-worker/same-program bridge sessions are now rendered as one bridge row (for example one Houdini entry) with a unioned project-path list and session count, so users see `HOUDINI: - file1 - file2` style grouping instead of fragmented rows.
- Workers UI full-path readability: grouped bridge path lists no longer clip long paths with ellipsis; they now wrap across lines so full network/project filepaths remain visible.
- Multi-project bridge visibility: bridge status payloads now include `activeProjects` (latest-first) sourced from editor context and command execution `projectPath`, so bridge rows can show all currently worked project paths, not just one.
- Houdini right-click context action: added bridge package `OPmenu.xml` plus `arkestrator_bridge.add_selected_nodes_to_context(kwargs)` so node right-click menus include `Add to Arkestrator Context` and push selected nodes into the shared context bag. Menu definition uses additive `addScriptItem` under `root_menu`; package-level `arkestrator_bridge/OPmenu.xml` is now the single source to prevent duplicate-id crashes when both user-level and package-level OPmenu files are loaded.
- Houdini right-click menu visibility follow-up: OPmenu context visibility was simplified to `<expression>True</expression>` (removed invalid `return`-based block), restoring reliable display of `Add to Arkestrator Context` after startup.
- Houdini right-click menu structure follow-up: package `OPmenu.xml` now uses canonical OPmenu layout (`<menu><scriptItem>`) instead of top-level additive item wiring, improving compatibility so the context entry appears across node/text RMB targets.
- Houdini context-source expansion follow-up: `add_selected_nodes_to_context(kwargs)` now also captures viewport geometry selections (points/primitives/edges/vertices) and script-bearing parm context (for example wrangle/python snippets), so context adds are no longer limited to network-node selections.
- Bridge context duplicate suppression: context-bag ingestion is now idempotent by `@index` per bridge on both server (`WebSocketHub.addBridgeContextItem`) and client (`bridgeContextStore.addItem`), preventing single add actions from rendering duplicate `@1` rows when duplicate events are received.
- Worker/offline bridge persistence hardening: WS bridge connect now derives stable worker identity fallback when `workerName` is missing (`workerName` â†’ `osUser@ip` â†’ `host-ip` â†’ name/program), upserts worker history consistently, and rebroadcasts worker status on bridge connect/disconnect so offline bridge targets remain available.
- Multi-bridge attribution from CLI bridge commands: `am` wrapper now forwards `X-Job-Id` (from `ARKESTRATOR_JOB_ID`), `/api/bridge-command` appends `usedBridges` on success (including headless/comfy fallbacks), and broadcasts `job_updated` so Jobs UIs show true multi-bridge sources instead of only initial `bridgeProgram`.
- Client WS reconnect stability: fixed stale-socket race in `client/src/lib/api/ws.ts` where an old socket `onclose` could schedule reconnect after a new socket was already active, causing periodic admin/client disconnect-connect churn.
- Dev reset hardening (Windows): `reset:dev` now handles transient `EBUSY/EPERM` file locks on `server/data` with retries and best-effort continuation instead of exiting non-zero.
- ComfyUI bridge (`bridges/comfyui/`) - Standalone Python bridge connecting Arkestrator WS + ComfyUI HTTP API. Workflow command execution, image artifact collection, system stats context push. CLI: `python -m arkestrator_bridge`
- UE5 plugin (`bridges/unreal/`) - C++ editor plugin using UE5 WebSockets module. Selected actors/level context, Python/console command execution, file applier, Blueprint-callable API
- CI/CD pipeline (GitHub Actions: build protocol, type-check client+admin, run 166 tests)
- Unit/integration tests (104 server + 62 protocol, Bun test runner, in-memory SQLite)
- Per-user token/cost limits (DB columns, worker enforcement, REST endpoints, admin UI, spawner userId fix)
- VSCode extension (`extensions/vscode/`) - Chat Participant + standalone webview, auto-discovery, status bar
- Blender bridge parity + critical bug fix: stripped to thin execution endpoint (removed log panel, `get_bridge()`/`_BridgeAPI`, `log_text`, `dashboard_path`). Fixed scene-guard bug that silently dropped all `bridge_command` messages. End-to-end verified via real orchestration job: agent sent Python to Blender (sphere OBJ export) and GDScript to Godot (scene file), both bridges responded with real `bridgeId`/`correlationId` JSON, output files confirmed on disk.
- MCP fixes: StatelessTransport no longer hangs on notifications (no `id` field â†’ 202 immediately), curl restored as primary orchestration method in system prompt, `am` CLI writes both `am.cmd` (cmd.exe) and `am` bash script (Git Bash/Claude Code).
- MCP job-control parity expansion: added `list_targets` (live bridges + enabled headless programs), `get_job_logs` (tail logs with line limits), and `cancel_job` tools. MCP cancel now uses `ProcessTracker` when available so running subprocesses are terminated before status transition.
- MCP client-parity bridge + user gate: added `client_api_request` MCP tool to forward allowlisted non-admin client REST calls (jobs/chat/projects/workers/coordinator-training flows) with caller auth headers, and added per-user `useMcp` capability enforced by `/mcp` auth so admins can allow/disallow MCP access per user.
- Startup script refresh: added root `start:latest` (`git pull --ff-only && pnpm dev`) and switched `start.bat` / `start.sh` to call it so launcher scripts always fast-forward to latest before booting dev.
- CLI/MCP parity hardening: added bridge context and headless-check REST endpoints (`GET /api/bridge-command/context/:target`, `POST /api/bridge-command/headless-check`), expanded `am` CLI to cover context, multi-command execution, agent config list, job create/status/list, and headless checks. MCP `run_headless_check` now reuses the same server helper as REST.
- VSCode extension parity refresh: extension REST client now tolerates both legacy and current `/api/workers` payloads (`Worker[]` vs `{ workers, bridges }`), parses structured server error payloads for cleaner UX, and status flows now report bridge counts plus worker online/active-bridge details.
- Bridge coordinator prompt quality pass: per-bridge defaults (Blender/Godot/Houdini/ComfyUI/Unity/Unreal) now include direct official documentation links; global/Codex guidance updated with explicit CLI equivalents for MCP-only workflows.
- Unity plugin (`bridges/unity/`) - C# Editor bridge with auto-connect from shared config, periodic context sync, context-item forwarding, path-safe file application, and structured `unity_json` execution actions.
- Coordinator script API hardening: `GET/PUT/DELETE /api/settings/coordinator-scripts/:program` now validates filename-safe program keys and rejects path-traversal-like values with `400 INVALID_INPUT`. Added dedicated route tests to prevent regressions.
- Admin-gated client-side coordination mode: added global gate (`allow_client_coordination`) in settings routes + admin Security UI, per-user opt-in (`client_coordination_enabled`) via auth route + client Settings UI, capability probe store (CPU/RAM/GPU + local model runtime detection), `coordinationMode` metadata on jobs (`server|client`), enforcement in `POST /api/jobs`, and audit events for toggles + client-coordinated submissions.
- Client coordinator management UX + playbook API expansion: client Settings now exposes a permission-gated Coordinator tab (`canEditCoordinator` or admin) with organized sections for playbook manifest editing, existing playbook file load/save, task reference-folder linking, GitHub demo repo references, uploads, and local/NAS reference path management. Server settings routes now expose recursive playbook file listing, safe file reads (`GET /api/settings/coordinator-playbooks/:program/files?path=...`), and GitHub reference cloning (`POST /api/settings/coordinator-playbooks/:program/add-reference-repo`), with route coverage for nested listing/read + invalid-repo validation.
- Coordinator source layering + dedicated Coordinator client tab: added additive external playbook source support via `coordinator_playbook_sources` (`GET/PUT /api/settings/coordinator-playbook-sources`) and one-by-one source onboarding endpoint `POST /api/settings/coordinator-playbooks/:program/add-source` with optional `autoAnalyze` folder mode (auto-generates manifest + task instruction files). Client sidebar now has a dedicated `Coordinator` tab for users with coordinator permissions, and source management supports one-by-one add/remove plus auto-analyze toggling.
- Client/server resource promotion flow + server policy visibility: Coordinator now separates `Server Resources` vs `Client Resources`; admins can toggle global client-side orchestration policy directly in `Server Resources`, `add-source` now accepts relative paths inside the program playbook directory, and client folder uploads preserve nested structure via per-file upload `paths[]` with optional auto-add/auto-analyze source registration.
- Coordinator simplification + training flow: client Coordinator page is now bridge-first with clear `Server Config` / `Client Config` tabs, unified script+source+prompt management, clickable project prompt configs, source analysis endpoint (`POST /api/settings/coordinator-playbooks/:program/analyze-source`) that auto-creates/updates `arkestrator.coordinator.json`, and a training endpoint (`POST /api/settings/coordinator-playbooks/:program/train-script`) that previews/applies script improvements from analyzed project prompts.
- Coordinator async analyze jobs + source naming + raw JSON editing: server source-path settings now support named entries (`entries[{path,name}]`), analyze/replace can be queued as background analyze jobs (`POST /api/settings/coordinator-playbooks/:program/analyze-source-job` + status/list endpoints), queued analyze runs are mirrored into the global jobs stream/table as first-class jobs, analyze writes both structured JSON (`arkestrator.coordinator.json`) and detailed Markdown notes (`arkestrator.coordinator.md`) with project inventory/key files/largest files/sampled paths, project prompt configs now expose raw JSON read/write endpoints, and client Coordinator UI now supports named/foldout server-local source rows, explicit `Edit JSON`, global script above bridge selection with bridge-specific script below, and push-to-server from selected existing local path.
- Coordinator analyzer mode toggle: coordinator analyze now supports explicit `fast` (deterministic local scan) and `ai` (bridge-backed LLM job) modes. AI mode is bridge-gated per target program (e.g., Houdini requires online Houdini bridge), queues standard jobs with live logs/status, and then re-collects generated project config summaries for the coordinator page.
- Coordinator config reliability + analyze model control: JSON remains canonical (`arkestrator.coordinator.json`) while Markdown stays a human summary (`arkestrator.coordinator.md`). Settings routes now auto-recover JSON from Markdown when JSON is missing (including project-config reads and analyze collection), notes include an embedded JSON snapshot for deterministic recovery, and admins can choose the default analyze agent/model via `GET/PUT /api/settings/coordinator-analyze-agent` (wired into client Analyze Settings).
- Coordinator adaptive guidance matching + outcome learning: runtime playbook loading supports detailed matched-context output (task playbooks + discovered project guidance docs from server/client sources), and outcome feedback now persists both per-program learning indexes/experiences plus per-job artifacts under `data/coordinator-playbooks/_learning/jobs/<program>/` (`<label>--<jobId>.json`) for inspectable job-level learning context.
- Coordinator source scoping by bridge: source paths now carry program scope metadata (`coordinator_playbook_source_programs`) and are filterable via `GET /api/settings/coordinator-playbook-sources?program=<bridge>`. Spawner filters configured source paths by target bridge so Blender jobs no longer inherit Houdini-only source references.
- Coordinator self-training scheduler + run-now jobs: added schedule settings (`GET/PUT /api/settings/coordinator-training-schedule`), manual run endpoint (`POST /api/settings/coordinator-training/run-now`), and per-program queued training jobs (`POST /api/settings/coordinator-playbooks/:program/train-script-job`). Scheduler tick (60s, server startup) now auto-queues first-class training jobs with logs/status in the main Jobs page.
- Coordinator training visibility + artifact clarity: training jobs now always include schema-valid `editorContext.projectRoot` (so they render reliably in Jobs WS streams), emit explicit `script/playbook updated|no-change` log lines, and when apply=true persist a `training` snapshot block into `<coordinator-playbooks>/<program>/playbook.json` (`updatedAt`, source paths, reference summaries) so each run has inspectable playbook-side output.
- Playbook seeding parity across bridges: coordinator playbook defaults now seed starter manifests/instructions for `global`, `blender`, `godot`, `houdini`, `unity`, `unreal`, and `comfyui` instead of Houdini-only defaults.
- Bridge playbook defaults slimmed to barebones: seeded bridge manifests now start with one minimal task each and empty `examples` lists, so clean installs avoid dangling reference paths and teams can grow playbooks via source analysis/training.
- Responsive resizable text-editing UX: client/admin prompt and coordinator script textareas now enforce responsive width and support manual drag-resize so long prompt/script editing is practical across window sizes.
- Checkbox/toggle UI consistency pass: client/admin global theme now applies unified custom checkbox/radio controls, and coordinator toggle rows enforce horizontal label-control alignment to avoid stacked/clunky settings layouts.
- Linux dropdown theme parity: global client/admin CSS now sets `color-scheme: dark` and styles `option/optgroup` to prevent white native dropdown menus in Linux builds.
- Client/admin cleanup pass: removed Svelte a11y/build warnings (semantic setup forms, keyboard-safe worker expansion markup, interactive chat resize handle, removed admin login autofocus and dead CSS rule).
- Test execution scope fix: server/protocol now expose explicit `test` scripts and CI runs them via pnpm filters, preventing accidental traversal into dependency test suites.
- Repo hygiene cleanup: removed tracked generated/runtime artifacts (`data/*.db*`, Houdini `__pycache__/*.pyc`, packaged VSCode `.vsix`) and deprecated scratch docs (`PLAN.md`, `marblegame*.md`); `.gitignore` now blocks these classes.
- Settings auth/local-server UX fix: client Settings now hides login fields while a session is active and shows auth form only when signed out; local server status now auto-detects externally started localhost servers (for example `pnpm dev`/`pnpm server`) through background `/health` polling instead of only client-spawned processes.
- Settings coordinator layout pass: coordinator-only settings now use a split rail/detail workspace so the left side handles area/program/target selection and the right side is dedicated to editing. Script editing is now preview-first with explicit `Edit Script` / `Preview` toggles, and settings max-width was expanded for better desktop space usage.
- Coordinator tab detail-pane fix: the dedicated client Coordinator page now uses a true split layout (sticky left control rail + right detail content pane), so wide-screen space is used for active editor/work surfaces instead of single-column stacking.
- Admin machine controls + worker rules: added a dedicated `Machines` admin page with live worker/bridge inventory (status, IP, connected programs) and per-machine rule editing (`banned`, `clientCoordinationAllowed`, `ipAllowlist`, `ipDenylist`, `note`) backed by new server worker-rule storage/enforcement (WS bridge admission + `POST /api/jobs` targeted-worker checks).
- Bridge context multi-select grouping: bridge right-click context actions now submit one grouped context item for multi-selection (Godot, Blender, Houdini, Unreal) so the chat context panel gets one `@N` reference per selection set instead of one item per selected object; server prompt formatting now includes grouped node detail blocks from `item.content`.

- Coordinator script editing UX follow-up: client Coordinator now presents global/bridge scripts as compact left-rail preview cards with explicit `Edit` actions and opens the full script editor in the right detail pane; bridge edit mode keeps training actions in-context. Responsive breakpoints were tightened so split layout remains usable on narrower desktop/tablet widths.
- Coordinator right-side script pane refinement: the script editor is now a dedicated side pane to the right of main Coordinator content (instead of inline in the content flow), so editing scripts no longer pushes server sources/prompts down.
- Coordinator script editor full-workspace follow-up: right script pane now mounts only while editing and uses a larger equal-width split plus near full-viewport editor height to avoid cramped script editing.
- Tauri dev sidecar auto-ensure: client `pretauri` now runs `client/scripts/ensure-sidecar.mjs` to verify host-triple sidecar binaries and automatically trigger `pnpm --filter @arkestrator/server build:sidecar` when missing, preventing first-run `tauri dev` failures from unresolved `bundle.externalBin` paths.

## Detailed Module Reference

Each module below contains enough detail for an agent to understand and work on that area without reading every file. Use these as a starting point, then read specific files as needed.

### Protocol (`packages/protocol/`)

**11 source files. Single dependency: zod.**

The shared schema package defines ALL types used across server, client, and admin. Every Zod schema serves dual purpose: runtime validation AND TypeScript type inference.

**Key schemas:**
- **Enums**: `JobStatus` (6 values: queued/paused/running/completed/failed/cancelled), `JobPriority` (4: low/normal/high/critical), `AgentEngine` (4: claude-code/codex/gemini/local-oss), `WorkspaceMode` (3: command/repo/sync), `PolicyType` (5: file_path/tool/prompt_filter/engine_model/command_filter), `PolicyAction` (2: block/warn)
- **Core types**: `FileChange` (path+content+action), `EditorContext` (activeFile+projectRoot+metadata), `FileAttachment` (path+content), `ContextItem` (type: node/script/asset/scene, name, data)
- **AgentConfig**: id, name, engine, command, args, model, maxTurns, systemPrompt, priority, timestamps
- **Job**: 20+ fields - status, priority, name, prompt, editorContext, files, agentConfigId, bridgeId, workerName, targetWorkerName, result (FileChange[]), commands (CommandResult[]), workspaceMode, logs, error, tokenUsage, dependsOn, projectId, submittedBy, bridgeProgram, timestamps
- **JobSubmit**: prompt, editorContext, files, agentConfigId, priority, preferredMode, dependsOn, targetWorkerName, startPaused, projectId
- **41 WebSocket message types**: All use `{ type, id, payload }` envelope via `makeMessage()` helper. `Message` is a discriminated union on `type`. Includes bridge context messages (item_add, clear, editor_context, sync), bridge command messages (send, command, result), project list messages, job intervention messages (list, submit, updated), client-dispatch messages (dispatch, tool_request, tool_result, job_log, job_complete, job_cancel), headless execution messages (worker_headless_command, worker_headless_result), and file_deliver.
- **Policy**: scope (global/user), type, pattern, action, enabled
- **Project**: bridgePathPattern, sourceType (local/git), sourcePath, systemPrompt, git options
- **Worker**: name (unique), status (computed), lastProgram, lastProjectPath, activeBridgeCount, osUser, knownPrograms

**Build:** `pnpm --filter @arkestrator/protocol build` â†’ `tsc` â†’ `dist/`. Must rebuild after any schema change.

### Server (`server/`)

**60+ source files in 13 subdirectories. Deps: @arkestrator/protocol, hono, minimatch, otpauth.**

The server is the central hub - all state lives here.

**Entry point (`src/index.ts`):** Initializes 16 repos (including skills, interventions), seeds defaults on first run (bootstrap admin user with strong env password or generated secret persisted to `bootstrap-admin.txt`, admin API key, default Claude Code config, default headless program templates for worker-owned execution), creates WS hub + process tracker + scheduler + sync manager, starts worker loop + timeout checker + cleanup timers, serves HTTP via Hono and WS via `Bun.serve()`. Optional TLS via `TLS_CERT_PATH` + `TLS_KEY_PATH` env vars.

**Database (`src/db/`):** 16 tables across 16 repo files + migrations. Key patterns:
- All repos use prepared statements for performance
- `pickNext()`: priority-ordered (criticalâ†’low), excludes jobs with incomplete dependencies, FIFO within same priority
- Startup recovery: stuck `running` â†’ `queued`
- Table rebuild migration for CHECK constraint changes (SQLite limitation)
- `users.repo.ts`: TOTP 2FA methods (setTotpSecret, enableTotp, disableTotp, recovery codes with Argon2)
- `settings.repo.ts`: Key-value store for server settings (enforce_2fa)
- `workers.repo.ts`: worker_bridges sub-table tracks per-worker program history
- `headless-programs.repo.ts`: CLI program configs with template placeholders

**REST API (`src/routes/`):** 19 route files. Auth: `getAuthenticatedUser()` from Bearer token, `requireAdmin()` for admin ops. Two-phase login with TOTP 2FA (10 attempts/IP/15min rate limit). Job creation validates via Zod + checks policies. Jobs enriched with tokenUsage + dependsOn. SSE streaming chat endpoint. Bridge-command API now includes command execution, bridge listing, full bridge context lookup, and worker-owned headless-check execution paths.

**WebSocket (`src/ws/`):** Hub (connection registry + broadcast + bridge context state), Handler (parse â†’ validate â†’ dispatch 15+ message types, including worker-owned headless result resolution), per-connection WsData (id, role, type, program, programVersion, bridgeVersion, workerName, machineId, projectPath, ip, osUser). Hub maintains `bridgeContexts: Map` for per-bridge context storage, relays context changes to all clients, and now locates desktop clients by worker for headless execution routing. On client connect: sends full bridge context sync + bridge status + worker status.

**Agent Spawning (`src/agents/`):**
- `spawnAgent()`: resolve workspace â†’ build command â†’ before-snapshot â†’ Windows-aware spawn fallback (handles `.cmd/.exe/.bat` shims on ENOENT, strips CLAUDE*/MCP_* env, injects ARKESTRATOR_URL/API_KEY) â†’ stream stdout/stderr real-time â†’ after-snapshot â†’ diff â†’ policy check â†’ complete/fail â†’ resume dependents â†’ record tokens. When bridge command-mode work needs headless DCC execution, spawner now routes it to the target desktop client/worker instead of server-local CLI fallback.
- Engine builders: claude-code (`--dangerously-skip-permissions -p`), codex (`exec --full-auto`), gemini, local-oss. `buildBridgeOrchestrationPrompt()` lists connected bridges + headless programs and documents both MCP tools and `am` CLI equivalents. Headless program listings now represent worker/client execution capability, not permission for the server to launch those DCC binaries locally. Per-bridge coordinator defaults include direct official docs links.
- `worker-headless.ts`: Routes headless bridge execution to the target desktop client/worker instead of running DCC binaries on the server
- File snapshot: recursive walk, content-based diff
- Process tracker: timeout enforcement (30s check interval), kill on shutdown

**Queue (`src/queue/`):** WorkerLoop polls on interval, checks available slots, claims jobs atomically, injects worker projectRoot for targeted jobs, fire-and-forget spawn. Scheduler delegates to `pickNext()`. Actual DCC-heavy bridge/headless execution is now additionally guarded by worker-scoped heavy-resource leases so conflicting GPU/VRAM-heavy steps do not overlap on one machine even when general agent concurrency stays high.

**Workspace Resolution (`src/workspace/`):** 7-step fallback:
1. preferredMode set â†’ use it
2. server default != auto â†’ use it
3. no projectRoot â†’ command
4. explicit projectId â†’ repo (at project.sourcePath)
5. project mapping matches â†’ repo (at mapped path)
6. projectRoot exists locally â†’ repo
7. attached files â†’ sync (temp dir)
8. fallback â†’ command

**Policy Enforcement (`src/policies/`):** Submission: prompt regex + engine/model. Post-completion: file path glob + command script regex. Tool restrictions â†’ `--disallowedTools`. 5 policy types: file_path, tool, prompt_filter, engine_model, command_filter.

### Client (`client/`)

**30 source files. Tauri v2 + Svelte 5 runes. PRIMARY user dashboard.**

**Pages (8):**
- **Chat** (default page): Multi-tab chat interface with SSE streaming. Machine targeting dropdown (`Auto` or one/many workers) replaces raw bridge selection in normal chat/job submit flow; live bridge/editor context is scoped to the selected workers while the coordinator remains responsible for choosing actual bridge/program steps. Three message roles: user, assistant, system. Collapsible context panel (right sidebar). Unsent tab drafts persist through navigation away from Chat and page remounts.
- **Jobs**: Resizable split panel. Left: filterable list with status dots, program icons (G/B/H), dependency tree (indented nesting), multi-select checkboxes, bulk delete, "Start Queue". Right: detail panel with all metadata, actions, dependency links, prompt, commands, real-time log stream, outcome feedback.
- **Admin**: Embedded admin panel via iframe at `{serverUrl}/admin`. Auto-passes session token via `postMessage` for seamless login. Includes local-server controls for desktop-local sessions.
- **Workers**: Machine-centric view: expandable worker cards with online/offline status, OS username, nested bridge list with program badges and version info.
- **Projects**: Project mapping CRUD with per-project system prompt.
- **Coordinator**: Dedicated coordinator management with Server Config (global + bridge scripts), Training (queue/schedule/run), and Client Config (local bridge prompt overrides) tabs.
- **Settings**: Server URL, login/logout, bridge plugin installer, local model management, local server port configuration.
- **Setup**: First-time setup with login-first flow. TOTP 2FA support (code input after password). Local server start via compiled sidecar binary (prod) or Bun (dev). Configurable local server port. Triggers first-time startup wizard after login.
- **StartupWizard**: Post-login onboarding wizard (local: 4 steps, remote: 3 steps). Agent template selection, bridge auto-detection + batch install, setup completion tracking via localStorage.

**Stores (10, Svelte 5 runes):** connection (url, session, serverMode, status - persists to localStorage), jobs (all, selectedId, selectedIds, logBuffer, statusFilter), agents (all), workers (workers + bridges + knownPrograms), chat (tabs, messages, machine selection, draft prompts - debounced persistence that now survives Chat page remounts), bridgeContext (per-bridge editor context + context items), server (local server process management), toast (notifications), navigation (current page).

**API:** REST client (`api` object with full coverage including chat.stream SSE) + WebSocket manager (exponential backoff 3sâ†’30s with jitter, dispatches 12+ message types to stores, writes local config via Tauri IPC).

**Components:** layout (TitleBar, Sidebar, StatusBar), chat (ChatTabBar, ChatInput, ChatMessageList, ChatContextPanel), ui (Badge, Toast), ServerManager.

### Admin (`admin/`)

**21 source files. Svelte 5 + Vite web SPA. REST-only (no WebSocket).**

**Pages (11):** Login (two-phase with 2FA), Users, ApiKeys, AgentConfigs, Machines, Bridges, CoordinatorTraining, Skills, Knowledge, Policies, AuditLog. Login guard on mount. **postMessage auto-login**: listens for `{ type: "session_token", token }` from parent window (Tauri client embeds admin via iframe) to skip login.

**Has but Client doesn't:** User management, server-side machine controls, policies, audit log.
**Client has but Admin doesn't:** Real-time WS streaming, chat interface, native desktop, local server management.

**Served by server** at `/admin/*` with SPA fallback to `index.html`.

### Godot Bridge (separate repo: [arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges))

**4 GDScript files + plugin.cfg. Reference implementation for all bridges.**

Bridge plugins live in the [arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges) repository, not in this repo.

**Files:**
- `plugin.gd` (~810 lines): Main EditorPlugin. Programmatic dock UI (Task + Settings tabs), editor context gathering (scene, nodes, scripts), job submission, WS callbacks, scene reload. 12 editor settings.
- `ws_client.gd` (~274 lines): WebSocket client. 10 signals. Full bridge metadata in connect URL. Exponential backoff reconnect. Handles 8 message types.
- `file_applier.gd` (~83 lines): Static file operations (create/modify/delete) + filesystem scan trigger.
- `command_executor.gd` (~90 lines): Dynamic GDScript compilation + execution. Wraps bare code in `run(editor)`.

**Editor context:** `{ projectRoot, activeFile, metadata: { active_scene, selected_nodes: [{name,type,path}], selected_scripts } }`. Attaches content of all open/selected scripts.

**Result handling:** Command mode â†’ execute GDScript. Repo/sync â†’ apply files + scan. Then auto-reload scene.

## Bridge Parity Requirements

When creating new bridge plugins (Blender, Houdini, etc.), they MUST maintain feature parity with the Godot bridge:

1. **WebSocket protocol**: Same `{ type, id, payload }` envelope, same query params on connect (`type=bridge`, `key`, `name`, `program`, `programVersion`, `bridgeVersion`, `protocolVersion`, `projectPath`, `workerName`, `machineId`, `osUser`)
2. **Editor context**: Provide `projectRoot`, `activeFile`, `metadata` with app-specific context. Push updates via `bridge_editor_context` message.
3. **Context items**: Support `bridge_context_item_add` (types: node, script, asset, scene) and `bridge_context_clear` messages. Right-click menus for "Add to Arkestrator Context".
4. **File attachments**: Gather relevant open files as `{ path, content }` arrays
5. **Job submission**: Support all JobSubmit fields (prompt, editorContext, files, agentConfigId, priority, dependsOn, startPaused, projectId)
6. **Result handling**: Both file changes (create/modify/delete) AND command execution (Python for Blender/Houdini, GDScript for Godot)
7. **Cross-bridge commands**: Handle `bridge_command` messages (execute scripts, return `bridge_command_result`)
8. **Settings**: server_url, api_key, auto_connect, auto_save, auto_reload, auto_apply_files, auto_execute_commands, worker_name, default_project
9. **Reconnect**: Exponential backoff (3s base â†’ 30s max)
10. **Worker identity**: Follow the desktop client's shared-config `workerName` and persistent `machineId` when available, sending both query params so the server can attach bridge sockets to the canonical machine record
11. **OS user**: Auto-detect from environment, send as `osUser` query param
12. **Project selection**: Per-job override â†’ default â†’ auto-detect
13. **Bridge type detection**: Set `program` query param (e.g. `blender`, `houdini`) - server uses this for command mode language detection via `detectBridgeType()` in `command-mode.ts`
