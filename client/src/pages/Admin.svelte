<script lang="ts">
  import { onMount } from "svelte";
  import { connection } from "../lib/stores/connection.svelte";
  import { disconnect } from "../lib/api/ws";
  import ServerManager from "../lib/components/ServerManager.svelte";
  import { isLoopbackUrl } from "../lib/stores/server.svelte";

  let iframeEl = $state<HTMLIFrameElement | null>(null);
  let loaded = $state(false);
  let loadTimedOut = $state(false);

  const adminUrl = $derived(connection.url ? `${connection.url}/admin` : "");

  function getAdminOrigin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  const showLocalServerManager = $derived(
    connection.serverMode === "local" || isLoopbackUrl(connection.url),
  );

  function markLoaded() {
    loaded = true;
    loadTimedOut = false;
  }

  function postSessionToken(targetWindow: Window | null = iframeEl?.contentWindow ?? null) {
    const token = connection.sessionToken?.trim();
    const origin = getAdminOrigin(adminUrl);
    if (!targetWindow || !token || !origin) return;
    targetWindow.postMessage({ type: "session_token", token }, origin);
  }

  function onIframeLoad() {
    markLoaded();
    postSessionToken();
  }

  /** Post a logout message to the admin iframe so it clears its session */
  function postLogoutToAdmin() {
    const origin = getAdminOrigin(adminUrl);
    if (!iframeEl?.contentWindow || !origin) return;
    iframeEl.contentWindow.postMessage({ type: "logout" }, origin);
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = getAdminOrigin(adminUrl);
      if (!origin) return;
      if (event.origin !== origin) return;
      if (iframeEl?.contentWindow && event.source !== iframeEl.contentWindow) return;

      if (event.data?.type === "admin_ready") {
        markLoaded();
        return;
      }

      if (event.data?.type === "admin_logout") {
        // Admin panel logged out — log out the client too
        connection.clearSession();
        disconnect();
        return;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  });

  let lastAdminUrl = "";
  $effect(() => {
    if (adminUrl === lastAdminUrl) return;
    lastAdminUrl = adminUrl;
    loaded = false;
    loadTimedOut = false;
  });

  $effect(() => {
    if (!adminUrl || loaded) return;
    const timeoutId = window.setTimeout(() => {
      if (!loaded) loadTimedOut = true;
    }, 8000);
    return () => window.clearTimeout(timeoutId);
  });

  // When session token changes, sync with admin iframe
  let prevToken = "";
  $effect(() => {
    const token = connection.sessionToken;
    if (loaded && adminUrl && token) {
      postSessionToken();
    } else if (prevToken && !token && loaded) {
      // Token was cleared — notify admin iframe to log out
      postLogoutToAdmin();
    }
    prevToken = token;
  });
</script>

<div class="admin-page">
  {#if !connection.url}
    <div class="no-connection">
      <p>Not connected to a server</p>
      <p class="hint">Connect to a server first to access the admin panel.</p>
    </div>
  {:else}
    {#if showLocalServerManager}
      <div class="local-server-panel">
        <ServerManager />
      </div>
    {/if}
    <div class="frame-shell">
      {#if !loaded}
        <div class="loading-overlay">
          <div class="loading-card">
            <p>Loading admin panel...</p>
            {#if loadTimedOut}
              <p class="loading-hint">
                The embedded admin page has not confirmed readiness yet.
                <a href={adminUrl} target="_blank" rel="noreferrer">Open it directly</a>
                to confirm the server session is healthy.
              </p>
            {/if}
          </div>
        </div>
      {/if}
      <iframe
        bind:this={iframeEl}
        src={adminUrl}
        title="Admin Panel"
        class="admin-iframe"
        class:visible={loaded}
        onload={onIframeLoad}
      ></iframe>
    </div>
  {/if}
</div>

<style>
  .admin-page {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .local-server-panel {
    padding: 16px 16px 0;
    flex-shrink: 0;
  }
  .frame-shell {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .admin-iframe {
    width: 100%;
    height: 100%;
    border: none;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .admin-iframe.visible {
    opacity: 1;
  }
  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }
  .loading-card {
    max-width: 440px;
    text-align: center;
    padding: 16px;
  }
  .loading-card p {
    margin: 0;
  }
  .loading-hint {
    margin-top: 10px !important;
    line-height: 1.5;
  }
  .no-connection {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 8px;
  }
</style>
