<script lang="ts">
  import { auth } from "../lib/stores/auth.svelte";
  import brandLogo from "../assets/brand/arkestrator-logo_brandname.svg";

  let username = $state("");
  let password = $state("");
  let totpCode = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);
  const adminVersion = __ADMIN_VERSION__;

  async function handleSubmit(e: Event) {
    e.preventDefault();
    loading = true;
    error = null;
    try {
      if (auth.needs2fa) {
        await auth.verifyTotp(totpCode);
      } else {
        await auth.login(username, password);
      }
    } catch (err: any) {
      error = err.message || "Login failed";
    } finally {
      loading = false;
    }
  }

  function goBack() {
    auth.challengeToken = null;
    totpCode = "";
    error = null;
  }
</script>

<div class="login-page">
  <div class="login-card">
    <div class="login-brand">
      <img class="login-title-logo" src={brandLogo} alt="Arkestrator" />
    </div>
    <p class="login-subtitle">Admin Dashboard v{adminVersion}</p>

    <form onsubmit={handleSubmit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}

      {#if auth.needs2fa}
        <p class="totp-info">Enter the 6-digit code from your authenticator app</p>
        <label class="field">
          <span>Authentication Code</span>
          <input
            type="text"
            bind:value={totpCode}
            placeholder="000 000"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="8"
          />
        </label>
        <p class="totp-hint">You can also use a recovery code</p>
        <div class="btn-row">
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button type="submit" class="login-btn" disabled={loading}>
            {loading ? "Verifying..." : "Verify"}
          </button>
        </div>
      {:else}
        <label class="field">
          <span>Username</span>
          <input type="text" bind:value={username} required />
        </label>

        <label class="field">
          <span>Password</span>
          <input type="password" bind:value={password} required />
        </label>

        <button type="submit" class="login-btn" disabled={loading}>
          {loading ? "Logging in..." : "Login"}
        </button>
      {/if}
    </form>
  </div>
</div>

<style>
  .login-page {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }

  .login-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 40px;
    width: 360px;
  }

  .login-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin-bottom: 12px;
  }

  .login-title-logo {
    width: 214px;
    max-width: 100%;
  }

  .login-subtitle {
    color: var(--text-muted);
    text-align: center;
    margin-bottom: 6px;
  }

  .field {
    display: block;
    margin-bottom: 16px;
  }

  .field span {
    display: block;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .field input {
    width: 100%;
  }

  .error {
    background: rgba(244, 71, 71, 0.15);
    color: var(--status-failed);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    margin-bottom: 16px;
  }

  .totp-info {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 16px;
  }

  .totp-hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 16px;
  }

  .login-btn {
    width: 100%;
    padding: 10px;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-md);
    font-weight: 500;
    font-size: var(--font-size-lg);
  }

  .login-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .login-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-row {
    display: flex;
    gap: 8px;
  }

  .back-btn {
    padding: 10px 16px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-radius: var(--radius-md);
    font-weight: 500;
  }

  .back-btn:hover {
    background: var(--bg-active);
  }

  .btn-row .login-btn {
    flex: 1;
  }
</style>
