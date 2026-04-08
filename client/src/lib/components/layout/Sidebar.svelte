<script lang="ts">
  import { nav, type Page } from "../../stores/navigation.svelte";
  import { connection } from "../../stores/connection.svelte";
  import { api } from "../../api/rest";
  import { disconnect, connect } from "../../api/ws";
  import appLogo from "../../../assets/brand/arkestrator-logo.svg";

  function toggleWorkerMode() {
    connection.workerModeEnabled = !connection.workerModeEnabled;
    connection.saveSession();
    if (connection.url && connection.apiKey) {
      disconnect();
      void connect(connection.url, connection.apiKey);
    }
  }

  const items: { page: Page; label: string; icon: string }[] = [
    { page: "chat", label: "Chat", icon: "&#9998;" },
    { page: "jobs", label: "Jobs", icon: "&#9654;" },
    { page: "admin", label: "Admin", icon: "&#9881;" },
    { page: "workers", label: "Workers", icon: "&#8644;" },
    { page: "projects", label: "Projects", icon: "&#9636;" },
    { page: "coordinator", label: "Skills & Training", icon: "&#9678;" },
    { page: "settings", label: "Settings", icon: "&#9776;" },
  ];

  async function handleLogout() {
    try {
      await api.auth.logout();
    } catch {
      // Ignore errors — server session may already be gone
    }
    connection.clearSession();
    disconnect();
  }
</script>

<nav class="sidebar">
  <div class="brand-badge" title="Arkestrator">
    <img src={appLogo} alt="Arkestrator logo" />
  </div>
  <div class="nav-items">
    {#each items as item}
      {#if item.page !== "coordinator" || connection.canEditCoordinator || connection.userRole === "admin"}
        <button
          class="nav-btn"
          class:active={nav.current === item.page}
          title={item.label}
          onclick={() => (nav.current = item.page)}
        >
          <span class="icon">{@html item.icon}</span>
        </button>
      {/if}
    {/each}
  </div>
  <div class="sidebar-footer">
    {#if connection.isConnected}
      <button
        class="worker-toggle"
        class:active={connection.workerModeEnabled}
        onclick={toggleWorkerMode}
        title={connection.workerModeEnabled ? "Worker mode ON — click to disable" : "Worker mode OFF — click to enable"}
      >
        <span class="worker-icon">&#9874;</span>
      </button>
    {/if}
    {#if connection.username}
      <div class="user-info" title="{connection.username} ({connection.userRole})">
        <span class="user-avatar">{connection.username[0].toUpperCase()}</span>
      </div>
      <button class="logout-btn" onclick={handleLogout} title="Logout ({connection.username})">
        <span class="logout-icon">&#x23FB;</span>
      </button>
    {/if}
    <div class="status-dot" class:connected={connection.isConnected}></div>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    flex-shrink: 0;
  }
  .nav-items {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .brand-badge {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 6px;
    background: rgba(0, 109, 119, 0.14);
    border: 1px solid rgba(66, 192, 184, 0.22);
  }
  .brand-badge img {
    width: 22px;
    height: 22px;
    display: block;
  }
  .nav-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    transition: all 0.15s;
  }
  .nav-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .nav-btn.active {
    background: var(--bg-active);
    color: var(--accent);
  }
  .icon {
    font-size: 16px;
  }
  .sidebar-footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .user-info {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: default;
  }
  .user-avatar {
    font-size: 12px;
    font-weight: 700;
    color: white;
  }
  .logout-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    transition: all 0.15s;
  }
  .logout-btn:hover {
    background: var(--bg-hover);
    color: var(--status-failed);
  }
  .logout-icon {
    font-size: 14px;
  }
  .worker-toggle {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    background: transparent;
    transition: all 0.15s;
    opacity: 0.5;
  }
  .worker-toggle:hover { background: var(--bg-hover); opacity: 0.8; }
  .worker-toggle.active {
    color: var(--status-completed);
    opacity: 1;
  }
  .worker-icon { font-size: 14px; }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-failed);
    margin-bottom: 4px;
  }
  .status-dot.connected {
    background: var(--status-completed);
  }
</style>
