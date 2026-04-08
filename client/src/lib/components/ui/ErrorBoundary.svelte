<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    name?: string;
  }

  let { children, name = "section" }: Props = $props();
  let error: Error | null = $state(null);

  function handleError(e: unknown) {
    error = e instanceof Error ? e : new Error(String(e));
    console.error(`[ErrorBoundary:${name}]`, e);
  }

  function retry() {
    error = null;
  }
</script>

<svelte:boundary onerror={handleError}>
  {#if error}
    <div class="error-boundary">
      <div class="error-content">
        <span class="error-icon" aria-hidden="true">&#9888;</span>
        <div class="error-text">
          <strong>Something went wrong in {name}</strong>
          <p>{error.message}</p>
        </div>
        <button class="retry-btn" onclick={retry}>Retry</button>
      </div>
    </div>
  {:else}
    {@render children()}
  {/if}
</svelte:boundary>

<style>
  .error-boundary {
    padding: 16px;
    border: 1px solid var(--status-failed, #7a2020);
    border-radius: var(--radius-md, 6px);
    background: rgba(122, 32, 32, 0.1);
    margin: 8px;
  }
  .error-content {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .error-icon {
    font-size: 24px;
    color: var(--status-failed, #e44);
    flex-shrink: 0;
  }
  .error-text {
    flex: 1;
    min-width: 0;
  }
  .error-text strong {
    color: var(--text-primary, #eee);
    font-size: var(--font-size-sm, 13px);
  }
  .error-text p {
    color: var(--text-secondary, #999);
    font-size: var(--font-size-sm, 13px);
    margin: 4px 0 0;
    word-break: break-word;
  }
  .retry-btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm, 4px);
    background: var(--bg-elevated, #333);
    color: var(--text-primary, #eee);
    font-size: var(--font-size-sm, 13px);
    flex-shrink: 0;
  }
  .retry-btn:hover {
    background: var(--bg-hover, #444);
  }
</style>
