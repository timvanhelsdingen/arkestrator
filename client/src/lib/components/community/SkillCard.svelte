<script lang="ts">
  import type { CommunitySkillSummary } from "../../api/community";
  import type { InstalledCommunitySkill } from "../../stores/communitySkills.svelte";
  import { programColor } from "../../utils/programColor";

  let {
    skill,
    installed,
    hasUpdate = false,
    busy = false,
    selected = false,
    onview,
    oninstall,
    ontoggle,
    onupdate,
    onuninstall,
    onselect,
  }: {
    skill: CommunitySkillSummary;
    installed?: InstalledCommunitySkill;
    hasUpdate?: boolean;
    busy?: boolean;
    selected?: boolean;
    onview: () => void;
    oninstall?: () => void;
    ontoggle?: () => void;
    onupdate?: () => void;
    onuninstall?: () => void;
    onselect?: () => void;
  } = $props();
</script>

<div class="skill-card" class:installed={!!installed} class:selected={selected}>
  <div class="card-header">
    {#if onselect}
      <input type="checkbox" checked={selected} onchange={onselect} onclick={(e) => e.stopPropagation()} class="card-checkbox" />
    {/if}
    <button class="card-title" onclick={onview}>{skill.title}</button>
  </div>

  <div class="card-badges">
    <span class="badge program-badge" style="background: {programColor(skill.program)}">
      {skill.program}
    </span>
    {#if skill.category}
      <span class="badge category-badge">{skill.category}</span>
    {/if}
    {#if hasUpdate}
      <span class="badge update-badge">Update</span>
    {/if}
  </div>

  {#if skill.description}
    <p class="card-desc">{skill.description}</p>
  {/if}

  <div class="card-meta">
    <span class="meta-author" title={skill.author?.username || "Official"}>
      {#if skill.author?.avatar_url}
        <img class="avatar" src={skill.author.avatar_url} alt="" />
      {:else}
        <span class="avatar-fallback">{(skill.author?.username || "Official")[0].toUpperCase()}</span>
      {/if}
      {skill.author?.username || "Official"}
    </span>
    <span class="meta-item">v{skill.version}</span>
    <span class="meta-item">&#8681; {skill.downloads ?? 0}</span>
  </div>

  <div class="card-actions">
    <button class="btn btn-sm" onclick={onview}>View</button>
    {#if !installed}
      {#if oninstall}
        <button class="btn btn-sm btn-accent" onclick={oninstall} disabled={busy}>
          {busy ? "Installing..." : "Install"}
        </button>
      {/if}
    {:else}
      {#if ontoggle}
        <button class="btn btn-sm" class:btn-enabled={installed.enabled} onclick={ontoggle}>
          {installed.enabled ? "Disable" : "Enable"}
        </button>
      {/if}
      {#if hasUpdate && onupdate}
        <button class="btn btn-sm btn-accent" onclick={onupdate} disabled={busy}>
          {busy ? "Updating..." : "Update"}
        </button>
      {/if}
      {#if onuninstall}
        <button class="btn btn-sm btn-danger" onclick={onuninstall}>Uninstall</button>
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
  }
  .skill-card:hover {
    border-color: var(--border, rgba(255,255,255,0.12));
    background: var(--bg-hover, rgba(255,255,255,0.04));
  }
  .skill-card.installed {
    border-left: 3px solid var(--status-completed);
  }
  .skill-card.selected {
    border-color: var(--accent);
  }
  .card-checkbox {
    flex-shrink: 0;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: calc(var(--card-scale, 1) * 6px);
    min-width: 0;
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
  .update-badge {
    background: var(--status-running);
    font-size: calc(var(--card-scale, 1) * 10px);
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
  .meta-author {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .avatar {
    width: calc(var(--card-scale, 1) * 14px);
    height: calc(var(--card-scale, 1) * 14px);
    border-radius: 50%;
  }
  .avatar-fallback {
    width: calc(var(--card-scale, 1) * 14px);
    height: calc(var(--card-scale, 1) * 14px);
    border-radius: 50%;
    background: var(--bg-active);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(var(--card-scale, 1) * 8px);
    font-weight: 700;
    color: var(--text-secondary);
  }
  .meta-item {
    white-space: nowrap;
  }

  .card-actions {
    display: flex;
    gap: calc(var(--card-scale, 1) * 4px);
    flex-wrap: wrap;
    padding-top: calc(var(--card-scale, 1) * 4px);
  }
  .btn {
    padding: calc(var(--card-scale, 1) * 2px) calc(var(--card-scale, 1) * 8px);
    border-radius: 3px;
    font-size: calc(var(--card-scale, 1) * 11px);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-subtle, rgba(255,255,255,0.08));
    color: inherit;
    transition: all 0.15s;
  }
  .btn:hover {
    background: var(--bg-hover, rgba(255,255,255,0.12));
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
  .btn-sm {
    padding: calc(var(--card-scale, 1) * 2px) calc(var(--card-scale, 1) * 8px);
  }
</style>
