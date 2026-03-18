import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "path";

export type TrainingQualityRating = "good" | "average" | "poor";
export const TRAINING_REPOSITORY_POLICY_SETTINGS_KEY = "training_repository_policy_v1";
export const TRAINING_REPOSITORY_OVERRIDES_SETTINGS_KEY = "training_repository_overrides_v1";

export type TrainingRepositorySourceKind =
  | "training_objective"
  | "job_outcome"
  | "experience"
  | "project_config"
  | "project_notes"
  | "playbook_snapshot"
  | "upload_file"
  | "scene_file";

export interface TrainingRepositoryPolicy {
  version: 1;
  retrieval: {
    lexicalWeight: number;
    semanticWeight: number;
    qualityWeight: number;
    minTrustScore: number;
    minScore: number;
    includeQuarantined: boolean;
    maxResults: number;
  };
  ingestion: {
    retentionDays: number;
    quarantineEnabled: boolean;
    quarantinePatterns: string[];
  };
  trustBySourceKind: Record<TrainingRepositorySourceKind, number>;
}

export interface TrainingRepositoryPolicyPatch {
  retrieval?: Partial<TrainingRepositoryPolicy["retrieval"]>;
  ingestion?: Partial<TrainingRepositoryPolicy["ingestion"]>;
  trustBySourceKind?: Partial<TrainingRepositoryPolicy["trustBySourceKind"]>;
}

export type TrainingRepositoryOverrideMode = "allow" | "quarantine" | "suppress";

export interface TrainingRepositoryOverrideRule {
  mode: TrainingRepositoryOverrideMode;
  trustDelta?: number;
  note?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TrainingRepositoryOverrides {
  version: 1;
  byId: Record<string, TrainingRepositoryOverrideRule>;
  bySourcePath: Record<string, TrainingRepositoryOverrideRule>;
}

export interface TrainingRepositoryRecord {
  id: string;
  program: string;
  sourceKind: TrainingRepositorySourceKind;
  sourcePath: string;
  title: string;
  summary: string;
  prompt?: string;
  outcome?: string;
  qualityRating: TrainingQualityRating;
  qualityWeight: number;
  sourceReliability: number;
  trustScore: number;
  quarantined: boolean;
  quarantineReasons: string[];
  semanticVector: number[];
  score: number;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
  tags: string[];
  metadata?: {
    jobId?: string;
    bridgeProgram?: string;
    usedBridges?: string[];
    trainingObjective?: string;
  };
}

type TrainingRepositoryRecordSeed = Omit<
  TrainingRepositoryRecord,
  "score" | "trustScore" | "quarantined" | "quarantineReasons" | "semanticVector"
>;

export interface TrainingRepositoryIndex {
  version: 2;
  program: string;
  generatedAt: string;
  recordCount: number;
  termCount: number;
  stats: {
    bySourceKind: Partial<Record<TrainingRepositorySourceKind, number>>;
    byQuality: Record<TrainingQualityRating, number>;
  };
  records: TrainingRepositoryRecord[];
  invertedIndex: Record<string, number[]>;
}

export interface RefreshTrainingRepositoryIndexOptions {
  dir: string;
  program: string;
  sourcePaths?: string[];
  trainingObjective?: string;
  policy?: TrainingRepositoryPolicy | TrainingRepositoryPolicyPatch | null;
  overrides?: TrainingRepositoryOverrides | null;
}

export interface QueryTrainingRepositoryOptions {
  dir: string;
  program?: string;
  prompt: string;
  maxResults?: number;
  policy?: TrainingRepositoryPolicy | TrainingRepositoryPolicyPatch | null;
  overrides?: TrainingRepositoryOverrides | null;
}

export interface TrainingRepositoryHit {
  record: TrainingRepositoryRecord;
  score: number;
  matchedTerms: string[];
  lexicalScore: number;
  semanticScore: number;
}

export interface TrainingRepositoryRefreshStatus {
  program: string;
  running: boolean;
  pending: boolean;
  refreshCount: number;
  lastQueuedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
}

export interface ScheduleTrainingRepositoryRefreshOptions extends RefreshTrainingRepositoryIndexOptions {
  reason?: string;
  debounceMs?: number;
}

export interface ListTrainingRepositoryRecordsOptions {
  dir: string;
  program?: string;
  query?: string;
  includeQuarantined?: boolean;
  includeSuppressed?: boolean;
  maxResults?: number;
  policy?: TrainingRepositoryPolicy | TrainingRepositoryPolicyPatch | null;
  overrides?: TrainingRepositoryOverrides | null;
}

export interface TrainingRepositoryMetrics {
  program: string;
  queryCount: number;
  queryCacheHits: number;
  avgQueryMs: number;
  refreshCount: number;
  avgRefreshMs: number;
  lastQueryAt?: string;
  lastRefreshAt?: string;
  lastRefreshError?: string;
}

const INDEX_VERSION = 2;
const MAX_SCAN_FILES_PER_ROOT = 4_000;
const MAX_SCAN_DEPTH = 8;
const MAX_INDEX_RECORDS = 6_000;
const MAX_TEXT_BYTES = 512_000;
const MAX_SUMMARY_CHARS = 460;
const MAX_KEYWORDS = 48;
const MAX_TERMS_PER_RECORD = 72;
const SEMANTIC_VECTOR_DIM = 48;
const DEFAULT_REFRESH_DEBOUNCE_MS = 1_200;
const MAX_CANDIDATE_SCAN = 280;

export const DEFAULT_TRAINING_REPOSITORY_POLICY: TrainingRepositoryPolicy = {
  version: 1,
  retrieval: {
    lexicalWeight: 0.72,
    semanticWeight: 0.28,
    qualityWeight: 0.16,
    minTrustScore: 0.42,
    minScore: 0,
    includeQuarantined: false,
    maxResults: 6,
  },
  ingestion: {
    retentionDays: 365,
    quarantineEnabled: true,
    quarantinePatterns: [
      "ignore previous instructions",
      "ignore all prior",
      "system prompt",
      "disable safety",
      "bypass policy",
      "exfiltrate",
      "export secrets",
      "reveal hidden prompt",
    ],
  },
  trustBySourceKind: {
    job_outcome: 0.92,
    experience: 0.86,
    project_config: 0.8,
    project_notes: 0.74,
    playbook_snapshot: 0.72,
    training_objective: 0.64,
    upload_file: 0.48,
    scene_file: 0.52,
  },
};

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".cfg",
  ".ini",
  ".py",
  ".gd",
  ".vfl",
  ".usda",
  ".csv",
  ".xml",
  ".log",
]);

const SCENE_FILE_EXTENSIONS = new Set([
  ".hip",
  ".hiplc",
  ".hipnc",
  ".blend",
  ".ma",
  ".mb",
  ".usd",
  ".usda",
  ".usdc",
  ".fbx",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
  ".pnpm",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "cache",
  "tmp",
  "temp",
  "logs",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "will",
  "have",
  "has",
  "had",
  "job",
  "jobs",
  "task",
  "tasks",
  "then",
  "than",
  "into",
  "onto",
  "about",
  "there",
  "their",
  "they",
  "them",
  "also",
  "just",
  "use",
  "using",
  "make",
  "made",
  "need",
  "needs",
  "file",
  "files",
  "path",
  "paths",
  "project",
  "projects",
  "data",
  "scene",
]);

const CACHE = new Map<string, { mtimeMs: number; index: TrainingRepositoryIndex }>();
const QUERY_CACHE = new Map<string, { mtimeMs: number; hits: TrainingRepositoryHit[] }>();
const METRICS = new Map<string, {
  program: string;
  queryCount: number;
  queryCacheHits: number;
  queryMsTotal: number;
  refreshCount: number;
  refreshMsTotal: number;
  lastQueryAt?: string;
  lastRefreshAt?: string;
  lastRefreshError?: string;
}>();

type RefreshQueueEntry = {
  key: string;
  dir: string;
  program: string;
  pending: RefreshTrainingRepositoryIndexOptions | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  status: TrainingRepositoryRefreshStatus;
};

const REFRESH_QUEUE = new Map<string, RefreshQueueEntry>();

