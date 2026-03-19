# Module: Admin (`admin/`)

## Purpose
Focused web admin panel (served at `/admin`) for:
- user management
- agent configuration management
- server-side filters/policies
- machine inventory and per-machine controls
- audit log visibility

Job operations and broader operational tooling are intentionally handled in the Tauri client.

## Recent Updates (2026-03-19)
- Fine-grained API key permissions (2026-03-19): `ApiKeys.svelte` fully rewritten with grouped permission checkboxes on create (role-based defaults), "Edit Permissions" modal for existing keys, and access summary column in list view. `Users.svelte` adds 3 new permissions (`executeCommands`, `deliverFiles`, `submitJobs`) to the Operations group checkboxes. `src/lib/api/client.ts` adds `permissions` field to `AdminApiKey`, updates `keys.create` to accept optional permissions, and adds `keys.updatePermissions` method.

## Recent Updates (2026-03-15)
- Embedded readiness handshake fix (2026-03-17): `App.svelte` now posts an explicit `admin_ready` message back to the parent window after mount/session bootstrap and again after accepting an embedded `session_token` login handoff. This gives the Tauri client a deterministic readiness signal instead of depending only on iframe load timing.
- Login double-logo cleanup (2026-03-15): `Login.svelte` removed the standalone logo mark image (`arkestrator-logo.svg`) from the login brand section, keeping only the combined brandname wordmark (`arkestrator-logo_brandname.svg`) to eliminate the redundant double-logo appearance.
- Local-oss `localModelHost` admin controls (2026-03-15): `AgentConfigs.svelte` now includes a `Model Host` dropdown (`server`/`client` toggle, persisted on the agent config) for local-oss model host routing. The previous per-worker model catalog dropdown was renamed to `Catalog Source` (ephemeral, used only for browsing worker catalogs without persisting).

