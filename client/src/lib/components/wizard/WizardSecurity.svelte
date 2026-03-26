<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { wizard } from "../../stores/wizard.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { serverState, isLoopbackUrl } from "../../stores/server.svelte";
  import { api } from "../../api/rest";
  import { connect } from "../../api/ws";
  import { initMachineIdentity } from "../../api/ws";
  import QRCode from "qrcode";

  interface Props {
    oncomplete: () => void;
  }
  let { oncomplete }: Props = $props();

  // --- Server startup + auto-login state ---
  let autoLoginError = $state("");
  let autoLoginAttempted = $state(false);

  // --- Password change state ---
  let newPassword = $state("");
  let confirmPassword = $state("");
  let passwordError = $state("");
  let changingPassword = $state(false);

  // --- TOTP state ---
  let totpSecret = $state("");
  let totpQrDataUrl = $state("");
  let totpRecoveryCodes: string[] = $state([]);
  let totpLoading = $state(false);
  let totpVerifyCode = $state("");
  let totpVerifying = $state(false);
  let totpError = $state("");
  let totpStep: 1 | 2 | 3 = $state(1);
  let codesAcknowledged = $state(false);
  let copyLabel = $state("Copy All");
  let codeInput: HTMLInputElement | undefined = $state(undefined);

  // Start server automatically when this component mounts
  $effect(() => {
    if (wizard.securitySubStep === "starting" && serverState.canStart) {
      void serverState.start();
    }
  });

  // When server becomes running, attempt auto-login
  $effect(() => {
    if (serverState.isRunning && wizard.securitySubStep === "starting" && !autoLoginAttempted) {
      wizard.securitySubStep = "logging-in";
      void autoLogin();
    }
  });

  // Focus TOTP code input
  $effect(() => {
    if (wizard.securitySubStep === "totp-setup" && totpStep === 2 && codeInput) {
      codeInput.focus();
    }
  });

  async function autoLogin() {
    autoLoginAttempted = true;
    autoLoginError = "";

    // Wait a moment for the server to fully initialize
    await new Promise((r) => setTimeout(r, 1500));

    // Set connection URL
    connection.url = serverState.localUrl;

    // Default bootstrap credentials — server creates admin/admin on first run
    const username = "admin";
    const password = "admin";

    wizard.bootstrapUsername = username;
    wizard.bootstrapPassword = password;

    // Cache machine identity (don't let this block login)
    try {
      await initMachineIdentity();
    } catch {
      // Non-critical — continue with login
    }

    // Login with bootstrap credentials
    try {
      const result = await api.auth.login(username, password);

      // Store session
      connection.sessionToken = result.token;
      connection.username = result.user.username;
      connection.lastUsername = result.user.username;
      connection.userRole = result.user.role;
      connection.allowClientCoordination = !!result.allowClientCoordination;
      connection.clientCoordinationEnabled = !!result.user.clientCoordinationEnabled;
      connection.canEditCoordinator = !!result.canEditCoordinator;
      connection.totpEnabled = !!result.user?.totpEnabled;
      connection.saveSession();
      connection.serverMode = "local";

      // Connect WebSocket
      if (result.apiKey) {
        connect(connection.url, result.apiKey);
      }

      // Move to password change
      wizard.securitySubStep = "change-password";
    } catch (err: any) {
      autoLoginError = err?.message || "Auto-login failed";
    }
  }

  async function retryAutoLogin() {
    autoLoginAttempted = false;
    autoLoginError = "";
    wizard.securitySubStep = "starting";
  }

  async function changePassword() {
    if (!newPassword || !confirmPassword) {
      passwordError = "Both fields are required";
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError = "Passwords do not match";
      return;
    }
    if (newPassword.length < 8) {
      passwordError = "Password must be at least 8 characters";
      return;
    }
    passwordError = "";
    changingPassword = true;
    try {
      await api.auth.changePassword(wizard.bootstrapPassword, newPassword, confirmPassword);
      wizard.passwordChanged = true;
      wizard.securitySubStep = "totp-prompt";
    } catch (err: any) {
      passwordError = err?.message || "Failed to change password";
    } finally {
      changingPassword = false;
    }
  }

  async function startTotpSetup() {
    totpLoading = true;
    totpError = "";
    totpStep = 1;
    try {
      const res = await api.auth.totpSetup();
      totpSecret = res.secret;
      totpRecoveryCodes = res.recoveryCodes;
      totpQrDataUrl = await QRCode.toDataURL(res.uri, { width: 200, margin: 2 });
    } catch (e: any) {
      totpError = e.message || "Failed to start TOTP setup";
    } finally {
      totpLoading = false;
    }
  }

  async function verifyTotp() {
    const code = totpVerifyCode.trim();
    if (code.length !== 6) {
      totpError = "Please enter a 6-digit code";
      return;
    }
    totpVerifying = true;
    totpError = "";
    try {
      await api.auth.totpVerifySetup(code);
      totpStep = 3;
    } catch (e: any) {
      totpError = e.message || "Verification failed";
    } finally {
      totpVerifying = false;
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(totpRecoveryCodes.join("\n"));
      copyLabel = "Copied!";
      setTimeout(() => (copyLabel = "Copy All"), 2000);
    } catch {
      copyLabel = "Failed";
      setTimeout(() => (copyLabel = "Copy All"), 2000);
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(totpSecret);
    } catch {
      // silent
    }
  }

  function finishTotp() {
    wizard.totpSetupDone = true;
    connection.totpEnabled = true;
    connection.saveSession();
    oncomplete();
  }

  function skipTotp() {
    oncomplete();
  }