const DEFAULT_TRAINING_REPOSITORY_OVERRIDES: TrainingRepositoryOverrides = {
  version: 1,
  byId: {},
  bySourcePath: {},
};

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

function normalizePolicyNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function normalizePolicyPatterns(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = uniqueLimited(
    value
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean),
    48,
  );
  return out.length > 0 ? out : [...fallback];
}

function mergeTrainingRepositoryPolicy(
  base: TrainingRepositoryPolicy,
  patch?: TrainingRepositoryPolicyPatch | null,
): TrainingRepositoryPolicy {
  if (!patch) return base;
  const retrieval = patch.retrieval ?? {};
  const ingestion = patch.ingestion ?? {};
  const trustPatch = patch.trustBySourceKind ?? {};
  return {
    version: 1,
    retrieval: {
      lexicalWeight: normalizePolicyNumber(
        retrieval.lexicalWeight,
        base.retrieval.lexicalWeight,
        0,
        3,
      ),
      semanticWeight: normalizePolicyNumber(
        retrieval.semanticWeight,
        base.retrieval.semanticWeight,
        0,
        3,
      ),
      qualityWeight: normalizePolicyNumber(
        retrieval.qualityWeight,
        base.retrieval.qualityWeight,
        -2,
        2,
      ),
      minTrustScore: normalizePolicyNumber(
        retrieval.minTrustScore,
        base.retrieval.minTrustScore,
        0,
        1,
      ),
      minScore: normalizePolicyNumber(
        retrieval.minScore,
        base.retrieval.minScore,
        -5,
        100,
      ),
      includeQuarantined: retrieval.includeQuarantined == null
        ? base.retrieval.includeQuarantined
        : retrieval.includeQuarantined === true,
      maxResults: Math.round(
        normalizePolicyNumber(retrieval.maxResults, base.retrieval.maxResults, 1, 24),
      ),
    },
    ingestion: {
      retentionDays: Math.round(
        normalizePolicyNumber(ingestion.retentionDays, base.ingestion.retentionDays, 7, 3650),
      ),
      quarantineEnabled: ingestion.quarantineEnabled == null
        ? base.ingestion.quarantineEnabled
        : ingestion.quarantineEnabled === true,
      quarantinePatterns: normalizePolicyPatterns(ingestion.quarantinePatterns, base.ingestion.quarantinePatterns),
    },
    trustBySourceKind: {
      training_objective: normalizePolicyNumber(
        trustPatch.training_objective,
        base.trustBySourceKind.training_objective,
        0,
        1,
      ),
      job_outcome: normalizePolicyNumber(
        trustPatch.job_outcome,
        base.trustBySourceKind.job_outcome,
        0,
        1,
      ),
      experience: normalizePolicyNumber(
        trustPatch.experience,
        base.trustBySourceKind.experience,
        0,
        1,
      ),
      project_config: normalizePolicyNumber(
        trustPatch.project_config,
        base.trustBySourceKind.project_config,
        0,
        1,
      ),
      project_notes: normalizePolicyNumber(
        trustPatch.project_notes,
        base.trustBySourceKind.project_notes,
        0,
        1,
      ),
      playbook_snapshot: normalizePolicyNumber(
        trustPatch.playbook_snapshot,
        base.trustBySourceKind.playbook_snapshot,
        0,
        1,
      ),
      upload_file: normalizePolicyNumber(
        trustPatch.upload_file,
        base.trustBySourceKind.upload_file,
        0,
        1,
      ),
      scene_file: normalizePolicyNumber(
        trustPatch.scene_file,
        base.trustBySourceKind.scene_file,
        0,
        1,
      ),
    },
  };
}

export function parseTrainingRepositoryPolicy(
  value: unknown,
): TrainingRepositoryPolicy {
  if (!value) return DEFAULT_TRAINING_REPOSITORY_POLICY;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return DEFAULT_TRAINING_REPOSITORY_POLICY;
    try {
      const parsed = JSON.parse(text);
      return parseTrainingRepositoryPolicy(parsed);
    } catch {
      return DEFAULT_TRAINING_REPOSITORY_POLICY;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return DEFAULT_TRAINING_REPOSITORY_POLICY;

  const parsed = value as Record<string, unknown>;
  const patch: TrainingRepositoryPolicyPatch = {
    retrieval: parsed.retrieval && typeof parsed.retrieval === "object" && !Array.isArray(parsed.retrieval)
      ? parsed.retrieval as TrainingRepositoryPolicyPatch["retrieval"]
      : undefined,
    ingestion: parsed.ingestion && typeof parsed.ingestion === "object" && !Array.isArray(parsed.ingestion)
      ? parsed.ingestion as TrainingRepositoryPolicyPatch["ingestion"]
      : undefined,
    trustBySourceKind: parsed.trustBySourceKind && typeof parsed.trustBySourceKind === "object"
      && !Array.isArray(parsed.trustBySourceKind)
      ? parsed.trustBySourceKind as TrainingRepositoryPolicyPatch["trustBySourceKind"]
      : undefined,
  };
  return mergeTrainingRepositoryPolicy(DEFAULT_TRAINING_REPOSITORY_POLICY, patch);
}

export function policyToJson(policy: TrainingRepositoryPolicy): string {
  return JSON.stringify(policy);
}

function normalizeOverrideMode(value: unknown): TrainingRepositoryOverrideMode | null {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "allow" || mode === "quarantine" || mode === "suppress") return mode;
  return null;
}

function normalizeOverrideRule(value: unknown): TrainingRepositoryOverrideRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const mode = normalizeOverrideMode(row.mode);
  if (!mode) return null;
  const trustDelta = row.trustDelta == null
    ? undefined
    : normalizePolicyNumber(row.trustDelta, 0, -0.6, 0.6);
  return {
    mode,
    trustDelta,
    note: normalizeText(row.note, 300) || undefined,
    updatedAt: toIsoOrNow(row.updatedAt),
    updatedBy: normalizeText(row.updatedBy, 120) || undefined,
  };
}