## Recent Updates (2026-02-26)
- Brand asset resync (2026-03-12): admin brand assets under `src/assets/brand/` were re-synced directly from the current canonical `docs/assets/` SVGs as provided, keeping the browser/login/sidebar lockups aligned with the latest repo logo files.
- Brand refresh sync (2026-03-12): admin now ships the refreshed Arkestrator logo across browser/app surfaces. Added `public/favicon.svg`, synced local brand assets under `src/assets/brand/`, updated `Login.svelte` to show the new mark + wordmark, and updated `Sidebar.svelte` to render the logo mark beside the `Arkestrator / Admin` lockup.
- Build-ID visibility pass (2026-03-11): admin Vite builds now inject `__ADMIN_BUILD__` (`<package version>+<git short sha>`) alongside `__ADMIN_VERSION__`. The login screen shows the build under the version, and the authenticated top header now keeps a `Build <id>` badge visible so hosted/admin deployments are easy to identify.
- Users access disclosure cleanup (2026-03-11): `Users.svelte` now renders the per-user access list as a collapsed disclosure summary by default (`N access`, preview labels, chevron toggle) instead of always dumping the full permission chip stack inline, which keeps the management table compact until an admin expands a specific row.
- Training Vault imports root + cleanup parity (2026-03-11): `CoordinatorTraining.svelte` and `src/lib/api/client.ts` now treat server-owned imported references as a first-class vault root alongside `scripts`, `playbooks`, and `learning`, so imported task/reference artifacts can be inspected and cleared through the existing vault surfaces after the server-side `DATA_DIR`/imports refactor.
- Dependency security bump (2026-03-08): raised admin `svelte` to `^5.53.7` so the shipped admin SPA picks up the latest patched SSR/XSS fixes without changing page structure or workflows.
- Users permission matrix running-job guidance gate (2026-03-08): `Users.svelte` now includes per-user `Intervene in jobs` capability (`interveneJobs`) in create/edit flows, permission chips, and grouped permission sections so admins can allow/disallow running-job guidance separately from broader MCP/coordinator access.
- Grok engine option in agent form (2026-03-04): Engine dropdown now includes Grok alongside Claude Code, Codex, Gemini, and Local/OSS.
- Agent CLI one-click auth control panel (2026-03-04): `AgentConfigs.svelte` now includes a `CLI Auth (Server Runtime)` section for Claude/Codex with runtime-context status checks, one-click login start, live session output/logs, URL/code extraction (`Open Auth Page`, `Copy Code`), and login cancel/refresh controls backed by new server endpoints under `/api/agent-configs/cli-auth/*`. This replaces the previous command-only onboarding dependency for container/server login workflows.
- Admin API key management page restored (2026-03-03): added routed `API Keys` page in Admin (`ApiKeys.svelte`) with list/create/revoke workflows backed by `/api/keys`, including one-time raw key display + clipboard copy on create for MCP/client provisioning. Navigation, header titles, and permission-gated routing now include `manageApiKeys`.
- Users permission matrix MCP gate (2026-03-03): `Users.svelte` now includes per-user `Use MCP server` capability (`useMcp`) in create/edit flows, permission chips, and grouped permission sections, so admins can allow/disallow MCP access per user directly from Admin > Users.
- Training Vault exchange/recovery flow revision (2026-03-02): `CoordinatorTraining.svelte` now treats exports as real downloadable zip files instead of vault-write actions. Added scoped training bundle export (`selected job`, `checked jobs`, `selected bridge`, `current filters`, `all training data`) backed by new zip endpoints, plus in-vault zip import picker (`Import Training Data (.zip)`) for ingesting shared training bundles into `training/` roots.
- Full-server snapshot UX alignment (2026-03-02): Snapshot view now emphasizes one explicit `Export Entire Server (.zip)` / `Restore Server From Zip` flow using zip snapshot APIs, matching disaster-recovery intent without manual JSON save/import handling.
- Training metadata attribution visibility fix (2026-03-02): metadata actor rendering now includes worker/machine context (`workerName`) when present, reducing `Created By unknown` cases for generated training artifacts.
- Users details workflow pass (2026-03-01): `Users.svelte` now opens per-user insights as an in-page `User Details` panel instead of modal-only flow, with clickable usernames + `View` action, refresh/close controls, and deep-link support via `?user=<id>`. When `GET /api/users/:id/insights` is unavailable, UI now shows an explicit upgrade hint instead of opaque 404 messaging.
- Training Vault save-label clarity pass (2026-03-01): `CoordinatorTraining.svelte` now uses explicit wording (`Save In Vault`, `Saved in Training Vault: ...`) and inline helper text clarifying that save actions write to server-side vault storage, not an OS "Save As" dialog.
- Tooling determinism pass (2026-03-01): added `svelte-check` as an explicit admin `devDependency` so local and CI type-check steps no longer rely on transient `npx` package resolution.
- Machines readability cleanup (2026-03-01): normalized local-LLM check success output formatting in `Machines.svelte` to ASCII separators (`|`) so status text renders consistently across shells/fonts.
- Users search + drill-down insights pass (2026-03-01): `Users.svelte` now has inline user search (username/role/id), a `View` action per row, and a `User Insights` modal showing daily/monthly/all-time token totals, per-status job counts, and recent tokenized jobs. Backed by new admin API client method `users.insights()` -> `GET /api/users/:id/insights`.
- Training Vault job metadata table + filtered export controls (2026-03-01): `CoordinatorTraining.svelte` now renders a `Training Job Metadata + Export` panel sourced from normalized `learning/jobs/...` artifacts. The table shows job/user/worker/bridge/model/date plus inferred transport (`mcp` vs `cli_rest`/`mixed`) and supports export scopes (`selected job`, `selected bridge`, `current filters`, `all jobs`) with signal/transport/limit filtering.
- Training Vault humanized training job labels (2026-02-28): Vault Explorer training-job foldouts now parse friendly folder names (`<label>--<jobId>`) under `learning/jobs/<program>/...` and display readable job labels in the main row while retaining short job-id traceability in metadata.
- Agent template onboarding prompt pass (2026-02-28): after creating an agent config from template, Admin now opens a setup panel with provider-specific login guidance (steps, docs links, and copyable commands) so Claude/Codex/Gemini authorization can be completed immediately.
- Training Vault job-foldout organization pass (2026-02-26): `Vault Explorer` now collapses `learning/jobs/<program>/<jobId>/...` artifacts into one row per training job with nested file rows, reducing noise from multi-file training artifacts and making parent/child job outputs easier to inspect.
- Training Vault UX declutter pass (2026-02-26): split `Training Vault` into focused views (`Vault Explorer`, `Repository Controls`, `Snapshots`), switched repository `Program` input from free-text to a constrained dropdown, and moved snapshot export/import controls out of the main vault toolbar so file curation flows stay uncluttered.
- Machines distributed local-LLM controls (2026-02-26): Machines rule editor now manages per-worker local-LLM routing (`localLlmEnabled`, `localLlmBaseUrl`) and includes a direct endpoint probe action wired to `GET /api/workers/:id/local-llm-check` for fast worker-runtime validation before routing targeted local-oss jobs.
- Training repository control-plane UI (2026-02-26): `Training Vault` page now includes end-to-end repository controls for security managers/admins: policy JSON load/save (`GET/PUT /api/settings/training-repository-policy`), override curation CRUD (`GET/PUT /api/settings/training-repository-overrides`), indexed-record inspection/search (`GET /api/settings/training-repository-records`), queue/metrics/status inspection (`GET /api/settings/training-repository-status`, `GET /api/settings/training-repository-metrics`), and reindex queue/flush actions (`POST /api/settings/training-repository-reindex`).
- Training Vault organization/search overhaul (2026-02-25): Training Vault list now supports tokenized search across path + metadata fields, root/type/metadata filters, sorting (updated/path/size), grouping modes (root+bridge/root/bridge/flat), grouped section summaries, and improved row presentation (leaf + parent path + updated/meta chips) for large vault navigation.
- Global coordination policy control in Admin (2026-02-25): Training Vault page now includes a `Coordination Policy` section for security managers/admins to toggle global `Allow client-side coordination` (`PUT /api/settings/allow-client-coordination`), with current-state loading from `GET /api/settings`.
- Training Vault provenance controls (2026-02-25): admin Training Vault now surfaces per-entry metadata (`created/updated by`, IP, project paths, source paths, remarks), supports metadata editing/saving via `PUT /api/settings/coordinator-training-files/metadata`, and marks entries with metadata badges so admins can audit and curate training provenance before removing or retaining vault data.
- Training Vault snapshot portability controls (2026-02-25): Training Vault toolbar now includes full config snapshot `Export Snapshot` / `Import Snapshot` actions with an `Include server files` toggle. Exports include full server DB state + coordinator training files, and imports restore snapshot state through new settings snapshot APIs.
- Coordinator Training Vault explorer (2026-02-25): added a dedicated `Training Vault` admin page with global `training/` view (`scripts/`, `playbooks/`, `learning/`), searchable entry list, per-bridge/program filter, inline text editor, and file/folder create/update/delete actions through new coordinator-training settings APIs.
- Agent Config AUTO fallback wiring (2026-02-25): Agent Config form now supports optional `fallbackConfigId` editing so AUTO routing can escalate from a primary config to a specific fallback config when prompts need more capability.
- Agent Config local-model download progress UX (2026-02-25): model pull now uses streamed server progress events and renders live percent/progress bars in Agent Configs (single-model and bulk "Download Missing Allowed" flows).
- Agent Config local model allowlist/catalag pass (2026-02-25): `AgentConfigs` now consumes server model catalog metadata (`allowed`, `downloaded`, `recommended`, size hints), supports checkbox-based allowlist editing with `Save Allowed Models`, quick `Allow Common Models`, per-model download/update actions, and bulk `Download Missing Allowed`.
- Agent Config edit-open runtime crash fix (2026-02-25): escaped literal `{{MODEL}}` text in the Model input placeholder to avoid Svelte expression parsing (`MODEL is not defined`) that prevented the inline edit panel from rendering on `Edit`.
- Agent Config template-panel reliability fix (2026-02-25): replaced template popup with inline template panel toggle in `AgentConfigs`, eliminating embedded-webview overlay lockups where `Add from Template` could stop responding after an add cycle.
- Agent Config embedded-webview click fix (2026-02-25): moved Agent Config editor block directly above the list and switched delete confirmation to native `window.confirm`, removing dependency on custom confirmation overlay behavior in embedded Tauri admin sessions.
- Agent Config edit-panel reliability fix (2026-02-25): moved Agent Config new/edit form from modal to inline panel in `AgentConfigs` so edits cannot be blocked by hidden overlay state; template selection remains modal.
- Agent Config edit reliability fix (2026-02-25): Agent Config list/edit now normalizes legacy `args` payloads defensively and page action buttons explicitly use `type="button"`, preventing silent click failures in older datasets/embedded form contexts.
- Password reset confirmation hardening (2026-02-25): Users page reset-password modal now requires old password, new password, and confirm-new-password fields; API payload now sends `{ oldPassword, newPassword, confirmNewPassword }`.
- Template picker quick-add fix (2026-02-25): Agent Config templates remain in a modal popup, and `Use Template` now creates the config immediately (refreshing the list) with guarded in-flight state to avoid stuck-button/click-trap behavior.
- Local model UI stability fix (2026-02-25): Agent Config local-model auto-discovery now runs once per form open (instead of retry-looping on empty model lists), preventing UI thrash and restoring reliable button interaction when Ollama returns zero models.
- Local model discovery/pull UX (2026-02-25): Agent Configs now includes local runtime controls for `local-oss` profiles: refresh discovered Ollama models, choose from discovered list, on-demand model download/update, and optional auto-download before saving a config.
- Local agent-config UX pass (2026-02-25): Agent Config form now documents `local-oss` args placeholders (`{{MODEL}}`, `{{PROMPT}}`) so local runtime wiring is explicit. Template list now includes an `Ollama (Local)` starter profile from server templates.
- Version visibility baseline (2026-02-25, expanded 2026-03-11): admin build now injects `__ADMIN_VERSION__` plus `__ADMIN_BUILD__` (`<package version>+<git short sha>`). Login displays both version and build, and the authenticated header keeps the build visible across the admin shell.
- Typography consistency pass (2026-02-25): embedded local `Sora` font assets under `admin/src/assets/fonts/` and switched admin theme `--font-sans` to `Sora` via `@font-face` in `admin/src/app.css` for visual parity with client UI.
- CI type-check stabilization: tightened Users/Policies page typing (`loadError` toast path and `row` filter typing) so `npx svelte-check --tsconfig ./tsconfig.json` passes consistently in CI.
- Embedded auth hardening: `App.svelte` postMessage auto-login now requires `event.source === window.parent`, allowlisted origins, and strict token format validation before accepting `session_token` messages.

