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

  interface PolicyPreset {
    name: string;
    description: string;
    rules: Array<{ type: string; pattern: string; action: string; description: string }>;
  }

  const PRESETS: PolicyPreset[] = [
    {
      name: "Protect Sensitive Files",
      description: "Block modifications to env files, secrets, credentials, and SSH keys",
      rules: [
        { type: "file_path", pattern: "**/.env*", action: "block", description: "Protect environment/secret files" },
        { type: "file_path", pattern: "**/secrets/**", action: "block", description: "Protect secrets directory" },
        { type: "file_path", pattern: "**/*.pem", action: "block", description: "Protect SSL/SSH certificates" },
        { type: "file_path", pattern: "**/*.key", action: "block", description: "Protect private keys" },
        { type: "file_path", pattern: "**/credentials*", action: "block", description: "Protect credential files" },
        { type: "file_path", pattern: "**/.ssh/**", action: "block", description: "Protect SSH directory" },
      ],
    },
    {
      name: "Prevent Destructive Operations",
      description: "Block dangerous shell commands that delete files, format disks, or wipe data",
      rules: [
        { type: "command_filter", pattern: "rm\\s+-r[f ]|rm\\s+-fr", action: "block", description: "Block recursive file deletion" },
        { type: "command_filter", pattern: "rmdir\\s+/s", action: "block", description: "Block Windows recursive directory removal" },
        { type: "command_filter", pattern: "del\\s+/[sfq]", action: "block", description: "Block Windows force-delete" },
        { type: "command_filter", pattern: "format\\s+[a-z]:", action: "block", description: "Block disk formatting" },
        { type: "command_filter", pattern: "mkfs\\.", action: "block", description: "Block filesystem creation" },
        { type: "command_filter", pattern: "dd\\s+if=.*of=/dev/", action: "block", description: "Block raw disk writes" },
        { type: "prompt_filter", pattern: "rm\\s+-rf\\s+/(?!tmp)", action: "block", description: "Block prompts requesting recursive root deletion" },
      ],
    },
    {
      name: "Prevent Git Force Push",
      description: "Block force-push and destructive git operations that can lose history",
      rules: [
        { type: "command_filter", pattern: "git\\s+push\\s+.*--force(?!-with-lease)", action: "block", description: "Block git force push (allow --force-with-lease)" },
        { type: "command_filter", pattern: "git\\s+reset\\s+--hard", action: "warn", description: "Warn on git hard reset" },
        { type: "command_filter", pattern: "git\\s+clean\\s+-[dfx]", action: "warn", description: "Warn on git clean" },
      ],
    },
    {
      name: "Protect Project Structure",
      description: "Warn when agents modify build configs, lock files, or CI pipelines",
      rules: [
        { type: "file_path", pattern: "**/.github/workflows/**", action: "warn", description: "Warn on CI/CD pipeline changes" },
        { type: "file_path", pattern: "**/Dockerfile*", action: "warn", description: "Warn on Dockerfile changes" },
        { type: "file_path", pattern: "**/docker-compose*", action: "warn", description: "Warn on Docker Compose changes" },
        { type: "file_path", pattern: "**/package-lock.json", action: "warn", description: "Warn on lockfile changes" },
        { type: "file_path", pattern: "**/pnpm-lock.yaml", action: "warn", description: "Warn on lockfile changes" },
        { type: "file_path", pattern: "**/yarn.lock", action: "warn", description: "Warn on lockfile changes" },
      ],
    },
    {
      name: "Block Network Exfiltration",
      description: "Block commands that could upload or send data to external servers",
      rules: [
        { type: "command_filter", pattern: "curl\\s+.*-[dXF]|curl\\s+.*--data|curl\\s+.*--upload", action: "warn", description: "Warn on curl data uploads" },
        { type: "command_filter", pattern: "wget\\s+.*--post", action: "warn", description: "Warn on wget POST requests" },
        { type: "command_filter", pattern: "scp\\s|rsync\\s.*:", action: "warn", description: "Warn on remote file transfers" },
      ],
    },
  ];

  let policies = $state<Policy[]>([]);
  let users = $state<UserOption[]>([]);
  let activeTab = $state("file_path");
  let showPresetsModal = $state(false);
  let applyingPreset = $state(false);
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

  async function applyPreset(preset: PolicyPreset) {
    applyingPreset = true;
    const existingPatterns = new Set(policies.map((p) => `${p.type}:${p.pattern}`));
    let created = 0;
    let skipped = 0;
    try {
      for (const rule of preset.rules) {
        if (existingPatterns.has(`${rule.type}:${rule.pattern}`)) {
          skipped++;
          continue;
        }
        await api.policies.create({ scope: "global", ...rule });
        created++;
      }
      toast.success(`${preset.name}: ${created} rules added${skipped ? `, ${skipped} already existed` : ""}`);
      showPresetsModal = false;
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      applyingPreset = false;
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
    <div class="toolbar-actions">
      <button class="btn-secondary" onclick={() => (showPresetsModal = true)}>
        Presets
      </button>
      <button class="btn-primary" onclick={() => { resetForm(); form.type = activeTab; showForm = true; }}>
        Add Rule
      </button>
    </div>
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

<Modal title="Policy Presets" open={showPresetsModal} onclose={() => (showPresetsModal = false)}>
  <p class="presets-hint">Apply a preset to quickly add common safety rules. Existing rules with the same pattern are skipped.</p>
  <div class="presets-list">
    {#each PRESETS as preset}
      <div class="preset-card">
        <div class="preset-info">
          <h4>{preset.name}</h4>
          <p>{preset.description}</p>
          <span class="preset-count">{preset.rules.length} rules</span>
        </div>
        <button class="btn-secondary" onclick={() => applyPreset(preset)} disabled={applyingPreset}>
          {applyingPreset ? "..." : "Apply"}
        </button>
      </div>
    {/each}
  </div>
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
  .toolbar-actions { display: flex; gap: 8px; }
  .btn-secondary { background: var(--bg-elevated); color: var(--text-secondary); padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 500; border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .presets-hint { color: var(--text-muted); font-size: var(--font-size-sm); margin-bottom: 16px; }
  .presets-list { display: flex; flex-direction: column; gap: 10px; }
  .preset-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-surface); }
  .preset-info h4 { font-size: var(--font-size-sm); font-weight: 600; margin-bottom: 2px; }
  .preset-info p { font-size: var(--font-size-xs); color: var(--text-secondary); line-height: 1.4; }
  .preset-count { font-size: 11px; color: var(--text-muted); }
</style>
