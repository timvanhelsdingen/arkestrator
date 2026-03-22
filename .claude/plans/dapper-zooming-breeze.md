# v0.1.60 Post-Release Fix Plan

## Context

The v0.1.59 and v0.1.60 releases ("Skills as single source of truth" + "Skills unification complete") introduced a skills system but broke several things:

1. **Chat Job Settings panel disappeared** — ChatJobConfig import was removed from Chat.svelte, losing Agent/Model/Reasoning/Verify/Name controls
2. **Admin Skills page is orphaned** — Built but never wired into navigation/routing
3. **Hardcoded coordinator prompts** — 7 bridge programs with large prompts baked into server code
4. **Bridge repos not updated** — arkestrator-bridges repo lacks coordinator.md and skills folders
5. **Training Vault + Skills consolidation incomplete** — Training Vault still shows, Skills doesn't

---

## Fix 1: Restore Chat Job Settings Panel (Critical)

**Problem:** In v0.1.58, `Chat.svelte` had a `chat-sidebar` div on the right containing `ChatJobConfig` (top) and `ChatContextPanel` (bottom). In v0.1.60, the sidebar wrapper and ChatJobConfig import were removed, making Agent selection, Model override, Reasoning level, Verification, and Job Name all inaccessible.

**Files to modify:**
- `client/src/pages/Chat.svelte`

**Changes:**
1. Re-add `import ChatJobConfig from "../lib/components/chat/ChatJobConfig.svelte"`
2. Restore the `chat-sidebar` wrapper div in the template:
   ```svelte
   <div class="chat-sidebar">
     <ChatJobConfig />
     {#if chatStore.showContextPanel}
       <ChatContextPanel />
     {/if}
   </div>
   ```
3. Restore the CSS for `.chat-sidebar` (260px wide, flex column, border-left, etc.)
4. Remove the standalone `{#if chatStore.showContextPanel}` that's currently floating in chat-body

This is a direct restoration from the v0.1.58 structure. ChatJobConfig.svelte itself is fine — it just needs to be mounted again.

---

## Fix 2: Wire Skills Page into Admin Navigation

**Problem:** `admin/src/pages/Skills.svelte` is a fully built page (registry browser, CRUD, import/export) but is not routed, not in the nav type, and not in the sidebar.

**User intent:** Combined tabbed interface with Training Vault and Skills together.

**Files to modify:**
- `admin/src/lib/stores/navigation.svelte.ts` — add `"skills"` to Page type
- `admin/src/App.svelte` — import Skills, add route condition
- `admin/src/lib/components/layout/Sidebar.svelte` — replace "Training Vault" entry with combined "Knowledge" entry, OR add Skills as separate entry

**Approach — Tabbed Knowledge page:**
- Rename the sidebar entry from "Training Vault" to "Skills & Training" (or "Knowledge")
- The `coordinator-training` page becomes a container with two tabs:
  - **Skills** tab — renders the existing Skills.svelte component content
  - **Training** tab — renders the existing CoordinatorTraining.svelte content
- OR simpler: just add "Skills" as its own sidebar entry alongside "Training Vault"

**Recommended (simpler, less risk):** Add Skills as its own sidebar entry. Both pages already exist and work. Merging them into tabs is a UI refactor that can be done later. The immediate fix is just to make Skills reachable.

**Steps:**
1. In `navigation.svelte.ts`, add `| "skills"` to the Page type union
2. In `App.svelte`:
   - Add `import Skills from "./pages/Skills.svelte"`
   - Add route: `{:else if nav.current === "skills" && (auth.canEditCoordinator || auth.canManageSecurity)}`
   - Render `<Skills />`
3. In `Sidebar.svelte`:
   - Add Skills entry after the Training Vault entry (or before it):
     ```ts
     { page: "skills", label: "Skills", icon: "folder", canAccess: () => auth.canEditCoordinator || auth.canManageSecurity }
     ```
   - Need a distinct icon — could use "book" or similar. Add to iconPaths.

---

## Fix 3: Remove Hardcoded Coordinator Prompts

**Problem:** `COORDINATOR_SCRIPT_DEFAULTS` in `server/src/agents/engines.ts` hardcodes ~1000+ lines of coordinator prompts for blender, godot, houdini, comfyui, unity, unreal. `seedBuiltinPatternSkills()` hardcodes 4 pattern skills. This contradicts the community-driven model where bridges bring their own skills.

