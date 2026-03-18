<script lang="ts">
  import type {
    JobRuntimeOptions,
    RuntimeReasoningLevel,
    RuntimeVerificationMode,
  } from "@arkestrator/protocol";
  import { tick } from "svelte";
  import { chatStore } from "../../stores/chat.svelte";
  import { agents } from "../../stores/agents.svelte";
  import { jobs } from "../../stores/jobs.svelte";
  import { workersStore } from "../../stores/workers.svelte";
  import { bridgeContextStore } from "../../stores/bridgeContext.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { clientCoordination } from "../../stores/clientCoordination.svelte";
  import {
    api,
    type LocalModelCatalogEntry,
    type ProviderModelCatalog,
  } from "../../api/rest";

  const CONTEXT_DRAG_MIME = "application/x-arkestrator-context-item+json";

  let {
    draftPrompt,
    agentConfigId,
    priority,
    selectedWorkerNames,
    dependencyJobId,
    runtimeOptions,
    onsubmit,
    onchat,
  }: {
    draftPrompt: string;
    agentConfigId: string;
    priority: string;
    selectedWorkerNames: string[];
    dependencyJobId: string;
    runtimeOptions?: JobRuntimeOptions;
    onsubmit: (prompt: string, resolvedRuntimeOptions?: JobRuntimeOptions) => void;
    onchat: (prompt: string, resolvedRuntimeOptions?: JobRuntimeOptions) => void;
  } = $props();

  let projects = $state<Array<{ id: string; name: string }>>([]);
  let localModelCatalog = $state<LocalModelCatalogEntry[]>([]);
  let providerModelCatalogs = $state<Record<string, ProviderModelCatalog>>({});
  let localModelsLoadedKey = $state("");
  let providerCatalogsLoadedKey = $state("");
  let localModelsLoading = $state(false);

  // Fetch projects once on mount
  $effect(() => {
    if (connection.isConnected) {
      api.projects.list().then((list: any) => {
        projects = Array.isArray(list) ? list : list.projects ?? [];
      }).catch(() => {});
    }
  });

  let selectedAgent = $derived(
    agents.all.find((config) => config.id === agentConfigId),
  );
  let selectedEngine = $derived(selectedAgent?.engine ?? "");
  let showModelControl = $derived(selectedEngine !== "");

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

      // When localModelHost is "client" (default), ask the server to auto-find
      // an online worker with localLlmEnabled to discover models from.
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
      // Mark this key as attempted to avoid tight retry loops on persistent failures.
      // Users can retry with the Refresh button, and auth/session changes create a new key.
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

  // Clear model override when switching engines so stale values don't carry over
  let prevEngine = $state("");
  $effect(() => {
    if (selectedEngine !== prevEngine) {
      prevEngine = selectedEngine;
      if (runtimeOptions?.model) {
        chatStore.setRuntimeModel(undefined);
      }
    }
  });

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

  function reasoningLabel(value: string): string {
    if (value === "xhigh") return "Extreme";
    if (!value) return "Default";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  // If a persisted tab references a deleted/unknown project ID, reset to "none"
  // so submissions do not silently bind to stale project mappings.
  $effect(() => {
    const tab = chatStore.activeTab;
    if (!tab || tab.projectSelection !== "project" || !tab.projectId) return;
    if (!projects.some((project) => project.id === tab.projectId)) {
      chatStore.setProjectSelection("none");
    }
  });

  const INPUT_HEIGHT_KEY = "chat-input-height";
  const DEFAULT_HEIGHT = 160;
  const MIN_HEIGHT = 100;
  const MAX_HEIGHT = 500;

  let promptText = $state("");
  let syncedDraftPrompt = $state<string | null>(null);
  let improving = $state(false);
  let attachments = $state<Array<{
    id: string;
    name: string;
    kind: "text" | "image" | "binary";
    size: number;
  }>>([]);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let bridgeDropdownOpen = $state(false);
  let coordDropdownOpen = $state(false);
  let inputHeight = $state(loadInputHeight());
  let vDragging = $state(false);
  let promptDropActive = $state(false);

  function loadInputHeight(): number {
    try {
      const stored = localStorage.getItem(INPUT_HEIGHT_KEY);
      if (stored) {
        const h = parseInt(stored, 10);
        if (h >= MIN_HEIGHT && h <= MAX_HEIGHT) return h;
      }
    } catch {}
    return DEFAULT_HEIGHT;
  }

  function onVDragStart(e: MouseEvent) {
    e.preventDefault();
    vDragging = true;
    const startY = e.clientY;
    const startHeight = inputHeight;

    function onMove(ev: MouseEvent) {
      const delta = startY - ev.clientY;
      inputHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta));
    }

    function onUp() {
      vDragging = false;
      try { localStorage.setItem(INPUT_HEIGHT_KEY, String(inputHeight)); } catch {}
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  let connectedBridges = $derived(
    workersStore.bridges.filter((b) => b.connected),
  );

  let isAutoTarget = $derived(selectedWorkerNames.length === 0);

  let localHostname = $derived(connection.url ? new URL(connection.url).hostname : "localhost");

  interface WorkerEntry {
    name: string;
    status: "online" | "offline";
    programs: string[];
    activeBridgeCount: number;
    contextCount: number;
  }

  let workerEntries = $derived.by(() => {
    const workers = new Map<string, WorkerEntry>();

    for (const worker of workersStore.workers) {
      const name = String(worker.name ?? "").trim();
      if (!name) continue;
      workers.set(name.toLowerCase(), {
        name,
        status: worker.status === "online" ? "online" : "offline",
        programs: [...new Set((worker.knownPrograms ?? []).map((program) => String(program ?? "").trim()).filter(Boolean))],
        activeBridgeCount: 0,
        contextCount: 0,
      });
    }

    for (const bridge of connectedBridges) {
      const name = String(bridge.workerName ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = workers.get(key) ?? {
        name,
        status: "online" as const,
        programs: [],
        activeBridgeCount: 0,
        contextCount: 0,
      };
      existing.status = "online";
      existing.activeBridgeCount += 1;
      existing.contextCount += bridgeContextStore.bridges.get(bridge.id)?.items.length ?? 0;
      if (bridge.program?.trim() && !existing.programs.includes(bridge.program.trim())) {
        existing.programs = [...existing.programs, bridge.program.trim()];
      }
      workers.set(key, existing);
    }

    return [...workers.values()].sort((a, b) => {
      const aLocal = a.name.toLowerCase() === localHostname.toLowerCase() || a.name === "localhost";
      const bLocal = b.name.toLowerCase() === localHostname.toLowerCase() || b.name === "localhost";
      if (aLocal && !bLocal) return -1;
      if (!aLocal && bLocal) return 1;
      if (a.status === "online" && b.status !== "online") return -1;
      if (a.status !== "online" && b.status === "online") return 1;
      return a.name.localeCompare(b.name);
    });
  });

  let totalWorkerCount = $derived(workerEntries.length);

  let selectedCount = $derived(selectedWorkerNames.length);
  let dependencyJobs = $derived.by(() =>
    jobs.all
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 200),
  );
  let selectedDependency = $derived.by(() =>
    dependencyJobId
      ? jobs.all.find((job) => job.id === dependencyJobId)
      : undefined,
  );

  let machineLabel = $derived.by(() => {
    if (isAutoTarget) return `Auto (${totalWorkerCount})`;
    if (selectedCount === 1) {
      const workerName = selectedWorkerNames[0];
      const worker = workerEntries.find((entry) => entry.name === workerName);
      if (!worker) return workerName;
      return worker.status === "online" ? worker.name : `${worker.name} (offline)`;
    }
    return `${selectedCount} machines`;
  });

  let isAuth = $derived(connection.isAuthenticated || !!connection.apiKey);

  function dependencyLabel(job: { id: string; status: string; prompt: string; name?: string }): string {
    const title = (job.name?.trim() || job.prompt.trim() || "Untitled job").replace(/\s+/g, " ");
    const shortTitle = title.length > 46 ? `${title.slice(0, 46)}...` : title;
    return `#${job.id.slice(0, 8)} - ${shortTitle} [${job.status}]`;
  }

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

  function parseModelScale(name: string, sizeBytes?: number): number {
    const match = name.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (typeof sizeBytes === "number" && sizeBytes > 0) {
      return Number((sizeBytes / 1_000_000_000).toFixed(1));
    }
    return 0;
  }

  function chooseAutoLocalModel(prompt: string): string | undefined {
    const allowedDownloaded = localModelCatalog
      .filter((model) => model.allowed && model.downloaded)
      .map((model) => ({
        ...model,
        scale: parseModelScale(model.name, model.sizeBytes),
      }))
      .sort((a, b) => {
        if (a.scale !== b.scale) return a.scale - b.scale;
        return a.name.localeCompare(b.name);
      });

    if (allowedDownloaded.length === 0) {
      return selectedAgent?.model?.trim() || undefined;
    }

    const text = prompt.toLowerCase();
    let complexity = 0;
    if (prompt.length > 900) complexity += 2;
    if ((prompt.match(/\n/g)?.length ?? 0) > 8) complexity += 1;
    const hardKeywords = [
      "architecture",
      "refactor",
      "multi-file",
      "migration",
      "performance",
      "optimize",
      "root cause",
      "security",
      "concurrency",
      "database",
      "integration",
      "test plan",
    ];
    for (const keyword of hardKeywords) {
      if (text.includes(keyword)) complexity += 1;
    }

    if (complexity >= 3) {
      return allowedDownloaded[allowedDownloaded.length - 1]?.name;
    }
    return allowedDownloaded[0]?.name;
  }

  function resolveRuntimeOptionsForPrompt(prompt: string, mode: "chat" | "job" = "chat"): JobRuntimeOptions | undefined {
    const base = runtimeOptions ? { ...runtimeOptions } : undefined;
    if (selectedEngine !== "local-oss") return base;

    const requestedModel = base?.model?.trim().toLowerCase() ?? "";
    if (requestedModel !== "auto") return base;

    // Check user's default model preference first
    const userDefault = mode === "chat"
      ? clientCoordination.defaultChatModel
      : clientCoordination.defaultJobModel;
    if (userDefault) {
      const match = localModelCatalog.find(
        (m) => m.name === userDefault && m.allowed && m.downloaded
      );
      if (match) {
        return { ...(base ?? {}), model: match.name };
      }
    }

    const selected = chooseAutoLocalModel(prompt);
    if (!selected) {
      // Fall back to agent default model when auto cannot choose from allowlist.
      if (base) delete base.model;
      return base && Object.keys(base).length > 0 ? base : undefined;
    }
    return {
      ...(base ?? {}),
      model: selected,
    };
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Shift+Enter → Queue and Start
      e.preventDefault();
      submitJob(false);
    } else if (e.key === "Enter" && e.shiftKey) {
      // Shift+Enter → Send as chat
      e.preventDefault();
      sendChat();
    }
  }

  function sendChat() {
    if (improving) return;
    if (!promptText.trim()) return;
    const preparedPrompt = buildPromptWithAttachments(promptText.trim());
    onchat(preparedPrompt, resolveRuntimeOptionsForPrompt(preparedPrompt, "chat"));
    promptText = "";
    attachments = [];
  }

  function submitJob(paused: boolean) {
    if (improving) return;
    if (!promptText.trim()) return;
    const tab = chatStore.activeTab;
    if (tab) tab.startPaused = paused;
    const preparedPrompt = buildPromptWithAttachments(promptText.trim());
    onsubmit(preparedPrompt, resolveRuntimeOptionsForPrompt(preparedPrompt, "job"));
    promptText = "";
    attachments = [];
  }

  function isLikelyTextFile(file: File): boolean {
    if (file.type.startsWith("text/")) return true;
    const low = file.name.toLowerCase();
    return [
      ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
      ".obj", ".mtl", ".py", ".gd", ".cs", ".h", ".hpp", ".c", ".cpp", ".js", ".ts",
      ".vex", ".usda",
    ].some((ext) => low.endsWith(ext));
  }

  function triggerAttachPicker() {
    fileInput?.click();
  }

  async function onAttachFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;

    const next: typeof attachments = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      if (isLikelyTextFile(file)) {
        next.push({
          id,
          name: file.name,
          kind: "text",
          size: file.size,
        });
        continue;
      }
      if (file.type.startsWith("image/")) {
        next.push({
          id,
          name: file.name,
          kind: "image",
          size: file.size,
        });
        continue;
      }
      next.push({
        id,
        name: file.name,
        kind: "binary",
        size: file.size,
      });
    }
    attachments = [...attachments, ...next];
    input.value = "";
  }

  function removeAttachment(id: string) {
    attachments = attachments.filter((item) => item.id !== id);
  }

  function buildPromptWithAttachments(basePrompt: string): string {
    if (attachments.length === 0) return basePrompt;
    const sections: string[] = [
      basePrompt,
      "",
      "## Attached References",
      "Use these user-provided references while planning/executing the task.",
      "Attachment content is not inlined here; use filenames/type/size metadata only.",
    ];
    for (const item of attachments) {
      if (item.kind === "text") {
        sections.push(`### File: ${item.name} (${item.size} bytes)`);
        sections.push("Attached text file reference.");
      } else if (item.kind === "image") {
        sections.push(`### Image: ${item.name} (${item.size} bytes)`);
        sections.push("Attached image reference.");
      } else {
        sections.push(`### Binary: ${item.name} (${item.size} bytes)`);
        sections.push("Binary reference attached by user (not inlined).");
      }
    }
    return sections.join("\n");
  }

  function resolveImproveBridgePrograms(): string[] {
    const out = new Set<string>();
    const selected = selectedWorkerNames.length > 0
      ? workerEntries.filter((worker) => selectedWorkerNames.includes(worker.name))
      : workerEntries;
    for (const worker of selected) {
      for (const program of worker.programs) {
        out.add(program.toLowerCase());
      }
    }
    return [...out];
  }

  async function improvePrompt() {
    if (improving) return;
    const sourcePrompt = promptText.trim();
    if (!sourcePrompt || !isAuth || !agentConfigId) return;

    improving = true;
    let improvedText = "";
    try {
      await api.chat.stream(
        {
          prompt: buildPromptWithAttachments(sourcePrompt),
          agentConfigId,
          improve: true,
          bridgePrograms: resolveImproveBridgePrograms(),
          runtimeOptions,
        },
        (chunk) => {
          improvedText += chunk;
        },
      );
      const next = improvedText.trim();
      if (next) {
        promptText = next;
      }
    } catch {
      promptText = sourcePrompt;
    } finally {
      improving = false;
      textarea?.focus();
    }
  }

  // Keep local composer state and persisted tab draft in sync without letting
  // a fresh mount immediately overwrite the saved draft with the local default.
  $effect(() => {
    if (draftPrompt === syncedDraftPrompt) return;
    syncedDraftPrompt = draftPrompt;
    promptText = draftPrompt;
  });

  $effect(() => {
    if (syncedDraftPrompt === null) return;
    if (promptText === syncedDraftPrompt) return;
    syncedDraftPrompt = promptText;
    chatStore.setDraftPrompt(promptText);
  });

  function toggleWorker(workerName: string) {
    chatStore.toggleWorker(workerName);
  }

  function clearOverrides() {
    chatStore.setSelectedWorkers([]);
    bridgeDropdownOpen = false;
  }

  // --- Coordination script dropdown ---
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
    if (!target.closest(".bridge-dropdown")) {
      bridgeDropdownOpen = false;
    }
    if (!target.closest(".coordination-dropdown")) {
      coordDropdownOpen = false;
    }
  }

  function hasContextDragData(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types);
    return types.includes(CONTEXT_DRAG_MIME) || types.includes("text/x-arkestrator-context-ref");
  }

  function formatDroppedContextRef(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const index = Number((payload as any).index);
    if (!Number.isFinite(index) || index < 1) return "";
    const program = typeof (payload as any).program === "string" ? (payload as any).program.trim() : "";
    const name = typeof (payload as any).name === "string" ? (payload as any).name.trim() : "";
    if (program && name) return `@${index} [${program}:${name}]`;
    if (name) return `@${index} [${name}]`;
    return `@${index}`;
  }

  async function insertAtCursor(text: string) {
    const snippet = text.trim();
    if (!snippet) return;

    if (!textarea) {
      promptText = promptText
        ? `${promptText}${/\s$/.test(promptText) ? "" : " "}${snippet}`
        : snippet;
      return;
    }

    const start = textarea.selectionStart ?? promptText.length;
    const end = textarea.selectionEnd ?? start;
    const before = promptText.slice(0, start);
    const after = promptText.slice(end);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);

    promptText = `${before}${needsLeadingSpace ? " " : ""}${snippet}${needsTrailingSpace ? " " : ""}${after}`;

    const cursorPos = before.length + (needsLeadingSpace ? 1 : 0) + snippet.length;
    await tick();
    textarea.focus();
    textarea.setSelectionRange(cursorPos, cursorPos);
  }

  function onPromptDragEnter(e: DragEvent) {
    if (!hasContextDragData(e.dataTransfer)) return;
    e.preventDefault();
    promptDropActive = true;
  }

  function onPromptDragOver(e: DragEvent) {
    if (!hasContextDragData(e.dataTransfer)) return;
    e.preventDefault();
    promptDropActive = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onPromptDragLeave(e: DragEvent) {
    if (!promptDropActive) return;
    const related = e.relatedTarget as Node | null;
    if (textarea && related && textarea.contains(related)) return;
    promptDropActive = false;
  }

  async function onPromptDrop(e: DragEvent) {
    if (!hasContextDragData(e.dataTransfer)) return;
    e.preventDefault();
    promptDropActive = false;

    let reference = "";
    const raw = e.dataTransfer?.getData(CONTEXT_DRAG_MIME) ?? "";
    if (raw) {
      try {
        reference = formatDroppedContextRef(JSON.parse(raw));
      } catch {}
    }

    if (!reference) {
      reference = (e.dataTransfer?.getData("text/x-arkestrator-context-ref") ?? "").trim();
    }

    if (!reference) {
      const fallback = (e.dataTransfer?.getData("text/plain") ?? "").trim();
      if (fallback.startsWith("@")) {
        reference = fallback.split(/\s+/)[0];
      }
    }

    if (reference) {
      await insertAtCursor(reference);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:document onclick={handleClickOutside} />
<div class="chat-input" style="height: {inputHeight}px;">
  <button
    type="button"
    class="v-resize-handle"
    class:active={vDragging}
    aria-label="Resize chat input"
    onmousedown={onVDragStart}
  ></button>

  <div class="input-controls">
    <div class="control-group">
      <label class="control-label" for="chat-priority-select">Priority</label>
      <select
        id="chat-priority-select"
        value={priority}
        onchange={(e) => chatStore.setPriority((e.target as HTMLSelectElement).value as any)}
      >
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
    </div>

    <div class="control-group">
      <label class="control-label" for="chat-dependency-select">Depends On</label>
      <select
        id="chat-dependency-select"
        value={dependencyJobId}
        onchange={(e) => {
          const value = (e.target as HTMLSelectElement).value;
          chatStore.setDependsOnJob(value || undefined);
        }}
      >
        <option value="">None</option>
        {#if selectedDependency && !dependencyJobs.some((job) => job.id === selectedDependency.id)}
          <option value={selectedDependency.id}>{dependencyLabel(selectedDependency)}</option>
        {/if}
        {#each dependencyJobs as job (job.id)}
          <option value={job.id}>{dependencyLabel(job)}</option>
        {/each}
      </select>
    </div>

    <div class="control-group bridge-dropdown">
      <span class="control-label">Machines</span>
      <button
        class="bridge-trigger"
        class:has-overrides={!isAutoTarget}
        onclick={() => (bridgeDropdownOpen = !bridgeDropdownOpen)}
      >
        <span class="bridge-label">{machineLabel}</span>
        <span class="dropdown-arrow">{bridgeDropdownOpen ? "\u25B2" : "\u25BC"}</span>
      </button>

      {#if bridgeDropdownOpen}
        <div class="bridge-menu">
          <button class="menu-item auto-item" class:active={isAutoTarget} onclick={clearOverrides}>
            <span class="check">{isAutoTarget ? "\u2713" : ""}</span>
            <span>Auto</span>
            <span class="menu-hint">{totalWorkerCount} known</span>
          </button>

          {#if totalWorkerCount > 0}
            <div class="menu-divider"></div>
            <div class="menu-section-label">Limit to machine(s):</div>
          {/if}

          {#each workerEntries as worker (worker.name)}
            <button
              class="menu-item bridge-item worker-item"
              class:active={selectedWorkerNames.includes(worker.name)}
              class:offline={worker.status !== "online"}
              onclick={() => toggleWorker(worker.name)}
            >
              <span class="check">{selectedWorkerNames.includes(worker.name) ? "\u2713" : ""}</span>
              <span class="worker-name">{worker.name}</span>
              <span class="menu-hint">
                {worker.status === "online" ? `${worker.activeBridgeCount} live` : "offline"}
                {#if worker.programs.length > 0}
                  · {worker.programs.join(", ")}
                {/if}
              </span>
              {#if worker.contextCount > 0}
                <span class="ctx-badge">@{worker.contextCount}</span>
              {/if}
            </button>
          {/each}

          {#if totalWorkerCount === 0}
            <div class="menu-empty">No machines discovered yet</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="control-group">
      <label class="control-label" for="chat-project-select">Project</label>
      <select
        id="chat-project-select"
        value={chatStore.activeTab?.projectSelection === "project"
          ? (chatStore.activeTab?.projectId ?? "none")
          : "none"}
        onchange={(e) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === "none") {
            chatStore.setProjectSelection("none");
            return;
          }
          chatStore.setProjectSelection("project", val);
        }}
      >
        <option value="none">None</option>
        {#each projects as project (project.id)}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="input-row">
    <textarea
      bind:this={textarea}
      bind:value={promptText}
      onkeydown={handleKeydown}
      ondragenter={onPromptDragEnter}
      ondragover={onPromptDragOver}
      ondragleave={onPromptDragLeave}
      ondrop={onPromptDrop}
      class:drop-active={promptDropActive}
      readonly={improving}
      placeholder={"Type a message or prompt... (Shift+Enter to chat, Ctrl+Shift+Enter to queue)"}
    ></textarea>
  </div>
  {#if improving}
    <div class="improving-hint">Improving prompt...</div>
  {/if}

  {#if !isAuth}
    <div class="auth-warning">Log in to submit jobs</div>
  {/if}
  <div class="action-bar">
    <input
      bind:this={fileInput}
      type="file"
      multiple
      style="display: none"
      onchange={onAttachFiles}
    />
    <button
      class="btn-attach"
      onclick={triggerAttachPicker}
      disabled={improving}
      title="Attach reference files (text, OBJ, images)"
    >
      Attach
    </button>
    <button
      class="btn-send"
      onclick={sendChat}
      disabled={!promptText.trim() || !isAuth || improving}
      title={!isAuth
        ? "Log in to send messages"
        : "Send as chat message (no job created)"}
    >
      Send
    </button>
    <button
      class="btn-improve"
      onclick={improvePrompt}
      disabled={!promptText.trim() || !isAuth || !agentConfigId || improving}
      title={!isAuth ? "Log in to improve prompts" : !agentConfigId ? "Select an agent to improve prompts" : "Rewrite prompt for stronger execution quality"}
    >
      <span class="wand-icon" aria-hidden="true"></span>
      <span>{improving ? "Improving..." : "Improve"}</span>
    </button>
    <div class="action-separator"></div>
    <button
      class="btn-queue"
      onclick={() => submitJob(true)}
      disabled={!promptText.trim() || !agentConfigId || !isAuth || improving}
      title={!isAuth ? "Log in to submit jobs" : !agentConfigId ? "Select an agent to submit jobs" : "Add to job queue (paused)"}
    >
      Add to Queue
    </button>
    <button
      class="btn-queue-start"
      onclick={() => submitJob(false)}
      disabled={!promptText.trim() || !agentConfigId || !isAuth || improving}
      title={!isAuth ? "Log in to submit jobs" : !agentConfigId ? "Select an agent to submit jobs" : "Queue and start immediately"}
    >
      Queue and Start
    </button>
    <div class="runtime-controls">
      <div class="runtime-group runtime-agent-group">
        <label class="runtime-label" for="chat-agent-select">Agent</label>
        <select
          id="chat-agent-select"
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

      {#if showModelControl}
        <div class="runtime-group runtime-model-group">
          <label class="runtime-label" for="chat-model-override">Model</label>
          <div class="model-input-row">
            {#if (providerModelCatalogs[selectedEngine]?.models?.length ?? 0) > 0 && selectedEngine !== "codex"}
              <!-- Engines with known model presets get a proper dropdown -->
              <select
                id="chat-model-override"
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
              <!-- Engines without a dropdown use text input with datalist suggestions. -->
              <input
                id="chat-model-override"
                type="text"
                list="chat-model-options"
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
                  {localModelsLoading ? "…" : "↻"}
                </button>
              {/if}
              <datalist id="chat-model-options">
                {#each knownModelOptions as modelName (modelName)}
                  <option value={modelName}></option>
                {/each}
              </datalist>
            {/if}
          </div>
        </div>
      {/if}

      {#if selectedEngine === "codex"}
        <div class="runtime-group">
          <label class="runtime-label" for="chat-reasoning-select">Reasoning</label>
          <select
            id="chat-reasoning-select"
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

      <div class="runtime-group">
        <label class="runtime-label" for="chat-verification-mode-select">Verify</label>
        <select
          id="chat-verification-mode-select"
          value={runtimeOptions?.verificationMode ?? ""}
          onchange={(e) => updateRuntimeVerificationMode((e.target as HTMLSelectElement).value)}
        >
          <option value="">Default</option>
          <option value="required">Required</option>
          <option value="optional">Optional</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <div class="runtime-group runtime-verification-weight-group">
        <label class="runtime-label" for="chat-verification-weight-input">V Weight</label>
        <input
          id="chat-verification-weight-input"
          type="number"
          min="0"
          max="100"
          step="1"
          placeholder="Default"
          value={runtimeOptions?.verificationWeight ?? ""}
          onchange={(e) => updateRuntimeVerificationWeight((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="runtime-group coordination-dropdown">
        <span class="runtime-label">Coord</span>
        <button
          class="bridge-trigger"
          class:has-overrides={runtimeOptions?.coordinationScripts != null}
          onclick={() => (coordDropdownOpen = !coordDropdownOpen)}
        >
          <span class="bridge-label">
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
          <div class="bridge-menu">
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

      <div class="runtime-group runtime-jobname-group">
        <label class="runtime-label" for="chat-job-name">Name</label>
        <input
          id="chat-job-name"
          type="text"
          placeholder="Auto"
          value={chatStore.activeTab?.jobName ?? ""}
          oninput={(e) => chatStore.setJobName((e.target as HTMLInputElement).value)}
        />
      </div>
    </div>
  </div>
  {#if attachments.length > 0}
    <div class="attachment-list">
      {#each attachments as item (item.id)}
        <div class="attachment-chip">
          <span>{item.name}</span>
          <span class="attachment-kind">{item.kind}</span>
          <button class="attachment-remove" onclick={() => removeAttachment(item.id)} aria-label={`Remove ${item.name}`}>x</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chat-input {
    position: relative;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 10px 14px;
    padding-top: 14px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .v-resize-handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    cursor: row-resize;
    z-index: 10;
    background: transparent;
    transition: background 0.15s;
    border: none;
    padding: 0;
    margin: 0;
    width: 100%;
  }
  .v-resize-handle:hover,
  .v-resize-handle.active {
    background: var(--accent);
  }
  .input-controls {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .control-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .control-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
  }
  .control-group select {
    font-size: var(--font-size-sm);
    padding: 4px 6px;
    min-width: 108px;
  }
  .model-input-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .model-input-row input {
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

  /* Bridge dropdown & coordination dropdown */
  .bridge-dropdown,
  .coordination-dropdown {
    position: relative;
  }
  .bridge-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: var(--font-size-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    min-width: 140px;
  }
  .bridge-trigger:hover {
    border-color: var(--accent);
  }
  .bridge-trigger.has-overrides {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }
  .bridge-label {
    flex: 1;
    text-align: left;
  }
  .dropdown-arrow {
    font-size: 8px;
    color: inherit;
    opacity: 0.6;
  }

  .bridge-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 220px;
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
  .menu-section-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 4px 10px 2px;
    letter-spacing: 0.5px;
  }
  .bridge-item {
    padding-left: 12px;
  }
  .worker-name {
    flex: 1;
    font-weight: 500;
  }
  .ctx-badge {
    font-size: 10px;
    color: var(--accent);
    font-weight: 600;
  }
  .menu-empty {
    padding: 12px 10px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-style: italic;
  }
  .bridge-item.offline {
    opacity: 0.55;
  }
  .bridge-item.offline .worker-name {
    font-style: italic;
  }

  /* Input row — full width textarea */
  .input-row {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .input-row textarea {
    flex: 1;
    resize: none;
    font-family: var(--font-sans);
    font-size: var(--font-size-base);
    padding: 8px 10px;
    line-height: 1.4;
    min-height: 0;
  }
  .input-row textarea.drop-active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Action bar below textarea */
  .action-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    min-width: 0;
    flex-wrap: wrap;
  }
  .action-separator {
    width: 1px;
    height: 20px;
    background: var(--border);
    flex-shrink: 0;
  }
  .btn-send,
  .btn-attach,
  .btn-improve,
  .btn-queue,
  .btn-queue-start {
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    white-space: nowrap;
  }
  .btn-send {
    background: var(--accent);
    color: white;
  }
  .btn-attach {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .btn-attach:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent);
  }
  .btn-send:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn-improve {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .btn-improve:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent);
  }
  .wand-icon {
    width: 10px;
    height: 10px;
    display: inline-block;
    position: relative;
    transform: rotate(-35deg);
    border-right: 2px solid currentColor;
    border-top: 2px solid currentColor;
    opacity: 0.9;
  }
  .wand-icon::before,
  .wand-icon::after {
    content: "";
    position: absolute;
    border: 1px solid currentColor;
    border-radius: 50%;
    opacity: 0.75;
  }
  .wand-icon::before {
    width: 4px;
    height: 4px;
    top: -6px;
    right: -5px;
  }
  .wand-icon::after {
    width: 2px;
    height: 2px;
    top: -8px;
    right: -1px;
  }
  .btn-queue {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .btn-queue:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .btn-queue-start {
    background: var(--accent);
    color: white;
  }
  .btn-queue-start:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn-send:disabled,
  .btn-attach:disabled,
  .btn-improve:disabled,
  .btn-queue:disabled,
  .btn-queue-start:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .runtime-controls {
    margin-left: auto;
    display: inline-flex;
    align-items: flex-end;
    gap: 8px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    max-width: 100%;
  }
  .runtime-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .runtime-model-group {
    min-width: 170px;
  }
  .runtime-agent-group {
    min-width: 220px;
  }
  .runtime-verification-weight-group {
    width: 78px;
  }
  .runtime-jobname-group {
    min-width: 120px;
    max-width: 200px;
  }
  .runtime-group input,
  .runtime-group select {
    font-size: 11px;
    padding: 3px 6px;
    min-width: 0;
  }
  .runtime-label {
    font-size: 9px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.45px;
  }
  .auth-warning {
    font-size: 11px;
    color: var(--status-failed);
    padding: 4px 0;
    font-style: italic;
  }
  .improving-hint {
    font-size: 11px;
    color: var(--text-muted);
    animation: fade-pulse 1.1s ease-in-out infinite;
  }
  @keyframes fade-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .attachment-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    background: var(--bg-base);
  }
  .attachment-kind {
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 10px;
  }
  .attachment-remove {
    color: var(--text-muted);
    font-size: 11px;
    border: none;
    background: transparent;
    padding: 0 2px;
  }
  .attachment-remove:hover {
    color: var(--status-failed);
  }
</style>
