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

<div class="skill-row" class:installed={!!installed}>
  <div class="row-main">
    <button class="row-title" onclick={onview}>{skill.title}</button>
    <span class="badge program-badge" style="background: {programColor(skill.program)}">
      {skill.program}
    </span>
    {#if skill.category}
      <span class="badge category-badge">{skill.category}</span>
    {/if}
    {#if hasUpdate}
      <span class="badge update-badge">Update</span>
    {/if}
    <span class="row-desc">{skill.description || ""}</span>
  </div>

  <div class="row-meta">
    <span class="meta-author" title={skill.author?.username || "Unknown"}>
      {#if skill.author?.avatar_url}
        <img class="avatar" src={skill.author.avatar_url} alt="" />
      {:else}
        <span class="avatar-fallback">{(skill.author?.username || "?")[0].toUpperCase()}</span>
      {/if}
      {skill.author?.username || "Unknown"}
    </span>
    <span class="meta-item">v{skill.version}</span>
    <span class="meta-item">&#8681; {skill.downloads ?? 0}</span>
  </div>

  <div class="row-actions">
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
  .skill-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-light, rgba(255,255,255,0.06));
    transition: background 0.1s;
  }
  .skill-row:hover {
    background: var(--bg-hover, rgba(255,255,255,0.03));
  }
  .skill-row.installed {
    border-left: 3px solid var(--status-completed);
    padding-left: 5px;
  }
  .row-main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .row-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .row-title:hover {
    color: var(--accent);
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .category-badge {
    background: var(--bg-subtle, rgba(255,255,255,0.06));
    color: var(--text-secondary);
    font-size: 0.85em;
  }
  .update-badge {
    background: var(--status-running);
  }
  .row-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .row-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .meta-author {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .avatar {
    width: 14px;
    height: 14px;
    border-radius: 50%;
  }
  .avatar-fallback {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--bg-active);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 700;
    color: var(--text-secondary);
  }
  .meta-item {
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .btn {
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 0.8em;
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
    padding: 2px 8px;
  }
</style>
