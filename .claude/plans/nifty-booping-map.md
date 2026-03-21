# Admin Bridges Page

## Context

Bridge management is scattered across Machines, Coordinator Training, and Settings pages. Need a centralized "Bridges" tab in admin to manage bridge programs: view status, add/remove programs, kick connections, edit coordinator scripts.

## Changes

### 1. Navigation + Routing

**`admin/src/lib/stores/navigation.svelte.ts`** — Add `"bridges"` to `Page` type

**`admin/src/lib/components/layout/Sidebar.svelte`** — Add sidebar entry after "machines", gated on `auth.canManageWorkers`, with a link/plug icon

**`admin/src/App.svelte`** — Add import + conditional render for Bridges component

### 2. Server — New endpoint

**`server/src/routes/workers.ts`** — Add `DELETE /api/workers/bridges-by-program/:program`
- Calls `workersRepo.deleteBridgesByProgram(program)`
- Audit logged, permission-gated on `manageWorkers`
- Must be registered BEFORE `/:id` routes to avoid param catch

### 3. Admin API client

**`admin/src/lib/api/client.ts`** — Add:
- `connections.list()` → `GET /api/connections`
- `connections.kick(id)` → `POST /api/connections/:id/kick`
- `workers.deleteBridgesByProgram(program)` → new DELETE endpoint
- `coordinatorTraining.updateCoordinatorScript(program, content)` → existing `PUT` endpoint

### 4. Bridges page component (new file)

**`admin/src/pages/Bridges.svelte`**

**Data sources** (fetched in parallel on mount):
- `api.workers.list()` → workers + bridge info (live + historical)
- `api.connections.list()` → active WS connections (for kick IDs)
- `api.coordinatorTraining.listCoordinatorScripts()` → scripts per program

**Derived program-centric view** — For each unique program:
- `activeConnections`: count + IDs of live bridges
- `workers`: which workers have this bridge
- `versions`: bridge version, program version
- `hasScript` / `scriptIsDefault`: coordinator script status

**UI layout:**
| Program | Status | Workers | Versions | Script | Actions |
|---------|--------|---------|----------|--------|---------|
| blender | 2 active | worker-1, worker-2 | v0.1.48 / 4.3 | Default | [Edit] [Kick All] [Remove] |
| godot | offline | worker-1 | v0.1.47 / 4.4 | Customized | [Edit] [Remove] |

**Actions:**
- **Add Bridge** — modal with program name input + optional script content, calls PUT coordinator-scripts
- **Edit Script** — modal with textarea, save/reset-to-default buttons
- **Kick All** — confirmation, iterates `connections.kick(id)` for each active connection
- **Remove** — confirmation, calls `deleteBridgesByProgram` + `deleteCoordinatorScript`

**Svelte 5 runes** — `$state` for loading/modals/data, `$derived` for program aggregation

### 5. Documentation

- `admin/MODULE.md` — add Bridges page
- `server/MODULE.md` — document new endpoint

## Files

| File | Change |
|------|--------|
| `admin/src/pages/Bridges.svelte` | **New** — main page component |
| `admin/src/lib/stores/navigation.svelte.ts` | Add `"bridges"` to Page type |
| `admin/src/lib/components/layout/Sidebar.svelte` | Add sidebar entry |
| `admin/src/App.svelte` | Wire page routing |
| `admin/src/lib/api/client.ts` | Add connections + new API methods |
| `server/src/routes/workers.ts` | Add DELETE bridges-by-program endpoint |
| `admin/MODULE.md` | Update docs |
| `server/MODULE.md` | Update docs |

## Verification

1. Start server → admin sidebar shows "Bridges" tab
2. Connect a bridge → program appears in Bridges page with "1 active" status
3. Click "Edit Script" → can view/edit coordinator script in modal
4. Click "Kick All" → bridge connection terminated, status goes offline
5. Click "Remove" → program removed from list, DB records + script deleted
6. Click "Add Bridge" → new program appears, coordinator script created
7. Reconnect bridge → program re-appears dynamically
