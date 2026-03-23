<script lang="ts">
  import { api } from "../lib/api/client";
  import { auth } from "../lib/stores/auth.svelte";
  import { toast } from "../lib/stores/toast.svelte";

  let showResetModal = $state(false);
  let resetPassword = $state("");
  let resetConfirmation = $state("");
  let resetError = $state("");
  let resetBusy = $state(false);

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
      await api.system.factoryReset(resetPassword, resetConfirmation);
      toast.success("Factory reset complete. Logging out...");
      showResetModal = false;
      // Log out after a brief delay so the toast is visible
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
  }
</script>

<div class="page">
  <h2>System</h2>

  <div class="danger-zone">
    <h3>Danger Zone</h3>

    <div class="danger-card">
      <div class="danger-info">
        <h4>Factory Reset</h4>
        <p>
          Wipe all server data including jobs, sessions, API keys, agent configs, policies, workers, and audit logs.
          Your admin account will be preserved. All other users will be deleted.
        </p>
      </div>
      <button class="btn-danger" onclick={() => showResetModal = true}>Factory Reset</button>
    </div>
  </div>
</div>

{#if showResetModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={closeModal}>
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <h3>Factory Reset</h3>
      <p class="warning">This action is irreversible. All server data will be permanently deleted except your admin account.</p>
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
  .page { padding: 24px; }
  h2 { font-size: var(--font-size-xl); font-weight: 600; margin-bottom: 24px; }

  .danger-zone {
    border: 1px solid var(--status-failed);
    border-radius: var(--radius-lg);
    padding: 20px;
  }
  .danger-zone h3 {
    color: var(--status-failed);
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin-bottom: 16px;
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
