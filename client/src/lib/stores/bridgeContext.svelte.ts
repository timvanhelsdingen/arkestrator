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
  /** Map of bridgeId -> context state. Mutated in-place; bump `version` to trigger reactivity. */
  private _bridges = new Map<string, BridgeContextEntry>();
  /** Client-side item aliases keyed by bridgeId:index */
  private _aliases = new Map<string, string>();
  /**
   * Monotonic version counter — bumped on every mutation.
   * Svelte 5 tracks $state reads, so any getter that reads `version`
   * will re-run when it changes, without copying the entire Map.
   */
  version = $state(0);

  private bump() { this.version++; }

  private aliasKey(bridgeId: string, itemIndex: number): string {
    return `${bridgeId}:${itemIndex}`;
  }

  private clearBridgeAliases(bridgeId: string) {
    let changed = false;
    for (const key of this._aliases.keys()) {
      if (key.startsWith(`${bridgeId}:`)) {
        this._aliases.delete(key);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  getItemName(bridgeId: string, item: ContextItem): string {
    // Read version to subscribe to changes
    void this.version;
    return this._aliases.get(this.aliasKey(bridgeId, item.index)) ?? item.name;
  }

  getItemsForJob(bridgeId: string): ContextItem[] {
    void this.version;
    const entry = this._bridges.get(bridgeId);
    if (!entry) return [];
    return entry.items.map((item) => ({
      ...item,
      name: this.getItemName(bridgeId, item),
    }));
  }

  renameItem(bridgeId: string, itemIndex: number, name: string) {
    const key = this.aliasKey(bridgeId, itemIndex);
    const trimmed = name.trim();
    if (trimmed) {
      this._aliases.set(key, trimmed);
    } else {
      this._aliases.delete(key);
    }
    this.bump();
  }

  /** All context items across all bridges, flattened */
  get allItems(): Array<ContextItem & { bridgeId: string; program: string }> {
    // Reading version subscribes this getter to all mutations
    void this.version;
    const result: Array<ContextItem & { bridgeId: string; program: string }> = [];
    for (const [bridgeId, entry] of this._bridges) {
      for (const item of entry.items) {
        result.push({
          ...item,
          name: this._aliases.get(this.aliasKey(bridgeId, item.index)) ?? item.name,
          bridgeId,
          program: entry.program,
        });
      }
    }
    return result;
  }

  /** All bridge entries for iteration */
  get bridges(): Map<string, BridgeContextEntry> {
    void this.version;
    return this._bridges;
  }

  /** Handle bridge_context_sync — merges incoming bridges into current state */
  sync(bridges: BridgeContextEntry[]) {
    for (const b of bridges) {
      const existing = this._bridges.get(b.bridgeId);
      if (existing) {
        this._bridges.set(b.bridgeId, {
          ...existing,
          ...b,
          editorContext: b.editorContext ?? existing.editorContext,
          files: b.files.length > 0 ? b.files : existing.files,
        });
      } else {
        this._bridges.set(b.bridgeId, b);
      }
      this.clearBridgeAliases(b.bridgeId);
    }
    this.bump();
  }

  /** Handle bridge_context_item_add */
  addItem(bridgeId: string, bridgeName: string, program: string, item: ContextItem) {
    let entry = this._bridges.get(bridgeId);
    if (!entry) {
      entry = { bridgeId, bridgeName, program, items: [], files: [] };
      this._bridges.set(bridgeId, entry);
    }
    // De-duplicate by @index within a bridge (idempotent if event is replayed).
    const idx = entry.items.findIndex((existing) => existing.index === item.index);
    if (idx >= 0) {
      entry.items[idx] = item;
    } else {
      entry.items.push(item);
    }
    this.bump();
  }

  /** Handle bridge_context_clear */
  clear(bridgeId: string) {
    this._bridges.delete(bridgeId);
    this.clearBridgeAliases(bridgeId);
    this.bump();
  }

  /** Clear just the context items for a bridge (keep editor context and files) */
  clearItems(bridgeId: string) {
    const entry = this._bridges.get(bridgeId);
    if (entry) {
      entry.items = [];
      this.clearBridgeAliases(bridgeId);
      this.bump();
    }
  }

  /** Remove a single context item by index */
  removeItem(bridgeId: string, itemIndex: number) {
    const entry = this._bridges.get(bridgeId);
    if (entry) {
      entry.items = entry.items.filter((i) => i.index !== itemIndex);
      const key = this.aliasKey(bridgeId, itemIndex);
      this._aliases.delete(key);
      this.bump();
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
    let entry = this._bridges.get(bridgeId);
    if (!entry) {
      entry = { bridgeId, bridgeName, program, items: [], files: [] };
      this._bridges.set(bridgeId, entry);
    }
    entry.editorContext = editorContext;
    entry.files = files;
    this.bump();
  }
}

export const bridgeContextStore = new BridgeContextState();
