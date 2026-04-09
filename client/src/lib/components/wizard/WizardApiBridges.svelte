<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
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

  // ─── ComfyUI per-machine setup ──────────────────────────────────────

  interface DetectedComfyPath {
    path: string;
    label: string;
    hasMainPy: boolean;
  }

  let comfyShowSetup = $state(false);
  let comfyDetectedPaths = $state<DetectedComfyPath[]>([]);
  let comfyDetecting = $state(false);
  let comfySelectedPath = $state("");
  let comfyCustomPath = $state("");
  let comfySavedPath = $state<string | null>(null);

  let comfyUrl = $state("");
  let comfyUrlSource = $state<"setting" | "env" | "default">("default");
  let comfyUrlEffective = $state("http://127.0.0.1:8188");

  let comfyTesting = $state(false);
  let comfyTestResult = $state<{ reachable: boolean; latencyMs: number; error?: string } | null>(null);

  let comfyRunning = $state(false);
  let comfyLaunching = $state(false);
  let comfyAutoStart = $state(false);
  let comfySaving = $state(false);
  let comfyNodesInstalled = $state<boolean | null>(null);

  let comfyError = $state("");
  let comfySuccess = $state("");

  async function loadComfyConfig() {
    try {
      const [urlConfig, pathConfig, autoConfig] = await Promise.all([
        api.settings.getComfyuiUrl(),
        api.settings.getComfyuiPath(),
        invoke<{ autoStart: boolean; comfyuiPath: string }>("get_comfyui_autostart"),
      ]);
      comfyUrl = urlConfig.effectiveUrl;
      comfyUrlSource = urlConfig.source;
      comfyUrlEffective = urlConfig.effectiveUrl;
      comfySavedPath = pathConfig.path;
      comfyAutoStart = autoConfig.autoStart;
      if (pathConfig.path) comfySelectedPath = pathConfig.path;
      comfyRunning = await invoke<boolean>("is_comfyui_running");
      if (pathConfig.path) {
        const nodes = await invoke<{ installed: boolean }>("check_comfyui_nodes", { comfyuiPath: pathConfig.path });
        comfyNodesInstalled = nodes.installed;
      }
    } catch (e: any) {
      console.warn("[comfyui] Failed to load config:", e);
    }
  }

  async function comfyDetect() {
    comfyDetecting = true;
    comfyDetectedPaths = [];
    try {
      comfyDetectedPaths = await invoke<DetectedComfyPath[]>("detect_comfyui_paths");
      if (comfyDetectedPaths.length > 0 && !comfySelectedPath) {
        comfySelectedPath = comfyDetectedPaths[0].path;
      }
    } catch (e: any) {
      comfyError = e?.toString() ?? "Detection failed";
    }
    comfyDetecting = false;
  }

  async function comfyBrowse() {
    const folder = await open({ directory: true, title: "Select ComfyUI directory" });
    if (folder) {
      comfyCustomPath = folder as string;
      comfySelectedPath = "";
    }
  }

  async function comfySaveConfig() {
    comfySaving = true;
    comfyError = "";
    comfySuccess = "";
    try {
      const path = comfySelectedPath || comfyCustomPath || comfySavedPath || null;
      const urlToSave = comfyUrl !== comfyUrlEffective || comfyUrlSource === "default" ? comfyUrl : null;
      await api.settings.setComfyuiUrl(urlToSave === "http://127.0.0.1:8188" ? null : urlToSave);
      if (path) {
        await api.settings.setComfyuiPath(path);
        comfySavedPath = path;
        try {
          const nodes = await invoke<{ installed: boolean }>("check_comfyui_nodes", { comfyuiPath: path });
          comfyNodesInstalled = nodes.installed;
        } catch { comfyNodesInstalled = false; }
      }
      try {
        await invoke("set_comfyui_autostart", { autoStart: comfyAutoStart, comfyuiPath: path ?? "" });
      } catch { /* non-critical */ }
      comfySuccess = "Configuration saved";
      const urlConfig = await api.settings.getComfyuiUrl();
      comfyUrlSource = urlConfig.source;
      comfyUrlEffective = urlConfig.effectiveUrl;
    } catch (e: any) {
      comfyError = e?.toString() ?? "Save failed";
    }
    comfySaving = false;
  }

  async function comfyTestConnection() {
    comfyTesting = true;
    comfyTestResult = null;
    try {
      comfyTestResult = await api.settings.testComfyuiUrl();
    } catch (e: any) {
      comfyTestResult = { reachable: false, latencyMs: 0, error: e?.toString() ?? "Test failed" };
    }
    comfyTesting = false;
  }

  async function comfyStart() {
    comfyLaunching = true;
    comfyError = "";
    comfyTestResult = null;
    try {
      const path = comfySavedPath || comfySelectedPath || comfyCustomPath;
      if (!path) throw new Error("No ComfyUI path configured");
      const msg = await invoke<string>("launch_comfyui", { comfyuiPath: path, extraArgs: [] as string[] });
      comfySuccess = msg;
      comfyRunning = true;
      setTimeout(() => comfyTestConnection(), 5000);
      setTimeout(() => comfyTestConnection(), 15000);
    } catch (e: any) {
      comfyError = e?.toString() ?? "Launch failed";
    }
    comfyLaunching = false;
  }

  async function comfyStop() {
    comfyError = "";
    try {
      const msg = await invoke<string>("stop_comfyui");
      comfySuccess = msg;
      comfyRunning = false;
    } catch (e: any) {
      comfyError = e?.toString() ?? "Stop failed";
    }
  }

  async function comfyToggleSetup() {
    comfyShowSetup = !comfyShowSetup;
    if (comfyShowSetup) {
      await loadComfyConfig();
    }
  }
