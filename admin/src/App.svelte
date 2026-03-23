<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "./lib/stores/auth.svelte";
  import { nav } from "./lib/stores/navigation.svelte";
  import Sidebar from "./lib/components/layout/Sidebar.svelte";
  import Header from "./lib/components/layout/Header.svelte";
  import Toast from "./lib/components/ui/Toast.svelte";
  import Login from "./pages/Login.svelte";
  import Users from "./pages/Users.svelte";
  import ApiKeys from "./pages/ApiKeys.svelte";
  import AgentConfigs from "./pages/AgentConfigs.svelte";
  import Machines from "./pages/Machines.svelte";
  import Bridges from "./pages/Bridges.svelte";
  import Policies from "./pages/Policies.svelte";
  import AuditLog from "./pages/AuditLog.svelte";
  import Knowledge from "./pages/Knowledge.svelte";
  import System from "./pages/System.svelte";

  let ready = $state(false);

  function notifyParentReady() {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "admin_ready" }, "*");
    }
  }

  onMount(() => {
    const allowedOrigins = new Set<string>([
      window.location.origin,
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ]);

    // Listen for messages from parent window (when embedded in Tauri client)
    const handleMessage = async (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!allowedOrigins.has(event.origin)) return;

      if (event.data?.type === "logout") {
        // Parent client logged out — clear admin session
        auth.token = null;
        auth.user = null;
        localStorage.removeItem("admin_session_token");
        return;
      }

      if (event.data?.type !== "session_token") return;

      const token = typeof event.data.token === "string"
        ? event.data.token.trim()
        : "";
      if (!/^[a-f0-9]{64}$/i.test(token)) return;

      auth.token = token;
      localStorage.setItem("admin_session_token", token);
      await auth.checkSession();
      ready = true;
      notifyParentReady();
    };

    window.addEventListener("message", handleMessage);

    void (async () => {
      await auth.checkSession();
      ready = true;
      notifyParentReady();
    })();

    return () => window.removeEventListener("message", handleMessage);
  });
</script>

<Toast />

{#if !ready}
  <div class="loading">Loading...</div>
{:else if !auth.isLoggedIn}
  <Login />
{:else if !auth.hasAdminAccess}
  <div class="no-access">
    <h1>No Admin Access</h1>
    <p>
      Your account has no admin-panel capabilities assigned.
      Ask an administrator to grant permissions like `manageUsers`, `managePolicies`, or `viewAuditLog`.
    </p>
    <button class="logout-btn" onclick={() => auth.logout()}>Logout</button>
  </div>
{:else}
  <div class="shell">
    <Sidebar />
    <div class="main">
      <Header />
      <div class="content">
        {#if nav.current === "users" && auth.canManageUsers}
          <Users />
        {:else if nav.current === "api-keys" && auth.canManageApiKeys}
          <ApiKeys />
        {:else if nav.current === "agents" && auth.canManageAgents}
          <AgentConfigs />
        {:else if nav.current === "machines" && auth.canManageWorkers}
          <Machines />
        {:else if nav.current === "bridges" && auth.canManageWorkers}
          <Bridges />
        {:else if nav.current === "policies" && auth.canManagePolicies}
          <Policies />
        {:else if nav.current === "knowledge" && (auth.canEditCoordinator || auth.canManageSecurity)}
          <Knowledge />
        {:else if nav.current === "audit-log" && auth.canViewAuditLog}
          <AuditLog />
        {:else if nav.current === "system" && auth.canManageSecurity}
          <System />
        {:else}
          <div class="no-page">
            Select a section from the sidebar.
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .shell {
    display: flex;
    height: 100vh;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .content {
    flex: 1;
    overflow-y: auto;
  }

  .loading {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .no-access {
    height: 100vh;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
    justify-content: center;
  }

  .no-access h1 {
    font-size: var(--font-size-xl);
    color: var(--text-primary);
  }

  .no-access p {
    max-width: 560px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .logout-btn {
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
  }

  .logout-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .no-page {
    padding: 24px;
    color: var(--text-muted);
  }
</style>
