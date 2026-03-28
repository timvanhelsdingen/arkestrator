<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    type CoordinatorTrainingVaultEntry,
    type CoordinatorTrainingVaultMetadata,
    type TrainingJobSignal,
    type TrainingJobSummary,
    type TrainingJobTransport,
    type TrainingRepositoryMetrics,
    type TrainingRepositoryOverrideMode,
    type TrainingRepositoryOverrideRule,
    type TrainingRepositoryOverrides,
    type TrainingRepositoryRecord,
    type TrainingRepositoryRefreshStatus,
  } from "../lib/api/client";
  import { auth } from "../lib/stores/auth.svelte";
  import { toast } from "../lib/stores/toast.svelte";
  import ConfirmDialog from "../lib/components/ui/ConfirmDialog.svelte";

  type EntryKind = "file" | "directory";
  type SortMode = "updated_desc" | "path_asc" | "size_desc";
  type GroupMode = "root_program" | "root" | "program" | "flat";
  type MetadataFilter = "all" | "tagged" | "untagged";
  type OverrideTargetType = "id" | "sourcePath";
  type VaultView = "vault" | "repository" | "snapshot";

  interface TrainingRepositoryOverrideRow {
    targetType: OverrideTargetType;
    target: string;
    rule: TrainingRepositoryOverrideRule;
  }

  interface TrainingJobFoldout {
    jobPath: string;
    jobId: string;
    jobFolder: string;
    jobLabel: string;
    program: string;
    directoryEntry: CoordinatorTrainingVaultEntry | null;
    files: CoordinatorTrainingVaultEntry[];
    bytes: number;
    taggedCount: number;
    updatedAt: string | null;
    matchedEntries: number;
  }

  type VaultListRow =
    | { kind: "entry"; entry: CoordinatorTrainingVaultEntry }
    | { kind: "training_job"; job: TrainingJobFoldout };

  interface VaultListGroup {
    key: string;
    label: string;
    rows: VaultListRow[];
    bytes: number;
    taggedCount: number;
  }

  // Generic confirm dialog state (replaces window.confirm which fails in iframe)
  let confirmOpen = $state(false);
  let confirmTitle = $state("");
  let confirmMessage = $state("");
  let confirmAction: (() => void) | null = $state(null);

  function requestConfirm(title: string, message: string, action: () => void) {
    confirmTitle = title;
    confirmMessage = message;
    confirmAction = action;
    confirmOpen = true;
  }

  function handleConfirm() {
    confirmOpen = false;
    confirmAction?.();
    confirmAction = null;
  }

  let entries = $state<CoordinatorTrainingVaultEntry[]>([]);
  let loading = $state(false);
  let search = $state("");
  let selectedProgramFilter = $state("");
  let selectedRootFilter = $state<"" | "scripts" | "playbooks" | "learning" | "imports">("");
  let selectedKindFilter = $state<"" | EntryKind>("");
  let selectedMetadataFilter = $state<MetadataFilter>("all");
  let selectedSortMode = $state<SortMode>("updated_desc");
  let selectedGroupMode = $state<GroupMode>("root_program");
  let expandedTrainingJobs = $state<Record<string, boolean>>({});

  let selectedPath = $state("");
  let selectedKind = $state<EntryKind | null>(null);
  let selectedContent = $state("");
  let selectedBytes = $state<number | null>(null);
  let selectedUpdatedAt = $state<string | null>(null);
  let selectedMetadata = $state<CoordinatorTrainingVaultMetadata | null>(null);
  let metadataProjectPaths = $state("");
  let metadataSourcePaths = $state("");
  let metadataRemarks = $state("");

  let reading = $state(false);
  let saving = $state(false);
  let savingMetadata = $state(false);
  let snapshotBusy = $state(false);
  let trainingImportBusy = $state(false);
  let includeServerFiles = $state(false);
  let snapshotFileInput = $state<HTMLInputElement | null>(null);
  let trainingZipFileInput = $state<HTMLInputElement | null>(null);
  let vaultView = $state<VaultView>("vault");
  let repositoryProgram = $state("houdini");
  let coordinatorScripts = $state<Array<{ program: string; content: string; isDefault: boolean; defaultContent: string }>>([]);
  let coordinatorScriptsLoading = $state(false);
  let repositoryPolicyLoading = $state(false);
  let repositoryPolicySaving = $state(false);
  let repositoryPolicyJson = $state("");
  let repositoryDefaultPolicyJson = $state("");
  let repositoryOverrides = $state<TrainingRepositoryOverrides | null>(null);
  let repositoryOverrideRows = $state<TrainingRepositoryOverrideRow[]>([]);
  let repositoryOverridesLoading = $state(false);
  let repositoryOverrideApplying = $state(false);
  let repositoryOverrideTargetType = $state<OverrideTargetType>("id");
  let repositoryOverrideTargetValue = $state("");
  let repositoryOverrideMode = $state<TrainingRepositoryOverrideMode | "clear">("allow");
  let repositoryOverrideTrustDelta = $state("");
  let repositoryOverrideNote = $state("");
  let repositoryOverridePrograms = $state("");
  let repositoryOverrideImmediate = $state(true);
  let repositoryRecordsLoading = $state(false);
  let repositoryRecords = $state<TrainingRepositoryRecord[]>([]);
  let repositoryRecordsQuery = $state("");
  let repositoryRecordsIncludeQuarantined = $state(false);
  let repositoryRecordsIncludeSuppressed = $state(false);
  let repositoryRecordsLimit = $state(120);
  let repositoryStatusLoading = $state(false);
  let repositoryStatus = $state<TrainingRepositoryRefreshStatus[]>([]);
  let repositoryMetricsLoading = $state(false);
  let repositoryMetrics = $state<TrainingRepositoryMetrics[]>([]);
  let repositoryReindexBusy = $state(false);
  let repositoryReindexImmediate = $state(false);
  let repositoryReindexSourcePaths = $state("");
  let repositoryReindexObjective = $state("");

  // Self-Training Schedule
  interface TrainingScheduleState {
    enabled: boolean;
    intervalMinutes: number;
    apply: boolean;
    programs: string[];
  }
  let scheduleLoading = $state(false);
  let scheduleSaving = $state(false);
  let trainingSchedule = $state<TrainingScheduleState>({
    enabled: false,
    intervalMinutes: 24 * 60,
    apply: true,
    programs: [],
  });
  let scheduleLastRunByProgram = $state<Record<string, string>>({});
  let scheduleNextRunByProgram = $state<Record<string, string | null>>({});
  let schedulePrograms = $derived(
    coordinatorScripts
      .map((s) => normalizeProgramName(s.program))
      .filter((p) => p && p !== "global"),
  );

  let trainingRunning = $state(false);

  async function runTrainingNow() {
    const programs = trainingSchedule.programs.length > 0
      ? trainingSchedule.programs
      : undefined;
    trainingRunning = true;
    try {
      const result = await api.coordinatorTraining.runTraining(programs ? { programs } : undefined) as any;
      // Orchestrator endpoint returns { ok, orchestratorJobId, job }
      if (result?.orchestratorJobId || result?.job?.id) {
        const jobId = String(result.orchestratorJobId ?? result.job?.id ?? "");
        toast.success(`Training queued: ${jobId.slice(0, 8)} (auto-detect)`);
        const nowIso = new Date().toISOString();
        for (const prog of programs ?? ["global"]) {
          scheduleLastRunByProgram = { ...scheduleLastRunByProgram, [prog]: nowIso };
        }
      }
      // Legacy format: { queued, failures }
      if (Array.isArray(result?.queued) && result.queued.length > 0) {
        toast.success(`Training queued for: ${result.queued.map((q: any) => q.program).join(", ")}`);
      }
      if (Array.isArray(result?.failures) && result.failures.length > 0) {
        toast.error(`Failed: ${result.failures.map((f: any) => `${f.program}: ${f.error}`).join(", ")}`);
      }
    } catch (err: any) {
      toast.error(err.message ?? "Failed to run training");
    } finally {
      trainingRunning = false;
    }
  }

  // Housekeeping Agent
  interface HousekeepingScheduleState {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt?: string;
  }
  let housekeepingSchedule = $state<HousekeepingScheduleState>({
    enabled: false,
    intervalMinutes: 1440,
  });
  let housekeepingLoading = $state(false);
  let housekeepingSaving = $state(false);
  let housekeepingRunning = $state(false);

  async function loadHousekeepingSchedule() {
    housekeepingLoading = true;
    try {
      const data = await api.coordinatorTraining.getHousekeepingSchedule();
      housekeepingSchedule = {
        enabled: data.enabled ?? false,
        intervalMinutes: data.intervalMinutes ?? 1440,
        lastRunAt: data.lastRunAt,
      };
    } catch {
      // endpoint may not exist yet on old servers
    } finally {
      housekeepingLoading = false;
    }
  }

  async function saveHousekeepingSchedule() {
    housekeepingSaving = true;
    try {
      await api.coordinatorTraining.setHousekeepingSchedule({
        enabled: housekeepingSchedule.enabled,
        intervalMinutes: housekeepingSchedule.intervalMinutes,
      });
      toast.success("Housekeeping schedule saved");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save housekeeping schedule");
    } finally {
      housekeepingSaving = false;
    }
  }

  async function runHousekeepingNow() {
    housekeepingRunning = true;
    try {
      const result = await api.coordinatorTraining.runHousekeeping();
      toast.success(`Housekeeping job queued: ${result.jobId}`);
      housekeepingSchedule = { ...housekeepingSchedule, lastRunAt: new Date().toISOString() };
    } catch (err: any) {
      toast.error(err.message ?? "Failed to run housekeeping");
    } finally {
      housekeepingRunning = false;
    }
  }

  let trainingJobsLoading = $state(false);
  let trainingJobs = $state<TrainingJobSummary[]>([]);
  let trainingJobsLastUpdatedAt = $state<string | null>(null);
  let trainingJobSignalFilter = $state<"all" | TrainingJobSignal>("all");
  let trainingJobTransportFilter = $state<"all" | TrainingJobTransport>("all");
  let trainingJobLimit = $state(500);
  let trainingJobExportBusy = $state(false);
  let checkedTrainingJobIds = $state<string[]>([]);

  let createFilePath = $state("learning/manual/new-note.md");
  let createFileContent = $state("");
  let createFolderPath = $state("learning/manual");

  function normalizePath(value: string): string {
    return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  function isVaultRoot(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === "scripts" || normalized === "playbooks" || normalized === "learning" || normalized === "imports";
  }

  function isValidVaultPath(path: string): boolean {
    return /^(scripts|playbooks|learning|imports)\/.+/.test(normalizePath(path));
  }

  function isTrainingJobArtifactPath(path: string): boolean {
    return /^learning\/jobs\/[^/]+\/.+/.test(normalizePath(path));
  }

  function clearSelection() {
    selectedPath = "";
    selectedKind = null;
    selectedContent = "";
    selectedBytes = null;
    selectedUpdatedAt = null;
    selectedMetadata = null;
    metadataProjectPaths = "";
    metadataSourcePaths = "";
    metadataRemarks = "";
  }

  function parseMultilinePaths(value: string): string[] {
    return [...new Set(
      String(value ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )];
  }

  function normalizeProgramName(value: string): string {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(normalized)) return "";
    return normalized;
  }

  function parseProgramList(value: string): string[] {
    return [...new Set(
      String(value ?? "")
        .split(/[,\r\n]+/)
        .map((entry) => normalizeProgramName(entry))
        .filter(Boolean),
    )];
  }

  function parseTrustDeltaInput(value: string): number | undefined {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(-0.6, Math.min(0.6, parsed));
  }

  function buildOverrideRows(overrides: TrainingRepositoryOverrides | null): TrainingRepositoryOverrideRow[] {
    if (!overrides) return [];
    const rows: TrainingRepositoryOverrideRow[] = [];
    for (const [target, rule] of Object.entries(overrides.byId ?? {})) {
      rows.push({ targetType: "id", target, rule });
    }
    for (const [target, rule] of Object.entries(overrides.bySourcePath ?? {})) {
      rows.push({ targetType: "sourcePath", target, rule });
    }
    rows.sort((a, b) => {
      if (a.targetType !== b.targetType) return a.targetType.localeCompare(b.targetType);
      return a.target.localeCompare(b.target);
    });
    return rows;
  }

  function syncMetadataFields(metadata: CoordinatorTrainingVaultMetadata | null) {
    selectedMetadata = metadata;
    metadataProjectPaths = Array.isArray(metadata?.projectPaths) ? metadata.projectPaths.join("\n") : "";
    metadataSourcePaths = Array.isArray(metadata?.sourcePaths) ? metadata.sourcePaths.join("\n") : "";
    metadataRemarks = String(metadata?.remarks ?? "");
  }

  async function load() {
    loading = true;
    try {
      const result = await api.coordinatorTraining.list(5000);
      entries = Array.isArray(result?.entries) ? result.entries : [];
      if (selectedPath && !entries.some((entry) => entry.path === selectedPath)) {
        clearSelection();
      } else if (selectedPath) {
        const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? null;
        syncMetadataFields(selectedEntry?.metadata ?? null);
      }
      await loadTrainingJobs({ silentErrors: true });
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load coordinator training files");
      entries = [];
    } finally {
      loading = false;
    }
  }


  async function loadCoordinatorScripts() {
    if (!auth.canManageSecurity) return;
    coordinatorScriptsLoading = true;
    try {
      const result = await api.coordinatorTraining.listCoordinatorScripts();
      coordinatorScripts = Array.isArray(result?.scripts) ? result.scripts : [];
    } catch {
      // Non-critical — fall back to whatever vault entries provide
    } finally {
      coordinatorScriptsLoading = false;
    }
  }

  async function loadTrainingSchedule() {
    if (!auth.canManageSecurity) return;
    scheduleLoading = true;
    try {
      const result = await api.coordinatorTraining.getTrainingSchedule();
      const schedule = result?.schedule ?? {} as any;
      const programs = Array.isArray(schedule?.programs)
        ? schedule.programs.map((v: unknown) => normalizeProgramName(String(v ?? ""))).filter(Boolean)
        : [];
      trainingSchedule = {
        enabled: schedule?.enabled === true,
        intervalMinutes: Number.isFinite(Number(schedule?.intervalMinutes))
          ? Math.max(5, Number(schedule.intervalMinutes))
          : 24 * 60,
        apply: schedule?.apply !== false,
        programs,
      };
      scheduleLastRunByProgram = result?.lastRunByProgram && typeof result.lastRunByProgram === "object"
        ? result.lastRunByProgram
        : {};
      scheduleNextRunByProgram = result?.nextRunByProgram && typeof result.nextRunByProgram === "object"
        ? result.nextRunByProgram
        : {};
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load training schedule");
    } finally {
      scheduleLoading = false;
    }
  }

  async function saveTrainingSchedule() {
    if (!auth.canManageSecurity) return;
    scheduleSaving = true;
    try {
      const result = await api.coordinatorTraining.setTrainingSchedule({
        enabled: trainingSchedule.enabled,
        intervalMinutes: Math.max(5, Math.round(Number(trainingSchedule.intervalMinutes) || 0)),
        apply: trainingSchedule.apply,
        programs: trainingSchedule.programs,
      });
      const schedule = result?.schedule ?? {} as any;
      trainingSchedule = {
        enabled: schedule?.enabled === true,
        intervalMinutes: Number.isFinite(Number(schedule?.intervalMinutes))
          ? Math.max(5, Number(schedule.intervalMinutes))
          : trainingSchedule.intervalMinutes,
        apply: schedule?.apply !== false,
        programs: Array.isArray(schedule?.programs)
          ? schedule.programs.map((v: unknown) => normalizeProgramName(String(v ?? ""))).filter(Boolean)
          : trainingSchedule.programs,
      };
      scheduleLastRunByProgram = result?.lastRunByProgram && typeof result.lastRunByProgram === "object"
        ? result.lastRunByProgram
        : scheduleLastRunByProgram;
      scheduleNextRunByProgram = result?.nextRunByProgram && typeof result.nextRunByProgram === "object"
        ? result.nextRunByProgram
        : scheduleNextRunByProgram;
      toast.success("Training schedule saved.");
    } catch (err: any) {
      toast.error(`Save training schedule failed: ${err.message ?? err}`);
    } finally {
      scheduleSaving = false;
    }
  }

  function isScheduledForProgram(p: string): boolean {
    return trainingSchedule.programs.includes(normalizeProgramName(p));
  }

  function toggleScheduleProgram(p: string, enabled: boolean) {
    const target = normalizeProgramName(p);
    const next = new Set(trainingSchedule.programs.map((v) => normalizeProgramName(v)));
    if (enabled) next.add(target);
    else next.delete(target);
    trainingSchedule = { ...trainingSchedule, programs: [...next] };
  }

  function formatScheduleDateTime(iso: string | null | undefined): string {
    const value = String(iso ?? "").trim();
    if (!value) return "Not scheduled";
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return "Invalid date";
    return new Date(ts).toLocaleString();
  }

  async function deleteCoordinatorScript(program: string) {
    try {
      await api.coordinatorTraining.deleteCoordinatorScript(program);
      toast.success(`Deleted coordinator script for "${program}"`);
      await loadCoordinatorScripts();
    } catch (err: any) {
      toast.error(err.message ?? `Failed to delete coordinator script for "${program}"`);
    }
  }

  async function loadTrainingRepositoryPolicy() {
    if (!auth.canManageSecurity) return;
    repositoryPolicyLoading = true;
    try {
      const result = await api.settings.getTrainingRepositoryPolicy();
      repositoryPolicyJson = `${JSON.stringify(result?.policy ?? {}, null, 2)}\n`;
      repositoryDefaultPolicyJson = `${JSON.stringify(result?.defaultPolicy ?? {}, null, 2)}\n`;
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load training repository policy");
      repositoryPolicyJson = "";
      repositoryDefaultPolicyJson = "";
    } finally {
      repositoryPolicyLoading = false;
    }
  }

  async function saveTrainingRepositoryPolicy() {
    if (!auth.isAdmin) {
      toast.error("Only admins can update training repository policy");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(repositoryPolicyJson);
    } catch {
      toast.error("Policy JSON is invalid");
      return;
    }

    repositoryPolicySaving = true;
    try {
      const result = await api.settings.updateTrainingRepositoryPolicy(parsed as any);
      repositoryPolicyJson = `${JSON.stringify(result?.policy ?? {}, null, 2)}\n`;
      toast.success("Training repository policy updated.");
      await loadTrainingRepositoryStatusAndMetrics();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update training repository policy");
    } finally {
      repositoryPolicySaving = false;
    }
  }

  async function loadTrainingRepositoryOverrides() {
    if (!auth.canManageSecurity) return;
    repositoryOverridesLoading = true;
    try {
      const result = await api.settings.getTrainingRepositoryOverrides();
      repositoryOverrides = result?.overrides ?? null;
      repositoryOverrideRows = buildOverrideRows(repositoryOverrides);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to load training repository overrides");
      repositoryOverrides = null;
      repositoryOverrideRows = [];
    } finally {
      repositoryOverridesLoading = false;
    }
  }

  async function applyTrainingRepositoryOverride(
    updateInput?: {
      id?: string;
      sourcePath?: string;
      mode?: TrainingRepositoryOverrideMode | "clear";
      trustDelta?: number;
      note?: string;
    },
    options?: {
      programs?: string[];
      immediate?: boolean;
      silent?: boolean;
    },
  ) {
    if (!auth.isAdmin) {
      toast.error("Only admins can update training repository overrides");
      return;
    }

    const fromForm = !updateInput;
    const update = updateInput ?? {
      id: repositoryOverrideTargetType === "id" ? repositoryOverrideTargetValue : undefined,
      sourcePath: repositoryOverrideTargetType === "sourcePath" ? repositoryOverrideTargetValue : undefined,
      mode: repositoryOverrideMode,
      trustDelta: parseTrustDeltaInput(repositoryOverrideTrustDelta),
      note: String(repositoryOverrideNote ?? "").trim() || undefined,
    };

    const targetValue = String(update.id ?? update.sourcePath ?? "").trim();
    if (!targetValue) {
      toast.error("Override target is required");
      return;
    }
    if (!update.mode) {
      toast.error("Override mode is required");
      return;
    }

    const programs = options?.programs && options.programs.length > 0
      ? options.programs
      : (() => {
          const parsed = parseProgramList(repositoryOverridePrograms);
          if (parsed.length > 0) return parsed;
          const fallback = normalizeProgramName(repositoryProgram);
          return fallback ? [fallback] : [];
        })();

    repositoryOverrideApplying = true;
    try {
      const result = await api.settings.updateTrainingRepositoryOverrides(
        [update],
        {
          programs,
          immediate: options?.immediate ?? repositoryOverrideImmediate,
        },
      );
      repositoryOverrides = result?.overrides ?? null;
      repositoryOverrideRows = buildOverrideRows(repositoryOverrides);
      if (fromForm) {
        repositoryOverrideTargetValue = "";
        repositoryOverrideTrustDelta = "";
        repositoryOverrideNote = "";
      }
      if (!options?.silent) {
        toast.success(`Override ${update.mode === "clear" ? "removed" : "saved"} (${result?.applied ?? 0} applied).`);
      }
      await Promise.all([
        loadTrainingRepositoryRecords({ silentErrors: true }),
        loadTrainingRepositoryStatusAndMetrics({ silentErrors: true }),
      ]);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update training repository override");
    } finally {
      repositoryOverrideApplying = false;
    }
  }

  async function clearTrainingRepositoryOverride(row: TrainingRepositoryOverrideRow) {
    await applyTrainingRepositoryOverride({
      id: row.targetType === "id" ? row.target : undefined,
      sourcePath: row.targetType === "sourcePath" ? row.target : undefined,
      mode: "clear",
    });
  }

  async function loadTrainingRepositoryRecords(options?: { silentErrors?: boolean }) {
    if (!auth.canManageSecurity) return;
    const program = normalizeProgramName(repositoryProgram);
    if (!program) {
      repositoryRecords = [];
      if (!options?.silentErrors) toast.error("Enter a valid bridge program first (e.g. houdini)");
      return;
    }

    repositoryRecordsLoading = true;
    try {
      const result = await api.settings.listTrainingRepositoryRecords({
        program,
        query: repositoryRecordsQuery.trim() || undefined,
        includeQuarantined: repositoryRecordsIncludeQuarantined,
        includeSuppressed: repositoryRecordsIncludeSuppressed,
        limit: Math.max(1, Math.min(500, Math.round(repositoryRecordsLimit || 120))),
      });
      repositoryRecords = Array.isArray(result?.records) ? result.records : [];
    } catch (err: any) {
      if (!options?.silentErrors) toast.error(err.message ?? "Failed to load training repository records");
      repositoryRecords = [];
    } finally {
      repositoryRecordsLoading = false;
    }
  }

  async function loadTrainingRepositoryStatusAndMetrics(options?: { silentErrors?: boolean }) {
    if (!auth.canManageSecurity) return;
    const program = normalizeProgramName(repositoryProgram);
    const programArg = program || undefined;

    repositoryStatusLoading = true;
    repositoryMetricsLoading = true;
    try {
      const [statusResult, metricsResult] = await Promise.all([
        api.settings.getTrainingRepositoryStatus(programArg),
        api.settings.getTrainingRepositoryMetrics(programArg),
      ]);
      repositoryStatus = Array.isArray(statusResult?.statuses) ? statusResult.statuses : [];
      repositoryMetrics = Array.isArray(metricsResult?.metrics) ? metricsResult.metrics : [];
    } catch (err: any) {
      repositoryStatus = [];
      repositoryMetrics = [];
      if (!options?.silentErrors) toast.error(err.message ?? "Failed to load training repository status/metrics");
    } finally {
      repositoryStatusLoading = false;
      repositoryMetricsLoading = false;
    }
  }

  async function reindexTrainingRepository() {
    if (!auth.isAdmin) {
      toast.error("Only admins can queue training repository reindex");
      return;
    }
    const program = normalizeProgramName(repositoryProgram);
    const programs = parseProgramList(repositoryOverridePrograms);
    const effectivePrograms = programs.length > 0
      ? programs
      : (program ? [program] : []);
    if (effectivePrograms.length === 0) {
      toast.error("Provide a valid program (e.g. houdini) or program list");
      return;
    }

    repositoryReindexBusy = true;
    try {
      const sourcePaths = parseMultilinePaths(repositoryReindexSourcePaths);
      const result = await api.settings.reindexTrainingRepository({
        programs: effectivePrograms,
        immediate: repositoryReindexImmediate,
        sourcePaths: sourcePaths.length > 0 ? sourcePaths : undefined,
        trainingObjective: repositoryReindexObjective.trim() || undefined,
      });
      const queueCount = Array.isArray(result?.queued) ? result.queued.length : 0;
      toast.success(`Queued training repository reindex for ${queueCount} program(s).`);
      await Promise.all([
        loadTrainingRepositoryStatusAndMetrics({ silentErrors: true }),
        loadTrainingRepositoryRecords({ silentErrors: true }),
      ]);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to queue training repository reindex");
    } finally {
      repositoryReindexBusy = false;
    }
  }

  async function refreshTrainingRepositoryData() {
    await Promise.all([
      loadCoordinatorScripts(),
      loadTrainingRepositoryPolicy(),
      loadTrainingRepositoryOverrides(),
      loadTrainingRepositoryStatusAndMetrics({ silentErrors: true }),
      loadTrainingRepositoryRecords({ silentErrors: true }),
    ]);
  }

  function selectedTrainingJobId(): string | null {
    if (checkedTrainingJobIds.length === 1) {
      return checkedTrainingJobIds[0];
    }
    const path = normalizePath(selectedPath);
    if (!path) return null;
    const jobPath = trainingJobPathFromPath(path);
    if (!jobPath) return null;
    const parts = jobPath.split("/").filter(Boolean);
    const folder = parts[3] ?? "";
    const parsed = parseTrainingJobFolder(folder);
    const id = String(parsed.jobId || folder).trim();
    return id || null;
  }

  function isTrainingJobChecked(jobId: string): boolean {
    const target = String(jobId ?? "").trim();
    if (!target) return false;
    return checkedTrainingJobIds.includes(target);
  }

  function setTrainingJobChecked(jobId: string, checked: boolean) {
    const target = String(jobId ?? "").trim();
    if (!target) return;
    if (checked) {
      if (!checkedTrainingJobIds.includes(target)) {
        checkedTrainingJobIds = [...checkedTrainingJobIds, target];
      }
      return;
    }
    checkedTrainingJobIds = checkedTrainingJobIds.filter((id) => id !== target);
  }

  function clearCheckedTrainingJobs() {
    checkedTrainingJobIds = [];
  }

  function buildTrainingJobFilterOptions() {
    const program = normalizeProgramName(selectedProgramFilter);
    const q = search.trim();
    return {
      program: program || undefined,
      q: q || undefined,
      signal: trainingJobSignalFilter === "all" ? undefined : trainingJobSignalFilter,
      transport: trainingJobTransportFilter === "all" ? undefined : trainingJobTransportFilter,
      limit: Math.max(20, Math.min(5000, Math.round(trainingJobLimit || 500))),
    };
  }

  async function loadTrainingJobs(options?: { silentErrors?: boolean }) {
    if (!auth.canEditCoordinator && !auth.canManageSecurity) return;
    trainingJobsLoading = true;
    try {
      const result = await api.coordinatorTraining.listJobs(buildTrainingJobFilterOptions());
      trainingJobs = Array.isArray(result?.items) ? result.items : [];
      const available = new Set(trainingJobs.map((row) => row.jobId));
      checkedTrainingJobIds = checkedTrainingJobIds.filter((id) => available.has(id));
      trainingJobsLastUpdatedAt = new Date().toISOString();
    } catch (err: any) {
      trainingJobs = [];
      checkedTrainingJobIds = [];
      if (!options?.silentErrors) toast.error(err.message ?? "Failed to load training job summaries");
    } finally {
      trainingJobsLoading = false;
    }
  }

  function downloadBlob(blob: Blob, suggestedFileName: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedFileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function exportTrainingData(scope: "all" | "filtered" | "program" | "job" | "selected") {
    const jobId = selectedTrainingJobId();
    const filters = buildTrainingJobFilterOptions();

    const payload: {
      scope: "all" | "filtered" | "program" | "job" | "selected";
      program?: string;
      jobId?: string;
      jobIds?: string[];
      q?: string;
      signal?: TrainingJobSignal;
      transport?: TrainingJobTransport;
      limit?: number;
    } = {
      scope,
      ...filters,
      limit: Math.max(50, Math.min(20_000, Math.round(trainingJobLimit || 500))),
    };

    if (scope === "program" && !payload.program) {
      toast.error("Select a bridge filter first for program export.");
      return;
    }
    if (scope === "job") {
      if (!jobId) {
        toast.error("Select a training job row first.");
        return;
      }
      payload.jobId = jobId;
      delete payload.program;
      delete payload.q;
      delete payload.signal;
      delete payload.transport;
    }
    if (scope === "selected") {
      if (checkedTrainingJobIds.length === 0) {
        toast.error("Check one or more training jobs first.");
        return;
      }
      payload.jobIds = [...checkedTrainingJobIds];
      delete payload.program;
      delete payload.q;
      delete payload.signal;
      delete payload.transport;
    }

    trainingJobExportBusy = true;
    try {
      const result = await api.coordinatorTraining.exportTrainingDataZip(payload);
      const fileName = result.fileName || `arkestrator-training-${scope}.zip`;
      downloadBlob(result.blob, fileName);
      toast.success(`Exported training data bundle (${fileName}).`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to export training data");
    } finally {
      trainingJobExportBusy = false;
    }
  }

  async function loadFile(path: string) {
    reading = true;
    try {
      const result = await api.coordinatorTraining.readFile(path);
      selectedContent = String(result?.content ?? "");
      selectedBytes = typeof result?.bytes === "number" ? result.bytes : selectedBytes;
      selectedUpdatedAt = typeof result?.updatedAt === "string" ? result.updatedAt : selectedUpdatedAt;
      syncMetadataFields((result?.metadata as CoordinatorTrainingVaultMetadata | null) ?? selectedMetadata);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to read file");
    } finally {
      reading = false;
    }
  }

  async function openEntry(entry: CoordinatorTrainingVaultEntry) {
    selectedPath = entry.path;
    selectedKind = entry.kind;
    selectedBytes = entry.kind === "file" ? entry.bytes : null;
    selectedUpdatedAt = entry.updatedAt;
    syncMetadataFields(entry.metadata ?? null);

    if (entry.kind === "file") {
      await loadFile(entry.path);
      return;
    }
    selectedContent = "";
  }

  async function openTrainingJob(job: TrainingJobFoldout) {
    if (job.directoryEntry) {
      await openEntry(job.directoryEntry);
      return;
    }
    selectedPath = job.jobPath;
    selectedKind = "directory";
    selectedContent = "";
    selectedBytes = null;
    selectedUpdatedAt = job.updatedAt;
    syncMetadataFields(null);
  }

  async function createFile() {
    const path = normalizePath(createFilePath);
    if (!isValidVaultPath(path)) {
      toast.error("Path must start with scripts/, playbooks/, or learning/");
      return;
    }
    try {
      await api.coordinatorTraining.writeFile(path, createFileContent);
      toast.success(`Saved in Training Vault: ${path}`);
      selectedPath = path;
      selectedKind = "file";
      await load();
      await loadFile(path);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save file");
    }
  }

  async function createFolder() {
    const path = normalizePath(createFolderPath);
    if (!isValidVaultPath(path)) {
      toast.error("Folder path must start with scripts/, playbooks/, or learning/");
      return;
    }
    try {
      await api.coordinatorTraining.createFolder(path);
      toast.success(`Created folder ${path}`);
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create folder");
    }
  }

  async function saveSelected() {
    if (selectedKind !== "file" || !selectedPath) {
      toast.error("Select a file first");
      return;
    }
    saving = true;
    try {
      await api.coordinatorTraining.writeFile(selectedPath, selectedContent);
      toast.success(`Saved in Training Vault: ${selectedPath}`);
      await load();
      await loadFile(selectedPath);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save file");
    } finally {
      saving = false;
    }
  }

  async function saveSelectedMetadata() {
    if (!selectedPath || !selectedKind) {
      toast.error("Select a file or folder first");
      return;
    }
    savingMetadata = true;
    try {
      const result = await api.coordinatorTraining.updateMetadata(selectedPath, {
        projectPaths: parseMultilinePaths(metadataProjectPaths),
        sourcePaths: parseMultilinePaths(metadataSourcePaths),
        remarks: metadataRemarks.trim() ? metadataRemarks.trim() : null,
      });
      syncMetadataFields(result?.metadata ?? null);
      toast.success(`Saved metadata for ${selectedPath}`);
      await load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save metadata");
    } finally {
      savingMetadata = false;
    }
  }

  function deleteSelectedFile() {
    if (selectedKind !== "file" || !selectedPath) return;
    const path = selectedPath;
    requestConfirm("Delete File", `Delete file '${path}'?`, async () => {
      try {
        await api.coordinatorTraining.deleteFile(path);
        toast.success(`Deleted ${path}`);
        clearSelection();
        await load();
      } catch (err: any) {
        toast.error(err.message ?? "Failed to delete file");
      }
    });
  }

  function deleteSelectedFolder() {
    if (selectedKind !== "directory" || !selectedPath || isVaultRoot(selectedPath)) {
      toast.error("Select a non-root folder first");
      return;
    }
    const path = selectedPath;
    requestConfirm("Delete Folder", `Delete folder '${path}' and all contents?`, async () => {
      try {
        await api.coordinatorTraining.deleteFolder(path);
        toast.success(`Deleted ${path}`);
        clearSelection();
        await load();
      } catch (err: any) {
        toast.error(err.message ?? "Failed to delete folder");
      }
    });
  }

  async function exportSnapshot() {
    snapshotBusy = true;
    try {
      const result = await api.coordinatorTraining.exportSnapshotZip(includeServerFiles);
      const fileName = result.fileName || "arkestrator-config-snapshot.zip";
      downloadBlob(result.blob, fileName);
      toast.success(`Exported full server snapshot (${fileName})`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to export snapshot");
    } finally {
      snapshotBusy = false;
    }
  }

  function promptImportSnapshot() {
    snapshotFileInput?.click();
  }

  async function importSnapshotFile(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (!file) return;
    requestConfirm("Import Snapshot", "Import this snapshot zip and replace current DB/training data?", async () => {
      snapshotBusy = true;
      try {
        const result = await api.coordinatorTraining.importSnapshotZip(file, includeServerFiles);
        const trainingErrors = result.summary.trainingWriteErrors.length;
        const serverErrors = result.summary.serverWriteErrors.length;
        toast.success(
          `Imported snapshot zip (${result.summary.trainingWriteCount} training files, ${result.summary.serverWriteCount} server files${trainingErrors || serverErrors ? ", with some write errors" : ""})`,
        );
        await load();
      } catch (err: any) {
        toast.error(err.message ?? "Failed to import snapshot");
      } finally {
        snapshotBusy = false;
        if (target) target.value = "";
      }
    });
  }

  function promptImportTrainingZip() {
    trainingZipFileInput?.click();
  }

  async function importTrainingZipFile(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (!file) return;
    requestConfirm("Import Training Data", "Import this training zip into Training Vault? Existing files with the same path will be updated.", async () => {
      trainingImportBusy = true;
      try {
        const result = await api.coordinatorTraining.importTrainingDataZip(file);
        toast.success(
          `Imported training zip (${result.summary.writtenCount} files written, ${result.summary.skippedCount} skipped).`,
        );
        await load();
      } catch (err: any) {
        toast.error(err.message ?? "Failed to import training zip");
      } finally {
        trainingImportBusy = false;
        if (target) target.value = "";
      }
    });
  }

  function downloadSelectedFile() {
    if (selectedKind !== "file" || !selectedPath) return;
    const blob = new Blob([selectedContent], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, pathLeaf(selectedPath));
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(value: string | null): string {
    if (!value) return "-";
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return value;
    return new Date(ms).toLocaleString();
  }

  function formatActor(
    actor: {
      id: string | null;
      username: string | null;
      ipAddress: string | null;
      workerName: string | null;
    } | null | undefined,
  ): string {
    if (!actor) return "-";
    const username = String(actor.username ?? "").trim();
    const id = String(actor.id ?? "").trim();
    const ip = String(actor.ipAddress ?? "").trim();
    const worker = String(actor.workerName ?? "").trim();
    const who = username ? (id ? `${username} (${id})` : username) : (id || "unknown");
    const machine = worker ? `machine:${worker}` : "";
    if (ip && machine) return `${who} @ ${ip} · ${machine}`;
    if (ip) return `${who} @ ${ip}`;
    if (machine) return `${who} · ${machine}`;
    return who;
  }

  function rootLabel(root: "scripts" | "playbooks" | "learning" | "imports"): string {
    if (root === "scripts") return "Scripts";
    if (root === "playbooks") return "Playbooks";
    if (root === "imports") return "Imports";
    return "Learning";
  }

  function rootFromPath(path: string): string {
    const normalized = normalizePath(path);
    const [head] = normalized.split("/");
    return head || normalized;
  }

  function pathLeaf(path: string): string {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }

  function pathParent(path: string): string {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 1) return "/";
    return parts.slice(0, -1).join("/");
  }

  function entrySearchText(entry: CoordinatorTrainingVaultEntry): string {
    const metadata = entry.metadata;
    const metadataPaths = [
      ...(metadata?.projectPaths ?? []),
      ...(metadata?.sourcePaths ?? []),
      String(metadata?.remarks ?? ""),
      String(metadata?.createdBy?.username ?? ""),
      String(metadata?.updatedBy?.username ?? ""),
      String(metadata?.createdBy?.ipAddress ?? ""),
      String(metadata?.updatedBy?.ipAddress ?? ""),
    ];
    return [
      entry.path,
      entry.kind,
      entry.root,
      String(entry.program ?? ""),
      ...metadataPaths,
    ]
      .join(" ")
      .toLowerCase();
  }

  function compareEntries(
    a: CoordinatorTrainingVaultEntry,
    b: CoordinatorTrainingVaultEntry,
    sortMode: SortMode,
  ): number {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;

    if (sortMode === "size_desc") {
      const sizeDelta = Number(b.bytes ?? 0) - Number(a.bytes ?? 0);
      if (sizeDelta !== 0) return sizeDelta;
      return a.path.localeCompare(b.path);
    }

    if (sortMode === "updated_desc") {
      const aMs = Date.parse(String(a.updatedAt ?? "")) || 0;
      const bMs = Date.parse(String(b.updatedAt ?? "")) || 0;
      const updatedDelta = bMs - aMs;
      if (updatedDelta !== 0) return updatedDelta;
      return a.path.localeCompare(b.path);
    }

    return a.path.localeCompare(b.path);
  }

  function groupKey(entry: CoordinatorTrainingVaultEntry, mode: GroupMode): string {
    if (mode === "flat") return "all";
    if (mode === "root") return `root:${entry.root}`;
    if (mode === "program") return `program:${entry.program || "unscoped"}`;
    return `${entry.root}:${entry.program || "unscoped"}`;
  }

  function groupLabel(entry: CoordinatorTrainingVaultEntry, mode: GroupMode): string {
    if (mode === "flat") return "All Entries";
    if (mode === "root") return rootLabel(entry.root);
    if (mode === "program") return entry.program ? `Bridge: ${entry.program}` : "Bridge: unscoped";
    const programLabel = entry.program ? `Bridge: ${entry.program}` : "Bridge: unscoped";
    return `${rootLabel(entry.root)} · ${programLabel}`;
  }

  function trainingJobPathFromPath(path: string): string | null {
    const parts = normalizePath(path).split("/").filter(Boolean);
    if (parts.length < 4) return null;
    if (parts[0] !== "learning" || parts[1] !== "jobs") return null;
    const program = parts[2];
    const jobId = parts[3];
    if (!program || !jobId) return null;
    return `learning/jobs/${program}/${jobId}`;
  }

  function parseTrainingJobFolder(folder: string): { jobId: string; jobLabel: string } {
    const raw = String(folder ?? "").trim();
    if (!raw) return { jobId: "", jobLabel: "training job" };
    const separator = raw.lastIndexOf("--");
    if (separator > 0 && separator < raw.length - 2) {
      const labelPart = raw.slice(0, separator);
      const idPart = raw.slice(separator + 2);
      const label = labelPart
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        jobId: idPart,
        jobLabel: label || idPart,
      };
    }
    return {
      jobId: raw,
      jobLabel: raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || raw,
    };
  }

  function resolveTrainingJobPath(
    entry: CoordinatorTrainingVaultEntry,
    entryByPath: Map<string, CoordinatorTrainingVaultEntry>,
  ): string | null {
    const candidate = trainingJobPathFromPath(entry.path);
    if (!candidate) return null;
    const normalizedEntryPath = normalizePath(entry.path);
    if (normalizedEntryPath === candidate && entry.kind === "directory") return candidate;
    const root = entryByPath.get(candidate);
    if (!root || root.kind !== "directory") return null;
    return normalizedEntryPath.startsWith(`${candidate}/`) ? candidate : null;
  }

  function nestedPathUnderJob(jobPath: string, fullPath: string): string {
    const normalizedJobPath = normalizePath(jobPath);
    const normalizedFullPath = normalizePath(fullPath);
    if (!normalizedFullPath.startsWith(`${normalizedJobPath}/`)) return normalizedFullPath;
    return normalizedFullPath.slice(normalizedJobPath.length + 1);
  }

  function isTrainingJobExpanded(jobPath: string): boolean {
    return !!expandedTrainingJobs[jobPath];
  }

  function toggleTrainingJob(jobPath: string) {
    expandedTrainingJobs = {
      ...expandedTrainingJobs,
      [jobPath]: !expandedTrainingJobs[jobPath],
    };
  }

  let availablePrograms = $derived(
    [...new Set(
      coordinatorScripts.map((s) => s.program),
    )]
      .sort((a, b) => a.localeCompare(b)),
  );

  let repositoryProgramOptions = $derived(
    [...new Set(availablePrograms)]
      .map((value) => normalizeProgramName(value))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
  );

  let canDeleteRepositoryProgram = $derived(() => {
    const s = coordinatorScripts.find((s) => s.program === repositoryProgram);
    return !!s && !s.defaultContent;
  });

  let availableRoots = $derived(
    [...new Set(entries.map((entry) => entry.root))]
      .sort((a, b) => a.localeCompare(b)),
  );

  let searchTokens = $derived(
    search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );

  let filteredEntries = $derived(
    entries.filter((entry) => {
      const programOk = !selectedProgramFilter || (entry.program ?? "") === selectedProgramFilter;
      if (!programOk) return false;

      const rootOk = !selectedRootFilter || entry.root === selectedRootFilter;
      if (!rootOk) return false;

      const kindOk = !selectedKindFilter || entry.kind === selectedKindFilter;
      if (!kindOk) return false;

      const hasMetadata = !!entry.metadata;
      if (selectedMetadataFilter === "tagged" && !hasMetadata) return false;
      if (selectedMetadataFilter === "untagged" && hasMetadata) return false;

      if (searchTokens.length === 0) return true;
      const haystack = entrySearchText(entry);
      return searchTokens.every((token) => haystack.includes(token));
    }),
  );

  let sortedEntries = $derived(
    [...filteredEntries].sort((a, b) => compareEntries(a, b, selectedSortMode)),
  );

  let entryByPath = $derived(
    new Map(entries.map((entry) => [entry.path, entry] as const)),
  );

  let groupedEntries = $derived(
    (() => {
      const map = new Map<string, {
        key: string;
        label: string;
        sourceEntries: CoordinatorTrainingVaultEntry[];
        bytes: number;
        taggedCount: number;
      }>();
      for (const entry of sortedEntries) {
        const key = groupKey(entry, selectedGroupMode);
        let group = map.get(key);
        if (!group) {
          group = {
            key,
            label: groupLabel(entry, selectedGroupMode),
            sourceEntries: [],
            bytes: 0,
            taggedCount: 0,
          };
          map.set(key, group);
        }
        group.sourceEntries.push(entry);
        group.bytes += Number(entry.bytes ?? 0);
        if (entry.metadata) group.taggedCount += 1;
      }

      const groups: VaultListGroup[] = [];
      for (const sourceGroup of map.values()) {
        const standaloneRows = new Map<string, VaultListRow>();
        const jobBuckets = new Map<string, CoordinatorTrainingVaultEntry[]>();
        const rowOrder: string[] = [];

        for (const entry of sourceGroup.sourceEntries) {
          const jobPath = resolveTrainingJobPath(entry, entryByPath);
          if (jobPath) {
            if (!jobBuckets.has(jobPath)) {
              jobBuckets.set(jobPath, []);
              rowOrder.push(`job:${jobPath}`);
            }
            jobBuckets.get(jobPath)?.push(entry);
            continue;
          }
          const rowKey = `entry:${entry.path}`;
          if (!standaloneRows.has(rowKey)) {
            rowOrder.push(rowKey);
            standaloneRows.set(rowKey, { kind: "entry", entry });
          }
        }

        const rows = rowOrder
          .map((rowKey): VaultListRow | null => {
            if (rowKey.startsWith("entry:")) {
              return standaloneRows.get(rowKey) ?? null;
            }
            const jobPath = rowKey.slice(4);
            const bucket = jobBuckets.get(jobPath) ?? [];
            if (bucket.length === 0) return null;
            const directoryEntry = entryByPath.get(jobPath) ?? null;
            const files = bucket
              .filter((entry) => entry.kind === "file" && normalizePath(entry.path) !== jobPath)
              .sort((a, b) => compareEntries(a, b, selectedSortMode));
            const updatedAtValues = bucket
              .map((entry) => Date.parse(String(entry.updatedAt ?? "")))
              .filter((value) => Number.isFinite(value));
            const latestUpdatedAt = updatedAtValues.length > 0
              ? new Date(Math.max(...updatedAtValues)).toISOString()
              : directoryEntry?.updatedAt ?? null;
            const bytes = bucket.reduce((sum, entry) => sum + Number(entry.bytes ?? 0), 0);
            const taggedCount = bucket.reduce((sum, entry) => sum + (entry.metadata ? 1 : 0), 0);
            const parts = jobPath.split("/");
            const jobFolder = parts[3] ?? jobPath;
            const parsedFolder = parseTrainingJobFolder(jobFolder);
            const program = (parts[2] ?? String(directoryEntry?.program ?? "").trim()) || "unscoped";
            return {
              kind: "training_job",
              job: {
                jobPath,
                jobId: parsedFolder.jobId || jobFolder,
                jobFolder,
                jobLabel: parsedFolder.jobLabel || jobFolder,
                program,
                directoryEntry,
                files,
                bytes,
                taggedCount,
                updatedAt: latestUpdatedAt,
                matchedEntries: bucket.length,
              },
            };
          })
          .filter((row): row is VaultListRow => !!row);

        groups.push({
          key: sourceGroup.key,
          label: sourceGroup.label,
          rows,
          bytes: sourceGroup.bytes,
          taggedCount: sourceGroup.taggedCount,
        });
      }

      return groups.sort((a, b) => a.label.localeCompare(b.label));
    })(),
  );

  let filteredStats = $derived(
    filteredEntries.reduce(
      (acc, entry) => {
        acc.total += 1;
        if (entry.kind === "file") acc.files += 1;
        else acc.directories += 1;
        if (entry.metadata) acc.tagged += 1;
        acc.bytes += Number(entry.bytes ?? 0);
        return acc;
      },
      { total: 0, files: 0, directories: 0, tagged: 0, bytes: 0 },
    ),
  );

  let visibleRowStats = $derived(
    groupedEntries.reduce(
      (acc, group) => {
        acc.rows += group.rows.length;
        acc.tagged += group.taggedCount;
        acc.bytes += group.bytes;
        for (const row of group.rows) {
          if (row.kind === "training_job") acc.nestedFiles += row.job.files.length;
        }
        return acc;
      },
      { rows: 0, nestedFiles: 0, tagged: 0, bytes: 0 },
    ),
  );

  onMount(() => {
    void load();
    void loadCoordinatorScripts().then(() => loadTrainingSchedule());
    void refreshTrainingRepositoryData();
    void loadHousekeepingSchedule();
  });
</script>

<div class="page">
  <input
    bind:this={snapshotFileInput}
    type="file"
    accept=".zip,application/zip"
    class="hidden-file-input"
    onchange={importSnapshotFile}
  />


  {#if auth.canManageSecurity}
    <section class="policy-panel">
      <h2>Self-Learning</h2>
      <p class="hint">
        Arkestrator learns from your projects and past jobs. Training analyzes source content (scenes, textures, workflows) and creates skills with references to detailed playbook artifacts. After training, housekeeping reviews recent job outcomes, identifies patterns, links related skills, and generates new skills to improve future operations. Both run automatically when scheduled, or you can trigger them manually.
      </p>
      {#if scheduleLoading || housekeepingLoading}
        <p class="hint">Loading...</p>
      {:else}
        <div style="display: flex; gap: 8px; margin-bottom: 12px; align-items: center;">
          <button
            class="btn-primary"
            onclick={runTrainingNow}
            disabled={trainingRunning}
          >
            {trainingRunning ? "Queuing..." : "Run Training Now"}
          </button>
          <button
            class="btn-secondary"
            onclick={runHousekeepingNow}
            disabled={housekeepingRunning}
          >
            {housekeepingRunning ? "Queuing..." : "Run Housekeeping Only"}
          </button>
          {#if housekeepingSchedule.lastRunAt}
            <span class="hint">
              Last housekeeping: {formatScheduleDateTime(housekeepingSchedule.lastRunAt)}
            </span>
          {/if}
        </div>

        <details class="bridge-selector" open>
          <summary class="bridge-selector-summary">Schedule Settings</summary>
          <div class="bridge-selector-list">
            <label class="toggle policy-toggle">
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
            <label class="toggle policy-toggle">
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
            <div style="display: flex; gap: 16px; margin: 8px 0;">
              <label class="field compact" style="flex: 1;">
                <span>Training interval (min)</span>
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
              <label class="field compact" style="flex: 1;">
                <span>Housekeeping interval (min)</span>
                <input
                  type="number"
                  min="60"
                  step="60"
                  value={String(housekeepingSchedule.intervalMinutes)}
                  oninput={(e) =>
                    (housekeepingSchedule = {
                      ...housekeepingSchedule,
                      intervalMinutes: Math.max(60, Number((e.target as HTMLInputElement).value || 0)),
                    })}
                />
              </label>
            </div>

            <details class="bridge-selector" style="margin-top: 4px;">
              <summary class="bridge-selector-summary">
                Bridges in training schedule ({trainingSchedule.programs?.length ?? 0} selected)
              </summary>
              <div class="bridge-selector-list">
                {#each schedulePrograms as prog}
                  <label class="toggle policy-toggle">
                    <input
                      type="checkbox"
                      checked={isScheduledForProgram(prog)}
                      onchange={(e) => toggleScheduleProgram(prog, (e.target as HTMLInputElement).checked)}
                    />
                    <span>{prog}</span>
                  </label>
                  <div class="policy-meta">
                    Last: {formatScheduleDateTime(scheduleLastRunByProgram[prog])}
                    &mdash; Next: {formatScheduleDateTime(scheduleNextRunByProgram[prog])}
                  </div>
                {/each}
                {#if schedulePrograms.length === 0}
                  <p class="hint">No bridge programs discovered yet.</p>
                {/if}
              </div>
            </details>

            <div style="margin-top: 8px; display: flex; gap: 8px;">
              <button
                class="btn-primary"
                onclick={() => { saveTrainingSchedule(); saveHousekeepingSchedule(); }}
                disabled={scheduleSaving || housekeepingSaving}
              >
                {scheduleSaving || housekeepingSaving ? "Saving..." : "Save Schedule"}
              </button>
            </div>
          </div>
        </details>
      {/if}
    </section>
  {/if}

  {#if auth.canManageSecurity}
    <section class="view-switcher">
      <button
        class="btn-secondary"
        class:activeView={vaultView === "vault"}
        onclick={() => (vaultView = "vault")}
      >
        Vault Explorer
      </button>
      <button
        class="btn-secondary"
        class:activeView={vaultView === "repository"}
        onclick={() => (vaultView = "repository")}
      >
        Repository Controls
      </button>
      <button
        class="btn-secondary"
        class:activeView={vaultView === "snapshot"}
        onclick={() => (vaultView = "snapshot")}
      >
        Snapshots
      </button>
    </section>
  {/if}

  {#if auth.canManageSecurity && vaultView === "repository"}
    <section class="repository-panel">
      <div class="repository-head">
        <div>
          <h2>Training Repository Controls</h2>
          <p class="hint">
            Centralized curation for retrieval quality and safety. Use these controls to tune policy, override records, and monitor index health.
          </p>
        </div>
        <div class="repository-head-actions">
          <label class="field compact">
            <span>Program</span>
            <select bind:value={repositoryProgram}>
              {#each repositoryProgramOptions as program}
                <option value={program}>{program}</option>
              {/each}
            </select>
          </label>
          {#if canDeleteRepositoryProgram()}
            <button
              class="btn-danger"
              onclick={() => requestConfirm(
                "Delete Coordinator Script",
                `Remove the dynamically discovered coordinator script for "${repositoryProgram}"? This cannot be undone.`,
                () => deleteCoordinatorScript(repositoryProgram),
              )}
              disabled={coordinatorScriptsLoading}
            >
              Delete
            </button>
          {/if}
          <button class="btn-secondary" onclick={refreshTrainingRepositoryData} disabled={repositoryPolicyLoading || repositoryOverridesLoading || repositoryStatusLoading || repositoryMetricsLoading || repositoryRecordsLoading}>
            Refresh Repository
          </button>
        </div>
      </div>

      <div class="repository-grid">
        <article class="repository-card">
          <h3>Policy</h3>
          <p class="hint">
            Edit policy JSON directly. This controls trust thresholds, scoring weights, quarantine, retention, and source reliability.
          </p>
          <label class="field">
            <span>Effective Policy JSON</span>
            <textarea
              rows="14"
              bind:value={repositoryPolicyJson}
              spellcheck="false"
              disabled={repositoryPolicyLoading || (!auth.isAdmin && !auth.canManageSecurity)}
            ></textarea>
          </label>
          <div class="buttons">
            <button class="btn-primary" onclick={saveTrainingRepositoryPolicy} disabled={repositoryPolicySaving || repositoryPolicyLoading || !auth.isAdmin}>
              {repositoryPolicySaving ? "Saving..." : "Save Policy"}
            </button>
            <button class="btn-secondary" onclick={loadTrainingRepositoryPolicy} disabled={repositoryPolicyLoading}>
              {repositoryPolicyLoading ? "Loading..." : "Reload Policy"}
            </button>
          </div>
          <label class="field">
            <span>Default Policy (read-only)</span>
            <textarea rows="8" bind:value={repositoryDefaultPolicyJson} spellcheck="false" readonly></textarea>
          </label>
        </article>

        <article class="repository-card">
          <h3>Overrides</h3>
          <p class="hint">
            Force allow/quarantine/suppress for specific record IDs or source paths. Use clear to remove an override.
          </p>
          <div class="stats-inline">
            <span>Rules: {repositoryOverrideRows.length}</span>
            <span>{repositoryOverridesLoading ? "Loading..." : "Ready"}</span>
          </div>
          <div class="inline-grid">
            <label class="field">
              <span>Target Type</span>
              <select bind:value={repositoryOverrideTargetType}>
                <option value="id">Record ID</option>
                <option value="sourcePath">Source Path</option>
              </select>
            </label>
            <label class="field">
              <span>Mode</span>
              <select bind:value={repositoryOverrideMode}>
                <option value="allow">allow</option>
                <option value="quarantine">quarantine</option>
                <option value="suppress">suppress</option>
                <option value="clear">clear</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>Target</span>
            <input
              bind:value={repositoryOverrideTargetValue}
              placeholder={repositoryOverrideTargetType === "id" ? "job_outcome:/path:..." : "/path/to/file.or.source"}
            />
          </label>
          <div class="inline-grid">
            <label class="field">
              <span>Trust Delta (-0.6..0.6)</span>
              <input bind:value={repositoryOverrideTrustDelta} placeholder="optional" />
            </label>
            <label class="field">
              <span>Programs (comma/newline)</span>
              <input bind:value={repositoryOverridePrograms} placeholder="houdini, blender" />
            </label>
          </div>
          <label class="field">
            <span>Note</span>
            <textarea rows="2" bind:value={repositoryOverrideNote} spellcheck="false"></textarea>
          </label>
          <label class="toggle">
            <input type="checkbox" bind:checked={repositoryOverrideImmediate} />
            <span>Flush affected reindex queues immediately</span>
          </label>
          <div class="buttons">
            <button class="btn-primary" onclick={() => applyTrainingRepositoryOverride()} disabled={repositoryOverrideApplying || !auth.isAdmin}>
              {repositoryOverrideApplying ? "Applying..." : "Apply Override"}
            </button>
            <button class="btn-secondary" onclick={loadTrainingRepositoryOverrides} disabled={repositoryOverridesLoading}>
              {repositoryOverridesLoading ? "Loading..." : "Reload Overrides"}
            </button>
          </div>
          <div class="compact-table">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Mode</th>
                  <th>Delta</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#if repositoryOverrideRows.length === 0}
                  <tr><td colspan="5" class="muted-cell">No overrides set.</td></tr>
                {:else}
                  {#each repositoryOverrideRows as row}
                    <tr>
                      <td>
                        <div class="mono-cell">{row.target}</div>
                        <div class="muted-sub">{row.targetType}</div>
                      </td>
                      <td>{row.rule.mode}</td>
                      <td>{row.rule.trustDelta ?? "-"}</td>
                      <td>
                        <div>{formatDate(row.rule.updatedAt ?? null)}</div>
                        <div class="muted-sub">{row.rule.updatedBy ?? "-"}</div>
                      </td>
                      <td>
                        <button class="btn-secondary btn-xs" onclick={() => clearTrainingRepositoryOverride(row)} disabled={repositoryOverrideApplying || !auth.isAdmin}>
                          Clear
                        </button>
                      </td>
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </article>

        <article class="repository-card repository-card-wide">
          <h3>Indexed Records</h3>
          <div class="inline-grid records-controls">
            <label class="field">
              <span>Search</span>
              <input bind:value={repositoryRecordsQuery} placeholder="prompt text, path, title..." />
            </label>
            <label class="field">
              <span>Limit</span>
              <input type="number" min="1" max="500" bind:value={repositoryRecordsLimit} />
            </label>
          </div>
          <div class="controls-row">
            <label class="toggle">
              <input type="checkbox" bind:checked={repositoryRecordsIncludeQuarantined} />
              <span>Include quarantined</span>
            </label>
            <label class="toggle">
              <input type="checkbox" bind:checked={repositoryRecordsIncludeSuppressed} />
              <span>Include suppressed</span>
            </label>
            <button class="btn-secondary" onclick={() => loadTrainingRepositoryRecords()} disabled={repositoryRecordsLoading}>
              {repositoryRecordsLoading ? "Loading..." : "Search Records"}
            </button>
          </div>
          <div class="compact-table records-table">
            <table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Score</th>
                  <th>Trust</th>
                  <th>Rating</th>
                  <th>State</th>
                  <th>Override</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#if repositoryRecordsLoading}
                  <tr><td colspan="7" class="muted-cell">Loading records...</td></tr>
                {:else if repositoryRecords.length === 0}
                  <tr><td colspan="7" class="muted-cell">No indexed records for this query/program.</td></tr>
                {:else}
                  {#each repositoryRecords as record}
                    <tr>
                      <td>
                        <div>{record.title}</div>
                        <div class="mono-cell">{record.sourcePath}</div>
                        <div class="muted-sub">{record.sourceKind} · {formatDate(record.updatedAt)}</div>
                      </td>
                      <td>{record.score.toFixed(3)}</td>
                      <td>{record.trustScore.toFixed(3)}</td>
                      <td>{record.qualityRating}</td>
                      <td>{record.quarantined ? "quarantined" : "active"}</td>
                      <td>{record.overrideMode ?? "-"}</td>
                      <td>
                        <div class="table-actions">
                          <button
                            class="btn-secondary btn-xs"
                            onclick={() => applyTrainingRepositoryOverride(
                              { id: record.id, sourcePath: record.sourcePath, mode: "allow" },
                              { programs: [normalizeProgramName(repositoryProgram)].filter(Boolean), immediate: true, silent: true },
                            )}
                            disabled={repositoryOverrideApplying || !auth.isAdmin}
                          >
                            Allow
                          </button>
                          <button
                            class="btn-secondary btn-xs"
                            onclick={() => applyTrainingRepositoryOverride(
                              { id: record.id, sourcePath: record.sourcePath, mode: "quarantine" },
                              { programs: [normalizeProgramName(repositoryProgram)].filter(Boolean), immediate: true, silent: true },
                            )}
                            disabled={repositoryOverrideApplying || !auth.isAdmin}
                          >
                            Quarantine
                          </button>
                          <button
                            class="btn-secondary btn-xs"
                            onclick={() => applyTrainingRepositoryOverride(
                              { id: record.id, sourcePath: record.sourcePath, mode: "suppress" },
                              { programs: [normalizeProgramName(repositoryProgram)].filter(Boolean), immediate: true, silent: true },
                            )}
                            disabled={repositoryOverrideApplying || !auth.isAdmin}
                          >
                            Suppress
                          </button>
                          <button
                            class="btn-secondary btn-xs"
                            onclick={() => applyTrainingRepositoryOverride(
                              { id: record.id, sourcePath: record.sourcePath, mode: "clear" },
                              { programs: [normalizeProgramName(repositoryProgram)].filter(Boolean), immediate: true, silent: true },
                            )}
                            disabled={repositoryOverrideApplying || !auth.isAdmin}
                          >
                            Clear
                          </button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </article>

        <article class="repository-card">
          <h3>Status, Metrics, Reindex</h3>
          <div class="controls-row">
            <button class="btn-secondary" onclick={() => loadTrainingRepositoryStatusAndMetrics()} disabled={repositoryStatusLoading || repositoryMetricsLoading}>
              {repositoryStatusLoading || repositoryMetricsLoading ? "Loading..." : "Refresh Status/Metrics"}
            </button>
          </div>

          <div class="status-grid">
            <div>
              <h4>Index Queue Status</h4>
              <ul class="compact-list">
                {#if repositoryStatus.length === 0}
                  <li class="muted">No status entries for current filter.</li>
                {:else}
                  {#each repositoryStatus as status}
                    <li>
                      <strong>{status.program}</strong>
                      <span>run:{status.running ? "yes" : "no"}</span>
                      <span>pending:{status.pending ? "yes" : "no"}</span>
                      <span>count:{status.refreshCount}</span>
                      {#if status.lastError}<span class="status-error">error:{status.lastError}</span>{/if}
                    </li>
                  {/each}
                {/if}
              </ul>
            </div>
            <div>
              <h4>Query/Refresh Metrics</h4>
              <ul class="compact-list">
                {#if repositoryMetrics.length === 0}
                  <li class="muted">No metrics entries yet.</li>
                {:else}
                  {#each repositoryMetrics as metric}
                    <li>
                      <strong>{metric.program}</strong>
                      <span>queries:{metric.queryCount}</span>
                      <span>cache:{Math.round(metric.queryCacheHitRate * 100)}%</span>
                      <span>avgQuery:{metric.avgQueryMs}ms</span>
                      <span>refresh:{metric.refreshCount}</span>
                      <span>avgRefresh:{metric.avgRefreshMs}ms</span>
                    </li>
                  {/each}
                {/if}
              </ul>
            </div>
          </div>

          <div class="reindex-panel">
            <h4>Queue Reindex</h4>
            <label class="field">
              <span>Source Paths (optional, one per line)</span>
              <textarea rows="4" bind:value={repositoryReindexSourcePaths} spellcheck="false" placeholder="/path/to/training/folder"></textarea>
            </label>
            <label class="field">
              <span>Training Objective (optional)</span>
              <textarea rows="3" bind:value={repositoryReindexObjective} spellcheck="false"></textarea>
            </label>
            <label class="toggle">
              <input type="checkbox" bind:checked={repositoryReindexImmediate} />
              <span>Run immediately (flush queue)</span>
            </label>
            <button class="btn-primary" onclick={reindexTrainingRepository} disabled={repositoryReindexBusy || !auth.isAdmin}>
              {repositoryReindexBusy ? "Queueing..." : "Queue Reindex"}
            </button>
          </div>
        </article>
      </div>
    </section>
  {/if}

  {#if auth.canManageSecurity && vaultView === "snapshot"}
    <section class="snapshot-panel">
      <h2>Export Entire Server</h2>
      <p class="hint">
        Disaster-recovery backup/restore for the full server state (database + training vault) as a zip file.
      </p>
      <label class="toggle">
        <input type="checkbox" bind:checked={includeServerFiles} />
        <span>Include configured server files</span>
      </label>
      <div class="buttons">
        <button class="btn-secondary" onclick={exportSnapshot} disabled={snapshotBusy}>
          {snapshotBusy ? "Working..." : "Export Entire Server (.zip)"}
        </button>
        <button class="btn-secondary" onclick={promptImportSnapshot} disabled={snapshotBusy}>
          Restore Server From Zip
        </button>
      </div>
    </section>
  {/if}

  {#if vaultView === "vault"}
  <div class="toolbar">
    <button class="btn-secondary" onclick={load} disabled={loading}>Refresh</button>
    <input
      type="text"
      bind:value={search}
      placeholder="Search path, remarks, project/source paths, actor..."
      class="search"
    />
    <select bind:value={selectedProgramFilter}>
      <option value="">All Bridges</option>
      {#each availablePrograms as program}
        <option value={program}>{program}</option>
      {/each}
    </select>
    <select bind:value={selectedRootFilter}>
      <option value="">All Roots</option>
      {#each availableRoots as root}
        <option value={root}>{rootLabel(root)}</option>
      {/each}
    </select>
    <select bind:value={selectedKindFilter}>
      <option value="">All Types</option>
      <option value="directory">Folders</option>
      <option value="file">Files</option>
    </select>
    <select bind:value={selectedMetadataFilter}>
      <option value="all">Metadata: All</option>
      <option value="tagged">Metadata: Tagged</option>
      <option value="untagged">Metadata: Untagged</option>
    </select>
    <select bind:value={selectedSortMode}>
      <option value="updated_desc">Sort: Updated (newest)</option>
      <option value="path_asc">Sort: Path (A-Z)</option>
      <option value="size_desc">Sort: Size (largest)</option>
    </select>
    <select bind:value={selectedGroupMode}>
      <option value="root_program">Group: Root + Bridge</option>
      <option value="root">Group: Root</option>
      <option value="program">Group: Bridge</option>
      <option value="flat">Group: Flat</option>
    </select>
    <button
      class="btn-secondary"
      onclick={() => {
        search = "";
        selectedProgramFilter = "";
        selectedRootFilter = "";
        selectedKindFilter = "";
        selectedMetadataFilter = "all";
      }}
    >
      Clear Filters
    </button>
    <span class="count">
      {visibleRowStats.rows} rows / {entries.length} entries
      · {visibleRowStats.nestedFiles} nested files
      · {filteredStats.files} files
      · {filteredStats.directories} folders
      · {filteredStats.tagged} tagged
      · {formatBytes(filteredStats.bytes)}
    </span>
  </div>

  <section class="job-export-panel">
    <h3>Training Job Metadata + Export</h3>
    <p class="hint">
      Shows normalized job metadata from <code>learning/jobs/...</code> artifacts (user, machine, bridge, model, date, and transport mode like MCP vs CLI/REST).
    </p>
    <div class="job-export-controls">
      <select bind:value={trainingJobSignalFilter}>
        <option value="all">Signal: All</option>
        <option value="positive">Signal: Positive</option>
        <option value="average">Signal: Average</option>
        <option value="negative">Signal: Negative</option>
      </select>
      <select bind:value={trainingJobTransportFilter}>
        <option value="all">Transport: All</option>
        <option value="mcp">Transport: MCP</option>
        <option value="cli_rest">Transport: CLI/REST</option>
        <option value="mixed">Transport: Mixed</option>
        <option value="unknown">Transport: Unknown</option>
      </select>
      <label class="inline-field">
        <span>Limit</span>
        <input type="number" min="20" max="5000" bind:value={trainingJobLimit} />
      </label>
      <button class="btn-secondary" onclick={() => loadTrainingJobs()} disabled={trainingJobsLoading}>
        {trainingJobsLoading ? "Loading..." : "Refresh Job Metadata"}
      </button>
      <button class="btn-secondary" onclick={() => exportTrainingData("job")} disabled={trainingJobExportBusy}>
        Export Selected Job
      </button>
      <button class="btn-secondary" onclick={() => exportTrainingData("selected")} disabled={trainingJobExportBusy}>
        Export Checked Jobs
      </button>
      <button class="btn-secondary" onclick={() => exportTrainingData("program")} disabled={trainingJobExportBusy}>
        Export Selected Bridge
      </button>
      <button class="btn-secondary" onclick={() => exportTrainingData("filtered")} disabled={trainingJobExportBusy}>
        Export Current Filters
      </button>
      <button class="btn-secondary" onclick={() => exportTrainingData("all")} disabled={trainingJobExportBusy}>
        Export All Training Data
      </button>
      <button class="btn-secondary" onclick={clearCheckedTrainingJobs} disabled={checkedTrainingJobIds.length === 0}>
        Clear Checks
      </button>
    </div>
    <div class="job-export-meta">
      <span>{trainingJobs.length} rows</span>
      <span>Updated: {formatDate(trainingJobsLastUpdatedAt)}</span>
      <span>Checked jobs: {checkedTrainingJobIds.length}</span>
      <span>Selected job: {selectedTrainingJobId() ?? "-"}</span>
    </div>
    <div class="job-export-table-wrap">
      <table class="job-export-table">
        <thead>
          <tr>
            <th>Pick</th>
            <th>Job</th>
            <th>Bridge</th>
            <th>Signal</th>
            <th>Model/Engine</th>
            <th>Transport</th>
            <th>Worker</th>
            <th>User</th>
            <th>Dates</th>
          </tr>
        </thead>
        <tbody>
          {#if trainingJobsLoading}
            <tr><td colspan="9" class="muted">Loading training job metadata...</td></tr>
          {:else if trainingJobs.length === 0}
            <tr><td colspan="9" class="muted">No training job metadata matched current filters.</td></tr>
          {:else}
            {#each trainingJobs as row}
              <tr>
                <td>
                  <input
                    type="checkbox"
                    checked={isTrainingJobChecked(row.jobId)}
                    onchange={(event) => {
                      const target = event.currentTarget as HTMLInputElement;
                      setTrainingJobChecked(row.jobId, !!target?.checked);
                    }}
                  />
                </td>
                <td>
                  <div class="job-cell-title">{row.name || row.jobId}</div>
                  <div class="job-cell-sub">#{row.jobId.slice(0, 8)} · {row.artifactCount} artifacts</div>
                </td>
                <td>
                  <div>{row.program}</div>
                  <div class="job-cell-sub">{row.usedBridges.join(", ") || row.bridgeProgram || "-"}</div>
                </td>
                <td>{row.signal}</td>
                <td>
                  <div>{row.model || "-"}</div>
                  <div class="job-cell-sub">{row.agentEngine || "-"}</div>
                </td>
                <td>{row.transport}</td>
                <td>
                  <div>{row.workerName || "-"}</div>
                  <div class="job-cell-sub">{row.targetWorkerName || "-"}</div>
                </td>
                <td>
                  <div>{row.submittedByUsername || "-"}</div>
                  <div class="job-cell-sub">{row.outcomeMarkedByUsername || "-"}</div>
                </td>
                <td>
                  <div>{formatDate(row.completedAt || row.storedAt)}</div>
                  <div class="job-cell-sub">Created: {formatDate(row.createdAt)}</div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>

  <div class="layout">
    <section class="list-panel">
      <h2>Training Vault</h2>
      <p class="hint">
        Global folder view: <code>training/</code> with <code>scripts/</code>, <code>playbooks/</code>, and <code>learning/</code>.
      </p>
      <p class="hint">
        Use zip import/export for training-data exchange. Full server backup/restore remains in <strong>Snapshots</strong>.
      </p>
      <div class="buttons">
        <button class="btn-secondary" onclick={() => exportTrainingData("all")} disabled={trainingJobExportBusy}>
          Export All Training Data (.zip)
        </button>
        <button class="btn-secondary" onclick={promptImportTrainingZip} disabled={trainingImportBusy}>
          {trainingImportBusy ? "Importing..." : "Import Training Data (.zip)"}
        </button>
      </div>
      <input
        type="file"
        accept=".zip,application/zip"
        bind:this={trainingZipFileInput}
        style="display:none"
        onchange={importTrainingZipFile}
      />

      <div class="create-grid">
        <label class="field">
          <span>File Path</span>
          <input bind:value={createFilePath} placeholder="learning/manual/new-note.md" />
        </label>
        <label class="field">
          <span>Folder Path</span>
          <input bind:value={createFolderPath} placeholder="learning/manual" />
        </label>
        <div class="buttons">
          <button class="btn-primary" onclick={createFile}>Add or Update File</button>
          <button class="btn-secondary" onclick={createFolder}>Create Folder</button>
        </div>
      </div>

      <label class="field">
        <span>New File Content</span>
        <textarea rows="4" bind:value={createFileContent} spellcheck="false"></textarea>
      </label>

      <div class="entry-list">
        {#if loading}
          <div class="muted">Loading training files...</div>
        {:else if visibleRowStats.rows === 0}
          <div class="muted">No files found.</div>
        {:else}
          {#each groupedEntries as group}
            <div class="entry-group">
              <div class="entry-group-head">
                <strong>{group.label}</strong>
                <span class="entry-group-meta">
                  {group.rows.length} rows · {group.taggedCount} tagged · {formatBytes(group.bytes)}
                </span>
              </div>
              {#each group.rows as row}
                {#if row.kind === "entry"}
                  <button
                    class="entry-row"
                    class:selected={selectedPath === row.entry.path}
                    onclick={() => openEntry(row.entry)}
                  >
                    <span class="entry-kind">{row.entry.kind === "directory" ? "DIR" : "FILE"}</span>
                    <span class="entry-path-wrap">
                      <span class="entry-leaf">{pathLeaf(row.entry.path)}</span>
                      <span class="entry-path">{pathParent(row.entry.path)}</span>
                    </span>
                    <span class="entry-meta">
                      <span>{formatDate(row.entry.updatedAt)}</span>
                      {#if row.entry.program}<span class="program-chip">{row.entry.program}</span>{/if}
                      {#if row.entry.metadata}<span class="meta-chip">tagged</span>{/if}
                      {row.entry.kind === "file" ? formatBytes(row.entry.bytes) : ""}
                    </span>
                  </button>
                {:else}
                  <button
                    class="entry-row training-job-row"
                    class:selected={selectedPath === row.job.jobPath}
                    onclick={() => {
                      toggleTrainingJob(row.job.jobPath);
                      void openTrainingJob(row.job);
                    }}
                  >
                    <span class="entry-kind">{isTrainingJobExpanded(row.job.jobPath) ? "JOB ▼" : "JOB ▶"}</span>
                    <span class="entry-path-wrap">
                      <span class="entry-leaf">{row.job.jobLabel}</span>
                      <span class="entry-path">learning/jobs/{row.job.program}</span>
                    </span>
                    <span class="entry-meta">
                      <span>#{row.job.jobId.slice(0, 8)}</span>
                      <span>{row.job.files.length} files</span>
                      <span>{formatDate(row.job.updatedAt)}</span>
                      <span class="program-chip">{row.job.program}</span>
                      {#if row.job.taggedCount > 0}<span class="meta-chip">{row.job.taggedCount} tagged</span>{/if}
                      <span>{formatBytes(row.job.bytes)}</span>
                    </span>
                  </button>
                  {#if isTrainingJobExpanded(row.job.jobPath)}
                    {#if row.job.files.length === 0}
                      <div class="entry-row entry-row-child entry-row-empty">
                        <span class="entry-kind">INFO</span>
                        <span class="entry-path-wrap">
                          <span class="entry-leaf">No nested files</span>
                          <span class="entry-path">{row.job.jobPath}</span>
                        </span>
                        <span class="entry-meta"></span>
                      </div>
                    {:else}
                      {#each row.job.files as fileEntry}
                        <button
                          class="entry-row entry-row-child"
                          class:selected={selectedPath === fileEntry.path}
                          onclick={() => openEntry(fileEntry)}
                        >
                          <span class="entry-kind">FILE</span>
                          <span class="entry-path-wrap">
                            <span class="entry-leaf">{pathLeaf(fileEntry.path)}</span>
                            <span class="entry-path">{nestedPathUnderJob(row.job.jobPath, fileEntry.path)}</span>
                          </span>
                          <span class="entry-meta">
                            <span>{formatDate(fileEntry.updatedAt)}</span>
                            {#if fileEntry.metadata}<span class="meta-chip">tagged</span>{/if}
                            {formatBytes(fileEntry.bytes)}
                          </span>
                        </button>
                      {/each}
                    {/if}
                  {/if}
                {/if}
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </section>

    <section class="editor-panel">
      {#if !selectedPath}
        <div class="placeholder">Select a file or folder from the training vault list.</div>
      {:else if selectedKind === "directory"}
        <h3>{selectedPath}</h3>
        <p class="hint">Folder selected. Use this to organize training files.</p>
        <div class="metadata-panel">
          <h4>Training Metadata</h4>
          <div class="metadata-grid">
            <div><strong>Created</strong> {formatDate(selectedMetadata?.createdAt ?? null)}</div>
            <div><strong>Created By</strong> {formatActor(selectedMetadata?.createdBy)}</div>
            <div><strong>Updated</strong> {formatDate(selectedMetadata?.updatedAt ?? null)}</div>
            <div><strong>Updated By</strong> {formatActor(selectedMetadata?.updatedBy)}</div>
          </div>
          <label class="field">
            <span>Project Paths (one per line)</span>
            <textarea rows="4" bind:value={metadataProjectPaths} spellcheck="false"></textarea>
          </label>
          <label class="field">
            <span>Source Paths (one per line)</span>
            <textarea rows="4" bind:value={metadataSourcePaths} spellcheck="false"></textarea>
          </label>
          <label class="field">
            <span>Remarks</span>
            <textarea rows="4" bind:value={metadataRemarks} spellcheck="false"></textarea>
          </label>
          <button class="btn-secondary" onclick={saveSelectedMetadata} disabled={savingMetadata}>
            {savingMetadata ? "Saving..." : "Save Metadata"}
          </button>
        </div>
        <button
          class="btn-danger"
          onclick={deleteSelectedFolder}
          disabled={isVaultRoot(selectedPath)}
        >
          Remove Folder From Vault
        </button>
      {:else}
        <div class="editor-header">
          <h3>{selectedPath}</h3>
          <div class="meta">
            <span>{selectedBytes != null ? formatBytes(selectedBytes) : "-"}</span>
            <span>{formatDate(selectedUpdatedAt)}</span>
          </div>
        </div>
        <textarea
          class="editor"
          rows="24"
          bind:value={selectedContent}
          spellcheck="false"
          disabled={reading || saving || isTrainingJobArtifactPath(selectedPath)}
        ></textarea>
        <div class="editor-actions">
          {#if isTrainingJobArtifactPath(selectedPath)}
            <button class="btn-secondary" onclick={downloadSelectedFile} disabled={reading}>
              Download File
            </button>
            <button class="btn-secondary" onclick={() => exportTrainingData("job")} disabled={trainingJobExportBusy}>
              Export Related Job Data (.zip)
            </button>
          {:else}
            <button class="btn-primary" onclick={saveSelected} disabled={saving || reading}>
              {saving ? "Saving..." : "Save In Vault"}
            </button>
            <button class="btn-danger" onclick={deleteSelectedFile} disabled={saving || reading}>
              Remove File From Vault
            </button>
          {/if}
        </div>
        {#if isTrainingJobArtifactPath(selectedPath)}
          <p class="hint hint-inline">Job artifacts are read-only here. Export as zip for exchange, or update via a new training run.</p>
        {:else}
          <p class="hint hint-inline">This writes to server Training Vault storage.</p>
        {/if}
        <div class="metadata-panel">
          <h4>Training Metadata</h4>
          <div class="metadata-grid">
            <div><strong>Created</strong> {formatDate(selectedMetadata?.createdAt ?? null)}</div>
            <div><strong>Created By</strong> {formatActor(selectedMetadata?.createdBy)}</div>
            <div><strong>Updated</strong> {formatDate(selectedMetadata?.updatedAt ?? null)}</div>
            <div><strong>Updated By</strong> {formatActor(selectedMetadata?.updatedBy)}</div>
          </div>
          <label class="field">
            <span>Project Paths (one per line)</span>
            <textarea rows="4" bind:value={metadataProjectPaths} spellcheck="false"></textarea>
          </label>
          <label class="field">
            <span>Source Paths (one per line)</span>
            <textarea rows="4" bind:value={metadataSourcePaths} spellcheck="false"></textarea>
          </label>
          <label class="field">
            <span>Remarks</span>
            <textarea rows="4" bind:value={metadataRemarks} spellcheck="false"></textarea>
          </label>
          <button class="btn-secondary" onclick={saveSelectedMetadata} disabled={savingMetadata || saving || reading}>
            {savingMetadata ? "Saving..." : "Save Metadata"}
          </button>
        </div>
      {/if}
    </section>
  </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmOpen}
  title={confirmTitle}
  message={confirmMessage}
  confirmText="Confirm"
  variant="danger"
  onconfirm={handleConfirm}
  oncancel={() => { confirmOpen = false; }}
/>

<style>
  .page {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .policy-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .policy-panel h2 {
    font-size: var(--font-size-lg);
  }

  .policy-toggle {
    margin-top: 2px;
  }

  .policy-meta {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .bridge-selector {
    margin: 8px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .bridge-selector-summary {
    padding: 8px 12px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .bridge-selector-summary:hover { color: var(--text-primary); }
  .bridge-selector-list {
    padding: 4px 12px 8px;
    max-height: 300px;
    overflow-y: auto;
  }

  .repository-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .view-switcher {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .snapshot-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .repository-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .repository-head h2 {
    font-size: var(--font-size-lg);
  }

  .repository-head-actions {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .field.compact {
    min-width: 140px;
    max-width: 220px;
  }

  .repository-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .repository-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .repository-card h3 {
    font-size: var(--font-size-base);
  }

  .repository-card h4 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .repository-card-wide {
    grid-column: span 2;
  }

  .stats-inline {
    display: flex;
    gap: 10px;
    align-items: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .inline-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .controls-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .records-controls {
    align-items: end;
  }

  .compact-table {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: auto;
    max-height: 260px;
  }

  .compact-table.records-table {
    max-height: 340px;
  }

  .compact-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .compact-table th,
  .compact-table td {
    border-bottom: 1px solid var(--border);
    padding: 6px 8px;
    vertical-align: top;
    text-align: left;
  }

  .compact-table th {
    position: sticky;
    top: 0;
    background: var(--bg-surface);
    z-index: 1;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .compact-table tr:last-child td {
    border-bottom: none;
  }

  .mono-cell {
    font-family: var(--font-mono);
    word-break: break-all;
  }

  .muted-cell {
    color: var(--text-muted);
    text-align: center;
  }

  .muted-sub {
    color: var(--text-muted);
    font-size: 11px;
  }

  .table-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .btn-xs {
    padding: 4px 6px;
    font-size: 11px;
  }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .compact-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .compact-list li {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .status-error {
    color: #e8abab;
  }

  .reindex-panel {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .job-export-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .job-export-panel h3 {
    font-size: var(--font-size-base);
  }

  .job-export-controls {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .inline-field {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
  }

  .inline-field span {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .inline-field input {
    width: 92px;
  }

  .job-export-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .job-export-table-wrap {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    overflow: auto;
    max-height: 320px;
  }

  .job-export-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .job-export-table th,
  .job-export-table td {
    border-bottom: 1px solid var(--border);
    padding: 7px 8px;
    vertical-align: top;
    text-align: left;
    white-space: nowrap;
  }

  .job-export-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-weight: 600;
  }

  .job-export-table tr:last-child td {
    border-bottom: none;
  }

  .job-cell-title {
    color: var(--text-primary);
    font-weight: 600;
    white-space: normal;
  }

  .job-cell-sub {
    color: var(--text-muted);
    font-size: 11px;
    white-space: normal;
  }

  .hidden-file-input {
    display: none;
  }

  .toggle {
    display: inline-flex;
    align-items: flex-start;
    gap: 6px;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .toggle input {
    margin-top: 2px;
  }

  .search {
    flex: 1;
    min-width: 220px;
  }

  .count {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(340px, 40%) 1fr;
    gap: 14px;
    min-height: calc(100vh - 170px);
  }

  .list-panel,
  .editor-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 12px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .list-panel h2 {
    font-size: var(--font-size-lg);
  }

  .hint {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    line-height: 1.4;
  }

  .field {
    display: block;
  }

  .field span {
    display: block;
    margin-bottom: 4px;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .field input,
  .field textarea {
    width: 100%;
  }

  .create-grid {
    display: grid;
    gap: 8px;
  }

  .buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .entry-list {
    margin-top: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    overflow: auto;
    min-height: 220px;
  }

  .entry-group {
    border-bottom: 1px solid var(--border);
  }

  .entry-group:last-child {
    border-bottom: none;
  }

  .entry-group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }

  .entry-group-meta {
    color: var(--text-muted);
    font-size: 12px;
  }

  .entry-row {
    width: 100%;
    display: grid;
    grid-template-columns: 54px 1fr auto;
    gap: 8px;
    align-items: center;
    text-align: left;
    border-bottom: 1px solid var(--border);
    padding: 8px 10px;
    color: var(--text-secondary);
    background: transparent;
  }

  .entry-row:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .entry-row.selected {
    background: var(--bg-active);
    color: var(--text-primary);
  }

  .training-job-row {
    background: var(--bg-surface);
  }

  .entry-row-child {
    padding-left: 24px;
    background: color-mix(in srgb, var(--bg-base) 86%, var(--bg-surface) 14%);
  }

  .entry-row-empty {
    cursor: default;
  }

  .entry-row-empty .entry-meta {
    display: none;
  }

  .entry-kind {
    font-size: 10px;
    letter-spacing: 0.4px;
    color: var(--text-muted);
  }

  .entry-path-wrap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .entry-leaf {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-path {
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .entry-meta {
    font-size: 11px;
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }

  .program-chip {
    display: inline-flex;
    align-items: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
    letter-spacing: 0.2px;
  }

  .meta-chip {
    display: inline-flex;
    align-items: center;
    background: #24433a;
    border: 1px solid #2f6e57;
    color: #bde8d5;
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
    letter-spacing: 0.2px;
  }

  .placeholder {
    color: var(--text-muted);
    margin: auto;
  }

  .editor-header {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
  }

  .editor-header h3 {
    font-size: var(--font-size-base);
    font-family: var(--font-mono);
    word-break: break-word;
  }

  .meta {
    display: flex;
    gap: 10px;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .editor {
    width: 100%;
    min-height: 280px;
    resize: vertical;
    font-family: var(--font-mono);
  }

  .editor-actions {
    display: flex;
    gap: 8px;
  }

  .hint-inline {
    margin-top: -4px;
    margin-bottom: 8px;
  }

  .metadata-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .metadata-panel h4 {
    font-size: var(--font-size-base);
  }

  .metadata-grid {
    display: grid;
    gap: 6px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .metadata-grid strong {
    color: var(--text-primary);
    margin-right: 6px;
  }

  .muted {
    color: var(--text-muted);
    padding: 10px;
  }

  .btn-primary {
    background: var(--accent);
    color: #fff;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--text-secondary);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-secondary.activeView {
    border: 1px solid var(--accent);
    color: var(--accent);
    background: var(--bg-hover);
  }

  .btn-danger {
    background: #6f2a2a;
    color: #ffd7d7;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }

  .btn-danger:hover:not(:disabled) {
    background: #843232;
  }

  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
  }

  @media (max-width: 1080px) {
    .repository-grid {
      grid-template-columns: 1fr;
    }

    .repository-card-wide {
      grid-column: span 1;
    }

    .inline-grid,
    .status-grid {
      grid-template-columns: 1fr;
    }

    .layout {
      grid-template-columns: 1fr;
      min-height: auto;
    }

    .job-export-controls {
      align-items: stretch;
    }

    .metadata-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
