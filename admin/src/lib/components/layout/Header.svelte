<script lang="ts">
  import { nav } from "../../stores/navigation.svelte";
  const adminVersion = __ADMIN_VERSION__;

  const titles: Record<string, string> = {
    users: "User Management",
    "api-keys": "API Keys",
    agents: "Agent Configurations",
    machines: "Machines",
    bridges: "Bridges",
    knowledge: "Skills & Training",
    templates: "Templates",
    policies: "Filters & Policies",
    "audit-log": "Audit Log",
  };
</script>

<header class="header">
  <h1 class="page-title">{titles[nav.current] ?? nav.current}</h1>
  <span class="build-badge">v{adminVersion}</span>
</header>

<style>
  .header {
    height: var(--header-height);
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .page-title {
    font-size: var(--font-size-xl);
    font-weight: 600;
    color: var(--text-primary);
  }

  .build-badge {
    flex: 0 0 auto;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 11px;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }
</style>
