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

  interface SkillInfo { slug: string; title: string; program: string; category: string; enabled: boolean; }
  let serverSkills = $state<SkillInfo[]>([]);
  let skillsLoaded = $state(false);

  async function loadSkills() {
    try {
      const res = await api.skills.list();
      const raw = (res as any).skills ?? res;
      serverSkills = (Array.isArray(raw) ? raw : []).map((s: any) => ({
        slug: s.slug,
        title: s.title ?? s.slug,
        program: s.program ?? "global",
        category: s.category ?? "custom",
        enabled: s.enabled !== false,
      }));
      skillsLoaded = true;
    } catch { /* ignore */ }
  }

  // Load skills once connection is available
  $effect(() => {
    if (connection.url && !skillsLoaded) loadSkills();
  });

  let skillsExpanded = $state(false);
  let enabledSkillCount = $derived(serverSkills.filter(s => s.enabled).length);

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

    <!-- Skills -->
    <div class="config-row config-row-inline">
      <button class="skills-toggle-btn" onclick={() => skillsExpanded = !skillsExpanded}>
        <span class="config-label-text">Skills</span>
        <span class="skills-count">{enabledSkillCount}/{serverSkills.length}</span>
        <span class="skills-chevron" class:expanded={skillsExpanded}>▸</span>
      </button>
    </div>
    {#if skillsExpanded}
      <div class="skills-list">
        {#each serverSkills as skill}
          <label class="skill-toggle" title={skill.slug}>
            <input
              type="checkbox"
              checked={skill.enabled}
              onchange={() => {
                skill.enabled = !skill.enabled;
                api.skills.update(skill.slug, { enabled: skill.enabled }, skill.program).catch(() => {});
              }}
            />
            <span class="skill-name">{skill.title}</span>
            <span class="skill-badge">{skill.program}</span>
          </label>
        {/each}
        {#if serverSkills.length === 0}
          <span class="muted" style="font-size: 11px; padding: 2px 0;">No skills loaded</span>
        {/if}
      </div>
    {/if}

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

  .skills-toggle-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .skills-count {
    font-size: 11px;
    color: var(--text-secondary);
    margin-left: auto;
  }
  .skills-chevron {
    font-size: 10px;
    color: var(--text-secondary);
    transition: transform 0.15s;
  }
  .skills-chevron.expanded {
    transform: rotate(90deg);
  }
  .skills-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 0 6px 4px;
    max-height: 180px;
    overflow-y: auto;
  }
  .skill-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    cursor: pointer;
    padding: 2px 0;
  }
  .skill-toggle input[type="checkbox"] {
    width: 13px;
    height: 13px;
    margin: 0;
    flex-shrink: 0;
  }
  .skill-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .skill-badge {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    flex-shrink: 0;
  }
</style>
