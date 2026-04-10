<script lang="ts">
  import { api } from "../../api/rest";
  import { onMount } from "svelte";
  import { workersStore } from "../../stores/workers.svelte";
  import { bridgeContextStore } from "../../stores/bridgeContext.svelte";
  import type { ContextItem } from "@arkestrator/protocol";

  /**
   * Unified reference picker.
   *
   * Opens when the user types `/` in the chat input. Lets users quickly address
   * any of four things that scale poorly with a dropdown:
   *
   *   - Worker (machine)        — routes to selectedWorkerNames
   *   - Bridge (DCC connection) — routes to selectedWorkerNames (its worker)
   *   - Context item            — inserts `@N [program:name]` reference
   *   - Skill                   — inserts `/skill:slug` tag
   *
   * Category scoping:
   *   `/foo`           → fuzzy search across all categories
   *   `/worker:foo`    → scope to workers only (also `/w:foo`)
   *   `/bridge:foo`    → scope to bridges only (also `/b:foo`)
   *   `/context:foo`   → scope to contexts only (also `/c:foo`)
   *   `/skill:foo`     → scope to skills only  (also `/s:foo`)
   *
   * Keybinds handled via exported handleKeydown():
   *   ArrowUp/Down     → navigate
   *   Enter / Tab      → commit highlighted item (no trailing space)
   *   Space            → commit highlighted item + trailing space (keep typing)
   *   Escape           → close without committing
   */

  export type PickerItem =
    | {
        kind: "worker";
        name: string;
        status: "online" | "offline";
        programs: string[];
        activeBridgeCount: number;
      }
    | {
        kind: "bridge";
        workerName: string;
        bridgeName: string;
        bridgeId: string;
        program: string;
      }
    | {
        kind: "context";
        bridgeId: string;
        bridgeName: string;
        program: string;
        workerName: string;
        item: ContextItem;
      }
    | {
        kind: "skill";
        slug: string;
        title: string;
        program: string;
      };

  interface Props {
    query: string;
    onselect: (item: PickerItem, opts: { trailingSpace: boolean }) => void;
    onclose: () => void;
  }

  let { query, onselect, onclose }: Props = $props();

  type Category = "all" | "worker" | "bridge" | "context" | "skill";

  interface SkillRow {
    slug: string;
    title: string;
    program: string;
    description: string;
    enabled: boolean;
  }

  let skills = $state<SkillRow[]>([]);
  let skillsLoading = $state(true);
  let selectedIndex = $state(0);

  // Parse category prefix from query. Accepts full names and single-letter shortcuts.
  let parsed = $derived.by(() => {
    const raw = query ?? "";
    const m = raw.match(/^(worker|bridge|context|skill|w|b|c|s):(.*)$/i);
    if (!m) return { category: "all" as Category, term: raw.trim().toLowerCase() };
    const full = m[1].toLowerCase();
    const cat: Category =
      full === "w" ? "worker"
      : full === "b" ? "bridge"
      : full === "c" ? "context"
      : full === "s" ? "skill"
      : (full as Category);
    return { category: cat, term: m[2].trim().toLowerCase() };
  });

  // Build per-category item lists. Read store getters so Svelte 5 tracks them.
  let workerItems = $derived.by<PickerItem[]>(() => {
    const byName = new Map<string, {
      name: string;
      status: "online" | "offline";
      programs: Set<string>;
      activeBridgeCount: number;
    }>();

    for (const w of workersStore.workers) {
      const name = String(w.name ?? "").trim();
      if (!name) continue;
      byName.set(name.toLowerCase(), {
        name,
        status: w.status === "online" ? "online" : "offline",
        programs: new Set((w.knownPrograms ?? []).map((p) => String(p ?? "").trim()).filter(Boolean)),
        activeBridgeCount: 0,
      });
    }
    for (const b of workersStore.bridges) {
      if (!b.connected) continue;
      const name = String(b.workerName ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = byName.get(key) ?? {
        name,
        status: "online" as const,
        programs: new Set<string>(),
        activeBridgeCount: 0,
      };
      existing.status = "online";
      existing.activeBridgeCount += 1;
      if (b.program?.trim()) existing.programs.add(b.program.trim());
      byName.set(key, existing);
    }

    return [...byName.values()].map((w) => ({
      kind: "worker" as const,
      name: w.name,
      status: w.status,
      programs: [...w.programs],
      activeBridgeCount: w.activeBridgeCount,
    }));
  });

  let bridgeItems = $derived.by<PickerItem[]>(() =>
    workersStore.bridges
      .filter((b) => b.connected)
      .map((b) => ({
        kind: "bridge" as const,
        workerName: String(b.workerName ?? "").trim() || "unknown",
        bridgeName: b.name,
        bridgeId: b.id,
        program: b.program ?? "",
      })),
  );

  let contextItems = $derived.by<PickerItem[]>(() => {
    const out: PickerItem[] = [];
    // Reading .bridges subscribes to version mutations.
    for (const [bridgeId, entry] of bridgeContextStore.bridges) {
      // Find worker for this bridge
      const bridgeInfo = workersStore.bridges.find((b) => b.id === bridgeId);
      const workerName = String(bridgeInfo?.workerName ?? "").trim() || "unknown";
      for (const item of entry.items) {
        out.push({
          kind: "context",
          bridgeId,
          bridgeName: entry.bridgeName,
          program: entry.program,
          workerName,
          item: {
            ...item,
            name: bridgeContextStore.getItemName(bridgeId, item),
          },
        });
      }
    }
    return out;
  });

  let skillItems = $derived.by<PickerItem[]>(() =>
    skills
      .filter((s) => s.enabled)
      .map((s) => ({
        kind: "skill" as const,
        slug: s.slug,
        title: s.title,
        program: s.program,
      })),
  );

  // Fuzzy substring match over the parts of each item that make sense to search.
  function matches(item: PickerItem, term: string): boolean {
    if (!term) return true;
    const haystack = buildHaystack(item).toLowerCase();
    // Split on whitespace so `loc bl sc` narrows progressively like Houdini TAB.
    const tokens = term.split(/\s+/).filter(Boolean);
    return tokens.every((t) => haystack.includes(t));
  }

  function buildHaystack(item: PickerItem): string {
    if (item.kind === "worker") {
      return [item.name, item.status, ...item.programs].join(" ");
    }
    if (item.kind === "bridge") {
      return [item.workerName, item.bridgeName, item.program].join(" ");
    }
    if (item.kind === "context") {
      const i = item.item;
      return [
        item.workerName,
        item.bridgeName,
        item.program,
        i.type,
        i.name,
        i.path ?? "",
      ].join(" ");
    }
    if (item.kind === "skill") {
      return [item.slug, item.title, item.program].join(" ");
    }
    return "";
  }

  // Filter + order: when a category is scoped, show only that category.
  // When "all", interleave categories but keep a stable order: workers, bridges, contexts, skills.
  let filtered = $derived.by<PickerItem[]>(() => {
    const { category, term } = parsed;
    const groups: PickerItem[][] = [];
    if (category === "all" || category === "worker") {
      groups.push(workerItems.filter((i) => matches(i, term)));
    }
    if (category === "all" || category === "bridge") {
      groups.push(bridgeItems.filter((i) => matches(i, term)));
    }
    if (category === "all" || category === "context") {
      groups.push(contextItems.filter((i) => matches(i, term)));
    }
    if (category === "all" || category === "skill") {
      groups.push(skillItems.filter((i) => matches(i, term)));
    }
    return groups.flat();
  });

  // Reset selection whenever the filtered list changes shape.
  $effect(() => {
    filtered;
    selectedIndex = 0;
  });

  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, Math.max(0, filtered.length - 1));
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
        const item = filtered[selectedIndex];
        if (item) onselect(item, { trailingSpace: false });
        return true;
      }
    }
    if (e.key === " " || e.code === "Space") {
      // Space autocompletes to the highlighted item AND adds a trailing space
      // so the user can keep typing the message. If there are no matches, let
      // the space fall through so users can type `/ ` as literal text.
      if (filtered.length > 0) {
        e.preventDefault();
        const item = filtered[selectedIndex];
        if (item) onselect(item, { trailingSpace: true });
        return true;
      }
      // No matches: close picker and let space pass through.
      onclose();
      return false;
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
      const el = document.querySelector(".reference-picker .ref-item.selected");
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  // Stable key per row so Svelte's keyed-each doesn't thrash on re-renders.
  function itemKey(item: PickerItem): string {
    if (item.kind === "worker") return `w:${item.name}`;
    if (item.kind === "bridge") return `b:${item.bridgeId}`;
    if (item.kind === "context") return `c:${item.bridgeId}:${item.item.index}`;
    return `s:${item.program}:${item.slug}`;
  }

  function iconFor(kind: PickerItem["kind"]): string {
    if (kind === "worker") return "\u{1F5A5}"; // 🖥
    if (kind === "bridge") return "\u{1F50C}"; // 🔌
    if (kind === "context") return "\u{1F4C4}"; // 📄
    return "\u{1F9E0}"; // 🧠 skill
  }

  function labelFor(kind: PickerItem["kind"]): string {
    if (kind === "worker") return "worker";
    if (kind === "bridge") return "bridge";
    if (kind === "context") return "context";
    return "skill";
  }

  function primaryText(item: PickerItem): string {
    if (item.kind === "worker") return item.name;
    if (item.kind === "bridge") return `${item.workerName} / ${item.bridgeName}`;
    if (item.kind === "context") return `@${item.item.index} ${item.item.name}`;
    return `/${item.slug}`;
  }

  function secondaryText(item: PickerItem): string {
    if (item.kind === "worker") {
      const parts: string[] = [];
      if (item.status === "online") {
        parts.push(`${item.activeBridgeCount} live`);
      } else {
        parts.push("offline");
      }
      if (item.programs.length > 0) parts.push(item.programs.join(", "));
      return parts.join(" · ");
    }
    if (item.kind === "bridge") {
      return item.program || "bridge";
    }
    if (item.kind === "context") {
      const ctx = item.item;
      const bits = [item.workerName, item.program || item.bridgeName, ctx.type];
      if (ctx.path) bits.push(ctx.path);
      return bits.filter(Boolean).join(" · ");
    }
    return item.program && item.program !== "global" ? item.program : "";
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
          enabled: s.enabled !== false,
        }));
      })
      .catch(() => {
        // If skills fail to load, workers/bridges/contexts still work.
        skills = [];
      })
      .finally(() => {
        skillsLoading = false;
      });
  });