</script>

<div class="security-step">
  {#if wizard.securitySubStep === "starting" || wizard.securitySubStep === "logging-in"}
    <!-- Auto-starting server + auto-login -->
    <h3>Setting Up Your Server</h3>
    {#if autoLoginError}
      <p class="status-text error-text">{autoLoginError}</p>
      <p class="hint">The server may still be starting. You can retry or skip this step.</p>
      <div class="actions">
        <button class="btn secondary" onclick={retryAutoLogin}>Retry</button>
        <button class="btn secondary" onclick={oncomplete}>Skip</button>
      </div>
    {:else}
      <p class="status-text">
        {#if wizard.securitySubStep === "starting"}
          Starting server...
        {:else}
          Logging in automatically...
        {/if}
      </p>
      {#if serverState.logs.length > 0}
        <div class="log-preview">
          {#each serverState.logs.slice(-4) as line}
            <div class="log-line">{line}</div>
          {/each}
        </div>
      {/if}
      <div class="spinner-row">
        <div class="spinner"></div>
        <span class="hint">This may take a moment on first launch</span>
      </div>
    {/if}

  {:else if wizard.securitySubStep === "change-password"}
    <!-- Password change (mandatory) -->
    <h3>Change Admin Password</h3>
    <p class="description">
      Your server was created with a temporary bootstrap password. Please set a new secure password to continue.
    </p>
    <form class="form" onsubmit={(e) => { e.preventDefault(); changePassword(); }}>
      <label>
        New Password
        <input
          type="password"
          bind:value={newPassword}
          placeholder="Min 8 characters"
          autocomplete="new-password"
          disabled={changingPassword}
        />
      </label>
      <label>
        Confirm Password
        <input
          type="password"
          bind:value={confirmPassword}
          placeholder="Re-enter password"
          autocomplete="new-password"
          disabled={changingPassword}
        />
      </label>
      {#if passwordError}
        <div class="error">{passwordError}</div>
      {/if}
      <div class="actions">
        <button type="submit" class="btn primary" disabled={changingPassword}>
          {changingPassword ? "Changing..." : "Set Password"}
        </button>
      </div>
    </form>

  {:else if wizard.securitySubStep === "totp-prompt"}
    <!-- 2FA choice screen -->
    <h3>Two-Factor Authentication</h3>
    <p class="description">
      Would you like to set up two-factor authentication? This adds an extra layer of security to your account using an authenticator app.
    </p>
    <p class="description recommended">🔒 Recommended for production use</p>
    <div class="actions totp-choice">
      <button class="btn primary" onclick={() => { wizard.securitySubStep = "totp-setup"; void startTotpSetup(); }}>
        Set Up 2FA
      </button>
      <button class="btn secondary" onclick={skipTotp}>
        Skip for Now
      </button>
    </div>

  {:else if wizard.securitySubStep === "totp-setup"}
    <!-- TOTP setup -->
    {#if totpStep === 1}
      <h3>Two-Factor Authentication</h3>
      <p class="description">
        Scan the QR code with your authenticator app (Google Authenticator, Authy, etc).
      </p>
      {#if totpLoading}
        <div class="spinner-row">
          <div class="spinner"></div>
          <span>Generating setup code...</span>
        </div>
      {:else if totpError && !totpQrDataUrl}
        <div class="error">{totpError}</div>
        <div class="actions">
          <button class="btn secondary" onclick={startTotpSetup}>Retry</button>
          <button class="btn secondary" onclick={skipTotp}>Skip 2FA</button>
        </div>
      {:else}
        <div class="qr-container">
          <img src={totpQrDataUrl} alt="TOTP QR Code" class="qr-image" />
        </div>
        <div class="manual-entry">
          <span class="manual-label">Or enter manually:</span>
          <div class="secret-row">
            <code class="secret-text">{totpSecret}</code>
            <button class="btn-icon" onclick={copySecret} title="Copy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="actions">
          <button class="btn secondary" onclick={skipTotp}>Skip 2FA</button>
          <button class="btn primary" onclick={() => { totpStep = 2; totpError = ""; totpVerifyCode = ""; }}>Next</button>
        </div>
      {/if}

    {:else if totpStep === 2}
      <h3>Verify Authenticator Code</h3>
      <p class="description">Enter the 6-digit code from your authenticator app</p>
      <form class="form" onsubmit={(e) => { e.preventDefault(); verifyTotp(); }}>
        <input
          bind:this={codeInput}
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="000000"
          bind:value={totpVerifyCode}
          class="code-input"
          autocomplete="one-time-code"
          disabled={totpVerifying}
        />
        {#if totpError}
          <div class="error">{totpError}</div>
        {/if}
        <div class="actions">
          <button type="button" class="btn secondary" onclick={() => { totpStep = 1; totpError = ""; }} disabled={totpVerifying}>Back</button>
          <button type="submit" class="btn primary" disabled={totpVerifying || totpVerifyCode.trim().length !== 6}>
            {totpVerifying ? "Verifying..." : "Verify"}
          </button>
        </div>
      </form>

    {:else if totpStep === 3}
      <h3>Save Recovery Codes</h3>
      <p class="description">
        Store these codes somewhere safe. Each can only be used once to recover your account.
      </p>
      <div class="recovery-codes">
        {#each totpRecoveryCodes as code}
          <span class="recovery-code">{code}</span>
        {/each}
      </div>
      <button class="btn secondary" onclick={copyRecoveryCodes}>{copyLabel}</button>
      <label class="acknowledge-row">
        <input type="checkbox" bind:checked={codesAcknowledged} />
        <span>I have saved my recovery codes</span>
      </label>
      <div class="actions">
        <button class="btn primary" onclick={finishTotp} disabled={!codesAcknowledged}>Done</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .security-step {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }
  .description {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }
  .status-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0;
  }
  .error-text {
    color: var(--status-failed);
  }
  .hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    padding: 6px 10px;
    background: rgba(244, 71, 71, 0.1);
    border-radius: var(--radius-sm);
  }
  .recommended {
    color: var(--accent);
    font-weight: 500;
    font-size: var(--font-size-sm);
  }
  .totp-choice {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    margin-top: 8px;
  }
  .totp-choice .btn {
    text-align: center;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    border: none;
  }
  .btn.primary {
    background: var(--accent);
    color: white;
  }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.secondary {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .log-preview {
    background: var(--bg-base);
    border-radius: var(--radius-sm);
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    max-height: 80px;
    overflow-y: auto;
    color: var(--text-secondary);
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }
  .spinner-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .qr-container {
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }
  .qr-image {
    border-radius: var(--radius-md);
    background: white;
    padding: 4px;
  }
  .manual-entry {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .manual-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .secret-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .secret-text {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    word-break: break-all;
    flex: 1;
  }
  .btn-icon {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .btn-icon:hover { color: var(--text-primary); }
  .code-input {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 20px;
    letter-spacing: 6px;
    padding: 10px 16px;
  }
  .recovery-codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
  }
  .recovery-code {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    text-align: center;
    padding: 4px 0;
  }
  .acknowledge-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
</style>
