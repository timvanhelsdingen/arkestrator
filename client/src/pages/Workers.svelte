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

  let monitoredWorkerIds = $state<Set<string>>(new Set());
  let confirmOpen = $state(false);
  let confirmWorkerName = $state("");
  let confirmWorkerId = $state("");
  let sidebarWidth = $state(320);

  // Refresh on mount and poll every 5 seconds while page is visible
  requestStatus();
  const pollInterval = setInterval(requestStatus, 5000);
  onDestroy(() => clearInterval(pollInterval));

  function workerKey(worker: { id: string; machineId?: string | null; name: string }) {
    return String(worker.machineId ?? worker.id ?? worker.name).trim().toLowerCase();
  }

  function toggleMonitor(worker: { id: string; machineId?: string | null; name: string }) {
    const key = workerKey(worker);
    const next = new Set(monitoredWorkerIds);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    monitoredWorkerIds = next;
  }

  function removeMonitor(key: string) {
    const next = new Set(monitoredWorkerIds);
    next.delete(key);
    monitoredWorkerIds = next;
  }

  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      sidebarWidth = Math.max(240, Math.min(520, startW - (ev.clientX - startX)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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

  /** Programs that currently have at least one connected bridge on this worker */
  function connectedProgramsForWorker(worker: { id: string; machineId?: string | null; name: string }): string[] {
    const programs = new Set<string>();
    for (const b of bridgesForWorker(worker)) {
      if (b.connected && b.program) programs.add(b.program.toLowerCase());
    }
    return [...programs].sort();
  }

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

  let monitoredWorkers = $derived(
    workersStore.workers.filter(w => monitoredWorkerIds.has(workerKey(w)))
  );
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

  <div class="workers-body">
    <!-- Grid of worker cards -->
    <div class="workers-grid">
      {#each workersStore.workers as worker (worker.id)}
        {@const workerBridges = displayBridgesForWorker(worker)}
        {@const isMonitored = monitoredWorkerIds.has(workerKey(worker))}
        {@const onlinePrograms = connectedProgramsForWorker(worker)}
        <div
          class="worker-card"
          class:monitored={isMonitored}
          onclick={() => toggleMonitor(worker)}
          role="button"
          tabindex="0"
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMonitor(worker); } }}
        >
          <div class="card-top">
            <Badge
              text={worker.status}
              variant={worker.status === "online" ? "completed" : "cancelled"}
            />
            <strong class="worker-name">{worker.name}</strong>
            {#if connection.username && isLocalWorker(worker.name, worker.machineId)}
              <span class="account-chip">You</span>
            {/if}
          </div>
          <div class="card-info">
            {#if workerBridges.length > 0}
              <span class="info-item">{workerBridges.length} bridge{workerBridges.length !== 1 ? "s" : ""}</span>
            {/if}
            {#if worker.lastIp}
              <span class="info-item mono">{worker.lastIp}</span>
            {/if}
          </div>
          {#if onlinePrograms.length > 0}
            <div class="card-programs">
              {#each onlinePrograms as prog}
                <Badge text={prog} variant={prog} />
              {/each}
            </div>
          {/if}
          <div class="card-footer">
            <span class="last-seen">{timeAgo(worker.lastSeenAt)}</span>
            <button class="action-btn danger" onclick={(e) => { e.stopPropagation(); confirmDeleteWorker(worker.id, worker.name); }} title="Remove worker">✕</button>
          </div>
        </div>
      {:else}
        <div class="empty">
          <p>No workers registered</p>
          <p class="hint">Workers are created automatically when a bridge connects with a worker name. Connect a DCC app (Godot, Blender, etc.) to see workers here.</p>
        </div>
      {/each}
    </div>

    <!-- Monitor sidebar -->
    {#if monitoredWorkers.length > 0}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sidebar-resize-handle" onmousedown={startSidebarResize}></div>
      <div class="workers-monitor" style="width: {sidebarWidth}px;">
        <div class="monitor-header">
          <h3>Monitor <span class="monitor-count">{monitoredWorkers.length}</span></h3>
          <button class="clear-btn" onclick={() => { monitoredWorkerIds = new Set(); }}>Clear</button>
        </div>
        <div class="monitor-list">
          {#each monitoredWorkers as worker (worker.id)}
            {@const workerBridges = displayBridgesForWorker(worker)}
            {@const osUser = osUserForWorker(worker)}
            {@const sidebarOnlinePrograms = connectedProgramsForWorker(worker)}
            <div class="monitor-card">
              <div class="monitor-card-header">
                <Badge
                  text={worker.status}
                  variant={worker.status === "online" ? "completed" : "cancelled"}
                />
                <strong class="monitor-name">{worker.name}</strong>
                <button class="action-btn" onclick={() => removeMonitor(workerKey(worker))} title="Remove from monitor">✕</button>
              </div>
              <div class="monitor-details">
                {#if worker.lastIp}
                  <div class="detail-row">
                    <span class="detail-label">IP</span>
                    <code>{worker.lastIp}</code>
                  </div>
                {/if}
                {#if worker.lastProjectPath}
                  <div class="detail-row">
                    <span class="detail-label">Path</span>
                    <code>{worker.lastProjectPath}</code>
                  </div>
                {/if}
                {#if osUser}
                  <div class="detail-row">
                    <span class="detail-label">User</span>
                    <span>{osUser}</span>
                  </div>
                {/if}
                <div class="detail-row">
                  <span class="detail-label">Seen</span>
                  <span>{timeAgo(worker.lastSeenAt)}</span>
                </div>
                {#if sidebarOnlinePrograms.length > 0}
                  <div class="detail-row">
                    <span class="detail-label">Programs</span>
                    <span class="program-tags">
                      {#each sidebarOnlinePrograms as prog}
                        <Badge text={prog} variant={prog} />
                      {/each}
                    </span>
                  </div>
                {/if}
              </div>
              {#if workerBridges.length > 0}
                <div class="monitor-bridges">
                  <div class="bridges-label">Bridges</div>
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
                          <span class="bridge-sessions">{bridge.sessionCount} sess</span>
                        {/if}
                      </div>
                      {#if bridgeProjects.length > 0}
                        <div class="bridge-paths">
                          {#each bridgeProjects as path (path)}
                            <code class="bridge-path">{path}</code>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
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
  .workers-page { padding: 16px; overflow: hidden; height: 100%; display: flex; flex-direction: column; }
  .page-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    flex-shrink: 0;
  }
  h2 { font-size: var(--font-size-lg); }
  h3 { font-size: var(--font-size-base); margin: 0; }
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

  /* Body: grid + optional sidebar */
  .workers-body {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-height: 0;
  }

  /* 3-wide grid */
  .workers-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    overflow-y: auto;
    padding-right: 4px;
    align-content: start;
    min-width: 0;
  }

  .worker-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    cursor: pointer;
    transition: border-color 0.15s;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .worker-card:hover {
    border-color: var(--accent);
  }
  .worker-card.monitored {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 8%, var(--bg-surface));
  }

  .card-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .worker-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--font-size-sm);
  }
  .account-chip {
    font-size: 10px;
    color: var(--text-muted);
    background: color-mix(in oklab, var(--bg-elevated) 65%, transparent);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .card-info {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .info-item {
    font-size: 11px;
    color: var(--text-muted);
  }
  .info-item.mono {
    font-family: var(--font-mono);
  }
  .card-programs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: auto;
  }
  .last-seen {
    font-size: 11px;
    color: var(--text-muted);
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

  /* Sidebar resize handle (Chat pattern) */
  .sidebar-resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .sidebar-resize-handle:hover,
  .sidebar-resize-handle:active {
    background: var(--accent);
  }

  /* Monitor sidebar */
  .workers-monitor {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    overflow-y: auto;
    flex-shrink: 0;
    background: var(--bg-base);
  }
  .monitor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .monitor-count {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 4px;
  }
  .clear-btn {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }
  .clear-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .monitor-list {
    flex: 1;
    overflow-y: auto;
  }

  .monitor-card {
    border-bottom: 1px solid var(--border);
    padding: 10px 12px;
  }
  .monitor-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .monitor-name {
    flex: 1;
    font-size: var(--font-size-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .monitor-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .detail-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-sm);
  }
  .detail-label {
    color: var(--text-muted);
    font-weight: 500;
    min-width: 48px;
    flex-shrink: 0;
  }
  .detail-row span:not(.detail-label) {
    color: var(--text-secondary);
  }
  .program-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  code {
    background: var(--bg-surface);
    padding: 1px 4px;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
  }

  /* Monitor bridges */
  .monitor-bridges {
    padding-top: 4px;
  }
  .bridges-label {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .bridge-row {
    padding: 4px 6px;
    margin-bottom: 2px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }
  .bridge-row.offline-row {
    opacity: 0.6;
  }
  .bridge-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .bridge-name {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bridge-version {
    font-size: 10px;
    color: var(--text-muted);
  }
  .bridge-sessions {
    font-size: 10px;
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
  .bridge-paths {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 2px;
  }
  .bridge-path {
    font-size: 10px;
    display: block;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .empty {
    grid-column: 1 / -1;
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 8px;
  }

  @media (max-width: 1200px) {
    .workers-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 800px) {
    .workers-grid { grid-template-columns: 1fr; }
  }
</style>
