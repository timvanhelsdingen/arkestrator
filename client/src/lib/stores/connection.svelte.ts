export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type ServerMode = "local" | "remote" | "";

const STORAGE_KEY = "arkestrator-connection";
const SESSION_KEY = "arkestrator-session";

interface SavedConnection {
  url: string;
  apiKey: string;
  serverMode: ServerMode;
}

interface SavedSession {
  token: string;
  username: string;
  role: string;
  lastUsername?: string;
  allowClientCoordination?: boolean;
  clientCoordinationEnabled?: boolean;
  canEditCoordinator?: boolean;
  workerModeEnabled?: boolean;
  idleWorkerEnabled?: boolean;
  idleWorkerMinutes?: number;
  localLlmEnabled?: boolean;
  totpEnabled?: boolean;
}

function loadSaved(): SavedConnection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        url: parsed.url || "",
        apiKey: parsed.apiKey || "",
        serverMode: parsed.serverMode || "",
      };
    }
  } catch {}
  return { url: "", apiKey: "", serverMode: "" };
}

function loadSession(): SavedSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { token: "", username: "", role: "" };
}

class ConnectionState {
  url = $state("");
  apiKey = $state("");
  serverMode = $state<ServerMode>("");
  status = $state<ConnectionStatus>("disconnected");
  lastError = $state("");
  sessionToken = $state("");
  username = $state("");
  lastUsername = $state("");
  userRole = $state("");
  allowClientCoordination = $state(false);
  clientCoordinationEnabled = $state(false);
  canEditCoordinator = $state(false);
  workerModeEnabled = $state(true);
  /** When true, auto-enable worker mode after idle timeout and disable on activity */
  idleWorkerEnabled = $state(false);
  /** Idle timeout in minutes before auto-enabling worker mode */
  idleWorkerMinutes = $state(15);
  /** Worker mode was auto-enabled by idle detection (will auto-disable on activity) */
  idleWorkerActive = $state(false);
  localLlmEnabled = $state(false);
  totpEnabled = $state(false);
  /** Blocks navigation to main app while forced 2FA setup is in progress */
  pendingForcedSetup = $state(false);
  /** Blocks navigation to main app while first-time wizard is active */
  pendingWizard = $state(false);

  constructor() {
    const session = loadSession();
    if (session.token) {
      this.sessionToken = session.token;
      this.username = session.username;
      this.lastUsername = session.username;
      this.userRole = session.role;
      this.allowClientCoordination = !!session.allowClientCoordination;
      this.clientCoordinationEnabled = !!session.clientCoordinationEnabled;
      this.canEditCoordinator = !!session.canEditCoordinator;
      this.workerModeEnabled = session.workerModeEnabled !== false;
      this.idleWorkerEnabled = !!session.idleWorkerEnabled;
      this.idleWorkerMinutes = Number(session.idleWorkerMinutes) || 15;
      this.localLlmEnabled = !!session.localLlmEnabled;
      this.totpEnabled = !!session.totpEnabled;
    } else if (session.lastUsername) {
      this.lastUsername = session.lastUsername;
    }
    const saved = loadSaved();
    if (saved.serverMode) {
      this.serverMode = saved.serverMode;
    }
  }

  get isConnected() {
    return this.status === "connected";
  }

  get isAuthenticated(): boolean {
    return !!(this.sessionToken && this.username);
  }

  save() {
    const payload = JSON.stringify({
      url: this.url,
      apiKey: this.apiKey,
      serverMode: this.serverMode,
    });
    localStorage.setItem(STORAGE_KEY, payload);
  }

  saveSession() {
    const payload = JSON.stringify({
      token: this.sessionToken,
      username: this.username,
      lastUsername: this.username || this.lastUsername,
      role: this.userRole,
      allowClientCoordination: this.allowClientCoordination,
      clientCoordinationEnabled: this.clientCoordinationEnabled,
      canEditCoordinator: this.canEditCoordinator,
      workerModeEnabled: this.workerModeEnabled,
      idleWorkerEnabled: this.idleWorkerEnabled,
      idleWorkerMinutes: this.idleWorkerMinutes,
      localLlmEnabled: this.localLlmEnabled,
      totpEnabled: this.totpEnabled,
    });
    localStorage.setItem(SESSION_KEY, payload);
  }

  clearSession() {
    const rememberedUsername = this.username || this.lastUsername;
    this.sessionToken = "";
    this.username = "";
    this.userRole = "";
    this.allowClientCoordination = false;
    this.clientCoordinationEnabled = false;
    this.canEditCoordinator = false;
    this.workerModeEnabled = true;
    this.localLlmEnabled = false;
    this.totpEnabled = false;
    this.lastUsername = rememberedUsername;
    const payload = JSON.stringify({
      token: "",
      username: "",
      lastUsername: this.lastUsername,
      role: "",
    });
    localStorage.setItem(SESSION_KEY, payload);
  }

  /** Full sign-out: clear all saved state and reload to show Setup */
  signOut() {
    this.clearSession();
    this.url = "";
    this.apiKey = "";
    this.serverMode = "";
    this.status = "disconnected";
    this.lastError = "";
    localStorage.removeItem(STORAGE_KEY);
  }

  get hasSavedCredentials(): boolean {
    const saved = loadSaved();
    return !!(saved.url && saved.apiKey);
  }

  loadSaved(): SavedConnection {
    return loadSaved();
  }
}

export const connection = new ConnectionState();
