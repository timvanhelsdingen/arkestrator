<script lang="ts">
  import { loadSettings, saveSettings, communityApi, type CommunityUser } from "../../api/community";
  import { toast } from "../../stores/toast.svelte";
  import { open } from "@tauri-apps/plugin-shell";

  let settings = $state(loadSettings());
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state("");

  // Auth state
  let tokenInput = $state("");
  let communityUser = $state<CommunityUser | null>(null);
  let loadingUser = $state(false);

  $effect(() => {
    if (settings.authToken && !communityUser) {
      loadingUser = true;
      communityApi.me()
        .then((u) => { communityUser = u; })
        .catch(() => { communityUser = null; })
        .finally(() => { loadingUser = false; });
    }
  });

  function save() {
    saving = true;
    try {
      saveSettings(settings);
      toast.success("Community settings saved");
    } catch (err: any) {
      toast.error(`Failed to save: ${err?.message}`);
    } finally {
      saving = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = "";
    try {
      const programs = await communityApi.getPrograms();
      testResult = `Connected. ${programs.length} programs available.`;
    } catch (err: any) {
      testResult = `Connection failed: ${err?.message}`;
    } finally {
      testing = false;
    }
  }

  async function openGitHubAuth() {
    const baseUrl = settings.baseUrl || "https://arkestrator.com";
    try {
      await open(`${baseUrl}/auth/github`);
    } catch {
      window.open(`${baseUrl}/auth/github`, "_blank");
    }
  }

  function saveToken() {
    if (!tokenInput.trim()) return;
    settings.authToken = tokenInput.trim();
    saveSettings(settings);
    tokenInput = "";
    // Reload user
    communityUser = null;
    loadingUser = true;
    communityApi.me()
      .then((u) => { communityUser = u; toast.success("GitHub account connected"); })
      .catch(() => { communityUser = null; toast.error("Invalid token"); })
      .finally(() => { loadingUser = false; });
  }

  function disconnectAccount() {
    settings.authToken = "";
    saveSettings(settings);
    communityUser = null;
    toast.info("GitHub account disconnected");
  }
</script>

<section>
  <h3>Community Skills</h3>
  <div class="form-group">
    <label class="toggle-label">
      <input type="checkbox" bind:checked={settings.enabled} />
      <span>Enable Community Skills</span>
    </label>
    <p class="desc">Browse and install skills from the Arkestrator community at arkestrator.com.</p>

    <label>
      Community API URL
      <input type="text" bind:value={settings.baseUrl} placeholder="https://arkestrator.com" />
    </label>

    <div class="actions-row">
      <button class="btn" onclick={save} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </button>
      <button class="btn" onclick={testConnection} disabled={testing}>
        {testing ? "Testing..." : "Test Connection"}
      </button>
    </div>
    {#if testResult}
      <p class="test-result" class:success={testResult.startsWith("Connected")}>{testResult}</p>
    {/if}
  </div>
</section>

<section>
  <h3>Community Account</h3>
  <div class="form-group">
    {#if settings.authToken}
      {#if loadingUser}
        <p class="desc">Verifying account...</p>
      {:else if communityUser}
        <div class="user-row">
          {#if communityUser.avatar_url}
            <img class="user-avatar" src={communityUser.avatar_url} alt="" />
          {/if}
          <span>Connected as <strong>{communityUser.username}</strong></span>
        </div>
        <button class="btn btn-danger-text" onclick={disconnectAccount}>Disconnect Account</button>
      {:else}
        <p class="desc">Could not verify account. The token may be expired.</p>
        <button class="btn btn-danger-text" onclick={disconnectAccount}>Reset Token</button>
      {/if}
    {:else}
      <p class="desc">Connect with GitHub to publish your skills to the community.</p>
      <button class="btn btn-accent" onclick={openGitHubAuth}>Connect with GitHub</button>
      <p class="desc">After authenticating, paste the token below:</p>
      <div class="token-row">
        <input
          type="text"
          class="token-input"
          bind:value={tokenInput}
          placeholder="Paste auth token..."
        />
        <button class="btn" onclick={saveToken} disabled={!tokenInput.trim()}>Save</button>
      </div>
    {/if}
  </div>
</section>

<style>
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  h3 {
    font-size: var(--font-size-base);
    margin-bottom: 12px;
    color: var(--text-secondary);
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
  .toggle-label {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);
    cursor: pointer;
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0;
    line-height: 1.4;
  }
  .actions-row {
    display: flex;
    gap: 8px;
  }
  .test-result {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    margin: 0;
  }
  .test-result.success {
    color: var(--status-completed);
  }
  .user-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .user-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  .token-row {
    display: flex;
    gap: 6px;
  }
  .token-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .btn {
    padding: 6px 16px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    align-self: flex-start;
    transition: all 0.15s;
  }
  .btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-accent:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-danger-text {
    color: var(--status-failed);
    background: transparent;
    border-color: transparent;
    padding: 4px 0;
  }
  .btn-danger-text:hover {
    text-decoration: underline;
    background: transparent;
  }
</style>
