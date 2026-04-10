<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface PathMappingEntry { platform: string; path: string; }

  interface Template {
    id: string;
    type: string;
    category: string;
    subcategory: string | null;
    name: string;
    description: string | null;
    content: string;
    icon: string | null;
    options: Record<string, any> | null;
    sortOrder: number;
    enabled: boolean;
    verificationMode: string | null;
    verificationWeight: number | null;
    bridgeExecutionMode: string | null;
    createdAt: string;
    updatedAt: string;
  }

  type TabType = "chat" | "project" | "job_preset" | "path_mapping";

  const tabs: { key: TabType; label: string }[] = [
    { key: "chat", label: "Chat Prompts" },
    { key: "project", label: "Project Prompts" },
    { key: "job_preset", label: "Job Presets" },
    { key: "path_mapping", label: "Path Mappings" },
  ];

  let activeTab = $state<TabType>("chat");
  let templates = $state<Template[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let editingId = $state<string | null>(null);
  let saving = $state(false);
  let showDeleteConfirm = $state<string | null>(null);
  let seeding = $state(false);

  let form = $state({
    name: "",
    type: "chat" as string,
    category: "",
    subcategory: "",
    description: "",
    content: "",
    icon: "",
    sortOrder: 0,
    enabled: true,
    verificationMode: "none",
    verificationWeight: 1,
    bridgeExecutionMode: "normal",
    pathEntries: [] as PathMappingEntry[],
  });

  function addPathEntry() {
    form.pathEntries = [...form.pathEntries, { platform: "", path: "" }];
  }

  function removePathEntry(i: number) {
    form.pathEntries = form.pathEntries.filter((_, j) => j !== i);
  }

  let filtered = $derived(templates.filter((t) => t.type === activeTab));

  let grouped = $derived.by(() => {
    const groups: Record<string, Template[]> = {};
    for (const t of filtered) {
      const cat = t.category || "Uncategorized";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    }
    // Sort templates within each group by sortOrder then name
    for (const cat of Object.keys(groups)) {
      groups[cat].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }
    return groups;
  });

  let categoryNames = $derived(Object.keys(grouped).sort());

  async function loadTemplates() {
    loading = true;
    try {
      const result = await api.templates.list();
      templates = Array.isArray(result) ? result : (result as any)?.templates ?? [];
    } catch (err: any) {
      toast.error(`Failed to load templates: ${err.message}`);
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingId = null;
    form = {
      name: "",
      type: activeTab,
      category: "",
      subcategory: "",
      description: "",
      content: "",
      icon: "",
      sortOrder: 0,
      enabled: true,
      verificationMode: "none",
      verificationWeight: 1,
      bridgeExecutionMode: "normal",
      pathEntries: activeTab === "path_mapping"
        ? [
            { platform: "Windows", path: "" },
            { platform: "macOS", path: "" },
            { platform: "Linux", path: "" },
          ]
        : [],
    };
    showModal = true;
  }

  function openEdit(t: Template) {
    editingId = t.id;
    const rawEntries = (t.options?.entries as PathMappingEntry[] | undefined) ?? [];
    form = {
      name: t.name,
      type: t.type,
      category: t.category,
      subcategory: t.subcategory ?? "",
      description: t.description ?? "",
      content: t.content,
      icon: t.icon ?? "",
      sortOrder: t.sortOrder,
      enabled: t.enabled,
      verificationMode: t.verificationMode ?? "none",
      verificationWeight: t.verificationWeight ?? 1,
      bridgeExecutionMode: t.bridgeExecutionMode ?? "normal",
      pathEntries: rawEntries.map((e) => ({ platform: e.platform ?? "", path: e.path ?? "" })),
    };
    showModal = true;
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!form.category.trim()) {
      toast.error("Category is required");
      return;
    }

    saving = true;
    try {
      const payload: any = {
        name: form.name.trim(),
        type: form.type,
        category: form.category.trim(),
        subcategory: form.subcategory.trim() || null,
        description: form.description.trim() || null,
        content: form.content,
        icon: form.icon.trim() || null,
        sortOrder: form.sortOrder,
        enabled: form.enabled,
      };

      if (form.type === "job_preset") {
        payload.verificationMode = form.verificationMode;
        payload.verificationWeight = form.verificationWeight;
        payload.bridgeExecutionMode = form.bridgeExecutionMode;
      }

      if (form.type === "path_mapping") {
        const cleanEntries = form.pathEntries
          .map((e) => ({ platform: e.platform.trim(), path: e.path.trim() }))
          .filter((e) => e.platform && e.path);
        if (cleanEntries.length === 0) {
          toast.error("Add at least one platform + path entry");
          saving = false;
          return;
        }
        payload.options = { entries: cleanEntries };
        payload.content = ""; // path_mapping templates don't use content
      }

      if (editingId) {
        await api.templates.update(editingId, payload);
        toast.success("Template updated");
      } else {
        await api.templates.create(payload);
        toast.success("Template created");
      }
      showModal = false;
      await loadTemplates();
    } catch (err: any) {
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.templates.delete(id);
      toast.success("Template deleted");
      showDeleteConfirm = null;
      await loadTemplates();
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message}`);
    }
  }

  async function handleToggle(t: Template) {
    try {
      await api.templates.update(t.id, { enabled: !t.enabled });
      t.enabled = !t.enabled;
    } catch (err: any) {
      toast.error(`Failed to toggle: ${err.message}`);
    }
  }

  async function handleSeedDefaults() {
    seeding = true;
    try {
      await api.templates.seed();
      toast.success("Default templates seeded");
      await loadTemplates();
    } catch (err: any) {
      toast.error(`Failed to seed: ${err.message}`);
    } finally {
      seeding = false;
    }
  }

  onMount(() => {
    loadTemplates();
  });
</script>

<div class="templates-page">
  <div class="tab-bar">
    {#each tabs as tab}
      <button
        class="tab"
        class:active={activeTab === tab.key}
        onclick={() => (activeTab = tab.key)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div class="tab-content">
    <div class="toolbar">
      <h3 class="toolbar-title">{tabs.find((t) => t.key === activeTab)?.label ?? "Templates"}</h3>
      <div class="toolbar-actions">
        <button class="btn secondary" onclick={handleSeedDefaults} disabled={seeding}>
          {seeding ? "Seeding..." : "Seed Defaults"}
        </button>
        <button class="btn" onclick={openCreate}>+ New Template</button>
      </div>
    </div>

    {#if loading}
      <div class="empty">Loading templates...</div>
    {:else if filtered.length === 0}
      <div class="empty">
        No templates for this type yet. Click "New Template" or "Seed Defaults" to add some.
      </div>
    {:else}
      {#each categoryNames as category}
        <div class="category-group">
          <h4 class="category-heading">{category}</h4>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Subcategory</th>
                <th>Order</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each grouped[category] as t}
                <tr>
                  <td class="name-cell">
                    {#if t.icon}
                      <span class="template-icon">{t.icon}</span>
                    {/if}
                    <span>{t.name}</span>
                  </td>
                  <td class="desc-cell">
                    {#if t.type === "path_mapping" && t.options?.entries}
                      {(t.options.entries as PathMappingEntry[]).map((e) => `${e.platform}: ${e.path}`).join(" | ")}
                    {:else}
                      {t.description ?? ""}
                    {/if}
                  </td>
                  <td>{t.subcategory ?? ""}</td>
                  <td class="num-cell">{t.sortOrder}</td>
                  <td>
                    <button
                      class="toggle-btn"
                      class:enabled={t.enabled}
                      onclick={() => handleToggle(t)}
                    >
                      {t.enabled ? "On" : "Off"}
                    </button>
                  </td>
                  <td class="actions-cell">
                    <button class="btn secondary small" onclick={() => openEdit(t)}>Edit</button>
                    {#if showDeleteConfirm === t.id}
                      <button class="btn danger small" onclick={() => handleDelete(t.id)}>Confirm</button>
                      <button class="btn secondary small" onclick={() => (showDeleteConfirm = null)}>Cancel</button>
                    {:else}
                      <button class="btn danger small" onclick={() => (showDeleteConfirm = t.id)}>Delete</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}
    {/if}
  </div>
</div>

<Modal title={editingId ? "Edit Template" : "New Template"} open={showModal} onclose={() => (showModal = false)}>
  <div class="form">
    <label class="field">
      <span class="label">Name</span>
      <input type="text" bind:value={form.name} placeholder="Template name" />
    </label>

    <div class="row-2">
      <label class="field">
        <span class="label">Category</span>
        <input type="text" bind:value={form.category} placeholder="e.g. General, Coding" />
      </label>
      <label class="field">
        <span class="label">Subcategory</span>
        <input type="text" bind:value={form.subcategory} placeholder="Optional" />
      </label>
    </div>

    <label class="field">
      <span class="label">Description</span>
      <input type="text" bind:value={form.description} placeholder="Brief description" />
    </label>

    {#if form.type !== "path_mapping"}
      <label class="field">
        <span class="label">Content</span>
        <textarea bind:value={form.content} rows="8" placeholder="Template content / prompt text"></textarea>
      </label>
    {:else}
      <div class="field">
        <span class="label">Platform Paths</span>
        <div class="path-entries">
          {#each form.pathEntries as entry, i}
            <div class="path-row">
              <input
                type="text"
                class="path-platform"
                bind:value={entry.platform}
                placeholder="Platform (Windows, macOS, Linux)"
              />
              <input
                type="text"
                class="path-value"
                bind:value={entry.path}
                placeholder="/path/on/this/platform"
              />
              <button type="button" class="btn secondary small" onclick={() => removePathEntry(i)}>&times;</button>
            </div>
          {/each}
          <button type="button" class="btn secondary small" onclick={addPathEntry}>+ Add Entry</button>
        </div>
      </div>
    {/if}

    <div class="row-3">
      <label class="field">
        <span class="label">Icon</span>
        <input type="text" bind:value={form.icon} placeholder="Emoji or symbol" />
      </label>
      <label class="field">
        <span class="label">Sort Order</span>
        <input type="number" bind:value={form.sortOrder} />
      </label>
      <label class="field">
        <span class="label">Enabled</span>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={form.enabled} />
          <span>{form.enabled ? "Yes" : "No"}</span>
        </label>
      </label>
    </div>

    {#if form.type === "job_preset"}
      <div class="row-3">
        <label class="field">
          <span class="label">Verification Mode</span>
          <select bind:value={form.verificationMode}>
            <option value="none">None</option>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Verification Weight</span>
          <input type="number" bind:value={form.verificationWeight} min="0" step="0.1" />
        </label>
        <label class="field">
          <span class="label">Bridge Execution Mode</span>
          <select bind:value={form.bridgeExecutionMode}>
            <option value="normal">Normal</option>
            <option value="dry_run">Dry Run</option>
            <option value="preview">Preview</option>
          </select>
        </label>
      </div>
    {/if}

    <div class="form-actions">
      <button class="btn secondary" onclick={() => (showModal = false)}>Cancel</button>
      <button class="btn" onclick={handleSave} disabled={saving}>
        {saving ? "Saving..." : editingId ? "Update" : "Create"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .templates-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tab-bar {
    display: flex;
    gap: 0;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .tab {
    padding: 10px 20px;
    font-size: var(--font-size-base);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab:hover {
    color: var(--text-primary);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .toolbar-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .toolbar-actions {
    display: flex;
    gap: 8px;
  }

  .empty {
    padding: 40px 0;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .category-group {
    margin-bottom: 24px;
  }

  .category-heading {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .name-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }

  .template-icon {
    font-size: 16px;
  }

  .desc-cell {
    color: var(--text-secondary);
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .num-cell {
    text-align: center;
    color: var(--text-muted);
  }

  .actions-cell {
    display: flex;
    gap: 4px;
    white-space: nowrap;
  }

  .toggle-btn {
    padding: 2px 10px;
    font-size: var(--font-size-sm);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-muted);
    border: 1px solid var(--border);
    cursor: pointer;
  }

  .toggle-btn.enabled {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  /* Buttons */
  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: none;
  }

  .btn:hover {
    background: var(--accent-hover);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn.danger {
    background: var(--status-failed);
  }

  .btn.secondary {
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .btn.secondary:hover {
    background: var(--bg-elevated);
  }

  .btn.small {
    padding: 3px 10px;
    font-size: 11px;
  }

  /* Form styles */
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 500;
  }

  .form input[type="text"],
  .form input[type="number"],
  .form select,
  .form textarea {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: inherit;
  }

  .form textarea {
    font-family: var(--font-mono);
    resize: vertical;
  }

  .form input:focus,
  .form select:focus,
  .form textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .row-3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }

  .path-entries {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .path-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .path-platform {
    width: 180px;
    flex-shrink: 0;
  }
  .path-value {
    flex: 1;
    font-family: var(--font-mono);
  }
</style>