function normalizeSourcePathKey(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

export function parseTrainingRepositoryOverrides(
  value: unknown,
): TrainingRepositoryOverrides {
  if (!value) return DEFAULT_TRAINING_REPOSITORY_OVERRIDES;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return DEFAULT_TRAINING_REPOSITORY_OVERRIDES;
    try {
      const parsed = JSON.parse(text);
      return parseTrainingRepositoryOverrides(parsed);
    } catch {
      return DEFAULT_TRAINING_REPOSITORY_OVERRIDES;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return DEFAULT_TRAINING_REPOSITORY_OVERRIDES;
  const parsed = value as Record<string, unknown>;
  const byId: Record<string, TrainingRepositoryOverrideRule> = {};
  const bySourcePath: Record<string, TrainingRepositoryOverrideRule> = {};

  if (parsed.byId && typeof parsed.byId === "object" && !Array.isArray(parsed.byId)) {
    for (const [id, rule] of Object.entries(parsed.byId as Record<string, unknown>)) {
      const key = normalizeText(id, 280);
      if (!key) continue;
      const normalizedRule = normalizeOverrideRule(rule);
      if (!normalizedRule) continue;
      byId[key] = normalizedRule;
    }
  }
  if (parsed.bySourcePath && typeof parsed.bySourcePath === "object" && !Array.isArray(parsed.bySourcePath)) {
    for (const [path, rule] of Object.entries(parsed.bySourcePath as Record<string, unknown>)) {
      const key = normalizeSourcePathKey(path);
      if (!key) continue;
      const normalizedRule = normalizeOverrideRule(rule);
      if (!normalizedRule) continue;
      bySourcePath[key] = normalizedRule;
    }
  }

  return {
    version: 1,
    byId,
    bySourcePath,
  };
}

export function overridesToJson(overrides: TrainingRepositoryOverrides): string {
  return JSON.stringify(overrides);
}

function resolveOverrides(overrides: TrainingRepositoryOverrides | null | undefined): TrainingRepositoryOverrides {
  if (!overrides) return DEFAULT_TRAINING_REPOSITORY_OVERRIDES;
  return parseTrainingRepositoryOverrides(overrides);
}

function findOverrideRule(
  record: Pick<TrainingRepositoryRecord, "id" | "sourcePath">,
  overrides: TrainingRepositoryOverrides,
): TrainingRepositoryOverrideRule | null {
  if (overrides.byId[record.id]) return overrides.byId[record.id];
  const sourcePath = normalizeSourcePathKey(record.sourcePath);
  if (sourcePath && overrides.bySourcePath[sourcePath]) return overrides.bySourcePath[sourcePath];
  return null;
}

function applyOverrideToRecord(
  record: TrainingRepositoryRecord,
  overrides: TrainingRepositoryOverrides,
): { record: TrainingRepositoryRecord; suppressed: boolean; overridden: boolean } {
  const rule = findOverrideRule(record, overrides);
  if (!rule) return { record, suppressed: false, overridden: false };
  if (rule.mode === "suppress") {
    return { record, suppressed: true, overridden: true };
  }
  const next: TrainingRepositoryRecord = {
    ...record,
    quarantineReasons: [...record.quarantineReasons],
    semanticVector: [...record.semanticVector],
    keywords: [...record.keywords],
    tags: [...record.tags],
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
  const trustDelta = normalizePolicyNumber(rule.trustDelta, 0, -0.6, 0.6);

  if (rule.mode === "allow") {
    next.quarantined = false;
    next.quarantineReasons = [];
    next.trustScore = clamp(Math.max(next.trustScore, 0.7) + trustDelta, 0, 1);
  } else if (rule.mode === "quarantine") {
    next.quarantined = true;
    next.trustScore = clamp(next.trustScore + trustDelta - 0.08, 0, 1);
    const reason = "policy_override";
    if (!next.quarantineReasons.includes(reason)) next.quarantineReasons.push(reason);
  } else {
    next.trustScore = clamp(next.trustScore + trustDelta, 0, 1);
  }

  next.score = computeRecordScore(next);
  return { record: next, suppressed: false, overridden: true };
}

function resolvePolicy(
  policy: TrainingRepositoryPolicy | TrainingRepositoryPolicyPatch | null | undefined,
): TrainingRepositoryPolicy {
  if (!policy) return DEFAULT_TRAINING_REPOSITORY_POLICY;
  const maybePolicy = policy as TrainingRepositoryPolicy;
  if (
    maybePolicy.version === 1
    && maybePolicy.retrieval
    && maybePolicy.ingestion
    && maybePolicy.trustBySourceKind
  ) {
    return parseTrainingRepositoryPolicy(maybePolicy);
  }
  return mergeTrainingRepositoryPolicy(
    DEFAULT_TRAINING_REPOSITORY_POLICY,
    policy as TrainingRepositoryPolicyPatch,
  );
}

function scanQuarantineReasons(
  text: string,
  policy: TrainingRepositoryPolicy,
): string[] {
  if (!policy.ingestion.quarantineEnabled) return [];
  const haystack = text.toLowerCase();
  const matches: string[] = [];
  for (const pattern of policy.ingestion.quarantinePatterns) {
    const p = String(pattern ?? "").trim().toLowerCase();
    if (!p) continue;
    if (haystack.includes(p)) {
      matches.push(p);
      if (matches.length >= 8) break;
    }
  }
  return matches;
}

function computeTrustScore(
  record: Pick<TrainingRepositoryRecord, "sourceKind" | "qualityRating" | "updatedAt" | "sourceReliability">,
  policy: TrainingRepositoryPolicy,
  quarantined: boolean,
): number {
  let trust = policy.trustBySourceKind[record.sourceKind] ?? 0.5;
  if (record.qualityRating === "good") trust += 0.04;
  if (record.qualityRating === "poor") trust -= 0.12;
  if (record.sourceReliability > 1.2) trust += 0.03;
  if (record.sourceReliability < 0.9) trust -= 0.03;
  const ageDays = Math.max(0, (Date.now() - Date.parse(record.updatedAt)) / 86_400_000);
  if (ageDays > policy.ingestion.retentionDays) trust -= 0.1;
  if (quarantined) trust = Math.min(trust, 0.2);
  return Math.round(clamp(trust, 0, 1) * 1000) / 1000;
}

function normalizeProgram(value: unknown): string | null {
  const out = String(value ?? "").trim().toLowerCase();
  if (!out || !/^[a-z0-9._-]+$/.test(out)) return null;
  return out;
}

function learningRoot(dir: string): string {
  return join(dir, "_learning");
}

function indexFilePath(dir: string, program: string): string {
  return join(learningRoot(dir), "index", `${program}.json`);
}

function normalizeScanRootPath(rootDir: string, candidatePath: string): string {
  if (isAbsolute(candidatePath)) return candidatePath;

  const rootNormalized = join(process.cwd(), String(rootDir ?? "")).replace(/\\/g, "/").replace(/\/+$/g, "");
  const candidateNormalized = join(process.cwd(), String(candidatePath ?? "")).replace(/\\/g, "/").replace(/\/+$/g, "");
  if (
    rootNormalized
    && (
      candidateNormalized === rootNormalized
      || candidateNormalized.startsWith(`${rootNormalized}/`)
    )
  ) {
    return candidatePath;
  }

  return join(rootDir, candidatePath);
}

function toIsoOrNow(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  return new Date().toISOString();
}

function normalizeText(value: unknown, maxChars = MAX_SUMMARY_CHARS): string {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function stableRecordId(sourceKind: TrainingRepositorySourceKind, sourcePath: string, suffix = ""): string {
  const normalizedPath = sourcePath.replace(/\\/g, "/").toLowerCase();
  const raw = `${sourceKind}:${normalizedPath}${suffix ? `:${suffix}` : ""}`;
  return raw.replace(/[^a-z0-9._:/-]+/g, "_").slice(0, 240);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function uniqueLimited(items: string[], max = MAX_KEYWORDS): string[] {
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

function normalizeOutcomeSignal(value: unknown): "positive" | "average" | "negative" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "positive" || normalized === "good") return "positive";
  if (normalized === "average") return "average";
  return "negative";
}

function signalToQuality(signal: "positive" | "average" | "negative"): TrainingQualityRating {
  if (signal === "positive") return "good";
  if (signal === "average") return "average";
  return "poor";
}

function qualityWeight(rating: TrainingQualityRating): number {
  if (rating === "good") return 1.35;
  if (rating === "average") return 1.0;
  return 0.6;
}

function sourceReliability(kind: TrainingRepositorySourceKind): number {
  switch (kind) {
    case "job_outcome":
      return 1.35;
    case "experience":
      return 1.2;
    case "project_config":
      return 1.15;
    case "project_notes":
      return 1.05;
    case "playbook_snapshot":
      return 1.0;
    case "training_objective":
      return 0.95;
    case "upload_file":
      return 0.9;
    case "scene_file":
      return 0.78;
    default:
      return 1.0;
  }
}

function recencyBoost(iso: string): number {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  if (ageDays <= 7) return 0.35;
  if (ageDays <= 30) return 0.22;
  if (ageDays <= 90) return 0.1;
  return 0.02;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function computeRecordScore(record: Omit<TrainingRepositoryRecord, "score">): number {
  const keywordBoost = Math.min(0.3, (record.keywords.length / 24) * 0.3);
  return roundScore(
    qualityWeight(record.qualityRating) * record.sourceReliability * (0.7 + record.trustScore * 0.3)
      + recencyBoost(record.updatedAt)
      + keywordBoost,
  );
}

function upsertRecord(
  records: Map<string, TrainingRepositoryRecord>,
  next: TrainingRepositoryRecordSeed,
  policy: TrainingRepositoryPolicy,
): void {
  if (!next.summary && !next.prompt && !next.outcome) return;
  const quarantineReasons = scanQuarantineReasons(
    [next.title, next.summary, next.prompt ?? "", next.outcome ?? ""].join(" "),
    policy,
  );
  const quarantined = quarantineReasons.length > 0;
  const trustScore = computeTrustScore(next, policy, quarantined);
  const semanticVector = buildSemanticVector(
    [next.title, next.summary, next.prompt ?? "", next.outcome ?? "", ...next.keywords].join(" "),
  );
  const materialized: TrainingRepositoryRecord = {
    ...next,
    trustScore,
    quarantined,
    quarantineReasons,
    semanticVector,
    score: computeRecordScore({
      ...next,
      trustScore,
      quarantined,
      quarantineReasons,
      semanticVector,
    }),
  };
  const existing = records.get(materialized.id);
  if (!existing) {
    records.set(materialized.id, materialized);
    return;
  }

  const existingUpdated = Date.parse(existing.updatedAt);
  const nextUpdated = Date.parse(materialized.updatedAt);
  if (Number.isFinite(nextUpdated) && (!Number.isFinite(existingUpdated) || nextUpdated >= existingUpdated)) {
    records.set(materialized.id, materialized);
    return;
  }

  if (!existing.summary && materialized.summary) {
    records.set(materialized.id, materialized);
  }
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function listFiles(root: string, maxFiles = MAX_SCAN_FILES_PER_ROOT): string[] {
  const out: string[] = [];
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(root);
  } catch {
    return out;
  }
  if (rootStat.isFile()) return [root];
  if (!rootStat.isDirectory()) return out;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && out.length < maxFiles) {
    const current = queue.shift() as { dir: string; depth: number };
    let entries: string[] = [];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = join(current.dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH) continue;
        if (SKIP_DIRS.has(entry.toLowerCase())) continue;
        queue.push({ dir: full, depth: current.depth + 1 });
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

function looksLikeCoordinatorConfig(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === "arkestrator.coordinator.json" || name === "agent-manager.coordinator.json") return true;
  if (name.endsWith(".coordinator.json")) return true;
  return false;
}

function looksLikeCoordinatorNotes(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === "arkestrator.coordinator.md" || name === "agent-manager.coordinator.md") return true;
  if (name.endsWith(".coordinator.md")) return true;
  return false;
}

function parseOutcomeArtifact(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): TrainingRepositoryRecordSeed | null {
  const parsedProgram = normalizeProgram(parsed.program);
  if (parsedProgram && parsedProgram !== program) return null;
  const signal = normalizeOutcomeSignal(parsed.signal);
  const qualityRating = signalToQuality(signal);
  const prompt = normalizeText(parsed.prompt, 360);
  const outcome = normalizeText(parsed.outcome, 360);
  const metadata = parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
    ? parsed.metadata as Record<string, unknown>
    : null;
  const job = parsed.job && typeof parsed.job === "object" && !Array.isArray(parsed.job)
    ? parsed.job as Record<string, unknown>
    : null;
  const jobId = normalizeText(metadata?.jobId ?? job?.id, 120);
  const jobName = normalizeText(metadata?.jobName ?? job?.name, 180);
  const usedBridges = Array.isArray(metadata?.usedBridges)
    ? uniqueLimited(metadata.usedBridges.map((entry) => String(entry ?? "")), 8)
    : [];
  const summary = normalizeText(
    [
      prompt ? `Prompt: ${prompt}` : "",
      outcome ? `Outcome: ${outcome}` : "",
    ].filter(Boolean).join(" | "),
    420,
  );
  if (!summary) return null;
  const title = jobName || basename(filePath);
  const keywordPool = [
    ...tokenize(title),
    ...tokenize(prompt),
    ...tokenize(outcome),
    ...usedBridges,
  ];
  return {
    id: stableRecordId("job_outcome", filePath, jobId || undefined),
    program,
    sourceKind: "job_outcome",
    sourcePath: filePath,
    title,
    summary,
    prompt: prompt || undefined,
    outcome: outcome || undefined,
    qualityRating,
    qualityWeight: qualityWeight(qualityRating),
    sourceReliability: sourceReliability("job_outcome"),
    createdAt: toIsoOrNow(parsed.storedAt ?? parsed.updatedAt),
    updatedAt: toIsoOrNow(parsed.storedAt ?? parsed.updatedAt),
    keywords: uniqueLimited(keywordPool),
    tags: uniqueLimited(["learning", "outcome", signal, ...usedBridges], 12),
    metadata: {
      jobId: jobId || undefined,
      bridgeProgram: normalizeProgram(parsedProgram ?? metadata?.bridgeProgram) ?? undefined,
      usedBridges: usedBridges.length > 0 ? usedBridges : undefined,
    },
  };
}

function parseExperienceRecords(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): TrainingRepositoryRecordSeed[] {
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const out: TrainingRepositoryRecordSeed[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const signal = normalizeOutcomeSignal(row.signal ?? (row.success === true ? "positive" : "negative"));
    const qualityRating = signalToQuality(signal);
    const prompt = normalizeText(row.prompt, 320);
    const outcome = normalizeText(row.outcome, 320);
    if (!prompt && !outcome) continue;
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : null;
    const jobId = normalizeText(metadata?.jobId, 120);
    const jobName = normalizeText(metadata?.jobName, 180);
    const usedBridges = Array.isArray(metadata?.usedBridges)
      ? uniqueLimited(metadata.usedBridges.map((entry) => String(entry ?? "")), 8)
      : [];

    out.push({
      id: stableRecordId("experience", filePath, `${jobId || "row"}-${i}`),
      program,
      sourceKind: "experience",
      sourcePath: filePath,
      title: jobName || `Experience ${i + 1}`,
      summary: normalizeText(
        [
          prompt ? `Prompt: ${prompt}` : "",
          outcome ? `Outcome: ${outcome}` : "",
        ].filter(Boolean).join(" | "),
        420,
      ),
      prompt: prompt || undefined,
      outcome: outcome || undefined,
      qualityRating,
      qualityWeight: qualityWeight(qualityRating),
      sourceReliability: sourceReliability("experience"),
      createdAt: toIsoOrNow(row.timestamp),
      updatedAt: toIsoOrNow(row.timestamp),
      keywords: uniqueLimited([
        ...tokenize(prompt),
        ...tokenize(outcome),
        ...usedBridges,
      ]),
      tags: uniqueLimited(["experience", signal, ...usedBridges], 10),
      metadata: {
        jobId: jobId || undefined,
        bridgeProgram: normalizeProgram(metadata?.bridgeProgram) ?? undefined,
        usedBridges: usedBridges.length > 0 ? usedBridges : undefined,
      },
    });
  }
  return out;
}

function parseCoordinatorConfigRecord(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): TrainingRepositoryRecordSeed | null {
  const parsedProgram = normalizeProgram(parsed.program);
  if (parsedProgram && parsedProgram !== program) return null;

  const projectName = normalizeText(parsed.projectName ?? parsed.name ?? basename(dirname(filePath)), 180);
  const prompt = normalizeText(parsed.prompt, 400);
  const summaryField = normalizeText(parsed.summary ?? parsed.description, 360);
  const contextsRaw = Array.isArray(parsed.contexts) ? parsed.contexts : [];
  const contextSnippets = contextsRaw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => normalizeText(entry.prompt ?? entry.summary ?? entry.description, 160))
    .filter(Boolean)
    .slice(0, 4);

  const mergedSummary = normalizeText(
    [prompt, summaryField, ...contextSnippets].filter(Boolean).join(" | "),
    440,
  );
  if (!mergedSummary) return null;

  const keywordPool = [
    ...tokenize(projectName),
    ...tokenize(prompt),
    ...tokenize(summaryField),
    ...contextSnippets.flatMap((snippet) => tokenize(snippet)),
  ];

  return {
    id: stableRecordId("project_config", filePath),
    program,
    sourceKind: "project_config",
    sourcePath: filePath,
    title: projectName || basename(dirname(filePath)),
    summary: mergedSummary,
    prompt: prompt || undefined,
    outcome: summaryField || undefined,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability("project_config"),
    createdAt: toIsoOrNow(parsed.createdAt ?? parsed.updatedAt),
    updatedAt: toIsoOrNow(parsed.updatedAt ?? parsed.createdAt),
    keywords: uniqueLimited(keywordPool),
    tags: uniqueLimited(["project", "config", "coordinator"]),
    metadata: {
      bridgeProgram: parsedProgram ?? program,
    },
  };
}

function parseMarkdownRecord(
  program: string,
  filePath: string,
  text: string,
): TrainingRepositoryRecordSeed | null {
  const cleaned = normalizeText(text, 8_000);
  if (!cleaned) return null;
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const title = normalizeText(
    heading?.replace(/^#\s+/, "")
      || basename(filePath),
    180,
  );
  const summary = normalizeText(cleaned, 440);
  const tags = looksLikeCoordinatorNotes(filePath)
    ? ["project", "notes", "coordinator"]
    : ["notes", "upload"];
  return {
    id: stableRecordId("project_notes", filePath),
    program,
    sourceKind: looksLikeCoordinatorNotes(filePath) ? "project_notes" : "upload_file",
    sourcePath: filePath,
    title,
    summary,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability(looksLikeCoordinatorNotes(filePath) ? "project_notes" : "upload_file"),
    createdAt: toIsoOrNow(statSync(filePath).ctime.toISOString()),
    updatedAt: toIsoOrNow(statSync(filePath).mtime.toISOString()),
    keywords: uniqueLimited([
      ...tokenize(title),
      ...tokenize(summary),
    ]),
    tags: uniqueLimited(tags),
  };
}

function parseSceneFileRecord(
  program: string,
  filePath: string,
): TrainingRepositoryRecordSeed | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  const title = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const summary = normalizeText(
    `${title} (${ext || "file"}) in ${dirname(filePath)}. Binary scene asset, ${st.size} bytes.`,
    420,
  );
  return {
    id: stableRecordId("scene_file", filePath),
    program,
    sourceKind: "scene_file",
    sourcePath: filePath,
    title,
    summary,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability("scene_file"),
    createdAt: toIsoOrNow(st.ctime.toISOString()),
    updatedAt: toIsoOrNow(st.mtime.toISOString()),
    keywords: uniqueLimited([
      ...tokenize(title),
      ...tokenize(dirname(filePath)),
    ]),
    tags: uniqueLimited(["scene", ext.replace(/^\./, ""), program]),
  };
}

function parseGenericJsonRecord(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): TrainingRepositoryRecordSeed | null {
  const parsedProgram = normalizeProgram(parsed.program);
  if (parsedProgram && parsedProgram !== program) return null;
  const title = normalizeText(parsed.name ?? parsed.projectName ?? basename(filePath), 180) || basename(filePath);
  const summaryField = normalizeText(parsed.summary ?? parsed.description ?? parsed.notes, 360);
  const prompt = normalizeText(parsed.prompt, 320);
  const outcome = normalizeText(parsed.outcome, 320);
  const merged = normalizeText(
    [summaryField, prompt, outcome].filter(Boolean).join(" | "),
    440,
  );
  if (!merged) return null;

  const signalRaw = String(parsed.signal ?? "").trim();
  const rating = signalRaw
    ? signalToQuality(normalizeOutcomeSignal(signalRaw))
    : "average";
  const tags = uniqueLimited([
    "json",
    "upload",
    parsedProgram || program,
    normalizeText(parsed.type, 64).toLowerCase(),
  ].filter(Boolean));

  return {
    id: stableRecordId("upload_file", filePath),
    program,
    sourceKind: "upload_file",
    sourcePath: filePath,
    title,
    summary: merged,
    prompt: prompt || undefined,
    outcome: outcome || undefined,
    qualityRating: rating,
    qualityWeight: qualityWeight(rating),
    sourceReliability: sourceReliability("upload_file"),
    createdAt: toIsoOrNow(parsed.createdAt),
    updatedAt: toIsoOrNow(parsed.updatedAt ?? parsed.createdAt),
    keywords: uniqueLimited([
      ...tokenize(title),
      ...tokenize(merged),
      ...Object.keys(parsed).map((key) => String(key ?? "").trim().toLowerCase()),
    ]),
    tags,
  };
}

function parsePlaybookSnapshotRecord(
  program: string,
  playbookPath: string,
): TrainingRepositoryRecordSeed | null {
  const parsed = readJson(playbookPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const training = root.training;
  if (!training || typeof training !== "object" || Array.isArray(training)) return null;
  const trainingObj = training as Record<string, unknown>;
  const references = Array.isArray(trainingObj.references) ? trainingObj.references : [];
  const referenceSnippets = references
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => normalizeText(entry.summary ?? entry.name, 150))
    .filter(Boolean)
    .slice(0, 6);
  const objective = normalizeText(trainingObj.trainingPrompt, 220);
  const summary = normalizeText(
    [
      objective ? `Objective: ${objective}` : "",
      ...referenceSnippets,
    ].filter(Boolean).join(" | "),
    440,
  );
  if (!summary) return null;

  return {
    id: stableRecordId("playbook_snapshot", playbookPath),
    program,
    sourceKind: "playbook_snapshot",
    sourcePath: playbookPath,
    title: `${program} playbook training snapshot`,
    summary,
    prompt: objective || undefined,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability("playbook_snapshot"),
    createdAt: toIsoOrNow(trainingObj.updatedAt),
    updatedAt: toIsoOrNow(trainingObj.updatedAt),
    keywords: uniqueLimited([
      ...tokenize(summary),
      ...referenceSnippets.flatMap((snippet) => tokenize(snippet)),
    ]),
    tags: uniqueLimited(["playbook", "training", program]),
    metadata: objective
      ? {
          trainingObjective: objective,
        }
      : undefined,
  };
}

function addObjectiveRecord(
  records: Map<string, TrainingRepositoryRecord>,
  program: string,
  objective: string,
  policy: TrainingRepositoryPolicy,
): void {
  const summary = normalizeText(objective, 420);
  if (!summary) return;
  upsertRecord(records, {
    id: stableRecordId("training_objective", `objective:${program}:${summary.slice(0, 120)}`),
    program,
    sourceKind: "training_objective",
    sourcePath: `training-objective:${program}`,
    title: `${program} training objective`,
    summary,
    prompt: summary,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability("training_objective"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    keywords: uniqueLimited(tokenize(summary)),
    tags: uniqueLimited(["objective", "training", program]),
    metadata: {
      trainingObjective: summary,
    },
  }, policy);
}

function addRecordsFromFile(
  records: Map<string, TrainingRepositoryRecord>,
  program: string,
  filePath: string,
  policy: TrainingRepositoryPolicy,
): void {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && !SCENE_FILE_EXTENSIONS.has(ext)) return;

  if (SCENE_FILE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
    const sceneRecord = parseSceneFileRecord(program, filePath);
    if (sceneRecord) upsertRecord(records, sceneRecord, policy);
    return;
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return;
  }
  if (st.size <= 0 || st.size > MAX_TEXT_BYTES) {
    if (SCENE_FILE_EXTENSIONS.has(ext)) {
      const sceneRecord = parseSceneFileRecord(program, filePath);
      if (sceneRecord) upsertRecord(records, sceneRecord, policy);
    }
    return;
  }

  let text = "";
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  if (!text.trim()) return;

  if (ext === ".json") {
    // playbook snapshots are indexed via parsePlaybookSnapshotRecord; skip generic
    // ingestion here to avoid duplicate/noisy records.
    if (basename(filePath).toLowerCase() === "playbook.json") return;

    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const json = parsed as Record<string, unknown>;

    if (json.source === "manual_outcome_feedback") {
      const record = parseOutcomeArtifact(program, filePath, json);
      if (record) upsertRecord(records, record, policy);
      return;
    }

    if (Array.isArray(json.entries) && filePath.toLowerCase().endsWith(".experiences.json")) {
      const rows = parseExperienceRecords(program, filePath, json);
      for (const row of rows) upsertRecord(records, row, policy);
      return;
    }

    if (looksLikeCoordinatorConfig(filePath)) {
      const configRecord = parseCoordinatorConfigRecord(program, filePath, json);
      if (configRecord) upsertRecord(records, configRecord, policy);
      return;
    }

    const generic = parseGenericJsonRecord(program, filePath, json);
    if (generic) upsertRecord(records, generic, policy);
    return;
  }

  if (ext === ".md" || ext === ".txt") {
    const md = parseMarkdownRecord(program, filePath, text);
    if (md) upsertRecord(records, md, policy);
    return;
  }

  const genericText = normalizeText(text, 440);
  if (!genericText) return;
  upsertRecord(records, {
    id: stableRecordId("upload_file", filePath),
    program,
    sourceKind: "upload_file",
    sourcePath: filePath,
    title: basename(filePath),
    summary: genericText,
    qualityRating: "average",
    qualityWeight: qualityWeight("average"),
    sourceReliability: sourceReliability("upload_file"),
    createdAt: toIsoOrNow(st.ctime.toISOString()),
    updatedAt: toIsoOrNow(st.mtime.toISOString()),
    keywords: uniqueLimited([
      ...tokenize(basename(filePath)),
      ...tokenize(genericText),
    ]),
    tags: uniqueLimited(["upload", ext.replace(/^\./, "")]),
  }, policy);
}

function scanPathForRecords(
  records: Map<string, TrainingRepositoryRecord>,
  program: string,
  rootPath: string,
  policy: TrainingRepositoryPolicy,
): void {
  if (!rootPath || !existsSync(rootPath)) return;
  const files = listFiles(rootPath, MAX_SCAN_FILES_PER_ROOT);
  for (const file of files) {
    addRecordsFromFile(records, program, file, policy);
  }
}

function buildInvertedIndex(records: TrainingRepositoryRecord[]): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const tokens = uniqueLimited([
      ...tokenize(record.title),
      ...tokenize(record.summary),
      ...tokenize(record.prompt ?? ""),
      ...tokenize(record.outcome ?? ""),
      ...record.keywords,
      ...record.tags,
    ], MAX_TERMS_PER_RECORD);
    for (const token of tokens) {
      if (!index[token]) index[token] = [];
      index[token].push(i);
    }
  }
  return index;
}

function indexStats(records: TrainingRepositoryRecord[]): TrainingRepositoryIndex["stats"] {
  const bySourceKind: Partial<Record<TrainingRepositorySourceKind, number>> = {};
  const byQuality: Record<TrainingQualityRating, number> = {
    good: 0,
    average: 0,
    poor: 0,
  };
  for (const record of records) {
    bySourceKind[record.sourceKind] = (bySourceKind[record.sourceKind] ?? 0) + 1;
    byQuality[record.qualityRating] += 1;
  }
  return { bySourceKind, byQuality };
}

export function refreshTrainingRepositoryIndex(
  options: RefreshTrainingRepositoryIndexOptions,
): TrainingRepositoryIndex {
  const refreshStartedAt = Date.now();
  const policy = resolvePolicy(options.policy);
  const overrides = resolveOverrides(options.overrides);
  const program = normalizeProgram(options.program);
  if (!program) {
    return {
      version: INDEX_VERSION,
      program: "",
      generatedAt: new Date().toISOString(),
      recordCount: 0,
      termCount: 0,
      stats: {
        bySourceKind: {},
        byQuality: { good: 0, average: 0, poor: 0 },
      },
      records: [],
      invertedIndex: {},
    };
  }

  const rootDir = options.dir;
  const records = new Map<string, TrainingRepositoryRecord>();

  addObjectiveRecord(records, program, String(options.trainingObjective ?? ""), policy);

  const learningDir = learningRoot(rootDir);
  const baselineRoots = [
    join(learningDir, "jobs", program),
    join(learningDir, "uploads", program),
    join(learningDir, `${program}.experiences.json`),
    join(learningDir, `${program}.json`),
  ];
  const playbookPath = join(rootDir, program, "playbook.json");
  if (existsSync(playbookPath)) {
    const playbookRecord = parsePlaybookSnapshotRecord(program, playbookPath);
    if (playbookRecord) upsertRecord(records, playbookRecord, policy);
    baselineRoots.push(playbookPath);
  }

  const additionalRoots = Array.isArray(options.sourcePaths)
    ? options.sourcePaths.map((path) => String(path ?? "").trim()).filter(Boolean)
    : [];

  const scannedRoots = new Set<string>();
  for (const path of [...baselineRoots, ...additionalRoots]) {
    const normalized = normalizeScanRootPath(rootDir, path);
    if (!normalized || scannedRoots.has(normalized)) continue;
    scannedRoots.add(normalized);
    scanPathForRecords(records, program, normalized, policy);
  }

  const retentionCutoffMs = Date.now() - policy.ingestion.retentionDays * 86_400_000;
  const sortedRecords = [...records.values()]
    .map((record) => applyOverrideToRecord(record, overrides))
    .filter((item) => !item.suppressed)
    .map((item) => item.record)
    .filter((record) => {
      if (record.sourceKind === "job_outcome" || record.sourceKind === "experience") return true;
      const ts = Date.parse(record.updatedAt);
      if (!Number.isFinite(ts)) return true;
      return ts >= retentionCutoffMs;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bTs = Date.parse(b.updatedAt);
      const aTs = Date.parse(a.updatedAt);
      if (Number.isFinite(bTs) && Number.isFinite(aTs) && bTs !== aTs) return bTs - aTs;
      return a.sourcePath.localeCompare(b.sourcePath);
    })
    .slice(0, MAX_INDEX_RECORDS);

  const invertedIndex = buildInvertedIndex(sortedRecords);
  const output: TrainingRepositoryIndex = {
    version: INDEX_VERSION,
    program,
    generatedAt: new Date().toISOString(),
    recordCount: sortedRecords.length,
    termCount: Object.keys(invertedIndex).length,
    stats: indexStats(sortedRecords),
    records: sortedRecords,
    invertedIndex,
  };

  const outputPath = indexFilePath(rootDir, program);
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
    const st = statSync(outputPath);
    CACHE.set(outputPath, { mtimeMs: st.mtimeMs, index: output });
    QUERY_CACHE.clear();
  } catch {
    // Best effort; in-memory output still returned.
  }

  const metricKey = refreshQueueKey(rootDir, program);
  const existingMetric = METRICS.get(metricKey) ?? {
    program,
    queryCount: 0,
    queryCacheHits: 0,
    queryMsTotal: 0,
    refreshCount: 0,
    refreshMsTotal: 0,
  };
  existingMetric.refreshCount += 1;
  existingMetric.refreshMsTotal += Math.max(0, Date.now() - refreshStartedAt);
  existingMetric.lastRefreshAt = new Date().toISOString();
  existingMetric.lastRefreshError = undefined;
  METRICS.set(metricKey, existingMetric);

  return output;
}

