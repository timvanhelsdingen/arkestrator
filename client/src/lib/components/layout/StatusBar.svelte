<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { jobs } from "../../stores/jobs.svelte";

  let runningCount = $derived(
    jobs.all.filter((j) => j.status === "running").length,
  );
  let queuedCount = $derived(
    jobs.all.filter((j) => j.status === "queued").length,
  );
  const clientVersion = __CLIENT_VERSION__;
</script>

<div class="statusbar">
  <div class="left">
    <span class="status-indicator" class:connected={connection.isConnected}>
      {connection.isConnected
        ? `Connected to ${connection.url}`
        : connection.status === "connecting"
          ? "Connecting..."
          : "Disconnected"}
    </span>
    {#if connection.lastError}
      <span class="error">{connection.lastError}</span>
    {/if}
  </div>
  <div class="right">
    {#if runningCount > 0}
      <span class="badge running">{runningCount} running</span>
    {/if}
    {#if queuedCount > 0}
      <span class="badge queued">{queuedCount} queued</span>
    {/if}
    {#if connection.username}
      <span class="user">{connection.username}</span>
    {/if}
    <span class="version">v{clientVersion}</span>
  </div>
</div>

<style>
  .statusbar {
    height: var(--statusbar-height);
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-size: var(--font-size-sm);
    color: white;
    flex-shrink: 0;
  }
  .left, .right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .error {
    color: #ffcccc;
  }
  .badge {
    padding: 0 6px;
    border-radius: 3px;
    font-size: 11px;
  }
  .badge.running {
    background: rgba(255, 255, 255, 0.2);
  }
  .badge.queued {
    background: rgba(255, 255, 255, 0.1);
  }
  .user {
    opacity: 0.8;
  }
  .version {
    opacity: 0.75;
    font-family: var(--font-mono);
    font-size: 11px;
  }
</style>
