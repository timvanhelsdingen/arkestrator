# Client UI Reorganization Plan

## Context
The client UI has grown organically and feels crowded/chaotic. Settings is a 2651-line monolith mixing server config, account management, bridges, LLM, and coordinator sections. The Coordinator page uses a sidebar layout that wastes space. Workers are stacked vertically which doesn't scale. This plan reorganizes all three pages for clarity and usability.

---

## 1. Settings Page → Tabbed Layout

**Files:** `client/src/pages/Settings.svelte` + 4 new sub-components

### New Structure
- **Account section** (always visible above tabs when authenticated): session info, password change, 2FA, clear data
- **Server tab**: ServerManager, server connection/URL/test/disconnect, worker mode toggle, launch-on-startup, default project dir
- **Bridges tab**: BridgeInstaller (auto-loads on page mount instead of requiring button press), bridge status overview
- **Local LLM tab**: Ollama enable/disable + hardware info, local model catalog, server LLM URL settings

### New Components
- `client/src/lib/components/settings/SettingsAccountSection.svelte`
- `client/src/lib/components/settings/SettingsServerTab.svelte`
- `client/src/lib/components/settings/SettingsBridgesTab.svelte`
- `client/src/lib/components/settings/SettingsLlmTab.svelte`

### Key Changes
- Remove `showOnlyCoordinator` prop entirely (not used by App.svelte)
- Remove ALL coordinator-related code from Settings (~60 state vars, all coord functions, coord UI) — it already has its own page
- Each sub-component manages its own state and imports stores directly
- Tab state: `let settingsTab = $state<'server' | 'bridges' | 'llm'>('server')`
- Tab styling reuses existing pill-button pattern from Coordinator tabs

---

## 2. Coordinator Page → Single Panel + Horizontal Toolbar

**File:** `client/src/pages/Coordinator.svelte`

### Current → New Layout
- **Remove**: Left sidebar (`aside.coord-left`) with tabs, dropdown, readiness panel
- **Add**: Horizontal toolbar bar above content with tabs, bridge dropdown, readiness pills inline
- **Content**: Full-width single panel (no sidebar)
- **Script editing**: Slides out as a resizable right panel (Chat sidebar pattern — draggable 4px handle, 200-600px range)

### Toolbar Bar Contents
- Left: Tab buttons (Server Config, Training, Client Config) + bridge/program dropdown
- Right: Readiness pills (bridge count online, fallback mode status) + Refresh + Run Probe buttons
- Probe output: Collapsible section below toolbar (not a permanent sidebar section)

### Key Changes
- Replace `.coordinator-layout` grid CSS with flex column (toolbar + body)
- `.coord-body` is flex row: content (flex:1) + optional editor panel
- Copy `startSidebarResize` from `Chat.svelte` (lines 24-38) for editor panel resizing
- Content sections use full width — more room for skills tables, training dashboard

---

## 3. Workers Page → Grid + Right Monitor Panel

**File:** `client/src/pages/Workers.svelte`

### Current → New Layout
- **Remove**: Stacked accordion list (`expandedWorker` state)
- **Add**: 3-wide CSS grid of compact worker cards
- **Add**: Resizable right sidebar (Chat pattern) for monitoring selected workers

### Grid Cards (Compact)
- Status badge, worker name
- Bridge count, known programs badges
- Worker IP, last seen
- Delete button (with stopPropagation)
- `.monitored` highlight when selected

### Monitor Sidebar
- Appears when 1+ workers are selected (clicking a card toggles it in/out)
- Multiple workers can be monitored simultaneously
- Each monitored worker shows full details: machine info + bridge rows
- "Clear All" button in sidebar header
- Resizable with draggable divider (same pattern as Chat, 200-500px)

### Key Changes
- Replace `expandedWorker: string | null` with `monitoredWorkerIds: Set<string>`
- Grid responsive: 3 cols → 2 cols at 1200px → 1 col at 800px
- Reuse `displayBridgesForWorker()` in monitor panel

---

## Implementation Order

1. **Settings tabs** — cleanest extraction, lowest risk
2. **Workers grid + monitor** — medium complexity
3. **Coordinator single panel** — highest complexity (2129-line file)
4. **Cleanup** — MODULE.md updates, rebuild

## Verification
- Run `pnpm --filter @arkestrator/client build` (Tauri build) after all changes
- Visual check: Settings tabs switch correctly, all settings still function
- Visual check: Workers grid renders 3-wide, clicking adds to monitor sidebar, resize works
- Visual check: Coordinator toolbar shows tabs/readiness inline, content is full-width, script editor slides out
- Ensure dark theme consistency across all new components
