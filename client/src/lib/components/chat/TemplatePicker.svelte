<script lang="ts">
  import { api } from "../../api/rest";
  import { onMount } from "svelte";

  interface Props {
    type: "chat" | "project" | "job_preset";
    onselect: (template: { name: string; content: string; options?: any }) => void;
    onclose: () => void;
  }

  let { type, onselect, onclose }: Props = $props();

  interface TemplateItem {
    id: string;
    name: string;
    description: string;
    content: string;
    category: string;
    icon: string | null;
    options: any;
  }

  let templates = $state<TemplateItem[]>([]);
  let loading = $state(true);
  let error = $state("");
  let search = $state("");
  let expandedCategories = $state<Set<string>>(new Set());
  let searchInput: HTMLInputElement | undefined = $state();

  // Group templates by category
  let grouped = $derived.by(() => {
    const lowerSearch = search.trim().toLowerCase();
    const filtered = lowerSearch
      ? templates.filter(
          (t) =>
            t.name.toLowerCase().includes(lowerSearch) ||
            (t.description ?? "").toLowerCase().includes(lowerSearch) ||
            t.category.toLowerCase().includes(lowerSearch),
        )
      : templates;

    const groups = new Map<string, TemplateItem[]>();
    for (const t of filtered) {
      const cat = t.category || "Uncategorized";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(t);
    }
    return groups;
  });

  let categoryNames = $derived([...grouped.keys()].sort());

  function toggleCategory(cat: string) {
    const next = new Set(expandedCategories);
    if (next.has(cat)) {
      next.delete(cat);
    } else {
      next.add(cat);
    }
    expandedCategories = next;
  }

  function selectTemplate(t: TemplateItem) {
    onselect({ name: t.name, content: t.content, options: t.options });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }

  onMount(() => {
    api.templates
      .list(type)
      .then((res: any) => {
        const items = Array.isArray(res) ? res : Array.isArray(res?.templates) ? res.templates : [];
        templates = items.map((t: any) => ({
          id: t.id ?? "",
          name: t.name ?? "",
          description: t.description ?? "",
          content: t.content ?? "",
          category: t.category ?? "General",
          icon: t.icon ?? null,
          options: typeof t.options === "object" && t.options !== null ? t.options : {},
        }));
        // Auto-expand all categories when there are few
        if (grouped.size <= 4) {
          expandedCategories = new Set(grouped.keys());
        }
      })
      .catch(() => {
        error = "Failed to load templates.";
      })
      .finally(() => {
        loading = false;
      });

    // Focus search input on mount
    requestAnimationFrame(() => searchInput?.focus());
  });

  // When searching, expand all matching categories
  $effect(() => {
    if (search.trim()) {
      expandedCategories = new Set(grouped.keys());
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="template-picker" onkeydown={handleKeydown}>
  <div class="picker-header">
    <input
      bind:this={searchInput}
      type="text"
      class="picker-search"
      placeholder="Search templates..."
      bind:value={search}
    />
  </div>

  <div class="picker-body">
    {#if loading}
      <div class="picker-empty">Loading templates...</div>
    {:else if error}
      <div class="picker-empty">{error}</div>
    {:else if categoryNames.length === 0}
      <div class="picker-empty">
        {#if search.trim()}
          No templates match "{search}"
        {:else}
          No templates available. Seed defaults from Admin &gt; Templates.
        {/if}
      </div>
    {:else}
      {#each categoryNames as cat (cat)}
        <div class="picker-category">
          <button class="category-header" onclick={() => toggleCategory(cat)}>
            <span class="category-arrow">{expandedCategories.has(cat) ? "\u25BC" : "\u25B6"}</span>
            <span class="category-name">{cat}</span>
            <span class="category-count">{grouped.get(cat)?.length ?? 0}</span>
          </button>

          {#if expandedCategories.has(cat)}
            <div class="category-items">
              {#each grouped.get(cat) ?? [] as tmpl (tmpl.id)}
                <button class="template-item" onclick={() => selectTemplate(tmpl)}>
                  <span class="template-name">{tmpl.icon ? `${tmpl.icon} ` : ""}{tmpl.name}</span>
                  {#if tmpl.description}
                    <span class="template-desc">{tmpl.description.length > 80 ? `${tmpl.description.slice(0, 80)}...` : tmpl.description}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .template-picker {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    width: 320px;
    max-height: 400px;
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
    padding: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-search {
    width: 100%;
    padding: 5px 8px;
    font-size: var(--font-size-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
  }

  .picker-search::placeholder {
    color: var(--text-muted);
  }

  .picker-search:focus {
    outline: none;
    border-color: var(--accent);
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

  .picker-category {
    display: flex;
    flex-direction: column;
  }

  .category-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .category-header:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .category-arrow {
    font-size: 8px;
    width: 10px;
    flex-shrink: 0;
    text-align: center;
  }

  .category-name {
    flex: 1;
  }

  .category-count {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 400;
  }

  .category-items {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-left: 8px;
  }

  .template-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 10px 6px 18px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    margin: 0 4px;
  }

  .template-item:hover {
    background: var(--bg-hover);
  }

  .template-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .template-desc {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
