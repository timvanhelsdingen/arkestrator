# First-Time Startup Wizard

## Context
New users launching Arkestrator for the first time need guided onboarding to configure AI providers, install bridge plugins for their DCC apps, and set preferences. Currently, Setup.svelte only handles server connection + login, then dumps users into the main app with no guidance.

## Architecture Decision
**Separate wizard component (post-auth), not new modes in Setup.svelte.** Setup.svelte handles pre-auth (connection + login). The wizard is post-auth onboarding. A `pendingWizard` flag on the connection store (like existing `pendingForcedSetup`) blocks the main app while the wizard is active.

## Flow

```
App launch → Legal → Boot → Setup (connect + login) → completeLogin()
  → if !setupComplete in localStorage:
      connection.pendingWizard = true
  → App.svelte sees isAuthenticated && pendingWizard
      → Renders StartupWizard (not main app)
  → User completes or skips wizard
      → localStorage flag set, pendingWizard cleared
  → Main app shown
```

**Local server steps:** Welcome → Agent Setup → Bridge Plugins → Done
**Remote server steps:** Welcome → Bridge Plugins → Done

## Files to Create

### 1. `client/src/lib/stores/wizard.svelte.ts` — Wizard state
- `setupComplete` check from localStorage key `arkestrator-setup-complete-v1`
- `currentStep`, `isLocal` state
- `markComplete()` sets localStorage + clears `connection.pendingWizard`
- `skip()` alias for markComplete

### 2. `client/src/pages/StartupWizard.svelte` — Shell (~200 lines)
- Step indicator bar (inline, not separate component — simple enough)
- Renders active step component based on `currentStep`
- Back / Next / Skip Setup navigation
- Steps array derived from `wizard.isLocal`

### 3. `client/src/lib/components/wizard/WizardWelcome.svelte` (~60 lines)
- Logo, welcome message, brief description of what wizard configures
- Shows connection mode (local/remote) and username

### 4. `client/src/lib/components/wizard/WizardAgentSetup.svelte` (~300 lines)
- **Local server only**
- Fetches `api.agents.templates()` on mount (need to add to client REST API)
- Fetches `api.agents.list()` to check existing configs
- Fetches `api.agents.cliAuthStatus()` to show auth state per provider
- Shows each template as a selectable card: engine name, description, onboarding steps
- "Add Selected" button creates agent configs via `api.agents.create()`
- CLI auth status indicators (authenticated / needs login)
- Link to admin panel for advanced setup

### 5. `client/src/lib/components/wizard/WizardBridges.svelte` (~300 lines)
- Auto-fetches bridge registry on mount via `invoke("fetch_bridge_registry")`
- For each bridge, auto-detects paths via `invoke("detect_program_paths")`
- Shows cards per bridge: name, detected path, version, checkbox
- Pre-checks detected DCCs, unchecked for undetected
- "Install Selected" button does batch install
- Progress bar during installation
- Simplified flow vs full BridgeInstaller (no per-bridge dialog, auto-detect only)
- If DCC not detected, user can browse for path via folder picker

### 6. `client/src/lib/components/wizard/WizardDone.svelte` (~60 lines)
- Success state with summary (agents configured, bridges installed)
- "Open Settings" link for further customization
- "Get Started" button calls `wizard.markComplete()`

## Files to Modify

### 7. `client/src/lib/stores/connection.svelte.ts`
- Add `pendingWizard = $state(false)` to ConnectionState (line ~71, after pendingForcedSetup)

### 8. `client/src/pages/Setup.svelte`
- Import wizard store
- In `completeLogin()` (line 244), after saving session + connecting WS, add:
  ```ts
  if (!wizard.isComplete) {
    wizard.isLocal = connection.serverMode === "local";
    connection.pendingWizard = true;
  }
  ```

### 9. `client/src/App.svelte`
- Import StartupWizard
- Update `showMain` derived (line 54) to add `&& !connection.pendingWizard`
- Add render branch between `{:else if showMain}` and `{:else}`:
  ```svelte
  {:else if connection.isAuthenticated && connection.pendingWizard}
    <div class="app-body"><StartupWizard /></div>
  ```

### 10. `client/src/lib/api/rest.ts`
- Add to `agents` namespace:
  - `templates: () => request("/api/agent-configs/templates")`
  - `create: (data) => request("/api/agent-configs", { method: "POST", body: ... })`
  - `cliAuthStatus: () => request("/api/agent-configs/cli-auth/status")`

## Edge Cases
- **Existing users upgrading:** Will see wizard once (no localStorage flag). Can skip immediately. Could also auto-skip if agent configs already exist.
- **Forced 2FA:** `pendingForcedSetup` takes priority in showMain. Wizard triggers after 2FA setup completes.
- **Sign out / re-login:** `pendingWizard` is transient (session-only). localStorage flag persists, so wizard won't re-show.
- **Remote users:** Skip agent setup entirely (server admin's domain).

## Implementation Order
1. `wizard.svelte.ts` store
2. `connection.svelte.ts` — add `pendingWizard`
3. `rest.ts` — add missing agent API methods
4. `WizardWelcome.svelte` + `WizardDone.svelte` (simple)
5. `WizardAgentSetup.svelte` (REST API calls)
6. `WizardBridges.svelte` (Tauri commands)
7. `StartupWizard.svelte` shell (orchestrates steps)
8. `Setup.svelte` — trigger wizard in completeLogin()
9. `App.svelte` — render wizard branch
10. Update MODULE.md, PROJECT_PLAN.md
11. Rebuild: `pnpm --filter @arkestrator/protocol build && pnpm --filter @arkestrator/client build`

## Verification
1. Clear localStorage (`arkestrator-setup-complete-v1` key) to trigger wizard
2. Login to local server → should see wizard with 4 steps
3. Agent setup step: loads templates, can select and create configs
4. Bridge step: auto-detects DCCs, can install bridges
5. Done step: shows summary, "Get Started" transitions to main app
6. Refresh: wizard should NOT re-appear (localStorage flag set)
7. Test remote flow: connect to remote → wizard has 3 steps (no agent setup)
8. Test "Skip Setup" button: goes straight to main app, sets localStorage flag
