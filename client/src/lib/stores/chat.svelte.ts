import type {
  BridgeExecutionMode,
  CoordinationScripts,
  JobPriority,
  JobRuntimeOptions,
  RuntimeReasoningLevel,
  RuntimeVerificationMode,
} from "@arkestrator/protocol";
import { agents } from "./agents.svelte";

// --- Types ---

export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatProjectSelection = "none" | "project";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  /** If this message corresponds to a submitted job */
  jobId?: string;
}

export interface ChatTab {
  id: string;
  /** Resettable conversation identity used by the server chat backend. */
  conversationKey: string;
  name: string;
  messages: ChatMessage[];
  /** Job IDs created in this session, in order */
  jobIds: string[];
  /** Selected agent config ID */
  agentConfigId: string;
  /** Job priority */
  priority: JobPriority;
  /** Whether to start immediately or queue paused */
  startPaused: boolean;
  /** Selected worker names for targeting (empty = "Auto") */
  selectedWorkerNames: string[];
  /** How project resolution should behave for this tab. */
  projectSelection: ChatProjectSelection;
  /** Optional project ID */
  projectId?: string;
  /** Optional dependency job ID selected in chat submit controls */
  dependsOnJobId?: string;
  /** Optional per-run runtime settings (model/reasoning overrides). */
  runtimeOptions?: JobRuntimeOptions;
  /** Prompt text currently being composed */
  draftPrompt: string;
  /** Optional job name override (blank = auto-generated) */
  jobName?: string;
}

// --- Persistence ---

const STORAGE_KEY = "arkestrator-chat-tabs";

