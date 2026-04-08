<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { api } from "../api/rest";

  const BRIDGE_REPO = "timvanhelsdingen/arkestrator-bridges";

  interface BridgeEntry {
    id: string;
    name: string;
    description: string;
    author: string;
    official: boolean;
    stability?: "stable" | "beta" | "experimental";
    version: string;
    program: string;
    installType: string;
    platforms: string[];
    installPath: Record<string, string>;
    detect: Record<string, string[]>;
    downloadUrl?: string;
  }

  interface InstalledBridge {
    id: string;
    version: string;
    installPath: string;
    installedAt: string;
  }

  interface DetectedPath {
    path: string;
    label: string;
  }

  let registry = $state<BridgeEntry[]>([]);
  let installed = $state<Record<string, InstalledBridge>>({});
  let loading = $state(false);
  let error = $state("");
  let installing = $state<string | null>(null);
  let installError = $state<Record<string, string>>({});
  let installSuccess = $state<Record<string, string>>({});
  let updatingAll = $state(false);

  // Install dialog state
  let showInstallDialog = $state<string | null>(null);
  let detectedPaths = $state<DetectedPath[]>([]);
  let selectedPath = $state("");
  let customPath = $state("");
  let detecting = $state(false);

  const platform = $derived(
    navigator.userAgent.includes("Win") ? "windows" :
    navigator.userAgent.includes("Mac") ? "macos" : "linux"
  );

  function getInstalledVersion(bridgeId: string): string | null {
    return installed[bridgeId]?.version ?? null;
  }

  function hasUpdate(bridge: BridgeEntry): boolean {
    const iv = getInstalledVersion(bridge.id);
    return iv !== null && iv !== bridge.version;
  }

  async function loadRegistry() {
    loading = true;
    error = "";
    try {
      // Force refresh bypasses cache — essential for "Check for Updates"
      const forceRefresh = registry.length > 0;
      const result = await invoke<any>("fetch_bridge_registry", { repo: BRIDGE_REPO, forceRefresh });
      registry = result.bridges ?? [];
      await loadInstalled();
    } catch (e: any) {
      error = e?.toString() ?? "Failed to load registry";
    } finally {
      loading = false;
    }
  }

  async function loadInstalled() {
    try {
      const result = await invoke<any>("get_installed_bridges");
      const map: Record<string, InstalledBridge> = {};
      for (const b of result.installed ?? []) {
        map[b.id] = b;
      }
      installed = map;
    } catch (e) {
      console.warn("[bridges] Failed to load installed bridges:", e);
    }
  }

  async function openInstallDialog(bridge: BridgeEntry) {
    showInstallDialog = bridge.id;
    detectedPaths = [];
    selectedPath = "";
    customPath = "";
    installError = { ...installError, [bridge.id]: "" };
    installSuccess = { ...installSuccess, [bridge.id]: "" };

    if (bridge.installType === "project") {
      // Project type: just show folder picker directly
      return;
    }

    // For user/engine types, detect existing installations
    const hints = bridge.detect?.[platform] ?? [];
    if (hints.length > 0) {
      detecting = true;
      try {
        detectedPaths = await invoke<DetectedPath[]>("detect_program_paths", { hints });
        if (detectedPaths.length > 0) {
          selectedPath = detectedPaths[0].path;
        }
      } catch (e) {
        console.warn("[bridges] Path detection failed:", e);
      }
      detecting = false;
    }
  }

  function resolveInstallPath(bridge: BridgeEntry, basePath: string): string {
    const pathTemplate = bridge.installPath?.[platform]
      ?? bridge.installPath?.relative
      ?? bridge.installPath?.default
      ?? "";

    if (bridge.installType === "project" && bridge.installPath?.relative) {
      return `${basePath}/${bridge.installPath.relative}`;
    }

    // For user/engine types with detected version path
    if (pathTemplate.includes("{appVersion}")) {
      // Extract version from selected base path's last directory component.
      // The template already includes the program prefix (e.g., "UE_{appVersion}")
      // so we strip known prefixes from the detected directory name to avoid
      // duplication like "UE_UE_5.4".
      const parts = basePath.replace(/\\/g, "/").split("/");
      let versionPart = parts[parts.length - 1] ?? "";
      // Strip common DCC version-directory prefixes
      for (const prefix of ["UE_", "UE-", "Houdini", "houdini"]) {
        if (versionPart.startsWith(prefix)) {
          versionPart = versionPart.slice(prefix.length);
          break;
        }
      }
      return pathTemplate.replace("{appVersion}", versionPart);
    }

    // Fixed install path (no version placeholder) — use the template directly.
    // The Rust backend expands env vars like %APPDATA% and ~ during extraction.
    if (pathTemplate) {
      return pathTemplate;
    }

    return basePath;
  }

  async function doInstall(bridge: BridgeEntry) {
    let targetPath = "";

    if (bridge.installType === "project") {
      const folder = await open({ directory: true, title: `Select ${bridge.program} project folder` });
      if (!folder) return;
      targetPath = resolveInstallPath(bridge, folder as string);
    } else if (selectedPath) {
      targetPath = resolveInstallPath(bridge, selectedPath);
    } else if (customPath) {
      targetPath = customPath;
    } else {
      installError = { ...installError, [bridge.id]: "Please select an install path" };
      return;
    }

    if (!bridge.downloadUrl) {
      installError = { ...installError, [bridge.id]: "No download URL available. Is there a release published?" };
      return;
    }

    installing = bridge.id;
    installError = { ...installError, [bridge.id]: "" };
    installSuccess = { ...installSuccess, [bridge.id]: "" };

    try {
      await invoke("download_and_install_bridge", {
        downloadUrl: bridge.downloadUrl,
        installPath: targetPath,
      });
      await invoke("save_bridge_installation", {
        bridgeId: bridge.id,
        version: bridge.version,
        installPath: targetPath,
        installType: bridge.installType,
      });
      await loadInstalled();
      installSuccess = { ...installSuccess, [bridge.id]: `Installed to ${targetPath}` };
      showInstallDialog = null;
    } catch (e: any) {
      installError = { ...installError, [bridge.id]: e?.toString() ?? "Install failed" };
    } finally {
      installing = null;
    }
  }

  async function doUninstall(bridge: BridgeEntry) {
    const inst = installed[bridge.id];
    if (!inst) return;

    installing = bridge.id;
    try {
      await invoke("uninstall_bridge", {
        bridgeId: bridge.id,
        installPath: inst.installPath,
      });
      await loadInstalled();
      installSuccess = { ...installSuccess, [bridge.id]: "Uninstalled" };
    } catch (e: any) {
      installError = { ...installError, [bridge.id]: e?.toString() ?? "Uninstall failed" };
    } finally {
      installing = null;
    }
  }

  async function browseFolder(bridge: BridgeEntry) {
    const folder = await open({ directory: true, title: `Select install location for ${bridge.name}` });
    if (folder) {
      customPath = folder as string;
      selectedPath = "";
    }
  }

  const INSTALL_TYPE_LABELS: Record<string, string> = {
    project: "Per-project",
    user: "User-level",
    engine: "Engine-level",
    standalone: "Standalone",
  };

  let updatableBridges = $derived(registry.filter((b) => hasUpdate(b) && b.downloadUrl && b.installType !== "project"));

  async function updateAllBridges() {
    updatingAll = true;
    for (const bridge of updatableBridges) {
      const inst = installed[bridge.id];
      if (!inst || !bridge.downloadUrl) continue;

      installing = bridge.id;
      installError = { ...installError, [bridge.id]: "" };
      installSuccess = { ...installSuccess, [bridge.id]: "" };

      try {
        const targetPath = inst.installPath;
        await invoke("download_and_install_bridge", {
          downloadUrl: bridge.downloadUrl,
          installPath: targetPath,
        });
        await invoke("save_bridge_installation", {
          bridgeId: bridge.id,
          version: bridge.version,
          installPath: targetPath,
          installType: bridge.installType,
        });
        installSuccess = { ...installSuccess, [bridge.id]: `Updated to v${bridge.version}` };
      } catch (e: any) {
        installError = { ...installError, [bridge.id]: e?.toString() ?? "Update failed" };
      }
    }
    installing = null;
    await loadInstalled();
    updatingAll = false;
  }

  // ─── ComfyUI setup state ─────────────────────────────────────────────

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
      if (pathConfig.path) {
        comfySelectedPath = pathConfig.path;
      }
      // Check running status
      comfyRunning = await invoke<boolean>("is_comfyui_running");
      // Check nodes
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
      // Save URL
      const urlToSave = comfyUrl !== comfyUrlEffective || comfyUrlSource === "default" ? comfyUrl : null;
      await api.settings.setComfyuiUrl(urlToSave === "http://127.0.0.1:8188" ? null : urlToSave);
      // Save path — update the saved path FIRST so subsequent calls use the new one
      if (path) {
        await api.settings.setComfyuiPath(path);
        comfySavedPath = path;
        // Check nodes at the NEW path
        try {
          const nodes = await invoke<{ installed: boolean }>("check_comfyui_nodes", { comfyuiPath: path });
          comfyNodesInstalled = nodes.installed;
        } catch { comfyNodesInstalled = false; }
      }
      // Save auto-start preference with the NEW path
      try {
        await invoke("set_comfyui_autostart", { autoStart: comfyAutoStart, comfyuiPath: path ?? "" });
      } catch { /* auto-start save is non-critical */ }
      comfySuccess = "Configuration saved";
      // Reload config
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
      // Auto-test connection after a short delay (ComfyUI needs time to start)
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

  // ─── Init ──────────────────────────────────────────────────────────────

  // Auto-load registry (and installed bridges) on mount.
  loadRegistry();
