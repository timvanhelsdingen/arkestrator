import type { Job, JobIntervention } from "@arkestrator/protocol";

const MAX_LOG_LINES = 5000;

class JobsState {
  all = $state<Job[]>([]);
  selectedId = $state<string | null>(null);
  selectedIds = $state<Set<string>>(new Set());
  statusFilter = $state<string[]>([]);

  // Log streaming: mutable map + version counter for cheap reactivity.
  // Logs are intentionally decoupled from `all` so that log-only updates
  // (which arrive at high frequency during job execution) do NOT trigger
  // re-computation of derived stores like filteredJobs, jobTree, etc.
  private logMap = new Map<string, string[]>();
  private logTextCache = new Map<string, string>();
  private interventionMap = new Map<string, JobIntervention[]>();
  logVersion = $state(0);
  interventionVersion = $state(0);

  // Separate version counter for job list structural changes (add/remove)
  // vs. in-place property updates. Derived stores that only care about
  // the set of jobs (workerOptions, bridgeOptions, userOptions) can use
  // this to avoid recalculating on every status/token update.
  listStructureVersion = $state(0);

  get selected(): Job | undefined {
    return this.all.find((j) => j.id === this.selectedId);
  }

  get filtered(): Job[] {
    if (this.statusFilter.length === 0) return this.all;
    return this.all.filter((j) => this.statusFilter.includes(j.status));
  }

  appendLog(jobId: string, text: string) {
    let arr = this.logMap.get(jobId);
    if (!arr) {
      arr = [];
      this.logMap.set(jobId, arr);
    }
    arr.push(text);
    if (arr.length > MAX_LOG_LINES) {
      arr.splice(0, arr.length - MAX_LOG_LINES);
      // Rebuild cache after splice
      this.logTextCache.set(jobId, arr.join(""));
    } else {
      // Append to cached string (avoid re-joining entire array)
      this.logTextCache.set(jobId, (this.logTextCache.get(jobId) ?? "") + text);
    }
    // Bump version counter — single integer assignment triggers reactivity
    this.logVersion++;
  }

  getLog(jobId: string): string[] {
    // Read version to subscribe to changes
    void this.logVersion;
    return this.logMap.get(jobId) ?? [];
  }

  /** Pre-joined log text — avoids re-joining the array on every render */
  getLogText(jobId: string): string {
    void this.logVersion;
    return this.logTextCache.get(jobId) ?? "";
  }

  toggleSelect(jobId: string) {
    const next = new Set(this.selectedIds);
    if (next.has(jobId)) {
      next.delete(jobId);
    } else {
      next.add(jobId);
    }
    this.selectedIds = next;
  }

  selectAllFiltered() {
    this.selectedIds = new Set(this.filtered.map((j) => j.id));
  }

  clearSelection() {
    this.selectedIds = new Set();
  }

  upsert(job: Job) {
    const idx = this.all.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      // In-place update: mutate the existing entry without spreading the
      // entire array. Svelte 5's fine-grained $state proxy detects the
      // individual property changes, so downstream derivations that read
      // specific job properties (status, tokens, etc.) update correctly
      // without triggering a full list re-render.
      Object.assign(this.all[idx], job);
    } else {
      // New job — this is a structural list change.
      this.all = [job, ...this.all];
      this.listStructureVersion++;
    }
  }

  /** Bulk-replace the entire job list (e.g. from job_list_response). */
  replaceAll(jobList: Job[]) {
    this.all = jobList;
    this.listStructureVersion++;
  }

  // --- Archive / Trash ---

  viewMode = $state<"active" | "archived" | "trash">("active");
  archivedJobs = $state<Job[]>([]);
  archivedTotal = $state(0);
  trashedJobs = $state<Job[]>([]);
  trashedTotal = $state(0);

  replaceArchived(jobList: Job[], total: number) {
    this.archivedJobs = jobList;
    this.archivedTotal = total;
  }

  replaceTrashed(jobList: Job[], total: number) {
    this.trashedJobs = jobList;
    this.trashedTotal = total;
  }

  removeFromActive(jobId: string) {
    this.all = this.all.filter((j) => j.id !== jobId);
    this.listStructureVersion++;
  }

  removeFromArchived(jobId: string) {
    this.archivedJobs = this.archivedJobs.filter((j) => j.id !== jobId);
    this.archivedTotal = Math.max(0, this.archivedTotal - 1);
  }

  removeFromTrashed(jobId: string) {
    this.trashedJobs = this.trashedJobs.filter((j) => j.id !== jobId);
    this.trashedTotal = Math.max(0, this.trashedTotal - 1);
  }

  setInterventions(jobId: string, items: JobIntervention[]) {
    this.interventionMap.set(jobId, [...items]);
    this.interventionVersion++;
  }

  upsertIntervention(jobId: string, intervention: JobIntervention) {
    const current = [...(this.interventionMap.get(jobId) ?? [])];
    const index = current.findIndex((entry) => entry.id === intervention.id);
    if (index >= 0) current[index] = intervention;
    else current.push(intervention);
    current.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.interventionMap.set(jobId, current);
    this.interventionVersion++;
  }

  getInterventions(jobId: string): JobIntervention[] {
    void this.interventionVersion;
    return this.interventionMap.get(jobId) ?? [];
  }
}

export const jobs = new JobsState();
