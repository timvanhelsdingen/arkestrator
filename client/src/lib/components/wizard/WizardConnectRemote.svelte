<script lang="ts">
  import { wizard } from "../../stores/wizard.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { serverState, isLoopbackUrl, buildLocalServerUrl } from "../../stores/server.svelte";
  import { api } from "../../api/rest";
  import { connect } from "../../api/ws";
  import { initMachineIdentity } from "../../api/ws";

  interface Props {
    oncomplete: () => void;
  }
  let { oncomplete }: Props = $props();

  // URL entry
  let serverUrl = $state("");
  let urlError = $state("");
  let connecting = $state(false);

  // Login
  let username = $state("admin");
  let password = $state("");
  let loginError = $state("");
  let loggingIn = $state(false);

  // TOTP
  let challengeToken = $state("");
  let totpCode = $state("");

  async function connectToServer() {
    if (!serverUrl) {
      urlError = "Server URL is required";
      return;
    }
    urlError = "";
    connecting = true;
    try {
      connection.url = serverUrl;
      await api.health();
      wizard.connectSubStep = "login";
    } catch {
      urlError = `Cannot reach server at ${serverUrl}`;
    } finally {
      connecting = false;
    }
  }

  async function login() {
    if (!username || !password) {
      loginError = "Username and password are required";
      return;
    }
    loginError = "";
    loggingIn = true;
    try {
      await initMachineIdentity();
      const result = await api.auth.login(username, password);

      if (result.requires2fa) {
        challengeToken = result.challengeToken;
        wizard.connectSubStep = "totp";
        loggingIn = false;
        return;
      }

      completeLogin(result);
    } catch (err: any) {
      loginError = err.message?.includes("401")
        ? "Invalid username or password"
        : `Login failed: ${err.message}`;
    } finally {
      loggingIn = false;
    }
  }

  async function verifyTotp() {
    if (!totpCode) {
      loginError = "Enter your authentication code";
      return;
    }
    loginError = "";
    loggingIn = true;
    try {
      const result = await api.auth.verifyTotp(challengeToken, totpCode);
      completeLogin(result);
    } catch (err: any) {
      loginError = err.message?.includes("401")
        ? "Invalid code"
        : `Verification failed: ${err.message}`;
    } finally {
      loggingIn = false;
    }
  }

  function completeLogin(result: any) {
    connection.sessionToken = result.token;
    connection.username = result.user.username;
    connection.lastUsername = result.user.username;
    connection.userRole = result.user.role;
    connection.allowClientCoordination = !!result.allowClientCoordination;
    connection.clientCoordinationEnabled = !!result.user.clientCoordinationEnabled;
    connection.canEditCoordinator = !!result.canEditCoordinator;
    connection.totpEnabled = !!result.user?.totpEnabled;
    connection.saveSession();
    connection.serverMode = isLoopbackUrl(connection.url) ? "local" : "remote";

    if (result.apiKey) {
      connect(connection.url, result.apiKey);
    }
    oncomplete();
  }
</script>

<div class="connect-step">
  {#if wizard.connectSubStep === "url"}
    <h3>Connect to Server</h3>
    <p class="description">Enter the URL of the Arkestrator server you want to connect to.</p>
    <form class="form" onsubmit={(e) => { e.preventDefault(); connectToServer(); }}>
      <label>
        Server URL
        <input
          bind:value={serverUrl}
          placeholder={buildLocalServerUrl(serverState.port)}
          autocomplete="url"
        />
      </label>
      {#if urlError}
        <div class="error">{urlError}</div>
      {/if}
      <div class="actions">
        <button type="submit" class="btn primary" disabled={connecting}>
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </form>

  {:else if wizard.connectSubStep === "login"}
    <h3>Log In</h3>
    <div class="server-badge">{connection.url}</div>
    <form class="form" onsubmit={(e) => { e.preventDefault(); login(); }}>
      <label>
        Username
        <input bind:value={username} placeholder="admin" autocomplete="username" />
      </label>
      <label>
        Password
        <input bind:value={password} type="password" placeholder="password" autocomplete="current-password" />
      </label>
      {#if loginError}
        <div class="error">{loginError}</div>
      {/if}
      <div class="actions">
        <button type="button" class="btn secondary" onclick={() => { wizard.connectSubStep = "url"; loginError = ""; }}>Back</button>
        <button type="submit" class="btn primary" disabled={loggingIn}>
          {loggingIn ? "Logging in..." : "Log In"}
        </button>
      </div>
    </form>

  {:else if wizard.connectSubStep === "totp"}
    <h3>Two-Factor Authentication</h3>
    <div class="server-badge">{connection.url}</div>
    <p class="description">Enter the 6-digit code from your authenticator app</p>
    <form class="form" onsubmit={(e) => { e.preventDefault(); verifyTotp(); }}>
      <input
        type="text"
        inputmode="numeric"
        maxlength="8"
        placeholder="000 000"
        bind:value={totpCode}
        class="code-input"
        autocomplete="one-time-code"
      />
      {#if loginError}
        <div class="error">{loginError}</div>
      {/if}
      <p class="hint">You can also use a recovery code</p>
      <div class="actions">
        <button type="button" class="btn secondary" onclick={() => { wizard.connectSubStep = "login"; totpCode = ""; loginError = ""; }}>Back</button>
        <button type="submit" class="btn primary" disabled={loggingIn}>
          {loggingIn ? "Verifying..." : "Verify"}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .connect-step {
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
  .hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    margin: 0;
  }
  .server-badge {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
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
  .code-input {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 20px;
    letter-spacing: 6px;
    padding: 10px 16px;
  }
</style>
