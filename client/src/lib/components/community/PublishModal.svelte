<script lang="ts">
  import { communityApi, loadSettings, saveSettings, type CommunityUser } from "../../api/community";
  import { api } from "../../api/rest";
  import { toast } from "../../stores/toast.svelte";
  import { open } from "@tauri-apps/plugin-shell";

  let { onclose, preselect }: {
    onclose: () => void;
    preselect?: { slug: string; program: string }[] | null;
  } = $props();

  let settings = $state(loadSettings());
  let hasToken = $derived(!!settings.authToken);

  // Auth state
  let tokenInput = $state("");
  let communityUser = $state<CommunityUser | null>(null);
  let loadingUser = $state(false);

  // Local skills for selection
  let localSkills = $state<any[]>([]);
  let loadingSkills = $state(false);
  let selectedSlug = $state(preselect?.[0]?.slug ?? "");
  let selectedProgram = $state(preselect?.[0]?.program ?? "");

  // MCP preset allowlist fetched from arkestrator.com. Used as a preflight
  // gate so user-local MCP bridge slugs (e.g. "my-test-mcp") cannot leak
  // into the community library. Empty array means the site hasn't shipped
  // /api/mcp-presets yet — in that case we skip the preflight and let the
  // server reject if needed (backward-compat rollout).
  let mcpPresetAllowlist = $state<Set<string>>(new Set());
  let allowlistLoaded = $state(false);

  // Batch publish state
  const isBatch = preselect && preselect.length > 1;
  let batchIndex = $state(0);
  let batchDone = $state(0);
  let batchErrors = $state<string[]>([]);
  let batchSkipped = $state(0);
  let publishing = $state(false);

  // Dependency inclusion
  let includeDeps = $state(true);

  // Community lookup for dependencies (slug → remote info)
  type DepStatus = "new" | "update" | "skip_official" | "skip_other" | "skip_identical";
  let depLookup = $state<Record<string, { status: DepStatus; version?: number }>>({});
  let lookupLoading = $state(false);

  // Load user info if token exists
  $effect(() => {
    if (hasToken && !communityUser) {
      loadingUser = true;
      communityApi.me()
        .then((u) => { communityUser = u; })
        .catch(() => { communityUser = null; })
        .finally(() => { loadingUser = false; });
    }
  });

  // Load local skills list
  $effect(() => {
    if (hasToken) {
      loadingSkills = true;
      api.skills.list()
        .then((result: any) => {
          localSkills = result?.skills ?? result ?? [];
        })
        .catch(() => { localSkills = []; })
        .finally(() => { loadingSkills = false; });
    }
  });

  // Fetch the MCP preset allowlist from arkestrator.com once per modal open.
  // Gracefully degrades to an empty set if the endpoint doesn't exist yet.
  $effect(() => {
    if (hasToken && !allowlistLoaded) {
      allowlistLoaded = true;
      communityApi.getMcpPresets()
        .then((presets) => {
          mcpPresetAllowlist = new Set(presets.map((p) => p.presetId));
        })
        .catch(() => { mcpPresetAllowlist = new Set(); });
    }
  });

  let selectedSkill = $derived(
    localSkills.find((s: any) => s.slug === selectedSlug && (!selectedProgram || s.program === selectedProgram))
  );

  // ---------------------------------------------------------------------------
  // Dependency resolution (client-side, operates on the in-memory localSkills)
  // ---------------------------------------------------------------------------

  function resolveLocalDeps(rootSlug: string, rootProgram: string): any[] {
    const visited = new Set<string>();
    const result: any[] = [];
    visited.add(`${rootSlug}::${rootProgram}`);

    const root = localSkills.find((s: any) => s.slug === rootSlug && s.program === rootProgram);
    if (!root?.relatedSkills?.length) return result;

    for (const depSlug of root.relatedSkills) {
      walkDeps(depSlug, rootProgram, visited, result);
    }
    return result;
  }

  function walkDeps(slug: string, preferProgram: string, visited: Set<string>, result: any[]) {
    // Prefer same program, then global, then any
    let skill = localSkills.find((s: any) => s.slug === slug && s.program === preferProgram);
    if (!skill) skill = localSkills.find((s: any) => s.slug === slug && s.program === "global");
    if (!skill) skill = localSkills.find((s: any) => s.slug === slug);
    if (!skill) return;

    const k = `${skill.slug}::${skill.program}`;
    if (visited.has(k)) return;
    visited.add(k);

    if (skill.relatedSkills?.length) {
      for (const depSlug of skill.relatedSkills) {
        walkDeps(depSlug, skill.program, visited, result);
      }
    }
    result.push(skill);
  }

  // Resolved deps for single-skill mode
  let resolvedDeps = $derived.by(() => {
    if (!selectedSkill || !includeDeps) return [];
    return resolveLocalDeps(selectedSkill.slug, selectedSkill.program);
  });

  // For batch mode, resolve all deps across all preselected skills
  let batchResolvedDeps = $derived.by(() => {
    if (!isBatch || !includeDeps || !preselect) return [];
    const seen = new Set<string>();
    const deps: any[] = [];
    for (const ps of preselect) {
      seen.add(`${ps.slug}::${ps.program}`);
    }
    for (const ps of preselect) {
      const skillDeps = resolveLocalDeps(ps.slug, ps.program);
      for (const dep of skillDeps) {
        const k = `${dep.slug}::${dep.program}`;
        if (!seen.has(k)) {
          seen.add(k);
          deps.push(dep);
        }
      }
    }
    return deps;
  });

  // All deps (before filtering)
  let allDeps = $derived(isBatch ? batchResolvedDeps : resolvedDeps);

  // Look up deps on community when they change
  $effect(() => {
    const deps = allDeps;
    if (deps.length === 0 || !communityUser) {
      depLookup = {};
      return;
    }
    lookupLoading = true;
    const slugs = deps.map((d: any) => d.slug);
    // Use the first dep's program as hint, but the lookup checks all
    const program = deps[0]?.program;
    communityApi.lookupSlugs(slugs, program).then((result) => {
      const lookup: Record<string, { status: DepStatus; version?: number }> = {};
      for (const dep of deps) {
        const remote = result[dep.slug];
        if (!remote) {
          lookup[dep.slug] = { status: "new" };
        } else if (remote.is_official) {
          lookup[dep.slug] = { status: "skip_official", version: remote.version };
        } else if (remote.author_username && remote.author_username !== communityUser!.username) {
          lookup[dep.slug] = { status: "skip_other", version: remote.version };
        } else {
          // Own skill — mark as update; server will skip if content is identical
          lookup[dep.slug] = { status: "update", version: remote.version };
        }
      }
      depLookup = lookup;
    }).catch(() => {
      // If lookup fails, treat all as new (safe fallback)
      const lookup: Record<string, { status: DepStatus }> = {};
      for (const dep of deps) {
        lookup[dep.slug] = { status: "new" };
      }
      depLookup = lookup;
    }).finally(() => {
      lookupLoading = false;
    });
  });

  // Deps that will actually be published (excluding skipped ones)
  let publishableDeps = $derived.by(() => {
    if (!includeDeps) return [];
    return allDeps.filter((dep: any) => {
      const info = depLookup[dep.slug];
      if (!info) return true; // lookup not done yet, include by default
      return info.status === "new" || info.status === "update";
    });
  });

  // Full publish list (publishable deps first, then main skills)
  let publishList = $derived.by(() => {
    if (isBatch) {
      const mainSkills = (preselect ?? []).map(ps =>
        localSkills.find((s: any) => s.slug === ps.slug && s.program === ps.program)
      ).filter(Boolean);
      return includeDeps ? [...publishableDeps, ...mainSkills] : mainSkills;
    } else {
      if (!selectedSkill) return [];
      return includeDeps ? [...publishableDeps, selectedSkill] : [selectedSkill];
    }
  });

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  async function openGitHubAuth() {
    const baseUrl = settings.baseUrl || "https://arkestrator.com";
    try {
      await open(`${baseUrl}/auth/github?from=desktop`);
    } catch {
      window.open(`${baseUrl}/auth/github?from=desktop`, "_blank");
    }
  }

  function saveToken() {
    if (!tokenInput.trim()) return;
    settings.authToken = tokenInput.trim();
    saveSettings(settings);
    tokenInput = "";
  }

  function disconnect() {
    settings.authToken = "";
    saveSettings(settings);
    communityUser = null;
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  /**
   * Preflight: skills tagged with a local-only MCP bridge slug (i.e. one
   * that isn't in arkestrator.com's registered preset allowlist) must not
   * leak into the community library. If the allowlist came back empty the
   * site hasn't shipped /api/mcp-presets yet — in that case we skip the
   * gate and let the server reject. Returns an error string, or null if OK.
   */
  function checkMcpAllowlist(skill: any): string | null {
    if (!skill.mcpPresetId) return null;
    if (mcpPresetAllowlist.size === 0) return null;
    if (mcpPresetAllowlist.has(skill.mcpPresetId)) return null;
    return `MCP preset "${skill.mcpPresetId}" is not a registered preset on arkestrator.com. Only skills tagged with official MCP presets (filesystem, github, context7, fetch, memory, brave-search, ...) can be published.`;
  }

  async function publishOne(skill: any) {
    const gateError = checkMcpAllowlist(skill);
    if (gateError) throw new Error(gateError);
    await communityApi.publish({
      title: skill.title,
      slug: skill.slug,
      program: skill.program || "global",
      mcpPresetId: skill.mcpPresetId ?? null,
      category: skill.category || "custom",
      description: skill.description || "",
      keywords: skill.keywords || [],
      relatedSkills: skill.relatedSkills || [],
      content: skill.content || "",
    });
  }

  async function publish() {
    const list = publishList;
    if (list.length === 0) return;

    publishing = true;
    batchDone = 0;
    batchErrors = [];
    batchSkipped = 0;

    for (let i = 0; i < list.length; i++) {
      batchIndex = i;
      const skill = list[i];
      if (!skill) { batchErrors.push(`Skill not found`); continue; }
      try {
        await publishOne(skill);
        batchDone++;
      } catch (err: any) {
        const msg = err?.message || "Unknown error";
        // If already exists, count as skipped rather than error
        if (msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("duplicate")) {
          batchSkipped++;
        } else {
          batchErrors.push(`${skill.title || skill.slug}: ${msg}`);
        }
      }
    }

    publishing = false;
    const parts: string[] = [];
    if (batchDone > 0) parts.push(`Published ${batchDone} skill${batchDone > 1 ? "s" : ""}`);
    if (batchSkipped > 0) parts.push(`${batchSkipped} already published`);
    if (parts.length > 0) toast.success(parts.join(", "));
    if (batchErrors.length) toast.error(`${batchErrors.length} failed`);
    else if (batchDone > 0) onclose();
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  // Total dep count for display
  let depCount = $derived(allDeps.length);
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick}>
  <div class="modal-dialog">
    <div class="modal-header">
      <h3>Publish to Community</h3>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>

    <div class="modal-body">
      {#if !hasToken}
        <div class="auth-section">
          <p class="section-desc">Connect your GitHub account to publish skills to the Arkestrator community.</p>
          <button class="btn btn-accent" onclick={openGitHubAuth}>
            Open GitHub Login
          </button>
          <p class="section-hint">After authenticating, paste the token below:</p>
          <div class="token-row">
            <input
              type="text"
              class="token-input"
              bind:value={tokenInput}
              placeholder="Paste auth token..."
            />
            <button class="btn" onclick={saveToken} disabled={!tokenInput.trim()}>
              Save
            </button>
          </div>
        </div>
      {:else}
        <div class="user-section">
          {#if loadingUser}
            <p class="muted">Verifying account...</p>
          {:else if communityUser}
            <div class="user-info">
              {#if communityUser.avatar_url}
                <img class="user-avatar" src={communityUser.avatar_url} alt="" />
              {/if}
              <span>Connected as <strong>{communityUser.username}</strong></span>
              <button class="btn btn-sm" onclick={disconnect}>Disconnect</button>
            </div>
          {:else}
            <p class="muted">Could not verify account. Token may be invalid.</p>
            <button class="btn btn-sm" onclick={disconnect}>Reset Token</button>
          {/if}
        </div>

        <div class="publish-section">
          {#if isBatch}
            <p class="field-label">Publish {preselect!.length} skills to community:</p>
            <div class="batch-list">
              {#each preselect! as ps, i}
                <div class="batch-item" class:done={publishing && i < batchIndex} class:active={publishing && i === batchIndex}>
                  <span>{ps.program}/{ps.slug}</span>
                  {#if batchErrors.find(e => e.startsWith(ps.program + "/" + ps.slug))}
                    <span class="batch-err">failed</span>
                  {/if}
                </div>
              {/each}
            </div>
            {#if batchErrors.length && !publishing}
              <div class="batch-errors">
                {#each batchErrors as err}
                  <p class="batch-err-msg">{err}</p>
                {/each}
              </div>
            {/if}
          {:else}
            {#if preselect?.length === 1}
              <p class="field-label">Skill to publish:</p>
            {:else}
              <label class="field-label">
                Select a local skill to publish
                <select bind:value={selectedSlug} class="skill-select">
                  <option value="">-- Choose a skill --</option>
                  {#each localSkills as s}
                    <option value={s.slug}>{s.title} ({s.program}/{s.slug})</option>
                  {/each}
                </select>
              </label>
            {/if}

            {#if selectedSkill}
              <div class="preview">
                <div class="preview-row"><span class="pv-label">Title</span><span>{selectedSkill.title}</span></div>
                <div class="preview-row"><span class="pv-label">Program</span><span>{selectedSkill.program}</span></div>
                <div class="preview-row"><span class="pv-label">Category</span><span>{selectedSkill.category}</span></div>
                <div class="preview-row"><span class="pv-label">Description</span><span>{selectedSkill.description || "—"}</span></div>
              </div>
            {/if}
          {/if}

          <!-- Dependency inclusion toggle -->
          {#if depCount > 0}
            <label class="deps-toggle">
              <input type="checkbox" bind:checked={includeDeps} />
              <span>Include dependencies ({depCount} found{publishableDeps.length < depCount && includeDeps ? `, ${publishableDeps.length} to publish` : ""})</span>
            </label>
            {#if includeDeps}
              {#if lookupLoading}
                <p class="muted" style="margin-top:6px;font-size:11px">Checking community...</p>
              {/if}
              <div class="deps-list">
                {#each allDeps as dep}
                  {@const info = depLookup[dep.slug]}
                  <div class="dep-item" class:dep-skipped={info && info.status !== "new" && info.status !== "update"}>
                    <span class="dep-slug">{dep.program}/{dep.slug}</span>
                    <span class="dep-status">
                      {#if !info}
                        <span class="badge badge-new">new</span>
                      {:else if info.status === "new"}
                        <span class="badge badge-new">new</span>
                      {:else if info.status === "update"}
                        <span class="badge badge-update">update</span>
                      {:else if info.status === "skip_official"}
                        <span class="badge badge-skip">official</span>
                      {:else if info.status === "skip_other"}
                        <span class="badge badge-skip">exists</span>
                      {:else if info.status === "skip_identical"}
                        <span class="badge badge-skip">unchanged</span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}

          <!-- Publish progress (shown when publishing with deps) -->
          {#if publishing && publishList.length > 1}
            <div class="publish-progress">
              <div class="progress-bar">
                <div class="progress-fill" style="width: {((batchIndex + 1) / publishList.length) * 100}%"></div>
              </div>
              <span class="progress-text">{batchIndex + 1} / {publishList.length}</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="modal-actions">
      {#if hasToken && (selectedSkill || isBatch)}
        <button class="btn btn-accent" onclick={publish} disabled={publishing}>
          {#if publishing}
            Publishing {batchIndex + 1}/{publishList.length}...
          {:else}
            Publish{publishList.length > 1 ? ` ${publishList.length} Skills` : ""}
          {/if}
        </button>
      {/if}
      <button class="btn" onclick={onclose}>{batchDone > 0 && !publishing ? "Close" : "Cancel"}</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 8px);
    width: min(480px, 90vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h3 {
    font-size: var(--font-size-lg);
    margin: 0;
  }
  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .close-btn:hover {
    color: var(--text-primary);
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .section-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 12px;
    line-height: 1.5;
  }
  .section-hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 12px 0 6px;
  }
  .token-row {
    display: flex;
    gap: 6px;
  }
  .token-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .user-section {
    margin-bottom: 16px;
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .user-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  .muted {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .field-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .skill-select {
    width: 100%;
  }
  .preview {
    margin-top: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
  }
  .preview-row {
    display: flex;
    gap: 8px;
    font-size: var(--font-size-sm);
    line-height: 1.6;
  }
  .pv-label {
    color: var(--text-muted);
    min-width: 80px;
    flex-shrink: 0;
  }
  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .btn {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    transition: all 0.15s;
  }
  .btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-accent:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-sm {
    padding: 3px 8px;
    font-size: 11px;
  }
  .batch-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
    max-height: 200px;
    overflow-y: auto;
  }
  .batch-item {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    background: var(--bg-base);
    border-radius: var(--radius-sm);
  }
  .batch-item.done { color: var(--status-completed); }
  .batch-item.active { color: var(--text-primary); font-weight: 600; }
  .batch-err { color: var(--status-failed); font-size: 11px; }
  .batch-errors { margin-top: 8px; }
  .batch-err-msg { font-size: 11px; color: var(--status-failed); margin: 2px 0; }

  /* Dependency controls */
  .deps-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .deps-toggle input[type="checkbox"] {
    accent-color: var(--accent);
  }
  .deps-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 6px;
    padding: 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    max-height: 140px;
    overflow-y: auto;
  }
  .dep-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    padding: 2px 0;
  }
  .dep-item.dep-skipped {
    opacity: 0.5;
  }
  .dep-slug {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .dep-status {
    text-align: right;
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-new {
    background: var(--accent);
    color: #fff;
  }
  .badge-update {
    background: #e0a800;
    color: #000;
  }
  .badge-skip {
    background: var(--bg-surface);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  /* Publish progress */
  .publish-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .progress-bar {
    flex: 1;
    height: 4px;
    background: var(--bg-base);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  .progress-text {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
