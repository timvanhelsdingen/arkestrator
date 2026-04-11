/**
 * Skill Index — in-memory search index over materialized skills.
 *
 * Provides hybrid lexical + semantic search using BM25-flavoured IDF
 * scoring, field-weighted tokens (title/keywords > content), LSH
 * semantic vectors, and a graduated-confidence effectiveness component.
 */

import type { Skill } from "../db/skills.repo.js";
import type { SkillEffectivenessRepo } from "../db/skill-effectiveness.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";

// ---------------------------------------------------------------------------
// Search primitives
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

/** Short but informative DCC terms that would otherwise be filtered by the length gate. */
const SHORT_ALLOWLIST = new Set([
  "ui", "api", "sdk", "cli", "cpu", "gpu", "ram", "os", "io",
  "2d", "3d", "4d", "vr", "xr", "ar", "hd", "sd", "fx",
  "uv", "ik", "fk", "sp", "rg", "rgb", "hdr", "pbr", "sss",
  "pp", "dof", "aa", "taa", "dx", "gl", "vk",
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/);
  for (const t of raw) {
    const token = t.trim();
    if (!token) continue;
    if (STOP_WORDS.has(token)) continue;
    if (token.length >= 3 || SHORT_ALLOWLIST.has(token)) out.push(token);
  }
  return out;
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
  /**
   * Number of usage rows that have an outcome (positive/average/negative).
   * Pending rows (e.g. from `search_skills` touches that the agent never
   * rated) are excluded. Use THIS for phase calculation — otherwise pending
   * rows inflate the phase counter and push skills out of exploration before
   * any feedback has actually been collected.
   */
  ratedCount: number;
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
  createdAt: string;
}

// ---------------------------------------------------------------------------
// SkillIndex
// ---------------------------------------------------------------------------

/** Field weights (multiplier on term frequency per field). */
const FIELD_WEIGHTS = {
  title: 3.5,
  keywords: 3.0,
  description: 2.0,
  content: 1.0,
} as const;

/**
 * Load the ranker config from server_settings, falling back to defaults.
 * Used by every caller that invokes search / rankForJob so admin tuning
 * actually takes effect at the agent level.
 */
export function loadSkillRankingConfig(settingsRepo?: SettingsRepo | null): SkillRankingConfig {
  const config: SkillRankingConfig = { ...DEFAULT_SKILL_RANKING_CONFIG };
  if (!settingsRepo) return config;
  for (const [field, dbKey] of Object.entries(SKILL_RANKING_SETTINGS_KEYS) as Array<[keyof SkillRankingConfig, string]>) {
    const stored = settingsRepo.getNumber(dbKey);
    if (stored != null && Number.isFinite(stored)) {
      config[field] = stored;
    }
  }
  return config;
}

export class SkillIndex {
  private skills: Skill[] = [];
  /** Inverted index: token -> Map<skill index, weighted term frequency>. */
  private invertedIndex: Map<string, Map<number, number>> = new Map();
  /** Document frequency per token (number of skills containing it). */
  private docFreq: Map<string, number> = new Map();
  /** Pre-computed semantic vectors for each skill (same order as this.skills). */
  private vectors: number[][] = [];
  /** Sum of weighted token counts per skill (for BM25-ish length norm). */
  private docLengths: number[] = [];
  /** Average weighted doc length (for BM25). */
  private avgDocLength = 1;
  private lastRefresh = 0;
  private TTL = 60_000; // 60 seconds

  constructor(
    private materializerFn: () => Skill[],
    private settingsRepo?: SettingsRepo | null,
    private effectivenessRepo?: SkillEffectivenessRepo | null,
  ) {}

  /** Late-bind the effectiveness repo (construction order dependency). */
  setEffectivenessRepo(repo: SkillEffectivenessRepo | null | undefined): void {
    this.effectivenessRepo = repo;
  }

  /** Late-bind the settings repo. */
  setSettingsRepo(repo: SettingsRepo | null | undefined): void {
    this.settingsRepo = repo;
  }

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
    this.docFreq = new Map();
    this.vectors = [];
    this.docLengths = [];

