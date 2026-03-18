<script lang="ts">
  import { connect, disconnect } from "../api/ws";
  import { connection } from "../stores/connection.svelte";
  import {
    isLoopbackUrl,
    parseLocalServerPortInput,
    serverState,
  } from "../stores/server.svelte";

  let showLogs = $state(false);
  let logContainer: HTMLDivElement | undefined = $state();
  let portDraft = $state(String(serverState.port));
  let portResult = $state("");
  let applyingPort = $state(false);

  function handleStart() {
    if (connection.serverMode === "local" || isLoopbackUrl(connection.url)) {
      connection.url = serverState.localUrl;
      connection.save();
    }
    void serverState.start();
    showLogs = true;
  }

  function handleStop() {
    void serverState.stop();
  }

  async function handleApplyPort() {
    const parsed = parseLocalServerPortInput(portDraft);
    if (!parsed.ok) {
      portResult = parsed.error;
      return;
    }

    applyingPort = true;
    portResult = "";
    const shouldUpdateConnection =
      connection.serverMode === "local" || isLoopbackUrl(connection.url);
    const shouldReconnect = shouldUpdateConnection && !!connection.apiKey;

    try {
      const result = await serverState.applyPort(parsed.port);
      portResult = "";
      if (shouldUpdateConnection) {
        connection.url = serverState.localUrl;
        connection.save();
      }
      const reconnectNow =
        shouldReconnect
        && (connection.isConnected || result.restarted || serverState.isRunning || serverState.status === "starting");
      if (reconnectNow) {
        connect(serverState.localUrl, connection.apiKey);
      } else if (shouldUpdateConnection && connection.isConnected) {
        disconnect();
      }
      showLogs = showLogs || result.restarted;
    } finally {
      applyingPort = false;
    }
  }

  // Auto-scroll logs
  $effect(() => {
    if (logContainer && serverState.logs.length > 0) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });

  $effect(() => {
    portDraft = String(serverState.port);
  });

  const statusColor = $derived(
    serverState.status === "running"
      ? "var(--status-completed)"
      : serverState.status === "error"
        ? "var(--status-failed)"
        : serverState.status === "starting" || serverState.status === "stopping"
          ? "var(--status-running)"
          : "var(--text-muted)"
  );
</script>

<section class="server-manager">
  <h3>Local Server</h3>

  <div class="status-row">
    <span class="status-dot" style="background: {statusColor}"></span>
    <span class="status-label">{serverState.status}</span>
    <span class="address">{serverState.localUrl}</span>
    {#if serverState.pid}
      <span class="pid">PID: {serverState.pid}</span>
    {/if}
  </div>

  <div class="form-group">
    <label>
      Port
      <div class="port-row">
        <input bind:value={portDraft} inputmode="numeric" placeholder={String(serverState.port)} />
        <button class="btn secondary" onclick={handleApplyPort} disabled={applyingPort}>
          {#if serverState.isRunning && serverState.canStop}
            {applyingPort ? "Applying..." : "Apply + Restart"}
          {:else}
            {applyingPort ? "Saving..." : "Save Port"}
          {/if}
        </button>
      </div>
    </label>

    <div class="btn-group">
      {#if serverState.canStart}
        <button class="btn" onclick={handleStart}>Start Server</button>
      {/if}
      {#if serverState.canStop}
        <button class="btn danger" onclick={handleStop}>Stop Server</button>
      {/if}
      <button class="btn secondary" onclick={() => (showLogs = !showLogs)}>
        {showLogs ? "Hide" : "Show"} Logs
      </button>
    </div>

    {#if serverState.error}
      <span class="error">{serverState.error}</span>
    {/if}
    {#if serverState.message}
      <span class="info">{serverState.message}</span>
    {/if}
    {#if portResult}
      <span class="info">{portResult}</span>
    {/if}
  </div>

  {#if showLogs}
    <div class="log-section">
      <div class="log-header">
        <span>Server Output</span>
        <button class="btn-small" onclick={() => serverState.clearLogs()}>Clear</button>
      </div>
      <div class="log-output" bind:this={logContainer}>
        {#each serverState.logs as line}
          <div class="log-line">{line}</div>
        {/each}
        {#if serverState.logs.length === 0}
          <div class="log-empty">No output yet</div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .server-manager {
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
  .status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-label {
    font-size: var(--font-size-sm);
    text-transform: capitalize;
  }
  .address {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }
  .pid {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-left: auto;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .port-row {
    display: flex;
    gap: 8px;
  }
  .port-row input {
    flex: 1;
    min-width: 0;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn.danger { background: var(--status-failed); }
  .btn.secondary {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-group { display: flex; gap: 8px; }
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .info {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .log-section {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: var(--bg-hover);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .btn-small {
    padding: 2px 8px;
    font-size: var(--font-size-xs);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .log-output {
    max-height: 240px;
    overflow-y: auto;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    background: var(--bg-primary);
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.4;
  }
  .log-empty {
    color: var(--text-muted);
    font-style: italic;
  }
</style>
