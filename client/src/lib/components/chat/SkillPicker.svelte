<script lang="ts">
  import { api } from "../../api/rest";
  import { onMount } from "svelte";

  interface Props {
    query: string;
    onselect: (skill: { slug: string; title: string; program: string }) => void;
    onclose: () => void;
  }

  let { query, onselect, onclose }: Props = $props();

  interface SkillItem {
    slug: string;
    title: string;
    program: string;
    description: string;
    category: string;
    enabled: boolean;
  }

  let skills = $state<SkillItem[]>([]);
  let loading = $state(true);
  let error = $state("");
  let selectedIndex = $state(0);

  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills.filter((s) => s.enabled);
    return skills.filter(
      (s) =>
        s.enabled &&
        (s.slug.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q) ||
          s.program.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)),
    );
  });

  // Reset selection when filter changes
  $effect(() => {
    filtered; // track
    selectedIndex = 0;
  });

  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      scrollSelectedIntoView();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      scrollSelectedIntoView();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (filtered.length > 0) {
        e.preventDefault();
        const skill = filtered[selectedIndex];
        if (skill) onselect({ slug: skill.slug, title: skill.title, program: skill.program });
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return true;
    }
    return false;
  }

  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector(".skill-picker .skill-item.selected");
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  onMount(() => {
    api.skills
      .list(undefined, undefined, false)
      .then((res: any) => {
        const items = Array.isArray(res) ? res : Array.isArray(res?.skills) ? res.skills : [];
        skills = items.map((s: any) => ({
          slug: s.slug ?? "",
          title: s.title || s.name || s.slug || "",
          program: s.program ?? "global",
          description: s.description ?? "",
          category: s.category ?? "",
          enabled: s.enabled !== false,
        }));
      })
      .catch(() => {
        error = "Failed to load skills.";
      })
      .finally(() => {
        loading = false;
      });
  });
</script>

<div class="skill-picker">
  <div class="picker-header">
    <span class="picker-title">Skills</span>
    {#if query}
      <span class="picker-query">/{query}</span>
    {/if}
  </div>
  <div class="picker-body">
    {#if loading}
      <div class="picker-empty">Loading skills...</div>
    {:else if error}
      <div class="picker-empty">{error}</div>
    {:else if filtered.length === 0}
      <div class="picker-empty">
        {#if query.trim()}
          No skills match "/{query}"
        {:else}
          No skills available.
        {/if}
      </div>
    {:else}
      {#each filtered as skill, i (skill.slug + skill.program)}
        <button
          class="skill-item"
          class:selected={i === selectedIndex}
          onclick={() => onselect({ slug: skill.slug, title: skill.title, program: skill.program })}
          onmouseenter={() => (selectedIndex = i)}
        >
          <div class="skill-top">
            <span class="skill-slug">/{skill.slug}</span>
            {#if skill.program && skill.program !== "global"}
              <span class="skill-program">{skill.program}</span>
            {/if}
          </div>
          {#if skill.title && skill.title !== skill.slug}
            <span class="skill-title">{skill.title}</span>
          {/if}
          {#if skill.description}
            <span class="skill-desc">{skill.description.length > 100 ? `${skill.description.slice(0, 100)}...` : skill.description}</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .skill-picker {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    width: 360px;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 100;
    overflow: hidden;
  }

  .picker-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .picker-query {
    font-size: var(--font-size-sm);
    color: var(--accent);
    font-family: var(--font-mono, monospace);
  }

  .picker-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding: 4px 0;
  }

  .picker-empty {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-style: italic;
  }

  .skill-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    width: 100%;
    margin: 0;
  }

  .skill-item:hover,
  .skill-item.selected {
    background: var(--bg-hover);
  }

  .skill-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .skill-slug {
    font-size: var(--font-size-sm);
    font-weight: 500;
    font-family: var(--font-mono, monospace);
    color: var(--accent);
  }

  .skill-program {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .skill-title {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .skill-desc {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
