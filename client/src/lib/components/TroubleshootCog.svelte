<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { connection } from "../stores/connection.svelte";
  import { api } from "../api/rest";

  interface Props {
    /** Whether we can access the local Tauri server (for full reset). */
    canFullReset?: boolean;
  }

  let { canFullReset = true }: Props = $props();

  let showMenu = $state(false);
  let confirmingFullReset = $state(false);
  let resetting = $state(false);
  let wipingSkills = $state(false);
  let resetError = $state("");

  function clearClientData() {
    localStorage.clear();
    window.location.reload();
  }

  async function wipeSkills() {
    wipingSkills = true;
    resetError = "";
    try {
      await api.skills.wipeAll();
      showMenu = false;
    } catch (err: any) {
      resetError = `Skill wipe failed: ${err?.message ?? err}`;
    } finally {
      wipingSkills = false;
    }
  }

  async function fullReset() {
    resetting = true;
    resetError = "";
    try {
      // Try to wipe skills via API first (server-side)
      try { await api.skills.wipeAll(); } catch { /* server may not be reachable */ }
      // Wipe the Tauri app data dir (production server data)
      try { await invoke("wipe_app_data_dir"); } catch { /* may fail in dev mode */ }
      // Wipe the dev-mode server data dir via API
      try {
        const res = await fetch("http://localhost:7800/api/settings/dev-reset", { method: "POST" });
        if (!res.ok) throw new Error("dev-reset not available");
      } catch { /* not critical — production uses wipe_app_data_dir */ }
      localStorage.clear();
      // Restart the app, fall back to page reload if Tauri restart fails (dev mode)
      try {
        await invoke("restart_app");
      } catch {
        window.location.reload();
      }
    } catch (err: any) {
      resetting = false;
      confirmingFullReset = false;
      resetError = `Reset failed: ${err?.message ?? err}`;
    }
  }

  function close() {
    showMenu = false;
    confirmingFullReset = false;
    resetError = "";
  }
</script>

<div class="troubleshoot-wrapper">
  <button
    class="troubleshoot-btn"
    title="Troubleshooting options"
    onclick={() => { showMenu = !showMenu; confirmingFullReset = false; resetError = ""; }}
    type="button"
  >&#9881; Troubleshoot</button>
  {#if showMenu}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={close}></div>
    <div class="menu">
      <button
        class="menu-item"
        onclick={() => { showMenu = false; clearClientData(); }}
        type="button"
      >
        <strong>Clear Client Data</strong>
        <span>Clears saved credentials and session. Does not affect the server.</span>
      </button>

      {#if connection.isAuthenticated}
        <button
          class="menu-item"
          onclick={wipeSkills}
          disabled={wipingSkills}
          type="button"
        >
          <strong>{wipingSkills ? "Wiping..." : "Wipe All Skills"}</strong>
          <span>Deletes all skills from the server. They will be re-seeded on next restart.</span>
        </button>
      {/if}

      {#if canFullReset}
        {#if !confirmingFullReset}
          <button
            class="menu-item danger"
            onclick={() => { confirmingFullReset = true; }}
            type="button"
          >
            <strong>Full Factory Reset</strong>
            <span>Stops the server, wipes all data (DB, skills, playbooks), and restarts fresh.</span>
          </button>
        {:else}
          <div class="confirm">
            <strong>Are you sure?</strong>
            <span>This will delete all server data, users, jobs, skills, and settings.</span>
            <div class="confirm-actions">
              <button
                class="btn-cancel"
                onclick={() => { confirmingFullReset = false; }}
                type="button"
              >Cancel</button>
              <button
                class="btn-reset"
                onclick={() => { showMenu = false; fullReset(); }}
                disabled={resetting}
                type="button"
              >{resetting ? "Resetting..." : "Yes, wipe everything"}</button>
            </div>
          </div>
        {/if}
      {/if}

      {#if resetError}
        <div class="error">{resetError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .troubleshoot-wrapper {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 50;
  }
  .troubleshoot-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    opacity: 0.6;
    transition: opacity 0.15s;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .troubleshoot-btn:hover {
    opacity: 1;
    background: var(--bg-hover);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }
  .menu {
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 260px;
    z-index: 100;
    overflow: hidden;
  }
  .menu-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 10px 14px;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 13px;
  }
  .menu-item:hover {
    background: var(--bg-hover);
  }
  .menu-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .menu-item span {
    font-size: 11px;
    color: var(--text-muted);
  }
  .menu-item.danger strong {
    color: var(--red, #e74c3c);
  }
  .menu-item.danger:hover {
    background: rgba(231, 76, 60, 0.1);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    font-size: 13px;
  }
  .confirm strong {
    color: var(--red, #e74c3c);
  }
  .confirm span {
    font-size: 11px;
    color: var(--text-muted);
  }
  .confirm-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .btn-cancel, .btn-reset {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
  }
  .btn-cancel {
    background: var(--bg-base);
    color: var(--text-secondary);
  }
  .btn-reset {
    background: var(--red, #e74c3c);
    color: white;
    border-color: var(--red, #e74c3c);
  }
  .btn-reset:hover {
    filter: brightness(1.1);
  }
  .btn-reset:disabled {
    opacity: 0.5;
  }
  .error {
    font-size: 11px;
    color: var(--red, #e74c3c);
    padding: 6px 14px;
  }
</style>