</script>

<section class="bridge-installer">
  <div class="bridge-header">
    <h3>Bridge Plugins</h3>
    <div class="header-actions">
      {#if updatableBridges.length > 0}
        <button class="btn" onclick={updateAllBridges} disabled={updatingAll || !!installing}>
          {updatingAll ? "Updating..." : `Update All (${updatableBridges.length})`}
        </button>
      {/if}
      <button class="btn secondary" onclick={loadRegistry} disabled={loading}>
        {loading ? "Loading..." : "Check for Updates"}
      </button>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if registry.length === 0 && !loading && !error}
    <p class="desc">Loading bridge plugin registry...</p>
  {/if}

  <div class="bridge-grid">
    {#each registry as bridge (bridge.id)}
      {@const isInstalled = !!installed[bridge.id]}
      {@const updateAvailable = hasUpdate(bridge)}
      {@const isInstalling = installing === bridge.id}

      <div class="bridge-card" class:installed={isInstalled}>
        <div class="bridge-card-header">
          <div class="bridge-name">{bridge.name}</div>
          <div class="bridge-badges">
            {#if bridge.official}
              <span class="badge official">Official</span>
            {/if}
            {#if bridge.stability && bridge.stability !== "stable"}
              <span class="badge stability-{bridge.stability}">{bridge.stability}</span>
            {/if}
            <span class="badge type">{INSTALL_TYPE_LABELS[bridge.installType] ?? bridge.installType}</span>
          </div>
        </div>

        <p class="bridge-desc">{bridge.description}</p>

        <div class="bridge-meta">
          <span class="bridge-version">v{bridge.version}</span>
          <span class="bridge-author">by {bridge.author}</span>
        </div>

        <div class="bridge-actions">
          {#if isInstalling}
            <button class="btn" disabled>Installing...</button>
          {:else if isInstalled && bridge.installType === "project"}
            <span class="installed-label">v{installed[bridge.id].version} installed</span>
            {#if updateAvailable}
              <button class="btn" onclick={() => openInstallDialog(bridge)}>Update to v{bridge.version}</button>
            {/if}
            <button class="btn" onclick={() => openInstallDialog(bridge)}>Install to Project</button>
          {:else if isInstalled && updateAvailable}
            <span class="installed-label">v{installed[bridge.id].version} installed</span>
            <button class="btn" onclick={() => openInstallDialog(bridge)}>Update to v{bridge.version}</button>
            <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
          {:else if isInstalled}
            <span class="installed-label">Installed</span>
            <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
          {:else if bridge.installType === "standalone" && bridge.program === "comfyui"}
            <button class="btn" onclick={comfyToggleSetup}>
              {comfyShowSetup ? "Hide Setup" : "Configure"}
            </button>
            {#if comfyRunning}
              <span class="comfy-status online">Running</span>
            {/if}
            {#if comfyNodesInstalled || comfySavedPath}
              <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
            {/if}
          {:else if bridge.installType === "standalone"}
            <span class="desc">Run standalone — see documentation</span>
          {:else}
            <button class="btn" onclick={() => openInstallDialog(bridge)}>Install</button>
          {/if}
        </div>

        {#if installError[bridge.id]}
          <div class="error">{installError[bridge.id]}</div>
        {/if}
        {#if installSuccess[bridge.id]}
          <div class="result">{installSuccess[bridge.id]}</div>
        {/if}

        {#if showInstallDialog === bridge.id && bridge.installType !== "project"}
          <div class="install-dialog">
            {#if detecting}
              <p class="desc">Detecting installations...</p>
            {:else if detectedPaths.length > 0}
              <p class="desc">Detected installations:</p>
              <div class="detected-list">
                {#each detectedPaths as dp}
                  <label class="radio-option">
                    <input type="radio" name="path-{bridge.id}" value={dp.path}
                      bind:group={selectedPath} />
                    <span>{dp.label}</span>
                    <span class="path-detail">{dp.path}</span>
                  </label>
                {/each}
              </div>
            {:else}
              <p class="desc">No installations detected automatically.</p>
            {/if}

            <div class="browse-row">
              <button class="btn secondary" onclick={() => browseFolder(bridge)}>Browse...</button>
              {#if customPath}
                <span class="path-detail">{customPath}</span>
              {/if}
            </div>

            <div class="dialog-actions">
              <button class="btn" onclick={() => doInstall(bridge)}
                disabled={!selectedPath && !customPath}>
                Install
              </button>
              <button class="btn secondary" onclick={() => showInstallDialog = null}>
                Cancel
              </button>
            </div>
          </div>
        {/if}

        {#if showInstallDialog === bridge.id && bridge.installType === "project"}
          <div class="install-dialog">
            <p class="desc">Select your {bridge.program} project folder. The bridge will be installed to <code>{bridge.installPath?.relative ?? "project"}</code>.</p>
            <div class="dialog-actions">
              <button class="btn" onclick={() => doInstall(bridge)}>
                Choose Folder & Install
              </button>
              <button class="btn secondary" onclick={() => showInstallDialog = null}>
                Cancel
              </button>
            </div>
          </div>
        {/if}

        {#if comfyShowSetup && bridge.program === "comfyui"}
          <!-- ComfyUI config opens as a modal popup -->
        {/if}
      </div>
    {/each}
  </div>
</section>

<!-- ComfyUI Configuration Modal -->
{#if comfyShowSetup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="comfy-modal-backdrop" onclick={() => (comfyShowSetup = false)}>
    <div class="comfy-modal" onclick={(e) => e.stopPropagation()}>
      <div class="comfy-modal-header">
        <h3>ComfyUI Configuration</h3>
        <button class="comfy-modal-close" onclick={() => (comfyShowSetup = false)}>&times;</button>
      </div>

      <div class="comfy-modal-body">
        <!-- Installation Help -->
        <details class="install-help">
          <summary>Don't have ComfyUI installed? Quick setup guide</summary>
          <div class="install-help-content">
            <p><strong>1. Clone ComfyUI</strong></p>
            <pre>git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI</pre>
            <p><strong>2. Install PyTorch with CUDA</strong> (NVIDIA GPU required)</p>
            <pre>pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124</pre>
            <p><strong>3. Install ComfyUI dependencies</strong></p>
            <pre>pip install -r requirements.txt</pre>
            <p><strong>4. Start ComfyUI</strong></p>
            <pre>python main.py</pre>
            <p class="desc">ComfyUI will start on <code>http://127.0.0.1:8188</code>. Once running, click Detect above to find it, then Save Configuration.</p>
            <p class="desc"><strong>Tip:</strong> If you get "Torch not compiled with CUDA enabled", run:<br/>
            <code>pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --force-reinstall</code></p>
          </div>
        </details>

        <!-- Location -->
        <div class="comfy-section">
          <div class="comfy-section-header">Location</div>
          <div class="comfy-row">
            <button class="btn secondary" onclick={comfyDetect} disabled={comfyDetecting}>
              {comfyDetecting ? "Detecting..." : "Detect"}
            </button>
            <button class="btn secondary" onclick={comfyBrowse}>Browse...</button>
          </div>
          {#if comfyCustomPath}
            <p class="desc"><code>{comfyCustomPath}</code></p>
          {/if}
          {#if comfyDetectedPaths.length > 0}
            <div class="detected-list">
              {#each comfyDetectedPaths as dp}
                <label class="radio-option">
                  <input type="radio" name="comfy-path" value={dp.path}
                    bind:group={comfySelectedPath} />
                  <span class="comfy-path-label">
                    {dp.path}
                    {#if dp.hasMainPy}
                      <span class="badge official">main.py found</span>
                    {:else}
                      <span class="badge type">no main.py</span>
                    {/if}
                  </span>
                </label>
              {/each}
            </div>
          {/if}
          {#if comfySavedPath}
            <p class="desc">Saved: <code>{comfySavedPath}</code></p>
          {/if}
        </div>

        <!-- Server URL -->
        <div class="comfy-section">
          <div class="comfy-section-header">
            Server URL
            <span class="badge type">{comfyUrlSource}</span>
          </div>
          <div class="comfy-row">
            <input type="text" class="comfy-input" bind:value={comfyUrl}
              placeholder="http://127.0.0.1:8188" />
            <button class="btn secondary" onclick={comfyTestConnection} disabled={comfyTesting}>
              {comfyTesting ? "Testing..." : "Test"}
            </button>
          </div>
          {#if comfyTestResult}
            <div class={comfyTestResult.reachable ? "comfy-test-ok" : "comfy-test-fail"}>
              {#if comfyTestResult.reachable}
                Connected ({comfyTestResult.latencyMs}ms)
              {:else}
                Unreachable{comfyTestResult.error ? `: ${comfyTestResult.error}` : ""}
              {/if}
            </div>
          {/if}
        </div>

        <!-- Custom Nodes -->
        <div class="comfy-section">
          <div class="comfy-section-header">Arkestrator Custom Nodes</div>
          {#if comfyNodesInstalled === true}
            <span class="comfy-status online">Installed</span>
          {:else if comfyNodesInstalled === false}
            <span class="desc">Not installed yet. Install will happen when you save a valid path.</span>
          {:else}
            <span class="desc">Select a location first</span>
          {/if}
        </div>

        <!-- Launch -->
        <div class="comfy-section">
          <div class="comfy-section-header">Launch</div>
          <label class="comfy-toggle">
            <input type="checkbox" bind:checked={comfyAutoStart} />
            <span>Start ComfyUI when Arkestrator launches</span>
          </label>
          <div class="comfy-row">
            {#if comfyRunning}
              <button class="btn danger" onclick={comfyStop}>Stop</button>
              <span class="comfy-status online">Running</span>
            {:else}
              <button class="btn" onclick={comfyStart}
                disabled={comfyLaunching || (!comfySavedPath && !comfySelectedPath && !comfyCustomPath)}>
                {comfyLaunching ? "Starting..." : "Start ComfyUI"}
              </button>
            {/if}
          </div>
        </div>

        {#if comfyError}
          <div class="error">{comfyError}</div>
        {/if}
        {#if comfySuccess}
          <div class="result">{comfySuccess}</div>
        {/if}
      </div>

      <div class="comfy-modal-footer">
        <button class="btn secondary" onclick={() => (comfyShowSetup = false)}>Cancel</button>
        <button class="btn" onclick={comfySaveConfig} disabled={comfySaving}>
          {comfySaving ? "Saving..." : "Save Configuration"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .bridge-installer {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  .bridge-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .bridge-header h3 {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--text-secondary);
  }
  .header-actions {
    display: flex;
    gap: 8px;
  }
  .bridge-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }
  .bridge-card {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bridge-card.installed {
    border-color: var(--accent);
  }
  .bridge-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .bridge-name {
    font-weight: 600;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .bridge-badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .badge.official {
    background: var(--accent);
    color: white;
  }
  .badge.type {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .badge.stability-beta {
    background: #854d0e22;
    color: #eab308;
    border: 1px solid #854d0e44;
  }
  .badge.stability-experimental {
    background: #9f123622;
    color: #f87171;
    border: 1px solid #9f123644;
  }
  .bridge-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0;
  }
  .bridge-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .bridge-version {
    font-family: var(--font-mono);
  }
  .bridge-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .installed-label {
    font-size: var(--font-size-sm);
    color: var(--accent);
    font-weight: 500;
  }
  .install-dialog {
    margin-top: 8px;
    padding: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .detected-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .radio-option {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    flex-direction: row;
  }
  .radio-option input {
    margin: 0;
  }
  .path-detail {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
  }
  .browse-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: none;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn:disabled { opacity: 0.5; cursor: default; }
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
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .result {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-base);
    padding: 1px 4px;
    border-radius: 2px;
  }

  /* ─── ComfyUI Setup ─── */
  .comfy-setup {
    margin-top: 8px;
    padding: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .comfy-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .comfy-section-header {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .comfy-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .comfy-input {
    flex: 1;
    min-width: 200px;
    padding: 5px 8px;
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    background: var(--bg-base);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    outline: none;
  }
  .comfy-input:focus {
    border-color: var(--accent);
  }
  .comfy-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .comfy-toggle input {
    margin: 0;
  }
  .comfy-status {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: var(--radius-sm);
  }
  .comfy-status.online {
    background: #16a34a22;
    color: #16a34a;
  }
  .comfy-test-ok {
    font-size: var(--font-size-sm);
    color: #16a34a;
  }
  .comfy-test-fail {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .comfy-path-label {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Installation Help */
  .install-help {
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .install-help summary {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-secondary);
    user-select: none;
  }
  .install-help summary:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .install-help-content {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.5;
  }
  .install-help-content p {
    margin: 8px 0 4px;
  }
  .install-help-content pre {
    background: var(--bg-base);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    overflow-x: auto;
    margin: 4px 0 8px;
    white-space: pre-wrap;
    word-break: break-all;
    user-select: all;
  }
  .install-help-content code {
    background: var(--bg-base);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 11px;
  }

  /* ComfyUI Config Modal */
  .comfy-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .comfy-modal {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 560px;
    max-width: 90vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }
  .comfy-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .comfy-modal-header h3 {
    margin: 0;
    font-size: 15px;
  }
  .comfy-modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
  }
  .comfy-modal-close:hover {
    color: var(--text-primary);
  }
  .comfy-modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
  }
  .comfy-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }
</style>