function normalizeStoredIndex(raw: unknown): TrainingRepositoryIndex | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (Number(parsed.version) !== INDEX_VERSION) return null;
  const program = normalizeProgram(parsed.program);
  if (!program) return null;
  const recordsRaw = Array.isArray(parsed.records) ? parsed.records : [];
  const records: TrainingRepositoryRecord[] = [];
  for (const item of recordsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const sourceKind = String(row.sourceKind ?? "").trim() as TrainingRepositorySourceKind;
    if (!sourceKind) continue;
    const quality = String(row.qualityRating ?? "").trim() as TrainingQualityRating;
    if (quality !== "good" && quality !== "average" && quality !== "poor") continue;
    const record: TrainingRepositoryRecord = {
      id: normalizeText(row.id, 260),
      program,
      sourceKind,
      sourcePath: normalizeText(row.sourcePath, 600),
      title: normalizeText(row.title, 220),
      summary: normalizeText(row.summary, 600),
      prompt: normalizeText(row.prompt, 360) || undefined,
      outcome: normalizeText(row.outcome, 360) || undefined,
      qualityRating: quality,
      qualityWeight: Number.isFinite(Number(row.qualityWeight))
        ? Number(row.qualityWeight)
        : qualityWeight(quality),
      sourceReliability: Number.isFinite(Number(row.sourceReliability))
        ? Number(row.sourceReliability)
        : sourceReliability(sourceKind),
      trustScore: Number.isFinite(Number(row.trustScore))
        ? clamp(Number(row.trustScore), 0, 1)
        : 0.5,
      quarantined: row.quarantined === true,
      quarantineReasons: Array.isArray(row.quarantineReasons)
        ? uniqueLimited(row.quarantineReasons.map((value) => String(value ?? "")), 8)
        : [],
      semanticVector: Array.isArray(row.semanticVector)
        ? row.semanticVector
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .slice(0, SEMANTIC_VECTOR_DIM)
        : [],
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
      createdAt: toIsoOrNow(row.createdAt),
      updatedAt: toIsoOrNow(row.updatedAt),
      keywords: Array.isArray(row.keywords)
        ? uniqueLimited(row.keywords.map((value) => String(value ?? "")))
        : [],
      tags: Array.isArray(row.tags)
        ? uniqueLimited(row.tags.map((value) => String(value ?? "")))
        : [],
      metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as TrainingRepositoryRecord["metadata"]
        : undefined,
    };
    if (!record.id || !record.sourcePath || !record.summary) continue;
    if (record.semanticVector.length !== SEMANTIC_VECTOR_DIM) {
      record.semanticVector = buildSemanticVector(
        [record.title, record.summary, record.prompt ?? "", record.outcome ?? "", ...record.keywords].join(" "),
      );
    }
    if (record.quarantineReasons.length > 0 && !record.quarantined) {
      record.quarantined = true;
    }
    if (record.score <= 0) {
      record.score = computeRecordScore(record);
    }
    records.push(record);
  }

  const invertedRaw = parsed.invertedIndex;
  const invertedIndex: Record<string, number[]> = {};
  if (invertedRaw && typeof invertedRaw === "object" && !Array.isArray(invertedRaw)) {
    for (const [term, value] of Object.entries(invertedRaw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const indices = value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry < records.length);
      if (indices.length > 0) invertedIndex[term] = indices;
    }
  }

  return {
    version: INDEX_VERSION,
    program,
    generatedAt: toIsoOrNow(parsed.generatedAt),
    recordCount: records.length,
    termCount: Object.keys(invertedIndex).length,
    stats: indexStats(records),
    records,
    invertedIndex: Object.keys(invertedIndex).length > 0 ? invertedIndex : buildInvertedIndex(records),
  };
}

