<script lang="ts">
  /**
   * Five-star rating control. Used in the community skill detail modal so
   * users can submit or update their 1-5 star rating, and so we can preview
   * the current average next to it.
   *
   * - `value` is the committed rating (user's own score, or the aggregate
   *   average shown in read-only mode). Values between integers render as
   *   partial-fill on the "nearest down" star for the average display case.
   * - `readonly` disables hover/click. Used for the aggregate display.
   * - `hint` is an optional tooltip shown on hover for accessibility.
   * - `onChange` fires when the user clicks a star in interactive mode.
   *
   * Keyboard: tab onto a star, use arrow keys or digits 1-5 to change.
   */

  let {
    value = null,
    readonly = false,
    hint = "",
    disabled = false,
    size = 18,
    onChange,
  }: {
    value?: number | null;
    readonly?: boolean;
    hint?: string;
    disabled?: boolean;
    size?: number;
    onChange?: (newValue: number) => void;
  } = $props();

  let hovered = $state<number | null>(null);

  const displayed = $derived(hovered ?? value ?? 0);

  function commit(v: number) {
    if (readonly || disabled) return;
    onChange?.(v);
  }

  function handleKey(e: KeyboardEvent, starIndex: number) {
    if (readonly || disabled) return;
    if (e.key >= "1" && e.key <= "5") {
      commit(parseInt(e.key, 10));
      e.preventDefault();
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      commit(Math.min(5, (value ?? 0) + 1));
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      commit(Math.max(1, (value ?? 1) - 1));
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === " ") {
      commit(starIndex);
      e.preventDefault();
    }
  }
</script>

<div
  class="star-rating"
  class:readonly
  class:disabled
  title={hint}
  style="--star-size: {size}px;"
  role="group"
  aria-label="Star rating"
>
  {#each [1, 2, 3, 4, 5] as i (i)}
    {@const fillPct = Math.max(0, Math.min(1, displayed - (i - 1))) * 100}
    <button
      type="button"
      class="star-btn"
      class:is-set={value != null && i <= value}
      disabled={readonly || disabled}
      aria-label={`${i} star${i === 1 ? "" : "s"}`}
      aria-pressed={value === i}
      onmouseenter={() => { if (!readonly && !disabled) hovered = i; }}
      onmouseleave={() => { hovered = null; }}
      onfocus={() => { if (!readonly && !disabled) hovered = i; }}
      onblur={() => { hovered = null; }}
      onclick={() => commit(i)}
      onkeydown={(e) => handleKey(e, i)}
    >
      <span class="star-track">☆</span>
      <span class="star-fill" style="width: {fillPct}%">★</span>
    </button>
  {/each}
</div>

<style>
  .star-rating {
    display: inline-flex;
    gap: 2px;
    align-items: center;
  }
  .star-btn {
    position: relative;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    width: var(--star-size);
    height: var(--star-size);
    line-height: 1;
    font-size: var(--star-size);
    color: var(--text-muted, rgba(255, 255, 255, 0.3));
  }
  .star-rating.readonly .star-btn,
  .star-rating.disabled .star-btn {
    cursor: default;
  }
  .star-rating.disabled .star-btn {
    opacity: 0.5;
  }
  .star-btn:hover:not(:disabled) {
    transform: scale(1.05);
  }
  .star-track {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .star-fill {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    color: #f5b301;
    overflow: hidden;
    white-space: nowrap;
  }
  .star-btn:focus-visible {
    outline: 2px solid var(--accent, #5b9dff);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
