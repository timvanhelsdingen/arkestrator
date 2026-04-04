<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, type UserInsightsResponse } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface UserPermissions {
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
    executeLocal: boolean;
    deliverFiles: boolean;
    submitJobs: boolean;
  }

  interface User {
    id: string;
    username: string;
    role: string;
    permissions: UserPermissions;
    require2fa: boolean;
    totpEnabled: boolean;
    clientCoordinationEnabled: boolean;
    createdAt: string;
    tokenLimitInput: number | null;
    tokenLimitOutput: number | null;
    tokenLimitPeriod: string;
  }

  const permissionDefs: Array<{ key: keyof UserPermissions; label: string; short: string }> = [
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
    { key: "executeLocal", label: "Execute local commands", short: "EL" },
    { key: "deliverFiles", label: "Deliver files to bridges/clients", short: "Deliver" },
    { key: "submitJobs", label: "Submit jobs", short: "Submit" },
  ];

  const permissionLabels: Record<keyof UserPermissions, string> = {
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
    executeLocal: "Execute local commands",
    deliverFiles: "Deliver files to bridges/clients",
    submitJobs: "Submit jobs",
  };

  const permissionGroups: Array<{
    title: string;
    hint: string;
    keys: Array<keyof UserPermissions>;
  }> = [
    {
      title: "Administration",
      hint: "User, policy, key, and security controls.",
      keys: ["manageUsers", "managePolicies", "manageApiKeys", "manageSecurity"],
    },
    {
      title: "Operations",
      hint: "Agents, projects, workers, live connections, and bridge operations.",
      keys: ["manageAgents", "manageProjects", "manageWorkers", "manageConnections", "executeCommands", "executeLocal", "deliverFiles", "submitJobs"],
    },
    {
      title: "Observability & Coordinator",
      hint: "Audit/usage visibility, coordinator editing, and MCP access.",
      keys: ["viewAuditLog", "viewUsage", "editCoordinator", "useMcp", "interveneJobs"],
    },
  ];

  const defaultPermissions: UserPermissions = {
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
    executeLocal: false,
    deliverFiles: false,
    submitJobs: false,
  };

  let users = $state<User[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let searchQuery = $state("");
  let expandedAccessUserIds = $state<string[]>([]);

  let showCreate = $state(false);
  let showEdit = $state<User | null>(null);
  let showResetPw = $state<string | null>(null);
  let showDeleteConfirm = $state<{ id: string; username: string } | null>(null);
  let deletePassword = $state("");
  let deleteError = $state("");
  let deleting = $state(false);
  let selectedInsightUserId = $state<string | null>(null);
  let insightsLoading = $state(false);
  let insightsError = $state<string | null>(null);
  let insights = $state<UserInsightsResponse | null>(null);

  let newUsername = $state("");
  let newPassword = $state("");
  let newConfirmPassword = $state("");
  let generatedPassword = $state("");
  let newRole = $state("user");
  let newRequire2fa = $state(false);
  let newClientCoordinationEnabled = $state(false);
  let newPermissions = $state<UserPermissions>({ ...defaultPermissions });

  let editRequire2fa = $state(false);
  let editClientCoordinationEnabled = $state(false);
  let editPermissions = $state<UserPermissions>({ ...defaultPermissions });
  let editRole = $state("user");
  let editLimitInput = $state("");
  let editLimitOutput = $state("");
  let editLimitPeriod = $state("monthly");

  let resetOldPw = $state("");
  let resetPw = $state("");
  let resetConfirmPw = $state("");

  function normalizePermissions(value: any): UserPermissions {
    const out: UserPermissions = { ...defaultPermissions };
    for (const def of permissionDefs) {
      out[def.key] = value?.[def.key] === true;
    }
    return out;
  }

  function normalizeUser(value: any): User {
    return {
      id: String(value?.id ?? ""),
      username: String(value?.username ?? ""),
      role: String(value?.role ?? "user"),
      permissions: normalizePermissions(value?.permissions),
      require2fa: value?.require2fa === true,
      totpEnabled: value?.totpEnabled === true,
      clientCoordinationEnabled: value?.clientCoordinationEnabled === true,
      createdAt: String(value?.createdAt ?? new Date().toISOString()),
      tokenLimitInput: typeof value?.tokenLimitInput === "number" ? value.tokenLimitInput : null,
      tokenLimitOutput: typeof value?.tokenLimitOutput === "number" ? value.tokenLimitOutput : null,
      tokenLimitPeriod: String(value?.tokenLimitPeriod ?? "monthly"),
    };
  }

  function roleDefaults(role: string): UserPermissions {
    if (role === "admin") {
      const out: UserPermissions = { ...defaultPermissions };
      for (const def of permissionDefs) out[def.key] = true;
      return out;
    }
    if (role === "user") {
      return {
        ...defaultPermissions,
        manageAgents: true,
        manageProjects: true,
        manageConnections: true,
        viewUsage: true,
        interveneJobs: true,
        executeCommands: true,
        deliverFiles: true,
        submitJobs: true,
      };
    }
    // viewer: read-only access
    return {
      ...defaultPermissions,
      viewAuditLog: true,
      viewUsage: true,
    };
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const result = await api.users.list();
      const rows = Array.isArray(result)
        ? result
        : (Array.isArray((result as any)?.users) ? (result as any).users : null);
      if (!rows) throw new Error("Invalid users response");
      users = rows.map(normalizeUser);
      if (selectedInsightUserId && !users.some((user) => user.id === selectedInsightUserId)) {
        selectedInsightUserId = null;
        insights = null;
        insightsError = null;
      }
    } catch (err: any) {
      users = [];
      const message = err.message ?? "Failed to load users";
      loadError = message;
      toast.error(message);
    } finally {
      loading = false;
    }
  }

  function generateRandomPassword(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join("");
  }

  async function createUser() {
    if (newPassword !== newConfirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    try {
      await api.users.create(
        newUsername,
        newPassword,
        newRole,
        newPermissions,
        {
          require2fa: newRequire2fa,
          clientCoordinationEnabled: newClientCoordinationEnabled,
        },
      );
      toast.success(`User "${newUsername}" created`);
      showCreate = false;
      newUsername = "";
      newPassword = "";
      newConfirmPassword = "";
      generatedPassword = "";
      newRole = "user";
      newRequire2fa = false;
      newClientCoordinationEnabled = false;
      newPermissions = roleDefaults("user");
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function openEdit(user: User) {
    showEdit = user;
    editRole = user.role;
    editRequire2fa = user.require2fa;
    editClientCoordinationEnabled = user.clientCoordinationEnabled;
    editPermissions = { ...user.permissions };
    editLimitInput = user.tokenLimitInput != null ? String(user.tokenLimitInput) : "";
    editLimitOutput = user.tokenLimitOutput != null ? String(user.tokenLimitOutput) : "";
    editLimitPeriod = user.tokenLimitPeriod ?? "monthly";
  }

  function parseTokenLimitInput(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("Token limits must be whole numbers >= 0");
    }
    return parsed;
  }

  function permissionsEqual(a: UserPermissions, b: UserPermissions): boolean {
    for (const def of permissionDefs) {
      if (a[def.key] !== b[def.key]) return false;
    }
    return true;
  }

  async function saveEdit() {
    if (!showEdit) return;
    const target = showEdit;
    try {
      const nextInputLimit = parseTokenLimitInput(editLimitInput);
      const nextOutputLimit = parseTokenLimitInput(editLimitOutput);

      if (editRole !== target.role) {
        await api.users.updateRole(target.id, editRole);
      }
      if (!permissionsEqual(editPermissions, target.permissions)) {
        await api.users.updatePermissions(target.id, editPermissions);
      }
      if (
        editRequire2fa !== target.require2fa
        || editClientCoordinationEnabled !== target.clientCoordinationEnabled
      ) {
        await api.users.updateSettings(target.id, {
          require2fa: editRequire2fa,
          clientCoordinationEnabled: editClientCoordinationEnabled,
        });
      }
      if (
        nextInputLimit !== target.tokenLimitInput
        || nextOutputLimit !== target.tokenLimitOutput
        || editLimitPeriod !== target.tokenLimitPeriod
      ) {
        await api.users.setLimits(target.id, {
          inputLimit: nextInputLimit,
          outputLimit: nextOutputLimit,
          period: editLimitPeriod,
        });
      }

      toast.success("User updated");
      showEdit = null;
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function resetPassword() {
    if (!showResetPw) return;
    if (resetPw !== resetConfirmPw) {
      toast.error("New password and confirmation do not match");
      return;
    }
    try {
      await api.users.resetPassword(showResetPw, resetOldPw, resetPw, resetConfirmPw);
      toast.success("Password reset");
      showResetPw = null;
      resetOldPw = "";
      resetPw = "";
      resetConfirmPw = "";
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function promptDeleteUser(id: string, username: string) {
    showDeleteConfirm = { id, username };
    deletePassword = "";
    deleteError = "";
  }

  async function confirmDeleteUser() {
    if (!showDeleteConfirm) return;
    if (!deletePassword) {
      deleteError = "Password is required";
      return;
    }
    deleteError = "";
    deleting = true;
    try {
      await api.users.delete(showDeleteConfirm.id, deletePassword);
      toast.success(`User "${showDeleteConfirm.username}" deleted`);
      showDeleteConfirm = null;
      deletePassword = "";
      await load();
    } catch (err: any) {
      deleteError = err.message || "Failed to delete user";
    } finally {
      deleting = false;
    }
  }

  function formatLimit(val: number | null): string {
    if (val == null) return "Unlimited";
    return val.toLocaleString();
  }

  function countEnabledPermissions(permissions: UserPermissions): number {
    let count = 0;
    for (const def of permissionDefs) {
      if (permissions[def.key]) count++;
    }
    return count;
  }

  function isAccessExpanded(userId: string): boolean {
    return expandedAccessUserIds.includes(userId);
  }

  function toggleAccess(userId: string) {
    if (isAccessExpanded(userId)) {
      expandedAccessUserIds = expandedAccessUserIds.filter((id) => id !== userId);
      return;
    }
    expandedAccessUserIds = [...expandedAccessUserIds, userId];
  }

  function enabledPermissionShorts(permissions: UserPermissions): string[] {
    const out: string[] = [];
    for (const def of permissionDefs) {
      if (permissions[def.key]) out.push(def.short);
    }
    return out;
  }

  function permissionPreview(permissions: UserPermissions): string {
    const enabled = enabledPermissionShorts(permissions);
    if (enabled.length === 0) return "No access";
    if (enabled.length <= 2) return enabled.join(", ");
    return `${enabled.slice(0, 2).join(", ")} +${enabled.length - 2}`;
  }

  function applyRoleDefaultsForCreate() {
    newPermissions = roleDefaults(newRole);
  }

  let filteredUsers = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) =>
      user.username.toLowerCase().includes(query)
      || user.role.toLowerCase().includes(query)
      || user.id.toLowerCase().includes(query)
    );
  });

  function formatTokenCount(value: number): string {
    return value.toLocaleString();
  }

  const selectedInsightUser = $derived.by(
    () => users.find((user) => user.id === selectedInsightUserId) ?? null,
  );

  function updateInsightsQueryParam(userId: string | null) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (userId) {
      url.searchParams.set("user", userId);
    } else {
      url.searchParams.delete("user");
    }
    history.replaceState({}, "", url.toString());
  }

  async function openInsights(user: User, opts?: { scroll?: boolean; updateUrl?: boolean }) {
    const shouldScroll = opts?.scroll ?? true;
    const shouldUpdateUrl = opts?.updateUrl ?? true;
    selectedInsightUserId = user.id;
    if (shouldUpdateUrl) updateInsightsQueryParam(user.id);
    if (shouldScroll) {
      await tick();
      document.getElementById("user-insights-panel")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
    insights = null;
    insightsError = null;
    insightsLoading = true;
    try {
      insights = await api.users.insights(user.id, 30);
    } catch (err: any) {
      const message = String(err?.message ?? "Failed to load user insights");
      insightsError = message.includes("404")
        ? "Insights endpoint not found on this server. Update the server image to a build that includes /api/users/:id/insights."
        : message;
    } finally {
      insightsLoading = false;
    }
  }

  function closeInsights() {
    selectedInsightUserId = null;
    insights = null;
    insightsError = null;
    updateInsightsQueryParam(null);
  }

  onMount(async () => {
    applyRoleDefaultsForCreate();
    await load();
    const params = new URLSearchParams(window.location.search);
    const requestedUserId = params.get("user");
    if (!requestedUserId) return;
    const user = users.find((entry) => entry.id === requestedUserId);
    if (user) {
      await openInsights(user, { scroll: false, updateUrl: false });
    } else {
      updateInsightsQueryParam(null);
    }
  });
</script>

<div class="page">
  <div class="toolbar">
    <input
      class="search-input"
      type="search"
      bind:value={searchQuery}
      placeholder="Search users (name, role, id)"
    />
    <button class="btn-secondary" onclick={load} disabled={loading}>Refresh</button>
    <button class="btn-primary" onclick={() => (showCreate = true)}>Create User</button>
  </div>

  {#if loadError}
    <div class="error-banner">
      <strong>Failed to load users:</strong> {loadError}
    </div>
  {/if}

  <table class="table">
    <thead>
      <tr>
        <th>Username</th>
        <th>Role</th>
        <th>Access</th>
        <th>2FA Required</th>
        <th>2FA Enabled</th>
        <th>Client Coord</th>
        <th>Input Limit</th>
        <th>Output Limit</th>
        <th>Period</th>
        <th>Created</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr>
          <td colspan="11" class="muted">Loading users...</td>
        </tr>
      {:else if filteredUsers.length === 0}
        <tr>
          <td colspan="11" class="muted">No users matched your search.</td>
        </tr>
      {:else}
        {#each filteredUsers as user}
          <tr>
            <td>
              <button class="link-button" type="button" onclick={() => openInsights(user)}>
                {user.username}
              </button>
            </td>
            <td>
              <span class="muted role-pill">{user.role}</span>
            </td>
            <td>
              {#if countEnabledPermissions(user.permissions) === 0}
                <span class="muted">None</span>
              {:else}
                <div class="access-summary">
                  <button
                    class="access-toggle"
                    type="button"
                    aria-expanded={isAccessExpanded(user.id)}
                    onclick={() => toggleAccess(user.id)}
                  >
                    <span class="access-count">{countEnabledPermissions(user.permissions)} access</span>
                    <span class="access-preview">{permissionPreview(user.permissions)}</span>
                    <span class:access-caret-open={isAccessExpanded(user.id)} class="access-caret">▾</span>
                  </button>
                  {#if isAccessExpanded(user.id)}
                    <div class="permission-chips access-panel">
                      {#each permissionDefs as def}
                        {#if user.permissions[def.key]}
                          <span class="chip">{def.short}</span>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </td>
            <td class="muted">{user.require2fa ? "Yes" : "No"}</td>
            <td class="muted">{user.totpEnabled ? "Yes" : "No"}</td>
            <td class="muted">{user.clientCoordinationEnabled ? "Yes" : "No"}</td>
            <td class="muted">{formatLimit(user.tokenLimitInput)}</td>
            <td class="muted">{formatLimit(user.tokenLimitOutput)}</td>
            <td class="muted">{user.tokenLimitPeriod ?? "monthly"}</td>
            <td class="muted">{new Date(user.createdAt).toLocaleDateString()}</td>
            <td class="actions">
              <button class="btn-small" type="button" onclick={() => openInsights(user)}>View</button>
              <button class="btn-small" type="button" onclick={() => openEdit(user)}>Edit</button>
              <button class="btn-small" type="button" onclick={() => { showResetPw = user.id; resetOldPw = ""; resetPw = ""; resetConfirmPw = ""; }}>Reset PW</button>
              <button class="btn-small btn-danger" type="button" onclick={() => promptDeleteUser(user.id, user.username)}>Delete</button>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>

  {#if selectedInsightUser}
    <section class="insights-panel" id="user-insights-panel">
      <div class="insights-header">
        <h3>User Details: {selectedInsightUser.username}</h3>
        <div class="insights-actions">
          <button class="btn-small" type="button" onclick={() => openInsights(selectedInsightUser, { scroll: false })} disabled={insightsLoading}>
            {insightsLoading ? "Refreshing..." : "Refresh"}
          </button>
          <button class="btn-small" type="button" onclick={closeInsights}>Close</button>
        </div>
      </div>

      {#if insightsLoading}
        <p class="hint">Loading usage and recent jobs...</p>
      {:else if insightsError}
        <p class="error-text">{insightsError}</p>
      {:else if insights}
        <div class="insights-grid">
          <div class="insight-card">
            <div class="insight-label">Today</div>
            <div class="insight-value">{formatTokenCount(insights.usage.daily.totalInput)} in / {formatTokenCount(insights.usage.daily.totalOutput)} out</div>
            <div class="insight-sub">{insights.usage.daily.jobCount} jobs</div>
          </div>
          <div class="insight-card">
            <div class="insight-label">This Month</div>
            <div class="insight-value">{formatTokenCount(insights.usage.monthly.totalInput)} in / {formatTokenCount(insights.usage.monthly.totalOutput)} out</div>
            <div class="insight-sub">{insights.usage.monthly.jobCount} jobs</div>
          </div>
          <div class="insight-card">
            <div class="insight-label">All Time</div>
            <div class="insight-value">{formatTokenCount(insights.usage.allTime.totalInput)} in / {formatTokenCount(insights.usage.allTime.totalOutput)} out</div>
            <div class="insight-sub">{insights.usage.allTime.jobCount} jobs</div>
          </div>
        </div>

        <div class="insight-statuses">
          <span>Total: {insights.jobs.counts.total}</span>
          <span>Queued: {insights.jobs.counts.queued}</span>
          <span>Running: {insights.jobs.counts.running}</span>
          <span>Paused: {insights.jobs.counts.paused}</span>
          <span>Completed: {insights.jobs.counts.completed}</span>
          <span>Failed: {insights.jobs.counts.failed}</span>
          <span>Cancelled: {insights.jobs.counts.cancelled}</span>
        </div>

        <div class="insight-jobs">
          <h4>Recent Jobs</h4>
          {#if insights.jobs.recent.length === 0}
            <p class="muted">No jobs submitted by this user yet.</p>
          {:else}
            <table class="table insight-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Program</th>
                  <th>Tokens</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {#each insights.jobs.recent as job}
                  <tr>
                    <td class="mono">#{job.id.slice(0, 8)}</td>
                    <td>{job.status}</td>
                    <td>{job.bridgeProgram ?? "n/a"}</td>
                    <td class="muted">
                      {#if job.tokenUsage}
                        {formatTokenCount(job.tokenUsage.inputTokens)} in / {formatTokenCount(job.tokenUsage.outputTokens)} out
                      {:else}
                        0 in / 0 out
                      {/if}
                    </td>
                    <td class="muted">{new Date(job.createdAt).toLocaleString()}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {:else}
        <p class="hint">No insight data loaded.</p>
      {/if}
    </section>
  {/if}
</div>

<Modal title="Create User" open={showCreate} onclose={() => { showCreate = false; generatedPassword = ""; }}>
  <form onsubmit={(e) => { e.preventDefault(); createUser(); }}>
    <label class="field">
      <span>Username</span>
      <input type="text" bind:value={newUsername} required />
    </label>
    <label class="field">
      <span>Password</span>
      <input type="password" bind:value={newPassword} required />
    </label>
    <label class="field">
      <span>Confirm Password</span>
      <input type="password" bind:value={newConfirmPassword} required />
    </label>
    <div class="field">
      <button type="button" class="btn-small" onclick={() => { const pw = generateRandomPassword(); newPassword = pw; newConfirmPassword = pw; generatedPassword = pw; }}>Generate Random Password</button>
      {#if generatedPassword}
        <div class="generated-pw">
          <code>{generatedPassword}</code>
          <button type="button" class="btn-small" onclick={() => { navigator.clipboard.writeText(generatedPassword); toast.success("Password copied to clipboard"); }}>Copy</button>
        </div>
      {/if}
    </div>
    <label class="field">
      <span>Role</span>
      <select bind:value={newRole} onchange={applyRoleDefaultsForCreate}>
        <option value="admin">Admin</option>
        <option value="user">User</option>
        <option value="viewer">Viewer</option>
      </select>
    </label>
    <div class="field">
      <span>Security Defaults</span>
      <label class="check-row">
        <input type="checkbox" bind:checked={newRequire2fa} />
        <span>Require 2FA on this account</span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={newClientCoordinationEnabled} />
        <span>Allow client-side coordination for this user</span>
      </label>
    </div>
    <div class="field">
      <span>Initial Access</span>
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
    <button type="submit" class="btn-primary">Create</button>
  </form>
</Modal>

<Modal title="Edit User" open={showEdit !== null} onclose={() => (showEdit = null)}>
  <form onsubmit={(e) => { e.preventDefault(); saveEdit(); }}>
    {#if showEdit}
      <p class="hint">Editing <strong>{showEdit.username}</strong></p>
    {/if}
    <label class="field">
      <span>Role</span>
      <select bind:value={editRole}>
        <option value="admin">Admin</option>
        <option value="user">User</option>
        <option value="viewer">Viewer</option>
      </select>
    </label>
    <div class="field">
      <span>Per-user security</span>
      <label class="check-row">
        <input type="checkbox" bind:checked={editRequire2fa} />
        <span>Require 2FA for this account</span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={editClientCoordinationEnabled} />
        <span>Allow client-side coordination for this account</span>
      </label>
    </div>
    <div class="field">
      <span>Token Limits</span>
      <p class="hint">Leave empty for unlimited. Values are token counts.</p>
      <label class="field">
        <span>Input Token Limit</span>
        <input type="number" bind:value={editLimitInput} placeholder="Unlimited" min="0" />
      </label>
      <label class="field">
        <span>Output Token Limit</span>
        <input type="number" bind:value={editLimitOutput} placeholder="Unlimited" min="0" />
      </label>
      <label class="field">
        <span>Period</span>
        <select bind:value={editLimitPeriod}>
          <option value="daily">Daily</option>
          <option value="monthly">Monthly</option>
          <option value="unlimited">Lifetime (no reset)</option>
        </select>
      </label>
    </div>
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

<Modal title="Reset Password" open={showResetPw !== null} onclose={() => (showResetPw = null)}>
  <form onsubmit={(e) => { e.preventDefault(); resetPassword(); }}>
    <label class="field">
      <span>Old Password</span>
      <input type="password" bind:value={resetOldPw} required />
    </label>
    <label class="field">
      <span>New Password</span>
      <input type="password" bind:value={resetPw} required />
    </label>
    <label class="field">
      <span>Confirm New Password</span>
      <input type="password" bind:value={resetConfirmPw} required />
    </label>
    <button type="submit" class="btn-primary">Reset</button>
  </form>
</Modal>

<Modal title="Delete User" open={showDeleteConfirm !== null} onclose={() => (showDeleteConfirm = null)}>
  <form onsubmit={(e) => { e.preventDefault(); confirmDeleteUser(); }}>
    <p class="delete-warning">
      Are you sure you want to permanently delete user <strong>{showDeleteConfirm?.username}</strong>? This action cannot be undone.
    </p>
    <label class="field">
      <span>Enter your password to confirm</span>
      <input type="password" bind:value={deletePassword} required placeholder="Your admin password" />
    </label>
    {#if deleteError}
      <p class="field-error">{deleteError}</p>
    {/if}
    <div class="delete-actions">
      <button type="button" class="btn-secondary" onclick={() => (showDeleteConfirm = null)}>Cancel</button>
      <button type="submit" class="btn-danger" disabled={deleting}>
        {deleting ? "Deleting..." : "Delete User"}
      </button>
    </div>
  </form>
</Modal>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 16px; }
  .search-input {
    min-width: 260px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
  }
  .error-banner {
    margin-bottom: 14px;
    padding: 10px 12px;
    border: 1px solid rgba(244, 71, 71, 0.35);
    background: rgba(244, 71, 71, 0.1);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
  }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  .table th { color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .role-pill {
    display: inline-block;
    text-transform: capitalize;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
  }
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
  .btn-primary { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--bg-elevated); color: var(--text-secondary); padding: 8px 16px; border-radius: var(--radius-sm); }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-small { background: var(--bg-elevated); color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
  .btn-small:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-danger { background: var(--status-failed); color: #fff; padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; }
  .btn-danger:hover { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; }
  .btn-small.btn-danger { background: none; color: var(--status-failed); padding: 4px 10px; font-weight: normal; }
  .btn-small.btn-danger:hover { background: rgba(244, 71, 71, 0.15); opacity: 1; }
  .delete-warning { font-size: var(--font-size-sm); color: var(--text-secondary); line-height: 1.5; margin-bottom: 14px; }
  .delete-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  .generated-pw { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 10px; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .generated-pw code { font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--text-primary); flex: 1; word-break: break-all; user-select: all; }
  .field-error { font-size: var(--font-size-sm); color: var(--status-failed); margin: -8px 0 8px; }
  .link-button {
    background: none;
    border: none;
    color: var(--accent);
    padding: 0;
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link-button:hover {
    color: var(--accent-hover);
  }
  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 4px; }
  .field input:not([type="checkbox"]):not([type="radio"]),
  .field select { width: 100%; }
  .hint { color: var(--text-muted); font-size: var(--font-size-sm); margin-bottom: 14px; }
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
  .error-text {
    color: var(--status-failed);
    font-size: var(--font-size-sm);
  }
  .insights-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }
  .insight-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
  }
  .insight-label {
    color: var(--text-muted);
    font-size: 11px;
    margin-bottom: 4px;
  }
  .insight-value {
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .insight-sub {
    color: var(--text-muted);
    font-size: 11px;
    margin-top: 3px;
  }
  .insight-statuses {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .insight-jobs h4 {
    margin: 0 0 8px;
    font-size: var(--font-size-sm);
  }
  .insights-panel {
    margin-top: 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    padding: 14px;
  }
  .insights-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .insights-header h3 {
    margin: 0;
    font-size: var(--font-size-base);
  }
  .insights-actions {
    display: flex;
    gap: 8px;
  }
  .insight-table .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }
</style>
