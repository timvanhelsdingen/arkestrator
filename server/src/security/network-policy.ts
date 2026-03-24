import { minimatch } from "minimatch";
import type { SettingsRepo } from "../db/settings.repo.js";

export interface NetworkRateLimitConfig {
  max: number;
  windowMs: number;
}

export interface NetworkControls {
  ipAllowlist: string[];
  ipDenylist: string[];
  domainAllowlist: string[];
  domainDenylist: string[];
  rateLimits: {
    login: NetworkRateLimitConfig;
    jobSubmit: NetworkRateLimitConfig;
  };
}

export interface NetworkAccessCheckInput {
  ip?: string;
  domain?: string;
  controls: NetworkControls;
}

export interface NetworkAccessCheckResult {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_LOGIN_RATE_MAX = 100;
const DEFAULT_LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
// Job submission rate limit — default is generous for single-user/small-team setups.
// Can be tightened via admin UI (Settings > Network Controls) for shared deployments.
const DEFAULT_JOB_RATE_MAX = 120;
const DEFAULT_JOB_RATE_WINDOW_MS = 60 * 1000;

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  )];
}

function serializeList(values: string[]): string {
  return values.join("\n");
}

function parseIntSetting(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const first = ip.split(",")[0]?.trim();
  if (!first) return undefined;
  return first.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) >>> 0)
    + ((nums[1] << 16) >>> 0)
    + ((nums[2] << 8) >>> 0)
    + (nums[3] >>> 0);
}

function matchesIpv4Cidr(ip: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split("/");
  if (!base || !prefixRaw) return false;
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNum = parseIpv4(ip);
  const baseNum = parseIpv4(base);
  if (ipNum == null || baseNum == null) return false;

  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function matchesIpPattern(ip: string, pattern: string): boolean {
  const candidate = pattern.trim();
  if (!candidate) return false;
  if (candidate.includes("/")) return matchesIpv4Cidr(ip, candidate);
  if (candidate.includes("*") || candidate.includes("?")) {
    return minimatch(ip, candidate, { nocase: true });
  }
  return ip.toLowerCase() === candidate.toLowerCase();
}

function normalizeDomain(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const trimmed = domain.trim();
  if (!trimmed) return undefined;

  const fromUrl = (() => {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return null;
    }
  })();
  if (fromUrl) return fromUrl.toLowerCase();

  return trimmed.split(":")[0].toLowerCase();
}

function matchesDomainPattern(domain: string, pattern: string): boolean {
  const candidate = pattern.trim().toLowerCase();
  if (!candidate) return false;
  if (candidate.startsWith(".")) {
    const suffix = candidate.slice(1);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }
  if (candidate.includes("*") || candidate.includes("?")) {
    return minimatch(domain, candidate, { nocase: true });
  }
  return domain === candidate;
}

function matchesAnyIp(ip: string | undefined, patterns: string[]): boolean {
  if (!ip) return false;
  return patterns.some((pattern) => matchesIpPattern(ip, pattern));
}

function matchesAnyDomain(domain: string | undefined, patterns: string[]): boolean {
  if (!domain) return false;
  return patterns.some((pattern) => matchesDomainPattern(domain, pattern));
}

export function getNetworkControls(settingsRepo: SettingsRepo): NetworkControls {
  return {
    ipAllowlist: parseList(settingsRepo.get("security_ip_allowlist")),
    ipDenylist: parseList(settingsRepo.get("security_ip_denylist")),
    domainAllowlist: parseList(settingsRepo.get("security_domain_allowlist")),
    domainDenylist: parseList(settingsRepo.get("security_domain_denylist")),
    rateLimits: {
      login: {
        max: parseIntSetting(
          settingsRepo.get("security_login_rate_max"),
          DEFAULT_LOGIN_RATE_MAX,
          1,
          10_000,
        ),
        windowMs: parseIntSetting(
          settingsRepo.get("security_login_rate_window_ms"),
          DEFAULT_LOGIN_RATE_WINDOW_MS,
          1_000,
          24 * 60 * 60 * 1000,
        ),
      },
      jobSubmit: {
        max: parseIntSetting(
          settingsRepo.get("security_job_rate_max"),
          DEFAULT_JOB_RATE_MAX,
          1,
          10_000,
        ),
        windowMs: parseIntSetting(
          settingsRepo.get("security_job_rate_window_ms"),
          DEFAULT_JOB_RATE_WINDOW_MS,
          1_000,
          24 * 60 * 60 * 1000,
        ),
      },
    },
  };
}

