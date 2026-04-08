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

  // Script editor side panel
  type ScriptEditorTarget = string | null; // program name or null
  let scriptEditorTarget = $state<ScriptEditorTarget>(null);
  let scriptEditorDraft = $state("");
  let editorPanelWidth = $state(520);

  // Client prompt overrides
  const CLIENT_PROMPT_OVERRIDES_STORAGE_KEY = "arkestrator-coordinator-client-prompt-overrides-v1";
  let clientPromptOverrideGlobal = $state("");
  let clientOverridesByProgram = $state<Record<string, string>>({});

  function startEditorResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = editorPanelWidth;
    function onMove(ev: MouseEvent) {
      editorPanelWidth = Math.max(360, Math.min(800, startW - (ev.clientX - startX)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

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

  function loadClientPromptOverrides() {
    let global = "";
    let byProgram: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        global = String(parsed?.global ?? "").trim();
        const byProgramRaw = parsed?.byProgram;
        if (byProgramRaw && typeof byProgramRaw === "object" && !Array.isArray(byProgramRaw)) {
          for (const [key, value] of Object.entries(byProgramRaw as Record<string, unknown>)) {
            const k = normalizeProgramKey(key);
            const text = String(value ?? "").trim();
            if (k && text) byProgram[k] = text;
          }
        }
      }
    } catch {
      global = "";
      byProgram = {};
    }
    clientPromptOverrideGlobal = global;
    clientOverridesByProgram = byProgram;
  }

  function saveClientPromptOverrides() {
    const payload: Record<string, unknown> = {};
    const global = clientPromptOverrideGlobal.trim();
    if (global) payload.global = global;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(clientOverridesByProgram)) {
      const text = v.trim();
      if (text) cleaned[normalizeProgramKey(k)] = text;
    }
    if (Object.keys(cleaned).length > 0) payload.byProgram = cleaned;
    localStorage.setItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY, JSON.stringify(payload));
    clientOverridesByProgram = cleaned;
    clientPromptOverrideGlobal = global;
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
      loadClientPromptOverrides();
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="scripts-page">
  <div class="scripts-body">
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

        <!-- Client Prompt Overrides -->
        <section class="panel" style="margin-top: 16px;">
          <h3>Client Bridge Prompt Overrides</h3>
          <p class="desc">
            Add local client-only instructions that are appended after server coordinator scripts when you submit jobs.
            These do not modify server scripts or training vault data.
          </p>
          <label>
            Global Client Override (optional)
            <textarea
              rows="6"
              bind:value={clientPromptOverrideGlobal}
              spellcheck="false"
              placeholder="Instructions added to all bridge runs from this client."
            ></textarea>
          </label>
          <div class="actions" style="margin-top: 8px;">
            <button class="btn" onclick={() => { saveClientPromptOverrides(); info = "Saved client prompt overrides."; }}>
              Save Client Overrides
            </button>
          </div>
          <p class="mini" style="margin-top: 6px;">
            Client coordination policy: {connection.allowClientCoordination ? "enabled by admin" : "disabled by admin"}.
            Your account preference: {connection.clientCoordinationEnabled ? "enabled" : "disabled"}.
          </p>
        </section>
      {/if}
    </div>

    <!-- Script editor side panel (resizable) -->
    {#if isAdmin && scriptEditorTarget}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sidebar-resize-handle" onmousedown={startEditorResize}></div>
      <aside class="editor-panel" style="width: {editorPanelWidth}px;">
        <section class="panel script-editor-panel">
          <h3>
            {scriptEditorTarget === "global" ? "Global Coordinator Script" : `${scriptEditorTarget.charAt(0).toUpperCase() + scriptEditorTarget.slice(1)} Coordinator Script`}
          </h3>
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
            <button class="btn secondary" onclick={closeScriptEditor} disabled={scriptsSaving}>Close</button>
          </div>
        </section>
      </aside>
    {/if}
  </div>
</div>

<style>
  .scripts-page {
    padding: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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

  .scripts-body {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }
  .scripts-main {
    flex: 1;
    overflow-y: auto;
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
  .mini { font-size: 11px; color: var(--text-muted); }
  .error { margin-bottom: 10px; color: var(--status-failed); font-size: var(--font-size-sm); }
  .info { margin-bottom: 10px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .btn { padding: 6px 12px; border-radius: var(--radius-sm); background: var(--accent); color: #fff; border: none; }
  .btn.secondary { border: 1px solid var(--border); background: var(--bg-base); color: var(--text-secondary); }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); color: var(--text-secondary); }
  textarea, input:not([type="checkbox"]):not([type="radio"]), select {
    width: 100%; background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px;
  }
  textarea { font-family: var(--font-mono); line-height: 1.45; resize: both; max-width: 100%; min-height: 96px; }

  /* Resizable editor side panel */
  .sidebar-resize-handle {
    width: 4px; cursor: col-resize; background: transparent; flex-shrink: 0; transition: background 0.15s;
  }
  .sidebar-resize-handle:hover, .sidebar-resize-handle:active { background: var(--accent); }
  .editor-panel {
    display: flex; flex-direction: column; border-left: 1px solid var(--border); overflow-y: auto; flex-shrink: 0;
  }
  .script-editor-panel {
    height: 100%; display: flex; flex-direction: column; overflow: hidden;
  }
  .script-editor-panel label {
    display: flex; flex-direction: column; gap: 4px; flex: 1; min-height: 0;
  }
  .script-editor-textarea {
    flex: 1; min-height: 200px; resize: none;
  }
</style>
