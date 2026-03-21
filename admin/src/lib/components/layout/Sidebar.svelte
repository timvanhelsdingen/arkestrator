<script lang="ts">
  import { nav, type Page } from "../../stores/navigation.svelte";
  import { auth } from "../../stores/auth.svelte";
  import brandMark from "../../../assets/brand/arkestrator-logo.svg";

  const iconPaths: Record<string, string> = {
    users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    key: "M21 2l-2 2m-7.61 7.61a5 5 0 1 1 7.07-7.07l-8.49 8.48a2 2 0 0 1-1.41.59H6v-2.54a2 2 0 0 1 .59-1.41l8.48-8.49z",
    cpu: "M4 4h16v16H4zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
    monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
    plug: "M12 2v6M8 8h8M9 8v4a3 3 0 0 0 6 0V8M12 16v6",
    filter: "M22 3H2l8 9v7l4 2v-9z",
    folder: "M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 7a2 2 0 0 1 2-2h4l2 2",
    zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
    list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  };

  const allItems: {
    page: Page;
    label: string;
    icon: string;
    canAccess: () => boolean;
  }[] = [
    { page: "users", label: "Users", icon: "users", canAccess: () => auth.canManageUsers },
    { page: "api-keys", label: "API Keys", icon: "key", canAccess: () => auth.canManageApiKeys },
    { page: "agents", label: "Agents", icon: "cpu", canAccess: () => auth.canManageAgents },
    { page: "machines", label: "Machines", icon: "monitor", canAccess: () => auth.canManageWorkers },
    { page: "bridges", label: "Bridges", icon: "plug", canAccess: () => auth.canManageWorkers },
    { page: "policies", label: "Filters", icon: "filter", canAccess: () => auth.canManagePolicies },
    { page: "coordinator-training", label: "Training Vault", icon: "folder", canAccess: () => auth.canEditCoordinator || auth.canManageSecurity },
    { page: "skills", label: "Skills", icon: "zap", canAccess: () => auth.canEditCoordinator || auth.canManageSecurity },
    { page: "audit-log", label: "Audit Log", icon: "list", canAccess: () => auth.canViewAuditLog },
  ];

  let items = $derived(allItems.filter((item) => item.canAccess()));

  $effect(() => {
    if (items.length === 0) return;
    if (!items.some((item) => item.page === nav.current)) {
      nav.current = items[0].page;
    }
  });
</script>

<nav class="sidebar">
  <div class="logo">
    <img class="logo-mark" src={brandMark} alt="Arkestrator logo" />
    <div class="logo-copy">
      <span class="logo-text">Arkestrator</span>
      <span class="logo-sub">Admin</span>
    </div>
  </div>

  <ul class="nav-list">
    {#each items as item}
      <li>
        <button
          class="nav-item"
          class:active={nav.current === item.page}
          onclick={() => (nav.current = item.page)}
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={iconPaths[item.icon]} />
          </svg>
          <span class="nav-label">{item.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="sidebar-footer">
    <div class="user-info">
      <span class="username">{auth.user?.username ?? ""}</span>
      <span class="role">{auth.user?.role ?? ""}</span>
    </div>
    <button class="logout-btn" onclick={() => auth.logout()}>Logout</button>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .logo {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo-mark {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
  }

  .logo-copy {
    display: flex;
    flex-direction: column;
  }

  .logo-text {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .logo-sub {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .nav-list {
    list-style: none;
    padding: 8px 0;
    flex: 1;
    overflow-y: auto;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 16px;
    color: var(--text-secondary);
    transition: background 0.1s, color 0.1s;
    text-align: left;
  }

  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: var(--bg-active);
    color: var(--text-primary);
    border-left: 2px solid var(--accent);
  }

  .nav-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .nav-label {
    font-size: var(--font-size-base);
  }

  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  .user-info {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .username {
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .role {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    text-transform: capitalize;
  }

  .logout-btn {
    width: 100%;
    padding: 6px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }

  .logout-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
</style>
