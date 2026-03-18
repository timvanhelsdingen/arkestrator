# Module: VSCode Extension (`extensions/vscode/`)

## Recent Updates (2026-02-24)
- Dependency security bump: upgraded `esbuild` to `^0.25.0` to address advisory `GHSA-67mh-4wv8-2f99` from full-workspace audit.

## Purpose
VS Code extension that connects to the Arkestrator server. Provides two interfaces: (1) a Chat Participant (`@arkestrator`) that integrates with VS Code's native chat UI, and (2) a standalone webview chat panel. Submits jobs via REST, streams chat via SSE, and shows status. This is a **client** (not a bridge) - it does not apply file changes or execute commands.

## Files (8 + config)
| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point - registers chat participant, commands, status bar |
| `src/config.ts` | Config resolution: VSCode settings + `~/.arkestrator/config.json` auto-discovery |
| `src/chat-participant.ts` | `@arkestrator` Chat Participant with `/job`, `/bridge`, `/status` slash commands |
| `src/api/rest.ts` | REST API client (jobs, agents, workers, bridges). Normalizes worker/bridge payload shapes to stay compatible with current server responses (`/api/workers` now returns `{ workers, bridges }`). |
| `src/api/sse.ts` | SSE streaming client for `POST /api/chat` |
| `src/webview/panel.ts` | WebviewPanel lifecycle manager - handles postMessage communication |
| `src/webview/index.html` | Self-contained chat UI (HTML+CSS+JS) with streaming support |
| `package.json` | Extension manifest with Chat Participant, commands, settings |
| `tsconfig.json` | TypeScript config (CommonJS for Node.js) |

## Chat Participant (`@arkestrator`)
### Slash Commands
| Command | Action |
|---------|--------|
| (default) | Stream chat via SSE `/api/chat` using first agent config |
| `/job <prompt>` | Submit a job to the queue via `POST /api/jobs` |
| `/bridge <program> <script>` | Send a command to a connected bridge via `POST /api/bridge-command` (language auto-maps to `gdscript` for `godot`, `unity_json` for `unity`, otherwise `python`) |
| `/status` | Show server health, connected bridge count, and connected workers |

## Standalone Webview Panel
- Opened via command palette: "Arkestrator: Open Chat Panel"
- Persistent chat history within session
- Streams responses chunk-by-chunk via postMessage
- Shows connection status indicator (green/red dot)

## Commands
| Command | Action |
|---------|--------|
| `arkestrator.openChat` | Open standalone chat panel |
| `arkestrator.submitJob` | Quick-submit a job via input box |
| `arkestrator.showStatus` | Show server + worker status (modal) |
| `arkestrator.configure` | Open Arkestrator settings |

## Configuration
| Setting | Default | Purpose |
|---------|---------|---------|
| `arkestrator.serverUrl` | (auto) | Primary server URL override. Falls back to shared config (`~/.arkestrator/config.json`) |
| `arkestrator.apiKey` | (auto) | Primary API key override. Falls back to shared config (`~/.arkestrator/config.json`) |

### Auto-Discovery
Reads `~/.arkestrator/config.json` for `wsUrl` and `apiKey`. Converts WS URL to HTTP for REST calls. VSCode settings override auto-discovered values.

## Build
```bash
cd extensions/vscode && pnpm install && pnpm build
```
Uses esbuild to bundle to `dist/extension.js` (CJS, Node.js platform, `vscode` external).
Packaged `.vsix` outputs are local build artifacts and are not committed to the repo.

## Status Bar
Shows connection state: "Ark: Connected", "Ark: Disconnected", or "Ark: Not configured". Clicking opens the status command. Connectivity check now validates both server reachability and auth by calling `/health` + `/api/workers` (instead of `/health` only), so invalid API keys no longer show as "connected".

## API Compatibility Notes
- `/api/workers` is normalized from `{ workers: Worker[], bridges: BridgeInfo[] }`.
- Bridge list uses `GET /api/bridge-command/bridges` and is normalized from `{ bridges: [...] }`.
- REST error parsing prefers structured server payloads (`{ error, code }`) so user-facing messages are clearer.
- Webview and status-bar connectivity indicators now validate authenticated access (`/api/workers`) instead of relying on unauthenticated `/health` only.


