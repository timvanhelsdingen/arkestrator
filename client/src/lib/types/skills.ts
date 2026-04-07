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
}

export interface SkillEffectiveness {
  totalUsed: number;
  successRate: number;
  pendingOutcomes: number;
  goodOutcomes: number;
  averageOutcomes: number;
  poorOutcomes: number;
}
