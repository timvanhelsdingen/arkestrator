<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { wizard } from "../../stores/wizard.svelte";

  const BRIDGE_REPO = "timvanhelsdingen/arkestrator-bridges";

  interface BridgeEntry {
    id: string;
    name: string;
    description: string;
    program: string;
    installType: string;
    platforms: string[];
    installPath: Record<string, string>;
    detect: Record<string, string[]>;
    version: string;
    downloadUrl?: string;
    stability?: string;
  }

  interface DetectedPath {
    path: string;
    label: string;
  }

  interface InstalledBridge {
    id: string;
    version: string;
    installPath: string;
    installedAt: string;
  }

  interface BridgeState {
    bridge: BridgeEntry;
    detected: DetectedPath[];
    selectedPath: string;
    selected: boolean;
    installing: boolean;
    installed: boolean;
    updateAvailable: boolean;
    error: string;
  }

  let bridges = $state<BridgeState[]>([]);
  let loading = $state(true);
  let error = $state("");
  let batchInstalling = $state(false);
  let alreadyInstalled = $state<Record<string, InstalledBridge>>({});

  const platform = $derived(
    navigator.userAgent.includes("Win") ? "windows" :
    navigator.userAgent.includes("Mac") ? "macos" : "linux"
  );

  onMount(async () => {
    try {
      // Fetch registry and installed state in parallel
      const [registryResult, installedResult] = await Promise.all([
        invoke<any>("fetch_bridge_registry", { repo: BRIDGE_REPO }),
        invoke<any>("get_installed_bridges"),
      ]);

      const registry: BridgeEntry[] = registryResult?.bridges ?? [];
      const installedMap: Record<string, InstalledBridge> = {};
      for (const b of installedResult?.installed ?? []) {
        installedMap[b.id] = b;
      }
      alreadyInstalled = installedMap;

      // Filter to bridges that support this platform and aren't "project" type
      // (project-type bridges are per-project and don't make sense in setup wizard)
      const eligible = registry.filter(
        (b) => b.installType !== "project" && b.platforms.includes(platform)
      );

      // Auto-detect paths for all eligible bridges in parallel
      const states: BridgeState[] = await Promise.all(
        eligible.map(async (bridge) => {
          const hints = bridge.detect?.[platform] ?? [];
          let detected: DetectedPath[] = [];
          if (hints.length > 0) {
            try {
              detected = await invoke<DetectedPath[]>("detect_program_paths", { hints });
            } catch {
              // Detection failed — not critical
            }
          }

          const isInstalled = !!installedMap[bridge.id];
          const hasUpdate = isInstalled && installedMap[bridge.id].version !== bridge.version;
          return {
            bridge,
            detected,
            selectedPath: isInstalled ? installedMap[bridge.id].installPath : (detected.length > 0 ? detected[0].path : ""),
            // Auto-select: new installs with detected paths, or installed bridges with available updates
            selected: hasUpdate || (detected.length > 0 && !isInstalled),
            installing: false,
            installed: isInstalled,
            updateAvailable: hasUpdate,
            error: "",
          };
        })
      );

      // Sort: detected first, then alphabetical
      states.sort((a, b) => {
        if (a.detected.length > 0 && b.detected.length === 0) return -1;
        if (a.detected.length === 0 && b.detected.length > 0) return 1;
        return a.bridge.name.localeCompare(b.bridge.name);
      });

      bridges = states;
    } catch (e: any) {
      error = e?.toString() ?? "Failed to load bridge registry";
    } finally {
      loading = false;
    }
  });

  function resolveInstallPath(bridge: BridgeEntry, basePath: string): string {
    const pathTemplate = bridge.installPath?.[platform]
      ?? bridge.installPath?.relative
      ?? bridge.installPath?.default
      ?? "";

    // Project-type bridges (Godot) use relative path under project root
    if (bridge.installType === "project" && bridge.installPath?.relative) {
      return `${basePath}/${bridge.installPath.relative}`;
    }

    // User/engine types with detected version path (Houdini, Unreal)
    if (pathTemplate.includes("{appVersion}")) {
      if (!basePath) return pathTemplate; // Can't resolve version without a base path
      const parts = basePath.replace(/\\/g, "/").split("/");
      let versionPart = parts[parts.length - 1] ?? "";
      for (const prefix of ["UE_", "UE-", "Houdini", "houdini"]) {
        if (versionPart.startsWith(prefix)) {
          versionPart = versionPart.slice(prefix.length);
          break;
        }
      }
      return pathTemplate.replace("{appVersion}", versionPart);
    }

    if (pathTemplate) return pathTemplate;
    return basePath;
  }

  async function browseForPath(index: number) {
    const bs = bridges[index];
    const folder = await open({
      directory: true,
      title: `Select ${bs.bridge.program} install location`,
    });
    if (folder) {
      bridges[index] = {
        ...bs,
        selectedPath: folder as string,
        selected: true,
      };
    }
  }

  function toggleBridge(index: number) {
    const bs = bridges[index];
    bridges[index] = { ...bs, selected: !bs.selected };
  }

  function selectPath(index: number, path: string) {
    const bs = bridges[index];
    bridges[index] = { ...bs, selectedPath: path };
  }

  async function installSelected() {
    batchInstalling = true;
    let count = 0;

    for (let i = 0; i < bridges.length; i++) {
      const bs = bridges[i];
      if (!bs.selected || (bs.installed && !bs.updateAvailable)) continue;
      if (!bs.selectedPath) {
        bridges[i] = { ...bs, error: "No install path selected" };
        continue;
      }
      if (!bs.bridge.downloadUrl) {
        bridges[i] = { ...bs, error: "No download URL available" };
        continue;
      }

      bridges[i] = { ...bs, installing: true, error: "" };
      try {
        const targetPath = resolveInstallPath(bs.bridge, bs.selectedPath);
        await invoke("download_and_install_bridge", {
          downloadUrl: bs.bridge.downloadUrl,
          installPath: targetPath,
        });
        await invoke("save_bridge_installation", {
          bridgeId: bs.bridge.id,
          version: bs.bridge.version,
          installPath: targetPath,
        });
        bridges[i] = { ...bs, installing: false, installed: true, error: "" };
        count++;
      } catch (e: any) {
        bridges[i] = { ...bs, installing: false, error: e?.toString() ?? "Install failed" };
      }
    }

    wizard.bridgesInstalled = count;
    batchInstalling = false;
  }

  let selectedCount = $derived(bridges.filter((b) => b.selected && (!b.installed || b.updateAvailable)).length);
