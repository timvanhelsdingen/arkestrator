<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { connection } from "../lib/stores/connection.svelte";
  import { getLocalWorkerName } from "../lib/api/ws";
  import { api } from "../lib/api/rest";

  type ScopeTab = "training" | "maintenance";

  interface AgentConfigOption {
    id: string;
    name: string;
    engine?: string;
    model?: string;
  }

  interface TrainingWorkerOption {
    name: string;
    status: "online" | "offline";
    lastIp?: string;
    localLlmEnabled?: boolean;
    localLlmBaseUrl?: string;
  }

  interface CoordinatorTrainingSchedule {
    enabled: boolean;
    intervalMinutes: number;
    apply: boolean;
    programs: string[];
  }

  interface TrainingQueueSummary {
    jobId: string;
    sourcePathCount: number;
    uploadedCount: number;
    agentConfigId: string;
    targetWorkerName: string;
    trainingPrompt: string;
    uploadSessionVaultPath: string;
    queuedAt: string;
  }

  const canManage = $derived(connection.canEditCoordinator || connection.userRole === "admin");
  const isAdmin = $derived(connection.userRole === "admin");
  const canQueueTraining = $derived(
    isAdmin || (connection.allowClientCoordination && connection.clientCoordinationEnabled),
  );
  const trainingQueueBlockedReason = $derived(
    isAdmin
      ? ""
      : !connection.allowClientCoordination
      ? "Client-side coordination is disabled by admin policy."
      : !connection.clientCoordinationEnabled
      ? "Enable client-side coordination in your user settings to queue maintenance jobs."
      : "",
  );

  let scopeTab = $state<ScopeTab>("training");
  let loading = $state(false);
  let error = $state("");
  let info = $state("");

  // Training state
  let trainingJobStarting = $state(false);
  let trainingInputPath = $state("");
  let trainingSourcePaths = $state<string[]>([]);
  let trainingAgentConfigId = $state("");
  let trainingTargetWorkerName = $state("");
  let trainingExcludeSelf = $state(false);
  let trainingPrompt = $state("");
  let trainingLevel = $state("medium");
  let trainingUploadFiles = $state<File[]>([]);
  let trainingUploadInputResetKey = $state(0);
  let trainingWorkers = $state<TrainingWorkerOption[]>([]);
  let trainingWorkersLoading = $state(false);
  let trainingLastQueued = $state<TrainingQueueSummary | null>(null);
  let trainingSchedule = $state<CoordinatorTrainingSchedule>({
    enabled: false,
    intervalMinutes: 24 * 60,
    apply: true,
    programs: [],
  });
  let trainingLastRunByProgram = $state<Record<string, string>>({});
  let trainingNextRunByProgram = $state<Record<string, string | null>>({});
  let trainingKnownPrograms = $state<string[]>([]);
  let housekeepingSchedule = $state<{ enabled: boolean; intervalMinutes: number; lastRunAt?: string }>({
    enabled: true,
    intervalMinutes: 24 * 60,
  });
  let maintenanceSaving = $state(false);
  let housekeepingRunning = $state(false);

  // Agents
  let analyzeAgents = $state<AgentConfigOption[]>([]);

  // Bridge program for training (auto-detect mode)
  let program = $state("global");
  let programs = $state<Array<{ value: string; label: string }>>([{ value: "global", label: "Global" }]);

  function normalizeProgramKey(value: string): string {
    return String(value ?? "").trim().toLowerCase();
  }

  function normalizeProgramList(values: unknown[]): string[] {
    return [...new Set(
      values
        .map((value) => normalizeProgramKey(String(value ?? "")))
        .filter((value): value is string => value.length > 0),
    )];
  }

  function formatDateTime(iso: string | null | undefined): string {
    const value = String(iso ?? "").trim();
    if (!value) return "Not scheduled";
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return "Invalid date";
    return new Date(ts).toLocaleString();
  }

  function mapAgentOptions(agentsRes: any): AgentConfigOption[] {
    return Array.isArray(agentsRes)
      ? agentsRes.map((a: any) => ({
        id: String(a?.id ?? ""),
        name: String(a?.name ?? "Unnamed"),
        engine: String(a?.engine ?? ""),
        model: String(a?.model ?? ""),
      })).filter((a: AgentConfigOption) => a.id)
      : [];
  }

  function formatAnalyzeAgentLabel(agentId: string): string {
    const agent = analyzeAgents.find((a) => a.id === agentId);
    if (!agent) return agentId;
    const model = String(agent.model ?? "").trim();
    return model ? `${agent.name} (${model})` : agent.name;
  }

  async function loadPrograms() {
    try {
      const [bridgesRes, apiBridgesRes] = await Promise.all([
        api.bridgeCommands.listBridges(),
        api.apiBridges.list().catch(() => []),
      ]);
      const knownKeys = new Set<string>();
      for (const bridge of Array.isArray(bridgesRes?.bridges) ? bridgesRes.bridges : []) {
        const key = normalizeProgramKey(String((bridge as any)?.program ?? ""));
        if (key) knownKeys.add(key);
      }
      for (const ab of Array.isArray(apiBridgesRes) ? apiBridgesRes : []) {
        const name = normalizeProgramKey(String((ab as any)?.name ?? ""));
        if (name) knownKeys.add(name);
      }
      knownKeys.add("global");
      programs = [...knownKeys].sort().map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
    } catch {
      // non-fatal
    }
  }

  async function loadTrainingAgentOptions() {
    if (!canQueueTraining) {
      analyzeAgents = [];
      trainingAgentConfigId = "";
      return;
    }
    const agentsRes = await api.agents.list();
    analyzeAgents = mapAgentOptions(agentsRes);
    if (!trainingAgentConfigId || !analyzeAgents.some((agent) => agent.id === trainingAgentConfigId)) {
      trainingAgentConfigId = "";
    }
  }

  async function loadTrainingWorkerOptions() {
    if (!canQueueTraining) {
      trainingWorkers = [];
      trainingTargetWorkerName = "";
      return;
    }
    trainingWorkersLoading = true;
    try {
      const result = await api.workers.list();
      const rows = Array.isArray(result?.workers) ? result.workers : [];
      const mapped: TrainingWorkerOption[] = rows
        .map((row: any) => ({
          name: String(row?.name ?? "").trim(),
          status: row?.status === "online" ? "online" : "offline",
          lastIp: String(row?.lastIp ?? "").trim() || undefined,
          localLlmEnabled: row?.rule?.localLlmEnabled === true,
          localLlmBaseUrl: String(row?.rule?.localLlmBaseUrl ?? "").trim() || undefined,
        }))
        .filter((row: TrainingWorkerOption) => !!row.name)
        .sort((a: TrainingWorkerOption, b: TrainingWorkerOption) => a.name.localeCompare(b.name));
      trainingWorkers = mapped;
      if (trainingTargetWorkerName && !mapped.some((w: TrainingWorkerOption) => w.name === trainingTargetWorkerName)) {
        trainingTargetWorkerName = "";
      }
    } catch {
      trainingWorkers = [];
    } finally {
      trainingWorkersLoading = false;
    }
  }

  async function loadTrainingSchedule() {
    if (!isAdmin) return;
    const result = await api.settings.getCoordinatorTrainingSchedule();
    const schedule = result?.schedule ?? {};
    const progs = Array.isArray(schedule?.programs)
      ? normalizeProgramList(schedule.programs as unknown[])
      : [];
    trainingSchedule = {
      enabled: schedule?.enabled === true,
      intervalMinutes: Number.isFinite(Number(schedule?.intervalMinutes))
        ? Math.max(5, Number(schedule.intervalMinutes))
        : 24 * 60,
      apply: schedule?.apply !== false,
      programs: progs,
    };
    trainingLastRunByProgram = result?.lastRunByProgram && typeof result.lastRunByProgram === "object"
      ? result.lastRunByProgram as Record<string, string>
      : {};
    trainingNextRunByProgram = result?.nextRunByProgram && typeof result.nextRunByProgram === "object"
      ? result.nextRunByProgram as Record<string, string | null>
      : {};
    trainingKnownPrograms = Array.isArray(result?.knownPrograms) ? result.knownPrograms : [];
  }

  async function loadHousekeepingSchedule() {
    if (!isAdmin) return;
    try {
      const result = await api.settings.getHousekeepingSchedule();
      if (result) {
        housekeepingSchedule = {
          enabled: result.enabled !== false,
          intervalMinutes: Number.isFinite(Number(result.intervalMinutes))
            ? Math.max(5, Number(result.intervalMinutes))
            : 24 * 60,
          lastRunAt: result.lastRunAt,
        };
      }
    } catch { /* ignore */ }
  }

  async function saveMaintenanceSettings() {
    maintenanceSaving = true;
    try {
      await Promise.all([
        api.settings.setHousekeepingSchedule({
          enabled: housekeepingSchedule.enabled,
          intervalMinutes: housekeepingSchedule.intervalMinutes,
        }),
        api.settings.setCoordinatorTrainingSchedule({
          enabled: trainingSchedule.enabled,
          intervalMinutes: trainingSchedule.intervalMinutes,
          apply: trainingSchedule.apply,
          programs: trainingSchedule.programs,
        }),
      ]);
      await Promise.all([loadHousekeepingSchedule(), loadTrainingSchedule()]);
    } catch (err) {
      console.error("Failed to save maintenance settings:", err);
    } finally {
      maintenanceSaving = false;
    }
  }

  async function runHousekeepingNow() {
    if (housekeepingRunning) return;
    housekeepingRunning = true;
    error = "";
    info = "";
    try {
      await api.settings.runHousekeepingNow();
      info = "Housekeeping job queued.";
    } catch (err: any) {
      error = `Housekeeping failed: ${err.message ?? err}`;
    } finally {
      housekeepingRunning = false;
    }
  }

  function clearTrainingInputs() {
    trainingInputPath = "";
    trainingSourcePaths = [];
    trainingPrompt = "";
    trainingLevel = "medium";
    trainingUploadFiles = [];
    trainingUploadInputResetKey += 1;
  }

  async function addTrainingFolder() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: "Select source folder(s)",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newPaths = paths.map((p) => String(p).trim()).filter(Boolean);
      trainingSourcePaths = [...new Set([...trainingSourcePaths, ...newPaths])];
    } catch (err) {
      console.warn("Folder picker failed:", err);
    }
  }

  async function addTrainingFiles() {
    try {
      const selected = await openDialog({
        directory: false,
        multiple: true,
        title: "Select source file(s)",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newPaths = paths.map((p) => String(p).trim()).filter(Boolean);
      trainingSourcePaths = [...new Set([...trainingSourcePaths, ...newPaths])];
    } catch (err) {
      console.warn("File picker failed:", err);
    }
  }

  function removeTrainingPath(path: string) {
    trainingSourcePaths = trainingSourcePaths.filter((p) => p !== path);
  }

  function addManualTrainingPath() {
    const trimmed = trainingInputPath.trim();
    if (!trimmed) return;
    if (!trainingSourcePaths.includes(trimmed)) {
      trainingSourcePaths = [...trainingSourcePaths, trimmed];
    }
    trainingInputPath = "";
  }

  async function queueTrainingJobForProgram() {
    if (!canQueueTraining) return;
    trainingJobStarting = true;
    error = "";
    info = "";
    try {
      const extraPath = trainingInputPath.trim();
      const trimmedPrompt = trainingPrompt.trim();
      const trimmedTargetWorkerName = trainingTargetWorkerName.trim();
      const applyTrainedUpdates = isAdmin ? trainingSchedule.apply : false;
      const allPaths = [...trainingSourcePaths];
      if (extraPath && !allPaths.includes(extraPath)) allPaths.push(extraPath);
      const sourcePaths = allPaths;
      const relativeUploadPaths = trainingUploadFiles.map((file) =>
        String((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").trim(),
      );
      const hasFiles = trainingUploadFiles.length > 0;
      const result = hasFiles
        ? await api.settings.queueCoordinatorTrainingJob(
            program,
            sourcePaths,
            applyTrainedUpdates,
            trainingUploadFiles,
            relativeUploadPaths,
            trainingAgentConfigId.trim(),
            trimmedPrompt,
            trimmedTargetWorkerName,
            trainingLevel,
          )
        : await api.settings.runCoordinatorTrainingNow({
            sourcePaths: sourcePaths.length > 0 ? sourcePaths : undefined,
            apply: applyTrainedUpdates,
            prompt: trimmedPrompt || undefined,
            targetWorkerName: trimmedTargetWorkerName || undefined,
            trainingLevel: trainingLevel || undefined,
            excludeWorker: trainingExcludeSelf ? getLocalWorkerName() || undefined : undefined,
          });
      const jobId = String(result?.job?.id ?? result?.orchestratorJobId ?? "");
      const uploadedCount = Array.isArray(result?.input?.uploadedFiles) ? result.input.uploadedFiles.length : 0;
      const resolvedSourcePathCount = Array.isArray(result?.input?.sourcePaths) ? result.input.sourcePaths.length : sourcePaths.length;
      const uploadSessionVaultPath = String(result?.input?.uploadSessionVaultPath ?? "").trim();
      const resolvedAgentConfigId = String(result?.input?.agentConfigId ?? "").trim();
      const resolvedTargetWorkerName = String(result?.input?.targetWorkerName ?? trimmedTargetWorkerName).trim();
      const resolvedTrainingPrompt = String(result?.input?.trainingPrompt ?? trimmedPrompt).trim();
      const uploadedSuffix = uploadedCount > 0 ? ` (${uploadedCount} uploaded input${uploadedCount === 1 ? "" : "s"})` : "";
      const programLabel = hasFiles ? program : "auto-detect";
      info = jobId
        ? `Queued maintenance job ${jobId.slice(0, 8)} (${programLabel})${uploadedSuffix}.`
        : `Queued maintenance job (${programLabel})${uploadedSuffix}.`;
      if (jobId) {
        trainingLastQueued = {
          jobId,
          sourcePathCount: resolvedSourcePathCount,
          uploadedCount,
          agentConfigId: resolvedAgentConfigId,
          targetWorkerName: resolvedTargetWorkerName,
          trainingPrompt: resolvedTrainingPrompt,
          uploadSessionVaultPath,
          queuedAt: new Date().toISOString(),
        };
      }
      clearTrainingInputs();
      if (isAdmin) await loadTrainingSchedule();
    } catch (err: any) {
      error = `Queue maintenance job failed: ${err.message ?? err}`;
    } finally {
      trainingJobStarting = false;
    }
  }

  function onProgramChanged(nextProgram: string) {
    program = nextProgram;
  }

  let initialized = false;
  $effect(() => {
    if (!canManage || initialized) return;
    initialized = true;
    void refreshAll();
  });

  async function refreshAll() {
    loading = true;
    error = "";
    info = "";
    try {
      await loadPrograms();
      if (isAdmin) {
        await Promise.all([
          loadTrainingAgentOptions(),
          loadTrainingWorkerOptions(),
        ]);
        await Promise.all([loadTrainingSchedule(), loadHousekeepingSchedule()]);
      } else {
        trainingLastRunByProgram = {};
        trainingNextRunByProgram = {};
        await Promise.all([
          loadTrainingAgentOptions(),
          loadTrainingWorkerOptions(),
        ]);
      }
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="training-page">
  <h2>Training</h2>
  {#if !canManage}
    <div class="panel">
      <p>You don't have permission to manage training resources.</p>
    </div>
  {:else}
    <div class="toolbar-bar">
      <div class="toolbar-row">
        <div class="tabs">
          <button class="tab" class:active={scopeTab === "training"} onclick={() => { scopeTab = "training"; }}>
            Training
          </button>
          {#if isAdmin}
            <button class="tab" class:active={scopeTab === "maintenance"} onclick={() => { scopeTab = "maintenance"; loadHousekeepingSchedule(); loadTrainingSchedule(); }}>
              Maintenance
            </button>
          {/if}
        </div>
        {#if scopeTab === "training"}
          <div class="toolbar-select">
            <label>
              Bridge
              <select value={program} onchange={(e) => onProgramChanged((e.target as HTMLSelectElement).value)}>
                {#each programs as p}
                  <option value={p.value}>{p.label}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
        <button class="btn secondary" onclick={refreshAll} disabled={loading}>Refresh</button>
      </div>
    </div>

    {#if error}<div class="error">{error}</div>{/if}
    {#if info}<div class="info">{info}</div>{/if}

    {#if scopeTab === "training"}
      <section class="panel training-dashboard-panel">
        <h3>Training</h3>
        <p class="desc">
          Queue a training job from source paths and/or attached files to teach the coordinator new patterns.
        </p>
        {#if !canQueueTraining}
          <p class="mini">
            {trainingQueueBlockedReason || "Training controls are unavailable for this account."}
          </p>
        {:else if !isAdmin}
          <p class="mini">
            Non-admin runs are always queued with auto-apply disabled.
          </p>
        {/if}
        <div class="training-source-paths">
          <div class="source-paths-header">
            <span class="label">Source Paths</span>
            <button class="btn secondary btn-sm" onclick={addTrainingFolder}>
              Add Folder
            </button>
            <button class="btn secondary btn-sm" onclick={addTrainingFiles}>
              Add Files
            </button>
          </div>
          {#if trainingSourcePaths.length > 0}
            <div class="source-paths-list">
              {#each trainingSourcePaths as path}
                <div class="source-path-item">
                  <span class="mono path-text" title={path}>{path}</span>
                  <button class="btn-remove" onclick={() => removeTrainingPath(path)} title="Remove">✕</button>
                </div>
              {/each}
            </div>
          {/if}
          <div class="source-path-manual">
            <input
              type="text"
              bind:value={trainingInputPath}
              placeholder="Or type a path and press Enter"
              onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManualTrainingPath(); } }}
            />
          </div>
        </div>
        {#if canQueueTraining}
          <label>
            Agent / Model
            <select bind:value={trainingAgentConfigId}>
              {#if analyzeAgents.length === 0}
                <option value="">No agents available</option>
              {:else}
                <option value="">Server default</option>
                {#each analyzeAgents as agent}
                  <option value={agent.id}>{agent.name}{agent.model ? ` (${agent.model})` : ""}</option>
                {/each}
              {/if}
            </select>
          </label>
          <label>
            Worker
            <select bind:value={trainingTargetWorkerName}>
              <option value="">Auto (pick best available)</option>
              {#each trainingWorkers as worker}
                <option value={worker.name}>
                  {worker.name}
                  {worker.status === "online" ? " · online" : " · offline"}
                  {worker.localLlmEnabled ? " · local LLM" : ""}
                </option>
              {/each}
            </select>
            <span class="mini">
              {trainingWorkersLoading
                ? "Loading workers..."
                : "Auto selects the best available worker with the right bridges and licenses."}
            </span>
            <label class="toggle" style="margin-top: 4px;">
              <input type="checkbox" bind:checked={trainingExcludeSelf} />
              <span>Don't use my machine (only dispatch to other workers)</span>
            </label>
          </label>
        {/if}
        <label>
          Analysis Level
          <select bind:value={trainingLevel}>
            <option value="low">Low — Quick filesystem scan (~2-5 min, ~$0.50-$1)</option>
            <option value="medium">Medium — Standard analysis (~5-15 min, ~$1-$3)</option>
            <option value="high">High — Deep exhaustive analysis (~15-45 min, ~$3-$8)</option>
          </select>
          <span class="help-text">
            {trainingLevel === "low" ? "Filesystem-only scan. No bridge tools used. Good for bulk scanning many projects."
              : trainingLevel === "high" ? "Full node tree inspection with all parameters. Extended timeout. Best for detailed recreation guides."
              : "Standard bridge-based analysis. Inspects top-level nodes and key parameters."}
          </span>
        </label>
        <label>
          Objective (optional)
          <textarea
            rows="4"
            bind:value={trainingPrompt}
            spellcheck="false"
            placeholder="Describe what the agent should understand or extract from these files."
          ></textarea>
        </label>
        {#if trainingUploadFiles.length > 0}
          <div class="source-item training-selection">
            <strong>Selected Uploads</strong>
            <div class="mini">{trainingUploadFiles.length} file{trainingUploadFiles.length === 1 ? "" : "s"}</div>
            <div class="mini mono">
              {trainingUploadFiles.slice(0, 4).map((file) => file.name).join(", ")}
              {#if trainingUploadFiles.length > 4}...{/if}
            </div>
          </div>
        {/if}
        {#if isAdmin}
          <label class="toggle">
            <input
              type="checkbox"
              checked={trainingSchedule.apply}
              onchange={(e) =>
                (trainingSchedule = {
                  ...trainingSchedule,
                  apply: (e.target as HTMLInputElement).checked,
                })}
            />
            <span>Write to playbook/script files</span>
          </label>
        {/if}
        <div class="actions">
          <button class="btn secondary" onclick={queueTrainingJobForProgram} disabled={trainingJobStarting || !canQueueTraining}>
            {trainingJobStarting ? "Queueing..." : "Run Training"}
          </button>
          <button class="btn secondary" onclick={clearTrainingInputs} disabled={trainingJobStarting}>
            Clear Inputs
          </button>
        </div>
        <p class="mini">
          Current run scope:
          {trainingInputPath.trim() ? " 1 source path" : " no source path"}
          {trainingUploadFiles.length > 0
            ? ` + ${trainingUploadFiles.length} uploaded input${trainingUploadFiles.length === 1 ? "" : "s"}`
            : ""}.
        </p>
        {#if trainingLastQueued}
          <div class="source-item training-last-queued">
            <strong>Last Queued Training Job</strong>
            <div class="mini mono">{trainingLastQueued.jobId}</div>
            <div class="mini">
              {trainingLastQueued.sourcePathCount} source path{trainingLastQueued.sourcePathCount === 1 ? "" : "s"},
              {trainingLastQueued.uploadedCount} uploaded input{trainingLastQueued.uploadedCount === 1 ? "" : "s"}.
            </div>
            {#if trainingLastQueued.agentConfigId}
              <div class="mini">Agent: {formatAnalyzeAgentLabel(trainingLastQueued.agentConfigId)}</div>
            {/if}
            {#if trainingLastQueued.targetWorkerName}
              <div class="mini">Target worker: {trainingLastQueued.targetWorkerName}</div>
            {/if}
            {#if trainingLastQueued.uploadSessionVaultPath}
              <div class="mini mono">{trainingLastQueued.uploadSessionVaultPath}</div>
            {/if}
            {#if trainingLastQueued.trainingPrompt}
              <div class="mini">{trainingLastQueued.trainingPrompt}</div>
            {/if}
            <div class="mini">Queued at {formatDateTime(trainingLastQueued.queuedAt)}</div>
          </div>
        {/if}
      </section>

    {:else if scopeTab === "maintenance"}
      <section class="panel maintenance-panel">
        <h3>Maintenance</h3>
        <p class="desc">
          Schedule and run housekeeping and training jobs automatically.
        </p>

        <div class="maintenance-section">
          <h4>Housekeeping Schedule</h4>
          <p class="mini">Housekeeping reviews recent job results and refines skills automatically.</p>
          <label class="toggle">
            <input
              type="checkbox"
              checked={housekeepingSchedule.enabled}
              onchange={(e) =>
                (housekeepingSchedule = {
                  ...housekeepingSchedule,
                  enabled: (e.target as HTMLInputElement).checked,
                })}
            />
            <span>Enable scheduled housekeeping</span>
          </label>
          <label>
            Interval (minutes)
            <input
              type="number"
              min="5"
              max="10080"
              value={housekeepingSchedule.intervalMinutes}
              oninput={(e) =>
                (housekeepingSchedule = {
                  ...housekeepingSchedule,
                  intervalMinutes: Math.max(5, Number((e.target as HTMLInputElement).value) || 1440),
                })}
            />
            <span class="mini">
              {housekeepingSchedule.intervalMinutes >= 1440
                ? `Every ${(housekeepingSchedule.intervalMinutes / 1440).toFixed(1).replace(/\.0$/, "")} day${housekeepingSchedule.intervalMinutes >= 2880 ? "s" : ""}`
                : housekeepingSchedule.intervalMinutes >= 60
                  ? `Every ${(housekeepingSchedule.intervalMinutes / 60).toFixed(1).replace(/\.0$/, "")} hour${housekeepingSchedule.intervalMinutes >= 120 ? "s" : ""}`
                  : `Every ${housekeepingSchedule.intervalMinutes} minutes`}
            </span>
          </label>
          {#if housekeepingSchedule.lastRunAt}
            <p class="mini">Last run: {formatDateTime(housekeepingSchedule.lastRunAt)}</p>
          {/if}
          <div class="actions" style="margin-top: 8px;">
            <button class="btn secondary" onclick={runHousekeepingNow} disabled={housekeepingRunning}>
              {housekeepingRunning ? "Running..." : "Run Housekeeping Now"}
            </button>
          </div>
        </div>

        <div class="maintenance-section">
          <h4>Training Schedule</h4>
          <p class="mini">Automatically run training on a recurring interval.</p>
          <label class="toggle">
            <input
              type="checkbox"
              checked={trainingSchedule.enabled}
              onchange={(e) =>
                (trainingSchedule = {
                  ...trainingSchedule,
                  enabled: (e.target as HTMLInputElement).checked,
                })}
            />
            <span>Enable scheduled training</span>
          </label>
          <label>
            Interval (minutes)
            <input
              type="number"
              min="5"
              max="10080"
              value={trainingSchedule.intervalMinutes}
              oninput={(e) =>
                (trainingSchedule = {
                  ...trainingSchedule,
                  intervalMinutes: Math.max(5, Number((e.target as HTMLInputElement).value) || 1440),
                })}
            />
            <span class="mini">
              {trainingSchedule.intervalMinutes >= 1440
                ? `Every ${(trainingSchedule.intervalMinutes / 1440).toFixed(1).replace(/\.0$/, "")} day${trainingSchedule.intervalMinutes >= 2880 ? "s" : ""}`
                : trainingSchedule.intervalMinutes >= 60
                  ? `Every ${(trainingSchedule.intervalMinutes / 60).toFixed(1).replace(/\.0$/, "")} hour${trainingSchedule.intervalMinutes >= 120 ? "s" : ""}`
                  : `Every ${trainingSchedule.intervalMinutes} minutes`}
            </span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              checked={trainingSchedule.apply}
              onchange={(e) =>
                (trainingSchedule = {
                  ...trainingSchedule,
                  apply: (e.target as HTMLInputElement).checked,
                })}
            />
            <span>Auto-apply to playbook/script files</span>
          </label>
          {#if trainingKnownPrograms.length > 0}
            <div class="program-checkboxes">
              <span class="label">Programs</span>
              {#each trainingKnownPrograms as prog}
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={trainingSchedule.programs.includes(prog)}
                    onchange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      trainingSchedule = {
                        ...trainingSchedule,
                        programs: checked
                          ? [...trainingSchedule.programs, prog]
                          : trainingSchedule.programs.filter((p) => p !== prog),
                      };
                    }}
                  />
                  <span>{prog}</span>
                </label>
              {/each}
            </div>
          {/if}
          {#each Object.entries(trainingLastRunByProgram) as [prog, ts]}
            <p class="mini">Last run ({prog}): {formatDateTime(ts)}</p>
          {/each}
          {#each Object.entries(trainingNextRunByProgram) as [prog, ts]}
            {#if ts}
              <p class="mini">Next run ({prog}): {formatDateTime(ts)}</p>
            {/if}
          {/each}
        </div>

        <div class="actions" style="margin-top: 16px;">
          <button class="btn primary" onclick={saveMaintenanceSettings} disabled={maintenanceSaving}>
            {maintenanceSaving ? "Saving..." : "Save Schedules"}
          </button>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .training-page {
    padding: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  h2 { font-size: var(--font-size-lg); margin-bottom: 12px; }
  h3 { font-size: var(--font-size-base); margin-bottom: 8px; color: var(--text-secondary); }
  h4 { margin: 0; font-size: var(--font-size-base); color: var(--fg); }

  .toolbar-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .toolbar-select { min-width: 140px; }
  .toolbar-select label {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }
  .toolbar-select select { width: auto; min-width: 120px; }

  .panel { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); padding: 12px; margin-bottom: 12px; }
  .desc { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4; }
  .mini { font-size: 11px; color: var(--text-muted); }
  .mono { font-family: var(--font-mono); word-break: break-all; }
  .error { margin-bottom: 10px; color: var(--status-failed); font-size: var(--font-size-sm); }
  .info { margin-bottom: 10px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .btn { padding: 6px 12px; border-radius: var(--radius-sm); background: var(--accent); color: #fff; border: none; }
  .btn.secondary { border: 1px solid var(--border); background: var(--bg-base); color: var(--text-secondary); }
  .btn.primary { background: var(--accent); color: #fff; border: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .tab { border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-secondary); border-radius: var(--radius-sm); padding: 6px 10px; }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .toggle {
    display: flex; flex-direction: row; gap: 10px; align-items: flex-start;
    color: var(--text-primary); font-size: var(--font-size-sm); margin-top: 8px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-base);
  }
  .toggle input { flex-shrink: 0; margin: 0; margin-top: 2px; }
  .toggle span { color: var(--text-secondary); }
  label { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); color: var(--text-secondary); }
  textarea, input:not([type="checkbox"]):not([type="radio"]), select {
    width: 100%; background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px;
  }
  input[type="checkbox"] { width: auto; padding: 0; }
  textarea { font-family: var(--font-mono); line-height: 1.45; resize: both; max-width: 100%; min-height: 96px; }

  .training-dashboard-panel { display: grid; gap: 8px; }
  .maintenance-panel { display: grid; gap: 12px; }
  .maintenance-section { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
  .program-checkboxes { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .program-checkboxes .label { font-size: var(--font-size-sm); color: var(--fg-muted); }

  .training-source-paths { margin-bottom: 8px; }
  .source-paths-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .source-paths-header .label { font-size: var(--font-size-sm); color: var(--text-secondary); font-weight: 500; }
  .btn-sm { padding: 3px 10px; font-size: var(--font-size-xs); }
  .source-paths-list { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
  .source-path-item {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--font-size-xs);
  }
  .path-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-remove { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0 4px; font-size: 12px; line-height: 1; }
  .btn-remove:hover { color: var(--danger); }
  .source-path-manual input { width: 100%; font-size: var(--font-size-sm); }
  .source-item {
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px;
    font-size: var(--font-size-sm); color: var(--text-secondary); background: var(--bg-base);
  }
  .training-selection, .training-last-queued { margin-top: 4px; }
  .help-text { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

  @media (max-width: 1024px) {
    .toolbar-bar { flex-direction: column; align-items: flex-start; }
  }
</style>
