<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../api/rest";
  import { wizard } from "../../stores/wizard.svelte";

  interface PresetInfo {
    presetId: string;
    displayName: string;
    defaultBaseUrl: string;
    authType?: string;
    description?: string;
    actions: Array<{ name: string; description: string }>;
    hasHandler?: boolean;
  }

  interface PresetState {
    preset: PresetInfo;
    selected: boolean;
    apiKey: string;
    baseUrl: string;
    saving: boolean;
    saved: boolean;
    testing: boolean;
    testOk: boolean | null;
    error: string;
  }

  let presetStates = $state<PresetState[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let alreadyConfigured = $state<string[]>([]);

  onMount(async () => {
    try {
      const presets = (await api.apiBridges.presets()) as PresetInfo[];
      // List existing bridges — may fail if not yet authenticated (wizard flow)
      let existing: Array<{ name: string }> = [];
      try { existing = (await api.apiBridges.list()) as Array<{ name: string }>; } catch { /* not authenticated yet */ }
      alreadyConfigured = existing.map((b) => b.name);
      presetStates = presets.map((preset) => ({
        preset,
        selected: false,
        apiKey: "",
        baseUrl: preset.defaultBaseUrl,
        saving: false,
        saved: alreadyConfigured.includes(preset.presetId),
        testing: false,
        testOk: null,
        error: "",
      }));
    } catch (err: any) {
      loadError = err.message ?? String(err);
    } finally {
      loading = false;
    }
  });

  async function testPreset(state: PresetState) {
    if (!state.apiKey && !state.saved) return;
    state.testing = true;
    state.testOk = null;
    try {
      // If already saved, test the saved bridge
      if (state.saved) {
        const bridges = (await api.apiBridges.list()) as Array<{ id: string; name: string }>;
        const bridge = bridges.find((b) => b.name === state.preset.presetId);
        if (bridge) {
          const result = (await api.apiBridges.test(bridge.id)) as { ok: boolean };
          state.testOk = result.ok;
          return;
        }
      }
      // Quick connectivity test with fetch
      const res = await fetch(state.baseUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      state.testOk = res ? res.status < 500 : false;
    } catch {
      state.testOk = false;
    } finally {
      state.testing = false;
    }
  }

  async function saveSelected() {
    let configured = 0;
    for (const state of presetStates) {
      if (!state.selected || state.saved) continue;
      if (!state.apiKey && state.preset.authType !== "none") {
        state.error = "API key required";
        continue;
      }
      state.saving = true;
      state.error = "";
      try {
        await api.apiBridges.create({
          name: state.preset.presetId,
          displayName: state.preset.displayName,
          type: "preset",
          presetId: state.preset.presetId,
          baseUrl: state.baseUrl,
          authType: state.preset.authType ?? "bearer",
          apiKey: state.apiKey || undefined,
          enabled: true,
        });
        state.saved = true;
        configured++;
      } catch (err: any) {
        state.error = err.message ?? String(err);
      } finally {
        state.saving = false;
      }
    }
    wizard.apiBridgesConfigured = configured;
  }

  let selectedCount = $derived(presetStates.filter((s) => s.selected && !s.saved).length);
  let anyUnsaved = $derived(selectedCount > 0);
</script>

<h2>API Bridges</h2>
<p class="subtitle">
  Connect external APIs for 3D generation, image processing, and more.
  These run server-side — no plugin installation needed.
</p>

{#if loading}
  <div class="loading">Loading available integrations...</div>
{:else if loadError}
  <div class="error">{loadError}</div>
{:else}
  <div class="preset-list">
    {#each presetStates as state}
      <div class="preset-card" class:selected={state.selected || state.saved} class:saved={state.saved}>
        <div class="preset-header">
          <label class="preset-check">
            <input
              type="checkbox"
              bind:checked={state.selected}
              disabled={state.saved}
            />
            <div class="preset-title">
              <span class="preset-name">{state.preset.displayName}</span>
              {#if state.saved}
                <span class="badge saved">Configured</span>
              {/if}
            </div>
          </label>
        </div>

        {#if state.preset.description}
          <div class="preset-desc">{state.preset.description}</div>
        {/if}
        {#if state.preset.actions.length > 0}
          <div class="preset-actions-list">
            {#each state.preset.actions as action}
              <span class="action-tag">{action.name}</span>
            {/each}
          </div>
        {/if}

        {#if (state.selected || state.saved) && !state.saved}
          <div class="preset-config">
            {#if state.preset.authType !== "none"}
              <label class="config-field">
                <span>API Key</span>
                <input
                  type="password"
                  bind:value={state.apiKey}
                  placeholder="Enter your API key"
                />
              </label>
            {/if}
            <label class="config-field">
              <span>Base URL</span>
              <input bind:value={state.baseUrl} />
            </label>
            {#if state.error}
              <div class="field-error">{state.error}</div>
            {/if}
          </div>
        {/if}

        {#if state.saved}
          <div class="preset-config">
            <div class="saved-info">
              <span class="saved-url">{state.baseUrl}</span>
              <button class="btn-test" onclick={() => testPreset(state)} disabled={state.testing}>
                {#if state.testing}
                  Testing...
                {:else if state.testOk === true}
                  Connected
                {:else if state.testOk === false}
                  Failed
                {:else}
                  Test
                {/if}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if anyUnsaved}
    <button class="btn-save" onclick={saveSelected}>
      Configure {selectedCount} API Bridge{selectedCount === 1 ? "" : "s"}
    </button>
  {:else}
    <p class="hint">Select an integration above, or click Next to skip this step. You can always configure API bridges later in Settings.</p>
  {/if}
{/if}

<style>
  h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 16px;
    line-height: 1.5;
  }
  .loading, .error {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
    padding: 20px;
  }
  .error { color: var(--status-failed); }

  .preset-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    max-height: 400px;
    overflow-y: auto;
  }

  .preset-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    background: var(--bg-surface);
    transition: border-color 0.15s;
  }
  .preset-card.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
  }
  .preset-card.saved {
    border-color: var(--status-completed);
    background: color-mix(in srgb, var(--status-completed) 5%, var(--bg-surface));
  }

  .preset-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .preset-check {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    width: 100%;
  }
  .preset-check input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }
  .preset-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .preset-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .badge.saved {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
    font-weight: 600;
  }

  .preset-desc {
    font-size: 11px;
    color: var(--text-secondary);
    padding-left: 24px;
    margin-top: 4px;
    line-height: 1.3;
  }
  .preset-actions-list {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 6px;
    padding-left: 24px;
  }
  .action-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .preset-config {
    margin-top: 10px;
    padding-left: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .config-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .config-field input {
    padding: 5px 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .field-error {
    font-size: 11px;
    color: var(--status-failed);
  }

  .saved-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .saved-url {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .btn-test {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .btn-test:hover {
    background: var(--bg-hover);
  }

  .btn-save {
    padding: 8px 20px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    width: 100%;
  }
  .btn-save:hover {
    filter: brightness(1.08);
  }

  .hint {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    margin: 0;
  }
</style>
