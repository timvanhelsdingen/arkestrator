<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  let appWindow: ReturnType<typeof getCurrentWindow> | null = $state(null);
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const clientVersion = __CLIENT_VERSION__;

  onMount(() => {
    try { appWindow = getCurrentWindow(); } catch { appWindow = null; }
  });

  function minimize() { appWindow?.minimize(); }
  function toggleMaximize() { appWindow?.toggleMaximize(); }
  function close() { appWindow?.close(); }
</script>

<div class="titlebar" class:macos={isMac} data-tauri-drag-region>
  <div class="title-wrap" data-tauri-drag-region>
    <span class="title" data-tauri-drag-region>Arkestrator</span>
    <span class="build-badge" data-tauri-drag-region>v{clientVersion}</span>
  </div>
  {#if !isMac}
    <div class="controls">
      <button class="control" onclick={minimize}>&#x2014;</button>
      <button class="control" onclick={toggleMaximize}>&#x25A1;</button>
      <button class="control close" onclick={close}>&#x2715;</button>
    </div>
  {/if}
</div>

<style>
  .titlebar {
    height: var(--titlebar-height);
    background: var(--bg-surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-left: 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .titlebar.macos {
    /* Account for native traffic light buttons (close/minimize/maximize) */
    padding-left: 78px;
    justify-content: center;
  }
  .title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .build-badge {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 10px;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
    line-height: 1.2;
  }
  .controls {
    display: flex;
    height: 100%;
  }
  .control {
    width: 46px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .control:hover {
    background: var(--bg-hover);
  }
  .close:hover {
    background: var(--status-failed);
    color: white;
  }
</style>
