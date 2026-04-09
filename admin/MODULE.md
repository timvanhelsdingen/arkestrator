# Module: Admin (`admin/`)

## Purpose
Focused web admin panel (served at `/admin`) for:
- user management
- agent configuration management
- server-side filters/policies
- machine inventory and per-machine controls
- audit log visibility

Job operations and broader operational tooling are intentionally handled in the Tauri client.

## App Structure
- `App.svelte`: login guard, shell layout, iframe token handoff (`session_token`) with parent-origin/source/token validation, and permission-aware page routing.
- Active routed pages: `users`, `api-keys`, `agents`, `machines`, `bridges`, `knowledge`, `templates`, `policies`, `audit-log`, `system`.
- If a logged-in account has no admin-panel capabilities, app shows a `No Admin Access` state.
- Served by server as SPA at `/admin/*`.

## Active Pages
| Page | Features |
|------|----------|
| Login | Password + two-phase TOTP flow (`verify-totp` challenge step when required), now branded with the refreshed logo mark + wordmark and browser favicon. |
| Users | User CRUD, searchable user table, password reset (old password + new + confirm), and unified per-user `Edit` flow: role, `require2fa`, `clientCoordinationEnabled`, token limits (input/output/period), and fine-grained capability editing (`manageUsers`, `manageAgents`, `manageProjects`, `managePolicies`, `manageApiKeys`, `manageConnections`, `manageWorkers`, `manageSecurity`, `viewAuditLog`, `viewUsage`, `editCoordinator`, `useMcp`, `interveneJobs`, `executeCommands`, `deliverFiles`, `submitJobs`). Includes clickable username/`View` drill-down into an in-page `User Details` insights panel (daily/monthly/all-time usage totals, status counts, recent tokenized jobs) with `?user=<id>` deep-link support. |
| API Keys | Permission-gated API key manager (`manageApiKeys`) for active key listing with access summary column, create with role selection + grouped permission checkboxes (role-based defaults), one-time raw key reveal + copy, "Edit Permissions" modal for existing keys, and key revocation (`/api/keys`, `/api/keys/:id/permissions`). CSS includes `.role-mcp` badge style (purple) for MCP-role keys. |
| AgentConfigs | Agent config CRUD via inline editor panel + inline template quick-add panel (`Use Template` creates config directly). Template adds can still show provider onboarding notes, and the page now includes a first-class `CLI Auth (Server Runtime)` panel for one-click Claude/Codex login in the active server runtime user context (status, start, live logs, open URL, copy code, cancel). Supports optional `fallbackConfigId` field for AUTO-routing escalation chains. Includes `Model Host` dropdown (`server`/`client` toggle, persisted on the agent config) for local-oss model host routing and a separate ephemeral `Catalog Source` dropdown (renamed from per-worker picker) for browsing worker model catalogs. Includes local model runtime tools (`runtime=ollama`): catalog + allowlist management (checkboxes, common-model presets, save allowlist), per-model download/update, bulk download for missing allowed models, live pull progress bar/percent via streamed events, and optional auto-pull before save. |
| Knowledge (Skills & Training) | Combined tabbed page (`Knowledge.svelte`) with two tabs: **Skills** (`Skills.svelte`) for skill management, registry browser, import/export, search, playbook content preview, and related skills navigation. Skill create modal includes name, slug, program, category (with `project-reference` and `housekeeping` options), description, content, priority, autoFetch, and enabled fields. **Training Vault** (`CoordinatorTraining.svelte`) for vault explorer, repository controls, and snapshots. Single sidebar entry "Skills & Training" replaces the former separate "Skills" and "Training Vault" entries. |
| Bridges | Program-centric bridge management page. Aggregates workers, connections, and coordinator scripts into a per-program table (Program, Status, Workers, Versions, Script, Actions). Actions: Edit Script (textarea + reset-to-default), Kick All (disconnects active connections), Remove (deletes bridge history via `DELETE /api/workers/bridges-by-program/:program` + coordinator script). Add Bridge creates a new coordinator script for a program name. |
| Machines | Machine/worker inventory (`/api/workers`) with live status + IP, connected programs, per-machine rule editing (`banned`, `clientCoordinationAllowed`, `ipAllowlist`, `ipDenylist`, `localLlmEnabled`, `localLlmBaseUrl`, `note`) via `PUT /api/workers/:id/rules`, one-click worker local-LLM endpoint checks (`GET /api/workers/:id/local-llm-check`), and per-machine delete button with confirmation modal dialog (`DELETE /api/workers/:id`). Delete UI uses `confirmDelete` state, `deleteWorker()` handler, and `.btn-danger`/`.actions-cell` styles. |
| Templates | Template management page with sub-tabs for Chat Prompts, Project Prompts, and Job Presets (`type` filter: `chat`, `project`, `job_preset`). Category-grouped table with name, description, subcategory, sort order, enabled toggle, and edit/delete actions. Create/edit modal with fields for name, type, category, subcategory, description, content (textarea), icon, sort order, enabled toggle, plus job_preset-specific fields (verificationMode, verificationWeight, bridgeExecutionMode). "Seed Defaults" button to populate built-in templates via `POST /api/templates/seed`. |
| Policies | Server-side allow/deny filters with type tabs for security (`file_path`, `tool`, `prompt_filter`, `engine_model`, `command_filter`) and resource management (`concurrent_limit`, `process_priority`, `token_budget`, `cost_budget`). **Three scope levels**: global, per-user, per-project (with project selector dropdown). Resource types show structured inputs (number fields, dropdowns) instead of raw pattern text. Enable/disable toggles, create/edit/delete flow. **Presets modal** with 14 built-in templates including resource presets: Limit Concurrent Jobs, Low Priority Agents, Cost Cap. Duplicate-aware application (skips existing patterns). |
| Training Vault | Global coordinator training explorer that lists one logical `training/` tree with `scripts/`, `playbooks/`, `learning/`, and `imports/`; organized into focused views (`Vault Explorer`, `Repository Controls`, `Snapshots`). In `Vault Explorer`, training job artifacts under `learning/jobs/<program>/<jobId>/...` render as one foldout row per job with nested file rows, while imported references now appear under the dedicated `imports` root. Includes a `Training Job Metadata + Export` panel with checkboxable job rows and scoped zip export by selected job, checked jobs, selected bridge/program, current filters, or full training set. Vault view also supports direct `Import Training Data (.zip)` ingest into server training roots, while job artifact files are read-only with explicit download/export actions (no misleading in-vault save behavior). `Snapshots` now handles full disaster-recovery zip export/import (`Export Entire Server (.zip)` / restore) with optional configured server-file inclusion. |
| AuditLog | Paginated admin activity log with action filtering and IP/details visibility. |
| System | System administration page with a tab bar: **System Settings** tab (job timeout, max concurrent agents, log level, worker poll interval, default workspace mode) backed by `GET/PUT /api/settings/system-config`, and **Danger Zone** tab containing Factory Reset functionality. Factory Reset requires password + typing "RESET" to confirm. Calls `POST /api/settings/factory-reset` (admin role + `manageSecurity` permission). Wipes all server data tables while preserving the triggering admin user. |