function saveTabs(tabs: ChatTab[], activeTabId: string) {
  try {
    const payload = JSON.stringify({ tabs, activeTabId });
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {}
}

function loadTabs(): { tabs: ChatTab[]; activeTabId: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

// --- Store ---

/** Default agent selection for new chats: "auto" routes by priority on the server. */
function getDefaultAgentId(): string {
  return "auto";
}

function createTab(name: string, agentConfigId: string = getDefaultAgentId()): ChatTab {
  return {
    id: crypto.randomUUID(),
    conversationKey: crypto.randomUUID(),
    name,
    messages: [],
    jobIds: [],
    agentConfigId,
    priority: "normal",
    startPaused: false,
    selectedWorkerNames: [],
    projectSelection: "none",
    runtimeOptions: undefined,
    draftPrompt: "",
  };
}

function isProjectSelection(value: unknown): value is ChatProjectSelection {
  return value === "none" || value === "project";
}

function normalizeLoadedTab(raw: any, index: number): ChatTab {
  const base = createTab(typeof raw?.name === "string" ? raw.name : `Chat ${index + 1}`);
  const projectId = typeof raw?.projectId === "string" && raw.projectId.trim()
    ? raw.projectId
    : undefined;
  const dependsOnJobId =
    typeof raw?.dependsOnJobId === "string" && raw.dependsOnJobId.trim()
      ? raw.dependsOnJobId
      : (Array.isArray(raw?.dependsOnJobIds) && typeof raw.dependsOnJobIds[0] === "string"
        ? raw.dependsOnJobIds[0]
        : undefined);
  const rawProjectSelection = raw?.projectSelection === "auto" ? "none" : raw?.projectSelection;
  const projectSelection: ChatProjectSelection =
    isProjectSelection(rawProjectSelection)
      ? rawProjectSelection
      : (projectId ? "project" : "none");

  const runtimeModel = typeof raw?.runtimeOptions?.model === "string"
    ? raw.runtimeOptions.model.trim()
    : "";
  const rawReasoning = typeof raw?.runtimeOptions?.reasoningLevel === "string"
    ? raw.runtimeOptions.reasoningLevel.trim().toLowerCase()
    : "";
  const runtimeReasoning = ["low", "medium", "high", "xhigh"].includes(rawReasoning)
    ? (rawReasoning as RuntimeReasoningLevel)
    : undefined;
  const rawVerificationMode = typeof raw?.runtimeOptions?.verificationMode === "string"
    ? raw.runtimeOptions.verificationMode.trim().toLowerCase()
    : "";
  const runtimeVerificationMode = ["required", "optional", "disabled"].includes(rawVerificationMode)
    ? (rawVerificationMode as RuntimeVerificationMode)
    : undefined;
  const rawVerificationWeight = raw?.runtimeOptions?.verificationWeight;
  const runtimeVerificationWeight =
    typeof rawVerificationWeight === "number"
    && Number.isFinite(rawVerificationWeight)
    && rawVerificationWeight >= 0
    && rawVerificationWeight <= 100
      ? Math.round(rawVerificationWeight)
      : undefined;
  const COORD_MODES = ["enabled", "disabled", "auto"];
  const rawCoord = raw?.runtimeOptions?.coordinationScripts;
  const coordinationScripts: CoordinationScripts | undefined =
    rawCoord && typeof rawCoord === "object"
    && (COORD_MODES.includes(rawCoord.coordinator)
      || COORD_MODES.includes(rawCoord.bridge)
      || COORD_MODES.includes(rawCoord.training))
      ? {
          coordinator: COORD_MODES.includes(rawCoord.coordinator) ? rawCoord.coordinator : "enabled",
          bridge: COORD_MODES.includes(rawCoord.bridge) ? rawCoord.bridge : "enabled",
          training: COORD_MODES.includes(rawCoord.training) ? rawCoord.training : "enabled",
        }
      : undefined;

  const runtimeOptions: JobRuntimeOptions | undefined =
    runtimeModel || runtimeReasoning || runtimeVerificationMode || runtimeVerificationWeight !== undefined || coordinationScripts
      ? {
          ...(runtimeModel ? { model: runtimeModel } : {}),
          ...(runtimeReasoning ? { reasoningLevel: runtimeReasoning } : {}),
          ...(runtimeVerificationMode ? { verificationMode: runtimeVerificationMode } : {}),
          ...(runtimeVerificationWeight !== undefined ? { verificationWeight: runtimeVerificationWeight } : {}),
          ...(coordinationScripts ? { coordinationScripts } : {}),
        }
      : undefined;

  return {
    ...base,
    ...(typeof raw?.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw?.conversationKey === "string" && raw.conversationKey.trim()
      ? { conversationKey: raw.conversationKey }
      : {}),
    ...(Array.isArray(raw?.messages) ? { messages: raw.messages } : {}),
    ...(Array.isArray(raw?.jobIds) ? { jobIds: raw.jobIds } : {}),
    ...(typeof raw?.agentConfigId === "string" ? { agentConfigId: raw.agentConfigId } : {}),
    ...(raw?.priority ? { priority: raw.priority } : {}),
    ...(typeof raw?.startPaused === "boolean" ? { startPaused: raw.startPaused } : {}),
    ...(Array.isArray(raw?.selectedWorkerNames) ? { selectedWorkerNames: raw.selectedWorkerNames } : {}),
    ...(dependsOnJobId ? { dependsOnJobId } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(typeof raw?.draftPrompt === "string" ? { draftPrompt: raw.draftPrompt } : {}),
    projectSelection: projectSelection === "project" && !projectId ? "none" : projectSelection,
    projectId: projectSelection === "project" ? projectId : undefined,
  };
}

class ChatState {
  tabs = $state<ChatTab[]>([]);
  activeTabId = $state<string>("");
  showContextPanel = $state(true);
  /** Bumped on every streaming chunk to trigger reactivity without spreading tabs */
  streamVersion = $state(0);
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const saved = loadTabs();
    if (saved && saved.tabs.length > 0) {
      const normalized = saved.tabs.map((tab: any, idx: number) => normalizeLoadedTab(tab, idx));
      this.tabs = normalized;
      this.activeTabId = normalized.some((tab) => tab.id === saved.activeTabId)
        ? saved.activeTabId
        : normalized[0].id;
    } else {
      const initial = createTab("Chat 1");
      this.tabs = [initial];
      this.activeTabId = initial.id;
    }
  }

  get activeTab(): ChatTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      saveTabs(this.tabs, this.activeTabId);
    }, 300);
  }

  private persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    saveTabs(this.tabs, this.activeTabId);
  }

  addTab() {
    // New chats inherit the currently selected agent (last-selected), or "auto" if none.
    const inherited = this.activeTab?.agentConfigId || getDefaultAgentId();
    const tab = createTab(`Chat ${this.tabs.length + 1}`, inherited);
    this.tabs = [...this.tabs, tab];
    this.activeTabId = tab.id;
    this.persistNow();
  }

  closeTab(tabId: string) {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(idx, this.tabs.length - 1)].id;
    }
    // Renumber auto-named tabs ("Chat N") to avoid gaps
    this.renumberTabs();
    this.persistNow();
  }

  /** Renumber tabs that have auto-generated names ("Chat N") to close gaps */
  private renumberTabs() {
    let counter = 1;
    for (const tab of this.tabs) {
      if (/^Chat \d+$/.test(tab.name)) {
        tab.name = `Chat ${counter}`;
        counter++;
      }
    }
    this.tabs = [...this.tabs];
  }

  clearChat() {
    const tab = this.activeTab;
    if (!tab) return;
    tab.conversationKey = crypto.randomUUID();
    tab.messages = [];
    tab.jobIds = [];
    this.tabs = [...this.tabs];
    this.persistNow();
  }

  renameTab(tabId: string, name: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.name = name;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  switchTab(tabId: string) {
    this.activeTabId = tabId;
    this.persistNow();
  }

  addMessage(message: ChatMessage) {
    const tab = this.activeTab;
    if (!tab) return;
    tab.messages = [...tab.messages, message];
    this.tabs = [...this.tabs];
    this.persistNow();
  }

  linkMessageToJob(messageId: string, jobId: string) {
    const tab = this.activeTab;
    if (!tab) return;
    const message = tab.messages.find((entry) => entry.id === messageId);
    if (!message) return;
    message.jobId = jobId;
    this.tabs = [...this.tabs];
    this.persist();
  }

  addMessageToTabByJobId(jobId: string, message: ChatMessage) {
    const tab = this.tabs.find((t) => t.jobIds.includes(jobId));
    if (!tab) return;
    tab.messages = [...tab.messages, message];
    this.tabs = [...this.tabs];
    this.persist();
  }

  trackJob(jobId: string) {
    const tab = this.activeTab;
    if (!tab) return;
    tab.jobIds = [...tab.jobIds, jobId];
    this.tabs = [...this.tabs];
    this.persist();
  }

  trackJobInTab(tabId: string, jobId: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab && !tab.jobIds.includes(jobId)) {
      tab.jobIds = [...tab.jobIds, jobId];
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  findTabByJobId(jobId: string): ChatTab | undefined {
    return this.tabs.find((t) => t.jobIds.includes(jobId));
  }

  setDraftPrompt(text: string) {
    const tab = this.activeTab;
    if (!tab) return;
    tab.draftPrompt = text;
    // Debounced persist so unsent prompts survive page switches/reloads.
    this.persist();
  }

  setAgentConfig(configId: string) {
    const tab = this.activeTab;
    if (tab) {
      tab.agentConfigId = configId;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  /** Backfill tabs that have no agent selected (or a stale/invalid agent) with "auto". */
  backfillDefaultAgent() {
    const defaultId = getDefaultAgentId();
    const validIds = new Set(agents.all.map((a) => a.id));
    let changed = false;
    for (const tab of this.tabs) {
      if (!tab.agentConfigId) {
        tab.agentConfigId = defaultId;
        changed = true;
        continue;
      }
      if (tab.agentConfigId === "auto") continue;
      if (!validIds.has(tab.agentConfigId)) {
        tab.agentConfigId = defaultId;
        changed = true;
      }
    }
    if (changed) {
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  setPriority(priority: JobPriority) {
    const tab = this.activeTab;
    if (tab) {
      tab.priority = priority;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  setJobName(name: string) {
    const tab = this.activeTab;
    if (tab) {
      tab.jobName = name || undefined;
      this.persist();
    }
  }

  toggleWorker(workerName: string) {
    const tab = this.activeTab;
    if (!tab) return;
    if (tab.selectedWorkerNames.includes(workerName)) {
      tab.selectedWorkerNames = tab.selectedWorkerNames.filter((name) => name !== workerName);
    } else {
      tab.selectedWorkerNames = [...tab.selectedWorkerNames, workerName];
    }
    this.tabs = [...this.tabs];
    this.persist();
  }

  setProjectSelection(selection: ChatProjectSelection, projectId?: string) {
    const tab = this.activeTab;
    if (tab) {
      tab.projectSelection = selection;
      tab.projectId = selection === "project" ? projectId : undefined;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  setProject(projectId: string | undefined) {
    this.setProjectSelection(projectId ? "project" : "none", projectId);
  }

  setSelectedWorkers(names: string[]) {
    const tab = this.activeTab;
    if (tab) {
      tab.selectedWorkerNames = names;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  setDependsOnJob(jobId: string | undefined) {
    const tab = this.activeTab;
    if (tab) {
      tab.dependsOnJobId = jobId;
      this.tabs = [...this.tabs];
      this.persist();
    }
  }

  setRuntimeModel(model: string | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const trimmed = typeof model === "string" ? model.trim() : "";
    const next: JobRuntimeOptions = {
      ...(tab.runtimeOptions ?? {}),
      ...(trimmed ? { model: trimmed } : {}),
    };
    if (!trimmed) delete next.model;
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setRuntimeReasoningLevel(level: RuntimeReasoningLevel | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = {
      ...(tab.runtimeOptions ?? {}),
      ...(level ? { reasoningLevel: level } : {}),
    };
    if (!level) delete next.reasoningLevel;
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setRuntimeVerificationMode(mode: RuntimeVerificationMode | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = {
      ...(tab.runtimeOptions ?? {}),
      ...(mode ? { verificationMode: mode } : {}),
    };
    if (!mode) delete next.verificationMode;
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setRuntimeVerificationWeight(weight: number | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const normalized = typeof weight === "number" && Number.isFinite(weight)
      ? Math.max(0, Math.min(100, Math.round(weight)))
      : undefined;
    const next: JobRuntimeOptions = {
      ...(tab.runtimeOptions ?? {}),
      ...(normalized !== undefined ? { verificationWeight: normalized } : {}),
    };
    if (normalized === undefined) delete next.verificationWeight;
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setCoordinationScripts(scripts: Partial<CoordinationScripts> | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = { ...(tab.runtimeOptions ?? {}) };
    if (scripts) {
      next.coordinationScripts = {
        coordinator: scripts.coordinator ?? "enabled",
        bridge: scripts.bridge ?? "enabled",
        training: scripts.training ?? "enabled",
      };
      // If all enabled, remove the override entirely
      const cs = next.coordinationScripts;
      if (cs.coordinator === "enabled" && cs.bridge === "enabled" && cs.training === "enabled") {
        delete next.coordinationScripts;
      }
    } else {
      delete next.coordinationScripts;
    }
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setBridgeExecutionMode(mode: BridgeExecutionMode | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = {
      ...(tab.runtimeOptions ?? {}),
      ...(mode ? { bridgeExecutionMode: mode } : {}),
    };
    if (!mode) delete next.bridgeExecutionMode;
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setSkillsMode(enabled: boolean | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = { ...(tab.runtimeOptions ?? {}) };
    if (enabled) {
      next.skillsMode = true;
    } else {
      delete next.skillsMode;
    }
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setRuntimeTimeout(minutes: number | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = { ...(tab.runtimeOptions ?? {}) };
    if (minutes != null && minutes > 0) {
      next.timeoutMinutes = minutes;
    } else {
      delete next.timeoutMinutes;
    }
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  setCleanupTempFiles(value: boolean | undefined) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = { ...(tab.runtimeOptions ?? {}) };
    if (value === true) {
      next.cleanupTempFiles = true;
    } else {
      delete next.cleanupTempFiles;
    }
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }

  /** Apply a preset by merging its runtime options into the current tab. */
  applyPreset(options: Partial<JobRuntimeOptions>) {
    const tab = this.activeTab;
    if (!tab) return;
    const next: JobRuntimeOptions = { ...(tab.runtimeOptions ?? {}), ...options };
    tab.runtimeOptions = Object.keys(next).length > 0 ? next : undefined;
    this.tabs = [...this.tabs];
    this.persist();
  }
}

export const chatStore = new ChatState();
