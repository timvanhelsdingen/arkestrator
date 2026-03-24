/**
 * training-scheduling.ts — Schedule management for coordinator training.
 *
 * Extracted from coordinator-training.ts as a pure structural refactor.
 */
import type { SettingsRepo } from "../db/settings.repo.js";
import { getCoordinatorScriptPrograms, type ProgramDiscoveryDeps } from "./engines.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const COORDINATOR_TRAINING_SCHEDULE_KEY = "coordinator_training_schedule";
export const COORDINATOR_TRAINING_LAST_RUN_KEY = "coordinator_training_last_run_by_program";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoordinatorTrainingSchedule {
  enabled: boolean;
  intervalMinutes: number;
  apply: boolean;
  programs: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeProgramList(programs: string[] | undefined, deps?: ProgramDiscoveryDeps): string[] {
  const known = new Set(getCoordinatorScriptPrograms(deps).map((p) => p.toLowerCase()));
  const out = new Set<string>();
  for (const raw of programs ?? []) {
    const p = String(raw ?? "").trim().toLowerCase();
    if (!p) continue;
    if (!known.has(p)) continue;
    out.add(p);
  }
  return [...out];
}

// ── Schedule read/write ──────────────────────────────────────────────────────

export function getCoordinatorTrainingSchedule(settingsRepo: SettingsRepo, deps?: ProgramDiscoveryDeps): CoordinatorTrainingSchedule {
  const defaults: CoordinatorTrainingSchedule = {
    enabled: false,
    intervalMinutes: 24 * 60,
    apply: true,
    programs: normalizeProgramList(getCoordinatorScriptPrograms(deps), deps),
  };
  const raw = settingsRepo.get(COORDINATOR_TRAINING_SCHEDULE_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const intervalValue = Number(parsed.intervalMinutes);
    return {
      enabled: parsed.enabled === true,
      intervalMinutes: Number.isFinite(intervalValue)
        ? Math.max(5, Math.min(7 * 24 * 60, Math.round(intervalValue)))
        : defaults.intervalMinutes,
      apply: parsed.apply !== false,
      programs: normalizeProgramList(
        Array.isArray(parsed.programs) ? parsed.programs.map((p) => String(p ?? "")) : defaults.programs,
        deps,
      ),
    };
  } catch {
    return defaults;
  }
}

export function setCoordinatorTrainingSchedule(settingsRepo: SettingsRepo, schedule: CoordinatorTrainingSchedule, deps?: ProgramDiscoveryDeps): void {
  const normalized: CoordinatorTrainingSchedule = {
    enabled: !!schedule.enabled,
    intervalMinutes: Math.max(5, Math.min(7 * 24 * 60, Math.round(Number(schedule.intervalMinutes) || 0))),
    apply: schedule.apply !== false,
    programs: normalizeProgramList(schedule.programs, deps),
  };
  settingsRepo.set(COORDINATOR_TRAINING_SCHEDULE_KEY, JSON.stringify(normalized));
}

export function getCoordinatorTrainingLastRunByProgram(settingsRepo: SettingsRepo): Record<string, string> {
  const raw = settingsRepo.get(COORDINATOR_TRAINING_LAST_RUN_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [program, iso] of Object.entries(parsed)) {
      const key = String(program ?? "").trim().toLowerCase();
      const value = String(iso ?? "").trim();
      if (!key || !value) continue;
      if (Number.isNaN(Date.parse(value))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function setCoordinatorTrainingLastRunByProgram(settingsRepo: SettingsRepo, runs: Record<string, string>): void {
  const out: Record<string, string> = {};
  for (const [program, iso] of Object.entries(runs)) {
    const key = String(program ?? "").trim().toLowerCase();
    const value = String(iso ?? "").trim();
    if (!key || !value || Number.isNaN(Date.parse(value))) continue;
    out[key] = value;
  }
  settingsRepo.set(COORDINATOR_TRAINING_LAST_RUN_KEY, JSON.stringify(out));
}

export function computeCoordinatorTrainingNextRunByProgram(
  schedule: CoordinatorTrainingSchedule,
  lastRunByProgram: Record<string, string>,
  now = new Date(),
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const nowMs = now.getTime();
  for (const program of schedule.programs) {
    if (!schedule.enabled) {
      out[program] = null;
      continue;
    }
    const last = lastRunByProgram[program];
    if (!last) {
      out[program] = new Date(nowMs).toISOString();
      continue;
    }
    const lastMs = Date.parse(last);
    if (Number.isNaN(lastMs)) {
      out[program] = new Date(nowMs).toISOString();
      continue;
    }
    out[program] = new Date(lastMs + schedule.intervalMinutes * 60_000).toISOString();
  }
  return out;
}
