<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { clientCoordination } from "../../stores/clientCoordination.svelte";
  import { connect, disconnect } from "../../api/ws";
  import { api, type LocalModelCatalogEntry, type LocalModelsResponse } from "../../api/rest";
  import { nav } from "../../stores/navigation.svelte";
  import { invoke } from "@tauri-apps/api/core";

  let clientCoordSaving = $state(false);
  let clientCoordError = $state("");
  let localModelsLoading = $state(false);
  let localModelsLoaded = $state(false);
  let localModelsError = $state("");
  let localModelsResult = $state("");
  let localRuntime = $state<"ollama">("ollama");
  let localRuntimeSource = $state<"server" | "client">("client");
  let localCatalog = $state<LocalModelCatalogEntry[]>([]);
  let localModelSourceLabel = $state("Client");
  let selectedCatalogModel = $state("");
  let pullModelName = $state("");
  let pullingLocalModel = $state(false);
  let pullProgressLabel = $state("");
  let pullProgressPercent = $state<number | null>(null);
  let serverLocalLlmBaseUrlDraft = $state("");
  let serverLocalLlmEffectiveBaseUrl = $state("http://127.0.0.1:11434");
  let serverLocalLlmSource = $state<"setting" | "env" | "default">("default");
  let serverLocalLlmSaving = $state(false);
  let serverLocalLlmLoaded = $state(false);
  let allowlistDirty = $state(false);
  let allowlistSaving = $state(false);
  let clientOllamaUrlDraft = $state(clientCoordination.ollamaBaseUrl);
  let defaultChatModelDraft = $state(clientCoordination.defaultChatModel);
  let defaultJobModelDraft = $state(clientCoordination.defaultJobModel);

  $effect(() => {
    if (connection.isAuthenticated && connection.allowClientCoordination) {
      clientCoordination.probeIfStale();
    }
  });

  $effect(() => {
    if (
      connection.isAuthenticated
      && connection.userRole === "admin"
      && !serverLocalLlmLoaded
    ) {
      void loadServerLocalLlmSettings();
    }
  });

  let availableLocalModels = $derived(
    localCatalog.filter((m: any) => m.allowed && m.downloaded)
  );

  function capabilitySummary(): string {
    if (!clientCoordination.capability) return "Not checked yet";
    const c = clientCoordination.capability;
    const parts = [
      c.cpuCores != null ? `${c.cpuCores} CPU cores` : "CPU unknown",
      c.memoryGb != null ? `${c.memoryGb}GB RAM` : "RAM unknown",
      c.localModelCount > 0 ? `${c.localModelCount} local model(s)` : "No local models",
    ];
    return parts.join(" \u2022 ");
  }

  async function reprobeClientCapability() {
    clientCoordError = "";
    try {
      await clientCoordination.probe();
    } catch (err: any) {
      clientCoordError = `Capability probe failed: ${err.message ?? err}`;
    }
  }

  async function setClientCoordination(enabled: boolean) {
    clientCoordError = "";
    if (enabled && !connection.allowClientCoordination) {
      clientCoordError = "Disabled by admin policy";
      return;
    }

    if (
      enabled
      && !clientCoordination.probing
      && (clientCoordination.isProbeStale() || !clientCoordination.capability)
    ) {
      try {
        await clientCoordination.probe();
      } catch (err: any) {
        clientCoordError = `Capability probe failed: ${err.message ?? err}`;
        return;
      }
    }

    if (enabled && !clientCoordination.isCapable) {
      clientCoordError = "This machine does not currently meet local AI requirements";
      return;
    }

    clientCoordSaving = true;
    try {
      const result = await api.auth.setClientCoordination(
        enabled,
        clientCoordination.capability ?? undefined,
      );
      connection.allowClientCoordination = !!result.allowClientCoordination;
      connection.clientCoordinationEnabled = !!result.clientCoordinationEnabled;
      connection.canEditCoordinator = !!result.canEditCoordinator;
      connection.saveSession();
    } catch (err: any) {
      clientCoordError = err.message ?? String(err);
    } finally {
      clientCoordSaving = false;
    }
  }

  async function loadLocalModels() {
    localModelsLoading = true;
    localModelsError = "";
    localModelsResult = "";
    try {
      if (localRuntimeSource === "client") {
        const payload = await clientCoordination.listLocalOllamaModels();
        const models = Array.isArray(payload.models) ? payload.models : [];
        localCatalog = models.map((model) => ({
          name: model.name,
          sizeBytes: model.sizeBytes,
          modifiedAt: model.modifiedAt,
          digest: model.digest,
          downloaded: true,
          allowed: true,
          recommended: false,
        }));
        if (localCatalog.length === 0) {
          selectedCatalogModel = "";
        } else if (!localCatalog.some((model) => model.name === selectedCatalogModel)) {
          selectedCatalogModel = localCatalog[0]?.name ?? "";
        }
        localModelSourceLabel = "Client (This Desktop)";
        serverLocalLlmEffectiveBaseUrl = "http://127.0.0.1:11434";
        serverLocalLlmSource = "default";
        return;
      }

      const result = await api.agents.localModels(localRuntime);
      const payload = result as LocalModelsResponse;
      localCatalog = Array.isArray(payload.catalog) ? payload.catalog : [];
      if (localCatalog.length === 0) {
        selectedCatalogModel = "";
      } else if (!localCatalog.some((model) => model.name === selectedCatalogModel)) {
        selectedCatalogModel = localCatalog[0]?.name ?? "";
      }
      localModelSourceLabel = payload.targetWorkerName
        ? `Worker: ${payload.targetWorkerName}`
        : (payload.source === "worker" ? "Worker" : "Server");
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
      localCatalog = [];
    } finally {
      localModelsLoading = false;
      localModelsLoaded = true;
    }
  }

  async function loadServerLocalLlmSettings() {
    if (connection.userRole !== "admin") return;
    try {
      const cfg = await api.settings.getServerLocalLlm();
      serverLocalLlmBaseUrlDraft = cfg.baseUrl ?? "";
      serverLocalLlmEffectiveBaseUrl = cfg.effectiveBaseUrl;
      serverLocalLlmSource = cfg.source;
      serverLocalLlmLoaded = true;
    } catch {
      // keep local defaults; non-fatal for non-security users.
    }
  }

  async function saveServerLocalLlmSettings() {
    if (connection.userRole !== "admin") return;
    serverLocalLlmSaving = true;
    localModelsError = "";
    localModelsResult = "";
    try {
      const next = await api.settings.setServerLocalLlm(serverLocalLlmBaseUrlDraft.trim() || null);
      serverLocalLlmBaseUrlDraft = next.baseUrl ?? "";
      serverLocalLlmEffectiveBaseUrl = next.effectiveBaseUrl;
      serverLocalLlmSource = next.source;
      serverLocalLlmLoaded = true;
      localModelsResult = `Server local runtime endpoint set to ${next.effectiveBaseUrl} (${next.source}).`;
      await loadLocalModels();
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
    } finally {
      serverLocalLlmSaving = false;
    }
  }

  function saveClientOllamaUrl() {
    clientCoordination.setOllamaBaseUrl(clientOllamaUrlDraft);
    serverLocalLlmEffectiveBaseUrl = clientCoordination.ollamaBaseUrl;
    void loadLocalModels();
  }

  async function pullLocalModelFromSettings() {
    const model = pullModelName.trim();
    if (!model) {
      localModelsError = "Enter a model name first (for example: qwen2.5-coder:14b).";
      return;
    }
    pullingLocalModel = true;
    localModelsError = "";
    localModelsResult = "";
    pullProgressLabel = "Starting download...";
    pullProgressPercent = null;
    try {
      if (localRuntimeSource === "client") {
        pullProgressLabel = "Downloading on this desktop...";
        await invoke<string>("pull_local_ollama_model", { model });
        pullProgressPercent = 100;
        localModelsResult = `Downloaded locally: ${model}`;
        pullModelName = "";
        await loadLocalModels();
        return;
      }

      await api.agents.pullLocalModelStream(
        model,
        (event) => {
          pullProgressLabel = event.status?.trim() || "Downloading...";
          pullProgressPercent = typeof event.progressPercent === "number"
            ? Math.max(0, Math.min(100, Math.round(event.progressPercent)))
            : pullProgressPercent;
        },
        localRuntime,
      );
      localModelsResult = `Downloaded: ${model}`;
      pullModelName = "";
      await loadLocalModels();
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
    } finally {
      pullingLocalModel = false;
    }
  }

  async function pullSelectedCatalogModelFromSettings() {
    if (!selectedCatalogModel.trim()) {
      localModelsError = "Select a model from the catalog first.";
      return;
    }
    pullModelName = selectedCatalogModel.trim();
    await pullLocalModelFromSettings();
  }

  function formatLocalCatalogOption(model: LocalModelCatalogEntry): string {
    const tags: string[] = [];
    if (model.downloaded) tags.push("downloaded");
    if (model.allowed) tags.push("allowed");
    if (model.recommended) tags.push("recommended");
    return tags.length > 0
      ? `${model.name} (${tags.join(", ")})`
      : model.name;
  }

  function toggleModelAllowed(modelName: string) {
    const idx = localCatalog.findIndex((m) => m.name === modelName);
    if (idx < 0) return;
    localCatalog[idx] = { ...localCatalog[idx], allowed: !localCatalog[idx].allowed };
    allowlistDirty = true;
  }

  async function saveModelAllowlist() {
    allowlistSaving = true;
    localModelsError = "";
    localModelsResult = "";
    try {
      const allowedModels = localCatalog
        .filter((m) => m.allowed)
        .map((m) => m.name);
      const result = await api.agents.setLocalModelAllowlist(allowedModels, localRuntime);
      const payload = result as LocalModelsResponse;
      localCatalog = Array.isArray(payload.catalog) ? payload.catalog : localCatalog;
      allowlistDirty = false;
      localModelsResult = `Model allowlist saved (${allowedModels.length} enabled).`;
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
    } finally {
      allowlistSaving = false;
    }
  }
