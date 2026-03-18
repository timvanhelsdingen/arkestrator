<script lang="ts">
  import { toast } from "../../stores/toast.svelte";
</script>

{#if toast.messages.length > 0}
  <div class="toast-container">
    {#each toast.messages as msg (msg.id)}
      <div class="toast toast-{msg.type}">
        {msg.message}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 40px;
    right: 16px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .toast {
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 13px;
    color: #fff;
    min-width: 250px;
    max-width: 400px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .toast-success {
    background: #1a5c35;
  }

  .toast-error {
    background: #7a2020;
  }

  .toast-info {
    background: #1a4a7a;
  }
</style>