</script>

<div class="bridge-setup">
  <h3>Install Bridge Plugins</h3>
  <p class="subtitle">Bridge plugins connect your DCC apps to Arkestrator. Select the apps you have installed.</p>

  {#if loading}
    <div class="loading">Scanning for installed applications...</div>
  {:else if error && bridges.length === 0}
    <div class="error">{error}</div>
  {:else if bridges.length === 0}
    <div class="empty">No bridge plugins available for your platform.</div>
  {:else}
    <div class="bridge-list">
      {#each bridges as bs, i (bs.bridge.id)}
        <div
          class="bridge-card"
          class:selected={bs.selected}
          class:installed={bs.installed && !bs.updateAvailable}
          class:update-available={bs.updateAvailable}
        >
          <div class="bridge-header">
            <label class="bridge-check">
              <input
                type="checkbox"
                checked={bs.selected || (bs.installed && !bs.updateAvailable)}
                disabled={(bs.installed && !bs.updateAvailable) || bs.installing}
                onchange={() => toggleBridge(i)}
              />
              <div class="bridge-info">
                <span class="bridge-name">
                  {bs.bridge.name}
                  {#if bs.bridge.stability && bs.bridge.stability !== "stable"}
                    <span class="stability-badge">{bs.bridge.stability}</span>
                  {/if}
                </span>
                <span class="bridge-desc">{bs.bridge.description}</span>
              </div>
            </label>
            <div class="bridge-badges">
              {#if bs.updateAvailable}
                <span class="badge update">Update → v{bs.bridge.version}</span>
              {:else if bs.installed}
                <span class="badge installed">Installed</span>
              {:else if bs.installing}
                <span class="badge installing">Installing...</span>
              {:else if bs.detected.length > 0}
                <span class="badge detected">Detected</span>
              {:else}
                <span class="badge not-found">Not found</span>
              {/if}
            </div>
          </div>

          {#if (bs.updateAvailable || !bs.installed) && (bs.selected || bs.detected.length > 0)}
            <div class="path-section">
              {#if bs.detected.length > 0}
                {#if bs.detected.length === 1}
                  <div class="detected-path">
                    <code>{bs.detected[0].path}</code>
                  </div>
                {:else}
                  <select
                    class="path-select"
                    value={bs.selectedPath}
                    onchange={(e) => selectPath(i, (e.target as HTMLSelectElement).value)}
                  >
                    {#each bs.detected as dp}
                      <option value={dp.path}>{dp.label || dp.path}</option>
                    {/each}
                  </select>
                {/if}
              {:else}
                <div class="no-detect">
                  <span>App not auto-detected.</span>
                  <button class="browse-btn" onclick={() => browseForPath(i)}>Browse...</button>
                </div>
                {#if bs.selectedPath}
                  <div class="detected-path">
                    <code>{bs.selectedPath}</code>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}

          {#if bs.error}
            <div class="card-error">{bs.error}</div>
          {/if}
        </div>
      {/each}
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button
        class="btn primary"
        disabled={selectedCount === 0 || batchInstalling}
        onclick={installSelected}
      >
        {batchInstalling ? "Installing..." : selectedCount === 0 ? "All up to date" : `Install / Update ${selectedCount} Plugin${selectedCount === 1 ? "" : "s"}`}
      </button>
      <span class="skip-hint">You can also install bridges later in Settings.</span>
    </div>
  {/if}
</div>

<style>
  .bridge-setup {
    text-align: left;
  }
  h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 16px;
  }
  .loading, .empty {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
    padding: 24px 0;
  }
  .error {
    font-size: 12px;
    color: #ff9d9d;
    padding: 8px;
    background: rgba(244, 71, 71, 0.1);
    border-radius: var(--radius-sm);
    margin-top: 8px;
  }
  .bridge-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 340px;
    overflow-y: auto;
  }
  .bridge-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    background: var(--bg-base);
    transition: border-color 0.15s;
  }
  .bridge-card.selected {
    border-color: var(--accent);
  }
  .bridge-card.installed {
    border-color: #4ade80;
    opacity: 0.8;
  }
  .bridge-card.update-available {
    border-color: var(--status-queued, #e2b93d);
    opacity: 1;
  }
  .bridge-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .bridge-check {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex: 1;
    cursor: pointer;
  }
  .bridge-check input {
    margin-top: 3px;
    flex-shrink: 0;
  }
  .bridge-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .bridge-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stability-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(250, 204, 21, 0.15);
    color: #facc15;
    font-weight: 500;
  }
  .bridge-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.3;
  }
  .bridge-badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .badge.detected {
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }
  .badge.installed {
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }
  .badge.update {
    background: rgba(226, 185, 61, 0.15);
    color: #e2b93d;
  }
  .badge.installing {
    background: rgba(96, 165, 250, 0.15);
    color: #60a5fa;
  }
  .badge.not-found {
    background: var(--bg-hover);
    color: var(--text-muted);
  }
  .path-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .detected-path {
    display: flex;
    align-items: center;
  }
  .detected-path code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
  }
  .path-select {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
  }
  .no-detect {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .browse-btn {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
  }
  .browse-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .card-error {
    font-size: 11px;
    color: #ff9d9d;
    margin-top: 6px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .skip-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.primary:disabled {
    opacity: 0.5;
    cursor: default;
    filter: none;
  }
</style>
