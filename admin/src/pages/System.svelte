<script lang="ts">
  import { api } from "../lib/api/client";
  import { auth } from "../lib/stores/auth.svelte";
  import { toast } from "../lib/stores/toast.svelte";

  type Tab = "settings" | "backup" | "danger";
  let activeTab = $state<Tab>("settings");

  // ── System Settings state ──
  let loading = $state(true);
  let saving = $state(false);
  let jobTimeoutMin = $state(30);
  let maxConcurrentAgents = $state(8);
  let logLevel = $state("info");
  let workerPollMs = $state(500);
  let defaultWorkspaceMode = $state("auto");
  let wsMaxPayloadMb = $state(256);

  // ── Coordination Policy ──
  let allowClientCoordination = $state(false);
  let policyLoading = $state(false);
  let policySaving = $state(false);

  // ── Community (arkestrator.com) admin controls ──
  let communityLoading = $state(false);
  let communitySaving = $state(false);
  let communityAgentAutoInstall = $state(true);
  let communityBaseUrl = $state("");
  let communityBaseUrlInput = $state("");
  let communityUsers = $state<Array<{ id: string; username: string; hasSession: boolean }>>([]);
  // Prompt-injection defense overrides (Layer 4). admin hard-disable
  // forces every other community gate to off, locks the per-user toggle
  // in the client UI, and refuses every install/search code path. Use
  // this to enforce org-wide policy on a shared server.
  let communityAdminHardDisabled = $state(false);
  let communityAllowOnClient = $state(false);
  let communityExtraCaution = $state(true);
  // Stats + visibility (populated by /community/stats)
  type CommunitySkillRow = {
    slug: string;
    program: string;
    title: string;
    trustTier: string | null;
    flagged: boolean;
    flaggedReasons: string[];
    authorLogin: string | null;
    authorVerified: boolean;
    createdAt: string;
  };
  let communityStats = $state<{ total: number; flagged: number; byTier: Record<string, number>; skills: CommunitySkillRow[] }>({
    total: 0,
    flagged: 0,
    byTier: {},
    skills: [],
  });
  let communityStatsLoading = $state(false);
  let showAllCommunitySkills = $state(false);
  let bulkDeleteBusy = $state(false);

  async function loadCommunityStats() {
    if (!auth.isAdmin) return;
    communityStatsLoading = true;
    try {
      communityStats = await api.settings.getCommunityStats();
    } catch {
      // Non-critical — feature may not be enabled or there are no skills yet.
      communityStats = { total: 0, flagged: 0, byTier: {}, skills: [] };
    } finally {
      communityStatsLoading = false;
    }
  }

  async function deleteCommunitySkill(slug: string, program: string, title: string) {
    if (!confirm(`Delete community skill "${title}" (${slug})? This cannot be undone — but the user can re-install it from arkestrator.com.`)) return;
    try {
      await api.settings.deleteCommunitySkill(slug, program);
      toast.success(`Deleted ${slug}`);
      await loadCommunityStats();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to delete skill");
    }
  }

  async function bulkDeleteFlaggedCommunitySkills() {
    if (communityStats.flagged === 0) return;
    if (!confirm(`Delete all ${communityStats.flagged} flagged community skill(s)? This cannot be undone.`)) return;
    bulkDeleteBusy = true;
    try {
      const r = await api.settings.deleteAllFlaggedCommunitySkills();
      toast.success(`Deleted ${r.removed} flagged skill(s)`);
      await loadCommunityStats();
    } catch (err: any) {
      toast.error(err?.message ?? "Bulk delete failed");
    } finally {
      bulkDeleteBusy = false;
    }
  }

  /**
   * Compute a human-readable "current state" label for the community feature
   * based on the resolved policy. Surfaced in the admin panel banner so the
   * admin can tell at a glance what their server is doing.
   */
  function communityEffectiveState(): { label: string; tone: "danger" | "warn" | "ok" | "off"; detail: string } {
    if (communityAdminHardDisabled) {
      return {
        label: "HARD-DISABLED",
        tone: "off",
        detail: "All community-skill code paths are no-ops. The per-user toggle in clients is locked off.",
      };
    }
    if (!communityAllowOnClient) {
      return {
        label: "DISABLED",
        tone: "off",
        detail: "Users on this server cannot search or install community skills, but they could enable it themselves in their Community tab.",
      };
    }
    if (!communityExtraCaution) {
      return {
        label: "ENABLED — relaxed framing",
        tone: "warn",
        detail: "Community skills are usable. Untrusted-content framing is in lighter mode. Recommended to turn extra caution back on.",
      };
    }
    return {
      label: "ENABLED — extra caution on",
      tone: "ok",
      detail: "Community skills are usable. All defenses active: untrusted-content framing, content scanner, publisher trust gating.",
    };
  }

  async function loadCommunityAdmin() {
    if (!auth.isAdmin) return;
    communityLoading = true;
    try {
      const result = await api.settings.getCommunityAdmin();
      communityAgentAutoInstall = result.agentAutoInstallEnabled;
      communityBaseUrl = result.baseUrl;
      communityBaseUrlInput = result.baseUrl;
      communityAdminHardDisabled = result.adminHardDisabled;
      communityAllowOnClient = result.allowOnClient;
      communityExtraCaution = result.extraCaution;
      communityUsers = result.users;
    } catch (err: any) {
      // Non-critical — feature may not be enabled on this server
    } finally {
      communityLoading = false;
    }
    await loadCommunityStats();
  }

  async function setCommunityAdminHardDisabled(disabled: boolean) {
    communitySaving = true;
    try {
      const r = await api.settings.setCommunityAdminHardDisabled(disabled);
      communityAdminHardDisabled = r.adminHardDisabled;
      toast.success(disabled
        ? "Community skills hard-disabled. The per-user toggle in clients is now locked off."
        : "Community skills hard-disable cleared. Per-user toggle in clients is unlocked.");
      // Re-fetch — turning hard-disable on may have implicitly forced
      // other flags to safe values on the server side.
      await loadCommunityAdmin();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update hard-disable");
    } finally {
      communitySaving = false;
    }
  }

  async function setCommunityAllowOnClientAdmin(enabled: boolean) {
    communitySaving = true;
    try {
      const r = await api.settings.setCommunityAllowOnClient(enabled);
      communityAllowOnClient = r.allowOnClient;
      toast.success(enabled ? "Community skills allowed on this server" : "Community skills disallowed on this server");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update allow-on-client");
    } finally {
      communitySaving = false;
    }
  }

  async function setCommunityExtraCautionAdmin(enabled: boolean) {
    communitySaving = true;
    try {
      const r = await api.settings.setCommunityExtraCaution(enabled);
      communityExtraCaution = r.extraCaution;
      toast.success(enabled ? "Extra caution mode enabled" : "Extra caution mode disabled");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update extra caution");
    } finally {
      communitySaving = false;
    }
  }

  async function setCommunityAgentAutoInstallEnabled(enabled: boolean) {
    communitySaving = true;
    try {
      const result = await api.settings.setCommunityAgentAutoInstall(enabled);
      communityAgentAutoInstall = result.agentAutoInstallEnabled;
      toast.success(enabled ? "Agent community auto-install enabled" : "Agent community auto-install disabled");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update community setting");
    } finally {
      communitySaving = false;
    }
  }

  async function saveCommunityBaseUrl() {
    communitySaving = true;
    try {
      const next = communityBaseUrlInput.trim() || null;
      const result = await api.settings.setCommunityBaseUrl(next);
      communityBaseUrl = result.baseUrl ?? "";
      communityBaseUrlInput = communityBaseUrl;
      toast.success("Community base URL updated");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update base URL");
    } finally {
      communitySaving = false;
    }
  }

  async function clearCommunityUserSession(userId: string, username: string) {
    if (!confirm(`Clear the community session for ${username}? They will need to re-connect their GitHub account in the client.`)) return;
    try {
      await api.settings.clearCommunityUserSession(userId);
      toast.success(`Cleared session for ${username}`);
      await loadCommunityAdmin();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to clear session");
    }
  }

  async function loadConfig() {
    loading = true;
    try {
      const cfg = await api.system.getConfig();
      jobTimeoutMin = Math.round(cfg.jobTimeoutMs / 60_000);
      maxConcurrentAgents = cfg.maxConcurrentAgents;
      logLevel = cfg.logLevel;
      workerPollMs = cfg.workerPollMs;
      defaultWorkspaceMode = cfg.defaultWorkspaceMode;
      wsMaxPayloadMb = cfg.wsMaxPayloadMb;
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load system config");
    } finally {
      loading = false;
    }
    // Load coordination policy alongside system config
    if (auth.canManageSecurity) {
      policyLoading = true;
      try {
        const result = await api.settings.get();
        allowClientCoordination = !!result?.allowClientCoordination;
      } catch { /* ignore */ } finally {
        policyLoading = false;
      }
    }
  }

  async function setAllowClientCoordination(enabled: boolean) {
    if (!auth.canManageSecurity) return;
    policySaving = true;
    try {
      const result = await api.settings.setAllowClientCoordination(enabled);
      allowClientCoordination = !!result?.allowClientCoordination;
      toast.success(allowClientCoordination ? "Global client-side coordination enabled." : "Global client-side coordination disabled.");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update coordination policy");
    } finally {
      policySaving = false;
    }
  }

  async function saveConfig() {
    saving = true;
    try {
      const res = await api.system.updateConfig({
        jobTimeoutMs: jobTimeoutMin * 60_000,
        maxConcurrentAgents,
        logLevel,
        workerPollMs,
        defaultWorkspaceMode,
        wsMaxPayloadMb,
      });
      toast.success(`Settings saved (${res.updated.length} updated)`);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save settings");
    } finally {
      saving = false;
    }
  }

  // Load on mount
  $effect(() => { loadConfig(); });
  $effect(() => { loadCommunityAdmin(); });

  // ── Danger Zone state ──
  let showResetModal = $state(false);
  let resetPassword = $state("");
  let resetConfirmation = $state("");
  let resetError = $state("");
  let resetBusy = $state(false);
  let clearTrainingData = $state(false);

  async function factoryReset() {
    if (!resetPassword) {
      resetError = "Password is required";
      return;
    }
    if (resetConfirmation !== "RESET") {
      resetError = 'Type "RESET" to confirm';
      return;
    }
    resetError = "";
    resetBusy = true;
    try {
      await api.system.factoryReset(resetPassword, resetConfirmation, clearTrainingData);
      toast.success("Factory reset complete. Logging out...");
      showResetModal = false;
      setTimeout(() => auth.logout(), 1500);
    } catch (err: any) {
      resetError = err?.message ?? "Factory reset failed";
    } finally {
      resetBusy = false;
    }
  }

  function closeModal() {
    showResetModal = false;
    resetPassword = "";
    resetConfirmation = "";
    resetError = "";
    clearTrainingData = false;
  }

  // ── Backup & Restore state ──
  interface ExportCategory { key: string; label: string; defaultEnabled: boolean; }
  let exportCategories = $state<ExportCategory[]>([]);
  let exportSelection = $state<Record<string, boolean>>({});
  let exportLoading = $state(false);
  let exportBusy = $state(false);
  let importBusy = $state(false);
  let importPreview = $state<{ fileName: string; categories: string[]; counts: Record<string, number> } | null>(null);
  let pendingImportSnapshot = $state<any>(null);

  async function loadExportCategories() {
    exportLoading = true;
    try {
      const res = await api.system.getExportCategories();
      exportCategories = res.categories;
      exportSelection = {};
      for (const cat of res.categories) {
        exportSelection[cat.key] = cat.defaultEnabled;
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load export categories");
    } finally {
      exportLoading = false;
    }
  }

  async function doExport() {
    exportBusy = true;
    try {
      const res = await api.system.selectiveExport(exportSelection);
      const blob = new Blob([JSON.stringify(res.snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.suggestedFileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch (err: any) {
      toast.error(err?.message ?? "Export failed");
    } finally {
      exportBusy = false;
    }
  }

  function handleImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const snapshot = JSON.parse(reader.result as string);
        if (snapshot.format !== "arkestrator-config-snapshot") {
          toast.error("Invalid file: not an Arkestrator export");
          return;
        }
        const tables = snapshot.tables ?? {};
        const counts: Record<string, number> = {};
        const categories: string[] = [];
        for (const [table, rows] of Object.entries(tables)) {
          if (Array.isArray(rows) && rows.length > 0) {
            counts[table] = rows.length;
            categories.push(table);
          }
        }
        if (snapshot.training?.files?.length > 0) {
          counts["training_files"] = snapshot.training.files.length;
          categories.push("training_files");
        }
        importPreview = { fileName: file.name, categories, counts };
        pendingImportSnapshot = snapshot;
      } catch {
        toast.error("Failed to parse import file");
      }
    };
    reader.readAsText(file);
    input.value = "";
  }

  async function doImport() {
    if (!pendingImportSnapshot) return;
    importBusy = true;
    try {
      const res = await api.coordinatorTraining.importSnapshot(pendingImportSnapshot, false);
      toast.success(`Import complete: ${JSON.stringify(res)}`);
      importPreview = null;
      pendingImportSnapshot = null;
    } catch (err: any) {
      toast.error(err?.message ?? "Import failed");
    } finally {
      importBusy = false;
    }
  }

  function cancelImport() {
    importPreview = null;
    pendingImportSnapshot = null;
  }

  $effect(() => {
    if (activeTab === "backup") loadExportCategories();
  });
</script>

<div class="system-page">
  <div class="tab-bar">
    <button class="tab" class:active={activeTab === "settings"} onclick={() => (activeTab = "settings")}>
      System Settings
    </button>
    <button class="tab" class:active={activeTab === "backup"} onclick={() => (activeTab = "backup")}>
      Backup & Restore
    </button>
    <button class="tab" class:active={activeTab === "danger"} onclick={() => (activeTab = "danger")}>
      Danger Zone
    </button>
  </div>

  <div class="tab-content">
    {#if activeTab === "settings"}
      <div class="page">
        <h2>System Settings</h2>
        <p class="subtitle">Runtime configuration for the server. Changes take effect immediately for new jobs.</p>

        {#if loading}
          <p class="muted">Loading...</p>
        {:else}
          <div class="settings-grid">
            <div class="setting">
              <label for="jobTimeout">Job Timeout (minutes)</label>
              <p class="hint">Maximum time a job can run before being killed. Default: 30 min.</p>
              <input id="jobTimeout" type="number" min="1" max="1440" bind:value={jobTimeoutMin} />
            </div>

            <div class="setting">
              <label for="maxAgents">Max Concurrent Agents</label>
              <p class="hint">How many jobs can run in parallel. Default: 8.</p>
              <input id="maxAgents" type="number" min="1" max="64" bind:value={maxConcurrentAgents} />
            </div>

            <div class="setting">
              <label for="logLevel">Log Level</label>
              <p class="hint">Server log verbosity.</p>
              <select id="logLevel" bind:value={logLevel}>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div class="setting">
              <label for="pollMs">Worker Poll Interval (ms)</label>
              <p class="hint">How often workers check for queued jobs. Lower = more responsive, higher = less CPU. Default: 500.</p>
              <input id="pollMs" type="number" min="100" max="10000" step="100" bind:value={workerPollMs} />
            </div>

            <div class="setting">
              <label for="wsPayload">WebSocket Max Payload (MB)</label>
              <p class="hint">Maximum size of a single WebSocket message. Applies to file transfers (EXR, PSD, etc.). Requires server restart. Default: 256 MB.</p>
              <input id="wsPayload" type="number" min="1" bind:value={wsMaxPayloadMb} />
            </div>

            <div class="setting">
              <label for="wsMode">Default Workspace Mode</label>
              <p class="hint">How the agent accesses the project filesystem by default.</p>
              <select id="wsMode" bind:value={defaultWorkspaceMode}>
                <option value="auto">Auto</option>
                <option value="command">Command</option>
                <option value="repo">Repo</option>
                <option value="sync">Sync</option>
              </select>
            </div>
          </div>

          <div class="actions-row">
            <button class="btn-primary" onclick={saveConfig} disabled={saving}>
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>

          {#if auth.canManageSecurity}
            <div class="policy-section">
              <h3>Coordination Policy</h3>
              <p class="hint">Controls whether non-admin users can enable client-side coordination and queue client-initiated training.</p>
              <label class="toggle-label">
                <input
                  type="checkbox"
                  checked={allowClientCoordination}
                  onchange={(e) => setAllowClientCoordination((e.target as HTMLInputElement).checked)}
                  disabled={policyLoading || policySaving}
                />
                <span>Allow client-side coordination globally</span>
              </label>
              {#if policyLoading}
                <p class="muted">Loading...</p>
              {:else if policySaving}
                <p class="muted">Saving...</p>
              {/if}
            </div>
          {/if}

          {#if auth.isAdmin}
            <div class="policy-section community-section">
              <h3>Community Skills (arkestrator.com)
                <span class="beta-badge">BETA</span>
              </h3>
              <p class="hint">
                Skills submitted by third parties on arkestrator.com. They are an
                <strong>untrusted prompt-injection vector</strong> — agents inject skill content
                directly into model context, so a malicious skill can attempt jailbreaks,
                credential exfiltration, or destructive tool calls. Arkestrator applies multiple
                defense layers (publisher-side scanning, local heuristic scanner, untrusted-content
                framing, trust-tier gating). This panel lets you tune the policy and triage
                anything that slipped through.
              </p>

              {#if communityLoading}
                <p class="muted">Loading community policy...</p>
              {:else}
                {@const state = communityEffectiveState()}
                <div class="community-status community-status-{state.tone}">
                  <div class="community-status-header">
                    <span class="community-status-dot"></span>
                    <strong>Current state: {state.label}</strong>
                  </div>
                  <p class="hint" style="margin:6px 0 0;">{state.detail}</p>
                </div>

                <!-- Live counts panel -->
                <div class="community-counts">
                  <div class="count-card">
                    <div class="count-num">{communityStats.total}</div>
                    <div class="count-label">installed</div>
                  </div>
                  <div class="count-card" class:count-card-danger={communityStats.flagged > 0}>
                    <div class="count-num">{communityStats.flagged}</div>
                    <div class="count-label">flagged</div>
                  </div>
                  {#each Object.entries(communityStats.byTier) as [tier, n]}
                    <div class="count-card">
                      <div class="count-num">{n}</div>
                      <div class="count-label">{tier}</div>
                    </div>
                  {/each}
                  {#if communityStats.flagged > 0}
                    <button
                      class="btn-danger"
                      onclick={bulkDeleteFlaggedCommunitySkills}
                      disabled={bulkDeleteBusy}
                    >
                      {bulkDeleteBusy ? "Deleting..." : `Delete all ${communityStats.flagged} flagged`}
                    </button>
                  {/if}
                </div>

                <!-- Security & Defense subgroup -->
                <h4 class="community-subhead">Security &amp; Defense</h4>
                <div class="security-card security-card-danger">
                  <label class="toggle-label">
                    <input
                      type="checkbox"
                      checked={communityAdminHardDisabled}
                      onchange={(e) => setCommunityAdminHardDisabled((e.target as HTMLInputElement).checked)}
                      disabled={communityLoading || communitySaving}
                    />
                    <span><strong>Hard-disable community skills</strong>
                      <span class="recommend-badge">Recommended for shared servers</span>
                    </span>
                  </label>
                  <p class="hint">
                    Master kill switch. When on: every community code path becomes a no-op
                    (search, install, get_skill, auto-injection), and the per-user toggle in
                    every client is locked off. Users cannot override this.
                  </p>
                </div>

                <div class="security-card">
                  <label class="toggle-label">
                    <input
                      type="checkbox"
                      checked={communityAllowOnClient}
                      onchange={(e) => setCommunityAllowOnClientAdmin((e.target as HTMLInputElement).checked)}
                      disabled={communityLoading || communitySaving || communityAdminHardDisabled}
                    />
                    <span>Allow community skills on this server (default)</span>
                  </label>
                  <p class="hint">
                    Server-side default for the per-user toggle. Users can override this in their
                    Community tab unless hard-disable above is on. Defaults to off.
                  </p>
                </div>

                <div class="security-card">
                  <label class="toggle-label">
                    <input
                      type="checkbox"
                      checked={communityExtraCaution}
                      onchange={(e) => setCommunityExtraCautionAdmin((e.target as HTMLInputElement).checked)}
                      disabled={communityLoading || communitySaving || communityAdminHardDisabled}
                    />
                    <span>Extra caution mode <span class="recommend-badge">Recommended</span></span>
                  </label>
                  <p class="hint">
                    Wraps community skill content in stronger prompt-injection-defense framing
                    when it reaches an agent. Adds ~200 tokens per skill. Defaults to on.
                  </p>
                </div>

                <div class="security-card">
                  <label class="toggle-label">
                    <input
                      type="checkbox"
                      checked={communityAgentAutoInstall}
                      onchange={(e) => setCommunityAgentAutoInstallEnabled((e.target as HTMLInputElement).checked)}
                      disabled={communityLoading || communitySaving || communityAdminHardDisabled}
                    />
                    <span>Enable agent auto-install (legacy flag)</span>
                  </label>
                  <p class="hint">
                    Lets agents call <code>install_community_skill</code> autonomously during a
                    job. Off by default — even when on, the install path enforces all the
                    defenses above.
                  </p>
                </div>

                <!-- Installed skills triage subgroup -->
                {#if communityStats.skills.length > 0}
                  <h4 class="community-subhead">
                    Installed Community Skills
                    {#if communityStats.flagged > 0}
                      <span class="flagged-count">{communityStats.flagged} flagged</span>
                    {/if}
                  </h4>
                  <p class="hint">
                    Flagged skills are listed first. Click delete to remove a skill from the
                    local DB — the user can re-install it if they choose.
                  </p>
                  <table class="community-skills-table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Slug</th>
                        <th>Tier</th>
                        <th>Author</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each (showAllCommunitySkills ? communityStats.skills : communityStats.skills.slice(0, 20)) as s}
                        <tr class:row-flagged={s.flagged}>
                          <td>{s.title}</td>
                          <td><code>{s.slug}</code></td>
                          <td>
                            {#if s.trustTier === "verified"}
                              <span class="tier-verified">verified</span>
                            {:else if s.trustTier === "community"}
                              <span class="tier-community">community</span>
                            {:else}
                              <span class="tier-unknown">{s.trustTier ?? "unknown"}</span>
                            {/if}
                          </td>
                          <td>
                            {#if s.authorLogin}
                              @{s.authorLogin}
                              {#if s.authorVerified}<span class="verified-tick">✓</span>{/if}
                            {:else}
                              <span class="muted">unknown</span>
                            {/if}
                          </td>
                          <td>
                            {#if s.flagged}
                              <span class="status-flagged" title={s.flaggedReasons.join(", ")}>
                                ⚠ {s.flaggedReasons.slice(0, 2).join(", ")}{s.flaggedReasons.length > 2 ? "…" : ""}
                              </span>
                            {:else}
                              <span class="status-clean">clean</span>
                            {/if}
                          </td>
                          <td>
                            <button class="btn-small btn-danger-text" onclick={() => deleteCommunitySkill(s.slug, s.program, s.title)}>Delete</button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  {#if communityStats.skills.length > 20 && !showAllCommunitySkills}
                    <button class="btn-link" onclick={() => showAllCommunitySkills = true}>
                      Show all {communityStats.skills.length} skills
                    </button>
                  {/if}
                {/if}
              {/if}

              <div class="setting" style="margin-top:12px;">
                <label for="communityBaseUrl">Community Base URL</label>
                <p class="hint">Defaults to https://arkestrator.com. Override for testing against a local or self-hosted instance.</p>
                <div style="display:flex; gap:8px; align-items:center;">
                  <input
                    id="communityBaseUrl"
                    type="text"
                    placeholder="https://arkestrator.com"
                    bind:value={communityBaseUrlInput}
                    style="flex:1;"
                  />
                  <button class="btn-primary" onclick={saveCommunityBaseUrl} disabled={communitySaving || communityBaseUrlInput.trim() === communityBaseUrl}>
                    Save
                  </button>
                </div>
              </div>

              {#if communityUsers.length > 0}
                <div class="setting" style="margin-top:16px;">
                  <h4 style="margin:0 0 8px;">Per-User Community Sessions</h4>
                  <p class="hint">
                    Users on this server with a stored arkestrator.com GitHub session.
                    Clear a session if a user leaves or their token is compromised.
                  </p>
                  <table class="community-users-table">
                    <thead>
                      <tr><th>Username</th><th>Status</th><th></th></tr>
                    </thead>
                    <tbody>
                      {#each communityUsers as user}
                        <tr>
                          <td>{user.username}</td>
                          <td>
                            {#if user.hasSession}
                              <span class="status-ok">Connected</span>
                            {:else}
                              <span class="status-none">Not connected</span>
                            {/if}
                          </td>
                          <td>
                            {#if user.hasSession}
                              <button class="btn-small" onclick={() => clearCommunityUserSession(user.id, user.username)}>Clear session</button>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>

    {:else if activeTab === "backup"}
      <div class="page">
        <h2>Backup & Restore</h2>
        <p class="subtitle">Export server data for backup or transfer to another instance. Import a previous export to restore.</p>

        <div class="backup-section">
          <h3>Export</h3>
          <p class="hint">Select what to include in the export. Sensitive data (users, API keys) is excluded by default.</p>

          {#if exportLoading}
            <p class="muted">Loading categories...</p>
          {:else}
            <div class="checkbox-grid">
              {#each exportCategories as cat}
                <label class="export-checkbox">
                  <input type="checkbox" bind:checked={exportSelection[cat.key]} />
                  <span>{cat.label}</span>
                </label>
              {/each}
            </div>

            <div class="actions-row">
              <button class="btn-primary" onclick={doExport} disabled={exportBusy || !Object.values(exportSelection).some(Boolean)}>
                {exportBusy ? "Exporting..." : "Export Selected"}
              </button>
            </div>
          {/if}
        </div>

        <div class="backup-section">
          <h3>Import</h3>
          <p class="hint">Upload a previously exported JSON file. Data will be merged with existing server state.</p>

          <label class="file-input-label">
            <input type="file" accept=".json" onchange={handleImportFile} class="file-input" />
            Choose File
          </label>

          {#if importPreview}
            <div class="import-preview">
              <p><strong>File:</strong> {importPreview.fileName}</p>
              <p><strong>Contains:</strong></p>
              <ul>
                {#each Object.entries(importPreview.counts) as [table, count]}
                  <li>{table}: {count} records</li>
                {/each}
              </ul>
              <div class="actions-row">
                <button class="btn-primary" onclick={doImport} disabled={importBusy}>
                  {importBusy ? "Importing..." : "Import"}
                </button>
                <button class="btn-cancel" onclick={cancelImport}>Cancel</button>
              </div>
            </div>
          {/if}
        </div>
      </div>

    {:else}
      <div class="page">
        <h2>Danger Zone</h2>

        <div class="danger-zone">
          <div class="danger-card">
            <div class="danger-info">
              <h4>Factory Reset</h4>
              <p>
                Wipe all server data including jobs, sessions, API keys, agent configs, policies, workers, and audit logs.
                All users will be deleted and a default admin account will be re-created.
              </p>
            </div>
            <button class="btn-danger" onclick={() => showResetModal = true}>Factory Reset</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if showResetModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={closeModal}>
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <h3>Factory Reset</h3>
      <p class="warning">This action is irreversible. All server data (users, jobs, skills, settings) will be permanently deleted. A default admin account (admin/admin) will be re-created.</p>
      <div class="form-group">
        <label>
          Admin Password
          <input
            type="password"
            bind:value={resetPassword}
            placeholder="Enter your password"
          />
        </label>
        <label>
          Type <strong>RESET</strong> to confirm
          <input
            bind:value={resetConfirmation}
            placeholder='Type "RESET"'
            onkeydown={(e) => { if (e.key === "Enter") factoryReset(); }}
          />
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={clearTrainingData} />
          Also clear training data
          <span class="hint">Removes learned patterns, experiences, and playbook artifacts. Uncheck to preserve institutional knowledge.</span>
        </label>
        {#if resetError}
          <span class="error">{resetError}</span>
        {/if}
      </div>
      <div class="actions">
        <button class="btn-cancel" onclick={closeModal}>Cancel</button>
        <button class="btn-danger" onclick={factoryReset} disabled={resetBusy}>
          {resetBusy ? "Resetting..." : "Confirm Factory Reset"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .system-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .tab-bar {
    display: flex;
    gap: 0;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .tab {
    padding: 10px 20px;
    font-size: var(--font-size-base);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .tab-content {
    flex: 1;
    overflow-y: auto;
  }

  .page { padding: 24px; }
  h2 { font-size: var(--font-size-xl); font-weight: 600; margin-bottom: 4px; }
  .subtitle { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 24px; }
  .muted { color: var(--text-muted); font-size: var(--font-size-sm); }

  /* ── Settings form ── */
  .settings-grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 480px;
  }

  .setting label {
    display: block;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .setting .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .setting input,
  .setting select {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .setting select {
    cursor: pointer;
  }

  .actions-row {
    margin-top: 24px;
    display: flex;
    gap: 8px;
  }
  .btn-primary {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: white;
    font-size: var(--font-size-sm);
    font-weight: 500;
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Danger Zone ── */
  .danger-zone {
    border: 1px solid var(--status-failed);
    border-radius: var(--radius-lg);
    padding: 20px;
  }
  .danger-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .danger-info h4 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .danger-info p {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    max-width: 540px;
  }
  .btn-danger {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    background: var(--status-failed);
    color: white;
    font-size: var(--font-size-sm);
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn-danger:hover { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  .checkbox-label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    margin-top: 4px;
  }
  .checkbox-label input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .checkbox-label .hint {
    display: block;
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 2px;
  }

  /* ── Policy section ── */
  .policy-section {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    max-width: 480px;
  }
  .policy-section h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .policy-section .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .toggle-label input[type="checkbox"] { flex-shrink: 0; }

  /* ── Modal ── */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
  }
  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    min-width: 360px;
    max-width: 440px;
  }
  .dialog h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .warning {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form-group label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .form-group input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .btn-cancel {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* ── Backup & Restore ── */
  .backup-section {
    max-width: 480px;
    margin-bottom: 32px;
  }
  .backup-section h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .backup-section .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .checkbox-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 16px;
    margin-bottom: 16px;
  }
  .export-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .export-checkbox input[type="checkbox"] { flex-shrink: 0; }
  .file-input-label {
    display: inline-block;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid var(--border);
  }
  .file-input-label:hover { background: var(--bg-hover); }
  .file-input { display: none; }
  .import-preview {
    margin-top: 16px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .import-preview p { font-size: var(--font-size-sm); margin-bottom: 8px; }
  .import-preview ul {
    list-style: none;
    padding: 0;
    margin: 0 0 16px 0;
  }
  .import-preview li {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    padding: 2px 0;
  }

  .beta-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    background: var(--accent, #006d77);
    color: #fff;
    border-radius: 4px;
    vertical-align: middle;
  }
  .community-users-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
    margin-top: 8px;
  }
  .community-users-table th,
  .community-users-table td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .community-users-table th {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .community-users-table .status-ok {
    color: var(--status-completed, #4ade80);
  }
  .community-users-table .status-none {
    color: var(--text-muted);
  }
  .btn-small {
    padding: 4px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .btn-small:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* ── Community policy panel ── */
  .community-section {
    max-width: 880px;
  }
  .community-status {
    display: block;
    border-left: 4px solid var(--border);
    background: var(--bg-elevated);
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    margin: 14px 0 18px;
  }
  .community-status-header {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-primary);
  }
  .community-status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .community-status-ok { border-left-color: var(--status-completed, #22c55e); }
  .community-status-ok .community-status-dot { background: var(--status-completed, #22c55e); }
  .community-status-warn { border-left-color: var(--status-running, #eab308); }
  .community-status-warn .community-status-dot { background: var(--status-running, #eab308); }
  .community-status-danger { border-left-color: var(--status-failed, #ef4444); }
  .community-status-danger .community-status-dot { background: var(--status-failed, #ef4444); }
  .community-status-off { border-left-color: var(--text-muted); }
  .community-status-off .community-status-dot { background: var(--text-muted); }

  .community-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 18px;
  }
  .count-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    min-width: 80px;
    text-align: center;
  }
  .count-card-danger {
    border-color: var(--status-failed, #ef4444);
    background: color-mix(in srgb, var(--status-failed, #ef4444) 10%, var(--bg-elevated));
  }
  .count-num {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.1;
  }
  .count-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .community-subhead {
    margin: 22px 0 8px;
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }
  .flagged-count {
    margin-left: 8px;
    font-size: 11px;
    background: var(--status-failed, #ef4444);
    color: white;
    padding: 2px 8px;
    border-radius: 12px;
    text-transform: none;
    letter-spacing: 0;
  }

  .security-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .security-card-danger {
    border-color: color-mix(in srgb, var(--status-failed, #ef4444) 50%, var(--border));
    background: color-mix(in srgb, var(--status-failed, #ef4444) 6%, var(--bg-elevated));
  }
  .recommend-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 8px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));
    color: var(--accent);
    border-radius: 10px;
    vertical-align: middle;
  }

  .community-skills-table {
    width: 100%;
    margin-top: 8px;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }
  .community-skills-table th,
  .community-skills-table td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .community-skills-table th {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  .community-skills-table code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-base);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .row-flagged {
    background: color-mix(in srgb, var(--status-failed, #ef4444) 8%, transparent);
  }
  .tier-verified {
    color: var(--status-completed, #22c55e);
    font-weight: 600;
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tier-community {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tier-unknown {
    color: var(--status-failed, #ef4444);
    font-weight: 600;
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .verified-tick {
    color: var(--status-completed, #22c55e);
    font-weight: 700;
    margin-left: 4px;
  }
  .status-flagged {
    color: var(--status-failed, #ef4444);
    font-weight: 600;
    font-size: var(--font-size-xs);
  }
  .status-clean {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .btn-danger {
    padding: 6px 14px;
    background: var(--status-failed, #ef4444);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    margin-left: auto;
  }
  .btn-danger:hover { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger-text {
    color: var(--status-failed, #ef4444);
    background: transparent;
    border: 1px solid transparent;
  }
  .btn-danger-text:hover {
    text-decoration: underline;
    background: transparent;
  }
  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
    padding: 6px 0;
  }
  .btn-link:hover { text-decoration: underline; }
</style>
