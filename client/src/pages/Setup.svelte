<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { connection } from "../lib/stores/connection.svelte";
  import { connect } from "../lib/api/ws";
  import { api } from "../lib/api/rest";
  import {
    buildLocalServerUrl,
    isLoopbackUrl,
    parseLocalServerPortInput,
    serverState,
  } from "../lib/stores/server.svelte";
  import brandLogo from "../assets/brand/arkestrator-logo_brandname.svg";
  import TotpSetupModal from "../lib/components/ui/TotpSetupModal.svelte";

  type Mode = "choose" | "remote" | "local" | "login" | "totp";
  let mode = $state<Mode>("choose");

  // Remote connection
  let serverUrl = $state(connection.loadSaved().url || serverState.localUrl);
  let error = $state("");
  let connecting = $state(false);

  // Local server
  let localStarting = $state(false);
  let localPort = $state(String(serverState.port));

  // When serverState.port changes (e.g. fallback port discovered), update the URL
  $effect(() => {
    const currentLocalUrl = serverState.localUrl;
    // Only auto-update if we're in local/login mode and URL was pointing at localhost
    if ((mode === "login" || mode === "local" || mode === "choose") && isLoopbackUrl(serverUrl)) {
      if (serverUrl !== currentLocalUrl) {
        serverUrl = currentLocalUrl;
        connection.url = currentLocalUrl;
      }
    }
  });

  // Login
  let loginUsername = $state(connection.lastUsername || "admin");
  let loginPassword = $state("");
  let loginError = $state("");
  let loggingIn = $state(false);
  let restoreIncludeServerFiles = $state(true);
  let restoringSnapshot = $state(false);
  let restoreResult = $state("");
  let restoreSnapshotInput: HTMLInputElement | null = null;

  // 2FA
  let challengeToken = $state("");
  let totpCode = $state("");
  let showForcedTotpSetup = $state(false);
  let deferredLoginResult: any = $state(null);

  async function ensureLocalBootstrapPath() {
    try {
      await serverState.ensureDataDir();
    } catch {
      // Leave the hint hidden if the desktop app cannot resolve local app data.
    }
  }

  onMount(() => {
    if (isLoopbackUrl(serverUrl)) {
      void ensureLocalBootstrapPath();
    }
  });

  function parseErrorMessage(status: number, statusText: string, body: string): string {
    try {
      const parsed = JSON.parse(body);
      const message = String(parsed?.error ?? statusText).trim();
      const code = String(parsed?.code ?? "").trim();
      return code ? `${message} (${code})` : message;
    } catch {
      return `${status}: ${body || statusText}`;
    }
  }

  function localAddressPreview(): string {
    const parsed = parseLocalServerPortInput(localPort);
    return buildLocalServerUrl(parsed.ok ? parsed.port : serverState.port);
  }

  async function connectRemote() {
    if (!serverUrl) {
      error = "Server URL is required";
      return;
    }
    error = "";
    connecting = true;
    try {
      // Set URL so REST client knows where to send requests
      connection.url = serverUrl;
      await api.health();
      if (isLoopbackUrl(serverUrl)) {
        void ensureLocalBootstrapPath();
      }
      mode = "login";
    } catch {
      error = `Cannot reach server at ${serverUrl}`;
    } finally {
      connecting = false;
    }
  }

  // Auto-transition to login when local server is running
  $effect(() => {
    if (serverState.status === "running" && localStarting) {
      localStarting = false;
      connection.url = serverState.localUrl;
      serverUrl = serverState.localUrl;
      void ensureLocalBootstrapPath();
      mode = "login";
    }
  });

  $effect(() => {
    const activeUrl = connection.url || serverUrl;
    if (mode === "local" || ((mode === "login" || mode === "totp") && isLoopbackUrl(activeUrl))) {
      void ensureLocalBootstrapPath();
    }
  });

  // Handle server errors
  $effect(() => {
    if (serverState.status === "error" && localStarting) {
      localStarting = false;
      error = serverState.error || "Failed to start server";
    }
  });

  async function startLocal() {
    const parsed = parseLocalServerPortInput(localPort);
    if (!parsed.ok) {
      error = parsed.error;
      return;
    }
    serverState.setPort(parsed.port);
    localStarting = true;
    error = "";
    await serverState.start();
  }

  async function login() {
    if (!loginUsername || !loginPassword) {
      loginError = "Username and password are required";
      return;
    }
    loginError = "";
    loggingIn = true;

    // Ensure connection URL matches the actual server port
    if (isLoopbackUrl(connection.url) || !connection.url) {
      connection.url = serverState.localUrl;
    }

    try {
      const result = await api.auth.login(loginUsername, loginPassword);

      if (result.requires2fa) {
        // 2FA required — show TOTP input
        challengeToken = result.challengeToken;
        mode = "totp";
        loggingIn = false;
        return;
      }

      if (result.requires2faSetup) {
        // Block navigation to main app while setup is pending
        connection.pendingForcedSetup = true;
        // Store login result for later — we need a session token for TOTP setup API calls
        deferredLoginResult = result;
        completeLogin(result);
        showForcedTotpSetup = true;
        loggingIn = false;
        return;
      }

      completeLogin(result);
    } catch (err: any) {
      // If fetch failed and we're on localhost, try discovering the real port from shared config
      if (err.message?.includes("Failed to fetch") && isLoopbackUrl(connection.url)) {
        try {
          const sharedConfig = await invoke<{ serverUrl?: string }>("read_shared_config");
          const sharedUrl = sharedConfig?.serverUrl;
          if (sharedUrl && sharedUrl !== connection.url && isLoopbackUrl(sharedUrl)) {
            // Found a different port — update and retry
            connection.url = sharedUrl;
            serverUrl = sharedUrl;
            const portMatch = sharedUrl.match(/:(\d+)/);
            if (portMatch) {
              serverState.setPort(parseInt(portMatch[1], 10));
            }
            loginError = "";
            // Retry login on the discovered port
            try {
              const result = await api.auth.login(loginUsername, loginPassword);
              if (result.requires2fa) {
                challengeToken = result.challengeToken;
                mode = "totp";
                loggingIn = false;
                return;
              }
              completeLogin(result);
              loggingIn = false;
              return;
            } catch (retryErr: any) {
              loginError = retryErr.message?.includes("401")
                ? "Invalid username or password"
                : `Login failed: ${retryErr.message}`;
              loggingIn = false;
              return;
            }
          }
        } catch {
          // read_shared_config not available
        }
      }
      loginError = err.message?.includes("401") ? "Invalid username or password" : `Login failed: ${err.message}`;
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
      loginError = err.message?.includes("401") ? "Invalid code" : `Verification failed: ${err.message}`;
    } finally {
      loggingIn = false;
    }
  }

  function completeLogin(result: any) {
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
    // Save server mode so we can auto-start on next boot
    // Determine mode by checking the URL the user actually connected to,
    // not whether a local server happens to be running.
    connection.serverMode = isLoopbackUrl(connection.url) ? "local" : "remote";
    // Connect WS with the auto-provisioned API key
    if (result.apiKey) {
      connect(connection.url, result.apiKey);
    }
    // Note: first-time wizard is handled by BootstrapWizard (before Setup is shown)
  }

  function openRestorePicker() {
    restoreSnapshotInput?.click();
  }

  async function importSnapshotFromSetup(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (!file) return;

    if (!loginUsername.trim() || !loginPassword) {
      restoreResult = "";
      loginError = "Enter admin username and password before importing a snapshot.";
      if (target) target.value = "";
      return;
    }

    restoringSnapshot = true;
    restoreResult = "";
    loginError = "";
    try {
      connection.url = serverUrl || connection.url || serverState.localUrl;
      const login = await api.auth.login(loginUsername.trim(), loginPassword);
      if (login?.requires2fa) {
        restoreResult = "";
        loginError = "2FA is required for this account. Log in first, then restore from Settings.";
        return;
      }

      const snapshot = JSON.parse(await file.text());
      const res = await fetch(`${connection.url}/api/settings/config-snapshot/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          snapshot,
          includeServerFiles: restoreIncludeServerFiles,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(parseErrorMessage(res.status, res.statusText, body));
      }

      const result = await res.json().catch(() => null);
      const trainingCount = Number(result?.summary?.trainingWriteCount ?? 0) || 0;
      const serverCount = Number(result?.summary?.serverWriteCount ?? 0) || 0;
      restoreResult = `Snapshot restored (${trainingCount} training files, ${serverCount} server files). Login with imported credentials.`;
      loginPassword = "";
      connection.clearSession();
      challengeToken = "";
      totpCode = "";
      mode = "login";
    } catch (err: any) {
      restoreResult = "";
      loginError = `Snapshot import failed: ${err?.message ?? err}`;
    } finally {
      restoringSnapshot = false;
      if (target) target.value = "";
    }
  }

</script>

<div class="setup-page">
  <div class="setup-card">
    <input
      bind:this={restoreSnapshotInput}
      type="file"
      accept=".json,application/json"
      class="hidden-file-input"
      onchange={importSnapshotFromSetup}
    />
    <img class="brand-logo" src={brandLogo} alt="Arkestrator" />
    <p class="brand-subtitle">AI Agent Orchestration for DCC Pipelines</p>

    {#if mode === "choose"}
      <p class="subtitle">Connect to a server to get started</p>
      <div class="options">
        <button class="option-btn" onclick={() => (mode = "local")}>
          <span class="option-icon">&#9881;</span>
          <strong>Start Local Server</strong>
          <span class="option-desc">Launch a server on this machine</span>
        </button>
        <button class="option-btn" onclick={() => (mode = "remote")}>
          <span class="option-icon">&#9729;</span>
          <strong>Connect to Server</strong>
          <span class="option-desc">Connect to an existing server</span>
        </button>
      </div>

    {:else if mode === "remote"}
      <p class="subtitle">Connect to a server</p>
      <form class="form" onsubmit={(e) => { e.preventDefault(); connectRemote(); }}>
        <label>
          Server URL
          <input bind:value={serverUrl} placeholder={buildLocalServerUrl(serverState.port)} />
        </label>
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <div class="actions">
          <button type="button" class="btn secondary" onclick={() => (mode = "choose")}>Back</button>
          <button
            type="submit"
            class="btn primary"
            disabled={connecting}
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </form>

    {:else if mode === "local"}
      <p class="subtitle">Start a local server</p>
      <div class="form">
        <label>
          Port
          <input bind:value={localPort} inputmode="numeric" placeholder={String(serverState.port)} />
        </label>
        {#if serverState.logs.length > 0}
          <div class="log-preview">
            {#each serverState.logs.slice(-5) as line}
              <div class="log-line">{line}</div>
            {/each}
          </div>
        {/if}
        {#if error}
          <div class="error">{error}</div>
        {/if}
        {#if serverState.dataDir}
          <div class="info-line">Data: {serverState.dataDir}</div>
        {/if}
        <div class="info-line">Address: {localAddressPreview()}</div>
        <div class="actions">
          <button class="btn secondary" onclick={() => (mode = "choose")}>Back</button>
          <button
            class="btn primary"
            onclick={startLocal}
            disabled={localStarting}
          >
            {localStarting ? "Starting..." : "Start Server"}
          </button>
        </div>
      </div>

    {:else if mode === "login"}
      <p class="subtitle">Log in to continue</p>
      <div class="connected-badge">
        <input
          class="server-url-input"
          value={connection.url}
          onchange={(e) => {
            const val = (e.target as HTMLInputElement).value.trim();
            if (val) {
              connection.url = val;
              serverUrl = val;
              const portMatch = val.match(/:(\d+)/);
              if (portMatch) serverState.setPort(parseInt(portMatch[1], 10));
            }
          }}
        />
      </div>
      <form class="form" onsubmit={(e) => { e.preventDefault(); login(); }}>
        <label>
          Username
          <input bind:value={loginUsername} placeholder="admin" autocomplete="username" />
        </label>
        <label>
          Password
          <input bind:value={loginPassword} type="password" placeholder="password" autocomplete="current-password" />
        </label>
        {#if loginError}
          <div class="error">{loginError}</div>
        {/if}
        {#if serverState.bootstrapCredentialsPath}
          <div class="login-hint">
            First run: bootstrap admin credentials were written to
            <code>{serverState.bootstrapCredentialsPath}</code>
          </div>
        {/if}
        <label class="toggle-label">
          <input type="checkbox" bind:checked={restoreIncludeServerFiles} />
          <span>Include server files on snapshot restore</span>
        </label>
        <div class="actions" style="justify-content: flex-start; margin-top: 0;">
          <button
            type="button"
            class="btn secondary"
            onclick={openRestorePicker}
            disabled={loggingIn || restoringSnapshot}
          >
            {restoringSnapshot ? "Restoring..." : "Restore Server Snapshot (.json)"}
          </button>
        </div>
        {#if restoreResult}
          <div class="login-hint">{restoreResult}</div>
        {/if}
        <div class="actions">
          <button type="button" class="btn secondary" onclick={() => (mode = serverState.isRunning ? "local" : "choose")}>Back</button>
          <button type="submit" class="btn primary" disabled={loggingIn}>
            {loggingIn ? "Logging in..." : "Log In"}
          </button>
        </div>
      </form>

    {:else if mode === "totp"}
      <p class="subtitle">Two-factor authentication</p>
      <div class="connected-badge">Server: {connection.url}</div>
      <form class="form" onsubmit={(e) => { e.preventDefault(); verifyTotp(); }}>
        <p class="totp-info">Enter the 6-digit code from your authenticator app</p>
        <label>
          Authentication Code
          <input
            bind:value={totpCode}
            placeholder="000 000"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="8"
          />
        </label>
        {#if loginError}
          <div class="error">{loginError}</div>
        {/if}
        <p class="totp-hint">You can also use a recovery code</p>
        <div class="actions">
          <button type="button" class="btn secondary" onclick={() => { mode = "login"; totpCode = ""; loginError = ""; }}>Back</button>
          <button type="submit" class="btn primary" disabled={loggingIn}>
            {loggingIn ? "Verifying..." : "Verify"}
          </button>
        </div>
      </form>
    {/if}
  </div>

  {#if showForcedTotpSetup}
    <TotpSetupModal
      open={true}
      forced={true}
      onclose={() => {}}
      oncomplete={() => {
        showForcedTotpSetup = false;
        connection.totpEnabled = true;
        connection.pendingForcedSetup = false;
        connection.saveSession();
        deferredLoginResult = null;
      }}
    />
  {/if}
</div>

<style>
  .setup-page {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    background: var(--bg-base);
  }
  .setup-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 32px;
    width: 420px;
    max-width: 90vw;
  }
  .brand-logo {
    width: min(360px, 72vw);
    height: auto;
    margin-bottom: 4px;
  }
  .hidden-file-input {
    display: none;
  }
  .brand-subtitle {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 14px;
  }
  .subtitle {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin-bottom: 24px;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .option-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    text-align: left;
    transition: border-color 0.15s;
  }
  .option-btn:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .option-icon {
    font-size: 18px;
    margin-bottom: 4px;
  }
  .option-btn strong {
    font-size: var(--font-size-base);
  }
  .option-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
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
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
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
  }
  .btn.primary {
    background: var(--accent);
    color: white;
  }
  .btn.primary:hover { background: var(--accent-hover); }
  .btn.primary:disabled { opacity: 0.5; }
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
    max-height: 100px;
    overflow-y: auto;
    color: var(--text-secondary);
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }
  .connected-badge {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    border: 1px solid var(--border);
  }
  .server-url-input {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    width: 100%;
    outline: none;
    padding: 0;
    font-family: var(--font-mono, monospace);
  }
  .server-url-input:focus {
    color: var(--text-primary);
  }
  .login-hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    line-height: 1.4;
  }
  .login-hint code {
    font-family: var(--font-mono);
    font-style: normal;
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
    word-break: break-all;
  }
  .totp-info {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0;
  }
  .totp-hint {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    margin: 0;
  }
  .info-line {
    font-size: 11px;
    color: var(--text-muted);
    word-break: break-all;
  }
</style>