</script>

<div class="reference-picker">
  <div class="picker-header">
    <span class="picker-title">Reference</span>
    <span class="picker-chips">
      <span class="chip" class:active={parsed.category === "all"}>all</span>
      <span class="chip" class:active={parsed.category === "worker"}>worker</span>
      <span class="chip" class:active={parsed.category === "bridge"}>bridge</span>
      <span class="chip" class:active={parsed.category === "context"}>context</span>
      <span class="chip" class:active={parsed.category === "skill"}>skill</span>
    </span>
    {#if query}
      <span class="picker-query">/{query}</span>
    {/if}
  </div>
  <div class="picker-body">
    {#if filtered.length === 0}
      <div class="picker-empty">
        {#if skillsLoading && parsed.category !== "worker" && parsed.category !== "bridge" && parsed.category !== "context"}
          Loading...
        {:else if query.trim()}
          No matches for "/{query}"
        {:else}
          Nothing to reference yet.
        {/if}
      </div>
    {:else}
      {#each filtered as item, i (itemKey(item))}
        <button
          type="button"
          class="ref-item"
          class:selected={i === selectedIndex}
          onclick={() => onselect(item, { trailingSpace: false })}
          onmouseenter={() => (selectedIndex = i)}
        >
          <span class="ref-icon">{iconFor(item.kind)}</span>
          <span class="ref-main">
            <span class="ref-primary">{primaryText(item)}</span>
            {#if secondaryText(item)}
              <span class="ref-secondary">{secondaryText(item)}</span>
            {/if}
          </span>
          <span class="ref-kind">{labelFor(item.kind)}</span>
        </button>
      {/each}
    {/if}
  </div>
  <div class="picker-footer">
    <span class="hint">↑↓ navigate</span>
    <span class="hint">Space autocompletes</span>
    <span class="hint">Enter commits</span>
    <span class="hint">Esc closes</span>
  </div>
</div>

<style>
  .reference-picker {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    width: 440px;
    max-height: 360px;
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
    flex-wrap: wrap;
  }

  .picker-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .picker-chips {
    display: flex;
    gap: 4px;
  }

  .chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    border: 1px solid transparent;
  }

  .chip.active {
    color: var(--accent);
    border-color: var(--accent);
  }

  .picker-query {
    margin-left: auto;
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

  .ref-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    width: 100%;
    margin: 0;
  }

  .ref-item:hover,
  .ref-item.selected {
    background: var(--bg-hover);
  }

  .ref-icon {
    font-size: 14px;
    width: 18px;
    text-align: center;
    flex-shrink: 0;
  }

  .ref-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .ref-primary {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono, monospace);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ref-secondary {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ref-kind {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }

  .picker-footer {
    display: flex;
    gap: 10px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-base);
  }

  .hint {
    font-size: 10px;
    color: var(--text-muted);
  }
</style>