export function loadTrainingRepositoryIndex(
  options: {
    dir: string;
    program: string;
    policy?: TrainingRepositoryPolicy | TrainingRepositoryPolicyPatch | null;
    overrides?: TrainingRepositoryOverrides | null;
  },
): TrainingRepositoryIndex {
  const program = normalizeProgram(options.program);
  if (!program) {
    return refreshTrainingRepositoryIndex({
      dir: options.dir,
      program: "",
      policy: options.policy,
      overrides: options.overrides,
    });
  }
  const path = indexFilePath(options.dir, program);
  if (!existsSync(path)) {
    return refreshTrainingRepositoryIndex({
      dir: options.dir,
      program,
      policy: options.policy,
      overrides: options.overrides,
    });
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return refreshTrainingRepositoryIndex({
      dir: options.dir,
      program,
      policy: options.policy,
      overrides: options.overrides,
    });
  }

  const cached = CACHE.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.index;

  const raw = readJson(path);
  const parsed = normalizeStoredIndex(raw);
  if (!parsed) {
    return refreshTrainingRepositoryIndex({
      dir: options.dir,
      program,
      policy: options.policy,
      overrides: options.overrides,
    });
  }

  CACHE.set(path, { mtimeMs: st.mtimeMs, index: parsed });
  return parsed;
}

