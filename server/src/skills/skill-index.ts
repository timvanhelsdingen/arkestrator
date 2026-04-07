/**
 * Skill Index — in-memory search index over materialized skills.
 *
 * Provides hybrid lexical + semantic search using TF-IDF primitives
 * copied from training-repository.ts (not imported, since they are
 * internal to that module).
 */

import type { Skill } from "../db/skills.repo.js";

// ---------------------------------------------------------------------------
// Search primitives (copied from training-repository.ts)
// ---------------------------------------------------------------------------

const SEMANTIC_VECTOR_DIM = 48;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your",
  "you", "are", "was", "were", "will", "have", "has", "had", "job",
  "jobs", "task", "tasks", "then", "than", "into", "onto", "about",
  "there", "their", "they", "them", "also", "just", "use", "using",
  "make", "made", "need", "needs", "file", "files", "path", "paths",
  "project", "projects", "data", "scene",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashToken(token: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function uniqueLimited(items: string[], max = 220): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = String(item ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function semanticFragments(text: string): string[] {
  const base = tokenize(text);
  const grams: string[] = [];
  for (const token of base) {
    if (token.length < 5) continue;
    for (let i = 0; i <= token.length - 4; i++) {
      grams.push(token.slice(i, i + 4));
    }
  }
  return uniqueLimited([...base, ...grams], 220);
}

function buildSemanticVector(text: string): number[] {
  const vector = new Array<number>(SEMANTIC_VECTOR_DIM).fill(0);
  const fragments = semanticFragments(text);
  for (const fragment of fragments) {
    const hash = hashToken(fragment);
    const idx = hash % SEMANTIC_VECTOR_DIM;
    const sign = ((hash >>> 1) & 1) === 0 ? 1 : -1;
    vector[idx] += sign;
  }
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 0) return vector;
  return vector.map((value) => Math.round((value / norm) * 1000) / 1000);
}

function semanticSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA <= 0 || magB <= 0) return 0;
  return clamp(dot / (Math.sqrt(magA) * Math.sqrt(magB)), -1, 1);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ranking configuration — configurable via admin API
// ---------------------------------------------------------------------------

export interface SkillRankingConfig {
  /** Uses below this count = exploration phase (optimistic bonus). Default: 8 */
  explorationThreshold: number;
  /** Uses at/above this count = established phase (trust actual rate). Default: 25 */
  establishedThreshold: number;
  /** Score given during exploration phase. Default: 0.6 */
  explorationBonus: number;
  /** Minimum effectiveness score for established skills (prevents hard-disable). Default: 0.10 */
  effectivenessFloor: number;
  /** Weight for lexical (keyword) matching. Default: 0.5 */
  weightLexical: number;
  /** Weight for semantic (vector) matching. Default: 0.3 */
  weightSemantic: number;
  /** Weight for effectiveness scoring. Default: 0.2 */
  weightEffectiveness: number;
  /** Minimum combined score to be included in results. Default: 0.05 */
  minScoreThreshold: number;
}

export const DEFAULT_SKILL_RANKING_CONFIG: SkillRankingConfig = {
  explorationThreshold: 8,
  establishedThreshold: 25,
  explorationBonus: 0.6,
  effectivenessFloor: 0.10,
  weightLexical: 0.5,
  weightSemantic: 0.3,
  weightEffectiveness: 0.2,
  minScoreThreshold: 0.05,
};

/** Settings keys for persisting ranking config in server_settings table. */
export const SKILL_RANKING_SETTINGS_KEYS: Record<keyof SkillRankingConfig, string> = {
  explorationThreshold: "skill_ranking_exploration_threshold",
  establishedThreshold: "skill_ranking_established_threshold",
  explorationBonus: "skill_ranking_exploration_bonus",
  effectivenessFloor: "skill_ranking_effectiveness_floor",
  weightLexical: "skill_ranking_weight_lexical",
  weightSemantic: "skill_ranking_weight_semantic",
  weightEffectiveness: "skill_ranking_weight_effectiveness",
  minScoreThreshold: "skill_ranking_min_score_threshold",
};

export interface SkillEffectivenessInfo {
  successRate: number;
  totalUsed: number;
}

export interface SkillRankResult {
  skill: Skill;
  score: number;
  reason: "ranked" | "auto-fetch";
}

export interface SkillSearchResult {
  slug: string;
  title: string;
  program: string;
  category: string;
  description: string;
  relevanceScore: number;
}

