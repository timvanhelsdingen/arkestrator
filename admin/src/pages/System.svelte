<script lang="ts">
  import { api } from "../lib/api/client";
  import { auth } from "../lib/stores/auth.svelte";
  import { toast } from "../lib/stores/toast.svelte";

  type Tab = "settings" | "danger";
  let activeTab = $state<Tab>("settings");

  // ── System Settings state ──
  let loading = $state(true);
  let saving = $state(false);
  let jobTimeoutMin = $state(30);
  let maxConcurrentAgents = $state(8);
  let logLevel = $state("info");
  let workerPollMs = $state(500);
  let defaultWorkspaceMode = $state("auto");
  let wsMaxPayloadMb = $state(256);

  // ── Coordination Policy ──
  let allowClientCoordination = $state(false);
  let policyLoading = $state(false);
  let policySaving = $state(false);

  async function loadConfig() {
    loading = true;
    try {
      const cfg = await api.system.getConfig();
      jobTimeoutMin = Math.round(cfg.jobTimeoutMs / 60_000);
      maxConcurrentAgents = cfg.maxConcurrentAgents;
      logLevel = cfg.logLevel;
      workerPollMs = cfg.workerPollMs;
      defaultWorkspaceMode = cfg.defaultWorkspaceMode;
      wsMaxPayloadMb = cfg.wsMaxPayloadMb;
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load system config");
    } finally {
      loading = false;
    }
    // Load coordination policy alongside system config
    if (auth.canManageSecurity) {
      policyLoading = true;
      try {
        const result = await api.settings.get();
        allowClientCoordination = !!result?.allowClientCoordination;
      } catch { /* ignore */ } finally {
        policyLoading = false;
      }
    }
  }

  async function setAllowClientCoordination(enabled: boolean) {
    if (!auth.canManageSecurity) return;
    policySaving = true;
    try {
      const result = await api.settings.setAllowClientCoordination(enabled);
      allowClientCoordination = !!result?.allowClientCoordination;
      toast.success(allowClientCoordination ? "Global client-side coordination enabled." : "Global client-side coordination disabled.");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update coordination policy");
    } finally {
      policySaving = false;
    }
  }

  async function saveConfig() {
    saving = true;
    try {
      const res = await api.system.updateConfig({
        jobTimeoutMs: jobTimeoutMin * 60_000,
        maxConcurrentAgents,
        logLevel,
        workerPollMs,
        defaultWorkspaceMode,
        wsMaxPayloadMb,
      });
      toast.success(`Settings saved (${res.updated.length} updated)`);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save settings");
    } finally {
      saving = false;
    }
  }

  // Load on mount
  $effect(() => { loadConfig(); });

  // ── Danger Zone state ──
  let showResetModal = $state(false);
  let resetPassword = $state("");
  let resetConfirmation = $state("");
  let resetError = $state("");
  let resetBusy = $state(false);
  let clearTrainingData = $state(false);

  async function factoryReset() {
    if (!resetPassword) {
      resetError = "Password is required";
      return;
    }
    if (resetConfirmation !== "RESET") {
      resetError = 'Type "RESET" to confirm';
      return;
    }
    resetError = "";
    resetBusy = true;
    try {
      await api.system.factoryReset(resetPassword, resetConfirmation, clearTrainingData);
      toast.success("Factory reset complete. Logging out...");
      showResetModal = false;
      setTimeout(() => auth.logout(), 1500);
    } catch (err: any) {
      resetError = err?.message ?? "Factory reset failed";
    } finally {
      resetBusy = false;
    }
  }

  function closeModal() {
    showResetModal = false;
    resetPassword = "";
    resetConfirmation = "";
    resetError = "";
    clearTrainingData = false;
  }
</script>

