<script lang="ts">
  import type { Job, JobInterventionSupport } from "@arkestrator/protocol";
  import { jobs } from "../lib/stores/jobs.svelte";
  import { workersStore } from "../lib/stores/workers.svelte";
  import { sendMessage } from "../lib/api/ws";
  import { api } from "../lib/api/rest";
  import { toast } from "../lib/stores/toast.svelte";
  import Badge from "../lib/components/ui/Badge.svelte";
  import ConfirmDialog from "../lib/components/ui/ConfirmDialog.svelte";
  import { timeAgo, truncate } from "../lib/utils/format";
  import { agents } from "../lib/stores/agents.svelte";

  function getAgentLabel(job: Job): { short: string; full: string } | null {
    const configId = job.actualAgentConfigId ?? job.agentConfigId;
    if (!configId || configId === "auto") return null;
    const config = agents.all.find((a) => a.id === configId);
    const name = config?.name ?? configId.slice(0, 8);
    const model = job.actualModel ?? config?.model;
    if (!model) return { short: name, full: name };
    return { short: `${name}/${model}`, full: `${name} (${model})` };
  }

  type LogScrollMode = "live" | "slow" | "paused";
  type OutcomeRating = "good" | "average" | "poor";

  function toOutcomeDraft(rating?: string | null): OutcomeRating | null {
    const normalized = String(rating ?? "").trim().toLowerCase();
    if (normalized === "good" || normalized === "positive") return "good";
    if (normalized === "average") return "average";
    if (normalized === "poor" || normalized === "negative") return "poor";
    return null;
  }

  function outcomeLabel(rating?: string | null): string {
    const draft = toOutcomeDraft(rating);
    if (draft === "good") return "good";
    if (draft === "average") return "average";
    if (draft === "poor") return "poor";
    return "unrated";
  }

  /** Svelte action: auto-scroll a <pre> element when content changes (live/slow/paused).
   *  Uses requestAnimationFrame polling instead of MutationObserver to avoid
   *  firing synchronous scroll calculations on every DOM character insertion. */
  function autoscroll(node: HTMLElement, mode: LogScrollMode = "live") {
    let rafId: number | null = null;
    let lastScrollHeight = 0;

    function scrollTick() {
      rafId = null;
      if (mode === "paused") return;
      const sh = node.scrollHeight;
      // Only scroll if content actually grew (avoids no-op recalcs)
      if (sh === lastScrollHeight) {
        scheduleCheck();
        return;
      }
      lastScrollHeight = sh;
      const target = Math.max(0, sh - node.clientHeight);
      if (mode === "slow") {
        const remaining = target - node.scrollTop;
        if (remaining > 0) {
          const step = Math.max(24, Math.ceil(remaining * 0.25));
          node.scrollTop = Math.min(target, node.scrollTop + step);
        }
      } else {
        node.scrollTop = target;
      }
      scheduleCheck();
    }

    function scheduleCheck() {
      if (rafId == null) {
        rafId = requestAnimationFrame(scrollTick);
      }
    }

    scheduleCheck();
    return {
      update(nextMode: LogScrollMode) {
        mode = nextMode;
        if (mode !== "paused") scheduleCheck();
      },
      destroy() {
        if (rafId != null) cancelAnimationFrame(rafId);
      },
    };
  }

  // Confirm dialog state
  let confirmOpen = $state(false);
  let confirmTitle = $state("");
  let confirmMessage = $state("");
  let confirmAction = $state<(() => void) | null>(null);

  function showConfirm(title: string, message: string, action: () => void) {
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

  function handleCancel() {
    confirmOpen = false;
    confirmAction = null;
  }

  interface JobNode {
    job: Job;
    children: JobNode[];
    depth: number;
  }

  /** Track which parent jobs are collapsed (children hidden). Parents start collapsed. */
  let collapsedParents = $state(new Set<string>());
  let collapsedInitialized = $state(false);

  function toggleCollapse(jobId: string, e: Event) {
    e.stopPropagation();
    const next = new Set(collapsedParents);
    if (next.has(jobId)) {
      next.delete(jobId);
    } else {
      next.add(jobId);
    }
    collapsedParents = next;
  }

  interface FilterOption {
    value: string;
    label: string;
  }

  interface DelegationSummary {
    childCount: number;
    activeCount: number;
    runningCount: number;
    failedCount: number;
    completedCount: number;
  }

  const EMPTY_DELEGATION_SUMMARY: DelegationSummary = {
    childCount: 0,
    activeCount: 0,
    runningCount: 0,
    failedCount: 0,
    completedCount: 0,
  };

  const statuses = ["all", "paused", "queued", "running", "completed", "failed", "cancelled"];
  const ALL_OPTION = "__all__";
  let searchQuery = $state("");
  let workerFilter = $state(ALL_OPTION);
  let bridgeFilter = $state(ALL_OPTION);
  let userFilter = $state(ALL_OPTION);

  function isActiveJobStatus(status: Job["status"]): boolean {
    return status === "queued" || status === "running" || status === "paused";
  }

  function canDeleteJob(job: Job): boolean {
    return !!job?.id;
  }

  function normalizedText(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
  }

  function shortId(value?: string): string {
    const text = String(value ?? "").trim();
    return text ? `#${text.slice(0, 8)}` : "Unknown";
  }

  function formatUsd(value?: number): string {
    const amount = Number(value ?? 0);
    if (!(amount > 0)) return "$0.00";
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: amount < 0.01 ? 4 : 2,
      maximumFractionDigits: amount < 0.01 ? 4 : 2,
    }).format(amount);
  }

  function getJobUserValue(job: Job): string {
    return normalizedText(job.submittedByUsername || job.submittedBy);
  }

  function getJobUserLabel(job: Job): string {
    const username = String(job.submittedByUsername ?? "").trim();
    if (username) return username;
    const submittedBy = String(job.submittedBy ?? "").trim();
    return submittedBy ? shortId(submittedBy) : "Unknown";
  }

  function getJobWorkerLabels(job: Job): string[] {
    const out = new Map<string, string>();
    const worker = String(job.workerName ?? "").trim();
    const targetWorker = String(job.targetWorkerName ?? "").trim();
    if (worker) out.set(normalizedText(worker), worker);
    if (targetWorker) out.set(normalizedText(targetWorker), targetWorker);
    return [...out.values()];
  }

  let jobsById = $derived.by(() => new Map(jobs.all.map((job) => [job.id, job])));
  let childJobsByParent = $derived.by(() => {
    const out = new Map<string, Job[]>();
    for (const job of jobs.all) {
      if (!job.parentJobId) continue;
      const list = out.get(job.parentJobId) ?? [];
      list.push(job);
      out.set(job.parentJobId, list);
    }
    return out;
  });
  let delegationSummaryByJobId = $derived.by(() => {
    const out = new Map<string, DelegationSummary>();
    const visiting = new Set<string>();
    function summarize(jobId: string): DelegationSummary {
      const cached = out.get(jobId);
      if (cached) return cached;
      if (visiting.has(jobId)) return EMPTY_DELEGATION_SUMMARY;
      visiting.add(jobId);
      const summary: DelegationSummary = {
        childCount: 0,
        activeCount: 0,
        runningCount: 0,
        failedCount: 0,
        completedCount: 0,
      };
      for (const child of childJobsByParent.get(jobId) ?? []) {
        summary.childCount += 1;
        if (isActiveJobStatus(child.status)) summary.activeCount += 1;
        if (child.status === "running") summary.runningCount += 1;
        if (child.status === "failed") summary.failedCount += 1;
        if (child.status === "completed") summary.completedCount += 1;
        const nested = summarize(child.id);
        summary.childCount += nested.childCount;
        summary.activeCount += nested.activeCount;
        summary.runningCount += nested.runningCount;
        summary.failedCount += nested.failedCount;
        summary.completedCount += nested.completedCount;
      }
      visiting.delete(jobId);
      out.set(jobId, summary);
      return summary;
    }
    for (const job of jobs.all) summarize(job.id);
    return out;
  });

  function getDelegationSummary(job: Job): DelegationSummary {
    return delegationSummaryByJobId.get(job.id) ?? EMPTY_DELEGATION_SUMMARY;
  }

  function getParentJob(job: Job): Job | null {
    if (!job.parentJobId) return null;
    return jobsById.get(job.parentJobId) ?? null;
  }

  function getRootJob(job: Job): Job | null {
    let parentId = job.parentJobId;
    let current: Job | undefined;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      current = jobsById.get(parentId);
      if (!current) return null;
      parentId = current.parentJobId;
    }
    return current ?? null;
  }

  function formatJobUsage(job: Job): string {
    if (!job.tokenUsage) return "";
    return `${job.tokenUsage.inputTokens.toLocaleString()} in / ${job.tokenUsage.outputTokens.toLocaleString()} out`;
  }

  function getJobBridgeTokens(job: Job): string[] {
    const out = new Set<string>();
    for (const used of job.usedBridges ?? []) {
      const token = normalizedText(used);
      if (token) out.add(token);
    }
    return [...out];
  }

  function getJobWorkerTokens(job: Job): string[] {
    const out = new Set<string>();
    const worker = normalizedText(job.workerName);
    const targetWorker = normalizedText(job.targetWorkerName);
    if (worker) out.add(worker);
    if (targetWorker) out.add(targetWorker);
    return [...out];
  }

  function clearAdvancedFilters() {
    searchQuery = "";
    workerFilter = ALL_OPTION;
    bridgeFilter = ALL_OPTION;
    userFilter = ALL_OPTION;
  }

  function programIcon(program?: string): string {
    switch (program) {
      case "godot": return "G";
      case "blender": return "B";
      case "houdini": return "H";
      case "comfyui": return "C";
      case "unity": return "U";
      case "unreal": return "UE";
      default: return "";
    }
  }

  function setFilter(status: string) {
    jobs.statusFilter = status === "all" ? [] : [status];
  }

  function selectJob(id: string) {
    jobs.selectedId = jobs.selectedId === id ? null : id;
  }

  async function refreshJobs() {
    try {
      const data = await api.jobs.list();
      jobs.replaceAll(data.jobs);
    } catch {
      // Fallback to WS if REST fails
      sendMessage({ type: "job_list", id: crypto.randomUUID(), payload: {} });
    }
  }

  async function cancelJob(jobId: string) {
    try {
      await api.jobs.cancel(jobId);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to cancel job: ${err.message}`);
    }
  }

  async function reprioritize(jobId: string, priority: string) {
    try {
      await api.jobs.reprioritize(jobId, priority);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to reprioritize: ${err.message}`);
    }
  }

  async function resumeJob(jobId: string) {
    try {
      await api.jobs.resume(jobId);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to resume job: ${err.message}`);
    }
  }

  async function dispatchJob(jobId: string) {
    try {
      await api.jobs.dispatch(jobId);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to start job: ${err.message}`);
    }
  }

  async function startAll() {
    const paused = jobs.all.filter((j) => j.status === "paused");
    let failures = 0;
    for (const job of paused) {
      try {
        await api.jobs.resume(job.id);
      } catch {
        failures++;
      }
    }
    if (failures > 0) {
      toast.error(`Failed to resume ${failures} of ${paused.length} job(s)`);
    }
    refreshJobs();
  }

  async function requeueJob(jobId: string) {
    try {
      await api.jobs.requeue(jobId);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to requeue job: ${err.message}`);
    }
  }

  function confirmDeleteJob(job: Job) {
    const message = isActiveJobStatus(job.status)
      ? "This job is still active. It will be cancelled first, then deleted. This action cannot be undone."
      : "Are you sure you want to delete this job? This action cannot be undone.";
    showConfirm("Delete Job", message, async () => {
      try {
        await api.jobs.delete(job.id);
        if (jobs.selectedId === job.id) jobs.selectedId = null;
        refreshJobs();
      } catch (err: any) {
        toast.error(`Failed to delete job: ${err.message}`);
      }
    });
  }

  function confirmBulkDelete() {
    const ids = [...jobs.selectedIds];
    if (ids.length === 0) return;
    const activeCount = jobs.all.filter((job) => ids.includes(job.id) && isActiveJobStatus(job.status)).length;
    const message = activeCount > 0
      ? `Delete ${ids.length} job(s)? ${activeCount} active job(s) will be cancelled first, then deleted. This action cannot be undone.`
      : `Are you sure you want to delete ${ids.length} job(s)? This action cannot be undone.`;
    showConfirm("Delete Selected Jobs", message, async () => {
      try {
        await api.jobs.bulkDelete(ids);
        jobs.clearSelection();
        jobs.selectedId = null;
        refreshJobs();
      } catch (err: any) {
        toast.error(`Failed to bulk delete: ${err.message}`);
      }
    });
  }

  async function removeDep(jobId: string, depJobId: string) {
    try {
      await api.jobs.removeDependency(jobId, depJobId);
      refreshJobs();
    } catch (err: any) {
      toast.error(`Failed to remove dependency: ${err.message}`);
    }
  }

  function toggleCheckbox(e: Event, jobId: string) {
    e.stopPropagation();
    jobs.toggleSelect(jobId);
  }

  function toggleSelectAll() {
    const visibleIds = filteredJobs.map((job) => job.id);
    if (visibleIds.length === 0) return;
    const allVisibleSelected = visibleIds.every((id) => jobs.selectedIds.has(id));
    const next = new Set(jobs.selectedIds);
    if (allVisibleSelected) {
      for (const id of visibleIds) next.delete(id);
    } else {
      for (const id of visibleIds) next.add(id);
    }
    jobs.selectedIds = next;
  }

  // Filter dropdown options only need rebuilding when jobs are added/removed,
  // not on every status/token update. Reading listStructureVersion establishes
  // this coarser-grained dependency.
  let workerOptions = $derived.by(() => {
    void jobs.listStructureVersion;
    const values = new Map<string, string>();
    for (const job of jobs.all) {
      for (const label of getJobWorkerLabels(job)) {
        const value = normalizedText(label);
        if (value && !values.has(value)) values.set(value, label);
      }
    }
    for (const worker of workersStore.workers) {
      const label = String(worker.name ?? "").trim();
      const value = normalizedText(label);
      if (value && !values.has(value)) values.set(value, label);
    }
    for (const bridge of workersStore.bridges) {
      const label = String(bridge.workerName ?? "").trim();
      const value = normalizedText(label);
      if (value && !values.has(value)) values.set(value, label);
    }
    return [...values.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }))
      .map(([value, label]) => ({ value, label } satisfies FilterOption));
  });

  let bridgeOptions = $derived.by(() => {
    void jobs.listStructureVersion;
    const values = new Set<string>();
    for (const job of jobs.all) {
      for (const token of getJobBridgeTokens(job)) values.add(token);
    }
    return [...values].sort();
  });

  let userOptions = $derived.by(() => {
    void jobs.listStructureVersion;
    const values = new Map<string, string>();
    for (const job of jobs.all) {
      const value = getJobUserValue(job);
      if (!value) continue;
      values.set(value, getJobUserLabel(job));
    }
    return [...values.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }))
      .map(([value, label]) => ({ value, label } satisfies FilterOption));
  });

  let filteredJobs = $derived.by(() => {
    const query = normalizedText(searchQuery);
    const queryTokens = query.split(/\s+/).filter(Boolean);
    const activeStatus = jobs.statusFilter;
    return jobs.all.filter((job) => {
      if (activeStatus.length > 0 && !activeStatus.includes(job.status)) return false;

      const workers = getJobWorkerTokens(job);
      const bridges = getJobBridgeTokens(job);
      const submittedBy = getJobUserValue(job);

      if (workerFilter !== ALL_OPTION && !workers.includes(workerFilter)) return false;
      if (bridgeFilter !== ALL_OPTION && !bridges.includes(bridgeFilter)) return false;
      if (userFilter !== ALL_OPTION && submittedBy !== userFilter) return false;

      if (queryTokens.length === 0) return true;
      const haystack = [
        job.id,
        job.name,
        job.prompt,
        job.status,
        job.workerName,
        job.targetWorkerName,
        job.bridgeId,
        job.bridgeProgram,
        ...(job.usedBridges ?? []),
        job.submittedBy,
        job.submittedByUsername,
        job.parentJobId,
      ]
        .map((value) => normalizedText(value))
        .filter(Boolean)
        .join(" ");
      return queryTokens.every((token) => haystack.includes(token));
    });
  });

  /** Build a tree of jobs: sub-jobs (parentJobId) nest under orchestrator; dependsOn nests when no parentJobId */
  let jobTree = $derived.by(() => {
    const filtered = filteredJobs;
    const filteredSet = new Set(filtered.map((j) => j.id));
    const childIds = new Set<string>();
    for (const job of filtered) {
      // Primary: MCP sub-jobs nest under their orchestrator via parentJobId
      if (job.parentJobId && filteredSet.has(job.parentJobId)) {
        childIds.add(job.id);
      }
      // Fallback: legacy dependsOn nesting only when parentJobId is not set
      else if (!job.parentJobId && job.dependsOn) {
        for (const depId of job.dependsOn) {
          if (filteredSet.has(depId)) {
            childIds.add(job.id);
            break;
          }
        }
      }
    }
    const visited = new Set<string>();
    function buildChildren(parentId: string, depth: number): JobNode[] {
      if (visited.has(parentId) || depth > 20) return [];
      visited.add(parentId);
      const children: JobNode[] = [];
      for (const j of filtered) {
        if (j.parentJobId === parentId) {
          children.push({ job: j, children: buildChildren(j.id, depth + 1), depth });
        } else if (!j.parentJobId && j.dependsOn?.includes(parentId)) {
          children.push({ job: j, children: buildChildren(j.id, depth + 1), depth });
        }
      }
      return children;
    }
    const nodes: JobNode[] = [];
    for (const job of filtered) {
      if (!childIds.has(job.id)) {
        nodes.push({ job, children: buildChildren(job.id, 1), depth: 0 });
      }
    }
    return nodes;
  });

  /** Auto-collapse parent jobs on first data load */
  $effect(() => {
    if (!collapsedInitialized && jobTree.length > 0) {
      const parents = new Set<string>();
      for (const node of jobTree) {
        if (node.children.length > 0) parents.add(node.job.id);
      }
      if (parents.size > 0) collapsedParents = parents;
      collapsedInitialized = true;
    }
  });

  /** Flatten tree for rendering, skipping children of collapsed parents */
  let flatNodes = $derived.by(() => {
    const result: JobNode[] = [];
    function walk(nodes: JobNode[]) {
      for (const node of nodes) {
        result.push(node);
        if (node.children.length > 0 && collapsedParents.has(node.job.id)) {
          continue; // Skip children — parent is collapsed
        }
        walk(node.children);
      }
    }
    walk(jobTree);
    return result;
  });

  let activeFilter = $derived(
    jobs.statusFilter.length === 0 ? "all" : jobs.statusFilter[0],
  );

  let hasSelection = $derived(jobs.selectedIds.size > 0);
  let allSelected = $derived(
    filteredJobs.length > 0 && filteredJobs.every((job) => jobs.selectedIds.has(job.id)),
  );
  let logScrollMode = $state<LogScrollMode>("live");
  let expandedPromptJobId = $state<string | null>(null);
  let outcomeRatingDraft = $state<OutcomeRating | null>(null);
  let outcomeNotesDraft = $state("");
  let outcomeSaving = $state(false);
  let outcomeLoadedForJobId = $state<string | null>(null);
  let interventionsLoadedForJobId = $state<string | null>(null);
  let interventionDraft = $state("");
  let interventionSaving = $state(false);
  let interventionSupport = $state<JobInterventionSupport | null>(null);

  $effect(() => {
    const selected = jobs.selected;
    if (!selected) {
      expandedPromptJobId = null;
      outcomeLoadedForJobId = null;
      outcomeRatingDraft = null;
      outcomeNotesDraft = "";
      return;
    }
    if (expandedPromptJobId && expandedPromptJobId !== selected.id) {
      expandedPromptJobId = null;
    }
    if (outcomeLoadedForJobId === selected.id) return;
    outcomeLoadedForJobId = selected.id;
    outcomeRatingDraft = toOutcomeDraft(selected.outcomeRating ?? null);
    outcomeNotesDraft = selected.outcomeNotes ?? "";
  });

  $effect(() => {
    const selected = jobs.selected;
    if (!selected) return;
    if (interventionsLoadedForJobId === selected.id) return;
    interventionsLoadedForJobId = selected.id;
    interventionDraft = "";
    api.jobs.interventions(selected.id)
      .then((result) => {
        jobs.setInterventions(selected.id, result.interventions);
        interventionSupport = result.support;
      })
      .catch((err: any) => {
        interventionSupport = null;
        toast.error(`Failed to load interventions: ${err?.message ?? err}`);
      });
  });

  function interventionStatusLabel(status: string): string {
    if (status === "pending") return "queued for next turn";
    return status;
  }

  async function submitIntervention(job: Job, source: "jobs" | "chat" | "mcp" = "jobs") {
    const text = interventionDraft.trim();
    if (!text) {
      toast.error("Enter guidance first");
      return;
    }
    interventionSaving = true;
    try {
      const result = await api.jobs.intervene(job.id, { text, source });
      jobs.upsertIntervention(job.id, result.intervention);
      interventionSupport = result.support;
      interventionDraft = "";
      toast.success("Guidance queued");
    } catch (err: any) {
      toast.error(`Failed to guide job: ${err?.message ?? err}`);
    } finally {
      interventionSaving = false;
    }
  }

  function canMarkOutcome(job: Job): boolean {
    return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
  }

  function showOutcomeFeedback(job: Job): boolean {
    return canMarkOutcome(job) && !job.parentJobId;
  }

  function showDelegatedOutcomeSummary(job: Job): boolean {
    return canMarkOutcome(job) && !!job.parentJobId;
  }

  async function saveOutcome(job: Job) {
    if (!outcomeRatingDraft) {
      toast.error("Choose Good, Average, or Poor first");
      return;
    }
    if (!canMarkOutcome(job)) {
      toast.error("Only finished jobs can be marked");
      return;
    }
    outcomeSaving = true;
    try {
      const result = await api.jobs.setOutcome(job.id, outcomeRatingDraft, outcomeNotesDraft) as {
        propagatedJobIds?: string[];
        skippedActiveJobIds?: string[];
      };
      await refreshJobs();
      const propagatedCount = Array.isArray(result?.propagatedJobIds) ? result.propagatedJobIds.length : 0;
      const skippedActiveCount = Array.isArray(result?.skippedActiveJobIds) ? result.skippedActiveJobIds.length : 0;
      if (propagatedCount > 0 || skippedActiveCount > 0) {
        const parts = [`Saved root outcome`];
        if (propagatedCount > 0) parts.push(`applied to ${propagatedCount} delegated job(s)`);
        if (skippedActiveCount > 0) parts.push(`${skippedActiveCount} active delegated job(s) not marked yet`);
        toast.success(parts.join(" - "));
      } else {
        toast.success("Saved job outcome feedback");
      }
    } catch (err: any) {
      toast.error(`Failed to save outcome: ${err?.message ?? err}`);
    } finally {
      outcomeSaving = false;
    }
  }

  function sanitizeFilePart(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function downloadTextFile(filename: string, content: string) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function saveJobLog(job: Job) {
    try {
      const latest = await api.jobs.get(job.id);
      const remoteLog = String((latest as Job | null)?.logs ?? "");
      const localLog = String(jobs.getLogText(job.id) || job.logs || "");
      const logText = remoteLog.length >= localLog.length ? remoteLog : localLog;
      const safeName = sanitizeFilePart(job.name || "job");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `job-${job.id.slice(0, 8)}-${safeName || "log"}-${timestamp}.log`;
      downloadTextFile(filename, logText || "(no logs)\n");
      toast.success("Saved log to disk");
    } catch (err: any) {
      toast.error(`Failed to save log: ${err?.message ?? err}`);
    }
  }

  function isPromptExpanded(job: Job): boolean {
    return expandedPromptJobId === job.id;
  }

  function togglePromptExpanded(job: Job) {
    expandedPromptJobId = expandedPromptJobId === job.id ? null : job.id;
  }

  function copyTextFallback(text: string): boolean {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copyJobPrompt(job: Job) {
    const promptText = String(job.prompt ?? "");
    if (!promptText.trim()) {
      toast.error("No prompt recorded for this job");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(promptText);
      } else if (!copyTextFallback(promptText)) {
        throw new Error("Clipboard unavailable");
      }
      toast.success("Prompt copied");
    } catch (err: any) {
      toast.error(`Failed to copy prompt: ${err?.message ?? err}`);
    }
  }

  // Resizable list panel
  let listWidth = $state(500);
  let resizing = $state(false);

  function onResizeStart(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startWidth = listWidth;
    function onMove(ev: MouseEvent) {
      listWidth = Math.max(250, Math.min(startWidth + ev.clientX - startX, window.innerWidth - 200));
    }
    function onUp() {
      resizing = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

<div class="jobs-page" class:resizing>
  <div class="list-panel" style="width: {listWidth}px">
    <div class="filters">
      {#each statuses as s}
        <button
          class="filter-btn"
          class:active={activeFilter === s}
          onclick={() => setFilter(s)}
        >
          {s}
        </button>
      {/each}
      <div class="filter-spacer"></div>
      {#if jobs.all.some((j) => j.status === "paused")}
        <button class="btn-start-queue" onclick={startAll}>Start Queue</button>
      {/if}
      <button class="btn-refresh" onclick={refreshJobs}>Refresh</button>
    </div>
    <div class="advanced-filters">
      <input
        class="search-input"
        type="text"
        bind:value={searchQuery}
        placeholder="Search jobs, prompt, ID, machine, bridge, user..."
      />
      <select class="filter-select" bind:value={workerFilter}>
        <option value={ALL_OPTION}>All Machines</option>
        {#each workerOptions as worker}
          <option value={worker.value}>{worker.label}</option>
        {/each}
      </select>
      <select class="filter-select" bind:value={bridgeFilter}>
        <option value={ALL_OPTION}>All Bridges</option>
        {#each bridgeOptions as bridge}
          <option value={bridge}>{bridge}</option>
        {/each}
      </select>
      <select class="filter-select" bind:value={userFilter}>
        <option value={ALL_OPTION}>All Users</option>
        {#each userOptions as user}
          <option value={user.value}>{user.label}</option>
        {/each}
      </select>
      <button class="btn-clear-filters" onclick={clearAdvancedFilters}>Clear</button>
      <span class="filter-count">{filteredJobs.length} shown</span>
    </div>
    {#if hasSelection}
      <div class="bulk-bar">
        <span>{jobs.selectedIds.size} selected</span>
        <button class="btn-bulk-delete" onclick={confirmBulkDelete}>Delete Selected</button>
        <button class="btn-bulk-clear" onclick={() => jobs.clearSelection()}>Clear</button>
      </div>
    {/if}
    <div class="job-list">
      {#if flatNodes.length > 0}
        <div class="select-all-row">
          <input
            type="checkbox"
            class="job-checkbox"
            checked={allSelected}
            onclick={toggleSelectAll}
          />
          <span class="select-all-label">{allSelected ? "Deselect all" : "Select all"}</span>
        </div>
      {/if}
      {#each flatNodes as node (node.job.id)}
        {@const job = node.job}
        {@const delegation = getDelegationSummary(job)}
        {@const parentJob = getParentJob(job)}
        <button
          class="job-row"
          class:selected={jobs.selectedId === job.id}
          class:delegated={node.depth > 0}
          class:fanout-root={delegation.childCount > 0}
          onclick={() => selectJob(job.id)}
          style="padding-left: {8 + node.depth * 16}px"
        >
          <input
            type="checkbox"
            class="job-checkbox"
            checked={jobs.selectedIds.has(job.id)}
            onclick={(e) => toggleCheckbox(e, job.id)}
          />
          {#if node.depth > 0}
            <span class="dep-connector"></span>
          {/if}
          <span class="status-dot status-dot-{job.status}" title={job.status}></span>
          {#if job.usedBridges?.length}
            {#each job.usedBridges as prog}
              <span class="source-icon source-{prog}" title={prog}>{programIcon(prog)}</span>
            {/each}
          {/if}
          {#if getAgentLabel(job)}
            {@const agentLabel = getAgentLabel(job)!}
            <span class="job-agent" title={agentLabel.full}>{truncate(agentLabel.short, 24)}</span>
          {/if}
          {#if delegation.childCount > 0}
            <span
              class="collapse-toggle"
              class:collapsed={collapsedParents.has(job.id)}
              role="button"
              tabindex="-1"
              onclick={(e) => toggleCollapse(job.id, e)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") toggleCollapse(job.id, e); }}
              title={collapsedParents.has(job.id) ? `Expand ${delegation.childCount} sub-jobs` : "Collapse sub-jobs"}
            >
              {collapsedParents.has(job.id) ? "▶" : "▼"}
            </span>
          {/if}
          <span class="job-name">{job.name || truncate(job.prompt, 50)}</span>
          {#if node.depth > 0}
            <span class="job-chip job-chip-delegated">sub-job</span>
            {#if parentJob}
              <span
                class="job-chip job-chip-parent"
                title={`Spawned from #${parentJob.id.slice(0, 8)}${parentJob.name || parentJob.prompt ? ` — ${truncate(parentJob.name ?? parentJob.prompt, 80)}` : ""}`}
              >
                from #{parentJob.id.slice(0, 8)}
              </span>
            {/if}
          {:else if delegation.childCount > 0}
            <span class="job-chip job-chip-fanout">{delegation.childCount} sub</span>
            {#if delegation.activeCount > 0}
              <span class="job-chip job-chip-active">{delegation.activeCount} active</span>
            {/if}
          {/if}
          {#if job.tokenUsage}
            <span class="job-tokens" title="Input/Output tokens">
              {formatJobUsage(job)}
            </span>
          {/if}
          {#if job.tokenUsage?.costUsd}
            <span class="job-cost" title="Reported run cost">{formatUsd(job.tokenUsage.costUsd)}</span>
          {/if}
          {#if getJobWorkerLabels(job).length > 0}
            <span class="job-worker" title={getJobWorkerLabels(job).join(", ")}>{truncate(getJobWorkerLabels(job)[0], 16)}</span>
          {/if}
          {#if job.submittedByUsername || job.submittedBy}
            <span class="job-user" title={getJobUserLabel(job)}>{truncate(getJobUserLabel(job), 14)}</span>
          {/if}
          <span class="job-id">#{job.id.slice(0, 8)}</span>
          <span class="job-time">{timeAgo(job.createdAt)}</span>
        </button>
      {:else}
        <div class="empty">No jobs</div>
      {/each}
    </div>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" onmousedown={onResizeStart}></div>

  {#if jobs.selected}
    {@const job = jobs.selected}
    {@const delegation = getDelegationSummary(job)}
    {@const rootJob = getRootJob(job)}
    <div class="detail-panel">
      <div class="detail-header">
        <h3>Job Detail</h3>
        <div class="detail-actions">
          {#if job.status === "paused"}
            <button class="btn-start" onclick={() => resumeJob(job.id)}>Start</button>
          {/if}
          {#if job.status === "queued"}
            <button class="btn-start" onclick={() => dispatchJob(job.id)}>Start</button>
          {/if}
          {#if job.status === "queued" || job.status === "paused"}
            <select onchange={(e) => reprioritize(job.id, (e.target as HTMLSelectElement).value)}>
              <option value="" disabled selected>Priority</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          {/if}
          {#if job.status === "queued" || job.status === "running" || job.status === "paused"}
            <button class="btn-cancel" onclick={() => cancelJob(job.id)}>Cancel</button>
          {/if}
          {#if job.status === "failed" || job.status === "cancelled"}
            <button class="btn-requeue" onclick={() => requeueJob(job.id)}>Requeue</button>
          {/if}
          {#if canDeleteJob(job)}
            <button class="btn-delete" onclick={() => confirmDeleteJob(job)}>Delete</button>
          {/if}
        </div>
      </div>
      <div class="detail-body">
      {#if showOutcomeFeedback(job)}
        <div class="outcome-section">
          <div class="outcome-header">
            <strong>Outcome Feedback:</strong>
            {#if job.outcomeRating}
              {@const ratingLabel = outcomeLabel(job.outcomeRating)}
              <span class="outcome-pill outcome-{ratingLabel}">{ratingLabel}</span>
            {:else}
              <span class="outcome-pill outcome-unset">unrated</span>
            {/if}
            {#if job.outcomeMarkedAt}
              <span class="outcome-meta">marked {new Date(job.outcomeMarkedAt).toLocaleString()}</span>
            {/if}
            {#if delegation.childCount > 0}
              <span class="outcome-meta">
                root rating propagates to {delegation.childCount} delegated job(s)
              </span>
            {/if}
          </div>
          <div class="outcome-buttons">
            <button
              class="outcome-btn outcome-btn-good"
              class:active={outcomeRatingDraft === "good"}
              onclick={() => (outcomeRatingDraft = "good")}
              disabled={outcomeSaving}
            >
              Good
            </button>
            <button
              class="outcome-btn outcome-btn-average"
              class:active={outcomeRatingDraft === "average"}
              onclick={() => (outcomeRatingDraft = "average")}
              disabled={outcomeSaving}
            >
              Average
            </button>
            <button
              class="outcome-btn outcome-btn-poor"
              class:active={outcomeRatingDraft === "poor"}
              onclick={() => (outcomeRatingDraft = "poor")}
              disabled={outcomeSaving}
            >
              Poor
            </button>
          </div>
          <textarea
            class="outcome-notes"
            rows="3"
            bind:value={outcomeNotesDraft}
            placeholder="What worked, what failed, what should be repeated or avoided..."
            disabled={outcomeSaving}
          ></textarea>
          <div class="outcome-actions">
            <button
              class="btn-save-outcome"
              onclick={() => saveOutcome(job)}
              disabled={!outcomeRatingDraft || outcomeSaving}
            >
              {outcomeSaving ? "Saving..." : delegation.childCount > 0 ? "Save Root Outcome" : "Save Outcome Feedback"}
            </button>
          </div>
        </div>
      {:else if showDelegatedOutcomeSummary(job)}
        <div class="outcome-section delegated-outcome-section">
          <div class="outcome-header">
            <strong>Outcome Feedback:</strong>
            {#if job.outcomeRating}
              {@const ratingLabel = outcomeLabel(job.outcomeRating)}
              <span class="outcome-pill outcome-{ratingLabel}">{ratingLabel}</span>
            {:else}
              <span class="outcome-pill outcome-unset">inherits from root</span>
            {/if}
            {#if job.outcomeMarkedAt}
              <span class="outcome-meta">inherited {new Date(job.outcomeMarkedAt).toLocaleString()}</span>
            {/if}
          </div>
          <div class="delegated-outcome-copy">
            This delegated sub-job inherits outcome from its root job for learning.
            {#if rootJob}
              <button class="dep-link" onclick={() => selectJob(rootJob.id)}>
                Open root #{rootJob.id.slice(0, 8)}
              </button>
            {/if}
          </div>
        </div>
      {/if}
      <div class="detail-meta">
        <div><strong>ID:</strong> <code class="detail-id">{job.id}</code></div>
        <div><strong>Status:</strong> <Badge text={job.status} variant={job.status} /></div>
        <div><strong>Priority:</strong> <Badge text={job.priority} variant={job.priority} /></div>
        {#if job.name}
          <div><strong>Name:</strong> {job.name}</div>
        {/if}
        {#if job.workerName}
          <div><strong>Worker:</strong> {job.workerName}</div>
        {/if}
        {#if job.targetWorkerName && job.targetWorkerName !== job.workerName}
          <div><strong>Target Worker:</strong> {job.targetWorkerName}</div>
        {/if}
        {#if job.submittedByUsername || job.submittedBy}
          <div><strong>Submitted By:</strong> {getJobUserLabel(job)}</div>
        {/if}
        {#if getAgentLabel(job)}
          {@const detailAgent = getAgentLabel(job)!}
          <div><strong>Agent:</strong> {detailAgent.full}</div>
        {/if}
        {#if job.actualModel}
          <div><strong>Model:</strong> <code>{job.actualModel}</code></div>
        {/if}
        {#if job.usedBridges?.length}
          <div class="bridges-row"><strong>Bridges:</strong>
            {#each job.usedBridges as prog}
              <span class="source-badge source-{prog}">{prog}</span>
            {/each}
          </div>
        {/if}
        {#if job.workspaceMode}
          <div><strong>Mode:</strong> <Badge text={job.workspaceMode} variant={job.workspaceMode} /></div>
        {/if}
        <div><strong>Created:</strong> {new Date(job.createdAt).toLocaleString()}</div>
        {#if job.startedAt}
          <div><strong>Started:</strong> {new Date(job.startedAt).toLocaleString()}</div>
        {/if}
        {#if job.completedAt}
          <div><strong>Completed:</strong> {new Date(job.completedAt).toLocaleString()}</div>
        {/if}
        {#if job.tokenUsage}
          <div><strong>Tokens:</strong> {job.tokenUsage.inputTokens.toLocaleString()} in / {job.tokenUsage.outputTokens.toLocaleString()} out</div>
          <div><strong>Duration:</strong> {(job.tokenUsage.durationMs / 1000).toFixed(1)}s</div>
          {#if job.tokenUsage.costUsd}
            <div><strong>Cost:</strong> {formatUsd(job.tokenUsage.costUsd)}</div>
          {/if}
        {/if}
        {#if job.parentJobId}
          {@const parentJob = getParentJob(job)}
          <div><strong>Spawned From:</strong>
            <button class="dep-link" onclick={() => selectJob(job.parentJobId!)}>
              #{job.parentJobId.slice(0, 8)}{parentJob ? ` — ${truncate(parentJob.name ?? parentJob.prompt, 30)}` : ""}
            </button>
          </div>
        {/if}
        {#if delegation.childCount > 0}
          <div><strong>Delegation:</strong> {delegation.childCount} sub-job(s), {delegation.runningCount} running, {delegation.failedCount} failed, {delegation.completedCount} completed</div>
        {/if}
      </div>
      <div class="detail-prompt">
        <div class="detail-prompt-header">
          <strong>Prompt</strong>
          <div class="detail-prompt-actions">
            <button class="btn-prompt-action" onclick={() => copyJobPrompt(job)}>Copy</button>
            <button class="btn-prompt-action" onclick={() => togglePromptExpanded(job)}>
              {isPromptExpanded(job) ? "Collapse" : "Expand"}
            </button>
          </div>
        </div>
        {#if job.prompt && job.prompt.trim().length > 0}
          <pre class:collapsed={!isPromptExpanded(job)}>{job.prompt}</pre>
        {:else}
          <div class="prompt-empty">(No prompt recorded)</div>
        {/if}
      </div>
      <div class="intervention-section">
        <div class="intervention-header">
          <strong>Running Job Guidance</strong>
          {#if interventionSupport}
            <span class="intervention-meta">
              {#if job.status === "running"}
                {interventionSupport.acceptsLiveNotes ? "live next-turn guidance enabled" : interventionSupport.liveReason ?? "live guidance unavailable"}
              {:else if job.status === "queued" || job.status === "paused"}
                {interventionSupport.acceptsQueuedNotes ? "queued for next launch/resume" : "guidance unavailable"}
              {:else}
                guidance unavailable after job end
              {/if}
            </span>
          {/if}
        </div>
        <textarea
          class="intervention-notes"
          rows="3"
          bind:value={interventionDraft}
          placeholder="Guide the active job: clarify intent, correct direction, or add constraints."
          disabled={interventionSaving}
        ></textarea>
        <div class="intervention-actions">
          <button
            class="btn-save-outcome"
            onclick={() => submitIntervention(job)}
            disabled={interventionSaving || !interventionDraft.trim()}
          >
            {interventionSaving ? "Sending..." : "Guide Job"}
          </button>
        </div>
        {#if jobs.getInterventions(job.id).length > 0}
          <div class="intervention-list">
            {#each jobs.getInterventions(job.id) as intervention}
              <div class="intervention-item">
                <div class="intervention-item-header">
                  <span class="intervention-status">{interventionStatusLabel(intervention.status)}</span>
                  <span class="intervention-author">{intervention.authorUsername ?? "operator"}</span>
                  <span class="intervention-time">{new Date(intervention.createdAt).toLocaleString()}</span>
                </div>
                <div class="intervention-text">{intervention.text}</div>
                {#if intervention.statusReason}
                  <div class="intervention-reason">{intervention.statusReason}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
      {#if job.dependsOn && job.dependsOn.length > 0}
        <div class="dependencies-section">
          <strong>Depends On:</strong>
          <div class="dep-list">
            {#each job.dependsOn as depId}
              {@const depJob = jobs.all.find((j) => j.id === depId)}
              <div class="dep-row">
                <button class="dep-link" onclick={() => selectJob(depId)}>
                  {depJob ? truncate(depJob.prompt, 40) : depId.slice(0, 8) + "..."}
                </button>
                {#if depJob}
                  <Badge text={depJob.status} variant={depJob.status} />
                {/if}
                <button class="dep-remove" onclick={() => removeDep(job.id, depId)}>x</button>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      {#if job.error}
        <div class="detail-error">
          <strong>Error:</strong> {job.error}
        </div>
      {/if}
      {#if job.result && job.result.length > 0}
        <div class="results-section">
          <strong>File Changes ({job.result.length})</strong>
          {#each job.result as change}
            <div class="file-change">
              <div class="file-change-header">
                <Badge text={change.action} variant={change.action === "create" ? "completed" : change.action === "delete" ? "failed" : "running"} />
                <span class="file-path">{change.path}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {#if job.commands && job.commands.length > 0}
        <div class="commands-section">
          <strong>Commands ({job.commands.length})</strong>
          {#each job.commands as cmd}
            <div class="command-block">
              <div class="command-header">
                <span class="command-lang">{cmd.language}</span>
                {#if cmd.description}
                  <span class="command-desc">{cmd.description}</span>
                {/if}
              </div>
              <pre class="command-script">{cmd.script}</pre>
            </div>
          {/each}
        </div>
      {/if}
      <div class="log-stream">
        <div class="log-header">
          <strong>Logs:</strong>
          <div class="log-controls">
            <select class="log-select" bind:value={logScrollMode}>
              <option value="live">Auto-scroll: Live</option>
              <option value="slow">Auto-scroll: Slow</option>
              <option value="paused">Auto-scroll: Paused</option>
            </select>
            <button class="btn-save-log" onclick={() => saveJobLog(job)}>Save Log</button>
          </div>
        </div>
        {#if job.status === "running"}
          <pre class="logs" use:autoscroll={logScrollMode}>{jobs.getLogText(job.id) || "(no logs yet)"}</pre>
        {:else}
          <pre class="logs">{jobs.getLogText(job.id) || job.logs || "(no logs)"}</pre>
        {/if}
      </div>
      </div>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmOpen}
  title={confirmTitle}
  message={confirmMessage}
  confirmText="Delete"
  variant="danger"
  onconfirm={handleConfirm}
  oncancel={handleCancel}
/>

<style>
  .jobs-page {
    display: flex;
    height: 100%;
    overflow: hidden;
  }
  .list-panel {
    min-width: 250px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .resize-handle:hover,
  .resizing .resize-handle {
    background: var(--accent);
  }
  .resizing {
    user-select: none;
    cursor: col-resize;
  }
  .filters {
    display: flex;
    gap: 2px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .filter-btn {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    text-transform: capitalize;
  }
  .filter-btn:hover { background: var(--bg-hover); }
  .filter-btn.active { background: var(--accent); color: white; }
  .filter-spacer { flex: 1; }
  .btn-start-queue {
    padding: 4px 12px;
    background: var(--status-running);
    color: var(--bg-base);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
  }
  .btn-start-queue:hover { opacity: 0.85; }
  .btn-refresh {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .btn-refresh:hover { background: var(--bg-hover); }
  .advanced-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1 1 260px;
    min-width: 220px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .filter-select {
    min-width: 130px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-clear-filters {
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-clear-filters:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .filter-count {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11px;
  }
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-hover);
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .btn-bulk-delete {
    padding: 2px 8px;
    background: var(--status-failed);
    color: white;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }
  .btn-bulk-clear {
    padding: 2px 8px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }
  .job-list {
    flex: 1;
    overflow-y: auto;
  }
  .select-all-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .select-all-label {
    font-size: 11px;
    color: var(--text-muted);
  }
  .job-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }
  .job-row:hover { background: var(--bg-hover); }
  .job-row.selected { background: var(--bg-active); }
  .job-row.delegated {
    background: linear-gradient(90deg, rgba(59, 130, 246, 0.08), transparent 28%);
  }
  .job-row.delegated:hover {
    background: linear-gradient(90deg, rgba(59, 130, 246, 0.14), var(--bg-hover) 42%);
  }
  .job-row.delegated.selected {
    background: linear-gradient(90deg, rgba(59, 130, 246, 0.18), var(--bg-active) 48%);
  }
  .job-row.fanout-root {
    box-shadow: inset 2px 0 0 rgba(245, 158, 11, 0.35);
  }
  .job-checkbox {
    width: 13px;
    height: 13px;
    accent-color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot-queued { background: var(--status-queued); }
  .status-dot-paused { background: var(--text-muted); }
  .status-dot-running { background: var(--status-running); }
  .status-dot-completed { background: var(--status-completed); }
  .status-dot-failed { background: var(--status-failed); }
  .status-dot-cancelled { background: var(--status-cancelled); }
  .source-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .source-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: capitalize;
    background: var(--bg-active);
  }
  .source-godot { background: #478cbf22; color: #478cbf; }
  .source-blender { background: #ea722022; color: #ea7220; }
  .source-houdini { background: #ff450022; color: #ff4500; }
  .source-comfyui { background: #16a34a22; color: #16a34a; }
  .source-unity { background: #cbd5e122; color: #cbd5e1; }
  .source-unreal { background: #a78bfa22; color: #a78bfa; }
  .bridges-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .dep-connector {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-left: 2px solid var(--border);
    border-bottom: 2px solid var(--border);
    flex-shrink: 0;
  }
  .job-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .job-chip {
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    background: var(--bg-surface);
    text-transform: lowercase;
  }
  .job-chip-delegated {
    background: rgba(59, 130, 246, 0.14);
    color: #8ec5ff;
    border-color: rgba(59, 130, 246, 0.28);
  }
  .collapse-toggle {
    all: unset;
    cursor: pointer;
    font-size: 0.65rem;
    color: rgba(255, 255, 255, 0.45);
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
  }
  .collapse-toggle:hover {
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.08);
  }
  .collapse-toggle.collapsed {
    color: rgba(245, 158, 11, 0.7);
  }
  .job-chip-fanout {
    background: rgba(245, 158, 11, 0.14);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.3);
  }
  .job-chip-parent {
    background: rgba(148, 163, 184, 0.12);
    color: #cbd5e1;
    border-color: rgba(148, 163, 184, 0.24);
  }
  .job-chip-active {
    background: rgba(16, 185, 129, 0.12);
    color: #34d399;
    border-color: rgba(16, 185, 129, 0.28);
  }
  .job-agent {
    color: #a78bfa;
    font-size: 10px;
    flex-shrink: 0;
    border: 1px solid rgba(167, 139, 250, 0.28);
    border-radius: 999px;
    padding: 1px 6px;
    background: rgba(167, 139, 250, 0.10);
  }
  .job-worker {
    color: var(--text-muted);
    font-size: 11px;
    flex-shrink: 0;
  }
  .job-cost,
  .job-user {
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    background: var(--bg-surface);
  }
  .job-tokens {
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    background: var(--bg-surface);
  }
  .job-id {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    flex-shrink: 0;
  }
  .job-time {
    color: var(--text-muted);
    font-size: 11px;
    flex-shrink: 0;
    min-width: 32px;
    text-align: right;
  }
  .empty {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .detail-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
  }
  .detail-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 6px;
  }
  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .detail-header h3 { font-size: var(--font-size-lg); }
  .detail-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .btn-start {
    padding: 4px 14px;
    background: var(--status-running);
    color: var(--bg-base);
    border-radius: var(--radius-sm);
    font-weight: 600;
  }
  .btn-start:hover { opacity: 0.85; }
  .btn-cancel {
    padding: 4px 12px;
    background: var(--status-failed);
    color: white;
    border-radius: var(--radius-sm);
  }
  .btn-requeue {
    padding: 4px 12px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
  }
  .btn-delete {
    padding: 4px 12px;
    background: var(--status-failed);
    color: white;
    border-radius: var(--radius-sm);
    opacity: 0.8;
  }
  .btn-delete:hover { opacity: 1; }
  .detail-id {
    font-family: var(--font-mono);
    font-size: 11px;
    user-select: all;
  }
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
    font-size: var(--font-size-sm);
  }
  .outcome-section {
    margin-bottom: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
  }
  .delegated-outcome-section {
    border-color: rgba(59, 130, 246, 0.24);
    background: linear-gradient(180deg, rgba(59, 130, 246, 0.08), transparent);
  }
  .delegated-outcome-copy {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .intervention-section {
    margin-bottom: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
  }
  .intervention-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .intervention-meta,
  .intervention-reason {
    color: var(--text-muted);
    font-size: 11px;
  }
  .intervention-notes {
    width: 100%;
    resize: vertical;
    min-height: 70px;
    margin-bottom: 8px;
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
  }
  .intervention-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .intervention-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .intervention-item {
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
  }
  .intervention-item-header {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .intervention-status {
    color: var(--accent);
    font-weight: 700;
  }
  .intervention-author {
    color: var(--text-secondary);
  }
  .intervention-time {
    color: var(--text-muted);
  }
  .intervention-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--font-size-sm);
  }
  .outcome-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
    font-size: var(--font-size-sm);
  }
  .outcome-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: capitalize;
    font-size: 11px;
    font-weight: 700;
  }
  .outcome-good { background: #16a34a22; color: #16a34a; }
  .outcome-average { background: #f59e0b22; color: #f59e0b; }
  .outcome-poor { background: #ef444422; color: #ef4444; }
  .outcome-unset { background: var(--bg-hover); color: var(--text-muted); }
  .outcome-meta {
    color: var(--text-muted);
    font-size: 11px;
  }
  .outcome-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .outcome-btn {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .outcome-btn.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset;
    color: var(--text-primary);
  }
  .outcome-btn-good.active { background: #16a34a22; color: #16a34a; border-color: #16a34a88; }
  .outcome-btn-average.active { background: #f59e0b22; color: #f59e0b; border-color: #f59e0b88; }
  .outcome-btn-poor.active { background: #ef444422; color: #ef4444; border-color: #ef444488; }
  .outcome-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .outcome-notes {
    width: 100%;
    resize: vertical;
    min-height: 70px;
    margin-bottom: 8px;
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
  }
  .outcome-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .btn-save-outcome {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: white;
    font-size: var(--font-size-sm);
  }
  .btn-save-outcome:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .dependencies-section {
    margin-bottom: 16px;
    font-size: var(--font-size-sm);
  }
  .dep-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .dep-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-base);
    border-radius: var(--radius-sm);
  }
  .dep-link {
    color: var(--accent);
    font-size: var(--font-size-sm);
    text-decoration: underline;
    cursor: pointer;
  }
  .dep-link:hover { opacity: 0.8; }
  .dep-remove {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11px;
    padding: 0 4px;
    border-radius: 2px;
  }
  .dep-remove:hover { color: var(--status-failed); background: var(--bg-hover); }
  .detail-prompt {
    margin-bottom: 16px;
  }
  .detail-prompt-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .detail-prompt-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn-prompt-action {
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: 11px;
  }
  .btn-prompt-action:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .detail-prompt pre {
    background: var(--bg-base);
    padding: 10px;
    border-radius: var(--radius-sm);
    margin-top: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.45;
  }
  .detail-prompt pre.collapsed {
    max-height: 180px;
    overflow-y: auto;
  }
  .prompt-empty {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .detail-error {
    color: var(--status-failed);
    margin-bottom: 16px;
  }
  .results-section { margin-bottom: 16px; }
  .file-change { margin-top: 6px; }
  .file-change-header {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: var(--font-size-sm);
  }
  .file-path {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .commands-section { margin-bottom: 16px; }
  .command-block { margin-top: 8px; }
  .command-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
  .command-lang { font-size: var(--font-size-sm); font-weight: 600; color: var(--accent); }
  .command-desc { font-size: 11px; color: var(--text-muted); }
  .command-script {
    background: var(--bg-base);
    padding: 8px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    color: var(--text-secondary);
  }
  .log-stream {
    border-top: 1px solid var(--border);
    margin-top: 16px;
    padding-top: 10px;
  }
  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .log-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .log-select {
    min-width: 170px;
    padding: 4px 8px;
    font-size: var(--font-size-sm);
  }
  .btn-save-log {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-save-log:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .logs {
    background: var(--bg-base);
    padding: 10px;
    border-radius: var(--radius-sm);
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 45vh;
    overflow-y: auto;
    color: var(--text-secondary);
  }
</style>
