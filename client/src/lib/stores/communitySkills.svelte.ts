/**
 * Community Skills store — manages browsing, installation tracking, and update detection
 * for community skills from arkestrator.com.
 */

import {
  communityApi,
  loadSettings,
  type CommunitySkillSummary,
  type CommunitySkillDetail,
} from "../api/community";
import { api } from "../api/rest";
import { toast } from "./toast.svelte";

// ---------------------------------------------------------------------------
// Manifest types (localStorage persistence)
// ---------------------------------------------------------------------------

const MANIFEST_KEY = "arkestrator-community-skills";

export interface InstalledCommunitySkill {
  communityId: string;
  localSlug: string;
  localProgram: string;
  installedVersion: number;
  enabled: boolean;
  installedAt: string;
}

type Manifest = Record<string, InstalledCommunitySkill>; // keyed by communityId

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class CommunitySkillsState {
  // Browse state
  skills = $state<CommunitySkillSummary[]>([]);
  loading = $state(false);
  error = $state("");
  searchQuery = $state("");
  programFilter = $state("");
  categoryFilter = $state("");
  showOfficial = $state(false);
  programs = $state<string[]>([]);
  categories = $state<string[]>([]);
  offset = $state(0);
  hasMore = $state(false);
  total = $state(0);

  // Detail modal
  selectedSkill = $state<CommunitySkillSummary | null>(null);
  selectedDetail = $state<CommunitySkillDetail | null>(null);
  detailLoading = $state(false);

  // Installation manifest
  private _manifest = $state<Manifest>(this._loadManifest());

  // Update detection
  updatesAvailable = $state<Record<string, number>>({}); // communityId -> remote version
  checkingUpdates = $state(false);

  // Publish state
  publishModalOpen = $state(false);
  publishPreselect = $state<{ slug: string; program: string }[] | null>(null);

  // Installing/uninstalling tracking
  installingIds = $state<Set<string>>(new Set());

  // Batch install tracking
  batchInstalling = $state(false);
  batchProgress = $state(0);
  batchTotal = $state(0);

  /** Skills filtered by the showOfficial toggle. Use this for display instead of `skills`. */
  get filteredSkills(): CommunitySkillSummary[] {
    if (this.showOfficial) return this.skills;
    return this.skills.filter((s) => !s.is_official);
  }

  // Active sub-tab
  activeTab = $state<"browse" | "installed">("browse");

  // ---------------------------------------------------------------------------
  // Manifest helpers
  // ---------------------------------------------------------------------------

  private _loadManifest(): Manifest {
    try {
      const raw = localStorage.getItem(MANIFEST_KEY);
      if (!raw) return {};
      return JSON.parse(raw) ?? {};
    } catch {
      return {};
    }
  }

  private _saveManifest(): void {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(this._manifest));
  }

  isInstalled(communityId: string): boolean {
    return communityId in this._manifest;
  }

  getInstalled(communityId: string): InstalledCommunitySkill | undefined {
    return this._manifest[communityId];
  }

  hasUpdate(communityId: string): boolean {
    return communityId in this.updatesAvailable;
  }

  get installedList(): InstalledCommunitySkill[] {
    return Object.values(this._manifest);
  }

  get installedCount(): number {
    return Object.keys(this._manifest).length;
  }

  get updateCount(): number {
    return Object.keys(this.updatesAvailable).length;
  }

  /** Find communityId for a local skill by slug+program, or undefined if not from community. */
  findCommunityId(localSlug: string, localProgram: string): string | undefined {
    for (const [communityId, entry] of Object.entries(this._manifest)) {
      if (entry.localSlug === localSlug && entry.localProgram === localProgram) {
        return communityId;
      }
    }
    return undefined;
  }

  /** Check if a local skill (by slug+program) has a community update available. */
  hasUpdateForLocal(localSlug: string, localProgram: string): boolean {
    const cid = this.findCommunityId(localSlug, localProgram);
    return cid ? cid in this.updatesAvailable : false;
  }

  // ---------------------------------------------------------------------------
  // Browse actions
  // ---------------------------------------------------------------------------

  async loadFilters(): Promise<void> {
    try {
      const [programs, categories] = await Promise.all([
        communityApi.getPrograms(),
        communityApi.getCategories(),
      ]);
      this.programs = programs;
      this.categories = categories;
    } catch {
      // Non-critical, filters just won't be available
    }
  }

  async search(): Promise<void> {
    this.loading = true;
    this.error = "";
    this.offset = 0;
    try {
      const result = await communityApi.search({
        query: this.searchQuery || undefined,
        program: this.programFilter || undefined,
        category: this.categoryFilter || undefined,
        limit: 30,
        offset: 0,
      });
      this.skills = result.skills;
      this.total = result.total;
      this.hasMore = result.offset + result.skills.length < result.total;
      this.offset = result.offset + result.skills.length;
    } catch (err: any) {
      this.error = err?.message || "Failed to search community skills";
      this.skills = [];
    } finally {
      this.loading = false;
    }
  }

  async loadMore(): Promise<void> {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    try {
      const result = await communityApi.search({
        query: this.searchQuery || undefined,
        program: this.programFilter || undefined,
        category: this.categoryFilter || undefined,
        limit: 30,
        offset: this.offset,
      });
      this.skills = [...this.skills, ...result.skills];
      this.total = result.total;
      this.hasMore = this.offset + result.skills.length < result.total;
      this.offset = this.offset + result.skills.length;
    } catch (err: any) {
      this.error = err?.message || "Failed to load more";
    } finally {
      this.loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  async viewDetail(skill: CommunitySkillSummary): Promise<void> {
    this.selectedSkill = skill;
    this.selectedDetail = null;
    this.detailLoading = true;
    try {
      this.selectedDetail = await communityApi.getSkill(skill.id);
    } catch (err: any) {
      toast.error(`Failed to load skill details: ${err?.message}`);
    } finally {
      this.detailLoading = false;
    }
  }

  closeDetail(): void {
    this.selectedSkill = null;
    this.selectedDetail = null;
  }

  // ---------------------------------------------------------------------------
  // Install / Uninstall
  // ---------------------------------------------------------------------------

  async install(communityId: string, includeDeps = true, silent = false): Promise<void> {
    if (this.installingIds.has(communityId)) return;
    this.installingIds = new Set([...this.installingIds, communityId]);
    try {
      const settings = loadSettings();
      const baseUrl = settings.baseUrl || undefined;

      // Server handles fetching from community API and creating the skill
      const result = await api.skills.installCommunity(communityId, baseUrl);

      // Fetch full detail for version info and dependency resolution
      let version = 1;
      let detail: CommunitySkillDetail | null = null;
      try {
        detail = await communityApi.getSkill(communityId);
        version = detail.version;
      } catch { /* non-critical */ }

      // Track in local manifest
      this._manifest = {
        ...this._manifest,
        [communityId]: {
          communityId,
          localSlug: result.slug,
          localProgram: result.program,
          installedVersion: version,
          enabled: false,
          installedAt: new Date().toISOString(),
        },
      };
      this._saveManifest();

      // Resolve and install dependencies
      let depCount = 0;
      if (includeDeps && detail) {
        depCount = await this._installDeps(detail, new Set([communityId]));
      }

      if (!silent) {
        const title = result.skill?.title || result.slug;
        const msg = depCount > 0
          ? `Installed "${title}" + ${depCount} dependenc${depCount === 1 ? "y" : "ies"} (disabled by default)`
          : `Installed "${title}" (disabled by default)`;
        toast.success(msg);
      }
    } catch (err: any) {
      if (!silent) toast.error(`Install failed: ${err?.message}`);
      else throw err; // Re-throw so batchInstall can count failures
    } finally {
      const next = new Set(this.installingIds);
      next.delete(communityId);
      this.installingIds = next;
    }
  }

  /** Batch-install multiple community skills sequentially. */
  async batchInstall(communityIds: string[]): Promise<void> {
    const toInstall = communityIds.filter(
      (id) => !this.isInstalled(id) && !this.installingIds.has(id),
    );
    if (toInstall.length === 0) return;

    this.batchInstalling = true;
    this.batchProgress = 0;
    this.batchTotal = toInstall.length;

    let successCount = 0;
    let failCount = 0;

    for (const communityId of toInstall) {
      try {
        await this.install(communityId, true, true);
        successCount++;
      } catch {
        failCount++;
      }
      this.batchProgress++;
    }

    this.batchInstalling = false;

    if (failCount === 0) {
      toast.success(
        `Installed ${successCount} skill${successCount !== 1 ? "s" : ""} (disabled by default)`,
      );
    } else {
      toast.info(
        `Installed ${successCount} of ${toInstall.length} skills (${failCount} failed)`,
      );
    }
  }

  /**
   * Recursively install dependencies for a community skill.
   * Parses `related-skills` from the downloaded SKILL.md content,
   * searches community by slug, and installs each missing dependency.
   */
  private async _installDeps(
    detail: CommunitySkillDetail,
    visited: Set<string>,
  ): Promise<number> {
    // Parse related-skills from the SKILL.md content (YAML frontmatter)
    const relatedSlugs = this._parseRelatedSkills(detail.content);
    if (relatedSlugs.length === 0) return 0;

    let installed = 0;
    for (const depSlug of relatedSlugs) {
      try {
        // Search community for this slug
        const searchResult = await communityApi.search({
          query: depSlug,
          program: detail.program,
          limit: 10,
        });

        // Find exact slug match (prefer same program, then any)
        let match = searchResult.skills.find(
          (s) => s.slug === depSlug && s.program === detail.program,
        );
        if (!match) {
          match = searchResult.skills.find((s) => s.slug === depSlug);
        }
        if (!match || visited.has(match.id)) continue;
        if (this.isInstalled(match.id)) continue;

        visited.add(match.id);

        // Install this dependency
        const settings = loadSettings();
        const baseUrl = settings.baseUrl || undefined;
        const result = await api.skills.installCommunity(match.id, baseUrl);

        // Track in manifest
        this._manifest = {
          ...this._manifest,
          [match.id]: {
            communityId: match.id,
            localSlug: result.slug,
            localProgram: result.program,
            installedVersion: match.version,
            enabled: false,
            installedAt: new Date().toISOString(),
          },
        };
        this._saveManifest();
        installed++;

        // Recursively install this dependency's own dependencies
        try {
          const depDetail = await communityApi.getSkill(match.id);
          installed += await this._installDeps(depDetail, visited);
        } catch { /* non-critical — dep installed, its sub-deps are best-effort */ }
      } catch {
        // Dependency not found on community or install failed — skip silently
      }
    }
    return installed;
  }

  /**
   * Parse `related-skills` from SKILL.md content (YAML frontmatter).
   * Handles both array format and inline format.
   */
  private _parseRelatedSkills(content: string): string[] {
    if (!content) return [];
    // Match YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];
    const fm = fmMatch[1];

    // Match related-skills line(s)
    // Format: related-skills: [slug1, slug2] or related-skills:\n  - slug1\n  - slug2
    const inlineMatch = fm.match(/related-skills:\s*\[([^\]]*)\]/);
    if (inlineMatch) {
      return inlineMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    }

    // YAML list format
    const listMatch = fm.match(/related-skills:\s*\n((?:\s+-\s+.*\n?)*)/);
    if (listMatch) {
      return listMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    }

    return [];
  }

  async uninstall(communityId: string): Promise<void> {
    const entry = this._manifest[communityId];
    if (!entry) return;
    try {
      await api.skills.delete(entry.localSlug, entry.localProgram);
    } catch {
      // Skill may already be deleted locally — that's fine, proceed with manifest cleanup
    }

    const next = { ...this._manifest };
    delete next[communityId];
    this._manifest = next;
    this._saveManifest();

    // Clean up updates tracking
    if (communityId in this.updatesAvailable) {
      const upd = { ...this.updatesAvailable };
      delete upd[communityId];
      this.updatesAvailable = upd;
    }
    toast.info("Skill uninstalled");
  }

  // ---------------------------------------------------------------------------
  // Enable / Disable
  // ---------------------------------------------------------------------------

  async toggleEnabled(communityId: string): Promise<void> {
    const entry = this._manifest[communityId];
    if (!entry) return;
    const newEnabled = !entry.enabled;
    try {
      await api.skills.update(entry.localSlug, { enabled: newEnabled }, entry.localProgram);
      this._manifest = {
        ...this._manifest,
        [communityId]: { ...entry, enabled: newEnabled },
      };
      this._saveManifest();
    } catch (err: any) {
      toast.error(`Failed to ${newEnabled ? "enable" : "disable"} skill: ${err?.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Update detection & application
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<void> {
    const entries = Object.values(this._manifest);
    if (entries.length === 0) return;
    this.checkingUpdates = true;
    const updates: Record<string, number> = {};
    try {
      // Check in batches of 5 to avoid hammering the API
      for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map((e) => communityApi.getSkill(e.communityId)),
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const entry = batch[j];
          if (result.status === "fulfilled" && result.value.version > entry.installedVersion) {
            updates[entry.communityId] = result.value.version;
          }
        }
      }
      this.updatesAvailable = updates;
    } catch {
      // Non-critical
    } finally {
      this.checkingUpdates = false;
    }
  }

  async updateSkill(communityId: string): Promise<void> {
    const entry = this._manifest[communityId];
    if (!entry) return;
    this.installingIds = new Set([...this.installingIds, communityId]);
    try {
      const [detail, content] = await Promise.all([
        communityApi.getSkill(communityId),
        communityApi.downloadSkill(communityId),
      ]);
      await api.skills.update(entry.localSlug, { content }, entry.localProgram);

      // Update manifest
      this._manifest = {
        ...this._manifest,
        [communityId]: { ...entry, installedVersion: detail.version },
      };
      this._saveManifest();

      // Remove from updates
      const upd = { ...this.updatesAvailable };
      delete upd[communityId];
      this.updatesAvailable = upd;

      toast.success(`Updated "${detail.title}" to v${detail.version}`);
    } catch (err: any) {
      toast.error(`Update failed: ${err?.message}`);
    } finally {
      const next = new Set(this.installingIds);
      next.delete(communityId);
      this.installingIds = next;
    }
  }
}

export const communitySkills = new CommunitySkillsState();
