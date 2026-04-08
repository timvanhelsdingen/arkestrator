<script lang="ts">
  import { connection } from "./lib/stores/connection.svelte";
  import { wizard } from "./lib/stores/wizard.svelte";
  import { clientCoordination } from "./lib/stores/clientCoordination.svelte";
  import { isLoopbackUrl, serverState } from "./lib/stores/server.svelte";
  import { nav } from "./lib/stores/navigation.svelte";
  import { api } from "./lib/api/rest";
  import { autoConnect, initMachineIdentity } from "./lib/api/ws";
  import TitleBar from "./lib/components/layout/TitleBar.svelte";
  import Sidebar from "./lib/components/layout/Sidebar.svelte";
  import StatusBar from "./lib/components/layout/StatusBar.svelte";
  import Setup from "./pages/Setup.svelte";
  import StartupWizard from "./pages/StartupWizard.svelte";
  import BootstrapWizard from "./pages/BootstrapWizard.svelte";
  import Chat from "./pages/Chat.svelte";
  import Jobs from "./pages/Jobs.svelte";
  import Admin from "./pages/Admin.svelte";
  import Workers from "./pages/Workers.svelte";
  import Projects from "./pages/Projects.svelte";
  import Skills from "./pages/Skills.svelte";
  import CoordinatorScripts from "./pages/CoordinatorScripts.svelte";
  import Training from "./pages/Training.svelte";
  import Settings from "./pages/Settings.svelte";
  import Toast from "./lib/components/ui/Toast.svelte";
  import brandLogo from "./assets/brand/arkestrator-logo_brandname.svg";
  import { checkForAppUpdatesOnce } from "./lib/updater";

  const LEGAL_ACCEPTANCE_KEY = "arkestrator-legal-acceptance-v1";

  type LegalAcceptance = {
    acceptedAt: string;
    version: "pre-release-disclaimer-2026-02-26";
  };

  function loadLegalAcceptance(): LegalAcceptance | null {
    try {
      const raw = localStorage.getItem(LEGAL_ACCEPTANCE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.version !== "pre-release-disclaimer-2026-02-26") return null;
      if (typeof parsed?.acceptedAt !== "string" || !parsed.acceptedAt) return null;
      return {
        acceptedAt: parsed.acceptedAt,
        version: parsed.version,
      };
    } catch {
      return null;
    }
  }

  let legalAcceptance = $state<LegalAcceptance | null>(loadLegalAcceptance());
  let licenseConsentChecked = $state(false);
  let licenseError = $state("");

  // Boot state: true while deciding what to show (prevents flash to Setup)
  let booting = $state(true);
  let bootMessage = $state("");

  let showMain = $derived(
    !booting
    && (connection.isConnected || connection.hasSavedCredentials)
    && connection.isAuthenticated
    && !connection.pendingForcedSetup
    && !connection.pendingWizard
    && wizard.isComplete
  );

  $effect(() => {
    if (!showMain) return;
    checkForAppUpdatesOnce();
  });

  // Boot sequence (runs once)
  let bootStarted = false;
  $effect(() => {
    if (bootStarted) return;
    if (!legalAcceptance) {
      booting = false;
      return;
    }
    bootStarted = true;

    const saved = connection.loadSaved();
    const hasSession = connection.isAuthenticated;
    const hasCreds = !!(saved.url && saved.apiKey);

    if (!hasSession || !hasCreds) {
      // No saved state -> show Setup immediately
      booting = false;
      return;
    }

    // Validate saved serverMode against the saved URL to fix any past misclassification.
    // If the saved URL points to a remote host but serverMode says "local", correct it.
    const effectiveMode =
      saved.serverMode === "local" && saved.url && !isLoopbackUrl(saved.url)
        ? "remote"
        : saved.serverMode;
    if (effectiveMode !== saved.serverMode) {
      connection.serverMode = effectiveMode;
      connection.save();
    }

    // Load saved URL so REST client knows where to call
    connection.url = effectiveMode === "local" ? serverState.localUrl : saved.url;
    if (effectiveMode === "local" && saved.apiKey) {
      connection.apiKey = saved.apiKey;
      connection.save();
    }

    if (effectiveMode === "local") {
      // Local mode: start server first, then validate session
      bootMessage = "Starting server...";
      void serverState.start();
    } else {
      // Remote mode: validate session immediately
      bootMessage = "Connecting...";
      validateSessionAndConnect();
    }
  });

  // Watch for local server becoming running -> then validate session
  $effect(() => {
    if (serverState.isRunning && booting && bootMessage === "Starting server...") {
      bootMessage = "Connecting...";
      validateSessionAndConnect();
    }
  });

  // Watch for local server failing to start
  $effect(() => {
    if (serverState.status === "error" && booting && bootMessage === "Starting server...") {
      booting = false;
    }
  });

  // Idle detection: auto-enable worker mode when user is inactive
  $effect(() => {
    if (!connection.idleWorkerEnabled) return;
    let lastActivity = Date.now();
    let idleCheckInterval: ReturnType<typeof setInterval>;
    const onActivity = () => {
      lastActivity = Date.now();
      // If idle-worker was auto-activated, deactivate on user return
      if (connection.idleWorkerActive) {
        connection.idleWorkerActive = false;
        connection.workerModeEnabled = false;
        connection.saveSession();
      }
    };
    const checkIdle = () => {
      if (!connection.idleWorkerEnabled || !connection.isConnected) return;
      const idleMs = Date.now() - lastActivity;
      const thresholdMs = (connection.idleWorkerMinutes || 15) * 60_000;
      if (idleMs >= thresholdMs && !connection.idleWorkerActive && !connection.workerModeEnabled) {
        connection.idleWorkerActive = true;
        connection.workerModeEnabled = true;
        connection.saveSession();
      }
    };
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("mousedown", onActivity);
    idleCheckInterval = setInterval(checkIdle, 30_000);
    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("mousedown", onActivity);
      clearInterval(idleCheckInterval);
    };
  });

  async function validateSessionAndConnect(retryCount = 0) {
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;
    try {
      // Cache machine identity before connecting so it's sent with the WS URL
      await initMachineIdentity();
      const user = await api.auth.me();
      connection.username = user.username;
      connection.userRole = user.role;
      connection.allowClientCoordination = !!user.allowClientCoordination;
      connection.clientCoordinationEnabled = !!user.clientCoordinationEnabled;
      connection.canEditCoordinator = !!user.canEditCoordinator;
      connection.saveSession();
      if (connection.allowClientCoordination) {
        clientCoordination.probeIfStale();
      }
      autoConnect();
      booting = false;
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      // Only clear persisted session on explicit auth failures.
      if (msg.startsWith("401:") || msg.startsWith("403:")) {
        connection.clearSession();
        // Also reset wizard so a wiped DB triggers the full first-time experience
        wizard.reset();
        booting = false;
        return;
      }
      // Transient error (network, timeout) — retry with backoff
      if (retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(1.5, retryCount);
        bootMessage = `Reconnecting... (attempt ${retryCount + 2})`;
        setTimeout(() => validateSessionAndConnect(retryCount + 1), delay);
      } else {
        // Give up retrying, show setup so user can manually reconnect
        booting = false;
      }
    }
  }

  // Note: WS reconnection is handled by scheduleReconnect() in ws.ts
  // with exponential backoff. No additional reconnect logic needed here.
  function acceptLegalTerms() {
    if (!licenseConsentChecked) {
      licenseError = "Please confirm acceptance before continuing.";
      return;
    }
    const payload: LegalAcceptance = {
      acceptedAt: new Date().toISOString(),
      version: "pre-release-disclaimer-2026-02-26",
    };
    localStorage.setItem(LEGAL_ACCEPTANCE_KEY, JSON.stringify(payload));
    legalAcceptance = payload;
    licenseError = "";
    booting = true;
    bootStarted = false;
  }