## App Structure
- `App.svelte`: login guard, shell layout, iframe token handoff (`session_token`) with parent-origin/source/token validation, and permission-aware page routing.
- Active routed pages: `users`, `api-keys`, `agents`, `machines`, `policies`, `coordinator-training`, `audit-log`.
- If a logged-in account has no admin-panel capabilities, app shows a `No Admin Access` state.
- Served by server as SPA at `/admin/*`.

## Active Pages
| Page | Features |
|------|----------|
| Login | Password + two-phase TOTP flow (`verify-totp` challenge step when required), now branded with the refreshed logo mark + wordmark and browser favicon. |
| Users | User CRUD, searchable user table, password reset (old password + new + confirm), and unified per-user `Edit` flow: role, `require2fa`, `clientCoordinationEnabled`, token limits (input/output/period), and fine-grained capability editing (`manageUsers`, `manageAgents`, `manageProjects`, `managePolicies`, `manageApiKeys`, `manageConnections`, `manageWorkers`, `manageSecurity`, `viewAuditLog`, `viewUsage`, `editCoordinator`, `useMcp`, `interveneJobs`, `executeCommands`, `deliverFiles`, `submitJobs`). Includes clickable username/`View` drill-down into an in-page `User Details` insights panel (daily/monthly/all-time usage totals, status counts, recent tokenized jobs) with `?user=<id>` deep-link support. |
| API Keys | Permission-gated API key manager (`manageApiKeys`) for active key listing with access summary column, create with role selection + grouped permission checkboxes (role-based defaults), one-time raw key reveal + copy, "Edit Permissions" modal for existing keys, and key revocation (`/api/keys`, `/api/keys/:id/permissions`). |
| AgentConfigs | Agent config CRUD via inline editor panel + inline template quick-add panel (`Use Template` creates config directly). Template adds can still show provider onboarding notes, and the page now includes a first-class `CLI Auth (Server Runtime)` panel for one-click Claude/Codex login in the active server runtime user context (status, start, live logs, open URL, copy code, cancel). Supports optional `fallbackConfigId` field for AUTO-routing escalation chains. Includes `Model Host` dropdown (`server`/`client` toggle, persisted on the agent config) for local-oss model host routing and a separate ephemeral `Catalog Source` dropdown (renamed from per-worker picker) for browsing worker model catalogs. Includes local model runtime tools (`runtime=ollama`): catalog + allowlist management (checkboxes, common-model presets, save allowlist), per-model download/update, bulk download for missing allowed models, live pull progress bar/percent via streamed events, and optional auto-pull before save. |
| Machines | Machine/worker inventory (`/api/workers`) with live status + IP, connected programs, per-machine rule editing (`banned`, `clientCoordinationAllowed`, `ipAllowlist`, `ipDenylist`, `localLlmEnabled`, `localLlmBaseUrl`, `note`) via `PUT /api/workers/:id/rules`, one-click worker local-LLM endpoint checks (`GET /api/workers/:id/local-llm-check`), and per-machine delete button with confirmation modal dialog (`DELETE /api/workers/:id`). Delete UI uses `confirmDelete` state, `deleteWorker()` handler, and `.btn-danger`/`.actions-cell` styles. |
| Policies | Server-side allow/deny filters with type tabs (`file_path`, `tool`, `prompt_filter`, `engine_model`, `command_filter`), per-user/global scope, enable/disable toggles, and create/edit/delete flow. |
| Training Vault | Global coordinator training explorer that lists one logical `training/` tree with `scripts/`, `playbooks/`, `learning/`, and `imports/`; organized into focused views (`Vault Explorer`, `Repository Controls`, `Snapshots`). In `Vault Explorer`, training job artifacts under `learning/jobs/<program>/<jobId>/...` render as one foldout row per job with nested file rows, while imported references now appear under the dedicated `imports` root. Includes a `Training Job Metadata + Export` panel with checkboxable job rows and scoped zip export by selected job, checked jobs, selected bridge/program, current filters, or full training set. Vault view also supports direct `Import Training Data (.zip)` ingest into server training roots, while job artifact files are read-only with explicit download/export actions (no misleading in-vault save behavior). `Snapshots` now handles full disaster-recovery zip export/import (`Export Entire Server (.zip)` / restore) with optional configured server-file inclusion. |
| AuditLog | Paginated admin activity log with action filtering and IP/details visibility. |

