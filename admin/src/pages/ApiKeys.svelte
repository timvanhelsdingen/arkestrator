<script lang="ts">
  import { onMount } from "svelte";
  import { api, type AdminApiKey, type AdminApiKeyCreateResponse, type AdminUserPermissions } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface KeyPermissions {
    manageUsers: boolean;
    manageAgents: boolean;
    manageProjects: boolean;
    managePolicies: boolean;
    manageApiKeys: boolean;
    manageConnections: boolean;
    manageWorkers: boolean;
    manageSecurity: boolean;
    viewAuditLog: boolean;
    viewUsage: boolean;
    editCoordinator: boolean;
    useMcp: boolean;
    interveneJobs: boolean;
    executeCommands: boolean;
    deliverFiles: boolean;
    submitJobs: boolean;
  }

  const permissionDefs: Array<{ key: keyof KeyPermissions; label: string; short: string }> = [
    { key: "manageUsers", label: "Manage users", short: "Users" },
    { key: "manageAgents", label: "Manage agents", short: "Agents" },
    { key: "manageProjects", label: "Manage projects", short: "Projects" },
    { key: "managePolicies", label: "Manage policies / filters", short: "Policies" },
    { key: "manageApiKeys", label: "Manage API keys", short: "Keys" },
    { key: "manageConnections", label: "Manage live connections", short: "Connections" },
    { key: "manageWorkers", label: "Manage workers", short: "Workers" },
    { key: "manageSecurity", label: "Manage security settings", short: "Security" },
    { key: "viewAuditLog", label: "View audit logs", short: "Audit" },
    { key: "viewUsage", label: "View token usage", short: "Usage" },
    { key: "editCoordinator", label: "Edit coordinator files", short: "Coordinator" },
    { key: "useMcp", label: "Use MCP server", short: "MCP" },
    { key: "interveneJobs", label: "Guide running jobs", short: "Guide" },
    { key: "executeCommands", label: "Execute bridge commands", short: "Commands" },
    { key: "deliverFiles", label: "Deliver files to bridges/clients", short: "Deliver" },
    { key: "submitJobs", label: "Submit jobs", short: "Submit" },
  ];

  const permissionLabels: Record<keyof KeyPermissions, string> = {
    manageUsers: "Manage users",
    manageAgents: "Manage agents",
    manageProjects: "Manage projects",
    managePolicies: "Manage policies / filters",
    manageApiKeys: "Manage API keys",
    manageConnections: "Manage live connections",
    manageWorkers: "Manage workers",
    manageSecurity: "Manage security settings",
    viewAuditLog: "View audit logs",
    viewUsage: "View token usage",
    editCoordinator: "Edit coordinator files",
    useMcp: "Use MCP server",
    interveneJobs: "Guide running jobs",
    executeCommands: "Execute bridge commands",
    deliverFiles: "Deliver files to bridges/clients",
    submitJobs: "Submit jobs",
  };

  const permissionGroups: Array<{
    title: string;
    hint: string;
    keys: Array<keyof KeyPermissions>;
  }> = [
    {
      title: "Administration",
      hint: "User, policy, key, and security controls.",
      keys: ["manageUsers", "managePolicies", "manageApiKeys", "manageSecurity"],
    },
    {
      title: "Operations",
      hint: "Agents, projects, workers, live connections, and bridge operations.",
      keys: ["manageAgents", "manageProjects", "manageWorkers", "manageConnections", "executeCommands", "deliverFiles", "submitJobs"],
    },
    {
      title: "Observability & Coordinator",
      hint: "Audit/usage visibility, coordinator editing, and MCP access.",
      keys: ["viewAuditLog", "viewUsage", "editCoordinator", "useMcp", "interveneJobs"],
    },
  ];

  const defaultPermissions: KeyPermissions = {
    manageUsers: false,
    manageAgents: false,
    manageProjects: false,
    managePolicies: false,
    manageApiKeys: false,
    manageConnections: false,
    manageWorkers: false,
    manageSecurity: false,
    viewAuditLog: false,
    viewUsage: false,
    editCoordinator: false,
    useMcp: false,
    interveneJobs: false,
    executeCommands: false,
    deliverFiles: false,
    submitJobs: false,
  };

  function roleDefaults(role: string): KeyPermissions {
    if (role === "admin") {
      const out: KeyPermissions = { ...defaultPermissions };
      for (const def of permissionDefs) out[def.key] = true;
      return out;
    }
    if (role === "client") {
      return {
        ...defaultPermissions,
        executeCommands: true,
        deliverFiles: true,
        submitJobs: true,
        useMcp: true,
        interveneJobs: true,
      };
    }
    if (role === "mcp") {
      return {
        ...defaultPermissions,
        useMcp: true,
        executeCommands: true,
        deliverFiles: true,
        submitJobs: true,
        interveneJobs: true,
      };
    }
    // bridge
    return {
      ...defaultPermissions,
      executeCommands: true,
    };
  }

  function normalizePermissions(value: any): KeyPermissions {
    const out: KeyPermissions = { ...defaultPermissions };
    for (const def of permissionDefs) {
      out[def.key] = value?.[def.key] === true;
    }
    return out;
  }

  function permissionsEqual(a: KeyPermissions, b: KeyPermissions): boolean {
    for (const def of permissionDefs) {
      if (a[def.key] !== b[def.key]) return false;
    }
    return true;
  }

  function countEnabledPermissions(permissions: KeyPermissions): number {
    let count = 0;
    for (const def of permissionDefs) {
      if (permissions[def.key]) count++;
    }
    return count;
  }

  function enabledPermissionShorts(permissions: KeyPermissions): string[] {
    const out: string[] = [];
    for (const def of permissionDefs) {
      if (permissions[def.key]) out.push(def.short);
    }
    return out;
  }

  function permissionPreview(permissions: KeyPermissions): string {
    const enabled = enabledPermissionShorts(permissions);
    if (enabled.length === 0) return "No access";
    if (enabled.length <= 2) return enabled.join(", ");
    return `${enabled.slice(0, 2).join(", ")} +${enabled.length - 2}`;
  }

  let keys = $state<(AdminApiKey & { _permissions: KeyPermissions })[]>([]);
  let loading = $state(false);
  let creating = $state(false);
  let expandedAccessKeyIds = $state<string[]>([]);

  let name = $state("");
  let role = $state<"bridge" | "client" | "admin" | "mcp">("client");
  let newPermissions = $state<KeyPermissions>(roleDefaults("client"));

  let createdKey = $state<AdminApiKeyCreateResponse | null>(null);

  let showEditPerms = $state<(AdminApiKey & { _permissions: KeyPermissions }) | null>(null);
  let editPermissions = $state<KeyPermissions>({ ...defaultPermissions });

  async function load() {
    loading = true;
    try {
      const raw = await api.keys.list();
      keys = raw.map((k) => ({
        ...k,
        _permissions: normalizePermissions(k.permissions),
      }));
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load API keys");
    } finally {
      loading = false;
    }
  }

  function applyRoleDefaultsForCreate() {
    newPermissions = roleDefaults(role);
  }

  async function createKey() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }

    creating = true;
    try {
      createdKey = await api.keys.create(trimmed, role, newPermissions as AdminUserPermissions);
      name = "";
      role = "client";
      newPermissions = roleDefaults("client");
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

  function openEditPerms(key: (AdminApiKey & { _permissions: KeyPermissions })) {
    showEditPerms = key;
    editPermissions = { ...key._permissions };
  }

  async function saveEditPerms() {
    if (!showEditPerms) return;
    const target = showEditPerms;
    try {
      if (!permissionsEqual(editPermissions, target._permissions)) {
        await api.keys.updatePermissions(target.id, editPermissions as AdminUserPermissions);
      }
      toast.success("Key permissions updated");
      showEditPerms = null;
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update permissions");
    }
  }

  function isAccessExpanded(keyId: string): boolean {
    return expandedAccessKeyIds.includes(keyId);
  }

  function toggleAccess(keyId: string) {
    if (isAccessExpanded(keyId)) {
      expandedAccessKeyIds = expandedAccessKeyIds.filter((id) => id !== keyId);
      return;
    }
    expandedAccessKeyIds = [...expandedAccessKeyIds, keyId];
  }

  async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch { /* secure-context only; fall through */ }
    }
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

  function roleHelp(current: "bridge" | "client" | "admin" | "mcp"): string {
    if (current === "client") return "Client UI websocket + job submission";
    if (current === "admin") return "Full admin-level API access";
    if (current === "mcp") return "MCP access for external AI agents (Claude, etc.)";
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
        <select bind:value={role} onchange={applyRoleDefaultsForCreate}>
          <option value="client">client</option>
          <option value="mcp">mcp</option>
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

    <div class="field perm-field">
      <span>Permissions</span>
      <div class="permission-groups">
        {#each permissionGroups as group}
          <fieldset class="permission-group">
            <legend>{group.title}</legend>
            <p class="group-hint">{group.hint}</p>
            <div class="permission-list">
              {#each group.keys as key}
                <label class="check-row check-row-card">
                  <input
                    type="checkbox"
                    checked={newPermissions[key]}
                    onchange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      newPermissions = { ...newPermissions, [key]: checked };
                    }}
                  />
                  <span>{permissionLabels[key]}</span>
                </label>
              {/each}
            </div>
          </fieldset>
        {/each}
      </div>
    </div>
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
          <th>Access</th>
          <th>Created</th>
          <th>Id</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          <tr><td colspan="6" class="muted">Loading keys...</td></tr>
        {:else if keys.length === 0}
          <tr><td colspan="6" class="muted">No active API keys.</td></tr>
        {:else}
          {#each keys as key}
            <tr>
              <td>{key.name}</td>
              <td>
                <span class="role role-{key.role}">{key.role}</span>
              </td>
              <td>
                {#if countEnabledPermissions(key._permissions) === 0}
                  <span class="muted">None</span>
                {:else}
                  <div class="access-summary">
                    <button
                      class="access-toggle"
                      type="button"
                      aria-expanded={isAccessExpanded(key.id)}
                      onclick={() => toggleAccess(key.id)}
                    >
                      <span class="access-count">{countEnabledPermissions(key._permissions)} access</span>
                      <span class="access-preview">{permissionPreview(key._permissions)}</span>
                      <span class:access-caret-open={isAccessExpanded(key.id)} class="access-caret">▾</span>
                    </button>
                    {#if isAccessExpanded(key.id)}
                      <div class="permission-chips access-panel">
                        {#each permissionDefs as def}
                          {#if key._permissions[def.key]}
                            <span class="chip">{def.short}</span>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </td>
              <td class="muted">{new Date(key.createdAt).toLocaleString()}</td>
              <td><code>{key.id}</code></td>
              <td class="actions">
                <button class="btn-small" type="button" onclick={() => openEditPerms(key)}>Edit</button>
                <button class="btn-small btn-danger" onclick={() => revokeKey(key)}>Revoke</button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<Modal title="Edit Key Permissions" open={showEditPerms !== null} onclose={() => (showEditPerms = null)}>
  <form onsubmit={(e) => { e.preventDefault(); saveEditPerms(); }}>
    {#if showEditPerms}
      <p class="hint">Editing permissions for <strong>{showEditPerms.name}</strong> ({showEditPerms.role})</p>
    {/if}
    <div class="field">
      <span>Capabilities</span>
      <div class="permission-groups">
        {#each permissionGroups as group}
          <fieldset class="permission-group">
            <legend>{group.title}</legend>
            <p class="group-hint">{group.hint}</p>
            <div class="permission-list">
              {#each group.keys as key}
                <label class="check-row check-row-card">
                  <input
                    type="checkbox"
                    checked={editPermissions[key]}
                    onchange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      editPermissions = { ...editPermissions, [key]: checked };
                    }}
                  />
                  <span>{permissionLabels[key]}</span>
                </label>
              {/each}
            </div>
          </fieldset>
        {/each}
      </div>
    </div>
    <button type="submit" class="btn-primary">Save</button>
  </form>
</Modal>

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
  .perm-field { margin-top: 14px; }

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

  .access-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .access-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    text-align: left;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .access-toggle:hover {
    background: var(--bg-hover);
    border-color: var(--border-focus);
    color: var(--text-primary);
  }
  .access-count {
    color: var(--text-primary);
    font-size: 11px;
    white-space: nowrap;
  }
  .access-preview {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .access-caret {
    flex: 0 0 auto;
    color: var(--text-muted);
    transition: transform 120ms ease;
  }
  .access-caret-open {
    transform: rotate(180deg);
  }
  .permission-chips { display: flex; gap: 6px; flex-wrap: wrap; min-height: 22px; align-items: center; }
  .access-panel {
    padding: 2px 0 0;
  }
  .chip {
    font-size: 11px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    padding: 2px 8px;
    border-radius: 999px;
  }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .permission-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    margin-top: 8px;
  }
  .permission-group {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    min-width: 0;
  }
  .permission-group legend {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-weight: 600;
    padding: 0 4px;
  }
  .group-hint {
    margin: 0 0 10px;
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .permission-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
  }
  .check-row input {
    width: auto;
    flex: 0 0 auto;
  }
  .check-row-card {
    margin: 0;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    transition: background 120ms ease, border-color 120ms ease;
  }
  .check-row-card:hover {
    background: var(--bg-hover);
    border-color: var(--border-focus);
  }
  .check-row span { margin: 0; }

  .hint { color: var(--text-muted); font-size: var(--font-size-sm); margin-bottom: 14px; }

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
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { color: var(--status-failed); }

  @media (max-width: 900px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
