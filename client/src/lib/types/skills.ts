export interface SkillEntry {
  id: string;
  slug: string;
  name?: string;
  program: string;
  category: string;
  title: string;
  description?: string;
  keywords?: string[];
  content?: string;
  playbooks?: string[];
  relatedSkills?: string[];
  source?: string;
  sourcePath?: string | null;
  priority?: number;
  autoFetch?: boolean;
  enabled?: boolean;
  locked?: boolean;
  appVersion?: string | null;
  createdAt?: string;
  /** Upstream marketplace skill id (present when source === "community"). */
  communityId?: string | null;
  /** Publisher login captured at install time. */
  authorLogin?: string | null;
  /** Marketplace trust tier at install time (verified, community, etc.). */
  trustTier?: string | null;
  /** Server-rendered link back to the marketplace page for this skill. */
  communityUrl?: string | null;
}

export interface SkillEffectiveness {
  totalUsed: number;
  successRate: number;
  pendingOutcomes: number;
  goodOutcomes: number;
  averageOutcomes: number;
  poorOutcomes: number;
}
