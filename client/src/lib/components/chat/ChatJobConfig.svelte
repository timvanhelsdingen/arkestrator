<script lang="ts">
  import type {
    JobRuntimeOptions,
    RuntimeReasoningLevel,
    RuntimeVerificationMode,
  } from "@arkestrator/protocol";
  import { chatStore } from "../../stores/chat.svelte";
  import { agents } from "../../stores/agents.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { clientCoordination } from "../../stores/clientCoordination.svelte";
  import {
    api,
    type LocalModelCatalogEntry,
    type ProviderModelCatalog,
  } from "../../api/rest";

  let localModelCatalog = $state<LocalModelCatalogEntry[]>([]);
  let providerModelCatalogs = $state<Record<string, ProviderModelCatalog>>({});
  let localModelsLoadedKey = $state("");
  let providerCatalogsLoadedKey = $state("");
  let localModelsLoading = $state(false);
  let coordDropdownOpen = $state(false);

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

  // --- Coordination dropdown ---

  type CoordKey = "coordinator" | "bridge" | "training";
  const COORD_OPTIONS: { key: CoordKey; label: string; hint: string }[] = [
    { key: "coordinator", label: "Playbooks", hint: "Task matching & guidance" },
    { key: "bridge", label: "Bridge Scripts", hint: "Per-program scripts" },
    { key: "training", label: "Training", hint: "Auto-generated learning" },
  ];

  function isCoordEnabled(key: CoordKey): boolean {
    return (runtimeOptions?.coordinationScripts?.[key] ?? "enabled") !== "disabled";
  }

  function toggleCoordOption(key: CoordKey) {
    const current = runtimeOptions?.coordinationScripts;
    const currentValue = current?.[key] ?? "enabled";
    const newValue = currentValue === "disabled" ? "enabled" : "disabled";
    chatStore.setCoordinationScripts({ ...current, [key]: newValue });
  }

  function resetCoordToAll() {
    chatStore.setCoordinationScripts(undefined);
    coordDropdownOpen = false;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".coordination-dropdown")) {
      coordDropdownOpen = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:document onclick={handleClickOutside} />

<div class="job-config">
  <div class="config-header">
    <strong>Job Settings</strong>
  </div>
  <div class="config-content">
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

    <!-- Coord -->
    <div class="config-row coordination-dropdown">
      <label>Coord</label>
      <button
        class="coord-trigger"
        class:has-overrides={runtimeOptions?.coordinationScripts != null}
        onclick={() => (coordDropdownOpen = !coordDropdownOpen)}
      >
        <span class="coord-label">
          {#if !runtimeOptions?.coordinationScripts}
            All
          {:else if !COORD_OPTIONS.some((o) => isCoordEnabled(o.key))}
            None
          {:else}
            {COORD_OPTIONS.filter((o) => isCoordEnabled(o.key)).map((o) => o.label).join(", ")}
          {/if}
        </span>
        <span class="dropdown-arrow">{coordDropdownOpen ? "\u25B2" : "\u25BC"}</span>
      </button>

      {#if coordDropdownOpen}
        <div class="coord-menu">
          <button class="menu-item auto-item" class:active={!runtimeOptions?.coordinationScripts} onclick={resetCoordToAll}>
            <span class="check">{!runtimeOptions?.coordinationScripts ? "\u2713" : ""}</span>
            <span>All Enabled</span>
          </button>
          <div class="menu-divider"></div>
          {#each COORD_OPTIONS as opt (opt.key)}
            <button
              class="menu-item"
              class:active={isCoordEnabled(opt.key)}
              onclick={() => toggleCoordOption(opt.key)}
            >
              <span class="check">{isCoordEnabled(opt.key) ? "\u2713" : ""}</span>
              <span>{opt.label}</span>
              <span class="menu-hint">{opt.hint}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Skills -->
    <div class="config-row config-row-inline">
      <label for="jc-skills-mode">Skills</label>
      <input
        id="jc-skills-mode"
        type="checkbox"
        checked={runtimeOptions?.skillsMode ?? false}
        onchange={(e) => chatStore.setSkillsMode((e.target as HTMLInputElement).checked)}
      />
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

  .config-row-inline input[type="checkbox"] {
    width: auto;
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

  /* Coordination dropdown */
  .coordination-dropdown {
    position: relative;
  }

  .coord-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    width: 100%;
  }

  .coord-trigger:hover {
    border-color: var(--accent);
  }

  .coord-trigger.has-overrides {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }

  .coord-label {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown-arrow {
    font-size: 8px;
    color: inherit;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .coord-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    min-width: 200px;
    max-height: 320px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 100;
    padding: 4px 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    text-align: left;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item.active {
    color: var(--accent);
  }

  .check {
    width: 14px;
    font-size: 12px;
    flex-shrink: 0;
    text-align: center;
  }

  .menu-hint {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
  }

  .menu-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }
</style>
