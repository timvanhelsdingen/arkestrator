<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";

  interface AuditEntry {
    id: string;
    userId: string | null;
    username: string;
    action: string;
    resource: string;
    resourceId: string | null;
    details: string | null;
    ipAddress: string | null;
    createdAt: string;
  }

  let entries = $state<AuditEntry[]>([]);
  let total = $state(0);
  let page = $state(0);
  let actionFilter = $state("");
  const limit = 50;

  async function load() {
    try {
      const result = await api.audit.list({
        limit,
        offset: page * limit,
        action: actionFilter || undefined,
      });
      entries = result.entries;
      total = result.total;
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  let totalPages = $derived(Math.ceil(total / limit));

  onMount(load);

  function nextPage() {
    if (page < totalPages - 1) {
      page++;
      load();
    }
  }

  function prevPage() {
    if (page > 0) {
      page--;
      load();
    }
  }
</script>

<div class="page">
  <div class="toolbar">
    <select bind:value={actionFilter} onchange={() => { page = 0; load(); }}>
      <option value="">All Actions</option>
      <option value="login">Login</option>
      <option value="login_failed">Login Failed</option>
      <option value="logout">Logout</option>
      <option value="create_user">Create User</option>
      <option value="delete_user">Delete User</option>
      <option value="update_user_role">Update Role</option>
      <option value="reset_password">Reset Password</option>
      <option value="create_api_key">Create Key</option>
      <option value="revoke_api_key">Revoke Key</option>
      <option value="create_agent_config">Create Agent</option>
      <option value="update_agent_config">Update Agent</option>
      <option value="delete_agent_config">Delete Agent</option>
      <option value="create_policy">Create Policy</option>
      <option value="update_policy">Update Policy</option>
      <option value="delete_policy">Delete Policy</option>
      <option value="kick_connection">Kick Connection</option>
      <option value="requeue_job">Requeue Job</option>
    </select>
    <span class="count">{total} total entries</span>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th>Time</th>
        <th>User</th>
        <th>Action</th>
        <th>Resource</th>
        <th>Details</th>
        <th>IP</th>
      </tr>
    </thead>
    <tbody>
      {#each entries as entry}
        <tr>
          <td class="muted">{new Date(entry.createdAt).toLocaleString()}</td>
          <td>{entry.username}</td>
          <td><span class="action-badge">{entry.action}</span></td>
          <td>
            {entry.resource}
            {#if entry.resourceId}
              <code class="resource-id">{entry.resourceId.slice(0, 8)}</code>
            {/if}
          </td>
          <td class="details">{entry.details ? truncate(entry.details, 60) : "-"}</td>
          <td class="muted">{entry.ipAddress ?? "-"}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if totalPages > 1}
    <div class="pagination">
      <button class="btn-small" onclick={prevPage} disabled={page === 0}>Previous</button>
      <span class="page-info">Page {page + 1} of {totalPages}</span>
      <button class="btn-small" onclick={nextPage} disabled={page >= totalPages - 1}>Next</button>
    </div>
  {/if}
</div>

<script lang="ts" module>
  function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
  }
</script>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
  .count { color: var(--text-muted); font-size: var(--font-size-sm); margin-left: auto; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  .table th { color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }
  .action-badge { background: var(--bg-active); padding: 2px 8px; border-radius: 10px; font-size: var(--font-size-sm); }
  .resource-id { font-family: var(--font-mono); font-size: 10px; margin-left: 4px; background: var(--bg-base); padding: 1px 4px; border-radius: 2px; }
  .details { font-size: var(--font-size-sm); color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 16px; padding: 12px; }
  .page-info { color: var(--text-secondary); font-size: var(--font-size-sm); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .btn-small:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