</script>

<h2>API Bridges</h2>
<p class="subtitle">
  Connect external APIs for 3D generation, image processing, and more.
  These run server-side — no plugin installation needed.
</p>
<p class="settings-hint">You can always configure API bridges later in Settings.</p>

{#if loading}
  <div class="loading">Loading available integrations...</div>
{:else if loadError}
  <div class="error">{loadError}</div>
{:else}
  <div class="preset-list">
    <!-- ComfyUI per-machine service -->
    <div class="preset-card" class:selected={comfyShowSetup || !!comfySavedPath} class:saved={!!comfySavedPath}>
      <div class="preset-header">
        <label class="preset-check">
          <input
            type="checkbox"
            checked={comfyShowSetup || !!comfySavedPath}
            disabled={!!comfySavedPath}
            onchange={() => comfyToggleSetup()}
          />
          <div class="preset-title">
            <span class="preset-name">ComfyUI</span>
            {#if comfySavedPath}
              <span class="badge saved">Configured</span>
            {:else if comfyRunning}
              <span class="badge saved">Running</span>
            {/if}
          </div>
        </label>
      </div>

      <div class="preset-desc">Local image generation service. Runs per-machine with auto-start support.</div>

      {#if comfyShowSetup && !comfySavedPath}
        <div class="preset-config">
          <div class="comfy-row">
            <button class="comfy-btn" onclick={comfyDetect} disabled={comfyDetecting}>
              {comfyDetecting ? "Detecting..." : "Detect"}
            </button>
            <button class="comfy-btn" onclick={comfyBrowse}>Browse...</button>
          </div>
          {#if comfyCustomPath}
            <div class="comfy-path"><code>{comfyCustomPath}</code></div>
          {/if}
          {#if comfyDetectedPaths.length > 0}
            {#each comfyDetectedPaths as dp}
              <label class="comfy-radio">
                <input type="radio" name="comfy-path" value={dp.path} bind:group={comfySelectedPath} />
                <span>{dp.path}</span>
                {#if dp.hasMainPy}
                  <span class="badge saved">main.py</span>
                {/if}
              </label>
            {/each}
          {/if}
          <label class="config-field">
            <span>Server URL</span>
            <input bind:value={comfyUrl} placeholder="http://127.0.0.1:8188" />
          </label>
          <label class="comfy-radio">
            <input type="checkbox" bind:checked={comfyAutoStart} />
            <span>Start ComfyUI when Arkestrator launches</span>
          </label>
          {#if comfyError}
            <div class="field-error">{comfyError}</div>
          {/if}
          {#if comfySuccess}
            <div class="comfy-path">{comfySuccess}</div>
          {/if}
          <button class="comfy-btn" onclick={comfySaveConfig} disabled={comfySaving || (!comfySelectedPath && !comfyCustomPath)}>
            {comfySaving ? "Saving..." : "Save Configuration"}
          </button>
        </div>
      {/if}

      {#if comfySavedPath}
        <div class="preset-config">
          <div class="saved-info">
            <span class="saved-url">{comfySavedPath}</span>
            <button class="btn-test" onclick={comfyTestConnection} disabled={comfyTesting}>
              {#if comfyTesting}
                Testing...
              {:else if comfyTestResult?.reachable}
                Connected
              {:else if comfyTestResult && !comfyTestResult.reachable}
                Failed
              {:else}
                Test
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>

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
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .settings-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin: 0 0 16px;
    font-style: italic;
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

  /* ComfyUI */
  .comfy-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
  }
  .comfy-btn {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .comfy-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .comfy-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .comfy-path {
    font-size: 11px;
    color: var(--text-secondary);
    margin: 4px 0;
  }
  .comfy-radio {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    margin: 2px 0;
  }
  .comfy-radio input {
    margin: 0;
  }
</style>
