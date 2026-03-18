<script lang="ts">
  import { connection } from "../lib/stores/connection.svelte";
  import { clientCoordination } from "../lib/stores/clientCoordination.svelte";
  import { nav } from "../lib/stores/navigation.svelte";
  import { connect, disconnect } from "../lib/api/ws";
  import {
    api,
    type LocalModelCatalogEntry,
    type LocalModelsResponse,
  } from "../lib/api/rest";
  import { isLoopbackUrl, serverState } from "../lib/stores/server.svelte";
  import {
    disable as disableAutostart,
    enable as enableAutostart,
    isEnabled as isAutostartEnabled,
  } from "@tauri-apps/plugin-autostart";
  import { invoke } from "@tauri-apps/api/core";
  import ServerManager from "../lib/components/ServerManager.svelte";
  import BridgeInstaller from "../lib/components/BridgeInstaller.svelte";
  import TotpSetupModal from "../lib/components/ui/TotpSetupModal.svelte";
  let { showOnlyCoordinator = false }: { showOnlyCoordinator?: boolean } = $props();

  const saved = connection.loadSaved();
  let serverUrl = $state(saved.url || serverState.localUrl);
  let username = $state(connection.lastUsername || "");
  let password = $state("");
  let testResult = $state("");
  let loginResult = $state("");
  let launchOnStartup = $state(false);
  let launchOnStartupLoading = $state(false);
  let launchOnStartupResult = $state("");
  let launchOnStartupLoaded = false;

  // Account section
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let pwChanging = $state(false);
  let pwResult = $state("");
  let pwError = $state("");

  // 2FA
  let showTotpSetup = $state(false);
  let totpDisabling = $state(false);
  let totpDisablePassword = $state("");
  let totpDisableCode = $state("");
  let totpDisableError = $state("");
  let showDisable2fa = $state(false);

  // Coordinator scripts (admin only)
  interface CoordinatorScript {
    program: string;
    content: string;
    isDefault: boolean;
    defaultContent: string;
  }
  const COORD_LABELS: Record<string, string> = {
    global: "Global",
    blender: "Blender",
    godot: "Godot",
    houdini: "Houdini",
    comfyui: "ComfyUI",
    unity: "Unity",
    unreal: "Unreal",
  };
  let coordScripts = $state<CoordinatorScript[]>([]);
  let coordSelected = $state("global");
  let coordDraft = $state("");
  let coordSaving = $state(false);
  let coordLoaded = $state(false);
  let coordError = $state("");
  let coordTab = $state<"scripts" | "playbook" | "server_resources" | "client_resources">("playbook");
  let coordinatorProgram = $state("houdini");
  let playbookLoaded = $state(false);
  let playbookManifest = $state("");
  let playbookSaving = $state(false);
  let playbookError = $state("");
  let playbookFiles = $state<string[]>([]);
  let playbookFilePath = $state("tasks/new_task.md");
  let playbookFileContent = $state("");
  let playbookFileSaving = $state(false);
  let playbookFileLoading = $state(false);
  let referencePathsLoaded = $state(false);
  let referencePathsInput = $state("");
  let defaultReferencePaths = $state<string[]>([]);
  let newReferencePath = $state("");
  let playbookSourcesLoaded = $state(false);
  let playbookSourcePathsInput = $state("");
  let defaultPlaybookSourcePaths = $state<string[]>([]);
  let newPlaybookSourcePath = $state("");
  let newPlaybookSourceAutoAnalyze = $state(true);
  let referencePathsSaving = $state(false);
  let playbookSourcesSaving = $state(false);
  let playbookSourceAdding = $state(false);
  let playbookSourceResult = $state("");
  let clientResourcePathsLoaded = $state(false);
  let clientResourcePaths = $state<string[]>([]);
  let newClientResourcePath = $state("");
  let selectedClientResourcePath = $state("");
  let promoteClientResourceAutoAnalyze = $state(true);
  let promoteClientResourceSaving = $state(false);
  let clientResourceResult = $state("");
  let clientResourceUploadFiles = $state<File[]>([]);
  let clientResourceUploadRelPaths = $state<string[]>([]);
  let clientResourceUploadTargetDir = $state("imports/client");
  let clientResourceUploadSaving = $state(false);
  let clientResourceUploadAutoAddSource = $state(true);
  let clientResourceUploadAutoAnalyze = $state(false);
  let clientResourceUploadResult = $state("");
  let uploadTargetDir = $state("examples/houdini/pyro");
  let uploadFiles = $state<File[]>([]);
  let uploadSaving = $state(false);
  let uploadResult = $state("");
  let addRefTaskId = $state("");
  let addRefFolderPath = $state("");
  let addRefSaving = $state(false);
  let addRefResult = $state("");
  let addRepoUrl = $state("");
  let addRepoBranch = $state("");
  let addRepoSubPath = $state("");
  let addRepoSaving = $state(false);
  let addRepoResult = $state("");
  let coordinatorEditorsInput = $state("");
  let coordinatorEditorsLoaded = $state(false);
  let coordinatorEditorsSaving = $state(false);
  let canManageCoordinator = $derived(connection.canEditCoordinator || connection.userRole === "admin");
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
  let coordScriptEditing = $state(false);
  let allowlistDirty = $state(false);
  let allowlistSaving = $state(false);
  let clientOllamaUrlDraft = $state(clientCoordination.ollamaBaseUrl);
  let defaultChatModelDraft = $state(clientCoordination.defaultChatModel);
  let defaultJobModelDraft = $state(clientCoordination.defaultJobModel);
  const CLIENT_RESOURCE_PATHS_STORAGE_KEY = "arkestrator-client-resource-paths";

  $effect(() => {
    if (!showOnlyCoordinator && !launchOnStartupLoaded) {
      launchOnStartupLoaded = true;
      void loadLaunchOnStartup();
    }
  });

  $effect(() => {
    // Load scripts once user is confirmed admin
    if (connection.userRole === "admin" && !coordLoaded) {
      loadCoordScripts();
    }
  });

  $effect(() => {
    if (canManageCoordinator && !playbookLoaded) {
      loadPlaybook();
    }
    if (canManageCoordinator && !referencePathsLoaded) {
      loadCoordinatorReferencePaths();
    }
    if (canManageCoordinator && !playbookSourcesLoaded) {
      loadCoordinatorPlaybookSources();
    }
    if (canManageCoordinator && !clientResourcePathsLoaded) {
      loadClientResourcePaths();
    }
    if (connection.userRole === "admin" && !coordinatorEditorsLoaded) {
      loadCoordinatorEditors();
    }
  });

  $effect(() => {
    if (connection.isAuthenticated && connection.allowClientCoordination) {
      clientCoordination.probeIfStale();
    }
  });

  $effect(() => {
    if (
      connection.isAuthenticated
      && !showOnlyCoordinator
      && !localModelsLoading
      && !localModelsLoaded
    ) {
      void loadLocalModels();
    }
  });

  $effect(() => {
    if (
      connection.isAuthenticated
      && connection.userRole === "admin"
      && !showOnlyCoordinator
      && !serverLocalLlmLoaded
    ) {
      void loadServerLocalLlmSettings();
    }
  });

  $effect(() => {
    if (coordTab !== "scripts") {
      coordScriptEditing = false;
    }
  });

  $effect(() => {
    const s = coordScripts.find((s) => s.program === coordSelected);
    if (s) coordDraft = s.content;
  });

  async function loadCoordScripts() {
    try {
      const result = await api.settings.getCoordinatorScripts();
      coordScripts = result.scripts ?? [];
      const first = coordScripts.find((s) => s.program === "global");
      if (first) coordDraft = first.content;
      coordLoaded = true;
    } catch (err: any) {
      coordError = `Failed to load scripts: ${err.message}`;
    }
  }

  async function saveCoordScript() {
    coordSaving = true;
    try {
      await api.settings.setCoordinatorScript(coordSelected, coordDraft);
      const idx = coordScripts.findIndex((s) => s.program === coordSelected);
      if (idx >= 0) {
        coordScripts[idx].content = coordDraft;
        coordScripts[idx].isDefault = coordDraft.trim() === coordScripts[idx].defaultContent.trim();
      }
      coordScriptEditing = false;
    } catch (err: any) {
      coordError = `Save failed: ${err.message}`;
    } finally {
      coordSaving = false;
    }
  }

  async function resetCoordScript() {
    try {
      const result = await api.settings.resetCoordinatorScript(coordSelected);
      coordDraft = result.content ?? "";
      const idx = coordScripts.findIndex((s) => s.program === coordSelected);
      if (idx >= 0) {
        coordScripts[idx].content = coordDraft;
        coordScripts[idx].isDefault = true;
      }
      coordScriptEditing = false;
    } catch (err: any) {
      coordError = `Reset failed: ${err.message}`;
    }
  }

  function coordIsModified() {
    const s = coordScripts.find((s) => s.program === coordSelected);
    return s ? coordDraft.trim() !== s.defaultContent.trim() : false;
  }

  function getPlaybookTaskIds(): string[] {
    try {
      const parsed = JSON.parse(playbookManifest);
      if (!Array.isArray(parsed.tasks)) return [];
      return parsed.tasks
        .map((t: any) => String(t?.id ?? "").trim())
        .filter((id: string) => !!id);
    } catch {
      return [];
    }
  }

  async function loadPlaybook() {
    playbookError = "";
    playbookLoaded = false;
    try {
      const result = await api.settings.getCoordinatorPlaybook(coordinatorProgram);
      playbookManifest = result.manifest || "{\n  \"version\": 1,\n  \"program\": \"" + coordinatorProgram + "\",\n  \"tasks\": []\n}";
      playbookFiles = Array.isArray(result.files)
        ? result.files.filter((f: unknown) => typeof f === "string")
        : [];
      if (!playbookFiles.includes(playbookFilePath)) {
        playbookFilePath = playbookFiles.find((f) => f.startsWith("tasks/")) ?? "tasks/new_task.md";
      }
      const ids = getPlaybookTaskIds();
      if (ids.length > 0 && !ids.includes(addRefTaskId)) addRefTaskId = ids[0];
      playbookLoaded = true;
    } catch (err: any) {
      playbookError = `Failed to load playbook: ${err.message ?? err}`;
    }
  }

  async function savePlaybookManifest() {
    playbookSaving = true;
    playbookError = "";
    try {
      await api.settings.setCoordinatorPlaybookManifest(coordinatorProgram, playbookManifest);
      playbookLoaded = true;
      const ids = getPlaybookTaskIds();
      if (ids.length > 0 && !ids.includes(addRefTaskId)) addRefTaskId = ids[0];
    } catch (err: any) {
      playbookError = `Save manifest failed: ${err.message ?? err}`;
    } finally {
      playbookSaving = false;
    }
  }

  async function savePlaybookFile() {
    if (!playbookFilePath.trim()) {
      playbookError = "Provide a relative path like tasks/my_task.md";
      return;
    }
    playbookFileSaving = true;
    playbookError = "";
    try {
      await api.settings.saveCoordinatorPlaybookFile(
        coordinatorProgram,
        playbookFilePath,
        playbookFileContent,
      );
      await loadPlaybook();
    } catch (err: any) {
      playbookError = `Save file failed: ${err.message ?? err}`;
    } finally {
      playbookFileSaving = false;
    }
  }

  async function loadPlaybookFileFromServer() {
    if (!playbookFilePath.trim()) {
      playbookError = "Select or enter a playbook file path first.";
      return;
    }
    playbookFileLoading = true;
    playbookError = "";
    try {
      const result = await api.settings.getCoordinatorPlaybookFile(
        coordinatorProgram,
        playbookFilePath.trim(),
      );
      playbookFilePath = result.path ?? playbookFilePath.trim();
      playbookFileContent = result.content ?? "";
    } catch (err: any) {
      playbookError = `Load file failed: ${err.message ?? err}`;
    } finally {
      playbookFileLoading = false;
    }
  }

  async function loadCoordinatorReferencePaths() {
    try {
      const result = await api.settings.getCoordinatorReferencePaths();
      referencePathsInput = (result.paths ?? []).join("\n");
      defaultReferencePaths = result.defaultPaths ?? [];
      referencePathsLoaded = true;
    } catch (err: any) {
      playbookError = `Failed to load reference paths: ${err.message ?? err}`;
    }
  }

  async function loadCoordinatorPlaybookSources() {
    try {
      const result = await api.settings.getCoordinatorPlaybookSources();
      playbookSourcePathsInput = (result.paths ?? []).join("\n");
      defaultPlaybookSourcePaths = result.defaultPaths ?? [];
      playbookSourcesLoaded = true;
    } catch (err: any) {
      playbookError = `Failed to load playbook source paths: ${err.message ?? err}`;
    }
  }

  async function loadCoordinatorEditors() {
    try {
      const result = await api.settings.getCoordinatorEditors();
      coordinatorEditorsInput = (result.userIds ?? []).join("\n");
      coordinatorEditorsLoaded = true;
    } catch (err: any) {
      playbookError = `Failed to load coordinator editors: ${err.message ?? err}`;
    }
  }

  async function saveCoordinatorReferencePaths() {
    referencePathsSaving = true;
    playbookError = "";
    try {
      const paths = parseReferencePathsInput();
      await api.settings.setCoordinatorReferencePaths(paths);
      referencePathsInput = paths.join("\n");
    } catch (err: any) {
      playbookError = `Save paths failed: ${err.message ?? err}`;
    } finally {
      referencePathsSaving = false;
    }
  }

  async function saveCoordinatorPlaybookSources() {
    playbookSourcesSaving = true;
    playbookError = "";
    try {
      const paths = parsePlaybookSourcePathsInput();
      await api.settings.setCoordinatorPlaybookSources(paths);
      playbookSourcePathsInput = paths.join("\n");
    } catch (err: any) {
      playbookError = `Save playbook sources failed: ${err.message ?? err}`;
    } finally {
      playbookSourcesSaving = false;
    }
  }

  async function saveCoordinatorEditors() {
    coordinatorEditorsSaving = true;
    playbookError = "";
    try {
      const userIds = coordinatorEditorsInput
        .split(/\r?\n/)
        .map((id) => id.trim())
        .filter(Boolean);
      await api.settings.setCoordinatorEditors(userIds);
    } catch (err: any) {
      playbookError = `Save editors failed: ${err.message ?? err}`;
    } finally {
      coordinatorEditorsSaving = false;
    }
  }

  function onUploadFilesChanged(e: Event) {
    const input = e.target as HTMLInputElement;
    uploadFiles = input.files ? Array.from(input.files) : [];
  }

  function parseReferencePathsInput(): string[] {
    return [...new Set(
      referencePathsInput
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    )];
  }

  function addReferencePathLine() {
    const path = newReferencePath.trim();
    if (!path) return;
    const next = parseReferencePathsInput();
    if (!next.includes(path)) next.push(path);
    referencePathsInput = next.join("\n");
    newReferencePath = "";
  }

  function parsePlaybookSourcePathsInput(): string[] {
    return [...new Set(
      playbookSourcePathsInput
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    )];
  }

  function addPlaybookSourcePathLine() {
    const path = newPlaybookSourcePath.trim();
    if (!path) return;
    const next = parsePlaybookSourcePathsInput();
    if (!next.includes(path)) next.push(path);
    playbookSourcePathsInput = next.join("\n");
    newPlaybookSourcePath = "";
  }

  function loadClientResourcePaths() {
    try {
      const raw = localStorage.getItem(CLIENT_RESOURCE_PATHS_STORAGE_KEY);
      if (!raw) {
        clientResourcePaths = [];
      } else {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          clientResourcePaths = parsed
            .map((p) => String(p).trim())
            .filter(Boolean);
        } else {
          clientResourcePaths = [];
        }
      }
      if (clientResourcePaths.length > 0 && !selectedClientResourcePath) {
        selectedClientResourcePath = clientResourcePaths[0];
      }
      clientResourcePathsLoaded = true;
    } catch {
      clientResourcePaths = [];
      clientResourcePathsLoaded = true;
    }
  }

  function saveClientResourcePaths() {
    const payload = JSON.stringify(clientResourcePaths);
    localStorage.setItem(CLIENT_RESOURCE_PATHS_STORAGE_KEY, payload);
  }

  function addClientResourcePath() {
    const path = newClientResourcePath.trim();
    if (!path) return;
    if (!clientResourcePaths.includes(path)) {
      clientResourcePaths = [...clientResourcePaths, path];
      saveClientResourcePaths();
    }
    if (!selectedClientResourcePath) selectedClientResourcePath = path;
    newClientResourcePath = "";
  }

  function removeClientResourcePath(path: string) {
    clientResourcePaths = clientResourcePaths.filter((p) => p !== path);
    if (selectedClientResourcePath === path) {
      selectedClientResourcePath = clientResourcePaths[0] ?? "";
    }
    saveClientResourcePaths();
  }

  async function promoteClientResourcePathToServerSource() {
    if (!selectedClientResourcePath) {
      clientResourceResult = "Select a client resource path first.";
      return;
    }

    promoteClientResourceSaving = true;
    clientResourceResult = "";
    playbookError = "";
    try {
      const result = await api.settings.addCoordinatorPlaybookSource(
        coordinatorProgram,
        selectedClientResourcePath,
        promoteClientResourceAutoAnalyze,
      );
      playbookSourcePathsInput = (result.paths ?? []).join("\n");
      clientResourceResult = "Path promoted to server playbook sources.";
      await loadPlaybook();
      await loadCoordinatorPlaybookSources();
    } catch (err: any) {
      clientResourceResult = `Promote failed: ${err.message ?? err}`;
    } finally {
      promoteClientResourceSaving = false;
    }
  }

  function onClientResourceFolderUploadChanged(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    clientResourceUploadFiles = files;
    clientResourceUploadRelPaths = files.map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      return (rel && rel.trim()) ? rel : f.name;
    });
  }

  async function uploadClientResourcesToServer() {
    if (clientResourceUploadFiles.length === 0) {
      clientResourceUploadResult = "Select a folder first.";
      return;
    }

    const targetDir = clientResourceUploadTargetDir.trim() || `imports/client/${Date.now().toString(36)}`;
    clientResourceUploadSaving = true;
    clientResourceUploadResult = "";
    playbookError = "";

    try {
      const uploaded = await api.settings.uploadCoordinatorPlaybookFiles(
        coordinatorProgram,
        targetDir,
        clientResourceUploadFiles,
        clientResourceUploadRelPaths,
      );

      let message = `Uploaded ${uploaded.files?.length ?? clientResourceUploadFiles.length} file(s) to server.`;
      if (clientResourceUploadAutoAddSource) {
        const added = await api.settings.addCoordinatorPlaybookSource(
          coordinatorProgram,
          targetDir,
          clientResourceUploadAutoAnalyze,
        );
        playbookSourcePathsInput = (added.paths ?? []).join("\n");
        message += clientResourceUploadAutoAnalyze
          ? ` Added source with auto-analysis (${added.generatedTaskCount ?? 0} task(s)).`
          : " Added source path.";
      }

      clientResourceUploadResult = message;
      await loadPlaybook();
      await loadCoordinatorPlaybookSources();
      clientResourceUploadFiles = [];
      clientResourceUploadRelPaths = [];
    } catch (err: any) {
      clientResourceUploadResult = `Upload failed: ${err.message ?? err}`;
    } finally {
      clientResourceUploadSaving = false;
    }
  }

  async function removePlaybookSourcePath(path: string) {
    const next = parsePlaybookSourcePathsInput().filter((p) => p !== path);
    playbookSourcePathsInput = next.join("\n");
    try {
      await api.settings.setCoordinatorPlaybookSources(next);
      playbookSourceResult = "Source removed.";
    } catch (err: any) {
      playbookSourceResult = `Remove source failed: ${err.message ?? err}`;
    }
  }

  async function addPlaybookSource() {
    const path = newPlaybookSourcePath.trim();
    if (!path) {
      playbookSourceResult = "Enter a folder or JSON path first.";
      return;
    }

    playbookSourceAdding = true;
    playbookSourceResult = "";
    playbookError = "";
    try {
      const result = await api.settings.addCoordinatorPlaybookSource(
        coordinatorProgram,
        path,
        newPlaybookSourceAutoAnalyze,
      );
      playbookSourcePathsInput = (result.paths ?? []).join("\n");
      newPlaybookSourcePath = "";
      playbookSourceResult = newPlaybookSourceAutoAnalyze
        ? `Added source with auto-analysis (${result.generatedTaskCount ?? 0} task(s) generated).`
        : "Added source path.";
      await loadPlaybook();
    } catch (err: any) {
      playbookSourceResult = `Add source failed: ${err.message ?? err}`;
    } finally {
      playbookSourceAdding = false;
    }
  }

  async function uploadCoordinatorFiles() {
    if (uploadFiles.length === 0) {
      uploadResult = "Select one or more files first.";
      return;
    }
    uploadSaving = true;
    uploadResult = "";
    try {
      const result = await api.settings.uploadCoordinatorPlaybookFiles(
        coordinatorProgram,
        uploadTargetDir,
        uploadFiles,
      );
      uploadResult = `Uploaded ${result.files?.length ?? uploadFiles.length} file(s).`;
      uploadFiles = [];
      await loadPlaybook();
    } catch (err: any) {
      uploadResult = `Upload failed: ${err.message ?? err}`;
    } finally {
      uploadSaving = false;
    }
  }

  async function addReferenceFolder() {
    addRefSaving = true;
    addRefResult = "";
    try {
      await api.settings.addCoordinatorReferenceFolder(
        coordinatorProgram,
        addRefTaskId,
        addRefFolderPath,
      );
      addRefResult = "Reference folder added to playbook task.";
      await loadPlaybook();
    } catch (err: any) {
      addRefResult = `Add folder failed: ${err.message ?? err}`;
    } finally {
      addRefSaving = false;
    }
  }

  async function addReferenceRepo() {
    if (!addRefTaskId || !addRepoUrl.trim()) {
      addRepoResult = "Select a task ID and provide a GitHub repository URL.";
      return;
    }

    addRepoSaving = true;
    addRepoResult = "";
    try {
      const result = await api.settings.addCoordinatorReferenceRepo(
        coordinatorProgram,
        addRefTaskId,
        addRepoUrl.trim(),
        addRepoBranch.trim() || undefined,
        addRepoSubPath.trim() || undefined,
      );
      addRepoResult = result.clonedNow
        ? `Repository cloned and attached at ${result.exampleRef}.`
        : `Repository already cached, attached at ${result.exampleRef}.`;
      await loadPlaybook();
    } catch (err: any) {
      addRepoResult = `Add repository failed: ${err.message ?? err}`;
    } finally {
      addRepoSaving = false;
    }
  }

  async function testConnection() {
    testResult = "Testing...";
    connection.url = serverUrl;
    try {
      const health = await api.health();
      testResult = `OK - Server v${health.version}, uptime ${health.uptime}s`;
    } catch (err) {
      testResult = `Failed: ${err}`;
    }
  }

  async function login() {
    loginResult = "Logging in...";
    connection.url = serverUrl;
    try {
      const result = await api.auth.login(username, password);
      connection.sessionToken = result.token;
      connection.username = result.user.username;
      connection.lastUsername = result.user.username;
      connection.userRole = result.user.role;
      connection.allowClientCoordination = !!result.allowClientCoordination;
      connection.clientCoordinationEnabled = !!result.user.clientCoordinationEnabled;
      connection.canEditCoordinator = !!result.canEditCoordinator;
      serverLocalLlmLoaded = false;
      connection.saveSession();
      loginResult = `Logged in as ${result.user.username} (${result.user.role})`;
      // Auto-connect WS with the provisioned API key
      if (result.apiKey && !connection.isConnected) {
        connect(serverUrl, result.apiKey);
      }
      if (connection.allowClientCoordination) {
        clientCoordination.probeIfStale();
      }
    } catch (err) {
      loginResult = `Login failed: ${err}`;
    }
  }

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

  let availableLocalModels = $derived(
    localCatalog.filter((m: any) => m.allowed && m.downloaded)
  );

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

  function disconnectWs() {
    disconnect();
  }

  async function loadLaunchOnStartup() {
    try {
      launchOnStartup = await isAutostartEnabled();
      launchOnStartupResult = "";
    } catch {
      launchOnStartupResult = "System startup control is only available in the desktop app.";
    }
  }

  async function setLaunchOnStartup(enabled: boolean) {
    launchOnStartupLoading = true;
    launchOnStartupResult = "";
    try {
      if (enabled) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }
      launchOnStartup = await isAutostartEnabled();
    } catch (err: any) {
      launchOnStartupResult = `Startup preference failed: ${err?.message ?? err}`;
      launchOnStartup = !enabled;
    } finally {
      launchOnStartupLoading = false;
    }
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

  function signOut() {
    disconnect();
    connection.signOut();
    serverLocalLlmLoaded = false;
    serverLocalLlmBaseUrlDraft = "";
    serverLocalLlmEffectiveBaseUrl = "http://127.0.0.1:11434";
    serverLocalLlmSource = "default";
    localRuntimeSource = "client";
    localModelSourceLabel = "Client";
  }

  async function changePassword() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      pwError = "All fields are required";
      return;
    }
    if (newPassword !== confirmPassword) {
      pwError = "New passwords do not match";
      return;
    }
    pwError = "";
    pwResult = "";
    pwChanging = true;
    try {
      await api.auth.changePassword(currentPassword, newPassword, confirmPassword);
      pwResult = "Password changed successfully.";
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
    } catch (err: any) {
      pwError = err?.message ?? "Failed to change password";
    } finally {
      pwChanging = false;
    }
  }

  async function disable2fa() {
    if (!totpDisablePassword) {
      totpDisableError = "Password is required";
      return;
    }
    totpDisableError = "";
    totpDisabling = true;
    try {
      await api.auth.totpDisable(totpDisablePassword, totpDisableCode || undefined);
      connection.totpEnabled = false;
      connection.saveSession();
      showDisable2fa = false;
      totpDisablePassword = "";
      totpDisableCode = "";
    } catch (err: any) {
      totpDisableError = err?.message ?? "Failed to disable 2FA";
    } finally {
      totpDisabling = false;
    }
  }