## Stores (`src/lib/stores/`)
| Store | File | State |
|-------|------|-------|
| auth | `auth.svelte.ts` | `token`, `user`, 2FA challenge state, plus capability getters (`canManageUsers`, `canManageAgents`, `canManagePolicies`, `canViewAuditLog`, etc.) and `hasAdminAccess`. |
| navigation | `navigation.svelte.ts` | `current: "users" | "api-keys" | "agents" | "machines" | "policies" | "coordinator-training" | "audit-log"` |
| toast | `toast.svelte.ts` | Toast queue/messages |

## Navigation + Layout
- `lib/components/layout/Sidebar.svelte`
  - Renders the refreshed Arkestrator logo mark beside the `Arkestrator / Admin` lockup
  - Capability-gated items: `Users`, `API Keys`, `Agents`, `Machines`, `Filters`, `Training Vault`, `Audit Log`
  - Filters items by permission (`manageUsers`, `manageApiKeys`, `manageAgents`, `manageWorkers`, `managePolicies`, `editCoordinator/manageSecurity`, `viewAuditLog`)
  - Auto-corrects `nav.current` to the first allowed page
- `lib/components/layout/Header.svelte`
  - Authenticated page title bar with persistent build badge (`Build <version+sha>`)
  - Titles for active pages (`users`, `api-keys`, `agents`, `machines`, `policies`, `coordinator-training`, `audit-log`)

