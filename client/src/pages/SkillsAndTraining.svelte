<script lang="ts">
  import Skills from "./Skills.svelte";
  import CoordinatorScripts from "./CoordinatorScripts.svelte";
  import Training from "./Training.svelte";

  type Tab = "skills" | "scripts" | "training";
  let activeTab = $state<Tab>("skills");
</script>

<div class="coordinator-page">
  <div class="tabs">
    <button class="tab" class:active={activeTab === "skills"} onclick={() => (activeTab = "skills")}>Skills</button>
    <button class="tab" class:active={activeTab === "scripts"} onclick={() => (activeTab = "scripts")}>Scripts</button>
    <button class="tab" class:active={activeTab === "training"} onclick={() => (activeTab = "training")}>Training</button>
  </div>
  <div class="tab-content">
    {#if activeTab === "skills"}
      <Skills />
    {:else if activeTab === "scripts"}
      <CoordinatorScripts />
    {:else if activeTab === "training"}
      <Training />
    {/if}
  </div>
</div>

<style>
  .coordinator-page {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tabs {
    display: flex;
    gap: 8px;
    padding: 12px 16px 0;
    flex-shrink: 0;
  }
  .tab {
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: var(--font-size-sm);
  }
  .tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .tab-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
