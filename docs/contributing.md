# Contributing

## Setup

1. Install prerequisites: Node.js 20+, pnpm, Bun, Rust (see [Installation](installation.md#build-from-source))
2. Clone and install:
   ```bash
   git clone https://github.com/timvanhelsdingen/arkestrator.git
   cd arkestrator
   pnpm install
   pnpm --filter @arkestrator/protocol build
   ```
3. Run in dev mode: `pnpm dev`

## Project Structure

```
arkestrator/
├── packages/protocol/   # Shared Zod schemas and TypeScript types
├── server/              # Bun + Hono server (hub)
├── client/              # Tauri v2 + Svelte 5 desktop app
├── admin/               # Web admin SPA (served at /admin)
├── bridges/
│   ├── godot/           # GDScript editor plugin
│   ├── blender/         # Python addon
│   ├── houdini/         # Python package
│   ├── comfyui/         # Standalone Python bridge
│   ├── unity/           # C# editor plugin
│   └── unreal/          # Python UE5 plugin
├── docs/                # Documentation
└── scripts/             # Build and deployment scripts
```

## Development Workflow

1. **Build protocol first** — all other packages depend on it: `pnpm --filter @arkestrator/protocol build`
2. **Make scoped changes** — minimal diffs, root-cause fixes, no temporary workarounds
3. **Verify builds** — see validation commands below
4. **Update docs** — update `MODULE.md` for every module you changed

## Coding Standards

| Standard | Rationale |
|---|---|
| Minimal, focused changes | Smaller diffs are easier to review and less likely to introduce regressions |
| Cross-platform (Windows/macOS/Linux) | Many users run the server on Windows or in Docker on various hosts |
| No hardcoded secrets or machine-specific paths | Secrets leak, hardcoded paths break on other machines |
| Zod schemas are the source of truth | Define schemas first, infer TypeScript types from them |
| No temporary fixes | Find root causes. Band-aids compound into tech debt. |
| No hardcoded dynamic data | Model lists, provider catalogs, and runtime-discovered data should come from APIs or config, not hardcoded arrays |

## Key Conventions

- All WebSocket messages use the `{ type, id, payload }` envelope (see `packages/protocol/src/messages.ts`)
- Server spawns CLI tools as subprocesses — it never calls AI APIs directly
- Bridges are thin execution endpoints — no job submission UI, no local state caching
- Protocol package is workspace-internal, referenced as `@arkestrator/protocol`
- Bridges auto-discover credentials from `~/.arkestrator/config.json`

## Validation Commands

```bash
# Protocol (must pass first — everything depends on it)
pnpm --filter @arkestrator/protocol build

# Server tests
pnpm --filter @arkestrator/server test

# Admin SPA build
pnpm --filter @arkestrator/admin build

# Desktop client build
pnpm --filter @arkestrator/client build
```

## Module Documentation

Each module has a `MODULE.md` file that tracks its current state. After making changes, update the relevant module doc:

- `packages/protocol/MODULE.md`
- `server/MODULE.md`
- `client/MODULE.md`
- `admin/MODULE.md`
- `bridges/godot/MODULE.md`
- `bridges/blender/MODULE.md`
- `bridges/houdini/MODULE.md`
- `bridges/comfyui/MODULE.md`
- `bridges/unity/MODULE.md`
- `bridges/unreal/MODULE.md`

## Pull Request Checklist

- [ ] Protocol builds: `pnpm --filter @arkestrator/protocol build`
- [ ] Server tests pass: `pnpm --filter @arkestrator/server test`
- [ ] Admin builds: `pnpm --filter @arkestrator/admin build`
- [ ] Client builds: `pnpm --filter @arkestrator/client build`
- [ ] Module docs updated for changed modules
- [ ] Cross-platform compatibility (no platform-specific assumptions)
- [ ] No secrets, generated artifacts, or runtime files committed
- [ ] No stale hardcoded data (model lists, provider catalogs, etc.)

## Bridge Contributions

Bridge plugins (Godot, Blender, Houdini, etc.) live in a separate repository:
[arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges).
PRs for bridge-specific changes should be submitted there.