export function saveNetworkControls(
  settingsRepo: SettingsRepo,
  controls: NetworkControls,
) {
  settingsRepo.set("security_ip_allowlist", serializeList(controls.ipAllowlist));
  settingsRepo.set("security_ip_denylist", serializeList(controls.ipDenylist));
  settingsRepo.set("security_domain_allowlist", serializeList(controls.domainAllowlist));
  settingsRepo.set("security_domain_denylist", serializeList(controls.domainDenylist));
  settingsRepo.set("security_login_rate_max", String(controls.rateLimits.login.max));
  settingsRepo.set("security_login_rate_window_ms", String(controls.rateLimits.login.windowMs));
  settingsRepo.set("security_job_rate_max", String(controls.rateLimits.jobSubmit.max));
  settingsRepo.set("security_job_rate_window_ms", String(controls.rateLimits.jobSubmit.windowMs));
}

export function normalizeNetworkControlsInput(raw: any): NetworkControls | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const parseListInput = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") return null;
      const trimmed = item.trim();
      if (!trimmed) continue;
      out.push(trimmed);
    }
    return [...new Set(out)];
  };

  const parsePositiveInt = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const rounded = Math.floor(value);
    if (rounded <= 0) return null;
    return rounded;
  };

  const ipAllowlist = parseListInput(raw.ipAllowlist);
  const ipDenylist = parseListInput(raw.ipDenylist);
  const domainAllowlist = parseListInput(raw.domainAllowlist);
  const domainDenylist = parseListInput(raw.domainDenylist);
  const loginRateMax = parsePositiveInt(raw.loginRateMax);
  const loginRateWindowMs = parsePositiveInt(raw.loginRateWindowMs);
  const jobRateMax = parsePositiveInt(raw.jobRateMax);
  const jobRateWindowMs = parsePositiveInt(raw.jobRateWindowMs);

  if (
    ipAllowlist == null
    || ipDenylist == null
    || domainAllowlist == null
    || domainDenylist == null
    || loginRateMax == null
    || loginRateWindowMs == null
    || jobRateMax == null
    || jobRateWindowMs == null
  ) {
    return null;
  }

  return {
    ipAllowlist,
    ipDenylist,
    domainAllowlist,
    domainDenylist,
    rateLimits: {
      login: {
        max: Math.min(10_000, Math.max(1, loginRateMax)),
        windowMs: Math.min(24 * 60 * 60 * 1000, Math.max(1_000, loginRateWindowMs)),
      },
      jobSubmit: {
        max: Math.min(10_000, Math.max(1, jobRateMax)),
        windowMs: Math.min(24 * 60 * 60 * 1000, Math.max(1_000, jobRateWindowMs)),
      },
    },
  };
}

export function evaluateNetworkAccess(
  input: NetworkAccessCheckInput,
): NetworkAccessCheckResult {
  const ip = normalizeIp(input.ip);
  const domain = normalizeDomain(input.domain);
  const { controls } = input;

  if (matchesAnyIp(ip, controls.ipDenylist)) {
    return { allowed: false, reason: "IP denied by server policy" };
  }
  if (controls.ipAllowlist.length > 0 && !matchesAnyIp(ip, controls.ipAllowlist)) {
    return { allowed: false, reason: "IP is not in server allowlist" };
  }

  if (matchesAnyDomain(domain, controls.domainDenylist)) {
    return { allowed: false, reason: "Domain denied by server policy" };
  }
  if (
    controls.domainAllowlist.length > 0
    && !matchesAnyDomain(domain, controls.domainAllowlist)
  ) {
    return { allowed: false, reason: "Domain is not in server allowlist" };
  }

  return { allowed: true };
}

export function extractDomainForPolicy(url: string, originHeader?: string): string | undefined {
  const origin = normalizeDomain(originHeader);
  if (origin) return origin;
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

