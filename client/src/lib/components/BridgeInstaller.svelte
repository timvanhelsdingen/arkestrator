<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";

  const BRIDGE_REPO = "timvanhelsdingen/arkestrator-bridges";

  interface BridgeEntry {
    id: string;
    name: string;
    description: string;
    author: string;
    official: boolean;
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
      const result = await invoke<any>("fetch_bridge_registry", { repo: BRIDGE_REPO });
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

  // Load on mount
  loadRegistry();
</script>

<section class="bridge-installer">
  <div class="bridge-header">
    <h3>Bridge Plugins</h3>
    <button class="btn secondary" onclick={loadRegistry} disabled={loading}>
      {loading ? "Loading..." : "Check for Updates"}
    </button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if registry.length === 0 && !loading}
    <p class="desc">No bridge plugins found. Click "Check for Updates" to fetch from the registry.</p>
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
          {:else if isInstalled && updateAvailable}
            <span class="installed-label">v{installed[bridge.id].version} installed</span>
            <button class="btn" onclick={() => openInstallDialog(bridge)}>Update to v{bridge.version}</button>
            <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
          {:else if isInstalled}
            <span class="installed-label">Installed</span>
            <button class="btn danger" onclick={() => doUninstall(bridge)}>Uninstall</button>
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
</style>
