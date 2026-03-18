import { api } from "../api/client";

interface UserPermissions {
  manageUsers: boolean;
  manageAgents: boolean;
  manageProjects: boolean;
  managePolicies: boolean;
  manageApiKeys: boolean;
  manageConnections: boolean;
  manageWorkers: boolean;
  manageSecurity: boolean;
  viewAuditLog: boolean;
  viewUsage: boolean;
  editCoordinator: boolean;
  useMcp: boolean;
  interveneJobs: boolean;
}

interface AuthUser {
  id: string;
  username: string;
  role: string;
  permissions: UserPermissions;
  totpEnabled?: boolean;
}

class AuthStore {
  token = $state<string | null>(localStorage.getItem("admin_session_token"));
  user = $state<AuthUser | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  // 2FA challenge state
  challengeToken = $state<string | null>(null);
  requires2faSetup = $state(false);

  get isLoggedIn() {
    return this.user !== null;
  }

  get isAdmin() {
    return this.user?.role === "admin";
  }

  get canManageUsers() {
    return this.user?.permissions?.manageUsers === true;
  }

  get canManageAgents() {
    return this.user?.permissions?.manageAgents === true;
  }

  get hasAdminAccess() {
    const p = this.user?.permissions;
    if (!p) return false;
    return (
      p.manageUsers
      || p.manageAgents
      || p.manageProjects
      || p.managePolicies
      || p.manageApiKeys
      || p.manageConnections
      || p.manageWorkers
      || p.manageSecurity
      || p.viewAuditLog
      || p.viewUsage
      || p.editCoordinator
      || p.useMcp
      || p.interveneJobs
    );
  }

  get canManageProjects() {
    return this.user?.permissions?.manageProjects === true;
  }

  get canManagePolicies() {
    return this.user?.permissions?.managePolicies === true;
  }

  get canManageApiKeys() {
    return this.user?.permissions?.manageApiKeys === true;
  }

  get canManageConnections() {
    return this.user?.permissions?.manageConnections === true;
  }

  get canManageWorkers() {
    return this.user?.permissions?.manageWorkers === true;
  }

  get canManageSecurity() {
    return this.user?.permissions?.manageSecurity === true;
  }

  get canViewAuditLog() {
    return this.user?.permissions?.viewAuditLog === true;
  }

  get canViewUsage() {
    return this.user?.permissions?.viewUsage === true;
  }

  get canEditCoordinator() {
    return this.user?.permissions?.editCoordinator === true;
  }

  get canUseMcp() {
    return this.user?.permissions?.useMcp === true;
  }

  get canInterveneJobs() {
    return this.user?.permissions?.interveneJobs === true;
  }

  get needs2fa() {
    return this.challengeToken !== null;
  }

  async login(username: string, password: string) {
    this.loading = true;
    this.error = null;
    this.challengeToken = null;
    try {
      const result = await api.auth.login(username, password);

      if (result.requires2fa) {
        // 2FA required — store challenge token, don't complete login yet
        this.challengeToken = result.challengeToken;
        return;
      }

      // Login succeeded
      this.token = result.token;
      this.user = result.user;
      this.requires2faSetup = result.requires2faSetup ?? false;
      localStorage.setItem("admin_session_token", result.token);
    } catch (err: any) {
      this.error = err.message || "Login failed";
      throw err;
    } finally {
      this.loading = false;
    }
  }

  async verifyTotp(code: string) {
    if (!this.challengeToken) {
      this.error = "No pending 2FA challenge";
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await api.auth.verifyTotp(this.challengeToken, code);
      this.token = result.token;
      this.user = result.user;
      this.challengeToken = null;
      localStorage.setItem("admin_session_token", result.token);
    } catch (err: any) {
      this.error = err.message || "Invalid code";
      throw err;
    } finally {
      this.loading = false;
    }
  }

  async checkSession() {
    if (!this.token) return;
    try {
      const user = await api.auth.me();
      this.user = user;
    } catch {
      this.token = null;
      this.user = null;
      localStorage.removeItem("admin_session_token");
    }
  }

  async logout() {
    try {
      await api.auth.logout();
    } catch {
      // Ignore logout errors
    }
    this.token = null;
    this.user = null;
    this.challengeToken = null;
    this.requires2faSetup = false;
    localStorage.removeItem("admin_session_token");
    // Notify parent client (if embedded in iframe) so it can log out too
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "admin_logout" }, "*");
    }
  }
}

export const auth = new AuthStore();
