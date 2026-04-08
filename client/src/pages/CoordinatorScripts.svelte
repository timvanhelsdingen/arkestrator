<script lang="ts">
  import { connection } from "../lib/stores/connection.svelte";
  import { api } from "../lib/api/rest";

  const canManage = $derived(connection.canEditCoordinator || connection.userRole === "admin");
  const isAdmin = $derived(connection.userRole === "admin");

  // Programs (bridges)
  let programs = $state<Array<{ value: string; label: string; isApi: boolean }>>([]);
  let loading = $state(false);
  let error = $state("");
  let info = $state("");

  // Scripts keyed by program name
  let scriptsByProgram = $state<Record<string, string>>({});
  let scriptsSaving = $state(false);

  // Script editor modal
  type ScriptEditorTarget = string | null; // program name or null
  let scriptEditorTarget = $state<ScriptEditorTarget>(null);
  let scriptEditorDraft = $state("");

  function normalizeProgramKey(value: string): string {
    return String(value ?? "").trim().toLowerCase();
  }

  function previewScript(content: string): string {
    const oneLine = String(content ?? "").trim().replace(/\s+/g, " ");
    if (!oneLine) return "No script content yet.";
    return oneLine.length > 140 ? `${oneLine.slice(0, 140)}...` : oneLine;
  }

  async function loadPrograms() {
    try {
      const [bridgesRes, apiBridgesRes] = await Promise.all([
        api.bridgeCommands.listBridges(),
        api.apiBridges.list().catch(() => []),
      ]);
      const knownKeys = new Set<string>();
      const apiKeys = new Set<string>();
      for (const bridge of Array.isArray(bridgesRes?.bridges) ? bridgesRes.bridges : []) {
        const key = normalizeProgramKey(String((bridge as any)?.program ?? ""));
        if (key) knownKeys.add(key);
      }
      for (const ab of Array.isArray(apiBridgesRes) ? apiBridgesRes : []) {
        const name = normalizeProgramKey(String((ab as any)?.name ?? ""));
        if (name) { knownKeys.add(name); apiKeys.add(name); }
      }
      knownKeys.add("global");
      programs = [...knownKeys].sort().map((p) => ({
        value: p,
        label: p.charAt(0).toUpperCase() + p.slice(1),
        isApi: apiKeys.has(p),
      }));
    } catch {
      // non-fatal
    }
  }

  async function loadScripts() {
    if (!isAdmin) return;
    try {
      const result = await api.settings.getCoordinatorScripts();
      const scripts = Array.isArray(result?.scripts) ? result.scripts : [];
      const map: Record<string, string> = {};
      for (const s of scripts) {
        const prog = normalizeProgramKey(String((s as any)?.program ?? ""));
        if (prog) map[prog] = String((s as any)?.content ?? "");
      }
      scriptsByProgram = map;
    } catch (err: any) {
      error = `Failed to load scripts: ${err.message ?? err}`;
    }
  }

  function openScriptEditor(program: string) {
    scriptEditorTarget = program;
    scriptEditorDraft = scriptsByProgram[program] ?? "";
  }

  function closeScriptEditor() {
    scriptEditorTarget = null;
    scriptEditorDraft = "";
  }

  async function saveScriptEditor() {
    if (!isAdmin || !scriptEditorTarget) return;
    scriptsSaving = true;
    error = "";
    info = "";
    try {
      await api.settings.setCoordinatorScript(scriptEditorTarget, scriptEditorDraft);
      scriptsByProgram = { ...scriptsByProgram, [scriptEditorTarget]: scriptEditorDraft };
      info = `Saved ${scriptEditorTarget} script.`;
      closeScriptEditor();
    } catch (err: any) {
      error = `Save script failed: ${err.message ?? err}`;
    } finally {
      scriptsSaving = false;
    }
  }

  async function resetScript(program: string) {
    if (!isAdmin) return;
    error = "";
    info = "";
    try {
      await api.settings.resetCoordinatorScript(program);
      await loadScripts();
      info = `Reset ${program} script to default.`;
    } catch (err: any) {
      error = `Reset failed: ${err.message ?? err}`;
    }
  }

  let initialized = false;
  $effect(() => {
    if (!canManage || initialized) return;
    initialized = true;
    void refreshAll();
  });

  async function refreshAll() {
    loading = true;
    error = "";
    info = "";
    try {
      await Promise.all([loadPrograms(), loadScripts()]);
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="scripts-page">
  <div class="scripts-main">
    <h2>Coordinator Scripts</h2>
    {#if !canManage}
      <div class="panel">
        <p>You don't have permission to manage coordinator scripts.</p>
      </div>
    {:else}
      <div class="scripts-toolbar">
        <button class="btn secondary" onclick={refreshAll} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {#if error}<div class="error">{error}</div>{/if}
      {#if info}<div class="info">{info}</div>{/if}

      {#if isAdmin}
        <div class="script-cards">
          {#each programs as prog (prog.value)}
            <div class="script-card">
              <div class="script-card-header">
                <span class="script-card-title">{prog.label}</span>
                <div class="script-card-badges">
                  {#if prog.value === "global"}
                    <span class="badge type-badge global">Global</span>
                  {:else if prog.isApi}
                    <span class="badge type-badge api">API</span>
                  {:else}
                    <span class="badge type-badge dcc">DCC</span>
                  {/if}
                </div>
              </div>
              <div class="script-card-preview">
                {previewScript(scriptsByProgram[prog.value] ?? "")}
              </div>
              <div class="script-card-actions">
                <button class="btn secondary" onclick={() => openScriptEditor(prog.value)}>Edit</button>
                {#if prog.value !== "global"}
                  <button class="btn secondary" onclick={() => resetScript(prog.value)}>Reset</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="panel">
          <h3>Server Scripts</h3>
          <p class="desc">Server-side coordinator scripts are admin-managed.</p>
        </div>
      {/if}
    {/if}
  </div>
</div>

<!-- Script editor modal -->
{#if isAdmin && scriptEditorTarget}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="script-modal-overlay" onclick={closeScriptEditor}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="script-modal-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="script-modal-header">
        <h3>
          {scriptEditorTarget === "global" ? "Global Coordinator Script" : `${scriptEditorTarget.charAt(0).toUpperCase() + scriptEditorTarget.slice(1)} Coordinator Script`}
        </h3>
        <button class="btn-sm" onclick={closeScriptEditor}>X</button>
      </div>
      <p class="desc">
        {#if scriptEditorTarget === "global"}
          Update the global script applied before bridge-specific instructions.
        {:else}
          Update the <strong>{scriptEditorTarget}</strong> script applied after the global coordinator script.
        {/if}
      </p>
      <label>
        Script
        <textarea class="script-editor-textarea" bind:value={scriptEditorDraft} spellcheck="false"></textarea>
      </label>
      <div class="actions">
        <button class="btn" onclick={saveScriptEditor} disabled={scriptsSaving}>
          {scriptsSaving ? "Saving..." : "Save Script"}
        </button>
        <button class="btn secondary" onclick={closeScriptEditor} disabled={scriptsSaving}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scripts-page {
    padding: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: auto;
    max-width: 1100px;
  }
  h2 { font-size: var(--font-size-lg); margin-bottom: 12px; }
  h3 { font-size: var(--font-size-base); margin-bottom: 8px; color: var(--text-secondary); }

  .scripts-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .scripts-main {
    flex: 1;
    min-width: 0;
  }

  /* Script cards grid */
  .script-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .script-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .script-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .script-card-title {
    font-weight: 600;
    font-size: var(--font-size-base);
    color: var(--text-primary);
  }
  .script-card-badges {
    display: flex;
    gap: 4px;
  }
  .type-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 999px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .type-badge.global {
    background: rgba(100, 180, 255, 0.15);
    color: #6ab4ff;
    border: 1px solid rgba(100, 180, 255, 0.3);
  }
  .type-badge.api {
    background: rgba(180, 130, 255, 0.15);
    color: #b482ff;
    border: 1px solid rgba(180, 130, 255, 0.3);
  }
  .type-badge.dcc {
    background: rgba(100, 200, 150, 0.15);
    color: #64c896;
    border: 1px solid rgba(100, 200, 150, 0.3);
  }
  .script-card-preview {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    padding: 10px;
    font-size: var(--font-size-sm);
    line-height: 1.4;
    word-break: break-word;
    min-height: 48px;
  }
  .script-card-actions {
    display: flex;
    gap: 6px;
  }

  .panel { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); padding: 12px; margin-bottom: 12px; }
  .desc { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4; }
  .error { margin-bottom: 10px; color: var(--status-failed); font-size: var(--font-size-sm); }
  .info { margin-bottom: 10px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .btn { padding: 6px 12px; border-radius: var(--radius-sm); background: var(--accent); color: #fff; border: none; }
  .btn.secondary { border: 1px solid var(--border); background: var(--bg-base); color: var(--text-secondary); }
  .btn-sm { padding: 4px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-base); color: var(--text-secondary); font-size: var(--font-size-sm); }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); color: var(--text-secondary); }
  textarea, input:not([type="checkbox"]):not([type="radio"]), select {
    width: 100%; background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px;
  }
  textarea { font-family: var(--font-mono); line-height: 1.45; resize: both; max-width: 100%; min-height: 96px; }

  /* Script editor modal */
  .script-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .script-modal-dialog {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    width: 640px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }
  .script-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .script-modal-header h3 {
    margin: 0;
  }
  .script-editor-textarea {
    flex: 1;
    min-height: 300px;
    resize: vertical;
  }
</style>
