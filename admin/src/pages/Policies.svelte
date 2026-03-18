<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface Policy {
    id: string;
    scope: string;
    userId: string | null;
    type: string;
    pattern: string;
    action: string;
    description: string | null;
    enabled: boolean;
    createdAt: string;
  }

  interface UserOption {
    id: string;
    username: string;
  }

  const typeLabels: Record<string, string> = {
    file_path: "File Paths",
    tool: "Tool Restrictions",
    prompt_filter: "Prompt Filters",
    engine_model: "Engine / Model",
    command_filter: "Command Filters",
  };

  const typeHelp: Record<string, string> = {
    file_path: "Glob patterns to block file modifications (e.g. *.env, /secrets/**)",
    tool: "Agent tool names to block (e.g. Bash, Write)",
    prompt_filter: "Regex patterns to block in job prompts (e.g. rm -rf, DELETE FROM)",
    engine_model: "Engine or engine:model to block (e.g. gemini, claude-code:opus)",
    command_filter: "Regex patterns to block commands/scripts before execution (e.g. rm -rf, del /f)",
  };

  const typePlaceholders: Record<string, string> = {
    file_path: "*.env",
    tool: "Bash",
    prompt_filter: "rm -rf",
    engine_model: "gemini",
    command_filter: "rm\\s+-rf|del\\s+/f",
  };

  let policies = $state<Policy[]>([]);
  let users = $state<UserOption[]>([]);
  let activeTab = $state("file_path");
  let showForm = $state(false);
  let editingId = $state<string | null>(null);
  let form = $state({
    scope: "global" as string,
    userId: "",
    type: "file_path",
    pattern: "",
    action: "block" as string,
    description: "",
  });

  let tabPolicies = $derived(policies.filter((p) => p.type === activeTab));
  let usernameById = $derived(
    new Map(users.map((user) => [user.id, user.username] as const)),
  );

  function resetForm() {
    form = { scope: "global", userId: "", type: activeTab, pattern: "", action: "block", description: "" };
    editingId = null;
  }

  async function load() {
    try {
      policies = await api.policies.list();
    } catch (err: any) {
      toast.error(err.message);
    }

    // User list is optional for policy managers without manageUsers permission.
    try {
      const result = await api.users.list();
      const rows = Array.isArray(result)
        ? result
        : (Array.isArray((result as any)?.users) ? (result as any).users : []);
      users = rows.map((row: any) => ({
        id: String(row?.id ?? ""),
        username: String(row?.username ?? ""),
      })).filter((row: UserOption) => row.id && row.username);
    } catch {
      users = [];
    }
  }

  function startEdit(policy: Policy) {
    editingId = policy.id;
    form = {
      scope: policy.scope,
      userId: policy.userId ?? "",
      type: policy.type,
      pattern: policy.pattern,
      action: policy.action,
      description: policy.description ?? "",
    };
    showForm = true;
  }

  async function save() {
    const data = {
      scope: form.scope,
      userId: form.scope === "user" ? form.userId || undefined : undefined,
      type: form.type,
      pattern: form.pattern,
      action: form.action,
      description: form.description || undefined,
    };

    try {
      if (editingId) {
        await api.policies.update(editingId, data);
        toast.success("Policy updated");
      } else {
        await api.policies.create(data);
        toast.success("Policy created");
      }
      showForm = false;
      resetForm();
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    try {
      await api.policies.toggle(id, enabled);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deletePolicy(id: string) {
    if (!confirm("Delete this policy?")) return;
    try {
      await api.policies.delete(id);
      toast.success("Policy deleted");
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  onMount(load);
</script>

<div class="page">
  <div class="toolbar">
    <div class="tabs">
      {#each Object.entries(typeLabels) as [type, label]}
        <button
          class="tab"
          class:active={activeTab === type}
          onclick={() => (activeTab = type)}
        >
          {label}
          <span class="tab-count">{policies.filter((p) => p.type === type).length}</span>
        </button>
      {/each}
    </div>
    <button class="btn-primary" onclick={() => { resetForm(); form.type = activeTab; showForm = true; }}>
      Add Rule
    </button>
  </div>

  <p class="help-text">{typeHelp[activeTab]}</p>

  {#if tabPolicies.length === 0}
    <div class="empty">No {typeLabels[activeTab]?.toLowerCase()} rules configured</div>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>Enabled</th>
          <th>Pattern</th>
          <th>Action</th>
          <th>Scope</th>
          <th>Description</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each tabPolicies as policy}
          <tr class:disabled={!policy.enabled}>
            <td>
              <input
                type="checkbox"
                checked={policy.enabled}
                onchange={() => toggle(policy.id, !policy.enabled)}
              />
            </td>
            <td><code>{policy.pattern}</code></td>
            <td>
              <span class="action-badge action-{policy.action}">{policy.action}</span>
            </td>
            <td>
              {#if policy.scope === "user" && policy.userId}
                <span class="scope-badge">
                  user:{usernameById.get(policy.userId) ?? policy.userId.slice(0, 8)}
                </span>
              {:else}
                <span class="scope-badge">{policy.scope}</span>
              {/if}
            </td>
            <td class="muted">{policy.description ?? "-"}</td>
            <td class="actions">
              <button class="btn-small" onclick={() => startEdit(policy)}>Edit</button>
              <button class="btn-small btn-danger" onclick={() => deletePolicy(policy.id)}>Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<Modal title={editingId ? "Edit Policy" : "Add Policy"} open={showForm} onclose={() => { showForm = false; resetForm(); }}>
  <form onsubmit={(e) => { e.preventDefault(); save(); }}>
    <label class="field">
      <span>Type</span>
      <select bind:value={form.type}>
        {#each Object.entries(typeLabels) as [type, label]}
          <option value={type}>{label}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>Pattern</span>
      <input type="text" bind:value={form.pattern} required placeholder={typePlaceholders[form.type] ?? ""} />
    </label>
    <label class="field">
      <span>Action</span>
      <select bind:value={form.action}>
        <option value="block">Block</option>
        <option value="warn">Warn</option>
      </select>
    </label>
    <label class="field">
      <span>Scope</span>
      <select bind:value={form.scope}>
        <option value="global">Global (all users)</option>
        <option value="user">Per User</option>
      </select>
    </label>
    {#if form.scope === "user"}
      <label class="field">
        <span>User</span>
        {#if users.length > 0}
          <select bind:value={form.userId} required>
            <option value="" disabled>Select user...</option>
            {#each users as user}
              <option value={user.id}>{user.username}</option>
            {/each}
          </select>
        {:else}
          <input type="text" bind:value={form.userId} required placeholder="User ID" />
        {/if}
      </label>
    {/if}
    <label class="field">
      <span>Description (optional)</span>
      <input type="text" bind:value={form.description} placeholder="Why this rule exists" />
    </label>
    <button type="submit" class="btn-primary">{editingId ? "Update" : "Create"}</button>
  </form>
</Modal>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 6px 14px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: var(--font-size-sm); display: flex; align-items: center; gap: 6px; }
  .tab:hover { background: var(--bg-hover); }
  .tab.active { background: var(--bg-active); color: var(--text-primary); }
  .tab-count { background: var(--bg-base); padding: 1px 6px; border-radius: 8px; font-size: 11px; }
  .help-text { color: var(--text-muted); font-size: var(--font-size-sm); margin-bottom: 16px; }
  .empty { color: var(--text-muted); text-align: center; padding: 40px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  .table th { color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500; }
  .table code { font-family: var(--font-mono); font-size: var(--font-size-sm); background: var(--bg-base); padding: 2px 6px; border-radius: 2px; }
  .table tr.disabled { opacity: 0.5; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }
  .action-badge { padding: 2px 8px; border-radius: 10px; font-size: var(--font-size-sm); }
  .action-block { color: var(--status-failed); background: rgba(244, 71, 71, 0.1); }
  .action-warn { color: var(--status-queued); background: rgba(226, 185, 61, 0.1); }
  .scope-badge { padding: 2px 8px; border-radius: 10px; font-size: var(--font-size-sm); background: var(--bg-active); }
  .actions { display: flex; gap: 6px; }
  .btn-primary { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { color: var(--status-failed); }
  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 4px; }
  .field input, .field select { width: 100%; }
</style>
