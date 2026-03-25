<script lang="ts">
  import { wizard } from "../lib/stores/wizard.svelte";
  import WizardWelcome from "../lib/components/wizard/WizardWelcome.svelte";
  import WizardAgentSetup from "../lib/components/wizard/WizardAgentSetup.svelte";
  import WizardBridges from "../lib/components/wizard/WizardBridges.svelte";
  import WizardDone from "../lib/components/wizard/WizardDone.svelte";

  // Step mapping differs by mode:
  // Local:  [Welcome, AgentSetup, Bridges, Done]
  // Remote: [Welcome, Bridges, Done]
  function getStepComponent(stepIndex: number) {
    if (wizard.isLocal) {
      switch (stepIndex) {
        case 0: return "welcome";
        case 1: return "agents";
        case 2: return "bridges";
        case 3: return "done";
        default: return "welcome";
      }
    } else {
      switch (stepIndex) {
        case 0: return "welcome";
        case 1: return "bridges";
        case 2: return "done";
        default: return "welcome";
      }
    }
  }

  let currentComponent = $derived(getStepComponent(wizard.currentStep));
  let isFirst = $derived(wizard.currentStep === 0);
  let isLast = $derived(wizard.currentStep === wizard.totalSteps - 1);
</script>

<div class="wizard-container">
  <div class="wizard-card">
    <!-- Step indicator -->
    <div class="step-indicator">
      {#each wizard.steps as label, i}
        <div
          class="step"
          class:active={i === wizard.currentStep}
          class:completed={i < wizard.currentStep}
        >
          <div class="step-circle">
            {#if i < wizard.currentStep}
              <span class="check">&#10003;</span>
            {:else}
              {i + 1}
            {/if}
          </div>
          <span class="step-label">{label}</span>
        </div>
        {#if i < wizard.steps.length - 1}
          <div
            class="step-connector"
            class:completed={i < wizard.currentStep}
          ></div>
        {/if}
      {/each}
    </div>

    <!-- Step content -->
    <div class="step-content">
      {#if currentComponent === "welcome"}
        <WizardWelcome />
      {:else if currentComponent === "agents"}
        <WizardAgentSetup />
      {:else if currentComponent === "bridges"}
        <WizardBridges />
      {:else if currentComponent === "done"}
        <WizardDone />
      {/if}
    </div>

    <!-- Navigation -->
    {#if !isLast}
      <div class="nav-bar">
        <button class="btn ghost" onclick={() => wizard.skip()}>
          Skip Setup
        </button>
        <div class="nav-right">
          {#if !isFirst}
            <button class="btn secondary" onclick={() => wizard.prevStep()}>
              Back
            </button>
          {/if}
          <button class="btn primary" onclick={() => wizard.nextStep()}>
            {isFirst ? "Get Started" : "Next"}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .wizard-container {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    background: var(--bg-base);
    padding: 20px;
  }
  .wizard-card {
    width: 100%;
    max-width: 580px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 80px);
  }

  /* Step indicator */
  .step-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .step-circle {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    border: 2px solid var(--border);
    color: var(--text-muted);
    background: var(--bg-base);
    transition: all 0.2s;
  }
  .step.active .step-circle {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .step.completed .step-circle {
    border-color: #4ade80;
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }
  .check {
    font-size: 14px;
    font-weight: 700;
  }
  .step-label {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .step.active .step-label {
    color: var(--text-primary);
    font-weight: 600;
  }
  .step.completed .step-label {
    color: var(--text-secondary);
  }
  .step-connector {
    width: 40px;
    height: 2px;
    background: var(--border);
    margin: 0 6px;
    margin-bottom: 18px; /* offset for step-label below circles */
    transition: background 0.2s;
  }
  .step-connector.completed {
    background: #4ade80;
  }

  /* Step content */
  .step-content {
    flex: 1;
    overflow-y: auto;
    min-height: 200px;
  }

  /* Navigation */
  .nav-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .nav-right {
    display: flex;
    gap: 8px;
  }
  .btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    border: none;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: 600;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.secondary {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn.secondary:hover {
    background: var(--bg-base);
  }
  .btn.ghost {
    background: none;
    color: var(--text-muted);
    font-size: 12px;
  }
  .btn.ghost:hover {
    color: var(--text-secondary);
  }
</style>
