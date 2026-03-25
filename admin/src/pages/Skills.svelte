<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface SkillEntry {
    id: string;
    slug: string;
    name: string;
    program: string | null;
    category: string;
    title: string;
    description: string;
    keywords: string[];
    content: string;
    playbooks: string[];
    relatedSkills: string[];
    source: string;
    sourcePath: string | null;
    priority: number;
    autoFetch: boolean;
    enabled: boolean;
  }

  interface EffectivenessStats {
    totalUsed: number;
    goodOutcomes: number;
    averageOutcomes: number;
    poorOutcomes: number;
    pendingOutcomes: number;
    successRate: number;
  }

  interface SearchResult {
    slug: string;
    name: string;
    program: string | null;
    category: string;
    title: string;
    description: string;
    score: number;
  }

  let loading = $state(false);
  let skills = $state<SkillEntry[]>([]);
  let effectivenessStats = $state<Record<string, EffectivenessStats>>({});

  // Filters
  let filterProgram = $state("");
  let filterCategory = $state("");
  let filterSource = $state("");

  // Import
  let importFileInput: HTMLInputElement | undefined = $state(undefined);
  let importing = $state(false);

  // Pull
  let pullingAll = $state(false);
  let pullingProgram = $state<string | null>(null);

  // Search preview
  let searchQuery = $state("");
  let searchResults = $state<SearchResult[]>([]);
  let searching = $state(false);

  // Create form
  let createOpen = $state(false);
  let createName = $state("");
  let createSlug = $state("");
  let createProgram = $state("");
  let createCategory = $state("custom");
  let createTitle = $state("");
  let createDescription = $state("");
  let createKeywords = $state("");
  let createContent = $state("");

  // Detail modal
  let detailSkill = $state<SkillEntry | null>(null);
  let playbookContent = $state<Array<{ path: string; content: string | null; error?: string }>>([]);
  let loadingPlaybooks = $state(false);

  // Delete confirm
  let confirmDelete = $state<SkillEntry | null>(null);

  // Registry
  interface RegistrySkill {
    slug: string;
    program: string;
    category: string;
    title: string;
    description: string;
    version: string;
    contentUrl: string;
    installed: boolean;
  }
  let registryOpen = $state(false);
  let registryLoading = $state(false);
  let registrySkills = $state<RegistrySkill[]>([]);
  let installingSlug = $state<string | null>(null);

  let filteredSkills = $derived.by(() => {
    let result = skills;
    if (filterProgram) {
      result = result.filter((s) => s.program === filterProgram);
    }
    if (filterCategory) {
      result = result.filter((s) => s.category === filterCategory);
    }
    if (filterSource) {
      result = result.filter((s) => s.source === filterSource);
    }
    return result;
  });

  let uniquePrograms = $derived.by(() => {
    const set = new Set<string>();
    for (const s of skills) {
      if (s.program) set.add(s.program);
    }
    return Array.from(set).sort();
  });

  let uniqueCategories = $derived.by(() => {
    const set = new Set<string>();
    for (const s of skills) {
      if (s.category) set.add(s.category);
    }
    return Array.from(set).sort();
  });

  let uniqueSources = $derived.by(() => {
    const set = new Set<string>();
    for (const s of skills) {
      if (s.source) set.add(s.source);
    }
    return Array.from(set).sort();
  });

  async function load() {
    loading = true;
    try {
      const data = await api.skills.list();
      skills = Array.isArray(data?.skills ?? data) ? (data?.skills ?? data) : [];
      // Fetch effectiveness stats for all skills
      const ids = skills.map((s) => s.id).filter(Boolean);
      if (ids.length > 0) {
        try {
          const eff = await api.skills.batchEffectiveness(ids);
          effectivenessStats = eff?.stats ?? {};
        } catch {
          effectivenessStats = {};
        }
      }
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load skills");
    } finally {
      loading = false;
    }
  }

  async function doSearch() {
    const q = searchQuery.trim();
    if (!q) {
      searchResults = [];
      return;
    }
    searching = true;
    try {
      const data = await api.skills.search(q, filterProgram || undefined, filterCategory || undefined);
      searchResults = Array.isArray(data) ? data : [];
    } catch (err: any) {
      toast.error(err.message ?? "Search failed");
    } finally {
      searching = false;
    }
  }

  async function refreshIndex() {
    try {
      await api.skills.refreshIndex();
      toast.success("Skill index refreshed");
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to refresh index");
    }
  }

  async function createSkill() {
    const name = createName.trim();
    const slug = createSlug.trim();
    const title = createTitle.trim();
    const content = createContent.trim();
    if (!name || !slug || !title || !content) {
      toast.error("Name, slug, title, and content are required");
      return;
    }
    try {
      const keywords = createKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      await api.skills.create({
        name,
        slug,
        program: createProgram.trim() || "global",
        category: createCategory,
        title,
        description: createDescription.trim() || "",
        keywords: keywords.length > 0 ? keywords : [],
        content,
      });
      toast.success(`Skill "${name}" created`);
      createOpen = false;
      createName = "";
      createSlug = "";
      createProgram = "";
      createCategory = "custom";
      createTitle = "";
      createDescription = "";
      createKeywords = "";
      createContent = "";
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create skill");
    }
  }

  async function deleteSkill() {
    if (!confirmDelete) return;
    const { slug, program } = confirmDelete;
    confirmDelete = null;
    try {
      await api.skills.delete(slug, program || undefined);
      toast.success(`Skill "${slug}" deleted`);
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to delete skill");
    }
  }

  async function openRegistry() {
    registryOpen = true;
    registryLoading = true;
    try {
      const data = await api.skills.registry();
      registrySkills = Array.isArray(data?.skills) ? data.skills : (Array.isArray(data) ? data : []);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to fetch registry");
      registrySkills = [];
    } finally {
      registryLoading = false;
    }
  }

  async function installSkill(skill: RegistrySkill) {
    const key = `${skill.slug}:${skill.program}`;
    installingSlug = key;
    try {
      await api.skills.install({ slug: skill.slug, program: skill.program, sourceUrl: skill.contentUrl });
      toast.success(`Installed "${skill.title}"`);
      // Mark as installed in registry list
      registrySkills = registrySkills.map((s) =>
        s.slug === skill.slug && s.program === skill.program ? { ...s, installed: true } : s
      );
      // Refresh main skills list
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to install skill");
    } finally {
      installingSlug = null;
    }
  }

  async function exportSkills() {
    try {
      const { blob, fileName } = await api.skills.export({
        program: filterProgram || undefined,
        category: filterCategory || undefined,
        source: filterSource || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName ?? "skills-export.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast.success("Skills exported");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to export skills");
    }
  }

  async function importSkills(file: File) {
    importing = true;
    try {
      const result = await api.skills.importZip(file);
      toast.success(`Imported ${result.imported} skill(s), ${result.skipped} skipped`);
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to import skills");
    } finally {
      importing = false;
      if (importFileInput) importFileInput.value = "";
    }
  }

  function handleImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) importSkills(file);
  }

  async function pullAll() {
    pullingAll = true;
    try {
      const result = await api.skills.pullAll();
      toast.success(result?.message ?? "Pulled skills from bridge repo");
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to pull skills");
    } finally {
      pullingAll = false;
    }
  }

  async function pullProgram(prog: string) {
    pullingProgram = prog;
    try {
      const result = await api.skills.pullProgram(prog);
      toast.success(result?.message ?? `Pulled skills for ${prog}`);
      await load();
    } catch (err: any) {
      toast.error(err.message ?? `Failed to pull skills for ${prog}`);
    } finally {
      pullingProgram = null;
    }
  }

  async function openDetail(skill: SkillEntry) {
    playbookContent = [];
    // Fetch full skill detail (list endpoint returns summary without content/playbooks)
    try {
      const data = await api.skills.get(skill.slug, skill.program || undefined);
      detailSkill = data?.skill ?? skill;
    } catch {
      detailSkill = skill;
    }
    if (detailSkill && detailSkill.playbooks?.length > 0) {
      loadingPlaybooks = true;
      try {
        const data = await api.skills.getPlaybookContent(detailSkill.slug, detailSkill.program || undefined);
        playbookContent = data?.playbooks ?? [];
      } catch {
        playbookContent = [];
      } finally {
        loadingPlaybooks = false;
      }
    }
  }

  function navigateToSkill(slug: string) {
    const target = skills.find(s => s.slug === slug);
    if (target) openDetail(target);
  }

  function autoSlug() {
    createSlug = createName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  onMount(() => {
    load();
  });
</script>

<div class="page">
  <div class="toolbar">
    <div class="filters">
      <select bind:value={filterProgram}>
        <option value="">All Bridges</option>
        {#each uniquePrograms as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
      <select bind:value={filterCategory}>
        <option value="">All Categories</option>
        {#each uniqueCategories as c}
          <option value={c}>{c}</option>
        {/each}
      </select>
      <select bind:value={filterSource}>
        <option value="">All Sources</option>
        {#each uniqueSources as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </div>
    <div class="toolbar-actions">
      <button class="btn-primary" onclick={() => (createOpen = true)}>Create Skill</button>
      <button class="btn-secondary" onclick={openRegistry}>Browse Registry</button>
      <button class="btn-secondary" onclick={pullAll} disabled={pullingAll}>
        {pullingAll ? "Pulling..." : "Pull from Bridge Repo"}
      </button>
      <button class="btn-secondary" onclick={exportSkills}>Export</button>
      <button class="btn-secondary" onclick={() => importFileInput?.click()} disabled={importing}>
        {importing ? "Importing..." : "Import"}
      </button>
      <input type="file" accept=".zip,.json" bind:this={importFileInput} onchange={handleImportFile} class="hidden-file-input" />
      <button class="btn-secondary" onclick={refreshIndex}>Refresh Index</button>
      <button class="btn-secondary" onclick={load} disabled={loading}>Reload</button>
    </div>
  </div>

  <!-- Search Preview -->
  <div class="search-panel">
    <div class="search-row">
      <input
        type="text"
        placeholder="Search skills..."
        bind:value={searchQuery}
        onkeydown={(e) => { if (e.key === "Enter") doSearch(); }}
      />
      <button class="btn-secondary" onclick={doSearch} disabled={searching}>
        {searching ? "Searching..." : "Search"}
      </button>
    </div>
    {#if searchResults.length > 0}
      <div class="search-results">
        {#each searchResults as r}
          <div class="search-result">
            <span class="mono">{r.slug}</span>
            <span class="result-title">{r.title}</span>
            <span class="badge badge-cat">{r.category}</span>
            {#if r.program}
              <span class="badge badge-prog">{r.program}</span>
            {/if}
            <span class="score">score: {r.score?.toFixed?.(2) ?? r.score}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Skills Table -->
  <table class="table">
    <thead>
      <tr>
        <th>Slug</th>
        <th>Title</th>
        <th>Bridge</th>
        <th>Category</th>
        <th>Source</th>
        <th>Uses</th>
        <th>Success</th>
        <th>Playbooks</th>
        <th>Enabled</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr><td colspan="10" class="muted">Loading skills...</td></tr>
      {:else if filteredSkills.length === 0}
        <tr><td colspan="10" class="muted">
          {#if skills.length === 0}
            No skills loaded yet.
            <button class="btn-link" onclick={pullAll} disabled={pullingAll}>
              {pullingAll ? "Pulling..." : "Pull from Bridge Repo"}
            </button>
            to fetch skills from connected bridges.
          {:else}
            No skills match the current filters.
          {/if}
        </td></tr>
      {:else}
        {#each filteredSkills as skill}
          {@const eff = effectivenessStats[skill.id]}
          <tr>
            <td class="mono">{skill.slug}</td>
            <td>{skill.title}</td>
            <td class="muted">{skill.program || "-"}</td>
            <td><span class="badge badge-cat">{skill.category}</span></td>
            <td><span class="badge {skill.source === 'user' ? 'badge-custom' : skill.source === 'registry' ? 'badge-registry' : skill.source === 'training' ? 'badge-training' : skill.source === 'bridge-repo' ? 'badge-bridge-repo' : 'badge-default'}">{skill.source}</span></td>
            <td class="mono">{eff?.totalUsed ?? "-"}</td>
            <td>
              {#if eff && eff.totalUsed > 0}
                {@const pct = Math.round(eff.successRate * 100)}
                <span class="badge {pct >= 70 ? 'badge-ok' : pct >= 40 ? 'badge-warn' : 'badge-bad'}">{pct}%</span>
              {:else}
                <span class="muted">-</span>
              {/if}
            </td>
            <td>
              {#if skill.playbooks?.length > 0}
                <span class="badge badge-playbook">{skill.playbooks.length}</span>
              {:else}
                <span class="muted">-</span>
              {/if}
            </td>
            <td>
              {#if skill.enabled}
                <span class="badge badge-ok">yes</span>
              {:else}
                <span class="badge badge-off">no</span>
              {/if}
            </td>
            <td class="actions-cell">
              <button class="btn-small" onclick={() => openDetail(skill)}>View</button>
              <button class="btn-small btn-danger" onclick={() => (confirmDelete = skill)}>Delete</button>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>

  <div class="summary">
    {filteredSkills.length} skill{filteredSkills.length !== 1 ? "s" : ""} shown
    {#if skills.length !== filteredSkills.length}
      ({skills.length} total)
    {/if}
  </div>
</div>

<!-- Detail Modal -->
<Modal title="Skill Detail" open={detailSkill !== null} onclose={() => (detailSkill = null)}>
  {#if detailSkill}
    <div class="detail-grid">
      <div><strong>Slug:</strong> <span class="mono">{detailSkill.slug}</span></div>
      <div><strong>Name:</strong> {detailSkill.name}</div>
      <div><strong>Title:</strong> {detailSkill.title}</div>
      <div><strong>Bridge:</strong> {detailSkill.program || "-"}</div>
      <div><strong>Category:</strong> {detailSkill.category}</div>
      <div><strong>Source:</strong> {detailSkill.source}</div>
      <div><strong>Enabled:</strong> {detailSkill.enabled ? "Yes" : "No"}</div>
      <div><strong>Priority:</strong> {detailSkill.priority}</div>
      <div><strong>Auto-fetch:</strong> {detailSkill.autoFetch ? "Yes" : "No"}</div>
      {#if detailSkill.keywords.length > 0}
        <div><strong>Keywords:</strong> {detailSkill.keywords.join(", ")}</div>
      {/if}
      {#if detailSkill.description}
        <div><strong>Description:</strong> {detailSkill.description}</div>
      {/if}
      {#if detailSkill.sourcePath}
        <div><strong>Source Path:</strong> <span class="mono">{detailSkill.sourcePath}</span></div>
      {/if}
    </div>
    {#if detailSkill.playbooks?.length > 0}
      <div class="detail-section">
        <strong>Playbook References ({detailSkill.playbooks.length})</strong>
        <div class="playbook-list">
          {#each detailSkill.playbooks as pb}
            <div class="playbook-entry mono">{pb}</div>
          {/each}
        </div>
        {#if loadingPlaybooks}
          <p class="muted">Loading playbook content...</p>
        {:else if playbookContent.length > 0}
          {#each playbookContent as pb}
            <div class="playbook-preview">
              <div class="playbook-path mono">{pb.path}</div>
              {#if pb.error}
                <div class="playbook-error">{pb.error}</div>
              {:else if pb.content}
                <textarea rows="10" value={pb.content.slice(0, 4000)} readonly class="content-viewer"></textarea>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
    {#if detailSkill.relatedSkills?.length > 0}
      <div class="detail-section">
        <strong>Related Skills</strong>
        <div class="related-skills">
          {#each detailSkill.relatedSkills as slug}
            <button class="btn-link" onclick={() => navigateToSkill(slug)}>{slug}</button>
          {/each}
        </div>
      </div>
    {/if}
    <label class="field">
      <span>Content</span>
      <textarea rows="10" value={detailSkill.content} readonly class="content-viewer"></textarea>
    </label>
    <div class="actions">
      <button class="btn-secondary" onclick={() => (detailSkill = null)}>Close</button>
    </div>
  {/if}
</Modal>

<!-- Create Modal -->
<Modal title="Create Custom Skill" open={createOpen} onclose={() => (createOpen = false)}>
  <form onsubmit={(e) => { e.preventDefault(); createSkill(); }}>
    <label class="field">
      <span>Name</span>
      <input type="text" bind:value={createName} placeholder="my-skill" oninput={autoSlug} />
    </label>
    <label class="field">
      <span>Slug</span>
      <input type="text" bind:value={createSlug} placeholder="my-skill" />
    </label>
    <label class="field">
      <span>Bridge (optional)</span>
      <input type="text" bind:value={createProgram} placeholder="e.g. godot, blender" />
    </label>
    <label class="field">
      <span>Category</span>
      <select bind:value={createCategory}>
        <option value="custom">custom</option>
        <option value="coordinator">coordinator</option>
        <option value="bridge">bridge</option>
        <option value="training">training</option>
        <option value="playbook">playbook</option>
        <option value="verification">verification</option>
        <option value="project">project</option>
      </select>
    </label>
    <label class="field">
      <span>Title</span>
      <input type="text" bind:value={createTitle} placeholder="Descriptive title" />
    </label>
    <label class="field">
      <span>Description (optional)</span>
      <input type="text" bind:value={createDescription} placeholder="Brief description" />
    </label>
    <label class="field">
      <span>Keywords (comma-separated, optional)</span>
      <input type="text" bind:value={createKeywords} placeholder="keyword1, keyword2" />
    </label>
    <label class="field">
      <span>Content</span>
      <textarea bind:value={createContent} rows="10" placeholder="Skill content / instructions..."></textarea>
    </label>
    <div class="actions">
      <button class="btn-secondary" type="button" onclick={() => (createOpen = false)}>Cancel</button>
      <button class="btn-primary" type="submit">Create</button>
    </div>
  </form>
</Modal>

<!-- Delete Confirm Modal -->
<Modal title="Delete Skill" open={confirmDelete !== null} onclose={() => (confirmDelete = null)}>
  {#if confirmDelete}
    <p>Are you sure you want to delete <strong>{confirmDelete.slug}</strong>?</p>
    <p class="hint">This will permanently remove the custom skill from the database.</p>
    <div class="actions">
      <button class="btn-secondary" onclick={() => (confirmDelete = null)}>Cancel</button>
      <button class="btn-danger" onclick={deleteSkill}>Delete</button>
    </div>
  {/if}
</Modal>

<!-- Registry Modal -->
<Modal title="Skill Registry" open={registryOpen} onclose={() => (registryOpen = false)}>
  {#if registryLoading}
    <p class="muted">Loading registry...</p>
  {:else if registrySkills.length === 0}
    <p class="muted">No skills available in the registry.</p>
  {:else}
    <div class="registry-list">
      {#each registrySkills as skill}
        <div class="registry-item">
          <div class="registry-info">
            <div class="registry-title">{skill.title}</div>
            <div class="registry-meta">
              <span class="badge badge-prog">{skill.program}</span>
              <span class="badge badge-cat">{skill.category}</span>
              <span class="registry-version">v{skill.version}</span>
            </div>
            {#if skill.description}
              <div class="registry-desc">{skill.description}</div>
            {/if}
          </div>
          <div class="registry-action">
            {#if skill.installed}
              <span class="badge badge-ok">Installed</span>
            {:else}
              <button
                class="btn-primary btn-small"
                disabled={installingSlug === `${skill.slug}:${skill.program}`}
                onclick={() => installSkill(skill)}
              >
                {installingSlug === `${skill.slug}:${skill.program}` ? "Installing..." : "Install"}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
  <div class="actions">
    <button class="btn-secondary" onclick={() => (registryOpen = false)}>Close</button>
  </div>
</Modal>

<style>
  .page { padding: 24px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 14px; }
  .filters { display: flex; gap: 8px; }
  .filters select { font-size: var(--font-size-sm); padding: 6px 8px; }
  .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; padding: 0; font-size: inherit; }
  .btn-link:hover { opacity: 0.8; }
  .btn-link:disabled { opacity: 0.5; cursor: default; }
  .toolbar-actions { display: flex; gap: 8px; }
  .search-panel { margin-bottom: 14px; }
  .search-row { display: flex; gap: 8px; margin-bottom: 6px; }
  .search-row input { flex: 1; padding: 6px 8px; font-size: var(--font-size-sm); }
  .search-results { border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 180px; overflow-y: auto; }
  .search-result { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: var(--font-size-sm); }
  .search-result:last-child { border-bottom: none; }
  .result-title { flex: 1; }
  .score { color: var(--text-muted); font-size: 11px; }
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
  .badge-warn { color: #e2b93d; background: rgba(226, 185, 61, 0.12); }
  .badge-bad { color: #e05252; background: rgba(224, 82, 82, 0.12); }
  .badge-off { color: var(--text-muted); background: var(--bg-elevated); }
  .badge-default { color: var(--text-muted); background: var(--bg-elevated); }
  .badge-custom { color: var(--accent); background: rgba(78, 156, 230, 0.12); }
  .badge-cat { color: var(--text-secondary); background: var(--bg-elevated); }
  .badge-prog { color: var(--accent); background: rgba(78, 156, 230, 0.12); }
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
  .field input, .field textarea, .field select { width: 100%; }
  .hint { color: var(--text-secondary); margin-bottom: 12px; }
  .summary { margin-top: 12px; color: var(--text-muted); font-size: var(--font-size-sm); }
  .detail-grid { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: var(--font-size-sm); }
  .content-viewer {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    resize: vertical;
    min-height: 200px;
  }
  .badge-registry { color: #b07cd8; background: rgba(176, 124, 216, 0.12); }
  .badge-training { color: #d8a07c; background: rgba(216, 160, 124, 0.12); }
  .badge-bridge-repo { color: #7cd89e; background: rgba(124, 216, 158, 0.12); }
  .badge-playbook { color: #d8c87c; background: rgba(216, 200, 124, 0.12); }
  .hidden-file-input { display: none; }
  .detail-section { margin-bottom: 12px; }
  .detail-section strong { display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .playbook-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .playbook-entry { font-size: var(--font-size-sm); padding: 4px 8px; background: var(--bg-elevated); border-radius: var(--radius-sm); }
  .playbook-preview { margin-top: 8px; }
  .playbook-path { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
  .playbook-error { color: #e05555; font-size: var(--font-size-sm); }
  .related-skills { display: flex; flex-wrap: wrap; gap: 6px; }
  .registry-list { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; margin-bottom: 12px; }
  .registry-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .registry-info { flex: 1; min-width: 0; }
  .registry-title { font-weight: 500; margin-bottom: 4px; }
  .registry-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .registry-version { color: var(--text-muted); font-size: 11px; }
  .registry-desc { color: var(--text-secondary); font-size: var(--font-size-sm); }
  .registry-action { flex-shrink: 0; }
</style>
