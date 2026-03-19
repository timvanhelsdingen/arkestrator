<script lang="ts">
  import { connection } from "../lib/stores/connection.svelte";
  import { api } from "../lib/api/rest";

  type ScopeTab = "server" | "training" | "client";
  type AnalyzeStatus = "queued" | "running" | "completed" | "failed";
  type AnalyzeMode = "fast" | "ai";

  interface SourceEntry {
    path: string;
    name?: string;
    programs?: string[];
  }

  interface ProjectSummary {
    projectPath: string;
    configPath: string;
    notesPath?: string;
    existed: boolean;
    created: boolean;
    updated: boolean;
    promptPreview: string;
  }

  interface AnalyzeJob {
    id: string;
    program: string;
    path: string;
    mode?: AnalyzeMode;
    status: AnalyzeStatus;
    overwritePrompt: boolean;
    createIfMissing: boolean;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    result?: {
      projects?: ProjectSummary[];
      projectCount?: number;
      existingConfigCount?: number;
      createdCount?: number;
      updatedCount?: number;
      paths?: string[];
      names?: Record<string, string>;
      entries?: SourceEntry[];
    };
  }

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

  interface ProgramHeadlessStatus {
    enabled: boolean;
    executable: string;
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

  let programs = $state<Array<{ value: string; label: string }>>([
    { value: "global", label: "Global" },
  ]);

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
      ? "Enable client-side coordination in your user settings to queue training jobs."
      : "",
  );

  let program = $state<string>("houdini");
  let scopeTab = $state<ScopeTab>("server");
  type ScriptEditorTarget = "global" | "bridge" | null;
  let scriptEditorTarget = $state<ScriptEditorTarget>(null);
  let scriptEditorDraft = $state("");
  let loading = $state(false);
  let error = $state("");
  let info = $state("");

  // Scripts (admin)
  let globalScript = $state("");
  let bridgeScript = $state("");
  let scriptsSaving = $state(false);
  let trainingJobStarting = $state(false);
  let trainingInputPath = $state("");
  let trainingAgentConfigId = $state("");
  let trainingTargetWorkerName = $state("");
  let trainingPrompt = $state("");
  let trainingUploadFiles = $state<File[]>([]);
  let trainingUploadInputResetKey = $state(0);
  let trainingWorkers = $state<TrainingWorkerOption[]>([]);
  let trainingWorkersLoading = $state(false);
  let trainingLastQueued = $state<TrainingQueueSummary | null>(null);
  let trainingScheduleSaving = $state(false);
  let trainingSchedule = $state<CoordinatorTrainingSchedule>({
    enabled: false,
    intervalMinutes: 24 * 60,
    apply: true,
    programs: [],
  });
  let trainingLastRunByProgram = $state<Record<string, string>>({});
  let trainingNextRunByProgram = $state<Record<string, string | null>>({});

  // Server source entries (admin)
  let serverSources = $state<SourceEntry[]>([]);
  let serverSourcesAll = $state<SourceEntry[]>([]);
  let serverSourceNameDrafts = $state<Record<string, string>>({});
  let newServerSourcePath = $state("");
  let newServerSourceName = $state("");
  let sourceSaving = $state(false);
  let analyzeJobStarting = $state(false);
  let analyzeMode = $state<AnalyzeMode>("ai");
  let savedAnalyzeMode = $state<AnalyzeMode>("ai");
  let analyzeJobs = $state<AnalyzeJob[]>([]);
  const consumedAnalyzeJobs = new Set<string>();
  const serverSourcePaths = $derived(serverSources.map((s) => s.path));
  let expandedServerSourceRows = $state<Record<string, boolean>>({});
  let analyzeSettingsSaving = $state(false);
  let analyzeAgents = $state<AgentConfigOption[]>([]);
  let analyzeAgentConfigId = $state("");
  let savedAnalyzeAgentConfigId = $state("");
  let analyzeAgentEffectiveId = $state("");
  const analyzeSettingsDirty = $derived(
    analyzeMode !== savedAnalyzeMode ||
    analyzeAgentConfigId.trim() !== savedAnalyzeAgentConfigId.trim(),
  );
  let readinessLoading = $state(false);
  let readinessProbing = $state(false);
  let readinessOutput = $state("");
  let bridgeOnlineCounts = $state<Record<string, number>>({});
  let headlessStatusByProgram = $state<Record<string, ProgramHeadlessStatus>>({});

  // Project configs
  let projects = $state<ProjectSummary[]>([]);
  let selectedProjectConfigPath = $state("");
  let selectedProjectName = $state("");
  let selectedProjectPrompt = $state("");
  let selectedProjectSaving = $state(false);
  let selectedProjectLoading = $state(false);
  let selectedProjectRawMode = $state(false);
  let selectedProjectRawText = $state("");
  let selectedProjectRawLoading = $state(false);
  let selectedProjectRawSaving = $state(false);

  // Local client prompt overrides
  const CLIENT_PROMPT_OVERRIDES_STORAGE_KEY = "arkestrator-coordinator-client-prompt-overrides-v1";
  const ANALYZE_MODE_STORAGE_KEY = "arkestrator-coordinator-analyze-mode-v1";
  let clientPromptOverrideGlobal = $state("");
  let clientPromptOverrideBridge = $state("");

  function loadAnalyzeModeFromStorage() {
    try {
      const raw = String(localStorage.getItem(ANALYZE_MODE_STORAGE_KEY) ?? "").trim().toLowerCase();
      if (raw === "fast" || raw === "ai") analyzeMode = raw as AnalyzeMode;
    } catch {
      // ignore storage errors
    }
    savedAnalyzeMode = analyzeMode;
  }

  function persistAnalyzeModeToStorage(mode: AnalyzeMode) {
    try {
      localStorage.setItem(ANALYZE_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore storage errors
    }
  }

  function setAnalyzeMode(next: AnalyzeMode) {
    analyzeMode = next;
  }

  function toEntries(payload: any): SourceEntry[] {
    if (Array.isArray(payload?.entries)) {
      const out: SourceEntry[] = [];
      for (const item of payload.entries) {
        const path = String(item?.path ?? "").trim();
        const name = String(item?.name ?? "").trim();
        const programs = Array.isArray(item?.programs)
          ? normalizeProgramList(item.programs as unknown[])
          : [];
        if (!path) continue;
        if (name && programs.length > 0) out.push({ path, name, programs });
        else if (name) out.push({ path, name });
        else if (programs.length > 0) out.push({ path, programs });
        else out.push({ path });
      }
      return dedupeEntries(out);
    }
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    const namesObj = payload?.names && typeof payload.names === "object" ? payload.names : {};
    const programsObj = payload?.programs && typeof payload.programs === "object" ? payload.programs : {};
    const out: SourceEntry[] = [];
    for (const p of paths) {
      const path = String(p ?? "").trim();
      if (!path) continue;
      const name = String((namesObj as any)?.[path] ?? "").trim();
      const programs = Array.isArray((programsObj as any)?.[path])
        ? normalizeProgramList((programsObj as any)[path] as unknown[])
        : [];
      if (name && programs.length > 0) out.push({ path, name, programs });
      else if (name) out.push({ path, name });
      else if (programs.length > 0) out.push({ path, programs });
      else out.push({ path });
    }
    return dedupeEntries(out);
  }

  function dedupeEntries(entries: SourceEntry[]): SourceEntry[] {
    const seen = new Set<string>();
    const out: SourceEntry[] = [];
    for (const entry of entries) {
      const path = String(entry.path ?? "").trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const name = String(entry.name ?? "").trim();
      const programs = Array.isArray(entry.programs)
        ? normalizeProgramList(entry.programs as unknown[])
        : [];
      if (name && programs.length > 0) out.push({ path, name, programs });
      else if (name) out.push({ path, name });
      else if (programs.length > 0) out.push({ path, programs });
      else out.push({ path });
    }
    return out;
  }

  function syncServerSources(payload: any) {
    serverSources = toEntries(payload);
    const drafts: Record<string, string> = {};
    for (const source of serverSources) drafts[source.path] = source.name ?? "";
    serverSourceNameDrafts = drafts;
    const nextExpanded: Record<string, boolean> = {};
    for (const source of serverSources) {
      nextExpanded[source.path] = expandedServerSourceRows[source.path] ?? false;
    }
    expandedServerSourceRows = nextExpanded;
  }

  function sourcePathLabel(path: string): string {
    const trimmed = path.trim().replace(/\\/g, "/");
    const parts = trimmed.split("/").filter(Boolean);
    return parts[parts.length - 1] || trimmed;
  }

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

  async function loadServerSources() {
    if (!isAdmin) return;
    const [scopedResult, allResult] = await Promise.all([
      api.settings.getCoordinatorPlaybookSources(program),
      api.settings.getCoordinatorPlaybookSources(),
    ]);
    syncServerSources(scopedResult);
    serverSourcesAll = toEntries(allResult);
  }

  function loadClientPromptOverrides() {
    let global = "";
    let byProgram: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const globalRaw = String(parsed?.global ?? "").trim();
        if (globalRaw) global = globalRaw;
        const byProgramRaw = parsed?.byProgram;
        if (byProgramRaw && typeof byProgramRaw === "object" && !Array.isArray(byProgramRaw)) {
          const out: Record<string, string> = {};
          for (const [key, value] of Object.entries(byProgramRaw as Record<string, unknown>)) {
            const programKey = normalizeProgramKey(key);
            const text = String(value ?? "").trim();
            if (!programKey || !text) continue;
            out[programKey] = text;
          }
          byProgram = out;
        }
      }
    } catch {
      global = "";
      byProgram = {};
    }
    clientPromptOverrideGlobal = global;
    clientPromptOverrideBridge = byProgram[normalizeProgramKey(program)] ?? "";
  }

  function saveClientPromptOverrides() {
    const programKey = normalizeProgramKey(program);
    const global = clientPromptOverrideGlobal.trim();
    const bridgeOverride = clientPromptOverrideBridge.trim();
    let byProgram: Record<string, string> = {};

    try {
      const raw = localStorage.getItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const existingByProgram = parsed?.byProgram;
        if (existingByProgram && typeof existingByProgram === "object" && !Array.isArray(existingByProgram)) {
          for (const [key, value] of Object.entries(existingByProgram as Record<string, unknown>)) {
            const keyNormalized = normalizeProgramKey(key);
            const text = String(value ?? "").trim();
            if (!keyNormalized || !text) continue;
            byProgram[keyNormalized] = text;
          }
        }
      }
    } catch {
      byProgram = {};
    }

    if (bridgeOverride) byProgram[programKey] = bridgeOverride;
    else delete byProgram[programKey];

    const payload: Record<string, unknown> = {};
    if (global) payload.global = global;
    if (Object.keys(byProgram).length > 0) payload.byProgram = byProgram;
    localStorage.setItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY, JSON.stringify(payload));
    clientPromptOverrideGlobal = global;
    clientPromptOverrideBridge = byProgram[programKey] ?? "";
  }

  function setServerSourceNameDraft(path: string, name: string) {
    serverSourceNameDrafts = { ...serverSourceNameDrafts, [path]: name };
  }

  function mergeAnalyzeJobs(jobs: AnalyzeJob[]) {
    const map = new Map<string, AnalyzeJob>();
    for (const job of analyzeJobs) map.set(job.id, job);
    for (const job of jobs) map.set(job.id, job);
    analyzeJobs = [...map.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  function toggleServerSourceRow(path: string) {
    expandedServerSourceRows = {
      ...expandedServerSourceRows,
      [path]: !expandedServerSourceRows[path],
    };
  }

  function getBridgeOnlineCount(p: string): number {
    return Number(bridgeOnlineCounts[normalizeProgramKey(p)] ?? 0);
  }

  function getHeadlessStatus(p: string): ProgramHeadlessStatus | null {
    return headlessStatusByProgram[normalizeProgramKey(p)] ?? null;
  }

  function fallbackModeLabel(p: string): string {
    if (p === "comfyui") return "ComfyUI HTTP API";
    const status = getHeadlessStatus(p);
    return status?.enabled ? "Headless CLI" : "None";
  }

  function isTrainingScheduledForProgram(p: string): boolean {
    return trainingSchedule.programs.includes(normalizeProgramKey(p));
  }

  function toggleTrainingProgram(p: string, enabled: boolean) {
    const target = normalizeProgramKey(p);
    const next = new Set(trainingSchedule.programs.map((value) => normalizeProgramKey(value)));
    if (enabled) next.add(target);
    else next.delete(target);
    trainingSchedule = {
      ...trainingSchedule,
      programs: [...next],
    };
  }

  function formatDateTime(iso: string | null | undefined): string {
    const value = String(iso ?? "").trim();
    if (!value) return "Not scheduled";
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return "Invalid date";
    return new Date(ts).toLocaleString();
  }

  async function loadExecutionReadiness() {
    if (!canManage) return;
    readinessLoading = true;
    try {
      const [bridgesRes, headlessRes] = await Promise.all([
        api.bridgeCommands.listBridges(),
        api.headlessPrograms.list(),
      ]);
      const bridgeCounts: Record<string, number> = {};
      for (const bridge of Array.isArray(bridgesRes?.bridges) ? bridgesRes.bridges : []) {
        const key = normalizeProgramKey(String((bridge as any)?.program ?? ""));
        if (!key) continue;
        bridgeCounts[key] = (bridgeCounts[key] ?? 0) + 1;
      }
      bridgeOnlineCounts = bridgeCounts;

      const nextHeadless: Record<string, ProgramHeadlessStatus> = {};
      for (const item of Array.isArray(headlessRes) ? headlessRes : []) {
        const key = normalizeProgramKey(String((item as any)?.program ?? ""));
        if (!key) continue;
        nextHeadless[key] = {
          enabled: !!(item as any)?.enabled,
          executable: String((item as any)?.executable ?? ""),
        };
      }
      headlessStatusByProgram = nextHeadless;

      // If programs list hasn't been populated by loadScripts (admin-only), derive from bridges + headless
      if (programs.length <= 1) {
        const knownKeys = new Set<string>();
        for (const key of Object.keys(bridgeCounts)) if (key) knownKeys.add(key);
        for (const key of Object.keys(nextHeadless)) if (key) knownKeys.add(key);
        knownKeys.add("global");
        const derived = [...knownKeys]
          .sort()
          .map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
        programs = derived;
      }
    } catch {
      // non-fatal
    } finally {
      readinessLoading = false;
    }
  }

  async function runExecutionProbe() {
    if (!canManage) return;
    readinessProbing = true;
    error = "";
    info = "";
    readinessOutput = "";
    try {
      let result: any;
      if (program === "comfyui") {
        result = await api.bridgeCommands.execute(program, [
          {
            language: "workflow",
            description: "Coordinator probe: tiny image workflow",
            script: JSON.stringify({
              "1": {
                inputs: { width: 256, height: 144, batch_size: 1, color: 4474111 },
                class_type: "EmptyImage",
              },
              "2": {
                inputs: { images: ["1", 0], filename_prefix: "agent_manager/coordinator_probe" },
                class_type: "SaveImage",
              },
            }),
          },
        ]);
      } else {
        const script = program === "godot"
          ? "print(\"COORDINATOR_PROBE_OK\")"
          : `print("COORDINATOR_PROBE_${program.toUpperCase()}_OK")`;
        const language = program === "godot" ? "gdscript" : "python";
        result = await api.bridgeCommands.execute(program, [{ language, script, description: "Coordinator probe" }]);
      }

      readinessOutput = JSON.stringify(result, null, 2);
      info = `Probe completed for ${program}.`;
      await loadExecutionReadiness();
    } catch (err: any) {
      readinessOutput = String(err?.message ?? err);
      error = `Probe failed for ${program}: ${err?.message ?? err}`;
    } finally {
      readinessProbing = false;
    }
  }

  async function refreshAnalyzeJobs() {
    if (!isAdmin) return;
    const pending = analyzeJobs.filter((j) => j.status === "queued" || j.status === "running");
    if (pending.length === 0) return;
    try {
      const updates = await Promise.all(
        pending.map(async (j) => {
          try {
            const res = await api.settings.getAnalyzeCoordinatorSourceJob(program, j.id);
            return res?.job as AnalyzeJob;
          } catch {
            return null;
          }
        }),
      );
      mergeAnalyzeJobs(updates.filter(Boolean) as AnalyzeJob[]);
      for (const job of updates) {
        if (!job || consumedAnalyzeJobs.has(job.id)) continue;
        if (job.status === "completed") {
          consumedAnalyzeJobs.add(job.id);
          if (job.result) {
            await loadServerSources();
            projects = Array.isArray(job.result.projects) ? job.result.projects : projects;
            if (projects.length > 0 && !selectedProjectConfigPath) {
              void openProjectConfig(projects[0].configPath);
            }
            info = `Analyze job completed (${job.result.projectCount ?? projects.length} project(s)).`;
          }
        } else if (job.status === "failed") {
          consumedAnalyzeJobs.add(job.id);
          error = `Analyze job failed: ${job.error ?? "Unknown error"}`;
        }
      }
    } catch {
      // best effort polling
    }
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
      if (isAdmin) {
        await loadScripts();
        await Promise.all([
          loadTrainingAgentOptions(),
          loadTrainingWorkerOptions(),
        ]);
        await loadTrainingSchedule();
      } else {
        trainingLastRunByProgram = {};
        trainingNextRunByProgram = {};
        await Promise.all([
          loadTrainingAgentOptions(),
          loadTrainingWorkerOptions(),
        ]);
      }
      loadClientPromptOverrides();
      await loadExecutionReadiness();
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  async function loadScripts() {
    if (!isAdmin) return;
    const result = await api.settings.getCoordinatorScripts();
    const scripts = Array.isArray(result?.scripts) ? result.scripts : [];
    globalScript = String(scripts.find((s: any) => s.program === "global")?.content ?? "");
    bridgeScript = String(scripts.find((s: any) => s.program === program)?.content ?? "");

    // Build programs dropdown from API response
    const fetched: Array<{ value: string; label: string }> = scripts
      .map((s: any) => String(s.program ?? ""))
      .filter((p: string) => p.length > 0)
      .map((p: string) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
    // Ensure "global" is always present
    if (!fetched.some((p) => p.value === "global")) {
      fetched.push({ value: "global", label: "Global" });
    }
    programs = fetched;
  }

  function formatAnalyzeAgentLabel(agentId: string): string {
    const agent = analyzeAgents.find((a) => a.id === agentId);
    if (!agent) return agentId;
    const model = String(agent.model ?? "").trim();
    return model ? `${agent.name} (${model})` : agent.name;
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

  async function loadAnalyzeSettings() {
    if (!isAdmin) return;
    const [agentsRes, analyzeRes] = await Promise.all([
      api.agents.list(),
      api.settings.getCoordinatorAnalyzeAgent(),
    ]);
    analyzeAgents = mapAgentOptions(agentsRes);
    analyzeAgentEffectiveId = String(analyzeRes?.effectiveAgentConfigId ?? "");
    const configured = String(analyzeRes?.agentConfigId ?? "");
    analyzeAgentConfigId = configured || analyzeAgentEffectiveId || analyzeAgents[0]?.id || "";
    savedAnalyzeAgentConfigId = analyzeAgentConfigId;
    if (!trainingAgentConfigId || !analyzeAgents.some((agent) => agent.id === trainingAgentConfigId)) {
      trainingAgentConfigId = analyzeAgentConfigId;
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
      if (trainingTargetWorkerName && !mapped.some((worker: TrainingWorkerOption) => worker.name === trainingTargetWorkerName)) {
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
    const programs = Array.isArray(schedule?.programs)
      ? normalizeProgramList(schedule.programs as unknown[])
      : [];
    trainingSchedule = {
      enabled: schedule?.enabled === true,
      intervalMinutes: Number.isFinite(Number(schedule?.intervalMinutes))
        ? Math.max(5, Number(schedule.intervalMinutes))
        : 24 * 60,
      apply: schedule?.apply !== false,
      programs,
    };
    trainingLastRunByProgram = result?.lastRunByProgram && typeof result.lastRunByProgram === "object"
      ? result.lastRunByProgram as Record<string, string>
      : {};
    trainingNextRunByProgram = result?.nextRunByProgram && typeof result.nextRunByProgram === "object"
      ? result.nextRunByProgram as Record<string, string | null>
      : {};
  }

  async function saveTrainingSchedule() {
    if (!isAdmin) return;
    trainingScheduleSaving = true;
    error = "";
    info = "";
    try {
      const result = await api.settings.setCoordinatorTrainingSchedule({
        enabled: trainingSchedule.enabled,
        intervalMinutes: Math.max(5, Math.round(Number(trainingSchedule.intervalMinutes) || 0)),
        apply: trainingSchedule.apply,
        programs: trainingSchedule.programs,
      });
      const schedule = result?.schedule ?? {};
      trainingSchedule = {
        enabled: schedule?.enabled === true,
        intervalMinutes: Number.isFinite(Number(schedule?.intervalMinutes))
          ? Math.max(5, Number(schedule.intervalMinutes))
          : trainingSchedule.intervalMinutes,
        apply: schedule?.apply !== false,
        programs: Array.isArray(schedule?.programs)
          ? normalizeProgramList(schedule.programs as unknown[])
          : trainingSchedule.programs,
      };
      trainingLastRunByProgram = result?.lastRunByProgram && typeof result.lastRunByProgram === "object"
        ? result.lastRunByProgram as Record<string, string>
        : trainingLastRunByProgram;
      trainingNextRunByProgram = result?.nextRunByProgram && typeof result.nextRunByProgram === "object"
        ? result.nextRunByProgram as Record<string, string | null>
        : trainingNextRunByProgram;
      info = "Training schedule saved.";
    } catch (err: any) {
      error = `Save training schedule failed: ${err.message ?? err}`;
    } finally {
      trainingScheduleSaving = false;
    }
  }

  async function applyAnalyzeSettings() {
    if (!isAdmin) return;
    const modeChanged = analyzeMode !== savedAnalyzeMode;
    const modelChanged = analyzeAgentConfigId.trim() !== savedAnalyzeAgentConfigId.trim();
    if (!modeChanged && !modelChanged) {
      info = "No analyze setting changes to apply.";
      return;
    }
    analyzeSettingsSaving = true;
    error = "";
    info = "";
    try {
      let modeMessage = "";
      let modelMessage = "";

      if (modeChanged) {
        persistAnalyzeModeToStorage(analyzeMode);
        savedAnalyzeMode = analyzeMode;
        modeMessage = `Analyze mode set to ${analyzeMode === "ai" ? "AI (Bridge)" : "Fast (Local)"}.`;
      }

      if (modelChanged) {
        const chosen = analyzeAgentConfigId.trim() || null;
        const result = await api.settings.setCoordinatorAnalyzeAgent(chosen);
        analyzeAgentEffectiveId = String(result?.effectiveAgentConfigId ?? "");
        analyzeAgentConfigId = String(result?.agentConfigId ?? analyzeAgentEffectiveId ?? "");
        savedAnalyzeAgentConfigId = analyzeAgentConfigId;
        modelMessage = analyzeAgentEffectiveId
          ? `Analyze model set to ${formatAnalyzeAgentLabel(analyzeAgentEffectiveId)}.`
          : "Analyze model setting cleared.";
      }

      info = [modeMessage, modelMessage].filter(Boolean).join(" ");
    } catch (err: any) {
      error = `Apply analyze settings failed: ${err.message ?? err}`;
    } finally {
      analyzeSettingsSaving = false;
    }
  }

  function onTrainingFilesSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement | null;
    trainingUploadFiles = input?.files ? Array.from(input.files) : [];
  }

  function clearTrainingInputs() {
    trainingInputPath = "";
    trainingPrompt = "";
    trainingUploadFiles = [];
    trainingUploadInputResetKey += 1;
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
      const sourcePaths = extraPath ? [extraPath] : [];
      const relativeUploadPaths = trainingUploadFiles.map((file) =>
        String((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").trim(),
      );
      const result = await api.settings.queueCoordinatorTrainingJob(
        program,
        sourcePaths,
        applyTrainedUpdates,
        trainingUploadFiles,
        relativeUploadPaths,
        trainingAgentConfigId.trim(),
        trimmedPrompt,
        trimmedTargetWorkerName,
      );
      const jobId = String(result?.job?.id ?? "");
      const uploadedCount = Array.isArray(result?.input?.uploadedFiles) ? result.input.uploadedFiles.length : 0;
      const resolvedSourcePathCount = Array.isArray(result?.input?.sourcePaths) ? result.input.sourcePaths.length : sourcePaths.length;
      const uploadSessionVaultPath = String(result?.input?.uploadSessionVaultPath ?? "").trim();
      const resolvedAgentConfigId = String(result?.input?.agentConfigId ?? "").trim();
      const resolvedTargetWorkerName = String(result?.input?.targetWorkerName ?? trimmedTargetWorkerName).trim();
      const resolvedTrainingPrompt = String(result?.input?.trainingPrompt ?? trimmedPrompt).trim();
      const uploadedSuffix = uploadedCount > 0 ? ` (${uploadedCount} uploaded input${uploadedCount === 1 ? "" : "s"})` : "";
      info = jobId
        ? `Queued coordinator training job ${jobId.slice(0, 8)} for ${program}${uploadedSuffix}.`
        : `Queued coordinator training job for ${program}${uploadedSuffix}.`;
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
      error = `Queue training job failed: ${err.message ?? err}`;
    } finally {
      trainingJobStarting = false;
    }
  }

  async function addServerSourcePath() {
    if (!isAdmin) return;
    const path = newServerSourcePath.trim();
    const name = newServerSourceName.trim();
    if (!path) return;
    sourceSaving = true;
    error = "";
    info = "";
    try {
      await api.settings.addCoordinatorPlaybookSource(program, path, false, name || undefined);
      await loadServerSources();
      newServerSourcePath = "";
      newServerSourceName = "";
      info = "Server source added.";
    } catch (err: any) {
      error = `Add source failed: ${err.message ?? err}`;
    } finally {
      sourceSaving = false;
    }
  }

  async function saveServerSourceName(path: string) {
    if (!isAdmin) return;
    sourceSaving = true;
    error = "";
    info = "";
    try {
      const targetName = String(serverSourceNameDrafts[path] ?? "").trim();
      const next = serverSourcesAll.map((entry) => {
        if (entry.path !== path) return entry;
        return targetName
          ? { path: entry.path, name: targetName, programs: entry.programs }
          : { path: entry.path, programs: entry.programs };
      });
      await api.settings.setCoordinatorPlaybookSourceEntries(next);
      await loadServerSources();
      info = targetName ? "Source name saved." : "Source name cleared.";
    } catch (err: any) {
      error = `Save source name failed: ${err.message ?? err}`;
    } finally {
      sourceSaving = false;
    }
  }

  async function removeServerSourcePath(path: string) {
    if (!isAdmin) return;
    sourceSaving = true;
    error = "";
    info = "";
    try {
      const next = serverSourcesAll.filter((entry) => entry.path !== path);
      await api.settings.setCoordinatorPlaybookSourceEntries(next);
      await loadServerSources();
      info = "Server source removed.";
    } catch (err: any) {
      error = `Remove source failed: ${err.message ?? err}`;
    } finally {
      sourceSaving = false;
    }
  }

  async function queueAnalyzeSource(path: string, overwritePrompt = false, mode: AnalyzeMode = analyzeMode) {
    if (!isAdmin) {
      error = "Analyze jobs require admin login.";
      return;
    }
    const targetPath = path.trim();
    if (!targetPath) return;
    analyzeJobStarting = true;
    error = "";
    info = "";
    try {
      const result = await api.settings.createAnalyzeCoordinatorSourceJob(program, targetPath, true, overwritePrompt, mode);
      if (result?.job) {
        mergeAnalyzeJobs([result.job as AnalyzeJob]);
        info = `Queued ${mode.toUpperCase()} analyze job ${result.job.id.slice(0, 8)}.`;
      }
    } catch (err: any) {
      error = `Analyze job failed to start: ${err.message ?? err}`;
    } finally {
      analyzeJobStarting = false;
    }
  }

  async function openProjectConfig(configPath: string) {
    selectedProjectLoading = true;
    error = "";
    selectedProjectRawMode = false;
    selectedProjectRawText = "";
    try {
      const result = await api.settings.getCoordinatorProjectConfig(program, configPath);
      selectedProjectConfigPath = configPath;
      selectedProjectName = String(result?.config?.projectName ?? "");
      selectedProjectPrompt = String(result?.config?.prompt ?? "");
    } catch (err: any) {
      error = `Load prompt failed: ${err.message ?? err}`;
    } finally {
      selectedProjectLoading = false;
    }
  }

  async function openProjectRawJson() {
    if (!selectedProjectConfigPath) return;
    selectedProjectRawLoading = true;
    error = "";
    try {
      const result = await api.settings.getCoordinatorProjectConfigRaw(program, selectedProjectConfigPath);
      selectedProjectRawText = String(result?.content ?? "");
      selectedProjectRawMode = true;
    } catch (err: any) {
      error = `Load JSON failed: ${err.message ?? err}`;
    } finally {
      selectedProjectRawLoading = false;
    }
  }

  async function saveProjectPrompt() {
    if (!selectedProjectConfigPath || !selectedProjectPrompt.trim()) return;
    selectedProjectSaving = true;
    error = "";
    info = "";
    try {
      await api.settings.setCoordinatorProjectConfig(
        program,
        selectedProjectConfigPath,
        selectedProjectName,
        selectedProjectPrompt,
      );
      projects = projects.map((p) => (p.configPath === selectedProjectConfigPath
        ? { ...p, promptPreview: selectedProjectPrompt.replace(/\s+/g, " ").slice(0, 160) }
        : p));
      info = "Project prompt saved.";
    } catch (err: any) {
      error = `Save prompt failed: ${err.message ?? err}`;
    } finally {
      selectedProjectSaving = false;
    }
  }

  async function saveProjectRawJson() {
    if (!selectedProjectConfigPath || !selectedProjectRawText.trim()) return;
    selectedProjectRawSaving = true;
    error = "";
    info = "";
    try {
      const result = await api.settings.setCoordinatorProjectConfigRaw(
        program,
        selectedProjectConfigPath,
        selectedProjectRawText,
      );
      selectedProjectRawText = String(result?.content ?? selectedProjectRawText);
      selectedProjectName = String(result?.config?.projectName ?? selectedProjectName);
      selectedProjectPrompt = String(result?.config?.prompt ?? selectedProjectPrompt);
      projects = projects.map((p) => (p.configPath === selectedProjectConfigPath
        ? { ...p, promptPreview: selectedProjectPrompt.replace(/\s+/g, " ").slice(0, 160) }
        : p));
      info = "Project JSON saved.";
    } catch (err: any) {
      error = `Save JSON failed: ${err.message ?? err}`;
    } finally {
      selectedProjectRawSaving = false;
    }
  }

  function saveClientPromptOverridesAction() {
    error = "";
    info = "";
    saveClientPromptOverrides();
    info = `Saved client prompt overrides for ${program}.`;
  }

  function clearClientBridgePromptOverride() {
    clientPromptOverrideBridge = "";
    saveClientPromptOverrides();
    error = "";
    info = `Cleared ${program} client prompt override.`;
  }

  async function onProgramChanged(nextProgram: string) {
    program = nextProgram;
    if (scriptEditorTarget === "bridge") closeScriptEditor();
    await refreshAll();
  }

  function setScopeTab(nextTab: ScopeTab) {
    scopeTab = nextTab;
    if (nextTab !== "server") closeScriptEditor();
  }

  function previewScript(content: string): string {
    const oneLine = String(content ?? "").trim().replace(/\s+/g, " ");
    if (!oneLine) return "No script content yet.";
    return oneLine.length > 140 ? `${oneLine.slice(0, 140)}...` : oneLine;
  }

  function openScriptEditor(target: ScriptEditorTarget) {
    scriptEditorTarget = target;
    scriptEditorDraft = target === "global" ? globalScript : bridgeScript;
  }

  function closeScriptEditor() {
    scriptEditorTarget = null;
    scriptEditorDraft = "";
  }

  async function saveScriptEditor() {
    if (!isAdmin || !scriptEditorTarget) return;
    scriptsSaving = true;
    error = "";
    info = "";
    try {
      if (scriptEditorTarget === "global") {
        await api.settings.setCoordinatorScript("global", scriptEditorDraft);
        globalScript = scriptEditorDraft;
        info = "Saved global script.";
      } else {
        await api.settings.setCoordinatorScript(program, scriptEditorDraft);
        bridgeScript = scriptEditorDraft;
        info = `Saved ${program} script.`;
      }
      await loadScripts();
      closeScriptEditor();
    } catch (err: any) {
      error = `Save script failed: ${err.message ?? err}`;
    } finally {
      scriptsSaving = false;
    }
  }
</script>

<div class="coordinator-page">
  <h2>Coordinator</h2>
  {#if !canManage}
    <div class="panel">
      <p>You don't have permission to manage coordinator resources.</p>
    </div>
  {:else}
    <div
      class="coordinator-layout"
      class:server-script-layout={scopeTab === "server" && isAdmin && !!scriptEditorTarget}
    >
      <aside class="coord-left">
    <div class="tabs">
      <button class="tab" class:active={scopeTab === "server"} onclick={() => setScopeTab("server")}>
        Server Config
      </button>
      <button class="tab" class:active={scopeTab === "training"} onclick={() => setScopeTab("training")}>
        Training
      </button>
      <button class="tab" class:active={scopeTab === "client"} onclick={() => setScopeTab("client")}>
        Client Config
      </button>
    </div>

    {#if error}<div class="error">{error}</div>{/if}
    {#if info}<div class="info">{info}</div>{/if}

    <section class="panel toolbar-panel">
      <div class="toolbar">
        <label>
          Bridge
          <select value={program} onchange={(e) => onProgramChanged((e.target as HTMLSelectElement).value)}>
            {#each programs as p}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </label>
        <button class="btn secondary" onclick={refreshAll} disabled={loading}>Refresh</button>
      </div>
    </section>

    <section class="panel">
      <h3>Execution Readiness</h3>
      <p class="desc">
        Quick visibility into whether this bridge can execute now (live bridge) or via fallback.
      </p>
      <div class="readiness-grid">
        <div class="source-item">
          <strong>Bridge Online</strong>
          <div class="mini">
            {#if readinessLoading}
              Checking...
            {:else}
              {getBridgeOnlineCount(program) > 0 ? `${getBridgeOnlineCount(program)} online` : "No live bridge"}
            {/if}
          </div>
        </div>
        <div class="source-item">
          <strong>Fallback Mode</strong>
          <div class="mini">{fallbackModeLabel(program)}</div>
        </div>
        <div class="source-item">
          <strong>Executable</strong>
          <div class="mini mono">{getHeadlessStatus(program)?.executable || "-"}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn secondary" onclick={loadExecutionReadiness} disabled={readinessLoading}>
          {readinessLoading ? "Refreshing..." : "Refresh Readiness"}
        </button>
        <button class="btn secondary" onclick={runExecutionProbe} disabled={readinessProbing}>
          {readinessProbing ? "Running Probe..." : "Run Probe"}
        </button>
      </div>
      {#if readinessOutput}
        <label>
          Probe Output
          <textarea rows="8" value={readinessOutput} readonly spellcheck="false"></textarea>
        </label>
      {/if}
    </section>

      </aside>

      <div
        class="coord-right"
        class:with-script-pane={scopeTab === "server" && isAdmin && !!scriptEditorTarget}
      >
      <div class="coord-main">

    {#if scopeTab === "server"}
      {#if isAdmin}
        <section class="panel">
          <h3>Global Coordinator Script</h3>
          <p class="desc">
            This runs before any bridge-specific coordinator instructions.
          </p>
          <div class="script-card">
            <div class="script-summary">{previewScript(globalScript)}</div>
            <div class="actions">
              <button class="btn secondary" onclick={() => openScriptEditor("global")}>Edit</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <h3>{program} Coordinator Script</h3>
          <p class="desc">
            Bridge-specific script for <strong>{program}</strong>. This runs after the global script.
          </p>
          <div class="script-card">
            <div class="script-summary">{previewScript(bridgeScript)}</div>
            <div class="actions">
              <button class="btn secondary" onclick={() => openScriptEditor("bridge")}>Edit</button>
            </div>
          </div>
        </section>
        <section class="panel">
          <p class="mini">
            Global client coordination policy is managed from the Admin dashboard.
          </p>
        </section>
      {:else}
        <section class="panel">
          <h3>Server Scripts</h3>
          <p class="desc">
            Server-side coordinator scripts are admin-managed.
          </p>
        </section>
      {/if}
    {:else if scopeTab === "training"}
      <section class="panel training-dashboard-panel">
        <h3>Training Dashboard</h3>
        <p class="desc">
          Queue one coordinator training job from a path and/or attached files.
          Uploaded inputs are staged in Training Vault before training runs.
        </p>
        {#if !canQueueTraining}
          <p class="mini">
            {trainingQueueBlockedReason || "Training queue controls are unavailable for this account."}
          </p>
        {:else if !isAdmin}
          <p class="mini">
            Non-admin runs are always queued with auto-apply disabled.
          </p>
        {/if}
        <div class="training-grid">
          <label>
            Training Source Path (file or folder)
            <input
              type="text"
              bind:value={trainingInputPath}
              placeholder="/path/to/project-or-file (optional)"
            />
          </label>
          <label>
            Attach Files or ZIP (optional)
            {#key trainingUploadInputResetKey}
              <input type="file" multiple onchange={onTrainingFilesSelected} />
            {/key}
          </label>
        </div>
        {#if canQueueTraining}
          <label>
            Training Agent / Model
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
            Training Compute Worker (optional)
            <select bind:value={trainingTargetWorkerName}>
              <option value="">Server default</option>
              {#each trainingWorkers as worker}
                <option value={worker.name}>
                  {worker.name}
                  {worker.localLlmEnabled ? " · local LLM enabled" : " · local LLM disabled"}
                  {worker.status === "online" ? " · online" : " · offline"}
                </option>
              {/each}
            </select>
            <span class="mini">
              {trainingWorkersLoading
                ? "Loading workers..."
                : "When set with a local-oss training agent, the server routes local LLM calls to this worker endpoint."}
            </span>
          </label>
        {/if}
        <label>
          Training Objective (optional)
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
            <span>Auto-apply trained script updates</span>
          </label>
        {/if}
        <div class="actions">
          <button class="btn secondary" onclick={queueTrainingJobForProgram} disabled={trainingJobStarting || !canQueueTraining}>
            {trainingJobStarting ? "Queueing..." : "Train Now (Queue Job)"}
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
        {#if isAdmin}
          <p class="mini">
            Last run ({program}): {formatDateTime(trainingLastRunByProgram[normalizeProgramKey(program)])}
          </p>
          <p class="mini">
            Next run ({program}): {formatDateTime(trainingNextRunByProgram[normalizeProgramKey(program)])}
          </p>
        {/if}
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
        {#if isAdmin}
          <hr />
          <h4>Self-Training Schedule</h4>
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
            <span>Enable scheduled coordinator self-training</span>
          </label>
          <label>
            Interval (minutes)
            <input
              type="number"
              min="5"
              step="5"
              value={String(trainingSchedule.intervalMinutes)}
              oninput={(e) =>
                (trainingSchedule = {
                  ...trainingSchedule,
                  intervalMinutes: Math.max(5, Number((e.target as HTMLInputElement).value || 0)),
                })}
            />
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              checked={isTrainingScheduledForProgram(program)}
              onchange={(e) => toggleTrainingProgram(program, (e.target as HTMLInputElement).checked)}
            />
            <span>Include {program} in schedule</span>
          </label>
          <div class="actions">
            <button class="btn secondary" onclick={saveTrainingSchedule} disabled={trainingScheduleSaving}>
              {trainingScheduleSaving ? "Saving..." : "Save Training Schedule"}
            </button>
          </div>
        {/if}
      </section>
    {:else}
      <section class="panel">
        <h3>Client Bridge Prompt Overrides</h3>
        <p class="desc">
          Add local client-only instructions that are appended after server coordinator scripts when you submit jobs.
          These do not modify server scripts or training vault data.
        </p>
        <label>
          Global Client Override (optional)
          <textarea
            rows="6"
            bind:value={clientPromptOverrideGlobal}
            spellcheck="false"
            placeholder="Instructions added to all bridge runs from this client."
          ></textarea>
        </label>
        <label>
          {program} Bridge Override (optional)
          <textarea
            rows="8"
            bind:value={clientPromptOverrideBridge}
            spellcheck="false"
            placeholder={`Additional ${program} instructions for this client.`}
          ></textarea>
        </label>
        <div class="actions">
          <button class="btn" onclick={saveClientPromptOverridesAction}>Save Client Overrides</button>
          <button class="btn secondary" onclick={clearClientBridgePromptOverride}>Clear {program} Override</button>
        </div>
        <p class="mini">
          Client coordination policy: {connection.allowClientCoordination ? "enabled by admin" : "disabled by admin"}.
          Your account preference: {connection.clientCoordinationEnabled ? "enabled" : "disabled"}.
        </p>
      </section>
    {/if}
      </div>
      {#if scopeTab === "server" && isAdmin && scriptEditorTarget}
        <aside class="coord-script-pane">
          <section class="panel script-editor-panel">
            <h3>{scriptEditorTarget === "global" ? "Global Coordinator Script" : `${program} Coordinator Script`}</h3>
            <p class="desc">
              {#if scriptEditorTarget === "global"}
                Update the global script applied before bridge-specific instructions.
              {:else}
                Update the <strong>{program}</strong> script applied after the global coordinator script.
              {/if}
            </p>
            <label>
              Script
              <textarea class="script-editor-textarea" rows="18" bind:value={scriptEditorDraft} spellcheck="false"></textarea>
            </label>
            <div class="actions">
              <button class="btn" onclick={saveScriptEditor} disabled={scriptsSaving}>
                {scriptsSaving ? "Saving..." : "Save Script"}
              </button>
              <button class="btn secondary" onclick={closeScriptEditor} disabled={scriptsSaving}>Close</button>
            </div>
          </section>
        </aside>
      {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .coordinator-page {
    padding: 16px;
    height: 100%;
    overflow-y: auto;
    max-width: none;
    width: 100%;
    margin: 0;
  }

  .coordinator-layout {
    display: grid;
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }
  .coordinator-layout.server-script-layout {
    grid-template-columns: minmax(320px, 560px) minmax(460px, 1fr);
    gap: 12px;
  }
  .coordinator-layout.server-script-layout .coord-right.with-script-pane {
    display: contents;
  }
  .coordinator-layout.server-script-layout .coord-left {
    position: static;
    max-height: none;
    overflow-y: visible;
    padding-right: 0;
    grid-column: 1;
    grid-row: 1;
  }
  .coordinator-layout.server-script-layout .coord-main {
    grid-column: 1;
    grid-row: 2;
  }
  .coordinator-layout.server-script-layout .coord-script-pane {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .coord-left {
    position: sticky;
    top: 10px;
    max-height: calc(100vh - 170px);
    overflow-y: auto;
    padding-right: 2px;
  }
  .coord-right {
    min-width: 0;
  }
  .coord-right.with-script-pane {
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(460px, 38vw, 620px);
    gap: 12px;
    align-items: start;
  }
  .coord-main {
    min-width: 0;
  }
  .coord-script-pane {
    position: sticky;
    top: 10px;
    max-height: calc(100vh - 70px);
    overflow-y: auto;
    padding-right: 2px;
  }
  .script-editor-panel {
    height: calc(100vh - 90px);
    min-height: 560px;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    overflow: hidden;
  }
  .script-editor-panel label {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
  }
  .script-editor-textarea {
    height: 100%;
    min-height: 0;
    resize: vertical;
  }
  .training-dashboard-panel {
    display: grid;
    gap: 8px;
  }
  .training-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .training-selection,
  .training-last-queued {
    margin-top: 4px;
  }
  h2 {
    font-size: var(--font-size-lg);
    margin-bottom: 12px;
  }
  h3 {
    font-size: var(--font-size-base);
    margin-bottom: 8px;
    color: var(--text-secondary);
  }
  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    margin-bottom: 12px;
  }
  .toolbar {
    display: flex;
    gap: 10px;
    align-items: end;
    flex-wrap: wrap;
  }
  .toolbar label {
    min-width: 220px;
    flex: 1 1 220px;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .tab {
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
  }
  .tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 8px;
    line-height: 1.4;
  }
  .source-item {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    background: var(--bg-base);
  }
  .script-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .script-summary {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    padding: 10px;
    font-size: var(--font-size-sm);
    line-height: 1.4;
    word-break: break-word;
  }
  .readiness-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 8px;
  }
  .mono {
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .mini {
    font-size: 11px;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    border: none;
  }
  .btn.secondary {
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
  }
  .toggle {
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: flex-start;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
  }
  .toggle input {
    flex-shrink: 0;
    margin: 0;
    margin-top: 2px;
  }
  .toggle span {
    color: var(--text-secondary);
  }
  .error {
    margin-bottom: 10px;
    color: var(--status-failed);
    font-size: var(--font-size-sm);
  }
  .info {
    margin-bottom: 10px;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  textarea,
  input:not([type="checkbox"]):not([type="radio"]),
  select {
    width: 100%;
    background: var(--bg-base);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
  }
  input[type="checkbox"] {
    width: auto;
    padding: 0;
  }
  textarea {
    font-family: var(--font-mono);
    line-height: 1.45;
    resize: both;
    max-width: 100%;
    min-height: 96px;
  }
  @media (max-width: 1200px) {
    .coordinator-layout {
      grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
    }
    .coordinator-layout.server-script-layout {
      grid-template-columns: minmax(260px, 380px) minmax(0, 1fr);
    }
    .coord-right.with-script-pane {
      grid-template-columns: 1fr;
    }
    .coord-script-pane {
      position: static;
      max-height: none;
      overflow-y: visible;
      padding-right: 0;
    }
  }
  @media (max-width: 1024px) {
    .coordinator-layout {
      grid-template-columns: 1fr;
    }
    .coordinator-layout.server-script-layout .coord-right.with-script-pane {
      display: block;
    }
    .coordinator-layout.server-script-layout .coord-main,
    .coordinator-layout.server-script-layout .coord-script-pane {
      grid-column: auto;
      grid-row: auto;
    }
    .coord-left {
      position: static;
      max-height: none;
      overflow-y: visible;
      padding-right: 0;
    }
    .readiness-grid {
      grid-template-columns: 1fr;
    }
    .training-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
