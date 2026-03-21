# Arkestrator - Claude Code Instructions

## Project Overview
Hub-and-spoke system for managing AI agent tasks across DCC apps (Godot, Blender, Houdini). See `PROJECT_PLAN.md` for full architecture, implementation phases, and progress tracking.

## Tech Stack
- **Monorepo:** pnpm workspaces
- **Server:** Bun + Hono + SQLite (user accounts with Argon2, session auth)
- **Client:** Tauri v2 + Svelte 5 (runes, custom titlebar, dark theme)
- **Protocol:** Zod schemas (shared TypeScript types)
- **Bridges:** GDScript (Godot), Python (Blender/Houdini) — live in a [separate repo](https://github.com/timvanhelsdingen/arkestrator-bridges)

## Working in This Repo

### Pre-flight: Dependency Check
**Before doing ANY work, verify that all required tools are installed.** Run these checks and install anything missing:

```bash
# Required global tools - check and install if missing
pnpm --version  || npm install -g pnpm    # Package manager
bun --version   || npm install -g bun     # Server runtime
rustc --version                            # Rust compiler (install from https://rustup.rs)
cargo --version                            # Rust package manager (comes with rustup)

# Install workspace dependencies (always run after pulling)
pnpm install
pnpm --filter @arkestrator/protocol build
```

If `npm` itself is not found, Node.js needs to be installed first (https://nodejs.org).
If `rustc`/`cargo` is not found, install Rust from https://rustup.rs (required for Tauri client builds).

### Setup
```bash
pnpm install                                    # Install all deps
pnpm --filter @arkestrator/protocol build     # Build protocol package
```

### Key Conventions
- All WebSocket messages use `{ type, id, payload }` envelope (see `packages/protocol/src/messages.ts`)
- Zod schemas are the source of truth for types - define schema first, infer TypeScript types from it
- Server spawns CLI tools (claude, codex, gemini) as subprocesses - never calls AI APIs directly
- Bridges are thin WebSocket clients - no AI logic, just serialize/deserialize and apply file changes
- Protocol package is workspace-internal, referenced as `@arkestrator/protocol`
- Provider model catalogs and reasoning tiers are time-sensitive runtime data. If the UI exposes model/reasoning suggestion lists for any provider and they are not dynamically discovered, agents must re-verify them against current official provider/runtime sources whenever touching that surface and before release/build packaging work. Do not leave stale hardcoded model lists in place when newer official variants exist.

### Project Plan
**Always check `PROJECT_PLAN.md` before starting work.** It tracks:
- What's done (âœ…) and what's next (â¬œ)
- Architecture decisions and rationale
- Protocol message reference
- Key file locations

**Update `PROJECT_PLAN.md`** whenever you complete a task or add new items.

### Agent Instruction Files
Both `CLAUDE.md` and `AGENTS.md` exist for different AI agents (Claude Code and Codex respectively). If you update one, update the other to keep them in sync.

### Module Documentation
Each module has its own documentation file that tracks its current state (files, routes, components, schemas, etc.). **After making changes to any module, update its corresponding doc file** to reflect the new state:
- **Protocol:** `packages/protocol/MODULE.md`
- **Server:** `server/MODULE.md`
- **Client:** `client/MODULE.md`
- **Admin:** `admin/MODULE.md`
- **Bridges:** Live in a separate repo: [arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges). Do not look for bridge source code in this repo.

Update these docs whenever you add, remove, or rename files, routes, components, message types, schemas, or significant functionality. Keep descriptions concise - these are reference docs, not tutorials.

### Post-Task Checklist
**After completing any task, ALWAYS do the following before reporting done:**
1. **Update `MODULE.md` files** for every module you touched - reflect new/changed files, routes, schemas, signals, UI elements, etc.
2. **Update `PROJECT_PLAN.md`** if the task relates to a tracked milestone or phase.
4. **Update `README.md`** whenever the change is significant and user-facing (features, behavior, security posture, deployment, workflows, requirements, or commands). Keep README concise and ensure links stay correct.
5. **Rebuild affected apps** after any source changes:
   - Admin SPA: `pnpm --filter @arkestrator/admin build`
   - Protocol package: `pnpm --filter @arkestrator/protocol build`
   - Client (Tauri): `pnpm --filter @arkestrator/client build` (or `tauri build`)
   - Server restarts automatically when run with `bun --watch`
   - If you change server code or ship a new server image, refresh the bundled admin build metadata in `client/resources/admin-dist` so the Admin page build number stays in sync with the deployed server revision

This is mandatory. Do not skip documentation updates or rebuilds - they are how other agents (and future you) understand what changed, and how users see the changes.

### Cross-Platform
This must work on Windows, macOS, and Linux. Avoid platform-specific assumptions. Many users will run the server on Windows.

### Versioning and Releases
**NEVER bump versions, tag, or push releases on your own.** Only version up when the user explicitly asks (e.g. "push, merge, version up", "release", "bump version"). Commit fixes and features normally — the user decides when to cut a release.

When the user asks to release, sync to public, or build a release:

1. **Bump version** across all packages:
   ```bash
   node scripts/bump-version.mjs <version>   # e.g. 0.1.48
   ```

2. **Rebuild all artifacts** so every component reflects the new version:
   ```bash
   pnpm --filter @arkestrator/protocol build
   pnpm --filter @arkestrator/admin build
   cp -r admin/dist/* client/resources/admin-dist/
   ```
   **Critical:** The admin SPA embeds the version at build time (`__ADMIN_VERSION__`). If you skip this rebuild, the admin dashboard will display a stale version number. The bundled `client/resources/admin-dist/` is what the server serves — it must match the release version.

3. **Commit, tag, and push:**
   ```bash
   git add -A
   git commit -m "Arkestrator v<version>"
   git tag v<version>
   git push origin main --tags
   ```

4. **Release CI** runs automatically when a `v*` tag is pushed. It builds macOS (dmg+updater), Windows (NSIS+updater), and Linux (AppImage+deb) installers via GitHub Actions.

**Key files:**
- `scripts/bump-version.mjs` — bumps version in all package.json, Cargo.toml, tauri.conf.json
- `.github/workflows/release.yml` — CI that builds installers on tag push

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **No Hardcoding for Dynamic Data**: Never hard code values that should come from runtime state, configuration, discovery, or existing sources of truth.

## Workflow Standards

### Plan Before Building
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions).
- If something goes sideways, **STOP and re-plan immediately** - don't keep pushing.
- Use plan mode for verification steps, not just building.
- Write detailed specs upfront to reduce ambiguity.

### Subagent Strategy
- Use subagents liberally to keep main context window clean.
- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.

### Self-Improvement Loop
- After ANY correction from the user: update `LESSONS.md` with the pattern.
- Write rules for yourself that prevent the same mistake.
- Ruthlessly iterate on these lessons until mistake rate drops.
- Review `LESSONS.md` at session start for relevant context.

### Verification Before Done
- Never mark a task complete without proving it works.
- Diff behavior between main and your changes when relevant.
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness.

### Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky, step back and implement the elegant solution.
- Skip this for simple, obvious fixes - don't over-engineer.
- Challenge your own work before presenting it.

### Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests - then resolve them.
- Zero context switching required from the user.
- Go fix failing CI/tests without being told how.
