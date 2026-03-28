<script lang="ts">
  import { api } from "../../api/rest";
  import { connection } from "../../stores/connection.svelte";

  interface PersonalityPreset {
    id: string;
    name: string;
    description: string;
  }

  let presets = $state<PersonalityPreset[]>([]);
  let selected = $state("default");
  let customPrompt = $state("");
  let loading = $state(true);
  let saving = $state(false);
  let saved = $state(false);

  $effect(() => {
    if (!connection.isAuthenticated) return;
    loading = true;
    Promise.all([
      api.auth.getChatPersonalityPresets().catch(() => ({ presets: [] })),
      api.auth.getChatPersonality().catch(() => ({ personality: "default", customPrompt: "" })),
    ]).then(([presetsRes, currentRes]) => {
      presets = (presetsRes as any)?.presets ?? [];
      selected = (currentRes as any)?.personality ?? "default";
      customPrompt = (currentRes as any)?.customPrompt ?? "";
    }).finally(() => { loading = false; });
  });

  async function savePersonality() {
    saving = true;
    try {
      await api.auth.setChatPersonality(
        selected,
        selected === "custom" ? customPrompt.trim() || undefined : undefined,
      );
      saved = true;
    } catch { /* non-critical */ }
    saving = false;
  }
</script>

<div class="wizard-personality">
  <h2>Chat Personality</h2>
  <p class="hint">How should Arkestrator talk to you? This is your personal preference — other users can pick their own.</p>

  {#if loading}
    <p class="hint">Loading...</p>
  {:else if presets.length === 0}
    <p class="hint">No personality presets available on this server.</p>
  {:else}
    <div class="personality-grid">
      {#each presets as preset (preset.id)}
        <button
          class="personality-card"
          class:active={selected === preset.id}
          onclick={() => { selected = preset.id; saved = false; }}
        >
          <span class="pname">{preset.name}</span>
          <span class="pdesc">{preset.description}</span>
        </button>
      {/each}
      <button
        class="personality-card"
        class:active={selected === "custom"}
        onclick={() => { selected = "custom"; saved = false; }}
      >
        <span class="pname">Custom</span>
        <span class="pdesc">Write your own</span>
      </button>
    </div>
    {#if selected === "custom"}
      <textarea
        class="custom-prompt"
        placeholder="Describe how Arkestrator should talk to you..."
        rows="3"
        value={customPrompt}
        oninput={(e) => { customPrompt = (e.target as HTMLTextAreaElement).value; saved = false; }}
      ></textarea>
    {/if}
    <div class="actions">
      <button class="btn primary" onclick={savePersonality} disabled={saving || saved}>
        {saving ? "Saving..." : saved ? "Saved!" : "Save Preference"}
      </button>
    </div>
  {/if}
</div>

<style>
  .wizard-personality {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }
  .hint {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }
  .personality-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .personality-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    background: var(--bg-base);
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transition: all 0.15s;
  }
  .personality-card:hover {
    border-color: var(--text-muted);
  }
  .personality-card.active {
    border-color: var(--accent);
    background: rgba(99, 102, 241, 0.1);
  }
  .pname {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .personality-card.active .pname {
    color: var(--accent);
  }
  .pdesc {
    font-size: 10px;
    color: var(--text-muted);
    line-height: 1.3;
  }
  .custom-prompt {
    width: 100%;
    font-size: 12px;
    font-family: inherit;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    resize: vertical;
    min-height: 60px;
  }
  .custom-prompt:focus {
    border-color: var(--accent);
    outline: none;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    border: none;
  }
  .btn.primary {
    background: var(--accent);
    color: white;
  }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
