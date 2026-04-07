<script lang="ts">
  import type { CommunitySkillSummary } from "../../api/community";
  import type { InstalledCommunitySkill } from "../../stores/communitySkills.svelte";

  let {
    skill,
    installed,
    hasUpdate = false,
    busy = false,
    onview,
    oninstall,
    ontoggle,
    onupdate,
    onuninstall,
  }: {
    skill: CommunitySkillSummary;
    installed?: InstalledCommunitySkill;
    hasUpdate?: boolean;
    busy?: boolean;
    onview: () => void;
    oninstall?: () => void;
    ontoggle?: () => void;
    onupdate?: () => void;
    onuninstall?: () => void;
  } = $props();

  function programColor(program: string): string {
    const map: Record<string, string> = {
      blender: "#ea7600",
      godot: "#478cbf",
      houdini: "#ff4713",
      unity: "#222",
      unreal: "#0d47a1",
      comfyui: "#8e24aa",
      global: "#006d77",
    };
    return map[program.toLowerCase()] ?? "var(--text-muted)";
  }
</script>

<div class="skill-card" class:installed={!!installed}>
  <div class="card-header">
    <button class="card-title" onclick={onview}>{skill.title}</button>
    <div class="card-badges">
      <span class="badge program-badge" style="background: {programColor(skill.program)}">
        {skill.program}
      </span>
      {#if hasUpdate}
        <span class="badge update-badge">Update</span>
      {/if}
    </div>
  </div>

  <p class="card-desc">{skill.description || "No description"}</p>

  <div class="card-meta">
    <span class="meta-author" title={skill.author?.username || "Unknown"}>
      {#if skill.author?.avatar_url}
        <img class="avatar" src={skill.author.avatar_url} alt="" />
      {:else}
        <span class="avatar-fallback">{(skill.author?.username || "?")[0].toUpperCase()}</span>
      {/if}
      {skill.author?.username || "Unknown"}
    </span>
    <span class="meta-item" title="Version">v{skill.version}</span>
    <span class="meta-item" title="Downloads">&#8681; {skill.downloads ?? 0}</span>
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
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 0.15s;
  }
  .skill-card:hover {
    border-color: var(--text-muted);
  }
  .skill-card.installed {
    border-left: 3px solid var(--status-completed);
  }
  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .card-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    line-height: 1.3;
  }
  .card-title:hover {
    color: var(--accent);
  }
  .card-badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .update-badge {
    background: var(--status-running);
  }
  .card-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .meta-author {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }
  .avatar-fallback {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-active);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: var(--text-secondary);
  }
  .meta-item {
    white-space: nowrap;
  }
  .card-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .btn {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
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
  .btn-sm {
    padding: 3px 8px;
  }
</style>
