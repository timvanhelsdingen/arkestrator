<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface Connection {
    id: string;
    type: string;
    name: string;
    program?: string;
    programVersion?: string;
    bridgeVersion?: string;
    ip?: string;
  }

  interface Bridge {
    id: string;
    connected: boolean;
    workerName?: string;
    program?: string;
    programVersion?: string;
    bridgeVersion?: string;
    lastSeen?: string;
  }

  interface ScriptInfo {
    program: string;
    content: string;
    isDefault: boolean;
    defaultContent: string;
  }

  interface ProgramInfo {
    program: string;
    activeConnectionCount: number;
    activeConnectionIds: string[];
    workers: string[];
    bridgeVersions: string[];
    programVersions: string[];
    lastSeen: string | null;
    hasScript: boolean;
    scriptIsDefault: boolean;
    scriptContent: string;
    scriptDefaultContent: string;
  }

  let loading = $state(false);
  let connections = $state<Connection[]>([]);
  let bridges = $state<Bridge[]>([]);
  let scripts = $state<ScriptInfo[]>([]);

  let programs = $derived.by(() => {
    const map = new Map<string, ProgramInfo>();

    function ensure(name: string): ProgramInfo {
      let info = map.get(name);
      if (!info) {
        info = {
          program: name,
          activeConnectionCount: 0,
          activeConnectionIds: [],
          workers: [],
          bridgeVersions: [],
          programVersions: [],
          lastSeen: null,
          hasScript: false,
          scriptIsDefault: true,
          scriptContent: "",
          scriptDefaultContent: "",
        };
        map.set(name, info);
      }
      return info;
    }

    for (const b of bridges) {
      if (!b.program) continue;
      const info = ensure(b.program);
      if (b.workerName && !info.workers.includes(b.workerName)) {
        info.workers.push(b.workerName);
      }
      if (b.bridgeVersion && !info.bridgeVersions.includes(b.bridgeVersion)) {
        info.bridgeVersions.push(b.bridgeVersion);
      }
      if (b.programVersion && !info.programVersions.includes(b.programVersion)) {
        info.programVersions.push(b.programVersion);
      }
      if (b.lastSeen && (!info.lastSeen || b.lastSeen > info.lastSeen)) {
        info.lastSeen = b.lastSeen;
      }
    }

    for (const conn of connections) {
      if (conn.type !== "bridge" || !conn.program) continue;
      const info = ensure(conn.program);
      info.activeConnectionCount++;
      info.activeConnectionIds.push(conn.id);
      if (conn.bridgeVersion && !info.bridgeVersions.includes(conn.bridgeVersion)) {
        info.bridgeVersions.push(conn.bridgeVersion);
      }
      if (conn.programVersion && !info.programVersions.includes(conn.programVersion)) {
        info.programVersions.push(conn.programVersion);
      }
    }

    for (const s of scripts) {
      const info = ensure(s.program);
      info.hasScript = true;
      info.scriptIsDefault = s.isDefault;
      info.scriptContent = s.content;
      info.scriptDefaultContent = s.defaultContent;
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) => a.program.localeCompare(b.program));
    return arr;
  });

  function formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return "just now";
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function scriptPreview(content: string): string {
    if (!content) return "";
    const lines = content.split("\n").filter((l) => l.trim()).slice(0, 2);
    const text = lines.join(" ").trim();
    return text.length > 60 ? text.slice(0, 57) + "..." : text;
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Workers expand/collapse
  let expandedWorkers = $state(new Set<string>());
  function toggleWorkers(program: string) {
    const next = new Set(expandedWorkers);
    if (next.has(program)) next.delete(program); else next.add(program);
    expandedWorkers = next;
  }

  // Modal state
  let editScriptProgram = $state<ProgramInfo | null>(null);
  let editScriptContent = $state("");
  let addBridgeOpen = $state(false);
  let addBridgeName = $state("");
  let addBridgeScript = $state("");
  let confirmRemove = $state<ProgramInfo | null>(null);
  let confirmKick = $state<ProgramInfo | null>(null);

  async function load() {
    loading = true;
    try {
      const [workersResult, connsResult, scriptsResult] = await Promise.all([
        api.workers.list(),
        api.connections.list(),
        api.coordinatorTraining.listCoordinatorScripts(),
      ]);
      bridges = Array.isArray(workersResult?.bridges) ? workersResult.bridges : [];
      connections = Array.isArray(connsResult) ? connsResult : [];
      scripts = Array.isArray(scriptsResult?.scripts) ? scriptsResult.scripts : [];
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load bridges data");
    } finally {
      loading = false;
    }
  }

  function openEditScript(info: ProgramInfo) {
    editScriptProgram = info;
    editScriptContent = info.scriptContent || info.scriptDefaultContent || "";
  }

  async function saveScript() {
    if (!editScriptProgram) return;
    try {
      await api.coordinatorTraining.updateCoordinatorScript(editScriptProgram.program, editScriptContent);
      toast.success(`Script for "${editScriptProgram.program}" saved`);
      editScriptProgram = null;
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save script");
    }
  }

  function resetScriptToDefault() {
    if (!editScriptProgram) return;
    editScriptContent = editScriptProgram.scriptDefaultContent || "";
  }

  async function kickAll() {
    if (!confirmKick) return;
    const ids = confirmKick.activeConnectionIds;
    const program = confirmKick.program;
    confirmKick = null;
    let kicked = 0;
    for (const id of ids) {
      try {
        await api.connections.kick(id);
        kicked++;
      } catch {
        // connection may have disconnected
      }
    }
    toast.success(`Kicked ${kicked} connection(s) for "${program}"`);
    await load();
  }

  async function removeProgram() {
    if (!confirmRemove) return;
    const program = confirmRemove.program;
    confirmRemove = null;
    const errors: string[] = [];
    try {
      await api.workers.deleteBridgesByProgram(program);
    } catch (err: any) {
      errors.push(`bridge history: ${err.message ?? "failed"}`);
    }
    try {
      await api.coordinatorTraining.deleteCoordinatorScript(program);
    } catch (err: any) {
      if (!String(err.message ?? "").includes("404")) {
        errors.push(`coordinator script: ${err.message ?? "failed"}`);
      }
    }
    if (errors.length > 0) {
      toast.error(`Partial removal of "${program}": ${errors.join("; ")}`);
    } else {
      toast.success(`Removed bridge program "${program}"`);
    }
    await load();
  }

  async function addBridge() {
    const name = addBridgeName.trim();
    if (!name) {
      toast.error("Program name is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      toast.error("Program name may only contain letters, numbers, hyphens, and underscores");
      return;
    }
    try {
      const content = addBridgeScript.trim() || `# Coordinator script for ${name}\n`;
      await api.coordinatorTraining.updateCoordinatorScript(name, content);
      toast.success(`Bridge program "${name}" created`);
      addBridgeOpen = false;
      addBridgeName = "";
      addBridgeScript = "";
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create bridge program");
    }
  }

  onMount(() => {
    load();
    refreshTimer = setInterval(load, 15_000);
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
</script>

<div class="page">
  <div class="toolbar">
    <button class="btn-primary" onclick={() => (addBridgeOpen = true)}>Add Bridge</button>
    <button class="btn-secondary" onclick={load} disabled={loading}>Refresh</button>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th>Program</th>
        <th>Status</th>
        <th>Workers</th>
        <th>Versions</th>
        <th>Script</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr><td colspan="6" class="muted">Loading bridges...</td></tr>
      {:else if programs.length === 0}
        <tr><td colspan="6" class="muted">No bridge programs found.</td></tr>
      {:else}
        {#each programs as info}
          <tr>
            <td class="mono">{info.program}</td>
            <td>
              {#if info.activeConnectionCount > 0}
                <span class="badge badge-ok">{info.activeConnectionCount} online</span>
              {:else}
                <span class="badge badge-off">offline</span>
              {/if}
              {#if info.lastSeen}
                <span class="last-seen">{formatRelativeTime(info.lastSeen)}</span>
              {/if}
            </td>
            <td class="muted">
              {#if info.workers.length === 0}
                -
              {:else}
                <button class="workers-toggle" onclick={() => toggleWorkers(info.program)} title={info.workers.join(", ")}>
                  {info.workers.length} worker{info.workers.length !== 1 ? "s" : ""}
                </button>
                {#if expandedWorkers.has(info.program)}
                  <div class="workers-list">
                    {#each info.workers as w}<div>{w}</div>{/each}
                  </div>
                {/if}
              {/if}
            </td>
            <td class="muted versions-cell">
              {#if info.programVersions.length > 0}
                <span>App: {info.programVersions.join(", ")}</span>
              {/if}
              {#if info.bridgeVersions.length > 0}
                <span>Bridge: {info.bridgeVersions.join(", ")}</span>
              {/if}
              {#if info.programVersions.length === 0 && info.bridgeVersions.length === 0}
                -
              {/if}
            </td>
            <td>
              {#if info.hasScript}
                <span class="badge {info.scriptIsDefault ? 'badge-default' : 'badge-custom'}">
                  {info.scriptIsDefault ? "default" : "custom"}
                </span>
                {#if scriptPreview(info.scriptContent)}
                  <span class="script-preview">{scriptPreview(info.scriptContent)}</span>
                {/if}
              {:else}
                <span class="muted">none</span>
              {/if}
            </td>
            <td class="actions-cell">
              <button class="btn-small" onclick={() => openEditScript(info)}>Edit Script</button>
              {#if info.activeConnectionCount > 0}
                <button class="btn-small btn-warning" onclick={() => (confirmKick = info)}>Kick All</button>
              {/if}
              <button class="btn-small btn-danger" onclick={() => (confirmRemove = info)}>Remove</button>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<Modal title="Edit Coordinator Script" open={editScriptProgram !== null} onclose={() => (editScriptProgram = null)}>
  {#if editScriptProgram}
    <p class="hint">Program: <strong>{editScriptProgram.program}</strong></p>
    <label class="field">
      <span>Script content</span>
      <textarea bind:value={editScriptContent} rows="18" class="script-editor"></textarea>
    </label>
    <div class="actions">
      <button class="btn-secondary" type="button" onclick={resetScriptToDefault}>Reset to Default</button>
      <button class="btn-secondary" type="button" onclick={() => (editScriptProgram = null)}>Cancel</button>
      <button class="btn-primary" type="button" onclick={saveScript}>Save</button>
    </div>
  {/if}
</Modal>

<Modal title="Add Bridge Program" open={addBridgeOpen} onclose={() => (addBridgeOpen = false)}>
  <form onsubmit={(e) => { e.preventDefault(); addBridge(); }}>
    <label class="field">
      <span>Program name</span>
      <input type="text" bind:value={addBridgeName} placeholder="e.g. godot, blender, houdini" />
    </label>
    <label class="field">
      <span>Initial coordinator script (optional)</span>
      <textarea bind:value={addBridgeScript} rows="8" placeholder="# Coordinator instructions for this program..."></textarea>
    </label>
    <div class="actions">
      <button class="btn-secondary" type="button" onclick={() => (addBridgeOpen = false)}>Cancel</button>
      <button class="btn-primary" type="submit">Create</button>
    </div>
  </form>
</Modal>

<Modal title="Remove Bridge Program" open={confirmRemove !== null} onclose={() => (confirmRemove = null)}>
  {#if confirmRemove}
    <p>Are you sure you want to remove <strong>{confirmRemove.program}</strong>?</p>
    <p class="hint">This will delete all bridge history records and the coordinator script for this program. Active connections will not be kicked.</p>
    <div class="actions">
      <button class="btn-secondary" onclick={() => (confirmRemove = null)}>Cancel</button>
      <button class="btn-danger" onclick={removeProgram}>Remove</button>
    </div>
  {/if}
</Modal>

<Modal title="Kick All Connections" open={confirmKick !== null} onclose={() => (confirmKick = null)}>
  {#if confirmKick}
    <p>Kick all <strong>{confirmKick.activeConnectionCount}</strong> active connection(s) for <strong>{confirmKick.program}</strong>?</p>
    <p class="hint">The bridges will be disconnected immediately. They may reconnect automatically depending on their configuration.</p>
    <div class="actions">
      <button class="btn-secondary" onclick={() => (confirmKick = null)}>Cancel</button>
      <button class="btn-danger" onclick={kickAll}>Kick All</button>
    </div>
  {/if}
</Modal>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  .table th { color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }
  .mono { font-family: var(--font-mono); font-size: var(--font-size-sm); }
  .badge {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge-ok { color: var(--status-completed); background: rgba(78, 201, 176, 0.12); }
  .badge-off { color: var(--text-muted); background: var(--bg-elevated); }
  .badge-default { color: var(--text-muted); background: var(--bg-elevated); }
  .badge-custom { color: var(--accent); background: rgba(78, 156, 230, 0.12); }
  .versions-cell { display: flex; flex-direction: column; gap: 2px; }
  .btn-primary { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--bg-elevated); color: var(--text-secondary); padding: 8px 14px; border-radius: var(--radius-sm); }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { background: rgba(220, 50, 50, 0.15); color: #e05555; border: none; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; cursor: pointer; }
  .btn-danger:hover { background: rgba(220, 50, 50, 0.25); }
  .btn-small.btn-danger { padding: 4px 10px; font-size: var(--font-size-sm); }
  .btn-warning { background: rgba(220, 170, 50, 0.15); color: #d4a832; }
  .btn-warning:hover { background: rgba(220, 170, 50, 0.25); }
  .btn-small.btn-warning { padding: 4px 10px; font-size: var(--font-size-sm); }
  .actions-cell { display: flex; gap: 6px; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .field { display: block; margin-bottom: 12px; }
  .field span { display: block; margin-bottom: 4px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .field input, .field textarea { width: 100%; }
  .hint { color: var(--text-secondary); margin-bottom: 12px; }
  .script-editor {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    resize: vertical;
    min-height: 200px;
  }
  .workers-toggle {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  .workers-toggle:hover { color: var(--text-primary); }
  .workers-list {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .last-seen { color: var(--text-muted); font-size: 10px; display: block; margin-top: 2px; }
  .script-preview { display: block; color: var(--text-muted); font-size: 11px; margin-top: 2px; font-style: italic; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
