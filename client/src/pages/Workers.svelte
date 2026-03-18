<script lang="ts">
  import { onDestroy } from "svelte";
  import { workersStore } from "../lib/stores/workers.svelte";
  import { connection } from "../lib/stores/connection.svelte";
  import { api } from "../lib/api/rest";
  import { isLocalWorker, requestStatus } from "../lib/api/ws";
  import { timeAgo } from "../lib/utils/format";
  import Badge from "../lib/components/ui/Badge.svelte";
  import ConfirmDialog from "../lib/components/ui/ConfirmDialog.svelte";
  import type { BridgeInfo } from "../lib/stores/workers.svelte";

  let expandedWorker = $state<string | null>(null);
  let confirmOpen = $state(false);
  let confirmWorkerName = $state("");
  let confirmWorkerId = $state("");

  // Refresh on mount and poll every 5 seconds while page is visible
  requestStatus();
  const pollInterval = setInterval(requestStatus, 5000);
  onDestroy(() => clearInterval(pollInterval));

  function workerKey(worker: { id: string; machineId?: string | null; name: string }) {
    return String(worker.machineId ?? worker.id ?? worker.name).trim().toLowerCase();
  }

  function toggleExpand(worker: { id: string; machineId?: string | null; name: string }) {
    const key = workerKey(worker);
    expandedWorker = expandedWorker === key ? null : key;
  }

  function handleHeaderKeydown(
    e: KeyboardEvent,
    worker: { id: string; machineId?: string | null; name: string },
  ) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleExpand(worker);
    }
  }

  function bridgesForWorker(worker: { id: string; machineId?: string | null; name: string }) {
    const key = workerKey(worker);
    const lowerName = worker.name.toLowerCase();
    return workersStore.bridges.filter((b) => {
      const bridgeKey = String(b.machineId ?? "").trim().toLowerCase();
      if (bridgeKey) return bridgeKey === key;
      return b.workerName?.toLowerCase() === lowerName;
    });
  }

  type BridgeDisplayRow = BridgeInfo & {
    sessionCount: number;
  };

  function displayBridgesForWorker(worker: { id: string; machineId?: string | null; name: string }): BridgeDisplayRow[] {
    const byProgram = new Map<string, BridgeDisplayRow>();
    for (const bridge of bridgesForWorker(worker)) {
      const program = String(bridge.program ?? bridge.name ?? "bridge").trim();
      const key = program.toLowerCase();
      const existing = byProgram.get(key);
      const projects = [
        ...(Array.isArray(bridge.activeProjects) ? bridge.activeProjects : []),
        ...(bridge.projectPath ? [bridge.projectPath] : []),
      ].filter((p, idx, arr) => !!p && arr.indexOf(p) === idx);

      if (!existing) {
        byProgram.set(key, {
          ...bridge,
          activeProjects: projects,
          projectPath: projects[0] ?? bridge.projectPath,
          sessionCount: 1,
        });
        continue;
      }

      existing.sessionCount += 1;
      existing.connected = existing.connected || !!bridge.connected;
      existing.lastSeen = existing.lastSeen && bridge.lastSeen
        ? (new Date(existing.lastSeen).getTime() >= new Date(bridge.lastSeen).getTime() ? existing.lastSeen : bridge.lastSeen)
        : (existing.lastSeen ?? bridge.lastSeen);
      existing.connectedAt = existing.connectedAt && bridge.connectedAt
        ? (new Date(existing.connectedAt).getTime() <= new Date(bridge.connectedAt).getTime() ? existing.connectedAt : bridge.connectedAt)
        : (existing.connectedAt ?? bridge.connectedAt);
      const mergedProjects = [...(existing.activeProjects ?? []), ...projects];
      existing.activeProjects = mergedProjects.filter((p, idx, arr) => !!p && arr.indexOf(p) === idx);
      existing.projectPath = existing.activeProjects[0] ?? existing.projectPath;
      if (!existing.programVersion && bridge.programVersion) existing.programVersion = bridge.programVersion;
      if (!existing.bridgeVersion && bridge.bridgeVersion) existing.bridgeVersion = bridge.bridgeVersion;
      if (!existing.osUser && bridge.osUser) existing.osUser = bridge.osUser;
    }

    return [...byProgram.values()].sort((a, b) => {
      const ap = String(a.program ?? a.name ?? "").toLowerCase();
      const bp = String(b.program ?? b.name ?? "").toLowerCase();
      return ap.localeCompare(bp);
    });
  }

  /** Get the OS user for a worker from its connected bridges */
  function osUserForWorker(worker: { id: string; machineId?: string | null; name: string }): string | undefined {
    const bridges = bridgesForWorker(worker);
    for (const b of bridges) {
      if (b.osUser) return b.osUser;
    }
    return undefined;
  }

  function confirmDeleteWorker(id: string, name: string) {
    confirmWorkerId = id;
    confirmWorkerName = name;
    confirmOpen = true;
  }

  async function doDeleteWorker() {
    confirmOpen = false;
    try {
      await api.workers.delete(confirmWorkerId);
    } catch (err: any) {
      console.error("Failed to delete worker:", err);
    }
  }
