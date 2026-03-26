<script lang="ts">
  import type { ContextItem } from "@arkestrator/protocol";
  import { bridgeContextStore } from "../../stores/bridgeContext.svelte";
  import { workersStore } from "../../stores/workers.svelte";
  import { sendMessage } from "../../api/ws";
  import { truncate } from "../../utils/format";

  const CONTEXT_DRAG_MIME = "application/x-arkestrator-context-item+json";
  const CONTEXT_DRAG_REF_MIME = "text/x-arkestrator-context-ref";
  let expandedMachine = $state<string | null>(null);
  let expandedBridge = $state<string | null>(null);
  let editingItemKey = $state<string | null>(null);
  let editItemName = $state("");

  let connectedBridges = $derived(
    workersStore.bridges.filter((b) => b.connected),
  );

  let bridgesByMachine = $derived.by(() => {
    const groups = new Map<string, typeof connectedBridges>();
    for (const b of connectedBridges) {
      const machineName = String(b.workerName ?? "").trim() || "Unknown Machine";
      const list = groups.get(machineName) || [];
      list.push(b);
      groups.set(machineName, list);
    }
    return groups;
  });

  function isMachineExpanded(machineName: string): boolean {
    return expandedMachine === machineName;
  }

  function toggleMachine(machineName: string) {
    expandedMachine = expandedMachine === machineName ? null : machineName;
  }

  function itemKey(bridgeId: string, itemIndex: number): string {
    return `${bridgeId}:${itemIndex}`;
  }

  function startRenameItem(bridgeId: string, item: ContextItem) {
    editingItemKey = itemKey(bridgeId, item.index);
    editItemName = bridgeContextStore.getItemName(bridgeId, item);
  }

  function commitRenameItem(bridgeId: string, itemIndex: number) {
    bridgeContextStore.renameItem(bridgeId, itemIndex, editItemName);
    editingItemKey = null;
    editItemName = "";
  }

  function cancelRenameItem() {
    editingItemKey = null;
    editItemName = "";
  }

  function onRenameKeydown(e: KeyboardEvent, bridgeId: string, itemIndex: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRenameItem(bridgeId, itemIndex);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelRenameItem();
    }
  }

  function removeContextItem(bridgeId: string, itemIndex: number) {
    sendMessage({
      type: "client_context_item_remove",
      id: crypto.randomUUID(),
      payload: { bridgeId, itemIndex },
    });
    // Optimistic local update (server will also broadcast a sync)
    bridgeContextStore.removeItem(bridgeId, itemIndex);
  }

  function clearContextItems(bridgeId: string) {
    sendMessage({
      type: "client_context_items_clear",
      id: crypto.randomUUID(),
      payload: { bridgeId },
    });
    // Optimistic local update
    bridgeContextStore.clearItems(bridgeId);
  }

  function formatDragReference(item: ContextItem): string {
    return `@${item.index}`;
  }

  function onContextItemDragStart(
    e: DragEvent,
    bridgeId: string,
    program: string,
    item: ContextItem,
  ) {
    const name = bridgeContextStore.getItemName(bridgeId, item).trim();
    const payload = {
      bridgeId,
      program,
      index: item.index,
      name,
      path: item.path,
      type: item.type,
    };
    const text = formatDragReference(item);
    e.dataTransfer?.setData(CONTEXT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer?.setData(CONTEXT_DRAG_REF_MIME, text);
    e.dataTransfer?.setData("text/plain", text);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "copy";
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="context-panel">
  <div class="panel-header">
    <strong>Bridge Context</strong>
    <span class="bridge-count">{connectedBridges.length} connected</span>
  </div>

  <div class="panel-content">
    {#if connectedBridges.length === 0}
      <div class="no-bridges">
        <p>No bridges connected</p>
        <p class="hint">Connect a DCC app (Godot, Blender) to see editor context here.</p>
      </div>
    {:else}
      {#each [...bridgesByMachine] as [machineName, bridges] (machineName)}
        <div class="machine-section">
          <button class="machine-header" type="button" onclick={() => toggleMachine(machineName)}>
            <span class="machine-name">{machineName}</span>
            <span class="machine-count">{bridges.length}</span>
            <span class="expand-icon">{isMachineExpanded(machineName) ? "\u25B2" : "\u25BC"}</span>
          </button>

          {#if isMachineExpanded(machineName)}
            <div class="machine-bridges">
              {#each bridges as bridge (bridge.id)}
                {@const ctx = bridgeContextStore.bridges.get(bridge.id)}
                <div class="bridge-section">
                  <button
                    class="bridge-header"
                    type="button"
                    onclick={() => (expandedBridge = expandedBridge === bridge.id ? null : bridge.id)}
                  >
                    <span class="bridge-icon bridge-{bridge.program}">{bridge.program?.[0]?.toUpperCase() ?? "?"}</span>
                    <span class="bridge-name">{bridge.program ? `${bridge.program[0].toUpperCase() + bridge.program.slice(1)} — ${bridge.name}` : bridge.name}</span>
                    <span class="expand-icon">{expandedBridge === bridge.id ? "\u25B2" : "\u25BC"}</span>
                  </button>

                  {#if expandedBridge === bridge.id}
                    <div class="bridge-details">
                      {#if ctx?.editorContext}
                        <div class="context-section">
                          <div class="section-label">Editor State</div>
                          {#if ctx.editorContext.projectRoot}
                            <div class="ctx-row">
                              <span class="ctx-key">Project:</span>
                              <code class="ctx-val">{truncate(ctx.editorContext.projectRoot, 40)}</code>
                            </div>
                          {/if}
                          {#if ctx.editorContext.activeFile}
                            <div class="ctx-row">
                              <span class="ctx-key">Active:</span>
                              <code class="ctx-val">{truncate(ctx.editorContext.activeFile, 40)}</code>
                            </div>
                          {/if}
                          {#if ctx.editorContext.metadata}
                            {#if ctx.editorContext.metadata.active_scene}
                              <div class="ctx-row">
                                <span class="ctx-key">Scene:</span>
                                <code class="ctx-val">{ctx.editorContext.metadata.active_scene}</code>
                              </div>
                            {/if}
                            {#if ctx.editorContext.metadata.selected_nodes}
                              {@const nodes = ctx.editorContext.metadata.selected_nodes as any[]}
                              {#if nodes.length > 0}
                                <div class="ctx-row">
                                  <span class="ctx-key">Selected:</span>
                                  <span class="ctx-val">{nodes.map((n: any) => n.name || n).join(", ")}</span>
                                </div>
                              {/if}
                            {/if}
                            {#if ctx.editorContext.metadata.selected_objects}
                              {@const objs = ctx.editorContext.metadata.selected_objects as any[]}
                              {#if objs.length > 0}
                                <div class="ctx-row">
                                  <span class="ctx-key">Selected:</span>
                                  <span class="ctx-val">{objs.map((o: any) => o.name || o).join(", ")}</span>
                                </div>
                              {/if}
                            {/if}
                          {/if}
                        </div>
                      {/if}

                      {#if ctx?.files && ctx.files.length > 0}
                        <div class="context-section">
                          <div class="section-label">Open Files ({ctx.files.length})</div>
                          {#each ctx.files as file}
                            <div class="file-row">
                              <code>{truncate(file.path, 45)}</code>
                            </div>
                          {/each}
                        </div>
                      {/if}

                      {#if ctx?.items && ctx.items.length > 0}
                        <div class="context-section">
                          <div class="section-label-row">
                            <span class="section-label">Context Items ({ctx.items.length})</span>
                            <button class="clear-btn" type="button" onclick={() => clearContextItems(bridge.id)} title="Clear all items">Clear</button>
                          </div>
                          {#each ctx.items as item}
                            {@const rowKey = itemKey(bridge.id, item.index)}
                            <div class="item-row">
                              <!-- svelte-ignore a11y_no_static_element_interactions -->
                              <div
                                class="item-drag-target"
                                draggable={editingItemKey !== rowKey ? "true" : "false"}
                                role="button"
                                tabindex="-1"
                                title="Drag into prompt"
                                ondragstart={(e) => onContextItemDragStart(e, bridge.id, bridge.program ?? "", item)}
                              >
                                <span class="drag-item-btn">drag</span>
                                <span class="item-index">@{item.index}</span>
                                <span class="item-type">{item.type}</span>
                                {#if editingItemKey === rowKey}
                                  <!-- svelte-ignore a11y_autofocus -->
                                  <input
                                    class="item-rename"
                                    bind:value={editItemName}
                                    onblur={() => commitRenameItem(bridge.id, item.index)}
                                    onkeydown={(e: KeyboardEvent) => onRenameKeydown(e, bridge.id, item.index)}
                                    autofocus
                                  />
                                {:else}
                                  <span class="item-name">{truncate(bridgeContextStore.getItemName(bridge.id, item), 30)}</span>
                                {/if}
                              </div>
                              {#if editingItemKey !== rowKey}
                                <button class="rename-item-btn" type="button" onclick={() => startRenameItem(bridge.id, item)} title="Rename item">rename</button>
                              {/if}
                              <button class="remove-item-btn" type="button" onclick={() => removeContextItem(bridge.id, item.index)} title="Remove item">x</button>
                            </div>
                          {/each}
                        </div>
                      {/if}

                      {#if !ctx || (!ctx.editorContext && (!ctx.items || ctx.items.length === 0))}
                        <div class="no-context">No context available</div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .context-panel {
    position: relative;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }
  .bridge-count {
    font-size: 11px;
    color: var(--text-muted);
  }
  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }
  .machine-section {
    border-bottom: 1px solid var(--border);
  }
  .machine-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    font-size: var(--font-size-sm);
    font-weight: 400;
    color: var(--text-primary);
  }
  .machine-header:hover {
    background: var(--bg-hover);
  }
  .machine-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .machine-count {
    font-size: 10px;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 0 5px;
    border-radius: 8px;
    font-weight: 500;
    flex-shrink: 0;
  }
  .machine-bridges {
    padding-left: 8px;
  }
  .bridge-section {
    border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .bridge-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px;
    text-align: left;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .bridge-header:hover {
    background: var(--bg-hover);
  }
  .bridge-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .bridge-godot { background: #478cbf22; color: #478cbf; }
  .bridge-blender { background: #ea722022; color: #ea7220; }
  .bridge-houdini { background: #ff450022; color: #ff4500; }
  .bridge-comfyui { background: #16a34a22; color: #16a34a; }
  .bridge-unity { background: #cbd5e122; color: #cbd5e1; }
  .bridge-unreal { background: #a78bfa22; color: #a78bfa; }
  .bridge-fusion { background: #e8b83222; color: #e8b832; }
  .bridge-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .expand-icon {
    font-size: 9px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .bridge-details {
    padding: 0 12px 8px;
  }
  .context-section {
    margin-top: 6px;
  }
  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .ctx-row {
    display: flex;
    gap: 4px;
    font-size: 11px;
    padding: 1px 0;
    align-items: baseline;
  }
  .ctx-key {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .ctx-val {
    color: var(--text-secondary);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-row {
    font-size: 11px;
    padding: 1px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-row code {
    color: var(--text-secondary);
    font-size: 10px;
  }
  .section-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .clear-btn {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--text-muted);
    background: var(--bg-base);
    border: 1px solid var(--border);
  }
  .clear-btn:hover {
    color: var(--status-failed);
    border-color: var(--status-failed);
  }
  .item-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 0;
  }
  .item-drag-target {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    cursor: grab;
  }
  .item-drag-target:active {
    cursor: grabbing;
  }
  .drag-item-btn {
    font-size: 9px;
    line-height: 1;
    border-radius: 2px;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    padding: 1px 3px;
    flex-shrink: 0;
    user-select: none;
    opacity: 0.55;
  }
  .item-row:hover .drag-item-btn,
  .item-row:hover .item-drag-target {
    opacity: 1;
  }
  .item-row:hover .drag-item-btn {
    border-color: var(--accent);
    color: var(--accent);
  }
  .item-rename {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--accent);
    background: var(--bg-base);
    color: var(--text-primary);
  }
  .rename-item-btn {
    font-size: 9px;
    line-height: 1;
    border-radius: 2px;
    color: var(--text-muted);
    opacity: 0;
    flex-shrink: 0;
    padding: 1px 3px;
  }
  .item-row:hover .rename-item-btn {
    opacity: 1;
  }
  .rename-item-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .remove-item-btn {
    font-size: 9px;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    color: var(--text-muted);
    opacity: 0;
    flex-shrink: 0;
  }
  .item-row:hover .remove-item-btn {
    opacity: 1;
  }
  .remove-item-btn:hover {
    color: var(--status-failed);
    background: var(--bg-hover);
  }
  .item-index {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  .item-type {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 0 3px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .item-name {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .no-context {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 4px 0;
  }
  .no-bridges {
    padding: 24px 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }
  .hint {
    font-size: 11px;
    margin-top: 4px;
    opacity: 0.7;
  }
</style>
