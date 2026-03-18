import type { SettingsRepo } from "../db/settings.repo.js";

const WORKER_RULES_KEY = "security_worker_rules_v1";

export interface WorkerRule {
  workerName: string;
  banned: boolean;
  clientCoordinationAllowed: boolean;
  ipAllowlist: string[];
  ipDenylist: string[];
  localLlmEnabled: boolean;
  localLlmBaseUrl: string;
  note: string;
}

type StoredRule = Omit<WorkerRule, "workerName">;
type StoredRulesMap = Record<string, StoredRule>;

const DEFAULT_RULE: StoredRule = {
  banned: false,
  clientCoordinationAllowed: true,
  ipAllowlist: [],
  ipDenylist: [],
  localLlmEnabled: false,
  localLlmBaseUrl: "",
  note: "",
};

function normalizeBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function normalizeWorkerName(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeIpList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const ip = String(raw ?? "").trim();
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

function normalizeStoredRule(value: unknown): StoredRule {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    banned: input.banned === true,
    clientCoordinationAllowed:
      typeof input.clientCoordinationAllowed === "boolean"
        ? input.clientCoordinationAllowed
        : true,
    ipAllowlist: normalizeIpList(input.ipAllowlist),
    ipDenylist: normalizeIpList(input.ipDenylist),
    localLlmEnabled:
      typeof input.localLlmEnabled === "boolean"
        ? input.localLlmEnabled
        : false,
    localLlmBaseUrl: normalizeBaseUrl(input.localLlmBaseUrl),
    note: typeof input.note === "string" ? input.note.trim() : "",
  };
}

function parseStoredRules(settingsRepo: SettingsRepo): StoredRulesMap {
  const raw = settingsRepo.get(WORKER_RULES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out: StoredRulesMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const workerName = normalizeWorkerName(key);
      if (!workerName) continue;
      out[workerName] = normalizeStoredRule(value);
    }
    return out;
  } catch {
    return {};
  }
}

function saveStoredRules(settingsRepo: SettingsRepo, map: StoredRulesMap): void {
  settingsRepo.set(WORKER_RULES_KEY, JSON.stringify(map));
}

export function listWorkerRules(settingsRepo: SettingsRepo): WorkerRule[] {
  const rules = parseStoredRules(settingsRepo);
  return Object.entries(rules).map(([workerName, rule]) => ({
    workerName,
    ...DEFAULT_RULE,
    ...rule,
  }));
}

export function getWorkerRule(settingsRepo: SettingsRepo, workerName: string): WorkerRule {
  const normalized = normalizeWorkerName(workerName);
  const rules = parseStoredRules(settingsRepo);
  const rule = rules[normalized] ?? DEFAULT_RULE;
  return {
    workerName: normalized,
    ...DEFAULT_RULE,
    ...rule,
  };
}

export function updateWorkerRule(
  settingsRepo: SettingsRepo,
  workerName: string,
  patch: Partial<Omit<WorkerRule, "workerName">>,
): WorkerRule {
  const normalized = normalizeWorkerName(workerName);
  const rules = parseStoredRules(settingsRepo);
  const current = rules[normalized] ?? DEFAULT_RULE;

  const next: StoredRule = {
    banned: typeof patch.banned === "boolean" ? patch.banned : current.banned,
    clientCoordinationAllowed:
      typeof patch.clientCoordinationAllowed === "boolean"
        ? patch.clientCoordinationAllowed
        : current.clientCoordinationAllowed,
    ipAllowlist:
      patch.ipAllowlist !== undefined
        ? normalizeIpList(patch.ipAllowlist)
        : current.ipAllowlist,
    ipDenylist:
      patch.ipDenylist !== undefined
        ? normalizeIpList(patch.ipDenylist)
        : current.ipDenylist,
    localLlmEnabled:
      typeof patch.localLlmEnabled === "boolean"
        ? patch.localLlmEnabled
        : current.localLlmEnabled,
    localLlmBaseUrl:
      patch.localLlmBaseUrl !== undefined
        ? normalizeBaseUrl(patch.localLlmBaseUrl)
        : current.localLlmBaseUrl,
    note: typeof patch.note === "string" ? patch.note.trim() : current.note,
  };

  rules[normalized] = next;
  saveStoredRules(settingsRepo, rules);
  return { workerName: normalized, ...next };
}

export function evaluateWorkerAccess(
  settingsRepo: SettingsRepo,
  workerName: string,
  ip?: string,
): { allowed: true } | { allowed: false; reason: string } {
  const rule = getWorkerRule(settingsRepo, workerName);
  const candidateIp = String(ip ?? "").trim();

  if (rule.banned) {
    return { allowed: false, reason: `Worker "${rule.workerName}" is banned` };
  }

  if (candidateIp && rule.ipDenylist.includes(candidateIp)) {
    return { allowed: false, reason: `IP ${candidateIp} is denied for worker "${rule.workerName}"` };
  }

  if (rule.ipAllowlist.length > 0 && (!candidateIp || !rule.ipAllowlist.includes(candidateIp))) {
    return {
      allowed: false,
      reason: `IP ${candidateIp || "<unknown>"} is not allowlisted for worker "${rule.workerName}"`,
    };
  }

  return { allowed: true };
}
