import { connection } from "./connection.svelte";

const WIZARD_COMPLETE_KEY = "arkestrator-setup-complete-v1";

interface WizardCompletion {
  completedAt: string;
  version: number;
}

class WizardState {
  currentStep = $state(0);
  isLocal = $state(false);

  /** Summary counts set by individual wizard steps */
  agentsCreated = $state(0);
  bridgesInstalled = $state(0);

  get isComplete(): boolean {
    try {
      const raw = localStorage.getItem(WIZARD_COMPLETE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as WizardCompletion;
      return parsed?.version === 1 && !!parsed?.completedAt;
    } catch {
      return false;
    }
  }

  get steps(): string[] {
    return this.isLocal
      ? ["Welcome", "Agent Setup", "Bridge Plugins", "Ready"]
      : ["Welcome", "Bridge Plugins", "Ready"];
  }

  get totalSteps(): number {
    return this.steps.length;
  }

  nextStep() {
    if (this.currentStep < this.totalSteps - 1) {
      this.currentStep++;
    }
  }

  prevStep() {
    if (this.currentStep > 0) {
      this.currentStep--;
    }
  }

  markComplete() {
    const payload: WizardCompletion = {
      completedAt: new Date().toISOString(),
      version: 1,
    };
    localStorage.setItem(WIZARD_COMPLETE_KEY, JSON.stringify(payload));
    connection.pendingWizard = false;
  }

  skip() {
    this.markComplete();
  }

  reset() {
    this.currentStep = 0;
    this.agentsCreated = 0;
    this.bridgesInstalled = 0;
  }
}

export const wizard = new WizardState();
