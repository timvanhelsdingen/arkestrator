<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { workersStore } from "../stores/workers.svelte";

  const BRIDGE_REPO = "timvanhelsdingen/arkestrator-bridges";

  interface BridgeEntry {
    id: string;
    name: string;
    type?: string;
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

  // Filter out API bridges and standalone bridges — those are configured in the API bridges tab
  let programRegistry = $derived(registry.filter((b) => b.type !== "api" && b.installType !== "standalone"));

  // Connected bridges by program name for status display
  let connectedPrograms = $derived(
    new Set(workersStore.bridges.filter(b => b.connected).map(b => b.program))
  );
  let updatableBridges = $derived(programRegistry.filter((b) => hasUpdate(b) && b.downloadUrl && b.installType !== "project"));

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
    {#each programRegistry as bridge (bridge.id)}
      {@const isInstalled = !!installed[bridge.id]}
      {@const updateAvailable = hasUpdate(bridge)}
      {@const isInstalling = installing === bridge.id}
      {@const isConnected = connectedPrograms.has(bridge.program)}

      <div class="bridge-card" class:installed={isInstalled} class:update-available={updateAvailable}>
        <div class="bridge-card-top">
          <div class="bridge-card-header">
            <span class="bridge-name">{bridge.name}</span>
            {#if isConnected}
              <span class="connected-dot" title="Connected"></span>
            {/if}
            {#if bridge.stability && bridge.stability !== "stable"}
              <span class="badge stability-{bridge.stability}">{bridge.stability}</span>
            {/if}
          </div>
          <p class="bridge-desc">{bridge.description}</p>
          <div class="bridge-meta">
            <span class="bridge-version">v{bridge.version}</span>
            <span class="bridge-type">{INSTALL_TYPE_LABELS[bridge.installType] ?? bridge.installType}</span>
          </div>
        </div>

        <div class="bridge-card-bottom">
          <div class="bridge-status">
            {#if isInstalled && updateAvailable}
              <span class="status-text update">v{installed[bridge.id].version} &rarr; v{bridge.version}</span>
            {:else if isInstalled}
              <span class="status-text installed">v{installed[bridge.id].version} installed</span>
            {/if}
          </div>
          <div class="bridge-actions">
            {#if isInstalling}
              <button class="btn" disabled>Installing...</button>
            {:else if isInstalled && bridge.installType === "project"}
              {#if updateAvailable}
                <button class="btn" onclick={() => openInstallDialog(bridge)}>Update</button>
              {/if}
              <button class="btn secondary" onclick={() => openInstallDialog(bridge)}>Add to Project</button>
            {:else if isInstalled && updateAvailable}
              <button class="btn" onclick={() => openInstallDialog(bridge)}>Update</button>
              <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
            {:else if isInstalled}
              <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
            {:else}
              <button class="btn" onclick={() => openInstallDialog(bridge)}>Install</button>
            {/if}
          </div>
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

      </div>
    {/each}
  </div>
</section>

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
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
  }
  .bridge-card {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 140px;
  }
  .bridge-card.installed {
    border-color: var(--accent);
  }
  .bridge-card.update-available {
    border-color: var(--status-queued, #e2b93d);
  }
  .bridge-card-top {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bridge-card-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .bridge-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bridge-name {
    font-weight: 600;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .connected-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ade80;
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
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .bridge-meta {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .bridge-version {
    font-family: var(--font-mono);
  }
  .bridge-type {
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .bridge-status {
    min-width: 0;
  }
  .status-text {
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .status-text.installed {
    color: var(--accent);
  }
  .status-text.update {
    color: var(--status-queued, #e2b93d);
  }
  .bridge-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
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

</style>
