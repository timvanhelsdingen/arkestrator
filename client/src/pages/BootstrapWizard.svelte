<script lang="ts">
  import { wizard } from "../lib/stores/wizard.svelte";
  import { connection } from "../lib/stores/connection.svelte";
  import WizardChooseMode from "../lib/components/wizard/WizardChooseMode.svelte";
  import WizardSecurity from "../lib/components/wizard/WizardSecurity.svelte";
  import WizardConnectRemote from "../lib/components/wizard/WizardConnectRemote.svelte";
  import WizardAgentSetup from "../lib/components/wizard/WizardAgentSetup.svelte";
  import WizardBridges from "../lib/components/wizard/WizardBridges.svelte";
  import WizardDone from "../lib/components/wizard/WizardDone.svelte";

  // Determine what step component to show
  function getStepComponent(stepIndex: number): string {
    if (wizard.mode === "local") {
      // Welcome → Security → Agents → Bridges → Ready
      switch (stepIndex) {
        case 0: return "choose";
        case 1: return "security";
        case 2: return "agents";
        case 3: return "bridges";
        case 4: return "done";
        default: return "choose";
      }
    } else if (wizard.mode === "remote") {
      // Welcome → Connect → Bridges → Ready
      switch (stepIndex) {
        case 0: return "choose";
        case 1: return "connect";
        case 2: return "bridges";
        case 3: return "done";
        default: return "choose";
      }
    }
    // No mode selected yet — show chooser
    return "choose";
  }

  let currentComponent = $derived(getStepComponent(wizard.currentStep));
  let isFirst = $derived(wizard.currentStep === 0);
  let isLast = $derived(wizard.currentStep === wizard.totalSteps - 1);

  // Whether to show the step indicator (only after mode is selected)
  let showSteps = $derived(wizard.mode !== "" && wizard.currentStep > 0);

  // Whether to show default nav (some steps handle their own navigation)
  let showDefaultNav = $derived(
    currentComponent !== "choose" &&
    currentComponent !== "security" &&
    currentComponent !== "connect" &&
    currentComponent !== "done"
  );

  function handleModeSelect(mode: "local" | "remote") {
    wizard.mode = mode;
    wizard.currentStep = 1; // Advance past welcome
  }

  function handleSecurityComplete() {
    wizard.nextStep(); // Move from Security → Agents
  }

  function handleConnectComplete() {
    wizard.nextStep(); // Move from Connect → Bridges
  }
</script>

<div class="wizard-container">
  <div class="wizard-card">
    <!-- Step indicator (hidden on welcome/choose screen) -->
    {#if showSteps}
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
    {/if}

    <!-- Step content -->
    <div class="step-content">
      {#if currentComponent === "choose"}
        <WizardChooseMode onselect={handleModeSelect} />
      {:else if currentComponent === "security"}
        <WizardSecurity oncomplete={handleSecurityComplete} />
      {:else if currentComponent === "connect"}
        <WizardConnectRemote oncomplete={handleConnectComplete} />
      {:else if currentComponent === "agents"}
        <WizardAgentSetup />
      {:else if currentComponent === "bridges"}
        <WizardBridges />
      {:else if currentComponent === "done"}
        <WizardDone />
      {/if}
    </div>

    <!-- Navigation (for steps that don't handle their own) -->
    {#if showDefaultNav}
      <div class="nav-bar">
        <button class="btn ghost" onclick={() => wizard.skip()}>
          Skip Setup
        </button>
        <div class="nav-right">
          <button class="btn secondary" onclick={() => wizard.prevStep()}>
            Back
          </button>
          <button class="btn primary" onclick={() => wizard.nextStep()}>
            Next
          </button>
        </div>
      </div>
    {:else if currentComponent === "choose"}
      <!-- Skip on welcome screen -->
      <div class="nav-bar center">
        <button class="btn ghost" onclick={() => wizard.skip()}>
          Skip Setup
        </button>
      </div>
    {:else if currentComponent === "security" || currentComponent === "connect"}
      <!-- Skip option on security/connect steps -->
      <div class="nav-bar">
        <button class="btn ghost" onclick={() => wizard.skip()}>
          Skip Setup
        </button>
        <div class="nav-right"></div>
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
    margin-bottom: 18px;
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
  .nav-bar.center {
    justify-content: center;
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
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.secondary {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn.secondary:hover { background: var(--bg-base); }
  .btn.ghost {
    background: none;
    color: var(--text-muted);
    font-size: 12px;
  }
  .btn.ghost:hover { color: var(--text-secondary); }
</style>
