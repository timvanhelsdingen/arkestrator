import { connection } from "./connection.svelte";

const WIZARD_COMPLETE_KEY = "arkestrator-setup-complete-v1";

interface WizardCompletion {
  completedAt: string;
  version: number;
}

export type WizardMode = "local" | "remote" | "";

/** Sub-steps within the "Security" visible step (local path) */
export type SecuritySubStep = "starting" | "logging-in" | "change-password" | "totp-prompt" | "totp-setup";

/** Sub-steps within the "Connect" visible step (remote path) */
export type ConnectSubStep = "url" | "login" | "totp";

function readCompletionFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(WIZARD_COMPLETE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as WizardCompletion;
    return parsed?.version === 1 && !!parsed?.completedAt;
  } catch {
    return false;
  }
}

class WizardState {
  currentStep = $state(0);
  mode = $state<WizardMode>("");

  /** Summary counts set by individual wizard steps */
  agentsCreated = $state(0);
  bridgesInstalled = $state(0);


  /** Security step tracking */
  securitySubStep = $state<SecuritySubStep>("starting");
  passwordChanged = $state(false);
  totpSetupDone = $state(false);

  /** Connect step tracking (remote path) */
  connectSubStep = $state<ConnectSubStep>("url");

  /** Reactive completion flag — synced with localStorage */
  private _complete = $state(readCompletionFromStorage());

  /** Backward compat */
  get isLocal(): boolean {
    return this.mode === "local";
  }

  get isComplete(): boolean {
    return this._complete;
  }

  get steps(): string[] {
    return this.mode === "local"
      ? ["Welcome", "Security", "Agents", "Skills", "Bridges", "Ready"]
      : ["Welcome", "Connect", "Bridges", "Ready"];
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
    this._complete = true;
    connection.pendingWizard = false;
  }

  skip() {
    this.markComplete();
  }

  reset() {
    this.currentStep = 0;
    this.mode = "";
    this.agentsCreated = 0;
    this.bridgesInstalled = 0;
    this.securitySubStep = "starting";
    this.passwordChanged = false;
    this.totpSetupDone = false;
    this.connectSubStep = "url";
    this._complete = false;
  }
}

export const wizard = new WizardState();
