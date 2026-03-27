<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../api/rest";

  interface TrainingSchedule {
    enabled: boolean;
    intervalMinutes: number;
    apply: boolean;
    programs: string[];
  }

  const INTERVAL_OPTIONS = [
    { label: "Every 6 hours", value: 360 },
    { label: "Every 12 hours", value: 720 },
    { label: "Daily", value: 1440 },
    { label: "Every 3 days", value: 4320 },
    { label: "Weekly", value: 10080 },
  ];

  let schedule = $state<TrainingSchedule>({
    enabled: true,
    intervalMinutes: 1440,
    apply: true,
    programs: [],
  });
  let loading = $state(true);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");

  onMount(async () => {
    try {
      const res = await api.settings.getCoordinatorTrainingSchedule();
      const data = res as any;
      if (data) {
        schedule = {
          enabled: data.enabled ?? true,
          intervalMinutes: data.intervalMinutes ?? 1440,
          apply: data.apply ?? true,
          programs: data.programs ?? [],
        };
      }
    } catch {
      // Defaults are fine
    } finally {
      loading = false;
    }
  });

  async function saveSchedule() {
    error = "";
    saving = true;
    try {
      await api.settings.setCoordinatorTrainingSchedule({
        enabled: schedule.enabled,
        intervalMinutes: schedule.intervalMinutes,
        apply: schedule.apply,
        programs: schedule.programs,
      });
      saved = true;
    } catch (err: any) {
      error = `Failed to save: ${err.message}`;
    } finally {
      saving = false;
    }
  }

  function toggleEnabled() {
    schedule.enabled = !schedule.enabled;
    saved = false;
  }

  function toggleAutoApply() {
    schedule.apply = !schedule.apply;
    saved = false;
  }

  function setInterval(minutes: number) {
    schedule.intervalMinutes = minutes;
    saved = false;
  }
</script>

<div class="skills-training">
  <h3>Skills & Training</h3>
  <p class="subtitle">Arkestrator learns from every job it runs — building skills and improving over time.</p>

  <div class="explainer">
    <div class="loop-diagram">
      <div class="loop-step">
        <span class="step-icon">1</span>
        <span class="step-text">Jobs run and produce results</span>
      </div>
      <div class="loop-arrow">&darr;</div>
      <div class="loop-step">
        <span class="step-icon">2</span>
        <span class="step-text">Training analyzes what worked (and what didn't)</span>
      </div>
      <div class="loop-arrow">&darr;</div>
      <div class="loop-step">
        <span class="step-icon">3</span>
        <span class="step-text">Skills are extracted and stored for reuse</span>
      </div>
      <div class="loop-arrow">&darr;</div>
      <div class="loop-step">
        <span class="step-icon">4</span>
        <span class="step-text">Future jobs benefit from learned techniques</span>
      </div>
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading training settings...</div>
  {:else}
    <div class="settings-section">
      <h4>Automatic Training</h4>

      <label class="toggle-row">
        <input type="checkbox" checked={schedule.enabled} onchange={toggleEnabled} />
        <div class="toggle-info">
          <span class="toggle-label">Enable scheduled training</span>
          <span class="toggle-desc">Periodically review completed jobs and extract new skills</span>
        </div>
      </label>

      {#if schedule.enabled}
        <div class="interval-picker">
          <span class="picker-label">Run training:</span>
          <div class="interval-options">
            {#each INTERVAL_OPTIONS as opt}
              <button
                class="interval-btn"
                class:active={schedule.intervalMinutes === opt.value}
                onclick={() => setInterval(opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>

        <label class="toggle-row">
          <input type="checkbox" checked={schedule.apply} onchange={toggleAutoApply} />
          <div class="toggle-info">
            <span class="toggle-label">Auto-apply learned skills</span>
            <span class="toggle-desc">Automatically update coordinator scripts with new techniques</span>
          </div>
        </label>
      {/if}
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button
        class="btn primary"
        disabled={saving || saved}
        onclick={saveSettings}
      >
        {saving ? "Saving..." : saved ? "Saved!" : "Save Training Settings"}
      </button>
      <span class="skip-hint">You can fine-tune training later in the Admin panel.</span>
    </div>
  {/if}
</div>

<style>
  .skills-training {
    text-align: left;
  }
  h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  h4 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 10px;
  }
  .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 16px;
  }

  /* Self-learning loop diagram */
  .explainer {
    margin-bottom: 18px;
  }
  .loop-diagram {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 14px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .loop-step {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .step-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    background: var(--accent);
    color: var(--text-on-accent);
    flex-shrink: 0;
  }
  .step-text {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.4;
  }
  .loop-arrow {
    padding-left: 7px;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1;
  }

  /* Settings */
  .settings-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    background: var(--bg-base);
    margin-bottom: 12px;
  }
  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    margin-bottom: 10px;
  }
  .toggle-row:last-child {
    margin-bottom: 0;
  }
  .toggle-row input {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .toggle-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .toggle-label {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }
  .toggle-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.3;
  }

  /* Interval picker */
  .interval-picker {
    margin: 10px 0 12px;
    padding-left: 24px;
  }
  .picker-label {
    font-size: 11px;
    color: var(--text-muted);
    display: block;
    margin-bottom: 6px;
  }
  .interval-options {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .interval-btn {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .interval-btn:hover {
    border-color: var(--text-muted);
  }
  .interval-btn.active {
    border-color: var(--accent);
    background: rgba(99, 102, 241, 0.1);
    color: var(--accent);
    font-weight: 500;
  }

  .loading {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
    padding: 24px 0;
  }
  .error {
    font-size: 12px;
    color: #ff9d9d;
    padding: 8px;
    background: rgba(244, 71, 71, 0.1);
    border-radius: var(--radius-sm);
    margin-bottom: 8px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .skip-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.primary:disabled {
    opacity: 0.5;
    cursor: default;
    filter: none;
  }
</style>