export function queryTrainingRepository(
  options: QueryTrainingRepositoryOptions,
): TrainingRepositoryHit[] {
  const queryStartedAt = Date.now();
  const policy = resolvePolicy(options.policy);
  const overrides = resolveOverrides(options.overrides);
  const program = normalizeProgram(options.program);
  if (!program) return [];
  const metricKey = refreshQueueKey(options.dir, program);
  const metric = METRICS.get(metricKey) ?? {
    program,
    queryCount: 0,
    queryCacheHits: 0,
    queryMsTotal: 0,
    refreshCount: 0,
    refreshMsTotal: 0,
  };
  const index = loadTrainingRepositoryIndex({ dir: options.dir, program, policy, overrides });
  if (index.records.length === 0) {
    metric.queryCount += 1;
    metric.queryMsTotal += Math.max(0, Date.now() - queryStartedAt);
    metric.lastQueryAt = new Date().toISOString();
    METRICS.set(metricKey, metric);
    return [];
  }

  const prompt = String(options.prompt ?? "").trim();
  const queryTerms = uniqueLimited(tokenize(prompt), 32);
  const maxResults = Math.max(
    1,
    Math.min(
      24,
      Math.round(options.maxResults ?? policy.retrieval.maxResults),
    ),
  );
  const overrideSignature = hashToken(JSON.stringify(overrides));
  const queryCacheKey = `${index.program}:${index.generatedAt}:${queryTerms.join("|")}:${maxResults}:${policy.retrieval.minTrustScore}:${policy.retrieval.includeQuarantined ? "q1" : "q0"}:${overrideSignature}`;
  const indexPath = indexFilePath(options.dir, program);
  const indexStat = existsSync(indexPath) ? statSync(indexPath) : null;
  const cachedQuery = indexStat ? QUERY_CACHE.get(queryCacheKey) : null;
  if (cachedQuery && indexStat && cachedQuery.mtimeMs === indexStat.mtimeMs) {
    metric.queryCount += 1;
    metric.queryCacheHits += 1;
    metric.queryMsTotal += Math.max(0, Date.now() - queryStartedAt);
    metric.lastQueryAt = new Date().toISOString();
    METRICS.set(metricKey, metric);
    return cachedQuery.hits;
  }

  const candidates = new Set<number>();
  for (const term of queryTerms) {
    const indices = index.invertedIndex[term];
    if (!indices) continue;
    for (const value of indices) candidates.add(value);
  }

  if (candidates.size === 0) {
    for (let i = 0; i < Math.min(index.records.length, MAX_CANDIDATE_SCAN); i++) {
      candidates.add(i);
    }
  }

  const scored: TrainingRepositoryHit[] = [];
  const lowerPrompt = prompt.toLowerCase();
  const queryVector = buildSemanticVector(prompt);
  const lexicalWeight = policy.retrieval.lexicalWeight;
  const semanticWeight = policy.retrieval.semanticWeight;
  const qualityWeightBias = policy.retrieval.qualityWeight;
  for (const idx of candidates) {
    const baseRecord = index.records[idx];
    if (!baseRecord) continue;
    const overrideApplied = applyOverrideToRecord(baseRecord, overrides);
    if (overrideApplied.suppressed) continue;
    const record = overrideApplied.record;
    if (!policy.retrieval.includeQuarantined && record.quarantined) continue;
    if (record.trustScore < policy.retrieval.minTrustScore) continue;
    const termSet = new Set(uniqueLimited([
      ...record.keywords,
      ...tokenize(record.title),
      ...tokenize(record.summary),
      ...tokenize(record.prompt ?? ""),
      ...tokenize(record.outcome ?? ""),
    ], MAX_TERMS_PER_RECORD));

    let overlap = 0;
    const matchedTerms: string[] = [];
    for (const term of queryTerms) {
      if (!termSet.has(term)) continue;
      overlap += 1;
      if (matchedTerms.length < 10) matchedTerms.push(term);
    }

    const overlapRatio = queryTerms.length > 0 ? overlap / queryTerms.length : 0;
    const titleBoost = record.title && lowerPrompt.includes(record.title.toLowerCase()) ? 0.85 : 0;
    const qualityBias = (record.qualityRating === "good"
      ? 0.22
      : record.qualityRating === "poor"
        ? -0.12
        : 0) * qualityWeightBias;
    const lexicalScore = overlap * 0.75 + overlapRatio * 1.4 + titleBoost;
    const semanticScore = Math.max(0, semanticSimilarity(queryVector, record.semanticVector));
    const score = roundScore(
      record.score
        + lexicalScore * lexicalWeight
        + semanticScore * semanticWeight * 2
        + qualityBias
        + record.trustScore * 0.35,
    );
    if (score < policy.retrieval.minScore) continue;
    scored.push({ record, score, matchedTerms, lexicalScore: roundScore(lexicalScore), semanticScore: roundScore(semanticScore) });
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, maxResults);
  if (indexStat) {
    QUERY_CACHE.set(queryCacheKey, { mtimeMs: indexStat.mtimeMs, hits });
  }
  metric.queryCount += 1;
  metric.queryMsTotal += Math.max(0, Date.now() - queryStartedAt);
  metric.lastQueryAt = new Date().toISOString();
  METRICS.set(metricKey, metric);
  return hits;
}

