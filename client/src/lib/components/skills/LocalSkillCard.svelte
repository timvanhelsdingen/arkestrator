<script lang="ts">
  import type { SkillEntry, SkillEffectiveness } from "../../types/skills";
  import { programColor } from "../../utils/programColor";

  let {
    skill,
    effectiveness,
    selected = false,
    hasUpdate = false,
    onselect,
    onview,
  }: {
    skill: SkillEntry;
    effectiveness?: SkillEffectiveness | null;
    selected?: boolean;
    hasUpdate?: boolean;
    onselect?: () => void;
    onview?: () => void;
  } = $props();

  const ratedCount = $derived(
    effectiveness ? effectiveness.totalUsed - (effectiveness.pendingOutcomes ?? 0) : 0
  );
  const successPct = $derived(
    ratedCount > 0 ? Math.round((effectiveness?.successRate ?? 0) * 100) : null
  );

  const builtinSources = new Set(["bridge-repo", "builtin", "training"]);
  const isNew = $derived(
    !builtinSources.has(skill.source ?? "") &&
    (effectiveness?.totalUsed ?? 0) < 2 &&
    !!skill.createdAt &&
    (Date.now() - new Date(skill.createdAt).getTime()) < 86400000
  );
</script>

<div class="skill-card" class:selected class:disabled={!skill.enabled} onclick={onview} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onview?.(); }}>
  <div class="card-header">
    {#if onselect}
      <input type="checkbox" checked={selected} onchange={onselect} onclick={(e) => e.stopPropagation()} class="card-checkbox" />
    {/if}
    <button class="card-title" onclick={onview}>{skill.title}</button>
    {#if !skill.enabled}
      <span class="badge disabled-badge">OFF</span>
    {:else if hasUpdate}
      <span class="badge update-badge">UPDATE</span>
    {:else if isNew}
      <span class="badge new-badge">NEW</span>
    {/if}
    {#if skill.locked}
      <span class="lock-icon" title="Locked">&#128274;</span>
    {/if}
  </div>

  <div class="card-badges">
    <span class="badge program-badge" style="background: {programColor(skill.program)}">
      {skill.program}
    </span>
    {#if skill.category}
      <span class="badge category-badge">{skill.category}</span>
    {/if}
  </div>

  {#if skill.description}
    <p class="card-desc">{skill.description}</p>
  {/if}

  <div class="card-meta">
    {#if skill.source === "community" && skill.communityUrl}
      <a
        class="meta-item community-link"
        href={skill.communityUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={skill.authorLogin ? `Installed from community — by ${skill.authorLogin}` : "Installed from community"}
        onclick={(e) => e.stopPropagation()}
      >
        from community{skill.authorLogin ? ` · ${skill.authorLogin}` : ""} ↗
      </a>
    {:else if skill.source}
      <span class="meta-item" title="Source">{skill.source}</span>
    {/if}
    {#if effectiveness}
      <span class="meta-item" title="Total uses">
        {effectiveness.totalUsed} use{effectiveness.totalUsed !== 1 ? "s" : ""}
      </span>
      {#if successPct !== null}
        <span class="badge success-badge {successPct >= 70 ? 'success' : successPct >= 40 ? 'warn' : 'bad'}">
          {successPct}%
        </span>
      {:else if effectiveness.totalUsed > 0}
        <span class="meta-item muted" title="{effectiveness.pendingOutcomes} pending">pending</span>
      {/if}
    {/if}
  </div>

</div>

<style>
  .skill-card {
    display: flex;
    flex-direction: column;
    gap: calc(var(--card-scale, 1) * 4px);
    padding: calc(var(--card-scale, 1) * 10px);
    border: 1px solid var(--border-light, rgba(255,255,255,0.06));
    border-radius: 6px;
    background: var(--bg-surface, rgba(255,255,255,0.03));
    transition: border-color 0.15s, background 0.15s;
    cursor: pointer;
  }
  .skill-card:hover {
    border-color: var(--border, rgba(255,255,255,0.12));
    background: var(--bg-hover, rgba(255,255,255,0.04));
  }
  .skill-card.selected {
    border-color: var(--accent);
  }
  .skill-card.disabled {
    opacity: 0.4;
    border-color: transparent;
  }
  .skill-card.disabled:hover {
    opacity: 0.6;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: calc(var(--card-scale, 1) * 6px);
    min-width: 0;
  }
  .card-checkbox {
    flex-shrink: 0;
  }
  .card-title {
    flex: 1;
    font-size: calc(var(--card-scale, 1) * 12px);
    font-weight: 600;
    color: var(--text-primary);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    min-width: 0;
    word-break: break-word;
  }
  .card-title:hover {
    color: var(--accent);
  }
  .lock-icon {
    flex-shrink: 0;
    font-size: calc(var(--card-scale, 1) * 12px);
    opacity: 0.5;
  }

  .card-badges {
    display: flex;
    gap: calc(var(--card-scale, 1) * 4px);
    flex-wrap: wrap;
  }
  .badge {
    font-size: calc(var(--card-scale, 1) * 10px);
    font-weight: 600;
    padding: calc(var(--card-scale, 1) * 1px) calc(var(--card-scale, 1) * 5px);
    border-radius: 3px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .category-badge {
    background: var(--bg-subtle, rgba(255,255,255,0.06));
    color: var(--text-secondary);
  }
  .new-badge {
    flex-shrink: 0;
    font-size: calc(var(--card-scale, 1) * 9px);
    padding: calc(var(--card-scale, 1) * 1px) calc(var(--card-scale, 1) * 4px);
    border-radius: 3px;
    color: #4ec9b0;
    background: rgba(78, 201, 176, 0.15);
    letter-spacing: 0.5px;
  }
  .disabled-badge {
    flex-shrink: 0;
    font-size: calc(var(--card-scale, 1) * 9px);
    padding: calc(var(--card-scale, 1) * 1px) calc(var(--card-scale, 1) * 4px);
    border-radius: 3px;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.06);
    letter-spacing: 0.5px;
  }
  .update-badge {
    flex-shrink: 0;
    font-size: calc(var(--card-scale, 1) * 9px);
    padding: calc(var(--card-scale, 1) * 1px) calc(var(--card-scale, 1) * 4px);
    border-radius: 3px;
    color: #e2b93d;
    background: rgba(226, 185, 61, 0.15);
    letter-spacing: 0.5px;
  }

  .card-desc {
    margin: 0;
    font-size: calc(var(--card-scale, 1) * 12px);
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: calc(var(--card-scale, 1) * 8px);
    font-size: calc(var(--card-scale, 1) * 11px);
    color: var(--text-muted);
    flex-wrap: wrap;
    margin-top: auto;
    padding-top: calc(var(--card-scale, 1) * 4px);
    border-top: 1px solid var(--border-light, rgba(255,255,255,0.04));
  }
  .meta-item {
    white-space: nowrap;
  }
  .meta-item.muted {
    opacity: 0.6;
  }
  .community-link {
    color: var(--accent);
    text-decoration: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .community-link:hover {
    text-decoration: underline;
  }
  .success-badge {
    font-size: calc(var(--card-scale, 1) * 10px);
    padding: calc(var(--card-scale, 1) * 1px) calc(var(--card-scale, 1) * 5px);
    border-radius: 3px;
  }
  .success-badge.success { color: #4ec9b0; background: rgba(78, 201, 176, 0.12); }
  .success-badge.warn { color: #e2b93d; background: rgba(226, 185, 61, 0.12); }
  .success-badge.bad { color: #e05252; background: rgba(224, 82, 82, 0.12); }

</style>
