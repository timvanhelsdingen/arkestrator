<script lang="ts">
  import { chatStore } from "../../stores/chat.svelte";

  let editingTabId = $state<string | null>(null);
  let editName = $state("");

  function startRename(tabId: string, currentName: string) {
    editingTabId = tabId;
    editName = currentName;
  }

  function commitRename() {
    if (editingTabId && editName.trim()) {
      chatStore.renameTab(editingTabId, editName.trim());
    }
    editingTabId = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") editingTabId = null;
  }
</script>

<div class="tab-bar">
  <div class="tabs">
    {#each chatStore.tabs as tab (tab.id)}
      <button
        class="tab"
        class:active={chatStore.activeTabId === tab.id}
        onclick={() => chatStore.switchTab(tab.id)}
        ondblclick={() => startRename(tab.id, tab.name)}
      >
        {#if editingTabId === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="tab-rename"
            bind:value={editName}
            onblur={commitRename}
            onkeydown={handleKeydown}
            autofocus
          />
        {:else}
          <span class="tab-name">{tab.name}</span>
          {#if tab.jobIds.length > 0}
            <span class="tab-badge">{tab.jobIds.length}</span>
          {/if}
          {#if chatStore.tabs.length > 1}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class="tab-close"
              role="button"
              tabindex="-1"
              onclick={(e: MouseEvent) => { e.stopPropagation(); chatStore.closeTab(tab.id); }}
              onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.stopPropagation(); chatStore.closeTab(tab.id); } }}
            >x</span>
          {/if}
        {/if}
      </button>
    {/each}
  </div>
  <button class="tab-add" onclick={() => chatStore.addTab()} title="New chat">+</button>
  <div class="tab-spacer"></div>
  <button
    class="toggle-context"
    class:active={chatStore.showContextPanel}
    onclick={() => (chatStore.showContextPanel = !chatStore.showContextPanel)}
    title="Toggle context panel"
  >
    Context
  </button>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    min-height: 36px;
    flex-shrink: 0;
  }
  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
    border-bottom: 2px solid transparent;
  }
  .tab:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
    background: var(--bg-elevated);
  }
  .tab-name {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab-badge {
    font-size: 10px;
    background: var(--accent);
    color: white;
    border-radius: 8px;
    padding: 0 5px;
    min-width: 16px;
    text-align: center;
  }
  .tab-close {
    font-size: 10px;
    color: var(--text-muted);
    padding: 0 2px;
    border-radius: 2px;
    line-height: 1;
  }
  .tab-close:hover {
    color: var(--status-failed);
    background: var(--bg-hover);
  }
  .tab-rename {
    width: 80px;
    font-size: var(--font-size-sm);
    padding: 1px 4px;
  }
  .tab-add {
    font-size: 16px;
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .tab-add:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .tab-spacer {
    flex: 1;
  }
  .toggle-context {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .toggle-context:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .toggle-context.active {
    color: var(--accent);
  }
</style>