</script>

<div class="pref-card">
  <div class="pref-card-header">Local LLM (Ollama)</div>
  <p class="desc">
    Use locally-running Ollama models for chat and jobs.
    Models are advertised to the server so other users can route work to this machine.
  </p>
  <div class="pref-toggles">
    <label class="toggle-label">
      <input
        type="checkbox"
        checked={connection.localLlmEnabled}
        onchange={async (e: Event) => {
          const enabled = (e.target as HTMLInputElement).checked;
          connection.localLlmEnabled = enabled;
          connection.saveSession();
          // Auto-enable client coordination when local LLM is on
          if (enabled && connection.allowClientCoordination && !connection.clientCoordinationEnabled) {
            await setClientCoordination(true);
          }
          if (connection.url && connection.apiKey) {
            disconnect();
            void connect(connection.url, connection.apiKey);
          }
        }}
      />
      <span>Enable local LLM (Ollama)</span>
    </label>
  </div>
  {#if connection.localLlmEnabled}
    <div class="hardware-info">
      <div class="result">{capabilitySummary()}</div>
      {#if clientCoordination.capability?.gpuRenderer}
        <div class="result">GPU: {clientCoordination.capability.gpuRenderer}</div>
      {/if}
      {#if clientCoordination.capability && !clientCoordination.isCapable && clientCoordination.capability.reasons.length > 0}
        <div class="error">{clientCoordination.capability.reasons.join("; ")}</div>
      {/if}
      {#if clientCoordError}
        <div class="error">{clientCoordError}</div>
      {/if}
      <button class="btn secondary" onclick={reprobeClientCapability} disabled={clientCoordination.probing} style="margin-top: 6px;">
        {clientCoordination.probing ? "Probing..." : "Re-check Hardware"}
      </button>
    </div>
  {/if}
</div>

{#if connection.localLlmEnabled}
<section>
  <h3>Local Models (Ollama)</h3>
  <p class="desc">
    Choose where model actions run for <code class="ic">local-oss</code>.
    <strong>Client (This Desktop)</strong> uses this machine's local Ollama directly.
  </p>
  <div class="local-model-toolbar">
    <label>
      Model source
      <select bind:value={localRuntimeSource} disabled={localModelsLoading || pullingLocalModel}>
        <option value="client">Client (This Desktop)</option>
        <option value="server">Server/Worker</option>
      </select>
    </label>
    <div class="btn-group">
      <button class="btn secondary" onclick={loadLocalModels} disabled={localModelsLoading}>
        {localModelsLoading ? "Loading..." : localModelsLoaded ? "Refresh" : "Load Models"}
      </button>
      {#if localRuntimeSource === "server"}
        <button class="btn secondary" onclick={() => (nav.current = "admin")}>
          Admin Agent Configs
        </button>
      {/if}
    </div>
    <div class="local-model-status">
      <span class="result">Source: {localModelSourceLabel}</span>
      <span class="result">Endpoint: <code class="ic">{serverLocalLlmEffectiveBaseUrl}</code></span>
      <span class="result">Via: {localRuntimeSource === "client" ? "desktop" : serverLocalLlmSource}</span>
    </div>
  </div>

  {#if localRuntimeSource === "server" && connection.userRole === "admin"}
    <div class="local-model-endpoint">
      <label>
        Server Ollama Base URL (optional override)
        <input
          bind:value={serverLocalLlmBaseUrlDraft}
          placeholder="http://127.0.0.1:11434"
          disabled={serverLocalLlmSaving}
        />
      </label>
      <button class="btn secondary" onclick={saveServerLocalLlmSettings} disabled={serverLocalLlmSaving}>
        {serverLocalLlmSaving ? "Saving..." : "Save Runtime Endpoint"}
      </button>
    </div>
  {/if}

  {#if localRuntimeSource === "client"}
    <div class="local-model-endpoint">
      <label>
        Ollama URL
        <input
          bind:value={clientOllamaUrlDraft}
          placeholder="http://127.0.0.1:11434"
        />
      </label>
      <button class="btn secondary" onclick={saveClientOllamaUrl}>
        Save
      </button>
    </div>
  {/if}

  {#if localModelsResult}
    <div class="result">{localModelsResult}</div>
  {/if}
  {#if localModelsError}
    <div class="error">{localModelsError}</div>
  {/if}

  <div class="local-model-controls">
    <div class="local-model-picker">
      <label>
        Download model
        <div class="model-download-row">
          <select
            bind:value={selectedCatalogModel}
            disabled={localModelsLoading || pullingLocalModel || localCatalog.length === 0}
            style="flex: 1;"
          >
            <option value="">
              {localCatalog.length === 0 ? "No models in catalog" : "Select from catalog..."}
            </option>
            {#each localCatalog as model}
              <option value={model.name}>{formatLocalCatalogOption(model)}</option>
            {/each}
          </select>
          <span class="desc" style="margin: 0; white-space: nowrap; align-self: center;">or</span>
          <input
            bind:value={pullModelName}
            placeholder="custom model name"
            disabled={pullingLocalModel}
            style="flex: 1;"
          />
        </div>
      </label>
      <button
        class="btn secondary"
        onclick={() => {
          if (pullModelName.trim()) {
            pullLocalModelFromSettings();
          } else {
            pullSelectedCatalogModelFromSettings();
          }
        }}
        disabled={pullingLocalModel || (!selectedCatalogModel.trim() && !pullModelName.trim())}
      >
        {pullingLocalModel ? "Pulling..." : "Download"}
      </button>
    </div>
  </div>

  {#if pullingLocalModel}
    <div class="result">
      {pullProgressLabel}
      {#if pullProgressPercent !== null} ({pullProgressPercent}%){/if}
    </div>
  {/if}
  <div class="local-model-list">
    <div class="model-list-header">
      <strong>Models ({localCatalog.length})</strong>
      {#if allowlistDirty}
        <button class="btn" onclick={saveModelAllowlist} disabled={allowlistSaving || connection.userRole !== "admin"}>
          {allowlistSaving ? "Saving..." : "Save Changes"}
        </button>
      {/if}
    </div>
    {#if localCatalog.length === 0}
      <div class="desc">No models detected from runtime.</div>
    {:else}
      <div class="model-list-grid">
        {#each localCatalog as model}
          <label class="model-list-item" class:disabled={!model.allowed}>
            <input
              type="checkbox"
              checked={model.allowed}
              onchange={() => toggleModelAllowed(model.name)}
              disabled={connection.userRole !== "admin"}
            />
            <code class="ic">{model.name}</code>
            {#if model.downloaded}<span class="model-tag ok">downloaded</span>{/if}
            {#if model.recommended}<span class="model-tag">recommended</span>{/if}
          </label>
        {/each}
      </div>
    {/if}
  </div>

  <div class="local-model-defaults">
    <strong>Default Model Preferences</strong>
    <p class="desc">
      Choose default models for chat and jobs. Can be overridden per-chat or per-job.
    </p>
    <div class="model-defaults-row">
      <label>
        Default chat model
        <select
          bind:value={defaultChatModelDraft}
          onchange={() => clientCoordination.setDefaultChatModel(defaultChatModelDraft)}
        >
          <option value="">Auto (smallest suitable)</option>
          {#each availableLocalModels as model}
            <option value={model.name}>{model.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Default job model
        <select
          bind:value={defaultJobModelDraft}
          onchange={() => clientCoordination.setDefaultJobModel(defaultJobModelDraft)}
        >
          <option value="">Auto (largest available)</option>
          {#each availableLocalModels as model}
            <option value={model.name}>{model.name}</option>
          {/each}
        </select>
      </label>
    </div>
  </div>
</section>
{/if}

<style>
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  h3 { font-size: var(--font-size-base); margin-bottom: 12px; color: var(--text-secondary); }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn.secondary {
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-group { display: flex; gap: 8px; }
  .result {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .ic {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-base);
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--border);
  }
  .pref-card {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
  }
  .pref-card-header {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 8px;
  }
  .pref-toggles {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
    justify-content: flex-start;
  }
  .toggle-label input[type="checkbox"] {
    margin: 0;
    flex-shrink: 0;
  }
  .hardware-info {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .local-model-toolbar {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .local-model-toolbar label {
    margin: 0;
  }
  .local-model-status {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    width: 100%;
    margin-top: 2px;
  }
  .local-model-endpoint {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    margin: 8px 0 10px;
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .local-model-endpoint label {
    margin: 0;
    flex: 1 1 320px;
  }
  .local-model-controls {
    margin-top: 10px;
  }
  .local-model-controls .local-model-picker {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
  }
  .local-model-picker {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .model-download-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .local-model-list {
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    background: var(--bg-soft);
  }
  .model-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .model-list-grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .model-list-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .model-list-item:hover {
    background: var(--bg-hover);
  }
  .model-list-item.disabled {
    opacity: 0.5;
  }
  .model-list-item input[type="checkbox"] {
    margin: 0;
    flex-shrink: 0;
  }
  .model-tag {
    font-size: 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    color: var(--text-secondary);
  }
  .model-tag.ok {
    border-color: color-mix(in oklab, var(--success, #32d48e) 60%, var(--border));
    color: var(--success, #32d48e);
  }
  .local-model-defaults {
    margin-top: 12px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.02);
  }
  .model-defaults-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .model-defaults-row label {
    flex: 1;
    min-width: 200px;
  }
  @media (max-width: 1100px) {
    .model-download-row {
      flex-direction: column;
    }
  }
</style>
