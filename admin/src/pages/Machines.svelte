<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface WorkerRule {
    workerName: string;
    banned: boolean;
    clientCoordinationAllowed: boolean;
    ipAllowlist: string[];
    ipDenylist: string[];
    localLlmEnabled: boolean;
    localLlmBaseUrl: string;
    note: string;
  }

  interface Worker {
    id: string;
    name: string;
    status: "online" | "offline";
    lastIp?: string;
    activeBridgeCount: number;
    knownPrograms?: string[];
    firstSeenAt: string;
    lastSeenAt: string;
    rule: WorkerRule;
  }

  interface Bridge {
    id: string;
    connected: boolean;
    workerName?: string;
    program?: string;
    ip?: string;
    activeProjects?: string[];
  }

  let workers = $state<Worker[]>([]);
  let bridges = $state<Bridge[]>([]);
  let loading = $state(false);
  let showRules = $state<Worker | null>(null);

  let editBanned = $state(false);
  let editClientCoordAllowed = $state(true);
  let editIpAllowlist = $state("");
  let editIpDenylist = $state("");
  let editLocalLlmEnabled = $state(false);
  let editLocalLlmBaseUrl = $state("");
  let editNote = $state("");
  let localLlmCheckBusy = $state(false);
  let localLlmCheckOutput = $state("");
  let confirmDelete = $state<Worker | null>(null);

  function parseList(value: string): string[] {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function load() {
    loading = true;
    try {
      const result = await api.workers.list();
      const workerRows = Array.isArray(result?.workers) ? result.workers : [];
      const bridgeRows = Array.isArray(result?.bridges) ? result.bridges : [];
      workers = workerRows;
      bridges = bridgeRows;
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load machines");
    } finally {
      loading = false;
    }
  }

  function openRules(worker: Worker) {
    showRules = worker;
    editBanned = worker.rule?.banned === true;
    editClientCoordAllowed = worker.rule?.clientCoordinationAllowed !== false;
    editIpAllowlist = (worker.rule?.ipAllowlist ?? []).join("\n");
    editIpDenylist = (worker.rule?.ipDenylist ?? []).join("\n");
    editLocalLlmEnabled = worker.rule?.localLlmEnabled === true;
    editLocalLlmBaseUrl = worker.rule?.localLlmBaseUrl ?? "";
    editNote = worker.rule?.note ?? "";
    localLlmCheckOutput = "";
  }

  async function saveRules() {
    if (!showRules) return;
    try {
      await api.workers.updateRules(showRules.id, {
        banned: editBanned,
        clientCoordinationAllowed: editClientCoordAllowed,
        ipAllowlist: parseList(editIpAllowlist),
        ipDenylist: parseList(editIpDenylist),
        localLlmEnabled: editLocalLlmEnabled,
        localLlmBaseUrl: editLocalLlmBaseUrl,
        note: editNote,
      });
      toast.success("Machine rules updated");
      showRules = null;
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update machine rules");
    }
  }

  async function runLocalLlmCheck() {
    if (!showRules) return;
    localLlmCheckBusy = true;
    localLlmCheckOutput = "";
    try {
      const result = await api.workers.checkLocalLlm(showRules.id, 5000);
      if (!result?.resolution?.enabled) {
        localLlmCheckOutput = `Local LLM disabled: ${result?.resolution?.reason ?? "enable local LLM in machine rules."}`;
        return;
      }
      if (!result?.resolution?.baseUrl) {
        localLlmCheckOutput = `Missing endpoint: ${result?.resolution?.reason ?? "set localLlmBaseUrl or ensure worker IP is available."}`;
        return;
      }
      if (!result?.health?.ok) {
        localLlmCheckOutput = `Unreachable at ${result?.resolution?.baseUrl}: ${result?.health?.error ?? "unknown error"}`;
        return;
      }
      const models = Array.isArray(result.health.models) ? result.health.models.slice(0, 6).join(", ") : "";
      localLlmCheckOutput =
        `OK at ${result.health.baseUrl} | ${result.health.modelCount} model(s) | ${result.health.latencyMs}ms` +
        (models ? ` | ${models}` : "");
    } catch (err: any) {
      localLlmCheckOutput = err.message ?? "Failed local LLM check";
    } finally {
      localLlmCheckBusy = false;
    }
  }

  function getBridgeSummary(workerName: string): string {
    const names = bridges
      .filter((bridge) => bridge.workerName?.toLowerCase() === workerName.toLowerCase() && bridge.connected)
      .map((bridge) => bridge.program)
      .filter((program): program is string => !!program);
    return names.length > 0 ? names.join(", ") : "-";
  }

  async function deleteWorker() {
    if (!confirmDelete) return;
    try {
      await api.workers.delete(confirmDelete.id);
      toast.success(`Machine "${confirmDelete.name}" deleted`);
      confirmDelete = null;
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to delete machine");
    }
  }

  onMount(load);
</script>

<div class="page">
  <div class="toolbar">
    <button class="btn-secondary" onclick={load} disabled={loading}>Refresh</button>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th>Machine</th>
        <th>Status</th>
        <th>IP</th>
        <th>Connected Programs</th>
        <th>Bridges</th>
        <th>Client Orchestration</th>
        <th>Local LLM</th>
        <th>Banned</th>
        <th>Last Seen</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr><td colspan="10" class="muted">Loading machines...</td></tr>
      {:else if workers.length === 0}
        <tr><td colspan="10" class="muted">No machines found.</td></tr>
      {:else}
        {#each workers as worker}
          <tr>
            <td>{worker.name}</td>
            <td>
              <span class="badge {worker.status === 'online' ? 'badge-ok' : 'badge-off'}">{worker.status}</span>
            </td>
            <td class="mono">{worker.lastIp ?? "-"}</td>
            <td class="muted">{getBridgeSummary(worker.name)}</td>
            <td class="muted">{worker.activeBridgeCount}</td>
            <td class="muted">{worker.rule?.clientCoordinationAllowed === false ? "Disabled" : "Allowed"}</td>
            <td class="muted">{worker.rule?.localLlmEnabled ? "Enabled" : "Disabled"}</td>
            <td class="muted">{worker.rule?.banned ? "Yes" : "No"}</td>
            <td class="muted">{new Date(worker.lastSeenAt).toLocaleString()}</td>
            <td class="actions-cell">
              <button class="btn-small" onclick={() => openRules(worker)}>Rules</button>
              <button class="btn-small btn-danger" onclick={() => (confirmDelete = worker)}>Delete</button>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<Modal title="Machine Rules" open={showRules !== null} onclose={() => (showRules = null)}>
  {#if showRules}
    <form onsubmit={(e) => { e.preventDefault(); saveRules(); }}>
      <p class="hint"><strong>{showRules.name}</strong> ({showRules.lastIp ?? "no IP"})</p>
      <label class="check-row">
        <input type="checkbox" bind:checked={editBanned} />
        <span>Ban this machine (reject bridge connections and target jobs)</span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={editClientCoordAllowed} />
        <span>Allow client-side orchestration on this machine</span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={editLocalLlmEnabled} />
        <span>Enable distributed local LLM routing for targeted local-oss jobs</span>
      </label>

      <label class="field">
        <span>IP Allowlist (optional; comma/newline separated)</span>
        <textarea bind:value={editIpAllowlist} rows="3" placeholder="192.168.1.10"></textarea>
      </label>
      <label class="field">
        <span>IP Denylist (optional; comma/newline separated)</span>
        <textarea bind:value={editIpDenylist} rows="3" placeholder="10.0.0.5"></textarea>
      </label>
      <label class="field">
        <span>Local LLM Base URL (optional)</span>
        <input type="text" bind:value={editLocalLlmBaseUrl} placeholder="http://192.168.1.25:11434" />
      </label>
      <label class="field">
        <span>Note</span>
        <input type="text" bind:value={editNote} placeholder="Reason / comment" />
      </label>
      <div class="actions">
        <button class="btn-secondary" type="button" onclick={runLocalLlmCheck} disabled={localLlmCheckBusy}>
          {localLlmCheckBusy ? "Checking..." : "Check Local LLM"}
        </button>
        <button class="btn-primary" type="submit">Save</button>
      </div>
      {#if localLlmCheckOutput}
        <p class="hint mono">{localLlmCheckOutput}</p>
      {/if}
    </form>
  {/if}
</Modal>

<Modal title="Delete Machine" open={confirmDelete !== null} onclose={() => (confirmDelete = null)}>
  {#if confirmDelete}
    <p>Are you sure you want to delete <strong>{confirmDelete.name}</strong>?</p>
    <p class="hint">This will remove the machine record and its bridge history. If the machine reconnects, it will be re-created automatically.</p>
    <div class="actions">
      <button class="btn-secondary" onclick={() => (confirmDelete = null)}>Cancel</button>
      <button class="btn-danger" onclick={deleteWorker}>Delete</button>
    </div>
  {/if}
</Modal>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 14px; }
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
  .btn-primary { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--bg-elevated); color: var(--text-secondary); padding: 8px 14px; border-radius: var(--radius-sm); }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { background: rgba(220, 50, 50, 0.15); color: #e05555; border: none; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; cursor: pointer; }
  .btn-danger:hover { background: rgba(220, 50, 50, 0.25); }
  .btn-small.btn-danger { padding: 4px 10px; font-size: var(--font-size-sm); }
  .actions-cell { display: flex; gap: 6px; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .field { display: block; margin-bottom: 12px; }
  .field span { display: block; margin-bottom: 4px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .field input, .field textarea { width: 100%; }
  .hint { color: var(--text-secondary); margin-bottom: 12px; }
  .check-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 10px;
    color: var(--text-secondary);
  }
  .check-row input[type="checkbox"] {
    margin-top: 2px;
  }
</style>
