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
    top: 16px;
    right: 16px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .toast {
    padding: 10px 16px;
    border-radius: var(--radius-md);
    font-size: var(--font-size-base);
    color: #fff;
    min-width: 250px;
    max-width: 400px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .toast-success {
    background: #2a7b4b;
  }

  .toast-error {
    background: #a93333;
  }

  .toast-info {
    background: #1a6fb5;
  }
</style>
