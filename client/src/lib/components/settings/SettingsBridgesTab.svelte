<script lang="ts">
  import BridgeInstaller from "../BridgeInstaller.svelte";


</script>

<section>
  <h3>Bridge Plugins</h3>
  <p class="desc">Install bridge plugins for DCC applications. Bridge plugins connect your apps to the Arkestrator server. A green dot indicates the bridge is currently connected.</p>
  <BridgeInstaller />
</section>

<style>
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  h3 {
    font-size: var(--font-size-base);
    margin-bottom: 12px;
    color: var(--text-secondary);
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 10px;
  }
</style>