export function listTrainingRepositoryRecords(
  options: ListTrainingRepositoryRecordsOptions,
): TrainingRepositoryRecord[] {
  const policy = resolvePolicy(options.policy);
  const overrides = resolveOverrides(options.overrides);
  const program = normalizeProgram(options.program);
  if (!program) return [];
  const index = loadTrainingRepositoryIndex({
    dir: options.dir,
    program,
    policy,
    overrides,
  });
  if (index.records.length === 0) return [];
  const search = String(options.query ?? "").trim().toLowerCase();
  const includeQuarantined = options.includeQuarantined === true;
  const includeSuppressed = options.includeSuppressed === true;
  const maxResults = Math.max(1, Math.min(500, Math.round(options.maxResults ?? 200)));

  const out: TrainingRepositoryRecord[] = [];
  for (const baseRecord of index.records) {
    const overrideApplied = applyOverrideToRecord(baseRecord, overrides);
    if (overrideApplied.suppressed && !includeSuppressed) continue;
    const record = overrideApplied.record;
    if (record.quarantined && !includeQuarantined) continue;
    if (!search) {
      out.push(record);
      continue;
    }
    const haystack = [
      record.title,
      record.summary,
      record.prompt ?? "",
      record.outcome ?? "",
      ...record.keywords,
      ...record.tags,
      record.sourcePath,
    ].join(" ").toLowerCase();
    if (haystack.includes(search)) out.push(record);
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bTs = Date.parse(b.updatedAt);
    const aTs = Date.parse(a.updatedAt);
    if (Number.isFinite(bTs) && Number.isFinite(aTs) && bTs !== aTs) return bTs - aTs;
    return a.sourcePath.localeCompare(b.sourcePath);
  });
  return out.slice(0, maxResults);
}