**User intent:** Remove hardcoded, generic only. Content comes from bridge repos or user creation.

**Files to modify:**
- `server/src/agents/engines.ts` — the main file with hardcoded prompts

**Changes:**
1. **Replace `COORDINATOR_SCRIPT_DEFAULTS`** — remove all program-specific prompts. Keep only:
   - `global`: The orchestrator prompt (this is arkestrator's own logic, not bridge-specific)
   - All other programs: generic template only

   ```ts
   const COORDINATOR_SCRIPT_DEFAULTS: Record<string, string> = {
     global: DEFAULT_ORCHESTRATOR_PROMPT,
   };
   ```

2. **Update `ensureCoordinatorScript()`** — already has generic fallback logic:
   ```ts
   const content = registryContent ?? COORDINATOR_SCRIPT_DEFAULTS[normalized]
     ?? `# ${...} Coordinator\n\nCoordinator script for ${normalized}...`;
   ```
   This already works for unknown programs. With the hardcoded entries removed, ALL programs (including blender, godot, etc.) will get this generic stub unless overridden by bridge repo content.

3. **Remove `seedBuiltinPatternSkills()`** — delete the function and its call in `seedCoordinatorScripts()`. Pattern skills should come from bridge repos.

4. **Update `removeCoordinatorScript()`** — currently blocks removal of built-in programs:
   ```ts
   if (COORDINATOR_SCRIPT_DEFAULTS[normalized]) return false;
   ```
   With only `global` in the defaults, this naturally allows removing any bridge-specific coordinator.

5. **Remove the large prompt constants** — `BLENDER_COORDINATOR_PROMPT`, `GODOT_COORDINATOR_PROMPT`, `HOUDINI_COORDINATOR_PROMPT`, `COMFYUI_COORDINATOR_PROMPT`, `UNITY_COORDINATOR_PROMPT`, `UNREAL_COORDINATOR_PROMPT`. These are hundreds of lines each.

6. **Keep `DEFAULT_ORCHESTRATOR_PROMPT`** — this is arkestrator's own cross-bridge orchestration logic, not bridge-specific.

**Impact:**
- On fresh installs: only the global coordinator + generic stubs exist
- On bridge connect: `ensureCoordinatorScript()` creates a generic stub + pulls from bridge repo if available
- Existing installations: user-edited scripts preserved (hash-based protection), builtin entries in skills DB will get generic content on next seed

---

## Fix 4: Bridge Repos (Out of Scope — Separate Task)

The `arkestrator-bridges` repo needs:
- `registry.json` at the repo root
- `{program}/coordinator.md` for each bridge (blender, godot, houdini, comfyui)
- `{program}/skills/` folders with skill markdown files

This is in a separate repo and cannot be done here. The coordinator content that was hardcoded should be moved to those files. **Note for separate task:** extract the removed coordinator prompts and create proper coordinator.md files in arkestrator-bridges.

---

## Fix 5: Rebuild Admin Dist + Cleanup

After all fixes:
1. `pnpm --filter @arkestrator/protocol build`
2. `pnpm --filter @arkestrator/admin build`
3. `cp -r admin/dist/* client/resources/admin-dist/`
4. Update `admin/MODULE.md`, `client/MODULE.md`, `server/MODULE.md`
5. Update `PROJECT_PLAN.md`

---

## Verification

1. **Chat Job Settings**: Start client, navigate to Chat. The right sidebar should show Job Settings panel with Agent, Model, Reasoning, Verify, V Weight, Skills, Name controls. Below it, the Context Panel with bridge context.
2. **Admin Skills page**: Log into admin panel. Sidebar should show "Skills" entry. Clicking it should load the Skills management page with skill listing, search, create, registry browser, import/export.
3. **Generic coordinators**: Start server fresh (clear skills DB). Only `global-coordinator` should have substantial content. All bridge-specific coordinators should be generic stubs. On bridge connect, check that generic stub is created and bridge repo pull is attempted.
4. **Admin build**: Verify `client/resources/admin-dist/` is up to date with the new admin pages.

---

## Execution Order

1. Fix 1 (Chat sidebar) — highest priority, users can't select agents
2. Fix 2 (Admin Skills page) — wire into navigation
3. Fix 3 (Remove hardcoded prompts) — large but straightforward deletion
4. Fix 5 (Rebuild + docs)