export interface SkillSummary {
  id: string;
  slug: string;
  title: string;
  program: string;
  category: string;
  description: string;
  source: string;
  priority: number;
  autoFetch: boolean;
  enabled: boolean;
  locked: boolean;
  appVersion: string | null;
}

// ---------------------------------------------------------------------------
// SkillIndex
// ---------------------------------------------------------------------------

export class SkillIndex {
  private skills: Skill[] = [];
  /** Inverted index: token -> set of skill indices in this.skills. */
  private invertedIndex: Map<string, Set<number>> = new Map();
  /** Pre-computed semantic vectors for each skill (same order as this.skills). */
  private vectors: number[][] = [];
  private lastRefresh = 0;
  private TTL = 60_000; // 60 seconds

  constructor(private materializerFn: () => Skill[]) {}

  /** Ensure index is fresh (re-materialized if stale). */
  private ensureFresh(): void {
    if (Date.now() - this.lastRefresh > this.TTL) {
      this.refresh();
    }
  }

  /** Force-refresh the index from the materializer. */
  refresh(): void {
    this.skills = this.materializerFn();
    this.invertedIndex = new Map();
    this.vectors = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];

      // Build searchable text from keywords, title, and description
      const searchText = [
        skill.title,
        skill.description,
        ...skill.keywords,
        skill.category,
        skill.program,
      ].join(" ");

      const tokens = tokenize(searchText);
      for (const token of tokens) {
        let set = this.invertedIndex.get(token);
        if (!set) {
          set = new Set();
          this.invertedIndex.set(token, set);
        }
        set.add(i);
      }

