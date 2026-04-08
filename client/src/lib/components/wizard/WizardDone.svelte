<script lang="ts">
  import { wizard } from "../../stores/wizard.svelte";
</script>

<div class="done">
  <div class="checkmark">&#10003;</div>
  <h2>You're All Set!</h2>
  <p class="subtitle">Arkestrator is ready to go.</p>

  <div class="summary">
    {#if wizard.agentsCreated > 0}
      <div class="summary-item">
        <span class="count">{wizard.agentsCreated}</span>
        <span>agent{wizard.agentsCreated === 1 ? "" : "s"} configured</span>
      </div>
    {/if}
    {#if wizard.bridgesInstalled > 0}
      <div class="summary-item">
        <span class="count">{wizard.bridgesInstalled}</span>
        <span>bridge{wizard.bridgesInstalled === 1 ? "" : "s"} installed</span>
      </div>
    {/if}
    {#if wizard.apiBridgesConfigured > 0}
      <div class="summary-item">
        <span class="count">{wizard.apiBridgesConfigured}</span>
        <span>API bridge{wizard.apiBridgesConfigured === 1 ? "" : "s"} configured</span>
      </div>
    {/if}
    {#if wizard.agentsCreated === 0 && wizard.bridgesInstalled === 0 && wizard.apiBridgesConfigured === 0}
      <p class="hint">You can configure agents and install bridges later in Settings.</p>
    {/if}
  </div>

  <button class="btn primary" onclick={() => wizard.markComplete()}>
    Get Started
  </button>
</div>

<style>
  .done {
    text-align: center;
  }
  .checkmark {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--text-on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    font-weight: 700;
    margin: 0 auto 12px;
  }
  h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 20px;
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    margin-bottom: 24px;
  }
  .summary-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .count {
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: 600;
    min-width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    font-size: 12px;
    padding: 0 6px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
  }
  .btn {
    padding: 10px 28px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
</style>