    let totalLen = 0;

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];

      // Field-weighted token counts. Each field multiplies its tokens' TF so
      // a hit in the title outweighs the same token buried in body content.
      const termCounts = new Map<string, number>();
      const addTokens = (text: string, weight: number) => {
        const toks = tokenize(text);
        for (const t of toks) {
          termCounts.set(t, (termCounts.get(t) ?? 0) + weight);
        }
      };
      addTokens(skill.title, FIELD_WEIGHTS.title);
      addTokens(skill.description, FIELD_WEIGHTS.description);
      for (const kw of skill.keywords) addTokens(kw, FIELD_WEIGHTS.keywords);
      addTokens(skill.category, FIELD_WEIGHTS.description);
      addTokens(skill.program, FIELD_WEIGHTS.description);
      addTokens(skill.content, FIELD_WEIGHTS.content);

      // Populate inverted index + document-frequency counts.
      let docLen = 0;
      for (const [token, tf] of termCounts) {
        let postings = this.invertedIndex.get(token);
        if (!postings) {
          postings = new Map();
          this.invertedIndex.set(token, postings);
        }
        postings.set(i, tf);
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
        docLen += tf;
      }
      this.docLengths.push(docLen);
      totalLen += docLen;

      // Semantic vector from title + description + keywords + content — not
      // content-only (previously the short skills had near-zero vectors).
      const semText = [
        skill.title,
        skill.description,
        skill.keywords.join(" "),
        skill.content,
      ].join(" ");
      this.vectors.push(buildSemanticVector(semText));
    }

    this.avgDocLength = this.skills.length > 0 ? totalLen / this.skills.length : 1;
    if (!(this.avgDocLength > 0)) this.avgDocLength = 1;
    this.lastRefresh = Date.now();
  }

  /** Number of skills in the index (for IDF). */
  get size(): number {
    this.ensureFresh();
    return this.skills.length;
  }

  /** BM25-flavoured IDF: log((N - df + 0.5) / (df + 0.5) + 1). */
  private idf(token: string): number {
    const n = this.skills.length;
    const df = this.docFreq.get(token) ?? 0;
    if (df === 0) return 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * Compute a field-weighted, IDF-scaled lexical relevance score for a single
   * document against a query token list. Mirrors BM25 with k1 = 1.2, b = 0.6.
   * Output is normalised to ~[0, 1] by dividing by the query's max possible
   * contribution so the result composes cleanly with semantic/effectiveness.
   */
  private lexicalScore(docIndex: number, queryTokens: string[]): number {
    if (queryTokens.length === 0) return 0;
    const k1 = 1.2;
    const b = 0.6;
    const docLen = this.docLengths[docIndex] ?? 1;
    const lenNorm = docLen / (this.avgDocLength || 1);

    let score = 0;
    let maxPossible = 0;
    for (const token of queryTokens) {
      const idf = this.idf(token);
      maxPossible += idf;
      if (idf <= 0) continue;
      const postings = this.invertedIndex.get(token);
      if (!postings) continue;
      const tf = postings.get(docIndex);
      if (!tf) continue;
      const tfScaled = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lenNorm));
      score += idf * tfScaled;
    }
    if (maxPossible <= 0) return 0;
    // Normalise against best-case contribution (BM25's TF saturates at k1+1).
    return clamp(score / (maxPossible * (k1 + 1)), 0, 1);
  }

  /**
   * Combined relevance score for a single skill against a query, already
   * length-normalised and effectiveness-aware. Returns the individual
   * components so callers can log/debug without re-computing.
   */
  private scoreSkill(
    docIndex: number,
    queryTokens: string[],
    queryVector: number[],
    effectivenessMap: Map<string, SkillEffectivenessInfo>,
    rc: SkillRankingConfig,
  ): { score: number; lexical: number; semantic: number; effectiveness: number } {
    const skill = this.skills[docIndex];
    const lexical = this.lexicalScore(docIndex, queryTokens);
    const semantic = Math.max(0, semanticSimilarity(queryVector, this.vectors[docIndex]));

    const eff = effectivenessMap.get(skill.id);
    let effectiveness: number;
    const ratedCount = eff?.ratedCount ?? 0;
    if (!eff || ratedCount < rc.explorationThreshold) {
      effectiveness = rc.explorationBonus;
    } else if (ratedCount < rc.establishedThreshold) {
      const range = rc.establishedThreshold - rc.explorationThreshold;
      const confidence = range > 0 ? (ratedCount - rc.explorationThreshold) / range : 1;
      effectiveness = 0.5 * (1 - confidence) + eff.successRate * confidence;
    } else {
      effectiveness = Math.max(rc.effectivenessFloor, eff.successRate);
    }

    // Priority boost: +0 at priority 50 (neutral), ±0.05 at 0/100.
    // Only a tie-breaker — keeps admin-curated skills ahead of equivalents.
    const priorityBoost = ((clamp(skill.priority ?? 50, 0, 100) - 50) / 1000);
    // Program specificity bonus: a program-matching skill edges out a
    // global one at the same content score so "blender-sprite" ranks
    // above "generic-file-handling" for a blender job.
    const sp = skill.program.trim().toLowerCase();
    const specificityBonus = sp && sp !== "global" ? 0.03 : 0;

    const score =
      lexical * rc.weightLexical +
      semantic * rc.weightSemantic +
      effectiveness * rc.weightEffectiveness +
      priorityBoost +
      specificityBonus;

    return { score, lexical, semantic, effectiveness };
  }

  /**
   * Hybrid lexical + semantic search over all indexed skills. Uses the
   * shared scorer so results stay in sync with rankForJob / agent context.
   */
  search(
    query: string,
    opts?: {
      program?: string;
      category?: string;
      limit?: number;
      rankingConfig?: Partial<SkillRankingConfig>;
      /**
       * Enabled MCP preset IDs for the calling context (e.g. a spawning job's
       * enabled MCP bridges). Skills tagged with `mcpPresetId` are only
       * included when their preset is in this list. Pass `undefined` to
       * include every MCP-tagged skill (backward-compat / admin search).
       */
      enabledMcpPresetIds?: string[];
    },
  ): SkillSearchResult[] {
    this.ensureFresh();

    const limit = opts?.limit ?? 20;
    const rc: SkillRankingConfig = { ...loadSkillRankingConfig(this.settingsRepo), ...(opts?.rankingConfig ?? {}) };
    const queryTokens = tokenize(query);
    const queryVector = buildSemanticVector(query);
    const programFilter = opts?.program?.trim().toLowerCase() ?? "";
    const enabledMcp = opts?.enabledMcpPresetIds;
    const effectivenessMap = this.buildEffectivenessMap();

    const scored: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];
      if (!skill.enabled) continue;

      // MCP-scoped skills: include only if their preset is in the caller's
      // enabled list. If enabledMcp is undefined, fall through to the old
      // program-based filter (backward-compat for callers that don't pass it).
      if (skill.mcpPresetId) {
        if (enabledMcp !== undefined && !enabledMcp.includes(skill.mcpPresetId)) continue;
        // MCP skills always live under program='global', so skip the
        // program-mismatch check below.
      } else {
        const sp = skill.program.trim().toLowerCase();
        if (programFilter && sp && sp !== "global" && sp !== programFilter) continue;
      }
      if (opts?.category && skill.category !== opts.category) continue;

      const { score } = this.scoreSkill(i, queryTokens, queryVector, effectivenessMap, rc);
      if (score >= rc.minScoreThreshold) {
        scored.push({ index: i, score });
      }
    }

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
   * Pull current effectiveness stats for every known skill in one query.
   * Cached per-refresh so repeated search() calls in the same tick reuse
   * the same data. Falls back to an empty map if the repo isn't wired.
   */
  private buildEffectivenessMap(): Map<string, SkillEffectivenessInfo> {
    if (!this.effectivenessRepo) return new Map();
    const raw = this.effectivenessRepo.getRankingInfoForAllSkills();
    const out = new Map<string, SkillEffectivenessInfo>();
    for (const [id, stats] of raw) {
      out.set(id, {
        successRate: stats.successRate,
        totalUsed: stats.totalUsed,
        ratedCount: stats.ratedCount,
      });
    }
    return out;
  }

  /**
   * Rank skills for a specific job prompt. AutoFetch skills are always
   * included (coordinators, bridge scripts), sorted by priority. Non-
   * autofetch skills are scored via the shared lexical+semantic+effectiveness
   * pipeline.
   */
  rankForJob(
    prompt: string,
    program: string,
    opts?: {
      limit?: number;
      effectivenessScores?: Map<string, SkillEffectivenessInfo>;
      rankingConfig?: Partial<SkillRankingConfig>;
      /**
       * MCP preset IDs enabled for the job's bridge set. Tool-usage skills
       * (those tagged with `mcpPresetId`) are only included when their preset
       * is in this list. Omit to skip MCP filtering entirely.
       */
      enabledMcpPresetIds?: string[];
    },
  ): { results: SkillRankResult[] } {
    this.ensureFresh();

    const limit = opts?.limit ?? 8;
    const effectivenessMap =
      opts?.effectivenessScores ?? this.buildEffectivenessMap();
    const rc: SkillRankingConfig = { ...loadSkillRankingConfig(this.settingsRepo), ...(opts?.rankingConfig ?? {}) };
    const queryTokens = tokenize(prompt);
    const queryVector = buildSemanticVector(prompt);
    const programLower = program.trim().toLowerCase();
    const enabledMcp = opts?.enabledMcpPresetIds;

    const autoFetchResults: SkillRankResult[] = [];
    const ranked: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.skills.length; i++) {
      const skill = this.skills[i];
      if (!skill.enabled) continue;

      // MCP-scoped skills: include only if the job has that MCP bridge
      // enabled. When `enabledMcp` is undefined, MCP filtering is off and
      // these skills fall through to the program check.
      if (skill.mcpPresetId) {
        if (enabledMcp !== undefined && !enabledMcp.includes(skill.mcpPresetId)) continue;
      } else {
        const sp = skill.program.trim().toLowerCase();
        if (sp && sp !== "global" && programLower && sp !== programLower) continue;
      }

      if (skill.autoFetch) {
        autoFetchResults.push({ skill, score: 1.0, reason: "auto-fetch" });
        continue;
      }

      const { score } = this.scoreSkill(i, queryTokens, queryVector, effectivenessMap, rc);
      if (score >= rc.minScoreThreshold) {
        ranked.push({ index: i, score });
      }
    }

    // Sort auto-fetch skills by priority DESC so coordinators (90) come
    // before bridges (70) before custom auto-fetch skills (default 50).
    autoFetchResults.sort((a, b) => (b.skill.priority ?? 0) - (a.skill.priority ?? 0));

    ranked.sort((a, b) => b.score - a.score);
    const topRanked = ranked.slice(0, limit).map(({ index, score }) => ({
      skill: this.skills[index],
      score: Math.round(score * 1000) / 1000,
      reason: "ranked" as const,
    }));

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

  /**
   * Truncate markdown content at a safe boundary (never mid-code-fence,
   * never mid-list-item). Returns `content` unchanged if it fits, or a
   * truncated version with a trailing `…` marker. Keeps code fences
   * balanced by closing any open ``` block before the cut.
   */
  static truncateMarkdown(content: string, maxChars: number): string {
    if (!content || content.length <= maxChars) return content ?? "";
    // Prefer a cut at the last paragraph break, then last sentence break,
    // then last newline, then hard cut.
    const window = content.slice(0, maxChars);
    let cut = window.length;
    const tryCut = (re: RegExp, min: number) => {
      let best = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(window)) !== null) {
        if (m.index >= min) best = m.index;
      }
      if (best > 0) cut = Math.min(cut, best);
    };
    // Paragraph break
    tryCut(/\n\n/g, Math.floor(maxChars * 0.5));
    // Line break fallback
    if (cut === window.length) tryCut(/\n/g, Math.floor(maxChars * 0.5));
    let body = content.slice(0, cut).replace(/\s+$/, "");
    // Balance code fences. If we have an odd number of ``` markers, the
    // cut landed inside a code block — close it before handing the text
    // to the agent, otherwise it bleeds into the surrounding prompt.
    const fenceCount = (body.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      body += "\n```";
    }
    return `${body}\n\n…[truncated]`;
  }

  /** Return all skills matching filters (lightweight summaries). */
  list(opts?: { program?: string; category?: string; includeDisabled?: boolean }): SkillSummary[] {
    this.ensureFresh();
    return this.skills
      .filter((s) => {
        if (opts?.program && s.program !== opts.program && s.program !== "global") return false;
        if (opts?.category && s.category !== opts.category) return false;
        if (!opts?.includeDisabled && !s.enabled) return false;
        return true;
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
        createdAt: s.createdAt,
      }));
  }

}