## API Layer (`src/lib/api/client.ts`)
Active admin UI uses:
- `auth.*` (`login`, `verifyTotp`, `me`, `logout`)
- `users.*` (`list`, `insights`, `create`, `updateRole`, `resetPassword` with `oldPassword/newPassword/confirmNewPassword`, `delete`, `setLimits`, `updatePermissions`, `updateSettings`)
- `keys.*` (`list`, `create` with optional permissions, `revoke`, `updatePermissions`)
- `agents.*` (includes local model catalog discovery, allowlist updates, direct pull helpers, streamed pull-progress helper for live download UX, and CLI auth status/session/login helpers for Claude/Codex)
- `workers.list`, `workers.updateRules`, `workers.checkLocalLlm`, `workers.delete` (`DELETE /api/workers/:id`)
- `settings.get`, `settings.setAllowClientCoordination`, `settings.getTrainingRepositoryPolicy`, `settings.updateTrainingRepositoryPolicy`, `settings.getTrainingRepositoryOverrides`, `settings.updateTrainingRepositoryOverrides`, `settings.listTrainingRepositoryRecords`, `settings.getTrainingRepositoryStatus`, `settings.getTrainingRepositoryMetrics`, `settings.reindexTrainingRepository`
- `policies.*`
- `coordinatorTraining.*` (`list`, `readFile`, `writeFile`, `createFolder`, `deleteFile`, `deleteFolder`, `updateMetadata`, `listJobs`, `exportJobs`, `exportTrainingDataZip`, `importTrainingDataZip`, `exportSnapshot`, `importSnapshot`, `exportSnapshotZip`, `importSnapshotZip`)
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