<div class="system-page">
  <div class="tab-bar">
    <button class="tab" class:active={activeTab === "settings"} onclick={() => (activeTab = "settings")}>
      System Settings
    </button>
    <button class="tab" class:active={activeTab === "danger"} onclick={() => (activeTab = "danger")}>
      Danger Zone
    </button>
  </div>

  <div class="tab-content">
    {#if activeTab === "settings"}
      <div class="page">
        <h2>System Settings</h2>
        <p class="subtitle">Runtime configuration for the server. Changes take effect immediately for new jobs.</p>

        {#if loading}
          <p class="muted">Loading...</p>
        {:else}
          <div class="settings-grid">
            <div class="setting">
              <label for="jobTimeout">Job Timeout (minutes)</label>
              <p class="hint">Maximum time a job can run before being killed. Default: 30 min.</p>
              <input id="jobTimeout" type="number" min="1" max="1440" bind:value={jobTimeoutMin} />
            </div>

            <div class="setting">
              <label for="maxAgents">Max Concurrent Agents</label>
              <p class="hint">How many jobs can run in parallel. Default: 8.</p>
              <input id="maxAgents" type="number" min="1" max="64" bind:value={maxConcurrentAgents} />
            </div>

            <div class="setting">
              <label for="logLevel">Log Level</label>
              <p class="hint">Server log verbosity.</p>
              <select id="logLevel" bind:value={logLevel}>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div class="setting">
              <label for="pollMs">Worker Poll Interval (ms)</label>
              <p class="hint">How often workers check for queued jobs. Lower = more responsive, higher = less CPU. Default: 500.</p>
              <input id="pollMs" type="number" min="100" max="10000" step="100" bind:value={workerPollMs} />
            </div>

            <div class="setting">
              <label for="wsPayload">WebSocket Max Payload (MB)</label>
              <p class="hint">Maximum size of a single WebSocket message. Applies to file transfers (EXR, PSD, etc.). Requires server restart. Default: 256 MB.</p>
              <input id="wsPayload" type="number" min="1" bind:value={wsMaxPayloadMb} />
            </div>

            <div class="setting">
              <label for="wsMode">Default Workspace Mode</label>
              <p class="hint">How the agent accesses the project filesystem by default.</p>
              <select id="wsMode" bind:value={defaultWorkspaceMode}>
                <option value="auto">Auto</option>
                <option value="command">Command</option>
                <option value="repo">Repo</option>
                <option value="sync">Sync</option>
              </select>
            </div>
          </div>

          <div class="actions-row">
            <button class="btn-primary" onclick={saveConfig} disabled={saving}>
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>

          {#if auth.canManageSecurity}
            <div class="policy-section">
              <h3>Coordination Policy</h3>
              <p class="hint">Controls whether non-admin users can enable client-side coordination and queue client-initiated training.</p>
              <label class="toggle-label">
                <input
                  type="checkbox"
                  checked={allowClientCoordination}
                  onchange={(e) => setAllowClientCoordination((e.target as HTMLInputElement).checked)}
                  disabled={policyLoading || policySaving}
                />
                <span>Allow client-side coordination globally</span>
              </label>
              {#if policyLoading}
                <p class="muted">Loading...</p>
              {:else if policySaving}
                <p class="muted">Saving...</p>
              {/if}
            </div>
          {/if}
        {/if}
      </div>

    {:else}
      <div class="page">
        <h2>Danger Zone</h2>

        <div class="danger-zone">
          <div class="danger-card">
            <div class="danger-info">
              <h4>Factory Reset</h4>
              <p>
                Wipe all server data including jobs, sessions, API keys, agent configs, policies, workers, and audit logs.
                All users will be deleted and a default admin account will be re-created.
              </p>
            </div>
            <button class="btn-danger" onclick={() => showResetModal = true}>Factory Reset</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if showResetModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={closeModal}>
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <h3>Factory Reset</h3>
      <p class="warning">This action is irreversible. All server data (users, jobs, skills, settings) will be permanently deleted. A default admin account (admin/admin) will be re-created.</p>
      <div class="form-group">
        <label>
          Admin Password
          <input
            type="password"
            bind:value={resetPassword}
            placeholder="Enter your password"
          />
        </label>
        <label>
          Type <strong>RESET</strong> to confirm
          <input
            bind:value={resetConfirmation}
            placeholder='Type "RESET"'
            onkeydown={(e) => { if (e.key === "Enter") factoryReset(); }}
          />
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={clearTrainingData} />
          Also clear training data
          <span class="hint">Removes learned patterns, experiences, and playbook artifacts. Uncheck to preserve institutional knowledge.</span>
        </label>
        {#if resetError}
          <span class="error">{resetError}</span>
        {/if}
      </div>
      <div class="actions">
        <button class="btn-cancel" onclick={closeModal}>Cancel</button>
        <button class="btn-danger" onclick={factoryReset} disabled={resetBusy}>
          {resetBusy ? "Resetting..." : "Confirm Factory Reset"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .system-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tab-bar {
    display: flex;
    gap: 0;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .tab {
    padding: 10px 20px;
    font-size: var(--font-size-base);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .tab-content {
    flex: 1;
    overflow-y: auto;
  }

  .page { padding: 24px; }
  h2 { font-size: var(--font-size-xl); font-weight: 600; margin-bottom: 4px; }
  .subtitle { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 24px; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }

  /* ── Settings form ── */
  .settings-grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 480px;
  }

  .setting label {
    display: block;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .setting .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .setting input,
  .setting select {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .setting select {
    cursor: pointer;
  }

  .actions-row {
    margin-top: 24px;
    display: flex;
    gap: 8px;
  }
  .btn-primary {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: white;
    font-size: var(--font-size-sm);
    font-weight: 500;
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Danger Zone ── */
  .danger-zone {
    border: 1px solid var(--status-failed);
    border-radius: var(--radius-lg);
    padding: 20px;
  }
  .danger-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .danger-info h4 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .danger-info p {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    max-width: 540px;
  }
  .btn-danger {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    background: var(--status-failed);
    color: white;
    font-size: var(--font-size-sm);
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn-danger:hover { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  .checkbox-label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    margin-top: 4px;
  }
  .checkbox-label input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .checkbox-label .hint {
    display: block;
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 2px;
  }

  /* ── Policy section ── */
  .policy-section {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    max-width: 480px;
  }
  .policy-section h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .policy-section .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .toggle-label input[type="checkbox"] { flex-shrink: 0; }

  /* ── Modal ── */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
  }
  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    min-width: 360px;
    max-width: 440px;
  }
  .dialog h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .warning {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form-group label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .form-group input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .btn-cancel {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
</style>
