<script lang="ts">
  import { onMount } from "svelte";
  import { api, type AdminApiKey, type AdminApiKeyCreateResponse } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";

  let keys = $state<AdminApiKey[]>([]);
  let loading = $state(false);
  let creating = $state(false);

  let name = $state("");
  let role = $state<"bridge" | "client" | "admin">("client");

  let createdKey = $state<AdminApiKeyCreateResponse | null>(null);

  async function load() {
    loading = true;
    try {
      keys = await api.keys.list();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load API keys");
    } finally {
      loading = false;
    }
  }

  async function createKey() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }

    creating = true;
    try {
      createdKey = await api.keys.create(trimmed, role);
      name = "";
      role = "client";
      toast.success("API key created");
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create API key");
    } finally {
      creating = false;
    }
  }

  async function revokeKey(key: AdminApiKey) {
    if (!confirm(`Revoke API key '${key.name}'?`)) return;

    try {
      await api.keys.revoke(key.id);
      toast.success("API key revoked");
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to revoke API key");
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch { /* secure-context only; fall through */ }
    }
    // Fallback for non-HTTPS contexts (e.g. http://truenas.local)
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  async function copyRawKey() {
    const raw = createdKey?.key;
    if (!raw) return;

    try {
      await copyToClipboard(raw);
      toast.success("Key copied");
    } catch {
      toast.error("Clipboard write failed");
    }
  }

  function roleHelp(current: "bridge" | "client" | "admin"): string {
    if (current === "client") return "Use for MCP and client APIs";
    if (current === "admin") return "Full admin-level API access";
    return "Bridge websocket/auth only (not for MCP)";
  }

  onMount(load);
</script>

<div class="page">
  <div class="toolbar">
    <h2>API Keys</h2>
    <button class="btn-secondary" onclick={load} disabled={loading}>Refresh</button>
  </div>

  <div class="card">
    <h3>Create Key</h3>
    <p class="muted">Create a key for MCP or automation clients. Keep raw keys secret.</p>
    <div class="form-row">
      <label class="field">
        <span>Name</span>
        <input
          type="text"
          bind:value={name}
          placeholder="codex-mcp"
          maxlength="120"
        />
      </label>
      <label class="field role-field">
        <span>Role</span>
        <select bind:value={role}>
          <option value="client">client</option>
          <option value="admin">admin</option>
          <option value="bridge">bridge</option>
        </select>
      </label>
      <div class="field actions-field">
        <span>&nbsp;</span>
        <button class="btn-primary" onclick={createKey} disabled={creating || !name.trim()}>
          {creating ? "Creating..." : "Create Key"}
        </button>
      </div>
    </div>
    <p class="muted small">{roleHelp(role)}</p>
  </div>

  {#if createdKey}
    <div class="card created">
      <h3>New Key (Shown Once)</h3>
      <p class="muted">Store this now. You will not be able to view it again after closing this panel.</p>
      <div class="key-row">
        <code>{createdKey.key}</code>
        <button class="btn-secondary" onclick={copyRawKey}>Copy</button>
      </div>
      <p class="meta">Name: <strong>{createdKey.name}</strong> | Role: <strong>{createdKey.role}</strong></p>
    </div>
  {/if}

  <div class="card">
    <h3>Active Keys</h3>
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Role</th>
          <th>Created</th>
          <th>Id</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          <tr><td colspan="5" class="muted">Loading keys...</td></tr>
        {:else if keys.length === 0}
          <tr><td colspan="5" class="muted">No active API keys.</td></tr>
        {:else}
          {#each keys as key}
            <tr>
              <td>{key.name}</td>
              <td>
                <span class="role role-{key.role}">{key.role}</span>
              </td>
              <td class="muted">{new Date(key.createdAt).toLocaleString()}</td>
              <td><code>{key.id}</code></td>
              <td>
                <button class="btn-small btn-danger" onclick={() => revokeKey(key)}>Revoke</button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
  .page { padding: 24px; display: flex; flex-direction: column; gap: 16px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; }
  .toolbar h2 { font-size: var(--font-size-xl); color: var(--text-primary); }
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px;
  }
  .card h3 { margin: 0 0 8px; font-size: var(--font-size-lg); color: var(--text-primary); }
  .muted { color: var(--text-muted); }
  .small { font-size: var(--font-size-sm); }

  .form-row {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(180px, 1fr) 180px 160px;
    align-items: end;
    margin-top: 10px;
  }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field span { color: var(--text-secondary); font-size: var(--font-size-sm); }
  .role-field select, .field input { width: 100%; }

  .actions-field { display: flex; flex-direction: column; }

  .created { border-color: rgba(78, 201, 176, 0.35); }
  .key-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 10px 0;
  }
  .key-row code {
    flex: 1;
    overflow-x: auto;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .meta { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); }

  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  .table th { color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500; }
  .table code {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    border-radius: 3px;
    padding: 2px 6px;
  }

  .role {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .role-client { color: #60a5fa; background: rgba(96, 165, 250, 0.14); }
  .role-admin { color: #34d399; background: rgba(52, 211, 153, 0.14); }
  .role-bridge { color: #fbbf24; background: rgba(251, 191, 36, 0.14); }

  .btn-primary {
    background: var(--accent);
    color: #fff;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-weight: 500;
  }
  .btn-primary:hover { background: var(--accent-hover); }

  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--text-secondary);
    padding: 8px 14px;
    border-radius: var(--radius-sm);
  }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }

  .btn-small {
    background: var(--bg-elevated);
    color: var(--text-secondary);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }
  .btn-danger { color: var(--status-failed); }

  @media (max-width: 900px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
