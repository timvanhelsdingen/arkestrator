<script lang="ts">
  import { wizard } from "../../stores/wizard.svelte";
  import brandLogo from "../../../assets/brand/arkestrator-logo_brandname.svg";

  interface Props {
    onselect: (mode: "local" | "remote") => void;
  }
  let { onselect }: Props = $props();
</script>

<div class="choose-mode">
  <img class="brand-logo" src={brandLogo} alt="Arkestrator" />
  <h2>Welcome to Arkestrator</h2>
  <p class="subtitle">AI Agent Orchestration for DCC Pipelines</p>
  <p class="description">
    Let's get you set up. How would you like to connect?
  </p>

  <div class="options">
    <button class="option-btn" onclick={() => onselect("local")}>
      <span class="option-icon">&#9881;</span>
      <strong>Start Local Server</strong>
      <span class="option-desc">Launch a server on this machine — recommended for solo use</span>
    </button>
    <button class="option-btn" onclick={() => onselect("remote")}>
      <span class="option-icon">&#9729;</span>
      <strong>Connect to Existing Server</strong>
      <span class="option-desc">Join a server someone else is running</span>
    </button>
  </div>
</div>

<style>
  .choose-mode {
    text-align: center;
  }
  .brand-logo {
    width: min(320px, 64vw);
    height: auto;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: 11px;
    color: var(--text-muted);
    margin: 0 0 16px;
  }
  .description {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 20px;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .option-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    text-align: left;
    transition: border-color 0.15s;
    cursor: pointer;
  }
  .option-btn:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .option-icon {
    font-size: 18px;
    margin-bottom: 4px;
  }
  .option-btn strong {
    font-size: var(--font-size-base);
    color: var(--text-primary);
  }
  .option-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
</style>