## Stores (`src/lib/stores/`)
| Store | File | State |
|-------|------|-------|
| auth | `auth.svelte.ts` | `token`, `user`, 2FA challenge state, plus capability getters (`canManageUsers`, `canManageAgents`, `canManagePolicies`, `canViewAuditLog`, etc.) and `hasAdminAccess`. |
| navigation | `navigation.svelte.ts` | `current: "users" | "api-keys" | "agents" | "machines" | "bridges" | "knowledge" | "templates" | "policies" | "audit-log" | "system"` |
| toast | `toast.svelte.ts` | Toast queue/messages |

## Navigation + Layout
- `lib/components/layout/Sidebar.svelte`
  - Renders the refreshed Arkestrator logo mark beside the `Arkestrator / Admin` lockup
  - Capability-gated items: `Users`, `API Keys`, `Agents`, `Machines`, `Bridges`, `Skills & Training`, `Templates`, `Filters`, `Audit Log`, `System`
  - Filters items by permission (`manageUsers`, `manageApiKeys`, `manageAgents`, `manageWorkers`, `managePolicies`, `editCoordinator/manageSecurity`, `viewAuditLog`, `manageSecurity` for System)
  - Auto-corrects `nav.current` to the first allowed page
- `lib/components/layout/Header.svelte`
  - Authenticated page title bar with persistent build badge (`Build <version+sha>`)
  - Titles for active pages (`users`, `api-keys`, `agents`, `machines`, `bridges`, `knowledge`, `policies`, `audit-log`, `system`)

