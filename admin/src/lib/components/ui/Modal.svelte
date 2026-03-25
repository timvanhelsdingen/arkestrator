<script lang="ts">
  interface Props {
    title: string;
    open: boolean;
    onclose: () => void;
    children: any;
  }

  let { title, open, onclose, children }: Props = $props();

  function close() {
    onclose();
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target !== event.currentTarget) return;
    close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={handleOverlayClick}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>{title}</h2>
        <button type="button" class="close-btn" onclick={close}>X</button>
      </div>
      <div class="modal-body">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 650;
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    min-width: 400px;
    max-width: 800px;
    width: 90vw;
    max-height: 85vh;
    overflow-y: auto;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }

  .modal-header h2 {
    font-size: var(--font-size-lg);
    font-weight: 600;
  }

  .close-btn {
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .modal-body {
    padding: 20px;
  }
</style>
