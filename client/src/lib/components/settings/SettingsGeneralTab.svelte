<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { connect, disconnect } from "../../api/ws";
  import { api } from "../../api/rest";
  import { isLoopbackUrl, serverState } from "../../stores/server.svelte";
  import {
    disable as disableAutostart,
    enable as enableAutostart,
    isEnabled as isAutostartEnabled,
  } from "@tauri-apps/plugin-autostart";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { check } from "@tauri-apps/plugin-updater";
  import { invoke } from "@tauri-apps/api/core";
  import { getVersion } from "@tauri-apps/api/app";
  import ServerManager from "../ServerManager.svelte";
  import BugReportModal from "./BugReportModal.svelte";

  const saved = connection.loadSaved();
  let serverUrl = $state(saved.url || serverState.localUrl);
  let testResult = $state("");
  let showBugReport = $state(false);
  let launchOnStartup = $state(false);
  let launchOnStartupLoading = $state(false);
  let launchOnStartupResult = $state("");
  let launchOnStartupLoaded = false;
  let defaultProjectDirInput = $state("");
  let defaultProjectDirPlaceholder = $state("");
  let defaultProjectDirSaving = $state(false);
  let defaultProjectDirResult = $state("");
  let defaultProjectDirLoaded = false;

  // Chat personality
  interface PersonalityPreset {
    id: string;
    name: string;
    description: string;
  }
  let personalityPresets = $state<PersonalityPreset[]>([]);
  let currentPersonality = $state("default");
  let personalityCustomPrompt = $state("");
  let personalityLoaded = $state(false);
  let personalitySaving = $state(false);

  $effect(() => {
    if (connection.isAuthenticated && !personalityLoaded) {
      personalityLoaded = true;
      void loadPersonality();
    }
  });

  async function loadPersonality() {
    try {
      const [presetsRes, currentRes] = await Promise.all([
        api.auth.getChatPersonalityPresets(),
        api.auth.getChatPersonality(),
      ]);
      personalityPresets = (presetsRes as any)?.presets ?? [];
      currentPersonality = (currentRes as any)?.personality ?? "default";
      personalityCustomPrompt = (currentRes as any)?.customPrompt ?? "";
    } catch { /* defaults fine */ }
  }

  async function setPersonality(preset: string) {
    currentPersonality = preset;
    if (preset !== "custom") {
      personalitySaving = true;
      try { await api.auth.setChatPersonality(preset); } catch { /* ignore */ }
      personalitySaving = false;
    }
  }

  async function saveCustomPersonality() {
    if (!personalityCustomPrompt.trim()) return;
    personalitySaving = true;
    try { await api.auth.setChatPersonality("custom", personalityCustomPrompt.trim()); } catch { /* ignore */ }
    personalitySaving = false;
  }

  // Clear local data
  let showClearDataModal = $state(false);
  let clearDataPassword = $state("");
  let clearDataError = $state("");
  let clearDataBusy = $state(false);
  let wipeServerData = $state(false);
  let exportingSnapshot = $state(false);
  let exportSnapshotDone = $state(false);

  // Only show server wipe option for local admin users
  const isLocalAdmin = $derived(
    connection.userRole === "admin" &&
    (connection.serverMode === "local" || isLoopbackUrl(connection.url))
  );

  // Update section
  let currentVersion = $state("");
  let updateAvailable = $state<{version: string; date?: string} | null>(null);
  let updateChecking = $state(false);
  let updateDownloading = $state(false);
  let updateResult = $state("");
  let updateError = $state("");

  $effect(() => {
    if (!launchOnStartupLoaded) {
      launchOnStartupLoaded = true;
      void loadLaunchOnStartup();
    }
  });

  $effect(() => {
    if (connection.isConnected && !defaultProjectDirLoaded) {
      defaultProjectDirLoaded = true;
      void loadDefaultProjectDir();
    }
  });

  $effect(() => {
    getVersion().then(v => { currentVersion = v; }).catch(() => {});
  });

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

  async function loadDefaultProjectDir() {
    try {
      const res = await api.settings.getDefaultProjectDir();
      defaultProjectDirInput = res.path || "";
      defaultProjectDirPlaceholder = res.defaultPath || "";
    } catch {
      // Not critical - leave empty
    }
  }

  async function saveDefaultProjectDir() {
    defaultProjectDirSaving = true;
    defaultProjectDirResult = "";
    try {
      const value = defaultProjectDirInput.trim() || null;
      const res = await api.settings.setDefaultProjectDir(value);
      defaultProjectDirInput = res.path || "";
      defaultProjectDirResult = "Saved";
      setTimeout(() => (defaultProjectDirResult = ""), 2000);
    } catch (err: any) {
      defaultProjectDirResult = `Error: ${err?.message ?? err}`;
    } finally {
      defaultProjectDirSaving = false;
    }
  }

  async function browseDefaultProjectDir() {
    try {
      const folder = await openDialog({
        directory: true,
        title: "Select default project directory",
      });
      if (folder) {
        defaultProjectDirInput = folder as string;
      }
    } catch {
      // User cancelled or dialog unavailable
    }
  }

  async function resetDefaultProjectDir() {
    defaultProjectDirInput = "";
    await saveDefaultProjectDir();
  }

  async function checkForUpdates() {
    updateChecking = true;
    updateError = "";
    updateResult = "";
    updateAvailable = null;
    try {
      const update = await check();
      if (!update) {
        updateResult = "You're on the latest version.";
        return;
      }
      updateAvailable = { version: update.version, date: update.date ?? undefined };
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      // Dev mode — updater never works
      if (import.meta.env.DEV) {
        updateResult = "Update checking is only available in packaged builds.";
      } else if (msg.includes("endpoint") || msg.includes("No endpoints configured") || msg.includes("pubkey") || msg.includes("signature") || msg.includes("release JSON") || msg.includes("latest.json")) {
        // Updater plugin misconfigured or latest.json missing from release
        updateResult = "Auto-update is not available for this release. Check GitHub releases for new versions.";
      } else {
        updateError = msg || "Update check failed";
      }
    } finally {
      updateChecking = false;
    }
  }

  async function downloadAndInstallUpdate() {
    updateDownloading = true;
    updateError = "";
    try {
      const update = await check();
      if (!update) {
        updateResult = "No update available.";
        updateDownloading = false;
        return;
      }
      await update.downloadAndInstall();
      updateResult = `Update ${update.version} installed. Restart to apply.`;
      updateAvailable = null;
    } catch (err: any) {
      updateError = `Update failed: ${err?.message ?? err}`;
    } finally {
      updateDownloading = false;
    }
  }

  async function restartApp() {
    try {
      await invoke("restart_app");
    } catch {
      updateError = "Restart not available in this environment.";
    }
  }

  async function exportServerSnapshot() {
    exportingSnapshot = true;
    try {
      const { saveFileWithDialog } = await import("../../utils/format");
      const snapshot = await api.settings.exportConfigSnapshot(true);
      const json = JSON.stringify(snapshot, null, 2);
      const defaultName = `arkestrator-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const saved = await saveFileWithDialog(defaultName, json, [{ name: "JSON", extensions: ["json"] }], "Export Server Backup");
      if (saved) exportSnapshotDone = true;
    } catch (err: any) {
      clearDataError = `Export failed: ${err?.message ?? err}`;
    } finally {
      exportingSnapshot = false;
    }
  }

  async function clearAllLocalData() {
    if (!clearDataPassword) {
      clearDataError = "Password is required";
      return;
    }
    clearDataError = "";
    clearDataBusy = true;
    try {
      await api.auth.verifyPassword(clearDataPassword);
    } catch {
      clearDataError = "Invalid password";
      clearDataBusy = false;
      return;
    }

    // Optionally wipe server data first (factory reset)
    if (wipeServerData) {
      try {
        await api.settings.factoryReset(clearDataPassword);
      } catch (err: any) {
        clearDataError = `Server reset failed: ${err?.message ?? err}`;
        clearDataBusy = false;
        return;
      }
    }

    disconnect();
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
    window.location.reload();
  }
</script>

{#if connection.serverMode === "local" || isLoopbackUrl(connection.url)}
  <ServerManager />
{/if}

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
        <label class="toggle-row">
          <span class="toggle-text">Available as worker for other machines</span>
          <button
            class="toggle-switch"
            class:on={connection.workerModeEnabled}
            role="switch"
            aria-checked={connection.workerModeEnabled}
            onclick={() => {
              connection.workerModeEnabled = !connection.workerModeEnabled;
              connection.saveSession();
              if (connection.url && connection.apiKey) {
                disconnect();
                void connect(connection.url, connection.apiKey);
              }
            }}
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
        <label class="toggle-row">
          <span class="toggle-text">Auto-enable worker mode when idle</span>
          <button
            class="toggle-switch"
            class:on={connection.idleWorkerEnabled}
            role="switch"
            aria-checked={connection.idleWorkerEnabled}
            onclick={() => {
              connection.idleWorkerEnabled = !connection.idleWorkerEnabled;
              connection.saveSession();
            }}
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
        {#if connection.idleWorkerEnabled}
          <div class="idle-timeout-row">
            <span class="toggle-text">Idle timeout</span>
            <div class="idle-timeout-input">
              <input
                type="number"
                min="1"
                max="120"
                value={connection.idleWorkerMinutes}
                onchange={(e: Event) => {
                  connection.idleWorkerMinutes = Math.max(1, Math.min(120, Number((e.target as HTMLInputElement).value) || 15));
                  connection.saveSession();
                }}
              />
              <span class="idle-unit">min</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="pref-card">
      <div class="pref-card-header">Startup</div>
      <div class="pref-toggles">
        <label class="toggle-row">
          <span class="toggle-text">Launch Arkestrator on system startup</span>
          <button
            class="toggle-switch"
            class:on={launchOnStartup}
            disabled={launchOnStartupLoading}
            role="switch"
            aria-checked={launchOnStartup}
            onclick={() => setLaunchOnStartup(!launchOnStartup)}
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
        {#if launchOnStartupResult}
          <span class="result">{launchOnStartupResult}</span>
        {/if}
      </div>
    </div>

    <div class="pref-card" style="grid-column: 1 / -1;">
      <div class="pref-card-header">Default Project Directory</div>
      <p class="desc">
        Where agents save files when no project is open in a bridge.
        Agents create subfolders automatically based on the task.
      </p>
      <div class="pref-toggles">
        <div class="dir-input-row">
          <input
            type="text"
            bind:value={defaultProjectDirInput}
            placeholder={defaultProjectDirPlaceholder || "~/Documents/Arkestrator"}
            disabled={defaultProjectDirSaving}
          />
          <button class="btn secondary" onclick={browseDefaultProjectDir} disabled={defaultProjectDirSaving}>
            Browse
          </button>
        </div>
        <div class="dir-actions">
          <button class="btn" onclick={saveDefaultProjectDir} disabled={defaultProjectDirSaving}>
            {defaultProjectDirSaving ? "Saving..." : "Save"}
          </button>
          {#if defaultProjectDirInput}
            <button class="btn secondary" onclick={resetDefaultProjectDir} disabled={defaultProjectDirSaving}>
              Reset to Default
            </button>
          {/if}
          {#if defaultProjectDirResult}
            <span class="result">{defaultProjectDirResult}</span>
          {/if}
        </div>
      </div>
    </div>

    {#if connection.isAuthenticated && personalityPresets.length > 0}
      <div class="pref-card" style="grid-column: 1 / -1;">
        <div class="pref-card-header">Chat Personality</div>
        <p class="desc">How Arkestrator talks to you in chat. This is your personal preference — other users can pick their own.</p>
        <div class="personality-grid">
          {#each personalityPresets as preset (preset.id)}
            <button
              class="pers-card"
              class:active={currentPersonality === preset.id}
              disabled={personalitySaving}
              onclick={() => setPersonality(preset.id)}
            >
              <span class="pers-name">{preset.name}</span>
              <span class="pers-desc">{preset.description}</span>
            </button>
          {/each}
          <button
            class="pers-card"
            class:active={currentPersonality === "custom"}
            disabled={personalitySaving}
            onclick={() => setPersonality("custom")}
          >
            <span class="pers-name">Custom</span>
            <span class="pers-desc">Write your own personality</span>
          </button>
        </div>
        {#if currentPersonality === "custom"}
          <div class="custom-personality-row">
            <textarea
              placeholder="Describe how Arkestrator should talk to you..."
              rows="3"
              value={personalityCustomPrompt}
              oninput={(e) => { personalityCustomPrompt = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
            <button class="btn" onclick={saveCustomPersonality} disabled={personalitySaving || !personalityCustomPrompt.trim()}>
              {personalitySaving ? "Saving..." : "Save"}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<section>
  <h3>Client Update</h3>
  <div class="update-section">
    <div class="update-info">
      <span class="update-version">Current version: <strong>{currentVersion || "..."}</strong></span>
      {#if updateAvailable}
        <span class="update-badge">v{updateAvailable.version} available</span>
      {/if}
    </div>
    <div class="btn-group">
      <button class="btn secondary" onclick={checkForUpdates} disabled={updateChecking || updateDownloading}>
        {updateChecking ? "Checking..." : "Check for Updates"}
      </button>
      {#if updateAvailable}
        <button class="btn" onclick={downloadAndInstallUpdate} disabled={updateDownloading}>
          {updateDownloading ? "Downloading..." : `Update to v${updateAvailable.version}`}
        </button>
      {/if}
      {#if updateResult && updateResult.includes("Restart")}
        <button class="btn" onclick={restartApp}>Restart Now</button>
      {/if}
    </div>
    {#if updateResult}
      <span class="result">{updateResult}</span>
    {/if}
    {#if updateError}
      <span class="result error-text">{updateError}</span>
    {/if}
  </div>
</section>

<section>
  <h3>Help & Feedback</h3>
  <p class="section-desc">Found a bug or something not working right? Open a report and we'll look into it.</p>
  <button class="btn secondary" onclick={() => showBugReport = true}>Report a Bug</button>
</section>

{#if showBugReport}
  <BugReportModal onclose={() => showBugReport = false} />
{/if}

{#if connection.isAuthenticated}
  <section class="danger-zone">
    <h3>Danger Zone</h3>
    <p class="danger-desc">Clear all locally stored data including saved credentials, preferences, chat history, and cached settings. This will sign you out and return to the setup screen.</p>
    <button class="btn danger" onclick={() => showClearDataModal = true}>Clear All Local Data</button>
  </section>

  {#if showClearDataModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={() => { showClearDataModal = false; clearDataPassword = ""; clearDataError = ""; wipeServerData = false; exportSnapshotDone = false; }}>
      <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
        <h3>Clear All Local Data</h3>
        <p>This will permanently delete all locally stored data and sign you out. Enter your password to confirm.</p>
        <div class="form-group">
          <label>
            Password
            <input
              type="password"
              bind:value={clearDataPassword}
              placeholder="Enter your password"
              onkeydown={(e) => { if (e.key === "Enter") clearAllLocalData(); }}
            />
          </label>
          {#if isLocalAdmin}
            <label class="wipe-server-label">
              <input type="checkbox" bind:checked={wipeServerData} />
              <span>Also wipe local server data (factory reset)</span>
            </label>
            {#if wipeServerData}
              <p class="wipe-server-warning">⚠ This will delete all jobs, agents, settings, and users (except your account) from the server database. This cannot be undone.</p>
              <div class="export-before-wipe">
                <button class="btn secondary" onclick={exportServerSnapshot} disabled={exportingSnapshot || exportSnapshotDone}>
                  {exportingSnapshot ? "Exporting..." : exportSnapshotDone ? "✓ Exported" : "Export Backup First"}
                </button>
                {#if exportSnapshotDone}
                  <span class="export-hint">Backup saved to your downloads folder</span>
                {/if}
              </div>
            {/if}
          {/if}
          {#if clearDataError}
            <span class="result error-text">{clearDataError}</span>
          {/if}
        </div>
        <div class="modal-actions">
          <button class="btn" onclick={() => { showClearDataModal = false; clearDataPassword = ""; clearDataError = ""; wipeServerData = false; exportSnapshotDone = false; }}>Cancel</button>
          <button class="btn danger" onclick={clearAllLocalData} disabled={clearDataBusy}>
            {clearDataBusy ? "Clearing..." : wipeServerData ? "Clear Data & Reset Server" : "Clear Data"}
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  h3 { font-size: var(--font-size-base); margin-bottom: 12px; color: var(--text-secondary); }
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
  .error-text {
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
    padding: 16px;
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
    gap: 0;
    align-items: stretch;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--bg-elevated, #3a3a3c);
    border: none;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.2s ease;
  }
  .toggle-switch.on {
    background: var(--accent);
  }
  .toggle-switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s ease;
    pointer-events: none;
  }
  .toggle-switch.on .toggle-knob {
    transform: translateX(16px);
  }
  .idle-timeout-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .idle-timeout-row:last-child { border-bottom: none; }
  .idle-timeout-input {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .idle-timeout-input input {
    width: 52px;
    padding: 3px 6px;
    text-align: center;
  }
  .idle-unit {
    font-size: var(--font-size-xs, 11px);
    color: var(--text-muted);
  }
  .dir-input-row {
    display: flex;
    gap: 8px;
    width: 100%;
  }
  .dir-input-row input {
    flex: 1;
    min-width: 0;
  }
  .dir-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .update-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .update-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .update-version {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .update-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
  }
  .danger-zone {
    border: 1px solid var(--status-failed);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-top: 8px;
  }
  .danger-zone h3 {
    color: var(--status-failed);
  }
  .section-desc,
  .danger-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 12px;
    line-height: 1.5;
  }
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
  }
  .modal-dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    min-width: 320px;
    max-width: 420px;
  }
  .modal-dialog h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .modal-dialog p {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  /* Personality picker */
  .personality-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 8px;
  }
  .pers-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    background: var(--bg-surface);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pers-card:hover { border-color: var(--text-muted); }
  .pers-card.active {
    border-color: var(--accent);
    background: rgba(99, 102, 241, 0.1);
  }
  .pers-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .pers-card.active .pers-name { color: var(--accent); }
  .pers-desc {
    font-size: 10px;
    color: var(--text-muted);
    line-height: 1.3;
  }
  .custom-personality-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }
  .custom-personality-row textarea {
    font-size: 12px;
    font-family: inherit;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-primary);
    resize: vertical;
    min-height: 60px;
  }
  .custom-personality-row .btn {
    align-self: flex-end;
  }

  @media (max-width: 1100px) {
    .prefs-grid { grid-template-columns: 1fr; }
  }
  .wipe-server-label {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-top: 4px;
  }
  .export-before-wipe {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .export-hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
  }
  .wipe-server-warning {
    font-size: 11px;
    color: var(--status-failed);
    background: rgba(244, 71, 71, 0.08);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    line-height: 1.5;
    margin: 0;
  }
</style>