## API Layer (`src/lib/api/client.ts`)
Active admin UI uses:
- `auth.*` (`login`, `verifyTotp`, `me`, `logout`)
- `users.*` (`list`, `insights`, `create`, `updateRole`, `resetPassword` with `oldPassword/newPassword/confirmNewPassword`, `delete`, `setLimits`, `updatePermissions`, `updateSettings`)
- `keys.*` (`list`, `create` with optional permissions, `revoke`, `updatePermissions`)
- `agents.*` (includes local model catalog discovery, allowlist updates, direct pull helpers, streamed pull-progress helper for live download UX, and CLI auth status/session/login helpers for Claude/Codex)
- `connections.list`, `connections.kick`
- `workers.list`, `workers.updateRules`, `workers.checkLocalLlm`, `workers.delete`, `workers.deleteBridgesByProgram`
- `settings.get`, `settings.setAllowClientCoordination`, `settings.getTrainingRepositoryPolicy`, `settings.updateTrainingRepositoryPolicy`, `settings.getTrainingRepositoryOverrides`, `settings.updateTrainingRepositoryOverrides`, `settings.listTrainingRepositoryRecords`, `settings.getTrainingRepositoryStatus`, `settings.getTrainingRepositoryMetrics`, `settings.reindexTrainingRepository`
- `policies.*`
- `coordinatorTraining.*` (`list`, `readFile`, `writeFile`, `createFolder`, `deleteFile`, `deleteFolder`, `updateMetadata`, `listJobs`, `exportJobs`, `exportTrainingDataZip`, `importTrainingDataZip`, `exportSnapshot`, `importSnapshot`, `exportSnapshotZip`, `importSnapshotZip`, `listCoordinatorScripts`, `updateCoordinatorScript`, `deleteCoordinatorScript`)
- `templates.*` (`list`, `get`, `create`, `update`, `delete`, `categories`, `seed`)
- `system.*` (`factoryReset(password, confirmation)`, `getConfig()`, `updateConfig(config)`)
- `skills.*` (`list`, `get`, `create` (accepts `priority`, `autoFetch`, `enabled`), `update`, `delete`, `search`, `pullAll`, `pullProgram`, `registry`, `install`, `refreshIndex`, `validate`, `preview`, `getVersions`, `rollback`, `getEffectiveness`, `getPlaybookContent`, `batchEffectiveness`)
- `audit.*`

## Removed Legacy Pages
The following pages were removed from `admin/src/pages` as part of cleanup because they were no longer routed/needed:
- `Dashboard.svelte`
- `Jobs.svelte`
- `Projects.svelte`
- `Workers.svelte`
- `Connections.svelte`
- `Security.svelte`
- `CoordinatorScripts.svelte`

## Build & Serving
- Dev: `pnpm --filter @arkestrator/admin dev`
- Build: `pnpm --filter @arkestrator/admin build`
- Server serves build output from `admin/dist` at `/admin/*`
- `vite.config.ts` injects `__ADMIN_VERSION__` and `__ADMIN_BUILD__` from package metadata + git short SHA.

## Dependencies
- Svelte 5 + Vite