</script>

<div class="workers-page">
  <div class="page-header">
    <h2>Workers</h2>
    <span class="worker-count">{workersStore.workers.length} machine{workersStore.workers.length !== 1 ? "s" : ""}</span>
    {#if connection.username}
      <span class="account-user" title="Signed-in Arkestrator account">Account: {connection.username}</span>
    {/if}
    <button class="refresh-btn" onclick={() => requestStatus()} title="Refresh workers">&#x21bb;</button>
  </div>

  <div class="worker-list">
    {#each workersStore.workers as worker (worker.id)}
      {@const workerBridges = displayBridgesForWorker(worker)}
      {@const osUser = osUserForWorker(worker)}
      {@const isExpanded = expandedWorker === workerKey(worker)}
      <div class="worker-card" class:expanded={isExpanded}>
        <!-- Machine header row -->
        <div
          class="card-header"
          role="button"
          tabindex="0"
          onclick={() => toggleExpand(worker)}
          onkeydown={(e) => handleHeaderKeydown(e, worker)}
        >
          <div class="header-left">
            <span class="expand-icon" class:has-bridges={workerBridges.length > 0}>
              {#if workerBridges.length > 0}
                {isExpanded ? "▾" : "▸"}
              {:else}
                <span class="no-expand">&nbsp;</span>
              {/if}
            </span>
            <Badge
              text={worker.status}
              variant={worker.status === "online" ? "completed" : "cancelled"}
            />
            <strong class="worker-name">{worker.name}</strong>
            {#if connection.username && isLocalWorker(worker.name, worker.machineId)}
              <span class="account-chip" title="Signed-in Arkestrator account on this machine">
                Account {connection.username}
              </span>
            {/if}
          </div>
          <div class="header-right">
            {#if worker.activeBridgeCount > 0}
              <span class="bridge-count">{worker.activeBridgeCount} bridge{worker.activeBridgeCount !== 1 ? "s" : ""}</span>
            {/if}
            {#if worker.lastIp}
              <span class="worker-ip">{worker.lastIp}</span>
            {/if}
            <span class="last-seen" title="Last seen">{timeAgo(worker.lastSeenAt)}</span>
            <button class="action-btn danger" onclick={(e) => { e.stopPropagation(); confirmDeleteWorker(worker.id, worker.name); }} title="Remove worker">✕</button>
          </div>
        </div>

        <!-- Expanded bridges section -->
        {#if isExpanded}
          <div class="expanded-content">
            <!-- Machine details -->
            <div class="machine-details">
              {#if worker.lastProjectPath}
                <div class="detail-item">
                  <span class="detail-label">Path</span>
                  <code>{worker.lastProjectPath}</code>
                </div>
              {/if}
              <div class="detail-item">
                <span class="detail-label">First seen</span>
                <span>{timeAgo(worker.firstSeenAt)}</span>
              </div>
              {#if osUser}
                <div class="detail-item">
                  <span class="detail-label">OS user</span>
                  <span title="Remote machine OS account">{osUser}</span>
                </div>
              {/if}
              {#if worker.knownPrograms && worker.knownPrograms.length > 0}
                <div class="detail-item">
                  <span class="detail-label">Programs</span>
                  <span class="program-tags">
                    {#each worker.knownPrograms as prog}
                      <Badge text={prog} variant={prog} />
                    {/each}
                  </span>
                </div>
              {/if}
            </div>

            <!-- Connected bridges -->
            {#if workerBridges.length > 0}
              <div class="bridges-section">
                <div class="bridges-header">Bridges</div>
                {#each workerBridges as bridge (bridge.id)}
                  {@const bridgeProjects = (bridge.activeProjects && bridge.activeProjects.length > 0)
                    ? bridge.activeProjects
                    : (bridge.projectPath ? [bridge.projectPath] : [])}
                  <div class="bridge-row" class:offline-row={!bridge.connected}>
                    <div class="bridge-main">
                      {#if bridge.program}
                        <Badge text={bridge.program} variant={bridge.program} />
                      {/if}
                      <span class="bridge-name">{bridge.name}</span>
                      <span class="bridge-state" class:offline-state={!bridge.connected}>
                        {bridge.connected ? "online" : "offline"}
                      </span>
                      {#if bridge.programVersion}
                        <span class="bridge-version">v{bridge.programVersion}</span>
                      {/if}
                      {#if bridge.sessionCount > 1}
                        <span class="bridge-sessions">{bridge.sessionCount} sessions</span>
                      {/if}
                    </div>
                    <div class="bridge-meta">
                      {#if bridgeProjects.length > 0}
                        <div class="bridge-path-list">
                          {#each bridgeProjects as path, i (path)}
                            <code class="bridge-path" title={path}>
                              {`- ${path}`}
                            </code>
                          {/each}
                        </div>
                      {/if}
                      {#if bridge.connectedAt}
                        <span class="bridge-connected" title="Connected">{timeAgo(bridge.connectedAt)}</span>
                      {:else if bridge.lastSeen}
                        <span class="bridge-connected" title="Last seen">{timeAgo(bridge.lastSeen)}</span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="no-bridges">No active bridges</div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="empty">
        <p>No workers registered</p>
        <p class="hint">Workers are created automatically when a bridge connects with a worker name. Connect a DCC app (Godot, Blender, etc.) to see workers here.</p>
      </div>
    {/each}
  </div>
</div>

<ConfirmDialog
  open={confirmOpen}
  title="Remove Worker"
  message={`Remove worker "${confirmWorkerName}"? This only removes the record — the worker can re-register by reconnecting.`}
  confirmText="Remove"
  variant="danger"
  onconfirm={doDeleteWorker}
  oncancel={() => { confirmOpen = false; }}
/>

<style>
  .workers-page { padding: 16px; overflow-y: auto; height: 100%; }
  .page-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  h2 { font-size: var(--font-size-lg); }
  .worker-count {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .account-user {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: color-mix(in oklab, var(--bg-elevated) 65%, transparent);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
  }
  .refresh-btn {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 16px;
    margin-left: auto;
  }
  .refresh-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

  .worker-list { display: flex; flex-direction: column; gap: 4px; }

  .worker-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .worker-card.expanded {
    border-color: var(--border-active, var(--border));
  }

  /* Card header acts as a keyboard-accessible expand/collapse control */
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    gap: 8px;
  }
  .card-header:hover {
    background: var(--bg-hover);
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .expand-icon {
    width: 14px;
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .expand-icon.has-bridges { color: var(--text-secondary); }
  .no-expand { visibility: hidden; }

  .worker-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .account-chip {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    background: color-mix(in oklab, var(--bg-elevated) 65%, transparent);
    border: 1px solid var(--border-color);
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .bridge-count {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .worker-ip {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  .last-seen {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .action-btn {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 11px;
    flex-shrink: 0;
  }
  .action-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .action-btn.danger:hover {
    background: var(--status-failed);
    color: white;
  }

  /* Expanded content */
  .expanded-content {
    border-top: 1px solid var(--border);
    padding: 0 12px 12px 12px;
  }

  .machine-details {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    padding: 10px 0;
    font-size: var(--font-size-sm);
  }
  .detail-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .detail-label {
    color: var(--text-muted);
    font-weight: 500;
  }
  .detail-item span:not(.detail-label) {
    color: var(--text-secondary);
  }
  .program-tags {
    display: flex;
    gap: 4px;
  }
  code {
    background: var(--bg-base);
    padding: 1px 4px;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  /* Bridges section */
  .bridges-section {
    padding-top: 4px;
  }
  .bridges-header {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .bridge-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    margin-bottom: 2px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
  }
  .bridge-row.offline-row {
    opacity: 0.78;
  }
  .bridge-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .bridge-name {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bridge-version {
    font-size: 11px;
    color: var(--text-muted);
  }
  .bridge-sessions {
    font-size: 11px;
    color: var(--text-muted);
  }
  .bridge-state {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--status-completed);
  }
  .bridge-state.offline-state {
    color: var(--text-muted);
  }
  .bridge-meta {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .bridge-path-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    max-width: none;
  }
  .bridge-path {
    font-size: 11px;
    display: block;
    max-width: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    overflow: visible;
    text-overflow: clip;
  }
  .bridge-connected {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    align-self: flex-end;
  }
  .no-bridges {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 8px;
    text-align: center;
  }

  .empty {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 8px;
  }
</style>
