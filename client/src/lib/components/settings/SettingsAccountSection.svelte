<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { connect, disconnect } from "../../api/ws";
  import { api } from "../../api/rest";
  import TotpSetupModal from "../ui/TotpSetupModal.svelte";

  // Account section
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let pwChanging = $state(false);
  let pwResult = $state("");
  let pwError = $state("");

  // 2FA
  let showTotpSetup = $state(false);
  let totpDisabling = $state(false);
  let totpDisablePassword = $state("");
  let totpDisableCode = $state("");
  let totpDisableError = $state("");
  let showDisable2fa = $state(false);

  // Clear local data

  async function changePassword() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      pwError = "All fields are required";
      return;
    }
    if (newPassword !== confirmPassword) {
      pwError = "New passwords do not match";
      return;
    }
    pwError = "";
    pwResult = "";
    pwChanging = true;
    try {
      await api.auth.changePassword(currentPassword, newPassword, confirmPassword);
      pwResult = "Password changed successfully.";
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
    } catch (err: any) {
      pwError = err?.message ?? "Failed to change password";
    } finally {
      pwChanging = false;
    }
  }

  async function disable2fa() {
    if (!totpDisablePassword) {
      totpDisableError = "Password is required";
      return;
    }
    totpDisableError = "";
    totpDisabling = true;
    try {
      await api.auth.totpDisable(totpDisablePassword, totpDisableCode || undefined);
      connection.totpEnabled = false;
      connection.saveSession();
      showDisable2fa = false;
      totpDisablePassword = "";
      totpDisableCode = "";
    } catch (err: any) {
      totpDisableError = err?.message ?? "Failed to disable 2FA";
    } finally {
      totpDisabling = false;
    }
  }

  function signOut() {
    disconnect();
    connection.signOut();
  }

</script>

<section>
  <h3>Current Session</h3>
  <p>Logged in as <strong>{connection.username}</strong> ({connection.userRole})</p>
  <button class="btn danger" onclick={signOut} style="margin-top: 8px;">Sign Out</button>
</section>

<section>
  <h3>Account</h3>

  <div class="account-subsection">
    <h4>Change Password</h4>
    <div class="form-group">
      <label>
        Current Password
        <input type="password" bind:value={currentPassword} placeholder="Current password" autocomplete="current-password" />
      </label>
      <label>
        New Password
        <input type="password" bind:value={newPassword} placeholder="New password" autocomplete="new-password" />
      </label>
      <label>
        Confirm New Password
        <input type="password" bind:value={confirmPassword} placeholder="Confirm new password" autocomplete="new-password" />
      </label>
      <button class="btn" onclick={changePassword} disabled={pwChanging}>
        {pwChanging ? "Changing..." : "Change Password"}
      </button>
      {#if pwError}
        <span class="result error-text">{pwError}</span>
      {/if}
      {#if pwResult}
        <span class="result success-text">{pwResult}</span>
      {/if}
    </div>
  </div>

  <div class="account-subsection">
    <h4>Two-Factor Authentication</h4>
    {#if connection.totpEnabled}
      <p class="status-line"><span class="status-badge enabled">Enabled</span> Two-factor authentication is active on your account.</p>
      {#if !showDisable2fa}
        <button class="btn danger" onclick={() => showDisable2fa = true}>Disable 2FA</button>
      {:else}
        <div class="form-group disable-2fa-form">
          <label>
            Password
            <input type="password" bind:value={totpDisablePassword} placeholder="Current password" />
          </label>
          <label>
            TOTP Code
            <input bind:value={totpDisableCode} placeholder="6-digit code" inputmode="numeric" maxlength="8" />
          </label>
          {#if totpDisableError}
            <span class="result error-text">{totpDisableError}</span>
          {/if}
          <div class="btn-group">
            <button class="btn" onclick={() => { showDisable2fa = false; totpDisableError = ""; totpDisablePassword = ""; totpDisableCode = ""; }}>Cancel</button>
            <button class="btn danger" onclick={disable2fa} disabled={totpDisabling}>
              {totpDisabling ? "Disabling..." : "Confirm Disable"}
            </button>
          </div>
        </div>
      {/if}
    {:else}
      <p class="status-line"><span class="status-badge disabled">Disabled</span> Add an extra layer of security to your account.</p>
      <button class="btn" onclick={() => showTotpSetup = true}>Enable 2FA</button>
    {/if}
  </div>
</section>

<TotpSetupModal
  open={showTotpSetup}
  forced={false}
  onclose={() => showTotpSetup = false}
  oncomplete={() => {
    showTotpSetup = false;
    connection.totpEnabled = true;
    connection.saveSession();
  }}
/>


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
  .btn-group { display: flex; gap: 8px; }
  .result {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .error-text {
    color: var(--status-failed) !important;
  }
  .success-text {
    color: var(--status-completed) !important;
  }
  .account-subsection {
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .account-subsection:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  .account-subsection h4 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-primary);
  }
  .status-line {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .status-badge.enabled {
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
  }
  .status-badge.disabled {
    background: rgba(102, 102, 102, 0.15);
    color: var(--text-muted);
  }
  .disable-2fa-form {
    margin-top: 8px;
    padding: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
</style>
