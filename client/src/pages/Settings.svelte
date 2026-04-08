<script lang="ts">
  import { connection } from "../lib/stores/connection.svelte";
  import { api } from "../lib/api/rest";
  import { connect } from "../lib/api/ws";
  import SettingsAccountSection from "../lib/components/settings/SettingsAccountSection.svelte";
  import SettingsGeneralTab from "../lib/components/settings/SettingsGeneralTab.svelte";
  import SettingsBridgesTab from "../lib/components/settings/SettingsBridgesTab.svelte";
  import SettingsLlmTab from "../lib/components/settings/SettingsLlmTab.svelte";
  import SettingsCommunityTab from "../lib/components/settings/SettingsCommunityTab.svelte";
  import SettingsApiBridgesTab from "../lib/components/settings/SettingsApiBridgesTab.svelte";

  type SettingsTab = "general" | "account" | "bridges" | "api-bridges" | "llm" | "community";
  let settingsTab = $state<SettingsTab>("general");

  let username = $state(connection.lastUsername || "");
  let password = $state("");
  let loginResult = $state("");

  async function login() {
    loginResult = "Logging in...";
    try {
      const result = await api.auth.login(username, password);
      connection.sessionToken = result.token;
      connection.username = result.user.username;
      connection.lastUsername = result.user.username;
      connection.userRole = result.user.role;
      connection.allowClientCoordination = !!result.allowClientCoordination;
      connection.clientCoordinationEnabled = !!result.user.clientCoordinationEnabled;
      connection.canEditCoordinator = !!result.canEditCoordinator;
      connection.saveSession();
      loginResult = `Logged in as ${result.user.username} (${result.user.role})`;
      if (result.apiKey && !connection.isConnected) {
        connect(connection.url, result.apiKey);
      }
    } catch (err) {
      loginResult = `Login failed: ${err}`;
    }
  }
</script>

<div class="settings-page">
  <h2>Settings</h2>

  {#if !connection.isAuthenticated}
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

  <!-- Tab bar -->
  <div class="settings-tabs">
    <button class="settings-tab" class:active={settingsTab === "general"} onclick={() => (settingsTab = "general")}>
      General
    </button>
    {#if connection.isAuthenticated}
      <button class="settings-tab" class:active={settingsTab === "account"} onclick={() => (settingsTab = "account")}>
        Account
      </button>
    {/if}
    <button class="settings-tab" class:active={settingsTab === "bridges"} onclick={() => (settingsTab = "bridges")}>
      Program Bridges
    </button>
    <button class="settings-tab" class:active={settingsTab === "api-bridges"} onclick={() => (settingsTab = "api-bridges")}>
      API Bridges
    </button>
    <button class="settings-tab" class:active={settingsTab === "llm"} onclick={() => (settingsTab = "llm")}>
      Local LLM
    </button>
    <button class="settings-tab" class:active={settingsTab === "community"} onclick={() => (settingsTab = "community")}>
      Community
    </button>
  </div>

  <!-- Tab content -->
  <div class="settings-tab-content">
    {#if settingsTab === "general"}
      <SettingsGeneralTab />
    {:else if settingsTab === "account" && connection.isAuthenticated}
      <SettingsAccountSection />
    {:else if settingsTab === "bridges"}
      <SettingsBridgesTab />
    {:else if settingsTab === "api-bridges"}
      <SettingsApiBridgesTab />
    {:else if settingsTab === "llm"}
      <SettingsLlmTab />
    {:else if settingsTab === "community"}
      <SettingsCommunityTab />
    {/if}
  </div>
</div>

<style>
  .settings-page {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    max-width: 1100px;
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
  .result {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  /* Tab bar */
  .settings-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .settings-tab {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .settings-tab:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .settings-tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .settings-tab-content {
    min-height: 0;
  }
</style>
