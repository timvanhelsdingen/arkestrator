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
    locked: boolean;
    appVersion: string | null;
    repoContentHash: string | null;
    repoModified?: boolean;
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
  let filterType = $state<"" | "api" | "dcc">("");
  let filterEnabled = $state<"" | "enabled" | "disabled">("");
  let filterKeyword = $state("");
  let filterSearch = $state("");
  let apiBridgeNames = $state<Set<string>>(new Set());

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
  let createPriority = $state(50);
  let createAutoFetch = $state(false);
  let createEnabled = $state(true);

  // Detail modal
  let detailSkill = $state<SkillEntry | null>(null);
  let playbookContent = $state<Array<{ path: string; content: string | null; error?: string }>>([]);
  let loadingPlaybooks = $state(false);
  let expandedPlaybooks = $state<Set<string>>(new Set());

  // Edit mode
  let editMode = $state(false);
  let editContent = $state("");
  let editDescription = $state("");
  let editKeywords = $state("");
  let editPriority = $state(50);
  let editEnabled = $state(true);
  let editAutoFetch = $state(false);
  let editRelatedSkills = $state<string[]>([]);
  let relatedPickerValue = $state("");
  let saving = $state(false);

  // Version history
  let versions = $state<Array<{ id: string; version: number; content: string; keywords: string[]; description: string; createdAt: string }>>([]);
  let currentVersion = $state(0);
  let loadingVersions = $state(false);
  let selectedVersionNumber = $state(0);

  function versionTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  const viewingOldVersion = $derived(selectedVersionNumber > 0 && selectedVersionNumber !== currentVersion);
  const selectedVersionData = $derived(versions.find(v => v.version === selectedVersionNumber));

  function togglePlaybook(path: string) {
    const next = new Set(expandedPlaybooks);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedPlaybooks = next;
  }

  function formatPlaybookContent(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }

  // Selection
  let selectedSlugs = $state(new Set<string>());
  function skillKey(s: SkillEntry): string { return s.program + ":" + s.slug; }

  function toggleSelectAll() {
    if (selectedSlugs.size === filteredSkills.length && filteredSkills.length > 0) {
      selectedSlugs = new Set();
    } else {
      selectedSlugs = new Set(filteredSkills.map(skillKey));
    }
  }

  function toggleSelect(key: string) {
    const next = new Set(selectedSlugs);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectedSlugs = next;
  }

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
    if (filterType === "api") {
      result = result.filter((s) => s.program && apiBridgeNames.has(s.program.toLowerCase()));
    } else if (filterType === "dcc") {
      result = result.filter((s) => s.program === "global" || (s.program && !apiBridgeNames.has(s.program.toLowerCase())));
    }
    if (filterEnabled === "enabled") {
      result = result.filter((s) => s.enabled !== false);
    } else if (filterEnabled === "disabled") {
      result = result.filter((s) => s.enabled === false);
    }
    if (filterKeyword) {
      const kw = filterKeyword.toLowerCase();
      result = result.filter((s) => s.keywords?.some((k) => k.toLowerCase() === kw));
    }
    if (filterSearch) {
      const q = filterSearch.toLowerCase().trim();
      result = result.filter((s) =>
        s.slug.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.program ?? "").toLowerCase().includes(q) ||
        (s.category ?? "").toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        (s.keywords ?? []).some((k) => k.toLowerCase().includes(q)),
      );
    }
    return result;
  });

  const activeFilterCount = $derived(
    (filterProgram ? 1 : 0) +
    (filterCategory ? 1 : 0) +
    (filterSource ? 1 : 0) +
    (filterType ? 1 : 0) +
    (filterEnabled ? 1 : 0) +
    (filterKeyword ? 1 : 0) +
    (filterSearch ? 1 : 0)
  );

  function clearAllFilters() {
    filterProgram = "";
    filterCategory = "";
    filterSource = "";
    filterType = "";
    filterEnabled = "";
    filterKeyword = "";
    filterSearch = "";
  }

  // Clear selection when filters change
  $effect(() => {
    // Subscribe to filter values
    filterProgram; filterCategory; filterSource; filterType; filterEnabled; filterKeyword; filterSearch;
    selectedSlugs = new Set();
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

  let allKeywords = $derived.by(() => {
    const set = new Set<string>();
    for (const s of skills) {
      if (s.keywords) for (const k of s.keywords) if (k?.trim()) set.add(k.trim().toLowerCase());
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
      // Build the api-bridge name set so the Type filter can separate API from DCC.
      try {
        const apiBridges = await api.apiBridges.list();
        const names = new Set<string>();
        for (const ab of Array.isArray(apiBridges) ? apiBridges : []) {
          const name = String((ab as any)?.name ?? "").trim().toLowerCase();
          if (name) names.add(name);
        }
        apiBridgeNames = names;
      } catch {
        // Non-fatal: leave the set empty, the api/dcc filter just behaves like "all"
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
        priority: createPriority,
        autoFetch: createAutoFetch,
        enabled: createEnabled,
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
      createPriority = 50;
      createAutoFetch = false;
      createEnabled = true;
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
      // If skills are selected, export only those; otherwise export all (respecting filters)
      const slugs = selectedSlugs.size > 0
        ? filteredSkills.filter(s => selectedSlugs.has(skillKey(s))).map(s => s.slug)
        : undefined;
      const { blob, fileName } = await api.skills.export({
        program: filterProgram || undefined,
        category: filterCategory || undefined,
        source: filterSource || undefined,
        slugs,
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

  async function loadVersions(slug: string, program?: string) {
    loadingVersions = true;
    try {
      const result = await api.skills.listVersions(slug, program);
      versions = result.versions;
      currentVersion = result.currentVersion;
      selectedVersionNumber = currentVersion;
    } catch { versions = []; }
    loadingVersions = false;
  }

  function startEdit() {
    if (!detailSkill) return;
    editContent = detailSkill.content;
    editDescription = detailSkill.description;
    editKeywords = (detailSkill.keywords ?? []).join(", ");
    editPriority = detailSkill.priority ?? 50;
    editEnabled = detailSkill.enabled !== false;
    editAutoFetch = detailSkill.autoFetch === true;
    editRelatedSkills = [...(detailSkill.relatedSkills ?? [])];
    relatedPickerValue = "";
    editMode = true;
  }

  function addRelatedSkill(slug: string) {
    if (!slug || editRelatedSkills.includes(slug)) return;
    editRelatedSkills = [...editRelatedSkills, slug];
    relatedPickerValue = "";
  }

  function removeRelatedSkill(slug: string) {
    editRelatedSkills = editRelatedSkills.filter((s) => s !== slug);
  }

  async function saveEdit() {
    if (!detailSkill) return;
    saving = true;
    try {
      await api.skills.update(detailSkill.slug, {
        content: editContent,
        description: editDescription,
        keywords: editKeywords.split(",").map((k: string) => k.trim()).filter(Boolean),
        priority: editPriority,
        enabled: editEnabled,
        autoFetch: editAutoFetch,
        relatedSkills: editRelatedSkills,
      }, detailSkill.program || undefined);
      toast.success("Skill updated");
      editMode = false;
      const updated = await api.skills.get(detailSkill.slug, detailSkill.program || undefined);
      if (updated?.skill) detailSkill = updated.skill;
      loadVersions(detailSkill!.slug, detailSkill!.program || undefined);
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
    saving = false;
  }

  async function rollbackToVersion(version: number) {
    if (!detailSkill) return;
    try {
      await api.skills.rollback(detailSkill.slug, version, detailSkill.program || undefined);
      toast.success(`Rolled back to version ${version}`);
      const updated = await api.skills.get(detailSkill.slug, detailSkill.program || undefined);
      if (updated?.skill) detailSkill = updated.skill;
      loadVersions(detailSkill!.slug, detailSkill!.program || undefined);
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deleteSelectedVersion() {
    if (!detailSkill || !selectedVersionNumber) return;
    try {
      await api.skills.deleteVersion(detailSkill.slug, selectedVersionNumber, detailSkill.program || undefined);
      toast.success(`Deleted version ${selectedVersionNumber}`);
      await loadVersions(detailSkill.slug, detailSkill.program || undefined);
      selectedVersionNumber = currentVersion;
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function exportSingleSkill() {
    if (!detailSkill) return;
    try {
      const { blob, fileName } = await api.skills.export({ slugs: [detailSkill.slug] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName ?? "skill-export.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function toggleLock() {
    if (!detailSkill) return;
    try {
      const newLocked = !detailSkill.locked;
      await api.skills.update(detailSkill.slug, { locked: newLocked }, detailSkill.program || undefined);
      detailSkill = { ...detailSkill, locked: newLocked };
      toast.success(newLocked ? "Skill locked" : "Skill unlocked");
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function openDetail(skill: SkillEntry) {
    playbookContent = [];
    expandedPlaybooks = new Set();
    editMode = false;
    versions = [];
    selectedVersionNumber = 0;
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
    // Load version history
    if (detailSkill) {
      loadVersions(detailSkill.slug, detailSkill.program || undefined);
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

  // ── Ranking Config ──
  let rankingOpen = $state(false);
  let rankingLoading = $state(false);
  let rankingSaving = $state(false);
  let rankingConfig = $state<Record<string, number>>({});
  let rankingDefaults = $state<Record<string, number>>({});

  const RANKING_FIELDS: Array<{ key: string; label: string; hint: string; min: number; max: number; step: number }> = [
    { key: "explorationThreshold", label: "Exploration Threshold (uses)", hint: "Skills with fewer uses than this get an optimistic bonus.", min: 1, max: 100, step: 1 },
    { key: "establishedThreshold", label: "Established Threshold (uses)", hint: "Skills at or above this usage count trust their actual success rate.", min: 2, max: 500, step: 1 },
    { key: "explorationBonus", label: "Exploration Bonus", hint: "Effectiveness score given to new/low-use skills.", min: 0, max: 1, step: 0.05 },
    { key: "effectivenessFloor", label: "Effectiveness Floor", hint: "Minimum effectiveness score — prevents hard-disabling poor skills.", min: 0, max: 1, step: 0.05 },
    { key: "weightLexical", label: "Lexical Weight", hint: "Weight for keyword matching in the combined score.", min: 0, max: 1, step: 0.05 },
    { key: "weightSemantic", label: "Semantic Weight", hint: "Weight for semantic (vector) similarity.", min: 0, max: 1, step: 0.05 },
    { key: "weightEffectiveness", label: "Effectiveness Weight", hint: "Weight for effectiveness scoring.", min: 0, max: 1, step: 0.05 },
    { key: "minScoreThreshold", label: "Min Score Threshold", hint: "Minimum combined score for a skill to be included in results.", min: 0, max: 1, step: 0.01 },
  ];

  async function loadRankingConfig() {
    rankingLoading = true;
    try {
      const data = await api.skills.getRankingConfig();
      rankingConfig = { ...data.config };
      rankingDefaults = { ...data.defaults };
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load ranking config");
    } finally {
      rankingLoading = false;
    }
  }

  async function saveRankingConfig() {
    rankingSaving = true;
    try {
      const res = await api.skills.updateRankingConfig(rankingConfig);
      rankingConfig = { ...res.config };
      toast.success(`Ranking config saved (${res.updated.length} updated)`);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save ranking config");
    } finally {
      rankingSaving = false;
    }
  }

  async function resetRankingConfig() {
    rankingSaving = true;
    try {
      const res = await api.skills.resetRankingConfig();
      rankingConfig = { ...res.config };
      toast.success("Ranking config reset to defaults");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to reset ranking config");
    } finally {
      rankingSaving = false;
    }
  }

  function toggleRankingPanel() {
    rankingOpen = !rankingOpen;
    if (rankingOpen && Object.keys(rankingConfig).length === 0) {
      loadRankingConfig();
    }
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
      <select bind:value={filterType}>
        <option value="">All Types</option>
        <option value="api">API Bridge</option>
        <option value="dcc">DCC Bridge</option>
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
      <select bind:value={filterEnabled}>
        <option value="">All Status</option>
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled</option>
      </select>
      <select bind:value={filterKeyword}>
        <option value="">All Keywords</option>
        {#each allKeywords as kw}
          <option value={kw}>{kw}</option>
        {/each}
      </select>
      <input type="text" placeholder="Search skills..." bind:value={filterSearch} class="filter-search" />
      {#if activeFilterCount > 0}
        <button class="btn-secondary filter-clear" onclick={clearAllFilters}>
          Clear ({activeFilterCount})
        </button>
      {/if}
    </div>
    <div class="toolbar-actions">
      <button class="btn-secondary" onclick={() => (createOpen = true)}>Create Skill</button>
      <button class="btn-secondary" onclick={openRegistry}>Browse Registry</button>
      <button class="btn-secondary" onclick={pullAll} disabled={pullingAll}>
        {pullingAll ? "Pulling..." : "Pull from Bridge Repo"}
      </button>
      {#if selectedSlugs.size > 0}
        <span class="badge badge-selection">{selectedSlugs.size} selected</span>
      {/if}
      <button class="btn-secondary" onclick={exportSkills}>{selectedSlugs.size > 0 ? "Export Selected" : "Export All"}</button>
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

  <!-- Ranking Tuning -->
  <div class="ranking-section">
    <button class="ranking-toggle" onclick={toggleRankingPanel}>
      <span class="ranking-arrow">{rankingOpen ? "v" : ">"}</span>
      Ranking Tuning
    </button>
    {#if rankingOpen}
      <div class="ranking-panel">
        {#if rankingLoading}
          <p class="muted">Loading...</p>
        {:else}
          <p class="ranking-hint">Configure how skills are ranked when matched to agent prompts. Weights should sum to 1.0 for best results.</p>
          <div class="ranking-grid">
            {#each RANKING_FIELDS as field}
              <div class="ranking-field">
                <label for="rc-{field.key}">{field.label}</label>
                <p class="ranking-field-hint">{field.hint}</p>
                <div class="ranking-input-row">
                  <input
                    id="rc-{field.key}"
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    bind:value={rankingConfig[field.key]}
                  />
                  {#if rankingDefaults[field.key] !== undefined}
                    <span class="ranking-default">default: {rankingDefaults[field.key]}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
          <div class="ranking-actions">
            <button class="btn-primary" onclick={saveRankingConfig} disabled={rankingSaving}>
              {rankingSaving ? "Saving..." : "Save"}
            </button>
            <button class="btn-secondary" onclick={resetRankingConfig} disabled={rankingSaving}>
              Reset to Defaults
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Skills Table -->
  <table class="table">
    <thead>
      <tr>
        <th class="th-check">
          <input
            type="checkbox"
            checked={filteredSkills.length > 0 && selectedSlugs.size === filteredSkills.length}
            onclick={toggleSelectAll}
          />
        </th>
        <th>Slug</th>
        <th>Title</th>
        <th>Bridge</th>
        <th>Category</th>
        <th>Source</th>
        <th>Uses</th>
        <th>Success</th>
        <th>Playbooks</th>
        <th>Enabled</th>
        <th style="width:24px"></th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr><td colspan="12" class="muted">Loading skills...</td></tr>
      {:else if filteredSkills.length === 0}
        <tr><td colspan="12" class="muted">
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
          {@const key = skillKey(skill)}
          <tr>
            <td class="td-check">
              <input
                type="checkbox"
                checked={selectedSlugs.has(key)}
                onclick={() => toggleSelect(key)}
              />
            </td>
            <td class="mono">{skill.slug}</td>
            <td>{skill.title}</td>
            <td class="muted">{skill.program || "-"}</td>
            <td><span class="badge badge-cat">{skill.category}</span></td>
            <td><span class="badge {skill.source === 'user' ? 'badge-custom' : skill.source === 'registry' ? 'badge-registry' : skill.source === 'training' ? 'badge-training' : skill.source === 'bridge-repo' ? 'badge-bridge-repo' : skill.source === 'repo' ? 'badge-repo' : 'badge-default'}">{skill.source}{skill.source === 'repo' && skill.repoModified ? ' (modified)' : ''}</span></td>
            <td class="mono">{eff?.totalUsed ?? "-"}{eff && eff.pendingOutcomes > 0 ? ` (${eff.totalUsed - eff.pendingOutcomes} rated)` : ""}</td>
            <td>
              {#if eff && (eff.totalUsed - eff.pendingOutcomes) > 0}
                {@const pct = Math.round(eff.successRate * 100)}
                <span class="badge {pct >= 70 ? 'badge-ok' : pct >= 40 ? 'badge-warn' : 'badge-bad'}">{pct}%</span>
              {:else if eff && eff.totalUsed > 0}
                <span class="muted" title="{eff.pendingOutcomes} pending">pending</span>
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
            <td style="text-align:center">{#if skill.locked}<span title="Locked">&#128274;</span>{/if}</td>
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
<Modal title="Skill Detail" open={detailSkill !== null} onclose={() => { detailSkill = null; editMode = false; }}>
  {#if detailSkill}
    <div class="detail-toolbar">
      <button class="btn-secondary btn-small" onclick={startEdit} disabled={editMode || viewingOldVersion || detailSkill.locked} title={detailSkill.locked ? "Skill is locked" : ""}>Edit</button>
      <button class="btn-secondary btn-small" onclick={toggleLock}>{detailSkill.locked ? "Unlock" : "Lock"}</button>
      <button class="btn-secondary btn-small" onclick={exportSingleSkill}>Export</button>
      <button class="btn-secondary btn-small" onclick={() => { detailSkill = null; editMode = false; }}>Close</button>
    </div>

    <!-- Version selector -->
    {#if versions.length > 0}
      <div class="version-selector">
        <select bind:value={selectedVersionNumber}>
          <option value={currentVersion}>v{currentVersion} · current</option>
          {#each versions.filter(v => v.version !== currentVersion) as v}
            <option value={v.version}>v{v.version} · {versionTimeAgo(v.createdAt)}</option>
          {/each}
        </select>
        {#if viewingOldVersion}
          <button class="btn-primary btn-small restore-btn" onclick={() => rollbackToVersion(selectedVersionNumber)}>Restore this version</button>
          <button class="btn-danger-sm" onclick={deleteSelectedVersion}>Delete Version</button>
        {/if}
      </div>
    {/if}

    {#if editMode}
      <!-- Edit Mode -->
      <div class="detail-grid">
        <div><strong>Slug:</strong> <span class="mono">{detailSkill.slug}</span></div>
        <div><strong>Name:</strong> {detailSkill.name}</div>
        <div><strong>Title:</strong> {detailSkill.title}</div>
        <div><strong>Bridge:</strong> {detailSkill.program || "-"}</div>
        <div><strong>Category:</strong> {detailSkill.category}</div>
        <div><strong>Source:</strong> {detailSkill.source}{detailSkill.source === 'repo' && detailSkill.repoModified ? ' (modified)' : ''}</div>
        {#if detailSkill.sourcePath}
          <div><strong>Source Path:</strong> <span class="mono">{detailSkill.sourcePath}</span></div>
        {/if}
      </div>
      <label class="field">
        <span>Description</span>
        <input type="text" bind:value={editDescription} />
      </label>
      <label class="field">
        <span>Keywords (comma-separated)</span>
        <input type="text" bind:value={editKeywords} />
      </label>
      <label class="field">
        <span>Priority</span>
        <input type="number" bind:value={editPriority} min="0" max="100" />
      </label>
      <div class="field-row">
        <label class="field checkbox-field">
          <input type="checkbox" bind:checked={editEnabled} />
          <span>Enabled</span>
        </label>
        <label class="field checkbox-field">
          <input type="checkbox" bind:checked={editAutoFetch} />
          <span>Auto-fetch</span>
        </label>
      </div>
      <label class="field">
        <span>Content</span>
        <textarea bind:value={editContent} rows="15" class="content-editor"></textarea>
      </label>
      <label class="field">
        <span>Related Skills</span>
        {#if editRelatedSkills.length > 0}
          <div class="related-chip-list">
            {#each editRelatedSkills as relSlug}
              <span class="related-chip">
                {relSlug}
                <button type="button" class="chip-remove" onclick={() => removeRelatedSkill(relSlug)} aria-label="Remove">×</button>
              </span>
            {/each}
          </div>
        {/if}
        <select
          bind:value={relatedPickerValue}
          onchange={(e) => { addRelatedSkill(e.currentTarget.value); e.currentTarget.value = ""; }}
        >
          <option value="">+ Add related skill…</option>
          {#each skills.filter(s => s.slug !== detailSkill?.slug && !editRelatedSkills.includes(s.slug)) as s}
            <option value={s.slug}>{s.slug}{s.program ? " (" + s.program + ")" : ""}</option>
          {/each}
        </select>
      </label>
      <div class="actions">
        <button class="btn-secondary" onclick={() => { editMode = false; }}>Cancel</button>
        <button class="btn-primary" onclick={saveEdit} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
      </div>
    {:else}
      <!-- Read-only Mode -->
      <div class="detail-grid">
        <div><strong>Slug:</strong> <span class="mono">{detailSkill.slug}</span></div>
        <div><strong>Name:</strong> {detailSkill.name}</div>
        <div><strong>Title:</strong> {detailSkill.title}</div>
        <div><strong>Bridge:</strong> {detailSkill.program || "-"}</div>
        <div><strong>Category:</strong> {detailSkill.category}</div>
        <div><strong>Source:</strong> {detailSkill.source}{detailSkill.source === 'repo' && detailSkill.repoModified ? ' (modified)' : ''}</div>
        <div><strong>Enabled:</strong> {detailSkill.enabled ? "Yes" : "No"}</div>
        <div><strong>Priority:</strong> {detailSkill.priority}</div>
        <div><strong>Auto-fetch:</strong> {detailSkill.autoFetch ? "Yes" : "No"}</div>
        <div><strong>Locked:</strong> {detailSkill.locked ? "Yes" : "No"}</div>
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
          {#if loadingPlaybooks}
            <p class="muted">Loading playbook content...</p>
          {:else if playbookContent.length > 0}
            {#each playbookContent as pb}
              <div class="playbook-entry">
                <button class="playbook-toggle" onclick={() => togglePlaybook(pb.path)}>
                  <span class="playbook-arrow">{expandedPlaybooks.has(pb.path) ? "v" : ">"}</span>
                  <span class="mono">{pb.path}</span>
                </button>
                {#if pb.error}
                  <div class="playbook-error">{pb.error}</div>
                {:else if expandedPlaybooks.has(pb.path) && pb.content}
                  <pre class="playbook-content-view">{formatPlaybookContent(pb.content)}</pre>
                {/if}
              </div>
            {/each}
          {:else}
            <div class="playbook-list">
              {#each detailSkill.playbooks as pb}
                <div class="playbook-entry mono">{pb}</div>
              {/each}
            </div>
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
      {#if viewingOldVersion && selectedVersionData}
        <label class="field">
          <span>Content (v{selectedVersionNumber})</span>
          <textarea rows="10" value={selectedVersionData.content} readonly class="content-viewer"></textarea>
        </label>
      {:else}
        <label class="field">
          <span>Content</span>
          <textarea rows="10" value={detailSkill.content} readonly class="content-viewer"></textarea>
        </label>
      {/if}
    {/if}
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
        <option value="project-reference">project-reference</option>
        <option value="housekeeping">housekeeping</option>
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
      <span>Priority</span>
      <input type="number" bind:value={createPriority} min="0" max="100" />
    </label>
    <div class="field-row">
      <label class="field checkbox-field">
        <input type="checkbox" bind:checked={createEnabled} />
        <span>Enabled</span>
      </label>
      <label class="field checkbox-field">
        <input type="checkbox" bind:checked={createAutoFetch} />
        <span>Auto-fetch</span>
      </label>
    </div>
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
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-search { min-width: 180px; padding: 5px 8px; background: var(--bg-elevated, rgba(255,255,255,0.04)); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); }
  .filter-clear { font-size: var(--font-size-sm); }
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
  .btn-danger-sm { background: rgba(220, 50, 50, 0.15); color: #e05555; border: none; padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-sm); cursor: pointer; }
  .btn-danger-sm:hover { background: rgba(220, 50, 50, 0.25); }
  .actions-cell { display: flex; gap: 6px; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .field { display: block; margin-bottom: 10px; }
  .field span { display: block; margin-bottom: 3px; color: var(--text-secondary); font-size: 11px; }
  .field input, .field textarea, .field select { width: 100%; }
  .field-row { display: flex; gap: 16px; margin-bottom: 12px; }
  .checkbox-field { display: flex; align-items: center; gap: 6px; margin-bottom: 0; }
  .checkbox-field input[type="checkbox"] { width: auto; }
  .checkbox-field span { display: inline; margin-bottom: 0; }
  .hint { color: var(--text-secondary); margin-bottom: 12px; }
  .summary { margin-top: 12px; color: var(--text-muted); font-size: var(--font-size-sm); }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 12px; margin-bottom: 10px; font-size: var(--font-size-sm); }
  .detail-grid strong { font-size: 11px; color: var(--text-muted); }
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
  .badge-repo { color: #7cc8d8; background: rgba(124, 200, 216, 0.12); }
  .badge-playbook { color: #d8c87c; background: rgba(216, 200, 124, 0.12); }
  .hidden-file-input { display: none; }
  .detail-section { margin-bottom: 12px; }
  .detail-section strong { display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .playbook-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .playbook-entry { font-size: var(--font-size-sm); margin-bottom: 4px; }
  .playbook-toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--link, #6bb8ff); cursor: pointer; padding: 2px 0; text-align: left; width: 100%; font-size: var(--font-size-sm); }
  .playbook-toggle:hover { text-decoration: underline; }
  .playbook-arrow { font-family: var(--font-mono); font-size: 0.75em; width: 10px; flex-shrink: 0; color: var(--text-muted); }
  .playbook-content-view { white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.8em; max-height: 400px; overflow-y: auto; padding: 8px; background: var(--bg-elevated, rgba(0,0,0,0.2)); border-radius: var(--radius-sm); margin-top: 4px; }
  .playbook-error { color: #e05555; font-size: var(--font-size-sm); }
  .related-skills { display: flex; flex-wrap: wrap; gap: 6px; }
  .related-chip-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .related-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: var(--bg-elevated, rgba(255,255,255,0.05)); border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 0.82em; }
  .related-chip .chip-remove { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0 2px; font-size: 1em; line-height: 1; }
  .related-chip .chip-remove:hover { color: #e05555; }
  .registry-list { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; margin-bottom: 12px; }
  .registry-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .registry-info { flex: 1; min-width: 0; }
  .registry-title { font-weight: 500; margin-bottom: 4px; }
  .registry-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .registry-version { color: var(--text-muted); font-size: 11px; }
  .registry-desc { color: var(--text-secondary); font-size: var(--font-size-sm); }
  .registry-action { flex-shrink: 0; }
  .ranking-section { margin-bottom: 14px; }
  .ranking-toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 6px 0; font-size: var(--font-size-sm); font-weight: 500; }
  .ranking-toggle:hover { color: var(--text-primary); }
  .ranking-arrow { font-family: var(--font-mono); font-size: 0.75em; width: 10px; color: var(--text-muted); }
  .ranking-panel { padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-surface); margin-top: 6px; }
  .ranking-hint { font-size: var(--font-size-xs); color: var(--text-muted); margin-bottom: 12px; line-height: 1.4; }
  .ranking-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; max-width: 720px; }
  .ranking-field label { display: block; font-size: var(--font-size-sm); font-weight: 600; color: var(--text-primary); margin-bottom: 1px; }
  .ranking-field-hint { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; line-height: 1.3; }
  .ranking-input-row { display: flex; align-items: center; gap: 8px; }
  .ranking-input-row input { width: 100px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary); font-size: var(--font-size-sm); }
  .ranking-default { font-size: 11px; color: var(--text-muted); }
  .ranking-actions { display: flex; gap: 8px; margin-top: 14px; }
  .th-check, .td-check { width: 32px; text-align: center; }
  .th-check input, .td-check input { cursor: pointer; }
  .badge-selection { color: var(--accent); background: rgba(78, 156, 230, 0.12); display: inline-flex; align-items: center; font-size: var(--font-size-sm); padding: 4px 10px; border-radius: 999px; }
  .detail-toolbar { display: flex; gap: 8px; margin-bottom: 8px; justify-content: flex-end; }
  .content-editor {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    resize: vertical;
    min-height: 280px;
  }
  .version-selector { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .version-selector select { font-size: var(--font-size-sm); padding: 4px 8px; background: var(--bg-elevated, #1e1e24); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .restore-btn { font-weight: 600; }
</style>
