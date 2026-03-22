<script lang="ts">
  import Skills from "./Skills.svelte";
  import CoordinatorTraining from "./CoordinatorTraining.svelte";

  type Tab = "skills" | "training";

  let activeTab = $state<Tab>("skills");
</script>

<div class="knowledge-page">
  <div class="tab-bar">
    <button
      class="tab"
      class:active={activeTab === "skills"}
      onclick={() => (activeTab = "skills")}
    >
      Skills
    </button>
    <button
      class="tab"
      class:active={activeTab === "training"}
      onclick={() => (activeTab = "training")}
    >
      Training Vault
    </button>
  </div>

  <div class="tab-content">
    {#if activeTab === "skills"}
      <Skills />
    {:else}
      <CoordinatorTraining />
    {/if}
  </div>
</div>

<style>
  .knowledge-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tab-bar {
    display: flex;
    gap: 0;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .tab {
    padding: 10px 20px;
    font-size: var(--font-size-base);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab:hover {
    color: var(--text-primary);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-content {
    flex: 1;
    overflow-y: auto;
  }
</style>
