import type { ContextItem, EditorContext } from "@arkestrator/protocol";

export interface BridgeContextEntry {
  bridgeId: string;
  bridgeName: string;
  program: string;
  items: ContextItem[];
  editorContext?: EditorContext;
  files: Array<{ path: string; content: string }>;
}

class BridgeContextState {
  /** Map of bridgeId -> context state */
  bridges = $state<Map<string, BridgeContextEntry>>(new Map());
  /** Client-side item aliases keyed by bridgeId:index */
  itemAliases = $state<Map<string, string>>(new Map());

  private aliasKey(bridgeId: string, itemIndex: number): string {
    return `${bridgeId}:${itemIndex}`;
  }

  private clearBridgeAliases(bridgeId: string) {
    const next = new Map(this.itemAliases);
    for (const key of next.keys()) {
      if (key.startsWith(`${bridgeId}:`)) {
        next.delete(key);
      }
    }
    this.itemAliases = next;
  }

  getItemName(bridgeId: string, item: ContextItem): string {
    return this.itemAliases.get(this.aliasKey(bridgeId, item.index)) ?? item.name;
  }

  getItemsForJob(bridgeId: string): ContextItem[] {
    const entry = this.bridges.get(bridgeId);
    if (!entry) return [];
    return entry.items.map((item) => ({
      ...item,
      name: this.getItemName(bridgeId, item),
    }));
  }

  renameItem(bridgeId: string, itemIndex: number, name: string) {
    const key = this.aliasKey(bridgeId, itemIndex);
    const trimmed = name.trim();
    const next = new Map(this.itemAliases);
    if (trimmed) {
      next.set(key, trimmed);
    } else {
      next.delete(key);
    }
    this.itemAliases = next;
  }

  /** All context items across all bridges, flattened */
  get allItems(): Array<ContextItem & { bridgeId: string; program: string }> {
    const result: Array<ContextItem & { bridgeId: string; program: string }> = [];
    for (const [bridgeId, entry] of this.bridges) {
      for (const item of entry.items) {
        result.push({
          ...item,
          name: this.getItemName(bridgeId, item),
          bridgeId,
          program: entry.program,
        });
      }
    }
    return result;
  }

  /** Handle bridge_context_sync — merges incoming bridges into current state */
  sync(bridges: BridgeContextEntry[]) {
    const next = new Map(this.bridges);
    for (const b of bridges) {
      const existing = next.get(b.bridgeId);
      if (existing) {
        next.set(b.bridgeId, {
          ...existing,
          ...b,
          editorContext: b.editorContext ?? existing.editorContext,
          files: b.files.length > 0 ? b.files : existing.files,
        });
      } else {
        next.set(b.bridgeId, b);
      }
    }
    this.bridges = next;
    // Clear aliases for bridges that got re-indexed
    for (const b of bridges) {
      this.clearBridgeAliases(b.bridgeId);
    }
  }

  /** Handle bridge_context_item_add */
  addItem(bridgeId: string, bridgeName: string, program: string, item: ContextItem) {
    const copy = new Map(this.bridges);
    let entry = copy.get(bridgeId);
    if (!entry) {
      entry = { bridgeId, bridgeName, program, items: [], files: [] };
    } else {
      entry = { ...entry, items: [...entry.items] };
    }
    // De-duplicate by @index within a bridge (idempotent if event is replayed).
    const idx = entry.items.findIndex((existing) => existing.index === item.index);
    if (idx >= 0) {
      entry.items[idx] = item;
    } else {
      entry.items.push(item);
    }
    copy.set(bridgeId, entry);
    this.bridges = copy;
  }

  /** Handle bridge_context_clear */
  clear(bridgeId: string) {
    const copy = new Map(this.bridges);
    copy.delete(bridgeId);
    this.bridges = copy;
    this.clearBridgeAliases(bridgeId);
  }

  /** Clear just the context items for a bridge (keep editor context and files) */
  clearItems(bridgeId: string) {
    const copy = new Map(this.bridges);
    const entry = copy.get(bridgeId);
    if (entry) {
      copy.set(bridgeId, { ...entry, items: [] });
      this.bridges = copy;
      this.clearBridgeAliases(bridgeId);
    }
  }

  /** Remove a single context item by index */
  removeItem(bridgeId: string, itemIndex: number) {
    const copy = new Map(this.bridges);
    const entry = copy.get(bridgeId);
    if (entry) {
      copy.set(bridgeId, {
        ...entry,
        items: entry.items.filter((i) => i.index !== itemIndex),
      });
      this.bridges = copy;
      const key = this.aliasKey(bridgeId, itemIndex);
      if (this.itemAliases.has(key)) {
        const next = new Map(this.itemAliases);
        next.delete(key);
        this.itemAliases = next;
      }
    }
  }

  /** Handle bridge_editor_context */
  setEditorContext(
    bridgeId: string,
    bridgeName: string,
    program: string,
    editorContext: EditorContext,
    files: Array<{ path: string; content: string }>,
  ) {
    const copy = new Map(this.bridges);
    let entry = copy.get(bridgeId);
    if (!entry) {
      entry = { bridgeId, bridgeName, program, items: [], files: [] };
    } else {
      entry = { ...entry };
    }
    entry.editorContext = editorContext;
    entry.files = files;
    copy.set(bridgeId, entry);
    this.bridges = copy;
  }
}

export const bridgeContextStore = new BridgeContextState();
