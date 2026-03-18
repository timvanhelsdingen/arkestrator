<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    type LocalModelCatalogEntry,
    type LocalModelInfo,
    type LocalModelPullProgressEvent,
    type LocalModelsResponse,
  } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import ConfirmDialog from "../lib/components/ui/ConfirmDialog.svelte";

  interface ModelOverride {
    systemPrompt?: string;
    maxTurns?: number;
  }

  interface AgentConfig {
    id: string;
    name: string;
    engine: string;
    command: string;
    args: string[];
    model?: string;
    fallbackConfigId?: string;
    maxTurns: number;
    systemPrompt?: string;
    modelSystemPrompts?: Record<string, string>;
    modelOverrides?: Record<string, ModelOverride>;
    priority: number;
    localModelHost?: "server" | "client";
    createdAt: string;
  }

  interface AgentTemplate {
    id: string;
    name: string;
    description: string;
    engine: string;
    command: string;
    args: string[];
    model?: string;
    maxTurns: number;
    priority: number;
    onboarding?: AgentTemplateOnboarding;
  }

  interface AgentTemplateOnboarding {
    title: string;
    steps: string[];
    links?: Array<{
      label: string;
      url: string;
    }>;
    commands?: string[];
  }

  interface LocalModelWorkerOption {
    name: string;
    status: "online" | "offline";
    localLlmEnabled: boolean;
    localLlmBaseUrl?: string;
  }

  let configs = $state<AgentConfig[]>([]);
  let templates = $state<AgentTemplate[]>([]);
  let showTemplates = $state(false);
  let loadingTemplates = $state(false);
  let addingTemplate = $state(false);
  let selectedTemplateId = $state("");
  let onboardingTemplate = $state<AgentTemplate | null>(null);
  let showForm = $state(false);
  let editingId = $state<string | null>(null);
  let localRuntime = $state<"ollama">("ollama");
  let localModels = $state<LocalModelInfo[]>([]);
  let localCatalog = $state<LocalModelCatalogEntry[]>([]);
  let allowedLocalModels = $state<string[]>([]);
  let localModelsLoading = $state(false);
  let localModelsError = $state("");
  let pullingLocalModel = $state(false);
  let pullProgressModel = $state("");
  let pullProgressLabel = $state("");
  let pullProgressPercent = $state<number | null>(null);
  let localModelSourceLabel = $state("Server");
  let localModelTargetWorkerName = $state("");
  let localModelWorkers = $state<LocalModelWorkerOption[]>([]);
  let localModelWorkersLoading = $state(false);
  let localModelWorkersLoaded = $state(false);
  let savingAllowlist = $state(false);
  let allowlistDirty = $state(false);
  let allowlistInput = $state("");
  let ollamaReachable = $state(true);
  let autoPullModelOnSave = $state(false);
  let localModelsAutoLoaded = $state(false);
  let form = $state({
    name: "",
    engine: "claude-code" as string,
    command: "claude",
    args: "",
    model: "",
    fallbackConfigId: "",
    maxTurns: 300,
    systemPrompt: "",
    priority: 50,
    localModelHost: "client" as "server" | "client",
  });
  // Per-model overrides (system prompt, max turns) keyed by model name
  let modelOverridesState = $state<Record<string, ModelOverride>>({});
  let expandedModels = $state<Set<string>>(new Set());

  function normalizeArgs(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item).trim())
        .filter(Boolean);
    }
    if (typeof value === "string") {
      return value.trim().split(/\s+/).filter(Boolean);
    }
    return [];
  }

  function normalizeConfig(raw: any): AgentConfig {
    return {
      id: String(raw?.id ?? ""),
      name: String(raw?.name ?? "Unnamed Config"),
      engine: String(raw?.engine ?? "claude-code"),
      command: String(raw?.command ?? ""),
      args: normalizeArgs(raw?.args),
      model: typeof raw?.model === "string" && raw.model.trim() ? raw.model : undefined,
      fallbackConfigId: typeof raw?.fallbackConfigId === "string" && raw.fallbackConfigId.trim()
        ? raw.fallbackConfigId
        : undefined,
      maxTurns: typeof raw?.maxTurns === "number" ? raw.maxTurns : 300,
      systemPrompt: typeof raw?.systemPrompt === "string" ? raw.systemPrompt : undefined,
      modelSystemPrompts: raw?.modelSystemPrompts && typeof raw.modelSystemPrompts === "object"
        ? raw.modelSystemPrompts as Record<string, string>
        : undefined,
      modelOverrides: raw?.modelOverrides && typeof raw.modelOverrides === "object"
        ? raw.modelOverrides as Record<string, ModelOverride>
        : undefined,
      priority: typeof raw?.priority === "number" ? raw.priority : 50,
      createdAt: String(raw?.createdAt ?? ""),
    };
  }

  function resetLocalModelState() {
    localModels = [];
    localCatalog = [];
    allowedLocalModels = [];
    localModelsLoading = false;
    localModelsError = "";
    pullingLocalModel = false;
    pullProgressModel = "";
    pullProgressLabel = "";
    pullProgressPercent = null;
    localModelSourceLabel = localModelTargetWorkerName ? `Worker: ${localModelTargetWorkerName}` : "Server";
    localModelWorkers = [];
    localModelWorkersLoading = false;
    localModelWorkersLoaded = false;
    savingAllowlist = false;
    allowlistDirty = false;
    allowlistInput = "";
    autoPullModelOnSave = false;
    localModelsAutoLoaded = false;
  }

  function resetForm() {
    form = { name: "", engine: "claude-code", command: "claude", args: "", model: "", fallbackConfigId: "", maxTurns: 300, systemPrompt: "", priority: 50, localModelHost: "client" as "server" | "client" };
    modelOverridesState = {};
    expandedModels = new Set();
    editingId = null;
    resetLocalModelState();
  }

  async function load() {
    try {
      const payload = await api.agents.list();
      configs = Array.isArray(payload) ? payload.map(normalizeConfig) : [];
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function closeTemplates() {
    showTemplates = false;
    selectedTemplateId = "";
  }

  function closeOnboarding() {
    onboardingTemplate = null;
  }

  function openOnboardingLink(url: string) {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error(`Could not open link: ${url}`);
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch { /* secure-context only; fall through */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  async function copyCommand(command: string) {
    try {
      await copyToClipboard(command);
      toast.success("Copied command");
    } catch {
      toast.error("Failed to copy command");
    }
  }

  async function loadTemplates() {
    loadingTemplates = true;
    try {
      templates = await api.agents.templates();
      selectedTemplateId = templates[0]?.id ?? "";
      showTemplates = true;
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      loadingTemplates = false;
    }
  }

  async function toggleTemplates() {
    if (showTemplates) {
      closeTemplates();
      return;
    }
    await loadTemplates();
  }

  async function addTemplate(t: AgentTemplate) {
    if (addingTemplate) return;
    addingTemplate = true;
    try {
      const createData: Record<string, unknown> = {
        name: t.name,
        engine: t.engine,
        command: t.command,
        args: t.args,
        model: t.model || undefined,
        maxTurns: t.maxTurns,
        priority: t.priority,
      };
      if (t.engine === "local-oss") {
        createData.localModelHost = "client";
      }
      await api.agents.create(createData);
      closeTemplates();
      onboardingTemplate = t.onboarding ? t : null;
      if (onboardingTemplate) {
        toast.success(`Template added: ${t.name}. Complete provider login setup next.`);
      } else {
        toast.success(`Template added: ${t.name}`);
      }
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      addingTemplate = false;
    }
  }

  async function applySelectedTemplate() {
    const selected = templates.find((template) => template.id === selectedTemplateId);
    if (!selected) {
      toast.error("Select a template first");
      return;
    }
    await addTemplate(selected);
  }

  function startEdit(config: AgentConfig) {
    try {
      editingId = config.id;
      form = {
        name: config.name,
        engine: config.engine,
        command: config.command,
        args: normalizeArgs(config.args).join(" "),
        model: config.model ?? "",
        fallbackConfigId: config.fallbackConfigId ?? "",
        maxTurns: config.maxTurns,
        systemPrompt: config.systemPrompt ?? "",
        priority: config.priority,
        localModelHost: (config.localModelHost ?? "client") as "server" | "client",
      };
      // Populate per-model overrides (prefer modelOverrides, fall back to legacy modelSystemPrompts)
      const overrides: Record<string, ModelOverride> = {};
      if (config.modelOverrides && Object.keys(config.modelOverrides).length > 0) {
        for (const [model, ov] of Object.entries(config.modelOverrides)) {
          overrides[model] = { ...ov };
        }
      } else if (config.modelSystemPrompts && Object.keys(config.modelSystemPrompts).length > 0) {
        for (const [model, prompt] of Object.entries(config.modelSystemPrompts)) {
          overrides[model] = { systemPrompt: prompt };
        }
      }
      modelOverridesState = overrides;
      expandedModels = new Set();
      showForm = true;
      if (config.engine !== "local-oss") {
        resetLocalModelState();
      }

      const schedule = (
        typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      )
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0);

      schedule(() => {
        const panel = document.getElementById("agent-config-editor");
        if (!panel) return;
        try {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {
          panel.scrollIntoView();
        }
      });
    } catch (err: any) {
      console.error("Failed to open agent config editor", err);
      toast.error(err?.message ?? "Failed to open editor");
    }
  }

  function formatModelOption(model: LocalModelInfo): string {
    if (typeof model.sizeBytes !== "number" || model.sizeBytes <= 0) return model.name;
    const gb = model.sizeBytes / (1024 ** 3);
    return `${model.name} (${gb.toFixed(1)} GB)`;
  }

  function normalizeNames(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }

  function applyLocalModelsPayload(payload: LocalModelsResponse | any) {
    localModels = Array.isArray(payload?.models) ? payload.models : [];
    const downloadedByName = new Map(localModels.map((model) => [model.name, model] as const));
    const allowed = Array.isArray(payload?.allowedModels)
      ? normalizeNames(payload.allowedModels.map((value: unknown) => String(value ?? "")))
      : [];

    const catalogFallback = normalizeNames([
      ...allowed,
      ...localModels.map((model) => model.name),
    ]).map((name) => {
      const downloaded = downloadedByName.get(name);
      return {
        name,
        sizeBytes: downloaded?.sizeBytes,
        modifiedAt: downloaded?.modifiedAt,
        digest: downloaded?.digest,
        allowed: allowed.includes(name),
        downloaded: !!downloaded,
        recommended: false,
      } satisfies LocalModelCatalogEntry;
    });

    localCatalog = Array.isArray(payload?.catalog)
      ? payload.catalog
      : catalogFallback;
    allowedLocalModels = allowed;
    ollamaReachable = payload?.ollamaReachable !== false;
    const source = payload?.source === "worker" ? "worker" : "server";
    const worker = String(payload?.targetWorkerName ?? "").trim();
    localModelSourceLabel = source === "worker" && worker ? `Worker: ${worker}` : "Server";
    allowlistDirty = false;
  }

  function localModelTargetWorker(): string | undefined {
    const name = localModelTargetWorkerName.trim();
    return name ? name : undefined;
  }

  function describeLocalModelWorker(worker: LocalModelWorkerOption): string {
    const status = worker.status === "online" ? "online" : "offline";
    if (!worker.localLlmEnabled) {
      return `${worker.name} (${status}, local LLM disabled)`;
    }
    return `${worker.name} (${status})`;
  }

  function isModelAllowed(name: string): boolean {
    return allowedLocalModels.includes(name);
  }

  function setModelAllowed(name: string, allowed: boolean) {
    if (allowed) {
      allowedLocalModels = normalizeNames([...allowedLocalModels, name]);
    } else {
      allowedLocalModels = allowedLocalModels.filter((model) => model !== name);
    }
    localCatalog = localCatalog.map((entry) =>
      entry.name === name
        ? { ...entry, allowed }
        : entry,
    );
    allowlistDirty = true;
  }

  function addAllowlistModel() {
    const name = allowlistInput.trim();
    if (!name) return;
    const exists = localCatalog.some((entry) => entry.name === name);
    if (!exists) {
      localCatalog = [
        ...localCatalog,
        {
          name,
          allowed: true,
          downloaded: false,
          recommended: false,
        },
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!allowedLocalModels.includes(name)) {
      allowedLocalModels = normalizeNames([...allowedLocalModels, name]);
      allowlistDirty = true;
    }
    localCatalog = localCatalog.map((entry) =>
      entry.name === name
        ? { ...entry, allowed: true }
        : entry,
    );
    allowlistInput = "";
  }

  function allowRecommendedModels() {
    const recommended = localCatalog
      .filter((entry) => entry.recommended)
      .map((entry) => entry.name);
    if (recommended.length === 0) return;
    allowedLocalModels = normalizeNames([...allowedLocalModels, ...recommended]);
    localCatalog = localCatalog.map((entry) => ({
      ...entry,
      allowed: allowedLocalModels.includes(entry.name),
    }));
    allowlistDirty = true;
  }

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function progressPercentFromEvent(event: LocalModelPullProgressEvent): number | undefined {
    if (typeof event.progressPercent === "number") {
      return clampPercent(event.progressPercent);
    }
    if (
      typeof event.total === "number"
      && event.total > 0
      && typeof event.completed === "number"
      && event.completed >= 0
    ) {
      return clampPercent((event.completed / event.total) * 100);
    }
    return undefined;
  }

  async function downloadMissingAllowedModels() {
    if (pullingLocalModel) return;
    const pending = localCatalog.filter((entry) => entry.allowed && !entry.downloaded);
    if (pending.length === 0) {
      toast.success("All allowed models are already downloaded");
      return;
    }

    pullingLocalModel = true;
    localModelsError = "";
    pullProgressModel = "";
    pullProgressLabel = `Downloading allowed models (0/${pending.length})`;
    pullProgressPercent = 0;
    try {
      let completedModels = 0;

      for (const entry of pending) {
        pullProgressModel = entry.name;
        pullProgressLabel = `Downloading ${entry.name} (${completedModels + 1}/${pending.length})`;

        await api.agents.pullLocalModelStream(
          entry.name,
          (event) => {
            const modelPercent = progressPercentFromEvent(event) ?? 0;
            const weighted = ((completedModels + (modelPercent / 100)) / pending.length) * 100;
            pullProgressPercent = clampPercent(weighted);
            if (event.status) {
              pullProgressLabel = `${event.status} (${completedModels + 1}/${pending.length})`;
            }
          },
          localRuntime,
        );

        completedModels += 1;
        pullProgressPercent = clampPercent((completedModels / pending.length) * 100);
      }
      await refreshLocalModels(false);
      pullProgressPercent = 100;
      pullProgressLabel = `Downloaded ${pending.length} allowed model(s)`;
      pullProgressModel = "";
      toast.success(`Downloaded ${pending.length} allowed model(s)`);
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
      pullProgressLabel = `Download failed${pullProgressModel ? `: ${pullProgressModel}` : ""}`;
      toast.error(localModelsError);
    } finally {
      pullingLocalModel = false;
    }
  }

  async function refreshLocalModels(showToast = false) {
    localModelsLoading = true;
    localModelsError = "";
    try {
      const payload = await api.agents.localModels(localRuntime, localModelTargetWorker());
      applyLocalModelsPayload(payload);
      localModelsAutoLoaded = true;
      if (showToast) {
        toast.success(`Loaded ${localModels.length} local model(s)`);
      }
    } catch (err: any) {
      localModels = [];
      localCatalog = [];
      allowedLocalModels = [];
      localModelsError = err?.message ?? String(err);
      localModelsAutoLoaded = true;
      if (showToast) {
        toast.error(localModelsError);
      }
    } finally {
      localModelsLoading = false;
    }
  }

  async function pullLocalModel(modelName: string, showToast = true) {
    const model = modelName.trim();
    if (!model) {
      const msg = "Model name is required to download";
      if (showToast) toast.error(msg);
      else throw new Error(msg);
      return;
    }

    pullingLocalModel = true;
    localModelsError = "";
    pullProgressModel = model;
    pullProgressLabel = `Downloading ${model}`;
    pullProgressPercent = 0;
    try {
      await api.agents.pullLocalModelStream(
        model,
        (event) => {
          const percent = progressPercentFromEvent(event);
          if (percent !== undefined) {
            pullProgressPercent = percent;
          }
          if (event.status) {
            pullProgressLabel = `${event.status}: ${model}`;
          }
        },
        localRuntime,
        localModelTargetWorker(),
      );
      pullProgressPercent = 100;
      pullProgressLabel = `Model ready: ${model}`;
      if (showToast) {
        toast.success(`Model ready: ${model}`);
      }
      await refreshLocalModels(false);
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
      pullProgressLabel = `Download failed: ${model}`;
      if (showToast) toast.error(localModelsError);
      else throw err;
    } finally {
      pullingLocalModel = false;
    }
  }

  async function pullSelectedModel(showToast = true) {
    await pullLocalModel(form.model, showToast);
  }

  async function saveAllowlist(showToast = true) {
    if (!allowlistDirty) return;
    savingAllowlist = true;
    localModelsError = "";
    try {
      const payload = await api.agents.setLocalModelAllowlist(
        allowedLocalModels,
        localRuntime,
        localModelTargetWorker(),
      );
      applyLocalModelsPayload(payload);
      if (showToast) toast.success(`Allowed models updated (${allowedLocalModels.length})`);
    } catch (err: any) {
      localModelsError = err?.message ?? String(err);
      if (showToast) toast.error(localModelsError);
    } finally {
      savingAllowlist = false;
    }
  }

  let allowedDownloadedCatalog = $derived.by(() =>
    localCatalog.filter((entry) => entry.allowed && entry.downloaded),
  );

  async function loadLocalModelWorkers() {
    localModelWorkersLoading = true;
    try {
      const result = await api.workers.list();
      const rows = Array.isArray(result?.workers) ? result.workers : [];
      localModelWorkers = rows
        .map((row: any) => ({
          name: String(row?.name ?? "").trim(),
          status: row?.status === "online" ? "online" : "offline",
          localLlmEnabled: row?.rule?.localLlmEnabled === true,
          localLlmBaseUrl: String(row?.rule?.localLlmBaseUrl ?? "").trim() || undefined,
        }))
        .filter((row: LocalModelWorkerOption) => !!row.name)
        .sort((a: LocalModelWorkerOption, b: LocalModelWorkerOption) => a.name.localeCompare(b.name));
      if (
        localModelTargetWorkerName
        && !localModelWorkers.some((worker) => worker.name === localModelTargetWorkerName)
      ) {
        localModelTargetWorkerName = "";
      }
      localModelSourceLabel = localModelTargetWorkerName ? `Worker: ${localModelTargetWorkerName}` : "Server";
    } catch {
      localModelWorkers = [];
      if (localModelTargetWorkerName) {
        localModelTargetWorkerName = "";
      }
      localModelSourceLabel = "Server";
    } finally {
      localModelWorkersLoading = false;
      localModelWorkersLoaded = true;
    }
  }

  function onLocalModelTargetChange(event: Event) {
    localModelTargetWorkerName = String((event.currentTarget as HTMLSelectElement).value ?? "").trim();
    localModelsAutoLoaded = false;
    localModelSourceLabel = localModelTargetWorkerName ? `Worker: ${localModelTargetWorkerName}` : "Server";
    void refreshLocalModels(false);
  }

  function selectedWorkerHasLocalLlmDisabled(): boolean {
    if (!localModelTargetWorkerName) return false;
    const worker = localModelWorkers.find((entry) => entry.name === localModelTargetWorkerName);
    return worker ? !worker.localLlmEnabled : false;
  }

  $effect(() => {
    if (!showForm) return;
    if (form.engine !== "local-oss") return;
    if (localModelsLoading) return;
    if (localModelsAutoLoaded) return;
    void refreshLocalModels(false);
  });

  $effect(() => {
    if (!showForm) return;
    if (form.engine !== "local-oss") return;
    if (localModelWorkersLoading) return;
    if (localModelWorkersLoaded) return;
    void loadLocalModelWorkers();
  });

  function onDiscoveredModelChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!value) return;
    form.model = value;
  }

  async function save() {
    const data: Record<string, unknown> = {
      name: form.name,
      engine: form.engine,
      command: form.command,
      args: form.args.split(/\s+/).filter(Boolean),
      model: form.model || undefined,
      fallbackConfigId: form.fallbackConfigId || undefined,
      maxTurns: form.maxTurns,
      systemPrompt: form.systemPrompt || undefined,
      modelOverrides: Object.keys(modelOverridesState).length > 0
        ? Object.fromEntries(
            Object.entries(modelOverridesState)
              .filter(([, ov]) => ov.systemPrompt?.trim() || ov.maxTurns)
              .map(([model, ov]) => [model, {
                ...(ov.systemPrompt?.trim() ? { systemPrompt: ov.systemPrompt.trim() } : {}),
                ...(ov.maxTurns ? { maxTurns: ov.maxTurns } : {}),
              }]),
          )
        : undefined,
      // Keep legacy field in sync for backward compat
      modelSystemPrompts: Object.keys(modelOverridesState).length > 0
        ? Object.fromEntries(
            Object.entries(modelOverridesState)
              .filter(([, ov]) => ov.systemPrompt?.trim())
              .map(([model, ov]) => [model, ov.systemPrompt!.trim()]),
          ) || undefined
        : undefined,
      priority: form.priority,
    };
    if (form.engine === "local-oss") {
      data.localModelHost = form.localModelHost;
    }

    try {
      if (form.engine === "local-oss" && allowlistDirty) {
        await saveAllowlist(false);
      }
      if (form.engine === "local-oss" && autoPullModelOnSave && form.model.trim()) {
        await pullSelectedModel(false);
      }
      if (editingId) {
        await api.agents.update(editingId, data);
        toast.success("Agent config updated");
      } else {
        await api.agents.create(data);
        toast.success("Agent config created");
      }
      showForm = false;
      resetForm();
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  let confirmDeleteOpen = $state(false);
  let pendingDeleteConfig: AgentConfig | null = $state(null);

  function deleteConfig(config: AgentConfig) {
    pendingDeleteConfig = config;
    confirmDeleteOpen = true;
  }

  async function doDeleteConfig() {
    confirmDeleteOpen = false;
    if (!pendingDeleteConfig) return;
    try {
      await api.agents.delete(pendingDeleteConfig.id);
      toast.success(`"${pendingDeleteConfig.name}" deleted`);
      pendingDeleteConfig = null;
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="page">
  <div class="toolbar">
    <button type="button" class="btn-secondary" onclick={toggleTemplates} disabled={loadingTemplates}>
      {loadingTemplates ? "Loading Templates..." : (showTemplates ? "Hide Templates" : "Add from Template")}
    </button>
    <button type="button" class="btn-primary" onclick={() => { resetForm(); showForm = true; }}>
      New Agent Config
    </button>
  </div>

  <div class="cli-auth-notice">
    <strong>CLI Authentication</strong>
    <p>
      Agent CLIs (Claude Code, Codex, Gemini, Grok) are authenticated via terminal.
      In Docker, run <code>docker exec -it arkestrator claude /login</code> or <code>docker exec -it arkestrator codex auth</code>.
      Outside Docker, ensure the CLI is installed and on your PATH, then run its login command directly.
    </p>
    <p class="muted">
      Auth tokens persist across restarts when HOME is mapped to a volume (e.g. <code>HOME=/data/home</code>).
      For API-key-based engines (Gemini, Grok), set the key as an environment variable instead.
    </p>
  </div>

  {#if showTemplates}
    <div class="templates-panel">
      <div class="templates-header">
        <strong>Agent Config Templates</strong>
        <button type="button" class="btn-small" onclick={closeTemplates}>Close</button>
      </div>
      <div class="templates-modal">
        <div class="templates-list">
          {#each templates as t (t.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="template-card"
              class:selected={selectedTemplateId === t.id}
              onclick={() => (selectedTemplateId = t.id)}
            >
              <div class="template-header">
                <strong>{t.name}</strong>
                <span class="engine-badge">{t.engine}</span>
              </div>
              <p class="template-desc">{t.description}</p>
              <div class="template-meta">
                <span>Command: <code>{t.command}</code></span>
                {#if t.model}<span>Model: {t.model}</span>{/if}
              </div>
              <button
                type="button"
                class="btn-primary btn-sm-template"
                disabled={addingTemplate}
                onclick={async (e) => { e.stopPropagation(); await addTemplate(t); }}
              >
                {addingTemplate ? "Adding..." : "Use Template"}
              </button>
            </div>
          {:else}
            <p class="muted">No templates available.</p>
          {/each}
        </div>
        <div class="templates-footer">
          <button type="button" class="btn-secondary" onclick={closeTemplates}>Cancel</button>
          <button type="button" class="btn-primary" onclick={applySelectedTemplate} disabled={!selectedTemplateId || addingTemplate}>
            {addingTemplate ? "Adding..." : "Use Selected Template"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if onboardingTemplate?.onboarding}
    <div class="onboarding-panel">
      <div class="onboarding-header">
        <strong>{onboardingTemplate.name} setup</strong>
        <button type="button" class="btn-small" onclick={closeOnboarding}>Close</button>
      </div>
      <div class="onboarding-title">{onboardingTemplate.onboarding.title}</div>
      <ol class="onboarding-steps">
        {#each onboardingTemplate.onboarding.steps as step}
          <li>{step}</li>
        {/each}
      </ol>
      {#if onboardingTemplate.onboarding.links?.length}
        <div class="onboarding-links">
          {#each onboardingTemplate.onboarding.links as link}
            <button type="button" class="btn-secondary btn-inline" onclick={() => openOnboardingLink(link.url)}>
              Open: {link.label}
            </button>
          {/each}
        </div>
      {/if}
      {#if onboardingTemplate.onboarding.commands?.length}
        <div class="onboarding-commands">
          {#each onboardingTemplate.onboarding.commands as command}
            <div class="onboarding-command-row">
              <code>{command}</code>
              <button type="button" class="btn-small" onclick={() => copyCommand(command)}>Copy</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if showForm}
    <div class="editor-panel" id="agent-config-editor">
      <div class="editor-header">
        <strong>{editingId ? "Edit Agent Config" : "New Agent Config"}</strong>
        <button type="button" class="btn-small" onclick={() => { showForm = false; resetForm(); }}>Close</button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); save(); }}>
        <label class="field"><span>Name</span><input type="text" bind:value={form.name} required /></label>
        <label class="field">
          <span>Engine</span>
          <select bind:value={form.engine}>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
            <option value="grok">Grok</option>
            <option value="local-oss">Local / OSS</option>
          </select>
        </label>
        <label class="field"><span>Command</span><input type="text" bind:value={form.command} required /></label>
        <label class="field">
          <span>Args (space-separated)</span>
          <input type="text" bind:value={form.args} />
          <div class="hint">
            Local / OSS placeholders:
            <code>{'{{MODEL}}'}</code>
            and
            <code>{'{{PROMPT}}'}</code>
          </div>
        </label>
        <label class="field"><span>Model</span><input type="text" bind:value={form.model} placeholder={"Optional (used by {{MODEL}} placeholder)"} /></label>
        <label class="field"><span>Fallback Config ID (optional)</span><input type="text" bind:value={form.fallbackConfigId} placeholder="Used by AUTO routing escalation" /></label>
        {#if form.engine === "local-oss"}
          <div class="local-tools">
            <label class="field compact local-target-field">
              <span>Model Host</span>
              <select bind:value={form.localModelHost}>
                <option value="client">Client (any machine with LLM enabled)</option>
                <option value="server">Server (this machine)</option>
              </select>
              <div class="hint">{form.localModelHost === "client" ? "Jobs auto-route to any online worker with local LLM enabled" : "Jobs use Ollama running on the server itself"}</div>
            </label>
            <label class="field compact local-target-field">
              <span>Catalog Source</span>
              <select
                bind:value={localModelTargetWorkerName}
                onchange={onLocalModelTargetChange}
                disabled={localModelWorkersLoading || localModelsLoading || pullingLocalModel}
              >
                <option value="">Server (this machine)</option>
                {#each localModelWorkers as worker (worker.name)}
                  <option value={worker.name} disabled={!worker.localLlmEnabled}>
                    {describeLocalModelWorker(worker)}
                  </option>
                {/each}
              </select>
              <div class="hint">Browse/pull models from: {localModelSourceLabel}</div>
              {#if selectedWorkerHasLocalLlmDisabled()}
                <div class="hint error-hint">Selected worker has local LLM disabled in worker rules.</div>
              {/if}
            </label>
            <div class="local-actions">
              <button type="button" class="btn-secondary btn-inline" onclick={() => refreshLocalModels(true)} disabled={localModelsLoading || pullingLocalModel}>
                {localModelsLoading ? "Refreshing..." : "Refresh Local Model List"}
              </button>
              <button type="button" class="btn-secondary btn-inline" onclick={allowRecommendedModels} disabled={localCatalog.length === 0}>
                Allow Common Models
              </button>
              <button type="button" class="btn-secondary btn-inline" onclick={downloadMissingAllowedModels} disabled={pullingLocalModel || localCatalog.length === 0}>
                {pullingLocalModel ? "Downloading..." : "Download Missing Allowed"}
              </button>
              <button type="button" class="btn-secondary btn-inline" onclick={() => saveAllowlist(true)} disabled={savingAllowlist || !allowlistDirty}>
                {savingAllowlist ? "Saving..." : "Save Allowed Models"}
              </button>
            </div>
            {#if pullProgressPercent !== null}
              <div class="pull-progress">
                <div class="pull-progress-row">
                  <span class="pull-progress-label">
                    {pullProgressLabel || (pullProgressModel ? `Downloading ${pullProgressModel}` : "Preparing download")}
                  </span>
                  <span class="pull-progress-value">{pullProgressPercent}%</span>
                </div>
                <div class="pull-progress-track">
                  <div class="pull-progress-fill" style={`width: ${pullProgressPercent}%`}></div>
                </div>
              </div>
            {/if}
            <label class="field compact">
              <span>Allowed + Downloaded Models ({localRuntime})</span>
              <select onchange={onDiscoveredModelChange} disabled={localModelsLoading || allowedDownloadedCatalog.length === 0}>
                <option value="">{allowedDownloadedCatalog.length === 0 ? "No allowed models downloaded yet" : "Select a model for this config"}</option>
                {#each allowedDownloadedCatalog as model (model.name)}
                  <option value={model.name}>{formatModelOption(model)}</option>
                {/each}
              </select>
            </label>
            {#if !ollamaReachable && !localModelsLoading}
              <div class="hint info-banner">Ollama not detected on {localModelSourceLabel}. Manage the allowlist here — clients will download models via their own Ollama.</div>
            {/if}
            <div class="allowlist-editor">
              <div class="allowlist-add">
                <input
                  type="text"
                  bind:value={allowlistInput}
                  placeholder="Add model name (example: qwen2.5-coder:14b)"
                  onkeydown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAllowlistModel();
                    }
                  }}
                />
                <button type="button" class="btn-secondary btn-inline" onclick={addAllowlistModel}>
                  Add
                </button>
              </div>
              <div class="allowlist-list">
                {#if localCatalog.length === 0}
                  <div class="hint">No model catalog loaded yet. Click "Refresh Local Model List".</div>
                {:else}
                  {#each localCatalog as model (model.name)}
                    {@const isExpanded = expandedModels.has(model.name)}
                    {@const hasOverride = !!(modelOverridesState[model.name]?.systemPrompt?.trim() || modelOverridesState[model.name]?.maxTurns)}
                    <div class="allow-item-wrap" class:expanded={isExpanded}>
                      <div class="allow-item">
                        <label class="allow-checkbox">
                          <input
                            type="checkbox"
                            checked={isModelAllowed(model.name)}
                            onchange={(event) => setModelAllowed(model.name, (event.currentTarget as HTMLInputElement).checked)}
                          />
                          <span class="allow-model-name">{model.name}</span>
                          {#if model.recommended}
                            <span class="allow-recommended">Common</span>
                          {/if}
                          {#if model.parameterBillions}
                            <span class="allow-param">{model.parameterBillions}B</span>
                          {/if}
                          {#if hasOverride}
                            <span class="allow-override-badge">overrides</span>
                          {/if}
                        </label>
                        <span class="allow-status" class:is-downloaded={model.downloaded}>
                          {model.downloaded ? "Downloaded" : "Not downloaded"}
                        </span>
                        <div class="allow-actions">
                          <button
                            type="button"
                            class="btn-small"
                            onclick={async () => {
                              form.model = model.name;
                              await pullLocalModel(model.name, true);
                            }}
                            disabled={pullingLocalModel}
                          >
                            {pullingLocalModel ? "Working..." : (model.downloaded ? "Update" : "Download")}
                          </button>
                          <button
                            type="button"
                            class="btn-icon-sm expand-toggle"
                            title={isExpanded ? "Collapse settings" : "Expand settings"}
                            onclick={() => {
                              const next = new Set(expandedModels);
                              if (isExpanded) next.delete(model.name);
                              else next.add(model.name);
                              expandedModels = next;
                              if (!isExpanded && !modelOverridesState[model.name]) {
                                modelOverridesState = { ...modelOverridesState, [model.name]: {} };
                              }
                            }}
                          >
                            {isExpanded ? "▼" : "▶"}
                          </button>
                        </div>
                      </div>
                      {#if isExpanded}
                        <div class="allow-item-settings">
                          <label class="field compact">
                            <span>System Prompt Override</span>
                            <textarea
                              rows="2"
                              placeholder="Uses default system prompt"
                              value={modelOverridesState[model.name]?.systemPrompt ?? ""}
                              oninput={(e) => {
                                modelOverridesState = {
                                  ...modelOverridesState,
                                  [model.name]: { ...modelOverridesState[model.name], systemPrompt: (e.currentTarget as HTMLTextAreaElement).value },
                                };
                              }}
                            ></textarea>
                          </label>
                          <label class="field compact">
                            <span>Max Turns Override</span>
                            <input
                              type="number"
                              min="1"
                              placeholder="Uses global ({form.maxTurns})"
                              value={modelOverridesState[model.name]?.maxTurns ?? ""}
                              oninput={(e) => {
                                const val = parseInt((e.currentTarget as HTMLInputElement).value);
                                modelOverridesState = {
                                  ...modelOverridesState,
                                  [model.name]: { ...modelOverridesState[model.name], maxTurns: isNaN(val) ? undefined : val },
                                };
                              }}
                            />
                          </label>
                        </div>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
            <label class="check-row">
              <input type="checkbox" bind:checked={autoPullModelOnSave} />
              <span>Auto-download selected model before saving this config</span>
            </label>
            {#if localModelsError}
              <div class="hint error-hint">{localModelsError}</div>
            {/if}
          </div>
        {/if}
        <label class="field"><span>Max Turns</span><input type="number" bind:value={form.maxTurns} min="1" /></label>
        <label class="field"><span>System Prompt (default)</span><textarea bind:value={form.systemPrompt} rows="3" placeholder="Optional system prompt for all models"></textarea></label>

        <label class="field"><span>Priority (0-100)</span><input type="number" bind:value={form.priority} min="0" max="100" /></label>
        <div class="editor-actions">
          <button type="button" class="btn-secondary" onclick={() => { showForm = false; resetForm(); }}>Cancel</button>
          <button type="submit" class="btn-primary">{editingId ? "Update" : "Create"}</button>
        </div>
      </form>
    </div>
  {/if}

  <div class="config-grid">
    {#each configs as config}
      <div class="config-card">
        <div class="config-header">
          <strong>{config.name}</strong>
          <span class="engine-badge">{config.engine}</span>
        </div>
        <div class="config-details">
          <div><span class="label">Command:</span> <code>{config.command}</code></div>
          {#if config.model}
            <div><span class="label">Model:</span> {config.model}</div>
          {/if}
          {#if config.fallbackConfigId}
            <div><span class="label">Fallback:</span> <code>{config.fallbackConfigId}</code></div>
          {/if}
          <div><span class="label">Max turns:</span> {config.maxTurns}</div>
          <div><span class="label">Priority:</span> {config.priority}</div>
        </div>
        <div class="config-actions">
          <button type="button" class="btn-small" onclick={() => startEdit(config)}>Edit</button>
          <button type="button" class="btn-small btn-danger" onclick={() => deleteConfig(config)}>Delete</button>
        </div>
      </div>
    {/each}
  </div>
</div>

<ConfirmDialog
  open={confirmDeleteOpen}
  title="Delete Agent Config"
  message={`Delete agent config "${pendingDeleteConfig?.name ?? ""}"? This action cannot be undone.`}
  confirmText="Delete"
  variant="danger"
  onconfirm={doDeleteConfig}
  oncancel={() => { confirmDeleteOpen = false; }}
/>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 16px; }
  .cli-auth-notice {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: var(--font-size-sm);
    line-height: 1.5;
  }
  .cli-auth-notice p { margin: 6px 0 0; }
  .cli-auth-notice code {
    font-family: var(--font-mono);
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 6px;
  }
  .config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .config-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px; }
  .config-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .engine-badge { background: var(--bg-active); padding: 2px 8px; border-radius: 10px; font-size: var(--font-size-sm); color: var(--accent); }
  .config-details { font-size: var(--font-size-sm); color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .config-details code { font-family: var(--font-mono); background: var(--bg-base); padding: 1px 4px; border-radius: 2px; }
  .label { color: var(--text-muted); }
  .config-actions { display: flex; gap: 8px; }
  .btn-primary { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { color: var(--status-failed); }
  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 4px; }
  .field input, .field select, .field textarea { width: 100%; }
  .field.compact { margin-bottom: 8px; }
  .field .hint { margin-top: 6px; font-size: var(--font-size-sm); color: var(--text-muted); }
  .field .hint code { font-family: var(--font-mono); background: var(--bg-elevated); padding: 1px 4px; border-radius: 2px; }
  .editor-panel { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px; margin-bottom: 16px; }
  .editor-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .editor-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .local-tools { margin-bottom: 12px; padding: 10px; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: var(--bg-base); }
  .local-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .pull-progress { margin: 0 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-surface); padding: 8px; }
  .pull-progress-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
  .pull-progress-label { color: var(--text-secondary); font-size: var(--font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pull-progress-value { color: var(--text-primary); font-size: var(--font-size-sm); font-variant-numeric: tabular-nums; }
  .pull-progress-track { width: 100%; height: 8px; border-radius: 999px; background: color-mix(in oklab, var(--bg-hover) 80%, var(--bg-base)); overflow: hidden; }
  .pull-progress-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), color-mix(in oklab, var(--accent) 70%, #ffffff)); transition: width 140ms linear; }
  .btn-inline { padding: 6px 10px; font-size: var(--font-size-sm); }
  .allowlist-editor { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
  .allowlist-add { display: flex; gap: 8px; }
  .allowlist-add input { flex: 1; }
  .allowlist-list { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-surface); }
  .allow-item-wrap { border-bottom: 1px solid var(--border); }
  .allow-item-wrap:last-child { border-bottom: none; }
  .allow-item-wrap.expanded { background: var(--bg-base); }
  .allow-item { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 8px 10px; }
  .allow-actions { display: flex; align-items: center; gap: 4px; }
  .expand-toggle { font-size: 11px; padding: 2px 4px; }
  .allow-override-badge { font-size: 10px; color: var(--accent); background: color-mix(in oklab, var(--accent) 12%, transparent); border-radius: 999px; padding: 1px 5px; }
  .allow-item-settings { padding: 4px 10px 10px 34px; display: flex; flex-direction: column; gap: 6px; }
  .allow-item-settings .field { margin-bottom: 0; }
  .allow-item-settings .field span { font-size: 11px; color: var(--text-muted); }
  .allow-item-settings textarea { width: 100%; resize: vertical; font-size: var(--font-size-sm); }
  .allow-item-settings input[type="number"] { width: 120px; font-size: var(--font-size-sm); }
  .allow-checkbox { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .allow-checkbox input { width: auto; }
  .allow-model-name { font-family: var(--font-mono); font-size: var(--font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .allow-recommended { font-size: var(--font-size-sm); color: var(--accent); background: color-mix(in oklab, var(--accent) 16%, transparent); border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent); border-radius: 999px; padding: 1px 6px; }
  .allow-param { font-size: var(--font-size-sm); color: var(--text-muted); }
  .allow-status { font-size: var(--font-size-sm); color: var(--status-failed); }
  .allow-status.is-downloaded { color: var(--status-running); }
  .check-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .check-row input { width: auto; }
  .error-hint { color: var(--status-failed); margin-top: 4px; }
  .info-banner { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; margin-bottom: 8px; color: var(--text-secondary); }
  .btn-secondary { background: var(--bg-elevated); color: var(--text-secondary); padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .templates-panel { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; margin-bottom: 16px; }
  .templates-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .templates-modal { display: flex; flex-direction: column; gap: 12px; min-height: 220px; }
  .templates-list { display: flex; flex-direction: column; gap: 12px; }
  .template-card { background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; cursor: pointer; }
  .template-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent); }
  .template-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .template-desc { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4; }
  .template-meta { font-size: var(--font-size-sm); color: var(--text-muted); display: flex; gap: 12px; margin-bottom: 10px; }
  .template-meta code { font-family: var(--font-mono); background: var(--bg-elevated); padding: 1px 4px; border-radius: 2px; }
  .btn-sm-template { padding: 4px 12px; font-size: var(--font-size-sm); }
  .templates-footer { display: flex; justify-content: flex-end; gap: 8px; }
  .onboarding-panel { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; margin-bottom: 16px; }
  .onboarding-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .onboarding-title { color: var(--text-secondary); margin-bottom: 8px; }
  .onboarding-steps { margin: 0 0 10px 18px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .onboarding-steps li { margin-bottom: 4px; }
  .onboarding-links { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .onboarding-commands { display: flex; flex-direction: column; gap: 8px; }
  .onboarding-command-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px; }
  .onboarding-command-row code { font-family: var(--font-mono); font-size: var(--font-size-sm); white-space: pre-wrap; word-break: break-word; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }
.btn-icon-sm { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 6px; font-size: 14px; }
  .btn-icon-sm:hover { color: var(--status-failed); }
</style>
