<script lang="ts">
  import { connection } from "../lib/stores/connection.svelte";
  import { api } from "../lib/api/rest";
  import { communitySkills } from "../lib/stores/communitySkills.svelte";
  import { loadSettings as loadCommunitySettings } from "../lib/api/community";
  import SkillCard from "../lib/components/community/SkillCard.svelte";
  import SkillDetailModal from "../lib/components/community/SkillDetailModal.svelte";
  import PublishModal from "../lib/components/community/PublishModal.svelte";
  import LocalSkillCard from "../lib/components/skills/LocalSkillCard.svelte";
  import type { SkillEntry, SkillEffectiveness } from "../lib/types/skills";

  const canManage = $derived(connection.canEditCoordinator || connection.userRole === "admin");
  const isAdmin = $derived(connection.userRole === "admin");

  // Programs (bridges)
  let programs = $state<Array<{ value: string; label: string }>>([{ value: "global", label: "Global" }]);

  // API bridges for type detection
  let apiBridgeNames = $state<Set<string>>(new Set());

  // Skills state
  let serverSkills = $state<SkillEntry[]>([]);
  let skillsLoading = $state(false);
  let skillEffectiveness = $state<Record<string, SkillEffectiveness>>({});

  // Filters
  let skillsFilter = $state("");
  let skillFilterProgram = $state("");
  let skillFilterCategory = $state("");
  let skillFilterSource = $state("");
  let skillFilterType = $state<"" | "api" | "dcc">("");
  let skillFilterEnabled = $state<"" | "enabled" | "disabled">("");
  let skillFilterKeyword = $state("");
  let skillSort = $state<"name" | "newest" | "oldest">("newest");
  let skillCardSize = $state(Number(localStorage.getItem("ark-skill-card-size") ?? "200"));

  // Active filter count (for clear-all badge)
  const activeFilterCount = $derived(
    (skillFilterProgram ? 1 : 0) +
    (skillFilterCategory ? 1 : 0) +
    (skillFilterSource ? 1 : 0) +
    (skillFilterType ? 1 : 0) +
    (skillFilterEnabled ? 1 : 0) +
    (skillFilterKeyword ? 1 : 0) +
    (skillsFilter ? 1 : 0)
  );

  // Skill detail/edit state
  let skillViewSlug = $state<string | null>(null);
  let skillViewData = $state<SkillEntry | null>(null);
  let skillViewPlaybooks = $state<Array<{ path: string; content: string | null; error?: string }>>([]);
  let skillViewEffectiveness = $state<{ totalUsed: number; successRate: number; pendingOutcomes: number; goodOutcomes: number; averageOutcomes: number; poorOutcomes: number } | null>(null);
  let skillViewFeedback = $state<Array<{ jobOutcome: string; ratingNotes?: string; relevance?: string; accuracy?: string; completeness?: string; createdAt: string }>>([]);
  let skillViewLoading = $state(false);
  let skillEditMode = $state(false);
  let skillEditContent = $state("");
  let skillEditDescription = $state("");
  let skillEditKeywords = $state("");
  let skillEditPriority = $state(50);
  let skillEditEnabled = $state(true);
  let skillEditAutoFetch = $state(false);
  let skillSaving = $state(false);
  let skillVersions = $state<Array<{ id: string; version: number; content: string; keywords: string[]; description: string; createdAt: string }>>([]);
  let skillCurrentVersion = $state(0);
  let selectedVersionNumber = $state(0);
  let expandedPlaybooks = $state<Set<string>>(new Set());

  // Create skill state
  let skillCreateOpen = $state(false);
  let skillCreateName = $state("");
  let skillCreateSlug = $state("");
  let skillCreateProgram = $state("global");
  let skillCreateCategory = $state<string>("custom");
  let skillCreateTitle = $state("");
  let skillCreateDescription = $state("");
  let skillCreateKeywords = $state("");
  let skillCreateContent = $state("");
  let skillCreatePriority = $state(50);
  let skillCreateAutoFetch = $state(false);
  let skillCreateEnabled = $state(true);
  let skillCreateSaving = $state(false);
  let skillsPulling = $state(false);
  let selectedSkillKeys = $state(new Set<string>());
  let selectedCommunityIds = $state(new Set<string>());
  let importSkillInput = $state<HTMLInputElement | undefined>(undefined);
  let refreshingSkills = $state(new Set<string>());

  // Community skills
  type SkillsView = "local" | "community";
  let skillsView = $state<SkillsView>("local");
  let communitySearchTimer: ReturnType<typeof setTimeout> | undefined;
  let communityEnabled = $derived(loadCommunitySettings().enabled);
  let communityInitialized = false;

  // Loading/feedback
  let loading = $state(false);
  let error = $state("");
  let info = $state("");

  // --- Derived values ---

  const skillCategories = $derived.by(() => {
    const set = new Set<string>();
    for (const s of serverSkills) if (s.category) set.add(s.category);
    return Array.from(set).sort();
  });

  const skillSources = $derived.by(() => {
    const set = new Set<string>();
    for (const s of serverSkills) if (s.source) set.add(s.source);
    return Array.from(set).sort();
  });

  const skillPrograms = $derived.by(() => {
    const set = new Set<string>();
    for (const s of serverSkills) {
      if (!s.program) continue;
      if (skillFilterType === "api" && !apiBridgeNames.has(s.program.toLowerCase())) continue;
      if (skillFilterType === "dcc" && s.program !== "global" && apiBridgeNames.has(s.program.toLowerCase())) continue;
      set.add(s.program);
    }
    return Array.from(set).sort();
  });

  const allKeywords = $derived.by(() => {
    const set = new Set<string>();
    for (const s of serverSkills) {
      if (s.keywords) for (const k of s.keywords) if (k.trim()) set.add(k.trim().toLowerCase());
    }
    return Array.from(set).sort();
  });

  const filteredSkills = $derived.by(() => {
    const q = skillsFilter.toLowerCase().trim();
    let list = [...serverSkills];

    if (skillFilterProgram) {
      list = list.filter((s) => s.program === skillFilterProgram);
    }
    if (skillFilterCategory) {
      list = list.filter((s) => s.category === skillFilterCategory);
    }
    if (skillFilterSource) {
      list = list.filter((s) => (s.source ?? "") === skillFilterSource);
    }
    if (skillFilterType === "api") {
      list = list.filter((s) => s.program && apiBridgeNames.has(s.program.toLowerCase()));
    } else if (skillFilterType === "dcc") {
      list = list.filter((s) => s.program === "global" || (s.program && !apiBridgeNames.has(s.program.toLowerCase())));
    }
    if (skillFilterEnabled === "enabled") {
      list = list.filter((s) => s.enabled !== false);
    } else if (skillFilterEnabled === "disabled") {
      list = list.filter((s) => s.enabled === false);
    }
    if (skillFilterKeyword) {
      const kw = skillFilterKeyword.toLowerCase();
      list = list.filter((s) => s.keywords?.some((k) => k.toLowerCase() === kw));
    }
    if (q) {
      list = list.filter(
        (s) =>
          s.slug.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q) ||
          (s.program ?? "").toLowerCase().includes(q) ||
          (s.category ?? "").toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q) ||
          (s.keywords ?? []).some((k) => k.toLowerCase().includes(q)),
      );
    }
    if (skillSort === "newest") {
      list.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    } else if (skillSort === "oldest") {
      list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    } else {
      list.sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  });

  const selectedInstallableCount = $derived.by(() => {
    let count = 0;
    for (const id of selectedCommunityIds) {
      if (!communitySkills.isInstalled(id)) count++;
    }
    return count;
  });

  const viewingOldVersion = $derived(selectedVersionNumber > 0 && selectedVersionNumber !== skillCurrentVersion);
  const selectedVersionData = $derived(skillVersions.find(v => v.version === selectedVersionNumber));

  // Clear program selection if it no longer matches the type filter
  $effect(() => {
    if (skillFilterProgram && !skillPrograms.includes(skillFilterProgram)) {
      skillFilterProgram = "";
    }
  });

  // Clear selection when filters change
  $effect(() => {
    skillsFilter;
    skillFilterProgram;
    skillFilterCategory;
    skillFilterSource;
    skillFilterType;
    skillFilterEnabled;
    skillFilterKeyword;
    selectedSkillKeys = new Set();
  });

  // --- Functions ---

  function skillKey(s: any): string {
    return (s.program || "global") + ":" + s.slug;
  }

  function switchToSkillsView(view: SkillsView) {
    skillsView = view;
    if (view === "community" && !communityInitialized) {
      communityInitialized = true;
      communitySkills.loadFilters();
      communitySkills.search();
      communitySkills.checkForUpdates();
    }
  }

  function publishSkillFromRow(skill: SkillEntry) {
    closeSkillView();
    communitySkills.publishPreselect = [{ slug: skill.slug, program: skill.program || "global" }];
    communitySkills.publishModalOpen = true;
  }

  function publishSelectedSkills() {
    const preselect = [...selectedSkillKeys].map(k => {
      const parts = k.split(":");
      return { program: parts[0], slug: parts.slice(1).join(":") };
    });
    communitySkills.publishPreselect = preselect;
    communitySkills.publishModalOpen = true;
  }

  async function batchInstallSelected() {
    const ids = [...selectedCommunityIds].filter((id) => !communitySkills.isInstalled(id));
    if (ids.length === 0) return;
    await communitySkills.batchInstall(ids);
    selectedCommunityIds = new Set();
  }

  function normalizeProgramKey(value: string): string {
    return String(value ?? "").trim().toLowerCase();
  }

  async function loadPrograms() {
    try {
      const [bridgesRes, apiBridgesRes] = await Promise.all([
        api.bridgeCommands.listBridges(),
        api.apiBridges.list().catch(() => []),
      ]);
      const knownKeys = new Set<string>();
      for (const bridge of Array.isArray(bridgesRes?.bridges) ? bridgesRes.bridges : []) {
        const key = normalizeProgramKey(String((bridge as any)?.program ?? ""));
        if (key) knownKeys.add(key);
      }
      const apiNames = new Set<string>();
      for (const ab of Array.isArray(apiBridgesRes) ? apiBridgesRes : []) {
        const name = normalizeProgramKey(String((ab as any)?.name ?? ""));
        if (name) { knownKeys.add(name); apiNames.add(name); }
      }
      apiBridgeNames = apiNames;
      for (const skill of serverSkills) {
        const sp = normalizeProgramKey(skill.program ?? "");
        if (sp && sp !== "global") knownKeys.add(sp);
      }
      knownKeys.add("global");
      programs = [...knownKeys].sort().map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
    } catch {
      // non-fatal
    }
  }

  async function loadSkills() {
    skillsLoading = true;
    try {
      const data = await api.skills.list();
      serverSkills = Array.isArray(data?.skills ?? data) ? (data?.skills ?? data) : [];
      const ids = serverSkills.map((s) => s.id).filter(Boolean);
      if (ids.length > 0) {
        try {
          const eff = await api.skills.batchEffectiveness(ids);
          skillEffectiveness = eff?.stats ?? {};
        } catch {
          skillEffectiveness = {};
        }
      }
    } catch (err: any) {
      error = err.message ?? "Failed to load skills";
    } finally {
      skillsLoading = false;
    }
  }

  async function viewSkill(slug: string, prog: string) {
    skillViewSlug = slug;
    skillViewData = null;
    skillViewPlaybooks = [];
    skillViewEffectiveness = null;
    skillViewLoading = true;
    skillVersions = [];
    skillCurrentVersion = 0;
    selectedVersionNumber = 0;
    try {
      const data = await api.skills.get(slug, prog);
      const skill = data?.skill ?? data;
      skillViewData = skill;
      const promises: Promise<void>[] = [];
      if (skill?.playbooks?.length > 0) {
        promises.push(
          api.skills.getPlaybookContent(slug, prog).then((pb: any) => {
            skillViewPlaybooks = pb?.playbooks ?? [];
          }).catch(() => { skillViewPlaybooks = []; })
        );
      }
      promises.push(
        api.skills.getEffectiveness(slug, prog).then((eff: any) => {
          skillViewEffectiveness = eff?.stats ?? null;
          skillViewFeedback = eff?.records ?? [];
        }).catch(() => { skillViewEffectiveness = null; skillViewFeedback = []; })
      );
      promises.push(
        api.skills.listVersions(slug, prog).then((vResult: any) => {
          skillVersions = vResult?.versions ?? [];
          skillCurrentVersion = vResult?.currentVersion ?? 0;
          selectedVersionNumber = skillCurrentVersion;
        }).catch(() => { skillVersions = []; })
      );
      await Promise.all(promises);
    } catch (err: any) {
      skillViewData = { id: "", slug, program: prog, category: "", title: slug, content: `Error: ${err.message}` } as any;
    } finally {
      skillViewLoading = false;
    }
  }

  function closeSkillView() {
    skillViewSlug = null;
    skillViewData = null;
    skillViewPlaybooks = [];
    skillViewEffectiveness = null;
    skillEditMode = false;
    expandedPlaybooks = new Set();
    selectedVersionNumber = 0;
  }

  function startSkillEdit() {
    if (!skillViewData) return;
    skillEditContent = skillViewData.content ?? "";
    skillEditDescription = skillViewData.description ?? "";
    skillEditKeywords = (skillViewData.keywords ?? []).join(", ");
    skillEditPriority = skillViewData.priority ?? 50;
    skillEditEnabled = skillViewData.enabled !== false;
    skillEditAutoFetch = skillViewData.autoFetch === true;
    skillEditMode = true;
  }

  async function saveSkillEdit() {
    if (!skillViewData) return;
    skillSaving = true;
    try {
      await api.skills.update(skillViewData.slug, {
        content: skillEditContent,
        description: skillEditDescription,
        keywords: skillEditKeywords.split(",").map((k: string) => k.trim()).filter(Boolean),
        priority: skillEditPriority,
        enabled: skillEditEnabled,
        autoFetch: skillEditAutoFetch,
      }, skillViewData.program);
      info = "Skill updated";
      skillEditMode = false;
      await viewSkill(skillViewData.slug, skillViewData.program);
      loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to update skill";
    }
    skillSaving = false;
  }

  async function rollbackSkillVersion(version: number) {
    if (!skillViewData) return;
    try {
      await api.skills.rollback(skillViewData.slug, version, skillViewData.program);
      info = `Rolled back to version ${version}`;
      await viewSkill(skillViewData.slug, skillViewData.program);
      loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to rollback skill";
    }
  }

  async function deleteSkillVersion(version: number) {
    if (!skillViewData) return;
    try {
      await api.skills.deleteVersion(skillViewData.slug, version, skillViewData.program);
      info = `Deleted version ${version}`;
      const vResult = await api.skills.listVersions(skillViewData.slug, skillViewData.program);
      skillVersions = vResult.versions ?? [];
      skillCurrentVersion = vResult.currentVersion ?? 0;
      selectedVersionNumber = skillCurrentVersion;
    } catch (err: any) {
      error = err.message ?? "Failed to delete version";
    }
  }

  async function exportViewedSkill() {
    if (!skillViewData) return;
    try {
      await api.skills.exportZip([skillViewData.slug]);
      info = "Skill exported";
    } catch (err: any) {
      error = err.message ?? "Failed to export skill";
    }
  }

  async function toggleSkillLock() {
    if (!skillViewData) return;
    try {
      const newLocked = !skillViewData.locked;
      await api.skills.update(skillViewData.slug, { locked: newLocked }, skillViewData.program);
      skillViewData = { ...skillViewData, locked: newLocked };
      info = newLocked ? "Skill locked" : "Skill unlocked";
      loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to toggle skill lock";
    }
  }

  async function editSkillFromTable(slug: string, prog: string) {
    await viewSkill(slug, prog);
    startSkillEdit();
  }

  function togglePlaybook(path: string) {
    const next = new Set(expandedPlaybooks);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedPlaybooks = next;
  }

  function formatPlaybookContent(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }

  async function createSkill() {
    const slug = skillCreateSlug.trim() || skillCreateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!slug || !skillCreateTitle.trim() || !skillCreateContent.trim()) {
      error = "Slug, title, and content are required.";
      return;
    }
    skillCreateSaving = true;
    try {
      const keywords = skillCreateKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      await api.skills.create({
        name: skillCreateName.trim() || slug,
        slug,
        program: skillCreateProgram || "global",
        category: skillCreateCategory || "custom",
        title: skillCreateTitle.trim(),
        description: skillCreateDescription.trim(),
        keywords: keywords.length > 0 ? keywords : [],
        content: skillCreateContent,
        priority: skillCreatePriority,
        autoFetch: skillCreateAutoFetch,
        enabled: skillCreateEnabled,
      });
      info = `Skill "${slug}" created.`;
      skillCreateOpen = false;
      skillCreateName = "";
      skillCreateSlug = "";
      skillCreateTitle = "";
      skillCreateDescription = "";
      skillCreateKeywords = "";
      skillCreateContent = "";
      skillCreatePriority = 50;
      skillCreateAutoFetch = false;
      skillCreateEnabled = true;
      await loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to create skill";
    } finally {
      skillCreateSaving = false;
    }
  }

  async function deleteSkill(slug: string, prog: string) {
    try {
      await api.skills.delete(slug, prog);
      info = `Deleted skill "${slug}".`;
      await loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to delete skill";
    }
  }

  async function importSkillsFromZip() {
    const file = importSkillInput?.files?.[0];
    if (!file) return;
    try {
      const result = await api.skills.importZip(file);
      info = `Imported ${result.imported} skills, updated ${result.updated}`;
      loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to import skills";
    }
    if (importSkillInput) importSkillInput.value = "";
  }

  async function exportSelectedSkills() {
    try {
      const slugs = selectedSkillKeys.size > 0
        ? [...selectedSkillKeys].map(k => k.split(":").slice(1).join(":"))
        : undefined;
      await api.skills.exportZip(slugs);
      info = `Exported ${slugs?.length ?? filteredSkills.length} skills`;
    } catch (err: any) {
      error = err.message ?? "Failed to export skills";
    }
  }

  async function pullAllSkills() {
    skillsPulling = true;
    try {
      const result = await api.skills.pullAll();
      info = `Updated ${result?.total ?? 0} skills from repo.`;
      await loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to pull skills";
    } finally {
      skillsPulling = false;
    }
  }

  async function refreshSkillFromSource(skill: SkillEntry) {
    const key = `${skill.program}:${skill.slug}`;
    refreshingSkills = new Set([...refreshingSkills, key]);
    try {
      // For community skills, pass communityId so the server can fetch from community API
      const opts: { communityId?: string; communityBaseUrl?: string } = {};
      if (skill.source === "community") {
        const cid = communitySkills.findCommunityId(skill.slug, skill.program);
        if (!cid) {
          error = "Cannot find community ID for this skill. Try reinstalling from community.";
          return;
        }
        opts.communityId = cid;
      }
      await api.skills.refreshFromSource(skill.slug, skill.program, opts);
      info = `Updated "${skill.title}" from source.`;
      await loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to refresh skill from source";
    } finally {
      const next = new Set(refreshingSkills);
      next.delete(key);
      refreshingSkills = next;
    }
  }

  async function pushSkillToServer(skill: SkillEntry) {
    try {
      await api.skills.create({
        name: skill.name || skill.slug,
        slug: skill.slug,
        program: skill.program,
        category: skill.category,
        title: skill.title,
        description: skill.description ?? "",
        content: skill.content ?? "",
        priority: skill.priority,
        autoFetch: skill.autoFetch,
      });
      info = `Pushed "${skill.slug}" to server.`;
      await loadSkills();
    } catch (err: any) {
      error = err.message ?? "Failed to push skill";
    }
  }

  function versionTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function clearAllFilters() {
    skillsFilter = "";
    skillFilterProgram = "";
    skillFilterCategory = "";
    skillFilterSource = "";
    skillFilterType = "";
    skillFilterEnabled = "";
    skillFilterKeyword = "";
  }

  function formatDateTime(iso: string | null | undefined): string {
    const value = String(iso ?? "").trim();
    if (!value) return "Not scheduled";
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return "Invalid date";
    return new Date(ts).toLocaleString();
  }

  // --- Init ---

  let initialized = false;
  $effect(() => {
    if (!canManage || initialized) return;
    initialized = true;
    void refreshAll();
  });

  $effect(() => {
    const handler = () => { void loadSkills(); };
    window.addEventListener("arkestrator:skills_updated", handler);
    return () => window.removeEventListener("arkestrator:skills_updated", handler);
  });

  async function refreshAll() {
    loading = true;
    error = "";
    info = "";
    try {
      await loadSkills();
      await loadPrograms();
      // Check for community updates in the background (non-blocking)
      if (communityEnabled && communitySkills.installedCount > 0) {
        communitySkills.checkForUpdates().catch(() => {});
      }
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="skills-page">
  <h2>Skills</h2>
  {#if !canManage}
    <div class="panel">
      <p>You don't have permission to manage skills.</p>
    </div>
  {:else}
    <!-- Filter bar -->
    <div class="filter-bar">
      <select class="filter-select" bind:value={skillFilterProgram}>
        <option value="">All Bridges</option>
        {#each skillPrograms as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
      <select class="filter-select" bind:value={skillFilterType}>
        <option value="">All Types</option>
        <option value="api">API Bridge</option>
        <option value="dcc">DCC Bridge</option>
      </select>
      <select class="filter-select" bind:value={skillFilterCategory}>
        <option value="">All Categories</option>
        {#each skillCategories as cat}
          <option value={cat}>{cat}</option>
        {/each}
      </select>
      <select class="filter-select" bind:value={skillFilterSource}>
        <option value="">All Sources</option>
        {#each skillSources as src}
          <option value={src}>{src}</option>
        {/each}
      </select>
      <select class="filter-select" bind:value={skillFilterEnabled}>
        <option value="">All Status</option>
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled</option>
      </select>
      <select class="filter-select" bind:value={skillFilterKeyword}>
        <option value="">All Keywords</option>
        {#each allKeywords as kw}
          <option value={kw}>{kw}</option>
        {/each}
      </select>
      {#if activeFilterCount > 0}
        <button class="btn secondary filter-clear" onclick={clearAllFilters}>
          Clear ({activeFilterCount})
        </button>
      {/if}
    </div>
    <input type="text" placeholder="Search skills..." bind:value={skillsFilter} class="filter-search" />

    <!-- Skills header with view toggle and actions -->
    <div class="skills-header">
      <div class="skills-header-left">
        {#if communityEnabled}
          <div class="skills-view-toggle">
            <button class="view-btn" class:active={skillsView === "local"} onclick={() => switchToSkillsView("local")}>
              Local
            </button>
            <button class="view-btn" class:active={skillsView === "community"} onclick={() => switchToSkillsView("community")}>
              Community
              {#if communitySkills.updateCount > 0}
                <span class="update-dot">{communitySkills.updateCount}</span>
              {/if}
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if skillsView === "local"}
      <!-- Local skills view -->
      <div class="skill-toolbar">
        <button class="btn secondary btn-select-all" onclick={() => {
              const allSelected = filteredSkills.length > 0 && filteredSkills.every(s => selectedSkillKeys.has(skillKey(s)));
              const next = new Set(selectedSkillKeys);
              if (allSelected) {
                filteredSkills.forEach(s => next.delete(skillKey(s)));
              } else {
                filteredSkills.forEach(s => next.add(skillKey(s)));
              }
              selectedSkillKeys = next;
            }}>
          {filteredSkills.length > 0 && filteredSkills.every(s => selectedSkillKeys.has(skillKey(s))) ? "Deselect All" : "Select All"}
        </button>
        <select class="skill-filter-select" bind:value={skillSort}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A-Z</option>
        </select>
        {#if selectedSkillKeys.size > 0}
          <span class="badge">{selectedSkillKeys.size} selected</span>
        {/if}
        <button class="btn secondary" onclick={exportSelectedSkills}>
          {selectedSkillKeys.size > 0 ? `Export Selected (${selectedSkillKeys.size})` : "Export All"}
        </button>
        {#if communityEnabled && selectedSkillKeys.size > 0}
          <button class="btn secondary" onclick={publishSelectedSkills}>
            Share Selected ({selectedSkillKeys.size})
          </button>
        {/if}
        <button class="btn secondary" onclick={() => importSkillInput?.click()}>
          Import
        </button>
        <input type="file" accept=".zip" style="display:none" bind:this={importSkillInput} onchange={importSkillsFromZip} />
        <button class="btn secondary" onclick={loadSkills} disabled={skillsLoading}>
          {skillsLoading ? "Loading..." : "Refresh"}
        </button>
        <button class="btn secondary" onclick={pullAllSkills} disabled={skillsPulling}>
          {skillsPulling ? "Updating..." : "Update All from Repo"}
        </button>
        {#if canManage}
          <button class="btn" onclick={() => { skillCreateOpen = !skillCreateOpen; skillCreateProgram = skillFilterProgram || "global"; }}>
            {skillCreateOpen ? "Cancel" : "Create Skill"}
          </button>
        {/if}
        <span class="zoom-control" title="Card size">
          <span class="zoom-icon">&#x1F50D;</span>
          <input type="range" min="140" max="320" step="10" bind:value={skillCardSize}
            oninput={() => localStorage.setItem("ark-skill-card-size", String(skillCardSize))} />
        </span>
      </div>

      {#if skillCreateOpen}
        <div class="skill-create-form">
          <div class="form-row">
            <label>Name <input type="text" bind:value={skillCreateName} placeholder="My Skill" /></label>
            <label>Slug <input type="text" bind:value={skillCreateSlug} placeholder="auto-generated" /></label>
          </div>
          <div class="form-row">
            <label>Bridge
              <select bind:value={skillCreateProgram}>
                <option value="global">Global</option>
                {#each programs as p}{#if p.value !== "global"}<option value={p.value}>{p.label}</option>{/if}{/each}
              </select>
            </label>
            <label>Category
              <select bind:value={skillCreateCategory}>
                <option value="custom">Custom</option>
                <option value="coordinator">Coordinator</option>
                <option value="bridge">Bridge</option>
                <option value="training">Training</option>
                <option value="playbook">Playbook</option>
                <option value="verification">Verification</option>
                <option value="project">Project</option>
                <option value="project-reference">Project Reference</option>
                <option value="housekeeping">Housekeeping</option>
              </select>
            </label>
          </div>
          <label>Title <input type="text" bind:value={skillCreateTitle} placeholder="Descriptive title" /></label>
          <label>Description <input type="text" bind:value={skillCreateDescription} placeholder="Brief description (optional)" /></label>
          <label>Keywords <input type="text" bind:value={skillCreateKeywords} placeholder="keyword1, keyword2 (comma-separated)" /></label>
          <div class="form-row">
            <label>Priority <input type="number" bind:value={skillCreatePriority} min="0" max="100" /></label>
            <label class="checkbox-label"><input type="checkbox" bind:checked={skillCreateEnabled} /> Enabled</label>
            <label class="checkbox-label"><input type="checkbox" bind:checked={skillCreateAutoFetch} /> Auto-fetch</label>
          </div>
          <label>Content <textarea rows="8" bind:value={skillCreateContent} spellcheck="false" placeholder="Skill instructions..."></textarea></label>
          <button class="btn" onclick={createSkill} disabled={skillCreateSaving}>{skillCreateSaving ? "Creating..." : "Create"}</button>
        </div>
      {/if}

      {#if error}<div class="error">{error}</div>{/if}
      {#if info}<div class="info">{info}</div>{/if}

      {#if skillsLoading}
        <p class="muted" style="text-align:center; padding: 16px;">Loading...</p>
      {:else if filteredSkills.length === 0}
        <p class="muted" style="text-align:center; padding: 16px;">
          {#if serverSkills.length === 0}No skills loaded. <button class="btn-link" onclick={pullAllSkills}>Update All from Repo</button>{:else}No match.{/if}
        </p>
      {:else}
        <div class="skill-card-grid" style="grid-template-columns: repeat(auto-fill, minmax({skillCardSize}px, 1fr)); --card-scale: {skillCardSize / 200}">
          {#each filteredSkills as skill (skill.id)}
            {@const key = skillKey(skill)}
            <LocalSkillCard
              {skill}
              effectiveness={skillEffectiveness[skill.id] ?? null}
              selected={selectedSkillKeys.has(key)}
              hasUpdate={skill.source === "community" && communitySkills.hasUpdateForLocal(skill.slug, skill.program)}
              onselect={() => {
                const next = new Set(selectedSkillKeys);
                if (next.has(key)) next.delete(key); else next.add(key);
                selectedSkillKeys = next;
              }}
              onview={() => viewSkill(skill.slug, skill.program)}
            />
          {/each}
        </div>
      {/if}
      <p class="mini">{filteredSkills.length} skill{filteredSkills.length !== 1 ? "s" : ""}</p>

    {:else}
      <!-- Community view -->
      <div class="community-toolbar">
        <input
          type="text"
          class="filter-search"
          placeholder="Search community skills..."
          value={communitySkills.searchQuery}
          oninput={(e) => {
            communitySkills.searchQuery = (e.target as HTMLInputElement).value;
            selectedCommunityIds = new Set();
            clearTimeout(communitySearchTimer);
            communitySearchTimer = setTimeout(() => communitySkills.search(), 300);
          }}
        />
        <select class="filter-select" value={communitySkills.programFilter} onchange={(e) => { communitySkills.programFilter = (e.target as HTMLSelectElement).value; selectedCommunityIds = new Set(); communitySkills.search(); }}>
          <option value="">All Programs</option>
          {#each communitySkills.programs as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
        <select class="filter-select" value={communitySkills.categoryFilter} onchange={(e) => { communitySkills.categoryFilter = (e.target as HTMLSelectElement).value; selectedCommunityIds = new Set(); communitySkills.search(); }}>
          <option value="">All Categories</option>
          {#each communitySkills.categories as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={communitySkills.showOfficial} />
          Official
        </label>
        <button
          class="btn secondary"
          onclick={() => communitySkills.checkForUpdates()}
          disabled={communitySkills.checkingUpdates}
        >
          {communitySkills.checkingUpdates ? "Checking..." : "Check Updates"}
          {#if communitySkills.updateCount > 0}
            <span class="update-dot">{communitySkills.updateCount}</span>
          {/if}
        </button>
        <button class="btn secondary" onclick={() => communitySkills.search()} disabled={communitySkills.loading}>
          {communitySkills.loading ? "Loading..." : "Refresh"}
        </button>
        <button class="btn" onclick={() => { communitySkills.publishPreselect = null; communitySkills.publishModalOpen = true; }}>
          Publish
        </button>
        <span class="toolbar-separator"></span>
        <button class="btn secondary btn-select-all" onclick={() => {
          const allSelected = communitySkills.filteredSkills.length > 0 && communitySkills.filteredSkills.every(s => selectedCommunityIds.has(s.id));
          const next = new Set(selectedCommunityIds);
          if (allSelected) {
            communitySkills.filteredSkills.forEach(s => next.delete(s.id));
          } else {
            communitySkills.filteredSkills.forEach(s => next.add(s.id));
          }
          selectedCommunityIds = next;
        }}>
          {communitySkills.filteredSkills.length > 0 && communitySkills.filteredSkills.every(s => selectedCommunityIds.has(s.id)) ? "Deselect All" : "Select All"}
        </button>
        {#if selectedCommunityIds.size > 0}
          <span class="badge">{selectedCommunityIds.size} selected</span>
        {/if}
        {#if selectedInstallableCount > 0}
          <button class="btn" onclick={batchInstallSelected} disabled={communitySkills.batchInstalling}>
            {communitySkills.batchInstalling
              ? `Installing (${communitySkills.batchProgress}/${communitySkills.batchTotal})...`
              : `Install Selected (${selectedInstallableCount})`}
          </button>
        {/if}
      </div>

      {#if communitySkills.error}
        <div class="community-error">
          <span>{communitySkills.error}</span>
          <button class="btn-sm" onclick={() => communitySkills.search()}>Retry</button>
        </div>
      {/if}

      <div class="skill-card-grid" style="grid-template-columns: repeat(auto-fill, minmax({skillCardSize}px, 1fr)); --card-scale: {skillCardSize / 200}">
        {#each communitySkills.filteredSkills as skill (skill.id)}
          {@const installed = communitySkills.getInstalled(skill.id)}
          <SkillCard
            {skill}
            {installed}
            hasUpdate={communitySkills.hasUpdate(skill.id)}
            busy={communitySkills.installingIds.has(skill.id)}
            selected={selectedCommunityIds.has(skill.id)}
            onselect={() => {
              const next = new Set(selectedCommunityIds);
              if (next.has(skill.id)) next.delete(skill.id); else next.add(skill.id);
              selectedCommunityIds = next;
            }}
            onview={() => communitySkills.viewDetail(skill)}
            oninstall={() => communitySkills.install(skill.id)}
            ontoggle={() => communitySkills.toggleEnabled(skill.id)}
            onupdate={() => communitySkills.updateSkill(skill.id)}
            onuninstall={() => communitySkills.uninstall(skill.id)}
          />
        {/each}
      </div>

      {#if communitySkills.loading}
        <p class="muted" style="text-align:center; padding: 16px;">Loading...</p>
      {/if}

      {#if !communitySkills.loading && communitySkills.filteredSkills.length === 0 && !communitySkills.error}
        <p class="muted" style="text-align:center; padding: 16px;">
          {#if communitySkills.skills.length > 0 && !communitySkills.showOfficial}
            No community skills found. <button class="btn-link" onclick={() => communitySkills.showOfficial = true}>Show official skills</button>
          {:else}
            No community skills found.
          {/if}
        </p>
      {/if}

      {#if communitySkills.hasMore && !communitySkills.loading}
        <div style="text-align:center; padding: 12px;">
          <button class="btn secondary" onclick={() => communitySkills.loadMore()}>Load More</button>
        </div>
      {/if}

      {#if communitySkills.installedCount > 0}
        <p class="mini">{communitySkills.installedCount} installed &middot; {communitySkills.updateCount} update{communitySkills.updateCount !== 1 ? "s" : ""} available</p>
      {/if}
    {/if}

    <!-- Community modals -->
    {#if communitySkills.selectedSkill}
      <SkillDetailModal
        skill={communitySkills.selectedSkill}
        detail={communitySkills.selectedDetail}
        loading={communitySkills.detailLoading}
        installed={communitySkills.getInstalled(communitySkills.selectedSkill.id)}
        hasUpdate={communitySkills.hasUpdate(communitySkills.selectedSkill.id)}
        onclose={() => communitySkills.closeDetail()}
        oninstall={() => communitySkills.install(communitySkills.selectedSkill!.id)}
        onuninstall={() => communitySkills.uninstall(communitySkills.selectedSkill!.id)}
        ontoggle={() => communitySkills.toggleEnabled(communitySkills.selectedSkill!.id)}
        onupdate={() => communitySkills.updateSkill(communitySkills.selectedSkill!.id)}
      />
    {/if}
    {#if communitySkills.publishModalOpen}
      <PublishModal
        preselect={communitySkills.publishPreselect}
        onclose={() => { communitySkills.publishModalOpen = false; communitySkills.publishPreselect = null; }}
      />
    {/if}
  {/if}
</div>

<!-- Skill detail overlay modal -->
{#if skillViewSlug}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="skill-modal-overlay" onclick={closeSkillView}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="skill-modal-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="skill-view-header">
        <h4>{skillViewData?.title ?? skillViewSlug}</h4>
        <div class="skill-view-toolbar">
          {#if canManage && !skillEditMode && !viewingOldVersion}
            <button class="btn-sm" onclick={startSkillEdit} disabled={skillViewData?.locked} title={skillViewData?.locked ? "Skill is locked" : ""}>Edit</button>
            <button class="btn-sm" onclick={toggleSkillLock}>{skillViewData?.locked ? "Unlock" : "Lock"}</button>
          {/if}
          {#if skillViewData && (skillViewData.source === "bridge-repo" || skillViewData.source === "registry" || skillViewData.source === "community")}
            {@const rkey = `${skillViewData.program}:${skillViewData.slug}`}
            <button class="btn-sm" onclick={() => refreshSkillFromSource(skillViewData!)} disabled={refreshingSkills.has(rkey)}>
              {refreshingSkills.has(rkey) ? "Updating..." : "Update from Source"}
            </button>
          {/if}
          {#if canManage && !skillEditMode && skillViewData}
            <button class="btn-sm danger" onclick={() => { deleteSkill(skillViewData!.slug, skillViewData!.program); closeSkillView(); }}>Delete</button>
          {/if}
          {#if communityEnabled && skillViewData}
            <button class="btn-sm" onclick={() => publishSkillFromRow(skillViewData!)}>Share</button>
          {/if}
          <button class="btn-sm" onclick={exportViewedSkill}>Export</button>
          <button class="btn-sm" onclick={closeSkillView}>X</button>
        </div>
      </div>
      {#if skillViewLoading}
        <p class="muted">Loading...</p>
      {:else if skillViewData}
        {#if skillVersions.length > 0}
          <div class="skill-version-selector">
            <select bind:value={selectedVersionNumber}>
              <option value={skillCurrentVersion}>v{skillCurrentVersion} · current</option>
              {#each skillVersions.filter(v => v.version !== skillCurrentVersion) as v}
                <option value={v.version}>v{v.version} · {versionTimeAgo(v.createdAt)}</option>
              {/each}
            </select>
            {#if viewingOldVersion}
              <button class="btn-sm restore-btn" onclick={() => rollbackSkillVersion(selectedVersionNumber)}>Restore this version</button>
              <button class="btn-sm danger" onclick={() => deleteSkillVersion(selectedVersionNumber)}>Delete Version</button>
            {/if}
          </div>
        {/if}
        {#if skillEditMode}
          <div class="skill-edit-form">
            <label>
              <span class="label">Description</span>
              <input type="text" bind:value={skillEditDescription} placeholder="Short description" />
            </label>
            <label>
              <span class="label">Keywords</span>
              <input type="text" bind:value={skillEditKeywords} placeholder="comma separated" />
            </label>
            <div class="form-row">
              <label style="flex: 0 0 100px;">
                <span class="label">Priority</span>
                <input type="number" min="0" max="100" bind:value={skillEditPriority} />
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={skillEditEnabled} /> Enabled
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={skillEditAutoFetch} /> Auto-fetch
              </label>
            </div>
            <label>
              <span class="label">Content</span>
              <textarea rows="15" style="font-family: var(--font-mono); width: 100%; resize: vertical; font-size: 0.85em;" bind:value={skillEditContent}></textarea>
            </label>
            <div class="form-row" style="justify-content: flex-end;">
              <button class="btn-sm" onclick={() => { skillEditMode = false; }} disabled={skillSaving}>Cancel</button>
              <button class="btn-sm" onclick={saveSkillEdit} disabled={skillSaving}>{skillSaving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        {:else}
          <div class="skill-detail-grid">
            <div><strong>Slug:</strong> <span class="mono">{skillViewData.slug}</span></div>
            {#if skillViewData.name && skillViewData.name !== skillViewData.slug}
              <div><strong>Name:</strong> {skillViewData.name}</div>
            {/if}
            <div><strong>Bridge:</strong> {skillViewData.program || "-"}</div>
            <div><strong>Category:</strong> {skillViewData.category}</div>
            <div><strong>Source:</strong> {skillViewData.source ?? "-"}</div>
            {#if skillViewData.sourcePath}
              <div><strong>Source Path:</strong> <span class="mono mini">{skillViewData.sourcePath}</span></div>
            {/if}
            <div><strong>Priority:</strong> {skillViewData.priority ?? "-"}</div>
            <div><strong>Enabled:</strong> {skillViewData.enabled ? "Yes" : "No"}</div>
            <div><strong>Auto-fetch:</strong> {skillViewData.autoFetch ? "Yes" : "No"}</div>
            <div><strong>Locked:</strong> {skillViewData.locked ? "Yes" : "No"}</div>
            {#if skillViewData.keywords && skillViewData.keywords.length > 0}
              <div><strong>Keywords:</strong> {skillViewData.keywords.join(", ")}</div>
            {/if}
            {#if !skillViewData.autoFetch && skillViewEffectiveness}
              {@const rated = skillViewEffectiveness.totalUsed - (skillViewEffectiveness.pendingOutcomes ?? 0)}
              <div><strong>Uses:</strong> {skillViewEffectiveness.totalUsed}{skillViewEffectiveness.pendingOutcomes > 0 ? ` (${rated} rated)` : ""}</div>
              <div><strong>Success Rate:</strong>
                {#if rated > 0}
                  {@const pct = Math.round(skillViewEffectiveness.successRate * 100)}
                  <span class="badge {pct >= 70 ? 'success' : pct >= 40 ? 'warn' : 'bad'}">{pct}%</span>
                {:else if skillViewEffectiveness.totalUsed > 0}
                  <span class="muted">pending</span>
                {:else}
                  -
                {/if}
              </div>
              {#if rated > 0}
                <div><strong>Breakdown:</strong> {skillViewEffectiveness.goodOutcomes} good, {skillViewEffectiveness.averageOutcomes} avg, {skillViewEffectiveness.poorOutcomes} poor</div>
              {/if}
            {/if}
          </div>
          {#if skillViewData.description}
            <div class="skill-detail-desc">{skillViewData.description}</div>
          {/if}
          {#if skillViewFeedback.length > 0}
            <div class="skill-detail-section">
              <strong>Recent Feedback ({skillViewFeedback.length}):</strong>
              {#each skillViewFeedback as fb}
                <div class="feedback-entry" style="padding: 4px 0; border-bottom: 1px solid var(--border); font-size: var(--font-size-sm);">
                  <span class="badge {fb.jobOutcome === 'positive' ? 'success' : fb.jobOutcome === 'negative' ? 'bad' : 'warn'}">{fb.jobOutcome ?? "?"}</span>
                  {#if fb.relevance}<span class="muted" style="margin-left: 6px;">relevance: {fb.relevance}</span>{/if}
                  {#if fb.accuracy}<span class="muted" style="margin-left: 6px;">accuracy: {fb.accuracy}</span>{/if}
                  {#if fb.completeness}<span class="muted" style="margin-left: 6px;">completeness: {fb.completeness}</span>{/if}
                  {#if fb.ratingNotes}<div class="mini" style="margin-top: 2px; color: var(--text-secondary);">{fb.ratingNotes}</div>{/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if skillViewData.relatedSkills && skillViewData.relatedSkills.length > 0}
            <div class="skill-detail-section">
              <strong>Related Skills:</strong>
              {#each skillViewData.relatedSkills as rel}
                <button class="btn-link" onclick={() => viewSkill(rel, skillViewData?.program ?? "")}>{rel}</button>
              {/each}
            </div>
          {/if}
          {#if skillViewPlaybooks.length > 0}
            <div class="skill-detail-section">
              <strong>Playbooks ({skillViewPlaybooks.length}):</strong>
              {#each skillViewPlaybooks as pb}
                <div class="playbook-entry">
                  <button class="playbook-toggle" onclick={() => togglePlaybook(pb.path)}>
                    <span class="playbook-arrow">{expandedPlaybooks.has(pb.path) ? "v" : ">"}</span>
                    <span class="mono mini">{pb.path}</span>
                  </button>
                  {#if pb.error}
                    <span class="muted">{pb.error}</span>
                  {:else if expandedPlaybooks.has(pb.path) && pb.content}
                    <pre class="playbook-preview expanded">{formatPlaybookContent(pb.content)}</pre>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if viewingOldVersion && selectedVersionData}
            <div class="skill-detail-section">
              <strong>Content (v{selectedVersionNumber}):</strong>
              <pre class="skill-content">{selectedVersionData.content}</pre>
            </div>
          {:else if skillViewData.content}
            <div class="skill-detail-section">
              <strong>Content:</strong>
              <pre class="skill-content">{skillViewData.content}</pre>
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .skills-page {
    padding: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    /* no max-width — fill available space like Scripts tab */
  }
  h2 { font-size: var(--font-size-lg); margin-bottom: 12px; }
  h3 { font-size: var(--font-size-base); margin-bottom: 8px; color: var(--text-secondary); }

  /* Filter bar */
  .filter-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .filter-select {
    padding: 5px 8px;
    font-size: var(--font-size-sm);
    background: var(--bg-deep, rgba(0,0,0,0.2));
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    min-width: 120px;
  }
  .filter-search {
    min-width: 160px;
    max-width: 260px;
    padding: 6px 8px;
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .filter-clear {
    white-space: nowrap;
  }

  .panel { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); padding: 12px; margin-bottom: 12px; }
  .desc { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4; }
  .mini { font-size: 11px; color: var(--text-muted); }
  .muted { color: var(--text-muted); }
  .mono { font-family: var(--font-mono); word-break: break-all; }
  .error { margin-bottom: 10px; color: var(--status-failed); font-size: var(--font-size-sm); }
  .info { margin-bottom: 10px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .btn { padding: 4px 10px; font-size: var(--font-size-sm); border-radius: var(--radius-sm); background: var(--accent); color: #fff; border: none; cursor: pointer; }
  .btn:hover { opacity: 0.85; }
  .btn.secondary { border: 1px solid var(--border); background: var(--bg-base); color: var(--text-secondary); }
  .btn.secondary:hover { background: var(--bg-hover, rgba(255,255,255,0.12)); }
  label { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); color: var(--text-secondary); }
  textarea, input:not([type="checkbox"]):not([type="radio"]), select:not(.filter-select):not(.skill-filter-select) {
    width: 100%; background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px;
  }
  input[type="checkbox"] { width: auto; padding: 0; }
  textarea { font-family: var(--font-mono); line-height: 1.45; resize: both; max-width: 100%; min-height: 96px; }

  /* Skills */
  .skills-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .skills-header-left { display: flex; align-items: center; gap: 12px; }
  .skills-view-toggle { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .view-btn {
    padding: 4px 12px; font-size: 11px; background: var(--bg-surface); color: var(--text-secondary);
    border: none; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 4px;
  }
  .view-btn:not(:last-child) { border-right: 1px solid var(--border); }
  .view-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .view-btn.active { background: var(--accent); color: #fff; }
  .update-dot {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--status-running); color: #fff; border-radius: 10px;
    font-size: 9px; font-weight: 700; min-width: 14px; height: 14px; padding: 0 3px;
  }

  .skill-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .skill-filter-select { padding: 5px 8px; font-size: var(--font-size-sm); background: var(--bg-deep, rgba(0,0,0,0.2)); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); min-width: 120px; }
  .skill-card-grid { display: grid; gap: 10px; }
  .btn-select-all { white-space: nowrap; }
  .zoom-control { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .zoom-icon { font-size: 12px; opacity: 0.5; }
  .zoom-control input[type="range"] { width: 80px; accent-color: var(--accent); }

  .badge { font-size: 0.75em; padding: 1px 6px; border-radius: 8px; background: var(--bg-subtle, rgba(255,255,255,0.08)); color: var(--text-secondary); }
  .badge.success { background: rgba(80, 200, 120, 0.2); color: #50c878; }
  .badge.warn { background: rgba(255, 200, 50, 0.2); color: #ffc832; }
  .badge.bad { background: rgba(230, 80, 80, 0.2); color: #e65050; }

  .btn-sm { font-size: 0.8em; padding: 2px 8px; cursor: pointer; background: var(--bg-subtle, rgba(255,255,255,0.08)); border: 1px solid var(--border); border-radius: 3px; color: inherit; }
  .btn-sm:hover { background: var(--bg-hover, rgba(255,255,255,0.12)); }
  .btn-sm.danger { color: var(--danger, #e55); }
  .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; padding: 0; font-size: inherit; }
  .skill-create-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 4px; margin-bottom: 12px; background: var(--bg-subtle, rgba(255,255,255,0.03)); }
  .skill-create-form .form-row { display: flex; gap: 8px; }
  .skill-create-form .form-row > label { flex: 1; }
  .skill-create-form .checkbox-label { display: flex; align-items: center; gap: 6px; flex: 0; white-space: nowrap; }
  .skill-create-form .checkbox-label input[type="checkbox"] { width: auto; }

  .skill-modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.5); z-index: 650;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .skill-modal-dialog {
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 12px 16px; width: 100%; max-width: 640px; max-height: 85vh; overflow-y: auto;
  }
  .skill-view-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .skill-view-header h4 { font-size: 0.95em; margin: 0; }
  .skill-detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px 12px; font-size: 0.8em; margin-bottom: 8px; }
  .skill-detail-grid strong { color: var(--text-secondary); font-size: 11px; }
  .skill-detail-desc { font-size: 0.8em; color: var(--text-secondary); margin-bottom: 8px; padding: 4px 6px; background: var(--bg-deep, rgba(0,0,0,0.15)); border-radius: 4px; }
  .skill-detail-section { margin-bottom: 8px; font-size: 0.8em; }
  .skill-detail-section strong { display: block; margin-bottom: 2px; color: var(--text-secondary); font-size: 11px; }
  .playbook-entry { margin-bottom: 4px; }
  .playbook-toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--link, #6bb8ff); cursor: pointer; padding: 2px 0; text-align: left; width: 100%; }
  .playbook-toggle:hover { text-decoration: underline; }
  .playbook-arrow { font-family: var(--font-mono); font-size: 0.75em; width: 10px; flex-shrink: 0; color: var(--text-muted, #888); }
  .playbook-preview { white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.8em; max-height: 150px; overflow-y: auto; padding: 6px; background: var(--bg-deep, rgba(0,0,0,0.2)); border-radius: 4px; margin-top: 2px; }
  .playbook-preview.expanded { max-height: 400px; }
  .skill-content { white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.8em; max-height: 300px; overflow-y: auto; padding: 6px; background: var(--bg-deep, rgba(0,0,0,0.2)); border-radius: 4px; }
  .skill-view-toolbar { display: flex; gap: 6px; align-items: center; }
  .skill-edit-form { display: flex; flex-direction: column; gap: 8px; }
  .skill-edit-form label { display: flex; flex-direction: column; gap: 2px; font-size: var(--font-size-sm); }
  .skill-edit-form .label { color: var(--text-secondary); font-weight: 500; }
  .skill-edit-form .form-row { display: flex; gap: 8px; align-items: flex-end; }
  .skill-edit-form .checkbox-label { display: flex; flex-direction: row; align-items: center; gap: 6px; white-space: nowrap; }
  .skill-edit-form .checkbox-label input[type="checkbox"] { width: auto; }
  .skill-edit-form textarea { font-size: 0.85em; }
  .skill-version-selector { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .skill-version-selector select { font-size: var(--font-size-sm); padding: 3px 6px; background: var(--bg-deep, rgba(0,0,0,0.2)); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); }
  .restore-btn { background: var(--accent, #4e9ce6) !important; color: #fff !important; font-weight: 600; }

  .community-toolbar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
  .toolbar-separator { width: 1px; height: 20px; background: var(--border-light, rgba(255,255,255,0.08)); }
  .community-error {
    background: rgba(244, 71, 71, 0.1); border: 1px solid var(--status-failed); border-radius: var(--radius-sm);
    padding: 8px 12px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;
    font-size: var(--font-size-sm); color: var(--status-failed);
  }
</style>
