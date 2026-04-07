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

  // Installing/uninstalling tracking
  installingIds = $state<Set<string>>(new Set());

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

  async install(communityId: string): Promise<void> {
    if (this.installingIds.has(communityId)) return;
    this.installingIds = new Set([...this.installingIds, communityId]);
    try {
      // Fetch full detail and SKILL.md content
      const [detail, content] = await Promise.all([
        communityApi.getSkill(communityId),
        communityApi.downloadSkill(communityId),
      ]);

      let slug = detail.slug;
      const program = detail.program || "global";

      // Create on local server (disabled by default)
      try {
        await api.skills.create({
          name: slug,
          slug,
          program,
          category: detail.category || "custom",
          title: detail.title,
          description: detail.description,
          keywords: detail.keywords,
          content,
          enabled: false,
        });
      } catch (err: any) {
        // Handle slug collision — retry with suffix
        if (String(err?.message).includes("409") || String(err?.message).toLowerCase().includes("exists")) {
          slug = `${slug}-community`;
          await api.skills.create({
            name: slug,
            slug,
            program,
            category: detail.category || "custom",
            title: detail.title,
            description: detail.description,
            keywords: detail.keywords,
            content,
            enabled: false,
          });
        } else {
          throw err;
        }
      }

      // Add to manifest
      this._manifest = {
        ...this._manifest,
        [communityId]: {
          communityId,
          localSlug: slug,
          localProgram: program,
          installedVersion: detail.version,
          enabled: false,
          installedAt: new Date().toISOString(),
        },
      };
      this._saveManifest();
      toast.success(`Installed "${detail.title}" (disabled by default)`);
    } catch (err: any) {
      toast.error(`Install failed: ${err?.message}`);
    } finally {
      const next = new Set(this.installingIds);
      next.delete(communityId);
      this.installingIds = next;
    }
  }

  async uninstall(communityId: string): Promise<void> {
    const entry = this._manifest[communityId];
    if (!entry) return;
    try {
      await api.skills.delete(entry.localSlug, entry.localProgram);
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
    } catch (err: any) {
      toast.error(`Uninstall failed: ${err?.message}`);
    }
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
