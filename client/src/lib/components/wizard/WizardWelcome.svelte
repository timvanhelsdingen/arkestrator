<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { wizard } from "../../stores/wizard.svelte";
  import brandLogo from "../../../assets/brand/arkestrator-logo_brandname.svg";
</script>

<div class="welcome">
  <img class="brand-logo" src={brandLogo} alt="Arkestrator" />
  <h2>Welcome to Arkestrator</h2>
  <p class="subtitle">Let's get your environment set up.</p>

  <div class="info-cards">
    {#if wizard.isLocal}
      <div class="info-card">
        <span class="icon">🤖</span>
        <div>
          <strong>Agent Setup</strong>
          <p>Configure AI providers — Claude Code, Codex, Gemini, and more.</p>
        </div>
      </div>
    {/if}
    <div class="info-card">
      <span class="icon">🔌</span>
      <div>
        <strong>Bridge Plugins</strong>
        <p>Detect your DCC apps and install bridge plugins with one click.</p>
      </div>
    </div>
  </div>

  <div class="connection-info">
    <span class="badge">{wizard.isLocal ? "Local Server" : "Remote Server"}</span>
    <span class="user">Signed in as <strong>{connection.username}</strong></span>
  </div>
</div>

<style>
  .welcome {
    text-align: center;
  }
  .brand-logo {
    width: min(360px, 70vw);
    height: auto;
    margin-bottom: 4px;
  }
  h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 8px 0 4px;
  }
  .subtitle {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 20px;
  }
  .info-cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
    margin-bottom: 20px;
  }
  .info-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .info-card .icon {
    font-size: 20px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .info-card strong {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    display: block;
    margin-bottom: 2px;
  }
  .info-card p {
    font-size: 12px;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.4;
  }
  .connection-info {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .badge {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 8px;
    font-size: 11px;
  }
  .user strong {
    color: var(--text-secondary);
  }
</style>