</script>

<div class="settings-page" class:coordinator-only={showOnlyCoordinator}>
  <h2>{showOnlyCoordinator ? "Coordinator" : "Settings"}</h2>

  {#if !showOnlyCoordinator && (connection.serverMode === "local" || isLoopbackUrl(connection.url))}
    <ServerManager />
  {/if}

  {#if !showOnlyCoordinator}
    <section>
      <h3>Server Connection</h3>
      <div class="form-group">
        <label>
          Server URL
          <input bind:value={serverUrl} placeholder={serverState.localUrl} />
        </label>
        <div class="btn-group">
          <button class="btn" onclick={testConnection}>Test Connection</button>
          {#if connection.isConnected}
            <button class="btn danger" onclick={disconnectWs}>Disconnect</button>
          {/if}
        </div>
        {#if testResult}
          <span class="result">{testResult}</span>
        {/if}
        <span class="status">
          Status: <strong>{connection.status}</strong>
        </span>
      </div>
    </section>
  {/if}

  {#if !showOnlyCoordinator && !connection.isAuthenticated}
    <section>
      <h3>Authentication</h3>
      <div class="form-group">
        <label>
          Username
          <input bind:value={username} placeholder="admin" />
        </label>
        <label>
          Password
          <input type="password" bind:value={password} placeholder="password" />
        </label>
        <button class="btn" onclick={login}>Login</button>
        {#if loginResult}
          <span class="result">{loginResult}</span>
        {/if}
      </div>
    </section>
  {/if}

  {#if connection.isAuthenticated && !showOnlyCoordinator}
    <section>
      <h3>Current Session</h3>
      <p>Logged in as <strong>{connection.username}</strong> ({connection.userRole})</p>
      <button class="btn danger" onclick={signOut} style="margin-top: 8px;">Sign Out</button>
    </section>

    <section>
      <h3>Account</h3>

      <div class="account-subsection">
        <h4>Change Password</h4>
        <div class="form-group">
          <label>
            Current Password
            <input type="password" bind:value={currentPassword} placeholder="Current password" autocomplete="current-password" />
          </label>
          <label>
            New Password
            <input type="password" bind:value={newPassword} placeholder="New password" autocomplete="new-password" />
          </label>
          <label>
            Confirm New Password
            <input type="password" bind:value={confirmPassword} placeholder="Confirm new password" autocomplete="new-password" />
          </label>
          <button class="btn" onclick={changePassword} disabled={pwChanging}>
            {pwChanging ? "Changing..." : "Change Password"}
          </button>
          {#if pwError}
            <span class="result error-text">{pwError}</span>
          {/if}
          {#if pwResult}
            <span class="result success-text">{pwResult}</span>
          {/if}
        </div>
      </div>

      <div class="account-subsection">
        <h4>Two-Factor Authentication</h4>
        {#if connection.totpEnabled}
          <p class="status-line"><span class="status-badge enabled">Enabled</span> Two-factor authentication is active on your account.</p>
          {#if !showDisable2fa}
            <button class="btn danger" onclick={() => showDisable2fa = true}>Disable 2FA</button>
          {:else}
            <div class="form-group disable-2fa-form">
              <label>
                Password
                <input type="password" bind:value={totpDisablePassword} placeholder="Current password" />
              </label>
              <label>
                TOTP Code
                <input bind:value={totpDisableCode} placeholder="6-digit code" inputmode="numeric" maxlength="8" />
              </label>
              {#if totpDisableError}
                <span class="result error-text">{totpDisableError}</span>
              {/if}
              <div class="btn-group">
                <button class="btn" onclick={() => { showDisable2fa = false; totpDisableError = ""; totpDisablePassword = ""; totpDisableCode = ""; }}>Cancel</button>
                <button class="btn danger" onclick={disable2fa} disabled={totpDisabling}>
                  {totpDisabling ? "Disabling..." : "Confirm Disable"}
                </button>
              </div>
            </div>
          {/if}
        {:else}
          <p class="status-line"><span class="status-badge disabled">Disabled</span> Add an extra layer of security to your account.</p>
          <button class="btn" onclick={() => showTotpSetup = true}>Enable 2FA</button>
        {/if}
      </div>
    </section>

    <TotpSetupModal
      open={showTotpSetup}
      forced={false}
      onclose={() => showTotpSetup = false}
      oncomplete={() => {
        showTotpSetup = false;
        connection.totpEnabled = true;
        connection.saveSession();
      }}
    />

    <section class="prefs-section">
      <h3>Preferences</h3>
      <div class="prefs-grid">
        <div class="pref-card">
          <div class="pref-card-header">Worker Mode</div>
          <p class="desc">
            When enabled, other machines can route jobs to your bridges.
            When disabled, only your own jobs can use your local bridges.
          </p>
          <div class="pref-toggles">
            <label class="toggle-label">
              <input
                type="checkbox"
                checked={connection.workerModeEnabled}
                onchange={(e: Event) => {
                  connection.workerModeEnabled = (e.target as HTMLInputElement).checked;
                  connection.saveSession();
                  if (connection.url && connection.apiKey) {
                    disconnect();
                    void connect(connection.url, connection.apiKey);
                  }
                }}
              />
              <span>Available as worker for other machines</span>
            </label>
            <label class="toggle-label">
              <input
                type="checkbox"
                checked={launchOnStartup}
                disabled={launchOnStartupLoading}
                onchange={(e) => setLaunchOnStartup((e.target as HTMLInputElement).checked)}
              />
              <span>Launch Arkestrator on system startup</span>
            </label>
            {#if launchOnStartupResult}
              <span class="result">{launchOnStartupResult}</span>
            {/if}
          </div>
        </div>

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
      </div>
    </section>

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
            {localModelsLoading ? "Refreshing..." : "Refresh Catalog"}
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
  {/if}

  {#if !showOnlyCoordinator}
    <BridgeInstaller />
  {/if}

  {#if canManageCoordinator && showOnlyCoordinator}
    <section>
      <h3>Coordinator</h3>
      <p class="desc">
        Manage bridge coordination assets from one place: prompts, task playbooks, uploaded examples,
        and path references for local/NAS shares.
      </p>
      {#if coordError}
        <div class="error">{coordError}</div>
      {/if}
      {#if playbookError}
        <div class="error">{playbookError}</div>
      {/if}
      <div class="coord-workspace">
        <aside class="coord-rail">
          <div class="coord-tabs coord-tabs-rail">
            {#if connection.userRole === "admin"}
              <button class="coord-tab" class:active={coordTab === "scripts"} onclick={() => (coordTab = "scripts")}>
                Scripts
              </button>
            {/if}
            <button class="coord-tab" class:active={coordTab === "playbook"} onclick={() => (coordTab = "playbook")}>
              Playbook
            </button>
            <button class="coord-tab" class:active={coordTab === "server_resources"} onclick={() => (coordTab = "server_resources")}>
              Server Resources
            </button>
            <button class="coord-tab" class:active={coordTab === "client_resources"} onclick={() => (coordTab = "client_resources")}>
              Client Resources
            </button>
          </div>

          {#if coordTab !== "scripts" || connection.userRole !== "admin"}
            <div class="coord-toolbar coord-toolbar-rail">
              <label>
                Program
                <select bind:value={coordinatorProgram} onchange={() => loadPlaybook()}>
                  <option value="houdini">Houdini</option>
                  <option value="blender">Blender</option>
                  <option value="godot">Godot</option>
                  <option value="unity">Unity</option>
                  <option value="unreal">Unreal</option>
                  <option value="comfyui">ComfyUI</option>
                  <option value="global">Global</option>
                </select>
              </label>
              <button class="btn secondary" onclick={loadPlaybook}>
                Refresh Program Data
              </button>
            </div>
          {/if}

          {#if coordTab === "scripts" && connection.userRole === "admin"}
            <div class="coord-rail-block">
              <p class="desc">Script target</p>
              {#if !coordLoaded}
                <div class="result">Loading scripts...</div>
              {:else if coordScripts.length === 0}
                <div class="result">No scripts found.</div>
              {:else}
                <label>
                  Target
                  <select bind:value={coordSelected}>
                    {#each coordScripts as s}
                      <option value={s.program}>
                        {COORD_LABELS[s.program] ?? s.program}
                      </option>
                    {/each}
                  </select>
                </label>
              {/if}
            </div>
          {/if}

        </aside>

        <div class="coord-main">
          {#if coordTab === "scripts" && connection.userRole === "admin"}
        <p class="desc">
          Per-bridge system prompts. <strong>Global</strong> is used when no bridge-specific script matches.
          Use <code class="ic">{"{BRIDGE_LIST}"}</code> as a placeholder.
        </p>
        {#if !coordLoaded}
          <span class="result">Loading...</span>
        {:else if coordScripts.length === 0}
          <span class="result">No scripts found on server.</span>
        {:else}
          <div class="coord-script-header">
            <strong>{COORD_LABELS[coordSelected] ?? coordSelected}</strong>
            {#if coordIsModified()}
              <span class="result">Modified from default</span>
            {:else}
              <span class="result">Using default script</span>
            {/if}
          </div>
          {#if coordScriptEditing}
            <textarea class="coord-editor" bind:value={coordDraft} rows="16" spellcheck="false"></textarea>
            <div class="coord-actions">
              <button class="btn secondary" onclick={() => (coordScriptEditing = false)}>Preview</button>
              {#if coordIsModified()}
                <button class="btn secondary" onclick={resetCoordScript}>Reset to Default</button>
              {/if}
              <button class="btn" onclick={saveCoordScript} disabled={coordSaving}>
                {coordSaving ? "Saving..." : `Save ${COORD_LABELS[coordSelected] ?? coordSelected}`}
              </button>
            </div>
          {:else}
            <pre class="coord-preview">{coordDraft || "# Empty script"}</pre>
            <div class="coord-actions">
              <button class="btn" onclick={() => (coordScriptEditing = true)}>Edit Script</button>
              {#if coordIsModified()}
                <button class="btn secondary" onclick={resetCoordScript}>Reset to Default</button>
              {/if}
            </div>
          {/if}
        {/if}
      {:else if coordTab === "playbook"}
        <p class="desc">Define task manifests, edit instruction files, and attach documented reference folders.</p>

        <div class="coord-block">
          <label>
            Manifest JSON
            <textarea class="coord-editor" bind:value={playbookManifest} rows="12" spellcheck="false"></textarea>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={savePlaybookManifest} disabled={playbookSaving}>
              {playbookSaving ? "Saving..." : "Save Manifest"}
            </button>
          </div>
        </div>

        <div class="coord-block">
          <label>
            Existing playbook files
            <select bind:value={playbookFilePath}>
              {#if playbookFiles.length === 0}
                <option value="">No files yet</option>
              {:else}
                {#each playbookFiles as f}
                  <option value={f}>{f}</option>
                {/each}
              {/if}
            </select>
          </label>
          <div class="coord-actions">
            <button
              class="btn secondary"
              onclick={loadPlaybookFileFromServer}
              disabled={playbookFileLoading || !playbookFilePath}
            >
              {playbookFileLoading ? "Loading..." : "Load File"}
            </button>
          </div>

          <label>
            Task file path
            <input bind:value={playbookFilePath} placeholder="tasks/my_task.md" />
          </label>
          <label>
            Task file content
            <textarea class="coord-editor" bind:value={playbookFileContent} rows="8" spellcheck="false"></textarea>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={savePlaybookFile} disabled={playbookFileSaving}>
              {playbookFileSaving ? "Saving..." : "Save Task File"}
            </button>
          </div>
        </div>

        <div class="coord-block">
          <label>
            Task ID for reference folder
            {#if getPlaybookTaskIds().length === 0}
              <select disabled>
                <option>No tasks in manifest</option>
              </select>
            {:else}
              <select bind:value={addRefTaskId}>
                {#each getPlaybookTaskIds() as taskId}
                  <option value={taskId}>{taskId}</option>
                {/each}
              </select>
            {/if}
          </label>
          <label>
            Existing folder path (local/NAS)
            <input bind:value={addRefFolderPath} placeholder="/mnt/nas/project_fx/explosion_pack" />
          </label>
          <p class="desc">
            The folder must include a documentation file such as <code class="ic">README.md</code> or
            <code class="ic">ABOUT.md</code> so coordinators know what the reference contains.
          </p>
          <div class="coord-actions">
            <button class="btn" onclick={addReferenceFolder} disabled={addRefSaving || !addRefTaskId || !addRefFolderPath}>
              {addRefSaving ? "Adding..." : "Add Reference Folder"}
            </button>
          </div>
          {#if addRefResult}<div class="result">{addRefResult}</div>{/if}
        </div>

        <div class="coord-block">
          <p class="desc">
            Add GitHub demo repositories directly to playbook references. The repository (or chosen subpath)
            must contain docs like <code class="ic">README.md</code>.
          </p>
          <label>
            GitHub repository URL
            <input bind:value={addRepoUrl} placeholder="https://github.com/owner/repo" />
          </label>
          <label>
            Branch or tag (optional)
            <input bind:value={addRepoBranch} placeholder="main" />
          </label>
          <label>
            Sub-path inside repo (optional)
            <input bind:value={addRepoSubPath} placeholder="examples/houdini/explosion" />
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={addReferenceRepo} disabled={addRepoSaving || !addRefTaskId || !addRepoUrl}>
              {addRepoSaving ? "Adding..." : "Add GitHub Reference"}
            </button>
          </div>
          {#if addRepoResult}<div class="result">{addRepoResult}</div>{/if}
        </div>
      {:else if coordTab === "server_resources"}
        <p class="desc">
          Server resources are shared by all workers and bridges. Use these paths/uploads for assets
          that must be globally available.
        </p>
        <div class="coord-block">
          <p class="desc">
            Global client-side coordination policy is managed from the Admin dashboard.
          </p>
        </div>

        <div class="coord-block">
          <p class="desc">
            Upload files directly into this program's playbook folder on the server.
          </p>
          <label>
            Target folder
            <input bind:value={uploadTargetDir} placeholder="examples/houdini/pyro" />
          </label>
          <label>
            Files
            <input type="file" multiple onchange={onUploadFilesChanged} />
          </label>
          {#if uploadFiles.length > 0}
            <div class="result">{uploadFiles.length} file(s) selected.</div>
          {/if}
          <div class="coord-actions">
            <button class="btn" onclick={uploadCoordinatorFiles} disabled={uploadSaving}>
              {uploadSaving ? "Uploading..." : "Upload Files"}
            </button>
          </div>
          {#if uploadResult}<div class="result">{uploadResult}</div>{/if}
        </div>

        <p class="desc">
          Add extra search roots for examples (local folders, mounted NAS paths, network shares).
          One path per line.
        </p>

        {#if defaultReferencePaths.length > 0}
          <p class="desc">Default paths from server config:</p>
          <div class="coord-list">
            {#each defaultReferencePaths as p}
              <div class="coord-list-item">{p}</div>
            {/each}
          </div>
        {/if}

        <div class="coord-block">
          <label>
            Add one path
            <input bind:value={newReferencePath} placeholder="/mnt/nas/library/fx_examples" />
          </label>
          <div class="coord-actions">
            <button class="btn secondary" onclick={addReferencePathLine}>Add Path</button>
          </div>

          <label>
            Additional reference paths
            <textarea class="coord-editor" bind:value={referencePathsInput} rows="6" spellcheck="false"></textarea>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={saveCoordinatorReferencePaths} disabled={referencePathsSaving}>
              {referencePathsSaving ? "Saving..." : "Save Paths"}
            </button>
          </div>
        </div>

        {#if defaultPlaybookSourcePaths.length > 0}
          <p class="desc">Default playbook source paths from server config:</p>
          <div class="coord-list">
            {#each defaultPlaybookSourcePaths as p}
              <div class="coord-list-item">{p}</div>
            {/each}
          </div>
        {/if}

        <div class="coord-block">
          <p class="desc">
            Optional external playbook sources (folders or JSON files). These are merged at runtime,
            so you can keep multiple smaller playbooks instead of one large override.
          </p>
          <label>
            Add one playbook source path
            <input bind:value={newPlaybookSourcePath} placeholder="/mnt/nas/playbooks/godot" />
          </label>
          <label class="toggle-label">
            <input type="checkbox" bind:checked={newPlaybookSourceAutoAnalyze} />
            <span>Auto analyze folder and generate manifest/tasks when adding</span>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={addPlaybookSource} disabled={playbookSourceAdding}>
              {playbookSourceAdding ? "Adding..." : "Add Source"}
            </button>
            <button class="btn secondary" onclick={addPlaybookSourcePathLine}>Stage Path Only</button>
          </div>
          {#if playbookSourceResult}<div class="result">{playbookSourceResult}</div>{/if}

          <p class="desc" style="margin-top: 8px;">Current source paths:</p>
          <div class="coord-list">
            {#each parsePlaybookSourcePathsInput() as p}
              <div class="coord-list-item row">
                <span>{p}</span>
                <button class="btn secondary" onclick={() => removePlaybookSourcePath(p)}>Remove</button>
              </div>
            {/each}
            {#if parsePlaybookSourcePathsInput().length === 0}
              <div class="coord-list-item">No source paths configured yet.</div>
            {/if}
          </div>

          <label>
            External playbook source paths
            <textarea class="coord-editor" bind:value={playbookSourcePathsInput} rows="5" spellcheck="false"></textarea>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={saveCoordinatorPlaybookSources} disabled={playbookSourcesSaving}>
              {playbookSourcesSaving ? "Saving..." : "Save Playbook Sources"}
            </button>
          </div>
        </div>
        {#if connection.userRole === "admin"}
          <div class="coord-block">
            <p class="desc">
              Coordinator editors (user IDs) can manage playbooks/uploads from the client.
              One user ID per line.
            </p>
            <textarea class="coord-editor" bind:value={coordinatorEditorsInput} rows="5" spellcheck="false"></textarea>
            <div class="coord-actions">
              <button class="btn" onclick={saveCoordinatorEditors} disabled={coordinatorEditorsSaving}>
                {coordinatorEditorsSaving ? "Saving..." : "Save Editor Permissions"}
              </button>
            </div>
          </div>
        {/if}
      {:else if coordTab === "client_resources"}
        <p class="desc">
          Client resources are paths on this machine. They are stored locally and can be promoted to
          server sources when the server can access them.
        </p>

        <div class="coord-block">
          <p class="desc">
            Push a local client folder to server storage to make it shared/bridge-independent.
          </p>
          <label>
            Local folder
            <input type="file" webkitdirectory multiple onchange={onClientResourceFolderUploadChanged} />
          </label>
          {#if clientResourceUploadFiles.length > 0}
            <div class="result">
              {clientResourceUploadFiles.length} file(s) queued from folder upload.
            </div>
          {/if}
          <label>
            Server target folder
            <input bind:value={clientResourceUploadTargetDir} placeholder="imports/client/demo_pack" />
          </label>
          <label class="toggle-label">
            <input type="checkbox" bind:checked={clientResourceUploadAutoAddSource} />
            <span>Auto add uploaded folder as a server playbook source</span>
          </label>
          <label class="toggle-label">
            <input
              type="checkbox"
              bind:checked={clientResourceUploadAutoAnalyze}
              disabled={!clientResourceUploadAutoAddSource}
            />
            <span>Auto analyze source after adding</span>
          </label>
          <div class="coord-actions">
            <button class="btn" onclick={uploadClientResourcesToServer} disabled={clientResourceUploadSaving}>
              {clientResourceUploadSaving ? "Uploading..." : "Push Folder To Server"}
            </button>
          </div>
          {#if clientResourceUploadResult}<div class="result">{clientResourceUploadResult}</div>{/if}
        </div>

        <div class="coord-block">
          <label>
            Add client-side path
            <input bind:value={newClientResourcePath} placeholder="/home/user/MyClientDemos" />
          </label>
          <div class="coord-actions">
            <button class="btn secondary" onclick={addClientResourcePath}>Add Client Path</button>
          </div>

          <p class="desc" style="margin-top: 8px;">Paths saved for this client:</p>
          <div class="coord-list">
            {#each clientResourcePaths as p}
              <div class="coord-list-item row">
                <span>{p}</span>
                <button class="btn secondary" onclick={() => removeClientResourcePath(p)}>Remove</button>
              </div>
            {/each}
            {#if clientResourcePaths.length === 0}
              <div class="coord-list-item">No client paths saved yet.</div>
            {/if}
          </div>

          <label>
            Select path to promote to server source
            <select bind:value={selectedClientResourcePath}>
              {#if clientResourcePaths.length === 0}
                <option value="">No client paths</option>
              {:else}
                {#each clientResourcePaths as p}
                  <option value={p}>{p}</option>
                {/each}
              {/if}
            </select>
          </label>
          <label class="toggle-label">
            <input type="checkbox" bind:checked={promoteClientResourceAutoAnalyze} />
            <span>Auto analyze on promote</span>
          </label>
          <div class="coord-actions">
            <button
              class="btn"
              onclick={promoteClientResourcePathToServerSource}
              disabled={promoteClientResourceSaving || !selectedClientResourcePath}
            >
              {promoteClientResourceSaving ? "Promoting..." : "Promote To Server Source"}
            </button>
          </div>
          <p class="desc">
            Note: promotion works only if the server can access that filesystem path (shared mount/NAS/same machine).
          </p>
          {#if clientResourceResult}<div class="result">{clientResourceResult}</div>{/if}
        </div>
      {/if}
        </div>
      </div>
    </section>
  {:else if canManageCoordinator && !showOnlyCoordinator}
    <section>
      <h3>Coordinator</h3>
      <p class="desc">
        Coordinator management moved to its own sidebar tab for a cleaner settings layout.
      </p>
      <div class="coord-actions" style="justify-content: flex-start; margin-top: 0;">
        <button class="btn secondary" onclick={() => { nav.current = "coordinator"; }}>
          Open Coordinator Tab
        </button>
      </div>
    </section>
  {/if}

</div>

<style>
  .settings-page {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    max-width: 1100px;
  }
  .settings-page.coordinator-only {
    max-width: 1300px;
  }
  h2 { font-size: var(--font-size-lg); margin-bottom: 20px; }
  h3 { font-size: var(--font-size-base); margin-bottom: 12px; color: var(--text-secondary); }
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
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
  .btn.danger { background: var(--status-failed); }
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
  .status {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
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
  .coord-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .coord-toolbar {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .coord-toolbar label {
    flex: 1;
    margin: 0;
  }
  .coord-workspace {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }
  .coord-rail {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: sticky;
    top: 8px;
    max-height: calc(100vh - 180px);
    overflow-y: auto;
  }
  .coord-main {
    min-width: 0;
  }
  .coord-tabs-rail {
    flex-direction: column;
    margin-bottom: 0;
  }
  .coord-tabs-rail .coord-tab {
    width: 100%;
    justify-content: space-between;
  }
  .coord-toolbar-rail {
    flex-direction: column;
    align-items: stretch;
    margin-bottom: 0;
  }
  .coord-rail-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .coord-tab {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .coord-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
  .coord-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .coord-script-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .coord-preview {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    min-height: 240px;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
  }
  .coord-block {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    margin-bottom: 10px;
    background: rgba(255, 255, 255, 0.02);
  }
  .coord-list {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 10px;
  }
  .coord-list-item {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .coord-list-item:first-child {
    border-top: 0;
  }
  .coord-list-item.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    word-break: break-all;
  }
  .coord-list-item.row .btn {
    flex-shrink: 0;
  }
  .coord-editor {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: 8px;
    resize: vertical;
    max-width: 100%;
    min-height: 96px;
    box-sizing: border-box;
    line-height: 1.5;
  }
  .coord-editor:focus { outline: none; border-color: var(--accent); }
  .coord-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 8px;
    flex-wrap: wrap;
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
  .local-model-picker {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
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
  .prefs-section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  .prefs-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
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
  .hardware-info {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
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
  @media (max-width: 1100px) {
    .settings-page,
    .settings-page.coordinator-only {
      max-width: 100%;
    }
    .coord-workspace {
      grid-template-columns: 1fr;
    }
    .coord-rail {
      position: static;
      max-height: none;
    }
    .coord-tabs-rail {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .coord-tabs-rail .coord-tab {
      width: auto;
    }
    .prefs-grid {
      grid-template-columns: 1fr;
    }
    .model-download-row {
      flex-direction: column;
    }
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
  .account-subsection {
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .account-subsection:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  .account-subsection h4 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-primary);
  }
  .status-line {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .status-badge.enabled {
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
  }
  .status-badge.disabled {
    background: rgba(102, 102, 102, 0.15);
    color: var(--text-muted);
  }
  .disable-2fa-form {
    margin-top: 8px;
    padding: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .error-text {
    color: var(--status-failed) !important;
  }
  .success-text {
    color: var(--status-completed) !important;
  }
</style>
