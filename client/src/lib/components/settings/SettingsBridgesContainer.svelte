<script lang="ts">
  import SettingsBridgesTab from "./SettingsBridgesTab.svelte";
  import SettingsApiBridgesTab from "./SettingsApiBridgesTab.svelte";

  type BridgeSubTab = "program" | "api" | "mcp";
  let subTab = $state<BridgeSubTab>("program");
</script>

<div class="bridge-subtabs">
  <button class="bridge-subtab" class:active={subTab === "program"} onclick={() => (subTab = "program")}>
    Program Bridges
  </button>
  <button class="bridge-subtab" class:active={subTab === "api"} onclick={() => (subTab = "api")}>
    API
  </button>
  <button class="bridge-subtab" class:active={subTab === "mcp"} onclick={() => (subTab = "mcp")}>
    MCP
  </button>
</div>

{#if subTab === "program"}
  <SettingsBridgesTab />
{:else if subTab === "api"}
  <SettingsApiBridgesTab mode="rest" />
{:else if subTab === "mcp"}
  <SettingsApiBridgesTab mode="mcp" />
{/if}

<style>
  .bridge-subtabs {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
  }
  .bridge-subtab {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    background: var(--bg-base);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .bridge-subtab:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .bridge-subtab.active {
    background: var(--bg-surface);
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
