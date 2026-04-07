<script lang="ts">
  import { communityApi, loadSettings, saveSettings, type CommunityUser } from "../../api/community";
  import { api } from "../../api/rest";
  import { toast } from "../../stores/toast.svelte";
  import { open } from "@tauri-apps/plugin-shell";

  let { onclose }: { onclose: () => void } = $props();

  let settings = $state(loadSettings());
  let hasToken = $derived(!!settings.authToken);

  // Auth state
  let tokenInput = $state("");
  let communityUser = $state<CommunityUser | null>(null);
  let loadingUser = $state(false);

  // Local skills for selection
  let localSkills = $state<any[]>([]);
  let loadingSkills = $state(false);
  let selectedSlug = $state("");
  let selectedProgram = $state("");

  // Publish state
  let publishing = $state(false);

  // Load user info if token exists
  $effect(() => {
    if (hasToken && !communityUser) {
      loadingUser = true;
      communityApi.me()
        .then((u) => { communityUser = u; })
        .catch(() => { communityUser = null; })
        .finally(() => { loadingUser = false; });
    }
  });

  // Load local skills list
  $effect(() => {
    if (hasToken) {
      loadingSkills = true;
      api.skills.list()
        .then((result: any) => {
          localSkills = result?.skills ?? result ?? [];
        })
        .catch(() => { localSkills = []; })
        .finally(() => { loadingSkills = false; });
    }
  });

  let selectedSkill = $derived(
    localSkills.find((s: any) => s.slug === selectedSlug && (!selectedProgram || s.program === selectedProgram))
  );

  async function openGitHubAuth() {
    const baseUrl = settings.baseUrl || "https://arkestrator.com";
    try {
      await open(`${baseUrl}/auth/github`);
    } catch {
      // Fallback to window.open if Tauri shell not available
      window.open(`${baseUrl}/auth/github`, "_blank");
    }
  }

  function saveToken() {
    if (!tokenInput.trim()) return;
    settings.authToken = tokenInput.trim();
    saveSettings(settings);
    tokenInput = "";
  }

  function disconnect() {
    settings.authToken = "";
    saveSettings(settings);
    communityUser = null;
  }

  async function publish() {
    if (!selectedSkill) return;
    publishing = true;
    try {
      await communityApi.publish({
        title: selectedSkill.title,
        slug: selectedSkill.slug,
        program: selectedSkill.program || "global",
        category: selectedSkill.category || "custom",
        description: selectedSkill.description || "",
        keywords: selectedSkill.keywords || [],
        content: selectedSkill.content || "",
      });
      toast.success(`Published "${selectedSkill.title}" to community!`);
      onclose();
    } catch (err: any) {
      toast.error(`Publish failed: ${err?.message}`);
    } finally {
      publishing = false;
    }
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick}>
  <div class="modal-dialog">
    <div class="modal-header">
      <h3>Publish to Community</h3>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>

    <div class="modal-body">
      {#if !hasToken}
        <div class="auth-section">
          <p class="section-desc">Connect your GitHub account to publish skills to the Arkestrator community.</p>
          <button class="btn btn-accent" onclick={openGitHubAuth}>
            Open GitHub Login
          </button>
          <p class="section-hint">After authenticating, paste the token below:</p>
          <div class="token-row">
            <input
              type="text"
              class="token-input"
              bind:value={tokenInput}
              placeholder="Paste auth token..."
            />
            <button class="btn" onclick={saveToken} disabled={!tokenInput.trim()}>
              Save
            </button>
          </div>
        </div>
      {:else}
        <div class="user-section">
          {#if loadingUser}
            <p class="muted">Verifying account...</p>
          {:else if communityUser}
            <div class="user-info">
              {#if communityUser.avatar_url}
                <img class="user-avatar" src={communityUser.avatar_url} alt="" />
              {/if}
              <span>Connected as <strong>{communityUser.username}</strong></span>
              <button class="btn btn-sm" onclick={disconnect}>Disconnect</button>
            </div>
          {:else}
            <p class="muted">Could not verify account. Token may be invalid.</p>
            <button class="btn btn-sm" onclick={disconnect}>Reset Token</button>
          {/if}
        </div>

        <div class="publish-section">
          <label class="field-label">
            Select a local skill to publish
            <select bind:value={selectedSlug} class="skill-select">
              <option value="">-- Choose a skill --</option>
              {#each localSkills as s}
                <option value={s.slug}>{s.title} ({s.program}/{s.slug})</option>
              {/each}
            </select>
          </label>

          {#if selectedSkill}
            <div class="preview">
              <div class="preview-row"><span class="pv-label">Title</span><span>{selectedSkill.title}</span></div>
              <div class="preview-row"><span class="pv-label">Program</span><span>{selectedSkill.program}</span></div>
              <div class="preview-row"><span class="pv-label">Category</span><span>{selectedSkill.category}</span></div>
              <div class="preview-row"><span class="pv-label">Description</span><span>{selectedSkill.description || "—"}</span></div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="modal-actions">
      {#if hasToken && selectedSkill}
        <button class="btn btn-accent" onclick={publish} disabled={publishing}>
          {publishing ? "Publishing..." : "Publish"}
        </button>
      {/if}
      <button class="btn" onclick={onclose}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 8px);
    width: min(480px, 90vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h3 {
    font-size: var(--font-size-lg);
    margin: 0;
  }
  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .close-btn:hover {
    color: var(--text-primary);
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .section-desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 12px;
    line-height: 1.5;
  }
  .section-hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 12px 0 6px;
  }
  .token-row {
    display: flex;
    gap: 6px;
  }
  .token-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .user-section {
    margin-bottom: 16px;
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .user-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  .muted {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }
  .field-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .skill-select {
    width: 100%;
  }
  .preview {
    margin-top: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
  }
  .preview-row {
    display: flex;
    gap: 8px;
    font-size: var(--font-size-sm);
    line-height: 1.6;
  }
  .pv-label {
    color: var(--text-muted);
    min-width: 80px;
    flex-shrink: 0;
  }
  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .btn {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    transition: all 0.15s;
  }
  .btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-accent:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-sm {
    padding: 3px 8px;
    font-size: 11px;
  }
</style>
