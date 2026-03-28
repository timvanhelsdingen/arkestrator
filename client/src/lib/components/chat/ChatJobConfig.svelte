<script lang="ts">
  import type {
    JobRuntimeOptions,
    RuntimeReasoningLevel,
    RuntimeVerificationMode,
  } from "@arkestrator/protocol";
  import type { BridgeExecutionMode } from "@arkestrator/protocol";
  import { chatStore } from "../../stores/chat.svelte";
  import { agents } from "../../stores/agents.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { clientCoordination } from "../../stores/clientCoordination.svelte";
  import {
    api,
    type LocalModelCatalogEntry,
    type ProviderModelCatalog,
  } from "../../api/rest";

  const JOB_PRESETS = [
    {
      name: "Quick Draft",
      icon: "\u26A1",
      description: "No verification, fast execution",
      options: { verificationMode: "disabled" as const, bridgeExecutionMode: "live" as BridgeExecutionMode },
    },
    {
      name: "Verified",
      icon: "\u2705",
      description: "Required verification, weight 80",
      options: { verificationMode: "required" as const, verificationWeight: 80, bridgeExecutionMode: "live" as BridgeExecutionMode },
    },
    {
      name: "Strict",
      icon: "\uD83D\uDD12",
      description: "Required verification, weight 99",
      options: { verificationMode: "required" as const, verificationWeight: 99, bridgeExecutionMode: "live" as BridgeExecutionMode },
    },
  ];

  let activePreset = $state("");

  let coordinationEnabled = $derived.by(() => {
    const cs = chatStore.activeTab?.runtimeOptions?.coordinationScripts;
    if (!cs) return true; // default: enabled
    return cs.coordinator !== "disabled" || cs.bridge !== "disabled" || cs.training !== "disabled";
  });

  function toggleCoordination() {
    if (coordinationEnabled) {
      // Disable all coordination scripts
      chatStore.setCoordinationScripts({ coordinator: "disabled", bridge: "disabled", training: "disabled" });
    } else {
      // Re-enable (remove override = use defaults)
      chatStore.setCoordinationScripts(undefined);
    }
  }

  let localModelCatalog = $state<LocalModelCatalogEntry[]>([]);
  let providerModelCatalogs = $state<Record<string, ProviderModelCatalog>>({});
  let localModelsLoadedKey = $state("");
  let providerCatalogsLoadedKey = $state("");
  let localModelsLoading = $state(false);
  let agentConfigId = $derived(chatStore.activeTab?.agentConfigId ?? "");
  let runtimeOptions = $derived(chatStore.activeTab?.runtimeOptions);

  let selectedAgent = $derived(
    agents.all.find((config) => config.id === agentConfigId),
  );
  let selectedEngine = $derived(selectedAgent?.engine ?? "");
  let showModelControl = $derived(selectedEngine !== "");

  let knownModelOptions = $derived.by(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (value: unknown) => {
      const normalized = String(value ?? "").trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      ordered.push(normalized);
    };

    const providerCatalog = providerModelCatalogs[selectedEngine];

    add(providerCatalog?.preferredDefaultModel);

    for (const preset of providerCatalog?.models ?? []) {
      add(preset);
    }

    for (const config of agents.all) {
      if (selectedEngine && config.engine !== selectedEngine) continue;
      const value = String(config.model ?? "").trim();
      if (!value) continue;
      if (selectedEngine === "local-oss" && localModelCatalog.length > 0) {
        const match = localModelCatalog.find((model) => model.name === value);
        if (match && (!match.allowed || !match.downloaded)) continue;
      }
      add(value);
    }

    if (selectedEngine === "local-oss") {
      add("auto");
      const allowedDownloaded = localModelCatalog.filter((model) => model.allowed && model.downloaded);
      for (const model of allowedDownloaded) {
        add(model.name);
      }
    }

    return ordered;
  });

  let defaultModelLabel = $derived.by(() => {
    const configured = String(selectedAgent?.model ?? "").trim();
    if (configured) return configured;
    const preferred = String(providerModelCatalogs[selectedEngine]?.preferredDefaultModel ?? "").trim();
    if (preferred) return preferred;
    return "Default";
  });

  let knownReasoningLevels = $derived.by(() => {
    if (selectedEngine !== "codex") return ["low", "medium", "high", "xhigh"];
    const levels = providerModelCatalogs.codex?.reasoningLevels ?? ["low", "medium", "high", "xhigh"];
    return levels.length > 0 ? levels : ["low", "medium", "high", "xhigh"];
  });

  // --- Load keys ---

  function getLocalModelsLoadKey(): string {
    const authKey = connection.sessionToken
      ? `session:${connection.sessionToken.slice(0, 12)}`
      : (connection.apiKey ? `apikey:${connection.apiKey.slice(0, 12)}` : "anonymous");
    const localMode = connection.allowClientCoordination && connection.clientCoordinationEnabled ? "client-local" : "server-runtime";
    const modelHost = selectedAgent?.localModelHost ?? "client";
    return `${connection.url}|${authKey}|${selectedEngine}|${localMode}|${modelHost}`;
  }

  function getProviderCatalogsLoadKey(): string {
    const authKey = connection.sessionToken
      ? `session:${connection.sessionToken.slice(0, 12)}`
      : (connection.apiKey ? `apikey:${connection.apiKey.slice(0, 12)}` : "anonymous");
    return `${connection.url}|${authKey}`;
  }

  // --- Loaders ---

  async function loadLocalModels(loadKey: string) {
    if (localModelsLoading) return;
    localModelsLoading = true;
    try {
      if (connection.allowClientCoordination && connection.clientCoordinationEnabled) {
        const local = await clientCoordination.listLocalOllamaModels();
        localModelCatalog = local.models.map((model) => ({
          name: model.name,
          sizeBytes: model.sizeBytes,
          modifiedAt: model.modifiedAt,
          digest: model.digest,
          allowed: true,
          downloaded: true,
          recommended: false,
        }));
        localModelsLoadedKey = loadKey;
        return;
      }

      const effectiveHost = selectedAgent?.localModelHost ?? "client";
      const payload = await api.agents.localModels("ollama", undefined, effectiveHost);
      const models = Array.isArray((payload as any)?.models) ? (payload as any).models : [];
      const allowed = Array.isArray((payload as any)?.allowedModels)
        ? [...new Set((payload as any).allowedModels.map((value: unknown) => String(value ?? "").trim()).filter(Boolean))]
        : [];
      const catalog = Array.isArray((payload as any)?.catalog) ? (payload as any).catalog : [];

      localModelCatalog = catalog.length > 0
        ? catalog
        : models.map((model: any) => ({
          ...model,
          allowed: allowed.includes(String(model?.name ?? "").trim()),
          downloaded: true,
          recommended: false,
        }));
      localModelsLoadedKey = loadKey;
    } catch {
      localModelCatalog = [];
      localModelsLoadedKey = loadKey;
    } finally {
      localModelsLoading = false;
    }
  }

  async function loadProviderCatalogs(loadKey: string) {
    try {
      const payload = await api.agents.modelCatalogs();
      providerModelCatalogs = payload?.catalogs ?? {};
    } catch {
      providerModelCatalogs = {};
    } finally {
      providerCatalogsLoadedKey = loadKey;
    }
  }

  // --- Effects ---

  $effect(() => {
    if (!connection.isConnected) return;
    if (!connection.sessionToken && !connection.apiKey) return;

    const loadKey = getProviderCatalogsLoadKey();
    if (providerCatalogsLoadedKey === loadKey) return;

    void loadProviderCatalogs(loadKey);
  });

  $effect(() => {
    if (selectedEngine !== "local-oss") return;
    if (!connection.isConnected) return;
    if (!connection.sessionToken && !connection.apiKey) return;

    const loadKey = getLocalModelsLoadKey();
    if (localModelsLoadedKey === loadKey) return;
    if (localModelsLoading) return;

    void loadLocalModels(loadKey);
  });

  $effect(() => {
    if (selectedEngine === "local-oss") return;
    localModelsLoadedKey = "";
  });

  let prevEngine = $state("");
  $effect(() => {
    if (selectedEngine !== prevEngine) {
      prevEngine = selectedEngine;
      if (runtimeOptions?.model) {
        chatStore.setRuntimeModel(undefined);
      }
    }
  });

  // --- Update functions ---

  function updateRuntimeModel(value: string) {
    chatStore.setRuntimeModel(value);
  }

  function updateRuntimeReasoningLevel(value: string) {
    const next = value
      ? (value as RuntimeReasoningLevel)
      : undefined;
    chatStore.setRuntimeReasoningLevel(next);
  }

  function updateRuntimeVerificationMode(value: string) {
    const next = value
      ? (value as RuntimeVerificationMode)
      : undefined;
    chatStore.setRuntimeVerificationMode(next);
  }

  function updateRuntimeVerificationWeight(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      chatStore.setRuntimeVerificationWeight(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    chatStore.setRuntimeVerificationWeight(parsed);
  }

  async function refreshLocalModelCatalog() {
    if (selectedEngine !== "local-oss") return;
    if (!connection.isConnected) return;
    if (!connection.sessionToken && !connection.apiKey) return;
    const key = getLocalModelsLoadKey();
    localModelsLoadedKey = "";
    await loadLocalModels(key);
  }

  function reasoningLabel(value: string): string {
    if (value === "xhigh") return "Extreme";
    if (!value) return "Default";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }


</script>

<div class="job-config">
  <div class="config-header">
    <strong>Job Settings</strong>
  </div>
  <div class="config-content">
    <!-- Presets -->
    <div class="preset-row">
      {#each JOB_PRESETS as preset (preset.name)}
        <button
          class="preset-chip"
          class:active={activePreset === preset.name}
          title={preset.description}
          onclick={() => {
            activePreset = activePreset === preset.name ? "" : preset.name;
            chatStore.applyPreset(preset.options);
          }}
        >
          {preset.icon} {preset.name}
        </button>
      {/each}
    </div>

    <!-- Agent -->
    <div class="config-row">
      <label for="jc-agent-select">Agent</label>
      <select
        id="jc-agent-select"
        value={agentConfigId}
        onchange={(e) => chatStore.setAgentConfig((e.target as HTMLSelectElement).value)}
      >
        <option value="" disabled>Select agent...</option>
        <option value="auto">Auto (priority)</option>
        {#each agents.all as config (config.id)}
          <option value={config.id}>{config.name} ({config.engine})</option>
        {/each}
      </select>
    </div>

    <!-- Model (conditional) -->
    {#if showModelControl}
      <div class="config-row">
        <label for="jc-model-override">Model</label>
        <div class="model-input-row">
          {#if (providerModelCatalogs[selectedEngine]?.models?.length ?? 0) > 0 && selectedEngine !== "codex"}
            <select
              id="jc-model-override"
              value={runtimeOptions?.model ?? ""}
              disabled={!agentConfigId}
              onchange={(e) => updateRuntimeModel((e.target as HTMLSelectElement).value)}
            >
              <option value="">{defaultModelLabel}</option>
              {#each knownModelOptions as modelName (modelName)}
                <option value={modelName}>{modelName}</option>
              {/each}
            </select>
          {:else}
            <input
              id="jc-model-override"
              type="text"
              list="jc-model-options"
              value={runtimeOptions?.model ?? ""}
              disabled={!agentConfigId}
              placeholder={defaultModelLabel}
              oninput={(e) => updateRuntimeModel((e.target as HTMLInputElement).value)}
              onchange={(e) => updateRuntimeModel((e.target as HTMLInputElement).value)}
            />
            {#if selectedEngine === "local-oss"}
              <button
                type="button"
                class="model-refresh-btn icon-only"
                onclick={refreshLocalModelCatalog}
                disabled={!agentConfigId || localModelsLoading || !connection.isConnected || (!connection.sessionToken && !connection.apiKey)}
                title={localModelsLoading ? "Refreshing local models..." : "Refresh local models"}
                aria-label={localModelsLoading ? "Refreshing local models" : "Refresh local models"}
              >
                {localModelsLoading ? "\u2026" : "\u21BB"}
              </button>
            {/if}
            <datalist id="jc-model-options">
              {#each knownModelOptions as modelName (modelName)}
                <option value={modelName}></option>
              {/each}
            </datalist>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Reasoning (conditional on codex) -->
    {#if selectedEngine === "codex"}
      <div class="config-row">
        <label for="jc-reasoning-select">Reasoning</label>
        <select
          id="jc-reasoning-select"
          value={runtimeOptions?.reasoningLevel ?? ""}
          onchange={(e) => updateRuntimeReasoningLevel((e.target as HTMLSelectElement).value)}
        >
          <option value="">Default</option>
          {#each knownReasoningLevels as level (level)}
            <option value={level}>{reasoningLabel(level)}</option>
          {/each}
        </select>
      </div>
    {/if}

    <!-- Verify -->
    <div class="config-row">
      <label for="jc-verification-mode-select">Verify</label>
      <select
        id="jc-verification-mode-select"
        value={runtimeOptions?.verificationMode ?? ""}
        onchange={(e) => updateRuntimeVerificationMode((e.target as HTMLSelectElement).value)}
      >
        <option value="">Default</option>
        <option value="required">Required</option>
        <option value="optional">Optional</option>
        <option value="disabled">Disabled</option>
      </select>
    </div>

    <!-- V Weight -->
    <div class="config-row">
      <label for="jc-verification-weight-input">V Weight</label>
      <input
        id="jc-verification-weight-input"
        type="number"
        min="0"
        max="100"
        step="1"
        placeholder="Default"
        value={runtimeOptions?.verificationWeight ?? ""}
        onchange={(e) => updateRuntimeVerificationWeight((e.target as HTMLInputElement).value)}
      />
    </div>

    <!-- Coordination Scripts -->
    <div class="config-row config-row-inline">
      <span class="config-label-text">Coordination Scripts</span>
      <button
        class="coordination-toggle"
        class:on={coordinationEnabled}
        onclick={toggleCoordination}
        title="Include coordinator scripts, bridge skills, and training in job prompts"
      >
        {coordinationEnabled ? "On" : "Off"}
      </button>
    </div>

    <!-- Execution Mode -->
    <div class="config-row">
      <label for="jc-exec-mode">Execution Mode</label>
      <select
        id="jc-exec-mode"
        value={chatStore.activeTab?.runtimeOptions?.bridgeExecutionMode ?? ""}
        onchange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          chatStore.setBridgeExecutionMode(v === "live" || v === "headless" ? v : undefined);
        }}
      >
        <option value="">Auto</option>
        <option value="live">Live Bridge</option>
        <option value="headless">CLI / Headless</option>
      </select>
    </div>

    <!-- Timeout -->
    <div class="config-row">
      <label for="jc-timeout">Timeout (min)</label>
      <input
        id="jc-timeout"
        type="number"
        min="1"
        max="1440"
        placeholder="Default"
        value={chatStore.activeTab?.runtimeOptions?.timeoutMinutes ?? ""}
        oninput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          chatStore.setRuntimeTimeout(v ? Number(v) : undefined);
        }}
      />
    </div>

    <!-- Cleanup Temp Files -->
    <div class="config-row config-row-inline">
      <span class="config-label-text">Cleanup Temp Files</span>
      <button
        class="coordination-toggle"
        class:on={chatStore.activeTab?.runtimeOptions?.cleanupTempFiles === true}
        onclick={() => {
          const current = chatStore.activeTab?.runtimeOptions?.cleanupTempFiles === true;
          chatStore.setCleanupTempFiles(!current ? true : undefined);
        }}
        title="Delete _arkestrator/ temp folder after job completes"
      >
        {chatStore.activeTab?.runtimeOptions?.cleanupTempFiles ? "On" : "Off"}
      </button>
    </div>

    <!-- Name -->
    <div class="config-row">
      <label for="jc-job-name">Name</label>
      <input
        id="jc-job-name"
        type="text"
        placeholder="Auto"
        value={chatStore.activeTab?.jobName ?? ""}
        oninput={(e) => chatStore.setJobName((e.target as HTMLInputElement).value)}
      />
    </div>
  </div>
</div>

<style>
  .job-config {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }

  .config-header {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
    flex-shrink: 0;
  }

  .config-content {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }

  .config-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .config-row label {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.45px;
  }

  .config-row-inline {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .config-label-text {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.45px;
  }

  .config-row select,
  .config-row input {
    font-size: 12px;
    width: 100%;
    padding: 4px 6px;
    min-width: 0;
  }

  .model-input-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .model-input-row input,
  .model-input-row select {
    flex: 1 1 auto;
    min-width: 0;
  }

  .model-refresh-btn {
    font-size: 11px;
    line-height: 1.1;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
  }

  .model-refresh-btn.icon-only {
    width: 28px;
    min-width: 28px;
    height: 28px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
  }

  .model-refresh-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .model-refresh-btn:disabled {
    opacity: 0.65;
  }

  .preset-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }

  .preset-chip {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .preset-chip:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .preset-chip.active {
    background: var(--accent);
    color: var(--bg-base);
    border-color: var(--accent);
  }

  .coordination-toggle {
    font-size: 11px;
    padding: 2px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    cursor: pointer;
    font-weight: 500;
    min-width: 36px;
  }
  .coordination-toggle.on {
    background: var(--status-completed);
    color: var(--bg-base);
    border-color: var(--status-completed);
  }
  .coordination-toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
