<script lang="ts">
  import { workersStore } from "../../stores/workers.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { requestStatus } from "../../api/ws";
  import BridgeInstaller from "../BridgeInstaller.svelte";
  import Badge from "../ui/Badge.svelte";

  let autoRefreshed = false;

  $effect(() => {
    if (connection.isConnected && !autoRefreshed) {
      autoRefreshed = true;
      requestStatus();
    }
  });

  let programBridges = $derived(workersStore.bridges.filter(b => b.bridgeVersion !== "api-bridge"));
  let onlineBridges = $derived(programBridges.filter(b => b.connected));
  let offlineBridges = $derived(programBridges.filter(b => !b.connected));
</script>

<section>
  <h3>Bridge Installer</h3>
  <p class="desc">Install bridge plugins for DCC applications. Bridge plugins connect your apps to the Arkestrator server.</p>
  <BridgeInstaller />
</section>

<section>
  <h3>Connected Bridges</h3>
  <p class="desc">Bridges currently connected to the server. Bridges auto-refresh when this tab is opened.</p>

  {#if programBridges.length === 0}
    <div class="empty-state">No bridges connected. Install a bridge plugin and open the target application.</div>
  {:else}
    <div class="bridge-status-summary">
      <span class="bridge-count online">{onlineBridges.length} online</span>
      {#if offlineBridges.length > 0}
        <span class="bridge-count offline">{offlineBridges.length} offline</span>
      {/if}
    </div>
    <div class="bridge-list">
      {#each programBridges as bridge}
        <div class="bridge-item" class:offline={!bridge.connected}>
          <div class="bridge-item-left">
            <Badge text={bridge.program ?? "bridge"} variant={bridge.program ?? "default"} />
            <span class="bridge-name">{bridge.name || bridge.id || "Unknown"}</span>
          </div>
          <div class="bridge-item-right">
            <span class="bridge-state" class:online={bridge.connected}>
              {bridge.connected ? "online" : "offline"}
            </span>
            {#if bridge.programVersion}
              <span class="bridge-version">v{bridge.programVersion}</span>
            {/if}
            {#if bridge.workerName}
              <span class="bridge-worker">{bridge.workerName}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <button class="btn secondary" onclick={() => requestStatus()} style="margin-top: 10px;">
    Refresh Bridges
  </button>
</section>

<style>
  section {
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
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }
  .btn:hover {
    background: var(--accent-hover);
  }
  .btn.secondary {
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .empty-state {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 16px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
  }
  .bridge-status-summary {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
  }
  .bridge-count {
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }
  .bridge-count.online {
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
  }
  .bridge-count.offline {
    background: rgba(102, 102, 102, 0.15);
    color: var(--text-muted);
  }
  .bridge-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .bridge-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
  }
  .bridge-item.offline {
    opacity: 0.6;
  }
  .bridge-item-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .bridge-item-right {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .bridge-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .bridge-state {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .bridge-state.online {
    border-color: var(--status-completed);
    color: var(--status-completed);
  }
  .bridge-version {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .bridge-worker {
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
