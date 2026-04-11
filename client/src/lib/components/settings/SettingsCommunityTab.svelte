<script lang="ts">
  import { loadSettings, saveSettings, communityApi, type CommunityUser } from "../../api/community";
  import { api } from "../../api/rest";
  import { toast } from "../../stores/toast.svelte";
  import { open } from "@tauri-apps/plugin-shell";

  let settings = $state(loadSettings());
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state("");

  // Auth state
  let tokenInput = $state("");
  let communityUser = $state<CommunityUser | null>(null);
  let loadingUser = $state(false);
  let localHasSession = $state(false);

  // ── Prompt-injection defense policy (Layer 4) ──────────────────────
  // Resolved policy from the local server. Reflects:
  //   - admin hard-disable (locks the UI when on)
  //   - per-server "Allow community skills" toggle (defaults OFF)
  //   - extra-caution mode (defaults ON)
  // The local server is the source of truth — the toggle UI here is just
  // a control surface. Why server-side: the client is open source, so any
  // defense that runs only here is trivially bypassable.
  let policyLoading = $state(false);
  let policySaving = $state(false);
  let adminHardDisabled = $state(false);
  let allowOnClient = $state(false);
  let extraCaution = $state(true);

  async function loadCommunityPolicy() {
    policyLoading = true;
    try {
      const p = await api.settings.getCommunityPolicy();
      adminHardDisabled = p.adminHardDisabled;
      allowOnClient = p.allowOnClient;
      extraCaution = p.extraCaution;
    } catch {
      // If the server doesn't have the policy endpoint yet, fall back to
      // the conservative defaults: locked off, extra caution on.
      adminHardDisabled = false;
      allowOnClient = false;
      extraCaution = true;
    } finally {
      policyLoading = false;
    }
  }

  async function setAllowOnClient(enabled: boolean) {
    if (adminHardDisabled) return;
    policySaving = true;
    try {
      const r = await api.settings.setCommunityAllowOnClient(enabled);
      allowOnClient = r.allowOnClient;
      toast.success(enabled ? "Community skills enabled on this server" : "Community skills disabled on this server");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update community policy");
      // Re-read to recover from any divergent state.
      await loadCommunityPolicy();
    } finally {
      policySaving = false;
    }
  }

  async function setExtraCaution(enabled: boolean) {
    policySaving = true;
    try {
      const r = await api.settings.setCommunityExtraCaution(enabled);
      extraCaution = r.extraCaution;
      toast.success(enabled ? "Extra caution mode enabled" : "Extra caution mode disabled");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update extra caution");
      await loadCommunityPolicy();
    } finally {
      policySaving = false;
    }
  }

  $effect(() => { loadCommunityPolicy(); });

  // Push the community session token to the local Arkestrator server so that
  // agent MCP tools (search_community_skills, install_community_skill) can
  // forward it as a Bearer token when calling arkestrator.com. Silent on failure
  // so users aren't bothered if the feature isn't reachable on the local server.
  async function pushSessionToLocalServer(token: string | null) {
    try {
      const res = await api.settings.setCommunitySession(token);
      localHasSession = res.hasSession;
    } catch {
      // Non-critical — the feature degrades to "not logged in" on the agent side,
      // but everything else in the Community tab still works.
    }
  }

  $effect(() => {
    if (settings.authToken && !communityUser) {
      loadingUser = true;
      communityApi.me()
        .then((u) => {
          communityUser = u;
          // Keep the local server in sync whenever we confirm a valid token
          pushSessionToLocalServer(settings.authToken);
        })
        .catch(() => { communityUser = null; })
        .finally(() => { loadingUser = false; });
    }
  });

  // Check local server session state on mount
  $effect(() => {
    api.settings.getCommunitySession()
      .then((res) => { localHasSession = res.hasSession; })
      .catch(() => { localHasSession = false; });
  });

  function save() {
    saving = true;
    try {
      saveSettings(settings);
      toast.success("Community settings saved");
    } catch (err: any) {
      toast.error(`Failed to save: ${err?.message}`);
    } finally {
      saving = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = "";
    try {
      const programs = await communityApi.getPrograms();
      testResult = `Connected. ${programs.length} programs available.`;
    } catch (err: any) {
      testResult = `Connection failed: ${err?.message}`;
    } finally {
      testing = false;
    }
  }

  async function openGitHubAuth() {
    const baseUrl = settings.baseUrl || "https://arkestrator.com";
    try {
      await open(`${baseUrl}/auth/github?from=desktop`);
    } catch {
      window.open(`${baseUrl}/auth/github?from=desktop`, "_blank");
    }
  }

  async function saveToken() {
    if (!tokenInput.trim()) return;
    settings.authToken = tokenInput.trim();
    saveSettings(settings);
    const newToken = tokenInput.trim();
    tokenInput = "";
    // Reload user
    communityUser = null;
    loadingUser = true;
    try {
      const u = await communityApi.me();
      communityUser = u;
      await pushSessionToLocalServer(newToken);
      toast.success("GitHub account connected");
    } catch {
      communityUser = null;
      toast.error("Invalid token");
    } finally {
      loadingUser = false;
    }
  }

  async function disconnectAccount() {
    settings.authToken = "";
    saveSettings(settings);
    communityUser = null;
    await pushSessionToLocalServer(null);
    toast.info("GitHub account disconnected");
  }
</script>

<section class="warning-banner">
  <div class="warning-row">
    <span class="warning-icon">⚠️</span>
    <div>
      <strong>Community skills are submitted by third parties</strong>
      <p class="desc">
        They have not been audited by Arkestrator. Skill content is text that gets injected into
        AI agent prompts, so a malicious skill can attempt prompt injection — instructing your
        agent to ignore safety guidance, run destructive commands, or exfiltrate credentials.
        Arkestrator applies multiple layers of defense (publisher-side scanning, local content
        scanning, untrusted-content framing in agent prompts), but defenses are not perfect.
        <strong>Use community skills with caution</strong>, especially from authors you don't
        recognize. If a job behaves unexpectedly after a community skill is involved, disable
        the skill and report it on arkestrator.com.
      </p>
    </div>
  </div>
</section>

<section>
  <h3>Community Skills</h3>
  <div class="form-group">
    {#if adminHardDisabled}
      <div class="locked-row">
        <span class="locked-icon">🔒</span>
        <div>
          <strong>Disabled by administrator</strong>
          <p class="desc">
            Community skills have been hard-disabled on this server by an administrator.
            Contact your admin to change this policy.
          </p>
        </div>
      </div>
    {:else}
      <label class="toggle-label">
        <input
          type="checkbox"
          checked={allowOnClient}
          disabled={policySaving || policyLoading}
          onchange={(e) => setAllowOnClient((e.target as HTMLInputElement).checked)}
        />
        <span>Allow community skills on this server</span>
      </label>
      <p class="desc">
        When off, agents cannot search or install skills from arkestrator.com and existing
        community skills are not surfaced via <code>get_skill</code>. Defaults to off — opt in
        only after reading the warning above.
      </p>

      <label class="toggle-label">
        <input
          type="checkbox"
          checked={extraCaution}
          disabled={policySaving || policyLoading || !allowOnClient}
          onchange={(e) => setExtraCaution((e.target as HTMLInputElement).checked)}
        />
        <span>Extra caution mode (recommended)</span>
      </label>
      <p class="desc">
        Wraps community skill content with stronger prompt-injection-defense framing when it
        reaches an agent. Slightly increases token usage but is the safer default.
      </p>
    {/if}

    <hr class="separator" />

    <label class="toggle-label">
      <input type="checkbox" bind:checked={settings.enabled} />
      <span>Enable Community Skills (client UI)</span>
    </label>
    <p class="desc">Show the Community tab in the Arkestrator client UI for browsing and installing skills manually.</p>

    <label>
      Community API URL
      <input type="text" bind:value={settings.baseUrl} placeholder="https://arkestrator.com" />
    </label>

    <div class="actions-row">
      <button class="btn" onclick={save} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </button>
      <button class="btn" onclick={testConnection} disabled={testing}>
        {testing ? "Testing..." : "Test Connection"}
      </button>
    </div>
    {#if testResult}
      <p class="test-result" class:success={testResult.startsWith("Connected")}>{testResult}</p>
    {/if}
  </div>
</section>

<section>
  <h3>Community Account</h3>
  <div class="form-group">
    {#if settings.authToken}
      {#if loadingUser}
        <p class="desc">Verifying account...</p>
      {:else if communityUser}
        <div class="user-row">
          {#if communityUser.avatar_url}
            <img class="user-avatar" src={communityUser.avatar_url} alt="" />
          {/if}
          <span>Connected as <strong>{communityUser.username}</strong></span>
        </div>
        <button class="btn btn-danger-text" onclick={disconnectAccount}>Disconnect Account</button>
      {:else}
        <p class="desc">Could not verify account. The token may be expired.</p>
        <button class="btn btn-danger-text" onclick={disconnectAccount}>Reset Token</button>
      {/if}
    {:else}
      <p class="desc">Connect with GitHub to publish your skills to the community.</p>
      <button class="btn btn-accent" onclick={openGitHubAuth}>Connect with GitHub</button>
      <p class="desc">After authenticating, paste the token below:</p>
      <div class="token-row">
        <input
          type="text"
          class="token-input"
          bind:value={tokenInput}
          placeholder="Paste auth token..."
        />
        <button class="btn" onclick={saveToken} disabled={!tokenInput.trim()}>Save</button>
      </div>
    {/if}
  </div>
</section>

<section>
  <h3>
    Agent Auto-Install
    <span class="beta-badge">BETA</span>
  </h3>
  <div class="form-group">
    <p class="desc">
      Agents can automatically search and install community skills from arkestrator.com
      during jobs, as a fallback when local skills don't cover the task. This feature is
      <strong>free during early access</strong>. When pricing launches later, beta users
      will receive advance notice.
    </p>
    {#if settings.authToken && communityUser && localHasSession}
      <p class="desc status-ok">
        ✓ Ready. Agents on this server can use community auto-install.
      </p>
    {:else if settings.authToken && communityUser && !localHasSession}
      <p class="desc status-warn">
        Your GitHub account is connected, but the local server hasn't received the
        session token yet. Try refreshing this tab or reconnecting.
      </p>
    {:else}
      <p class="desc status-warn">
        Agent auto-install requires connecting your GitHub account above. Without
        a connected account, agents on this server cannot install community skills.
      </p>
    {/if}
  </div>
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
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .toggle-label {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);
    cursor: pointer;
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0;
    line-height: 1.4;
  }
  .actions-row {
    display: flex;
    gap: 8px;
  }
  .test-result {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    margin: 0;
  }
  .test-result.success {
    color: var(--status-completed);
  }
  .user-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .user-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
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
  .btn {
    padding: 6px 16px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
    align-self: flex-start;
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
  .btn-danger-text {
    color: var(--status-failed);
    background: transparent;
    border-color: transparent;
    padding: 4px 0;
  }
  .btn-danger-text:hover {
    text-decoration: underline;
    background: transparent;
  }
  .beta-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    vertical-align: middle;
  }
  .status-ok {
    color: var(--status-completed, #4ade80);
  }
  .status-warn {
    color: var(--text-muted);
  }
  .warning-banner {
    background: color-mix(in srgb, var(--status-failed, #f87171) 12%, var(--bg-surface));
    border-color: color-mix(in srgb, var(--status-failed, #f87171) 40%, var(--border));
  }
  .warning-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .warning-icon {
    font-size: 20px;
    flex-shrink: 0;
    line-height: 1;
  }
  .warning-row strong {
    display: block;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    margin-bottom: 4px;
  }
  .locked-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
  }
  .locked-icon {
    font-size: 16px;
    line-height: 1;
    flex-shrink: 0;
  }
  .locked-row strong {
    display: block;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    margin-bottom: 2px;
  }
  .separator {
    border: none;
    border-top: 1px solid var(--border);
    margin: 8px 0 4px;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-elevated);
    padding: 1px 4px;
    border-radius: 3px;
  }
</style>