      // Build semantic vector from full content
      this.vectors.push(buildSemanticVector(skill.content));
    }

    this.lastRefresh = Date.now();
  }

  /**
   * Hybrid lexical + semantic search over all indexed skills.
   * Returns top results sorted by relevance.
   */
  search(
    query: string,
    opts?: { program?: string; category?: string; limit?: number },
  ): SkillSearchResult[] {
    this.ensureFresh();

    const limit = opts?.limit ?? 20;
    const queryTokens = tokenize(query);
    const queryVector = buildSemanticVector(query);

    // Score each skill
    const scored: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];

      // Filter by program/category if specified
      if (opts?.program && skill.program !== opts.program && skill.program !== "global") continue;
      if (opts?.category && skill.category !== opts.category) continue;
      if (!skill.enabled) continue;

      // Lexical score: fraction of query tokens that hit this skill
      let lexicalHits = 0;
      for (const token of queryTokens) {
        const postings = this.invertedIndex.get(token);
        if (postings?.has(i)) lexicalHits++;
      }
      const lexicalScore = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0;

      // Semantic score: cosine similarity
      const semScore = semanticSimilarity(queryVector, this.vectors[i]);

      // Hybrid: weighted combination (lexical heavier for short queries)
      const score = lexicalScore * 0.65 + Math.max(0, semScore) * 0.35;

      if (score > 0.05) {
        scored.push({ index: i, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ index, score }) => {
      const skill = this.skills[index];
      return {
        slug: skill.slug,
        title: skill.title,
        program: skill.program,
        category: skill.category,
        description: skill.description,
        relevanceScore: Math.round(score * 1000) / 1000,
      };
    });
  }

  /**
   * Rank skills for a specific job prompt using hybrid semantic + lexical + effectiveness scoring.
   * Returns the top-N most relevant skills for injection into agent context.
   *
   * AutoFetch skills (coordinators, bridge scripts) are always included regardless of score.
   * Effectiveness scoring uses a graduated confidence model with configurable thresholds.
   */
  rankForJob(
    prompt: string,
    program: string,
    opts?: {
      limit?: number;
      effectivenessScores?: Map<string, SkillEffectivenessInfo>;
      rankingConfig?: Partial<SkillRankingConfig>;
    },
  ): { results: SkillRankResult[] } {
    this.ensureFresh();

    const limit = opts?.limit ?? 8;
    const effectivenessMap = opts?.effectivenessScores ?? new Map();
    const rc = { ...DEFAULT_SKILL_RANKING_CONFIG, ...opts?.rankingConfig };
    const queryTokens = tokenize(prompt);
    const queryVector = buildSemanticVector(prompt);
    const programLower = program.trim().toLowerCase();

    const autoFetchResults: SkillRankResult[] = [];
    const ranked: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];
      if (!skill.enabled) continue;

      const sp = skill.program.trim().toLowerCase();
      // Filter by program: global + matching
      if (sp && sp !== "global" && programLower && sp !== programLower) continue;

      // AutoFetch skills always get included (coordinator scripts, bridge scripts, etc.)
      if (skill.autoFetch) {
        autoFetchResults.push({ skill, score: 1.0, reason: "auto-fetch" });
        continue;
      }

      const eff = effectivenessMap.get(skill.id);

      // Lexical score: fraction of query tokens that hit this skill
      let lexicalHits = 0;
      for (const token of queryTokens) {
        const postings = this.invertedIndex.get(token);
        if (postings?.has(i)) lexicalHits++;
      }
      const lexicalScore = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0;

      // Semantic score: cosine similarity
      const semScore = Math.max(0, semanticSimilarity(queryVector, this.vectors[i]));

      // Effectiveness score: graduated confidence model with configurable thresholds.
      // Exploration → Transition → Established phases based on usage count.
      let effScore: number;
      if (!eff || eff.totalUsed < rc.explorationThreshold) {
        // Exploration phase: optimistic to encourage discovery
        effScore = rc.explorationBonus;
      } else if (eff.totalUsed < rc.establishedThreshold) {
        // Transition phase: blend neutral toward actual rate as confidence grows
        const range = rc.establishedThreshold - rc.explorationThreshold;
        const confidence = range > 0 ? (eff.totalUsed - rc.explorationThreshold) / range : 1;
        effScore = 0.5 * (1 - confidence) + eff.successRate * confidence;
      } else {
        // Established: trust the data, with a floor so skills aren't fully killed
        effScore = Math.max(rc.effectivenessFloor, eff.successRate);
      }

      // Combined score with configurable weights
      const score = lexicalScore * rc.weightLexical + semScore * rc.weightSemantic + effScore * rc.weightEffectiveness;

      if (score > rc.minScoreThreshold) {
        ranked.push({ index: i, score });
      }
    }

    // Sort by score descending, take top N
    ranked.sort((a, b) => b.score - a.score);
    const topRanked = ranked.slice(0, limit).map(({ index, score }) => ({
      skill: this.skills[index],
      score: Math.round(score * 1000) / 1000,
      reason: "ranked" as const,
    }));

    // AutoFetch first, then ranked by relevance
    return {
      results: [...autoFetchResults, ...topRanked],
    };
  }

  /** Direct lookup by slug, optionally filtered by program. */
  get(slug: string, program?: string): Skill | null {
    this.ensureFresh();
    return this.skills.find(
      (s) => s.slug === slug && (!program || s.program === program),
    ) ?? null;
  }

  /** Return all skills matching filters (lightweight summaries). */
  list(opts?: { program?: string; category?: string }): SkillSummary[] {
    this.ensureFresh();
    return this.skills
      .filter((s) => {
        if (opts?.program && s.program !== opts.program && s.program !== "global") return false;
        if (opts?.category && s.category !== opts.category) return false;
        return s.enabled;
      })
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        title: s.title,
        program: s.program,
        category: s.category,
        description: s.description,
        keywords: s.keywords,
        content: s.content,
        playbooks: s.playbooks,
        relatedSkills: s.relatedSkills,
        source: s.source,
        sourcePath: s.sourcePath,
        priority: s.priority,
        autoFetch: s.autoFetch,
        enabled: s.enabled,
        locked: s.locked,
        appVersion: s.appVersion,
      }));
  }

  /**
   * Return skills that should be auto-fetched for a given program context.
   *
   * Always includes:
   * - Global coordinator script
   * - Program-specific bridge script
   *
   * If verification is required:
   * - Verification-category skills for the program
   */
  getAutoFetch(
    program: string,
    jobConfig?: { verificationMode?: string },
  ): Skill[] {
    this.ensureFresh();

    const results: Skill[] = [];

    for (const skill of this.skills) {
      if (!skill.enabled || !skill.autoFetch) continue;

      // Global coordinator script
      if (skill.category === "coordinator" && skill.program === "global") {
        results.push(skill);
        continue;
      }

      // Bridge-specific coordinator script
      if (skill.category === "bridge" && skill.program === program) {
        results.push(skill);
        continue;
      }

      // Verification skills when verification mode is active
      if (
        skill.category === "verification" &&
        jobConfig?.verificationMode &&
        (skill.program === program || skill.program === "global")
      ) {
        results.push(skill);
        continue;
      }

      // Custom auto-fetch skills matching the program
      if (
        skill.autoFetch &&
        (skill.program === program || skill.program === "global")
      ) {
        results.push(skill);
      }
    }

    // Sort by priority descending
    results.sort((a, b) => b.priority - a.priority);
    return results;
  }
}