</script>

<TitleBar />
{#if !legalAcceptance}
  <div class="app-body">
    <div class="boot-screen">
      <div class="boot-card legal-card">
        <img class="brand-logo" src={brandLogo} alt="Arkestrator" />
        <p class="brand-subtitle">Legal Notice Acceptance Required</p>
        <p class="legal-copy">
          This software is pre-release and provided "AS IS", without warranty of any kind. By continuing, you
          accept the disclaimer terms and confirm that use is at your own risk, including responsibility for
          backups and safe operation.
        </p>
        <label class="legal-consent">
          <input
            type="checkbox"
            bind:checked={licenseConsentChecked}
            onchange={() => {
              if (licenseConsentChecked) licenseError = "";
            }}
          />
          <span>
            I have read and accept the pre-release disclaimer/no-warranty terms.
          </span>
        </label>
        {#if licenseError}
          <p class="legal-error">{licenseError}</p>
        {/if}
        <div class="legal-actions">
          <button class="btn-accept" onclick={acceptLegalTerms}>Accept and Continue</button>
        </div>
      </div>
    </div>
  </div>
{:else if booting}
  <div class="app-body">
    <div class="boot-screen">
      <div class="boot-card">
        <img class="brand-logo" src={brandLogo} alt="Arkestrator" />
        <p class="brand-subtitle">AI Agent Orchestration for DCC Pipelines</p>
        <p class="boot-message">{bootMessage}</p>
        {#if serverState.status === "starting"}
          <div class="log-preview">
            {#each serverState.logs.slice(-3) as line}
              <div class="log-line">{line}</div>
            {/each}
          </div>
        {/if}
        <div class="boot-actions">
          <button class="boot-cancel" onclick={() => { booting = false; connection.clearSession(); wizard.reset(); }}>
            Cancel
          </button>
          <button
            class="boot-reset"
            onclick={() => { localStorage.clear(); window.location.reload(); }}
            title="Clear all saved credentials and reload"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  </div>
{:else if showMain}
  <div class="app-body">
    <Sidebar />
    <main class="content">
      {#if nav.current === "chat"}
        <Chat />
      {:else if nav.current === "jobs"}
        <Jobs />
      {:else if nav.current === "admin"}
        <Admin />
      {:else if nav.current === "workers"}
        <Workers />
      {:else if nav.current === "projects"}
        <Projects />
      {:else if nav.current === "skills"}
        <Skills />
      {:else if nav.current === "coordinator-scripts"}
        <CoordinatorScripts />
      {:else if nav.current === "training"}
        <Training />
      {:else if nav.current === "settings"}
        <Settings />
      {/if}
    </main>
  </div>
  <StatusBar />
{:else if connection.isAuthenticated && connection.pendingWizard}
  <div class="app-body">
    <BootstrapWizard />
  </div>
{:else if !wizard.isComplete}
  <div class="app-body">
    <BootstrapWizard />
  </div>
{:else}
  <div class="app-body">
    <Setup />
  </div>
{/if}
<Toast />

<style>
  .app-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .content {
    flex: 1;
    overflow: hidden;
    background: var(--bg-base);
  }
  .boot-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    background: var(--bg-base);
  }
  .boot-card {
    text-align: center;
  }
  .brand-logo {
    width: min(540px, 80vw);
    height: auto;
    margin-bottom: 8px;
  }
  .brand-subtitle {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .boot-message {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .log-preview {
    margin-top: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    max-width: 400px;
    text-align: left;
    color: var(--text-secondary);
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }
  .boot-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    justify-content: center;
  }
  .boot-cancel, .boot-reset {
    padding: 6px 20px;
    font-size: var(--font-size-sm);
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .boot-cancel:hover, .boot-reset:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
  .boot-reset {
    color: var(--red, #e74c3c);
    border-color: var(--red, #e74c3c);
    opacity: 0.7;
  }
  .boot-reset:hover {
    opacity: 1;
    color: var(--red, #e74c3c);
    border-color: var(--red, #e74c3c);
  }
  .legal-card {
    max-width: 620px;
    margin: 0 16px;
  }
  .legal-copy {
    font-size: var(--font-size-sm);
    line-height: 1.5;
    color: var(--text-secondary);
    margin: 12px 0 16px;
    text-align: left;
  }
  .legal-consent {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    text-align: left;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .legal-error {
    margin: 10px 0 0;
    color: #ff9d9d;
    font-size: var(--font-size-sm);
    text-align: left;
  }
  .legal-actions {
    margin-top: 16px;
    display: flex;
    justify-content: flex-end;
  }
  .btn-accept {
    height: 36px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--text-on-accent);
    border-radius: var(--radius-sm);
    padding: 0 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-accept:hover {
    filter: brightness(1.08);
  }
</style>