export function getTrainingRepositoryMetrics(
  options?: { dir?: string; program?: string },
): TrainingRepositoryMetrics[] {
  const programFilter = normalizeProgram(options?.program ?? "");
  const out: TrainingRepositoryMetrics[] = [];
  for (const [key, metric] of METRICS.entries()) {
    if (options?.dir && !key.startsWith(`${options.dir}::`)) continue;
    if (programFilter && metric.program !== programFilter) continue;
    out.push({
      program: metric.program,
      queryCount: metric.queryCount,
      queryCacheHits: metric.queryCacheHits,
      avgQueryMs: metric.queryCount > 0
        ? Math.round((metric.queryMsTotal / metric.queryCount) * 100) / 100
        : 0,
      refreshCount: metric.refreshCount,
      avgRefreshMs: metric.refreshCount > 0
        ? Math.round((metric.refreshMsTotal / metric.refreshCount) * 100) / 100
        : 0,
      lastQueryAt: metric.lastQueryAt,
      lastRefreshAt: metric.lastRefreshAt,
      lastRefreshError: metric.lastRefreshError,
    });
  }
  out.sort((a, b) => a.program.localeCompare(b.program));
  return out;
}

function refreshQueueKey(dir: string, program: string): string {
  return `${dir}::${program}`;
}

function mergeRefreshOptions(
  base: RefreshTrainingRepositoryIndexOptions | null,
  incoming: RefreshTrainingRepositoryIndexOptions,
): RefreshTrainingRepositoryIndexOptions {
  if (!base) {
    return {
      ...incoming,
      sourcePaths: Array.isArray(incoming.sourcePaths) ? [...incoming.sourcePaths] : undefined,
    };
  }
  const mergedPaths = uniqueLimited([
    ...(Array.isArray(base.sourcePaths) ? base.sourcePaths : []),
    ...(Array.isArray(incoming.sourcePaths) ? incoming.sourcePaths : []),
  ], 2_000);
  return {
    dir: incoming.dir || base.dir,
    program: incoming.program || base.program,
    trainingObjective: String(incoming.trainingObjective ?? base.trainingObjective ?? "").trim() || undefined,
    policy: incoming.policy ?? base.policy,
    overrides: incoming.overrides ?? base.overrides,
    sourcePaths: mergedPaths.length > 0 ? mergedPaths : undefined,
  };
}

async function runQueuedRefresh(entry: RefreshQueueEntry): Promise<void> {
  if (entry.running || !entry.pending) return;
  const next = entry.pending;
  entry.pending = null;
  entry.running = true;
  entry.status.running = true;
  entry.status.pending = false;
  entry.status.lastStartedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    refreshTrainingRepositoryIndex(next);
    entry.status.lastCompletedAt = new Date().toISOString();
    entry.status.lastDurationMs = Date.now() - startedAt;
    entry.status.lastError = undefined;
    entry.status.refreshCount += 1;
  } catch (err: any) {
    entry.status.lastCompletedAt = new Date().toISOString();
    entry.status.lastDurationMs = Date.now() - startedAt;
    entry.status.lastError = String(err?.message ?? err ?? "Unknown refresh error");
    const metricKey = refreshQueueKey(entry.dir, entry.program);
    const metric = METRICS.get(metricKey);
    if (metric) {
      metric.lastRefreshError = entry.status.lastError;
      metric.lastRefreshAt = entry.status.lastCompletedAt;
      METRICS.set(metricKey, metric);
    }
  } finally {
    entry.running = false;
    entry.status.running = false;
    if (entry.pending) {
      queueMicrotask(() => {
        void runQueuedRefresh(entry);
      });
    }
  }
}

function getOrCreateRefreshEntry(
  dir: string,
  program: string,
): RefreshQueueEntry {
  const key = refreshQueueKey(dir, program);
  const existing = REFRESH_QUEUE.get(key);
  if (existing) return existing;
  const created: RefreshQueueEntry = {
    key,
    dir,
    program,
    pending: null,
    timer: null,
    running: false,
    status: {
      program,
      running: false,
      pending: false,
      refreshCount: 0,
    },
  };
  REFRESH_QUEUE.set(key, created);
  return created;
}

export function scheduleTrainingRepositoryIndexRefresh(
  options: ScheduleTrainingRepositoryRefreshOptions,
): TrainingRepositoryRefreshStatus {
  const program = normalizeProgram(options.program);
  if (!program) {
    return {
      program: "",
      running: false,
      pending: false,
      refreshCount: 0,
      lastError: "Invalid program",
    };
  }
  const entry = getOrCreateRefreshEntry(options.dir, program);
  entry.pending = mergeRefreshOptions(entry.pending, {
    ...options,
    program,
  });
  entry.status.pending = true;
  entry.status.lastQueuedAt = new Date().toISOString();

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const debounceMs = Math.max(0, Math.min(30_000, Math.round(options.debounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS)));
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void runQueuedRefresh(entry);
  }, debounceMs);

  return { ...entry.status };
}

export async function flushTrainingRepositoryIndexRefresh(
  options: { dir: string; program: string },
): Promise<TrainingRepositoryRefreshStatus> {
  const program = normalizeProgram(options.program);
  if (!program) {
    return {
      program: "",
      running: false,
      pending: false,
      refreshCount: 0,
      lastError: "Invalid program",
    };
  }
  const entry = getOrCreateRefreshEntry(options.dir, program);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.pending && !entry.running) {
    entry.pending = {
      dir: options.dir,
      program,
    };
    entry.status.pending = true;
  }
  await runQueuedRefresh(entry);
  return { ...entry.status };
}

export function getTrainingRepositoryRefreshStatus(
  options?: { dir?: string; program?: string },
): TrainingRepositoryRefreshStatus[] {
  const programFilter = normalizeProgram(options?.program ?? "");
  const out: TrainingRepositoryRefreshStatus[] = [];
  for (const entry of REFRESH_QUEUE.values()) {
    if (options?.dir && entry.dir !== options.dir) continue;
    if (programFilter && entry.program !== programFilter) continue;
    out.push({ ...entry.status });
  }
  out.sort((a, b) => a.program.localeCompare(b.program));
  return out;
}

export function resolveTrainingRepositoryIndexPath(dir: string, program: string): string | null {
  const normalizedProgram = normalizeProgram(program);
  if (!normalizedProgram) return null;
  const path = indexFilePath(dir, normalizedProgram);
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return path;
}
