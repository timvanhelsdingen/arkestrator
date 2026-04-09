<script lang="ts">
  import { communitySkills, type InstalledCommunitySkill } from "../../stores/communitySkills.svelte";
  import type { CommunitySkillDetail, CommunitySkillSummary } from "../../api/community";

  let {
    skill,
    detail,
    loading = false,
    installed,
    hasUpdate = false,
    onclose,
    oninstall,
    onuninstall,
    ontoggle,
    onupdate,
  }: {
    skill: CommunitySkillSummary;
    detail: CommunitySkillDetail | null;
    loading?: boolean;
    installed?: InstalledCommunitySkill;
    hasUpdate?: boolean;
    onclose: () => void;
    oninstall?: () => void;
    onuninstall?: () => void;
    ontoggle?: () => void;
    onupdate?: () => void;
  } = $props();

  let busy = $derived(communitySkills.installingIds.has(skill.id));

  // Parse related-skills from SKILL.md content
  let relatedSkills = $derived.by(() => {
    if (!detail?.content) return [];
    const fmMatch = detail.content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];
    const fm = fmMatch[1];
    const inlineMatch = fm.match(/related-skills:\s*\[([^\]]*)\]/);
    if (inlineMatch) {
      return inlineMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    const listMatch = fm.match(/related-skills:\s*\n((?:\s+-\s+.*\n?)*)/);
    if (listMatch) {
      return listMatch[1].split("\n").map((l: string) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    }
    return [];
  });

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick}>
  <div class="modal-dialog">
    <div class="modal-header">
      <h3>{skill.title}</h3>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>

    {#if loading}
      <div class="loading">Loading skill details...</div>
    {:else if detail}
      <div class="detail-body">
        <div class="meta-grid">
          <div class="meta-cell">
            <span class="meta-label">Author</span>
            <span class="meta-value">
              {#if detail.author?.avatar_url}
                <img class="avatar" src={detail.author.avatar_url} alt="" />
              {/if}
              {detail.author?.username || "Arkestrator"}
            </span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">Program</span>
            <span class="meta-value">{detail.program}</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">Category</span>
            <span class="meta-value">{detail.category}</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">Version</span>
            <span class="meta-value">v{detail.version}</span>
          </div>
          <div class="meta-cell">
            <span class="meta-label">Downloads</span>
            <span class="meta-value">{detail.downloads ?? 0}</span>
          </div>
          {#if detail.keywords?.length}
            <div class="meta-cell full-width">
              <span class="meta-label">Keywords</span>
              <span class="meta-value keywords">
                {#each detail.keywords as kw}
                  <span class="keyword">{kw}</span>
                {/each}
              </span>
            </div>
          {/if}
        </div>

        <p class="description">{detail.description || "No description"}</p>

        {#if relatedSkills.length > 0}
          <div class="deps-section">
            <h4>Dependencies ({relatedSkills.length})</h4>
            <div class="deps-list">
              {#each relatedSkills as depSlug}
                <span class="dep-chip">{depSlug}</span>
              {/each}
            </div>
          </div>
        {/if}

        <div class="content-section">
          <h4>SKILL.md Preview</h4>
          <pre class="skill-content">{detail.content}</pre>
        </div>
      </div>
    {/if}

    <div class="modal-actions">
      {#if installed}
        {#if ontoggle}
          <button class="btn" class:btn-enabled={installed.enabled} onclick={ontoggle}>
            {installed.enabled ? "Disable" : "Enable"}
          </button>
        {/if}
        {#if hasUpdate && onupdate}
          <button class="btn btn-accent" onclick={onupdate} disabled={busy}>
            {busy ? "Updating..." : `Update to v${communitySkills.updatesAvailable[skill.id] ?? ""}`}
          </button>
        {/if}
        {#if onuninstall}
          <button class="btn btn-danger" onclick={onuninstall}>Uninstall</button>
        {/if}
      {:else if oninstall}
        <button class="btn btn-accent" onclick={oninstall} disabled={busy}>
          {#if busy}
            Installing...
          {:else if relatedSkills.length > 0}
            Install with {relatedSkills.length} dep{relatedSkills.length === 1 ? "" : "s"}
          {:else}
            Install
          {/if}
        </button>
      {/if}
      <button class="btn" onclick={onclose}>Close</button>
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
    width: min(640px, 90vw);
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
  .loading {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }
  .detail-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  }
  .meta-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .meta-cell.full-width {
    grid-column: 1 / -1;
  }
  .meta-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--text-muted);
  }
  .meta-value {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .avatar {
    width: 18px;
    height: 18px;
    border-radius: 50%;
  }
  .keywords {
    flex-wrap: wrap;
    gap: 4px;
  }
  .keyword {
    background: var(--bg-active);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .description {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0 0 12px;
  }
  .deps-section {
    margin-bottom: 12px;
  }
  .deps-section h4 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 6px;
  }
  .deps-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .dep-chip {
    background: var(--bg-active);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
  .content-section h4 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 6px;
  }
  .skill-content {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
    max-height: 260px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
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
  .btn-enabled {
    border-color: var(--status-completed);
    color: var(--status-completed);
  }
  .btn-danger {
    color: var(--status-failed);
    border-color: var(--status-failed);
    background: transparent;
  }
  .btn-danger:hover {
    background: rgba(244, 71, 71, 0.1);
  }
</style>
