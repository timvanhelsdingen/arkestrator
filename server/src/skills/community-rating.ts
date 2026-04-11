/**
 * Push and fetch 1-5 star ratings for community skills on arkestrator.com.
 *
 * Two call paths touch this helper:
 *   1. Agent-side: the `rate_skill` MCP tool calls `pushCommunityRating`
 *      whenever an agent rates a community-sourced skill. The score is the
 *      rounded rolling average of that user's internal outcomes for the
 *      skill (see `SkillEffectivenessRepo.getUserOutcomeAverage`), mapped to
 *      stars via useful=5 / average=3 / negative=1.
 *   2. Client-side (manual): the `/api/skills/community/:id/rate` route
 *      forwards a user-supplied score.
 *
 * The marketplace endpoint is upsert-per-user: re-POSTing with a new score
 * replaces the user's existing rating, which is exactly what "adjust rating
 * with new jobs" means from the user's perspective.
 *
 * Error handling mirrors `community-install.ts` — non-2xx responses have
 * their JSON body passed through verbatim so future server-side error shapes
 * (`rate_limited`, `subscription_required`, etc.) propagate to callers
 * without a client update.
 */

import { logger } from "../utils/logger.js";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function parseErrorBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    try {
      const text = await res.text();
      return { raw: text };
    } catch {
      return {};
    }
  }
}

export interface PushRatingOptions {
  /** The upstream arkestrator.com skill id. */
  communityId: string;
  baseUrl: string;
  sessionToken: string;
  /** 1..5 — caller is responsible for clamping before calling. */
  score: number;
}

export type PushRatingResult =
  | { ok: true; avg_rating: number; rating_count: number; your_rating: number }
  | { ok: false; error: string; message: string; status?: number };

/**
 * POST a 1-5 star rating for a community skill. Upsert-per-user on the server
 * — same user calling twice replaces their previous score.
 */
export async function pushCommunityRating(opts: PushRatingOptions): Promise<PushRatingResult> {
  const score = Math.max(1, Math.min(5, Math.round(opts.score)));
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(opts.communityId)}/rate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.sessionToken}`,
      },
      body: JSON.stringify({ score }),
    });
  } catch (err: any) {
    return {
      ok: false,
      error: "unreachable",
      message: `Unable to reach community registry to submit rating: ${err?.message ?? "network error"}`,
    };
  }

  if (!res.ok) {
    const body = await parseErrorBody(res);
    return {
      ok: false,
      error: (body.error as string) ?? `http_${res.status}`,
      message: (body.message as string) ?? `Rating submission failed with HTTP ${res.status}`,
      status: res.status,
    };
  }

  let body: any;
  try {
    body = await res.json();
  } catch (err: any) {
    return {
      ok: false,
      error: "invalid_response",
      message: `Community registry returned non-JSON on rate: ${err?.message ?? "parse error"}`,
    };
  }

  return {
    ok: true,
    avg_rating: typeof body.avg_rating === "number" ? body.avg_rating : 0,
    rating_count: typeof body.rating_count === "number" ? body.rating_count : 0,
    your_rating: typeof body.your_rating === "number" ? body.your_rating : score,
  };
}

export interface FetchUserRatingOptions {
  communityId: string;
  baseUrl: string;
  sessionToken: string;
}

export type FetchUserRatingResult =
  | { ok: true; your_rating: number | null }
  | { ok: false; error: string; message: string; status?: number };

/**
 * Fetch the current user's existing 1-5 star rating for a community skill
 * (so the client can pre-populate the star widget). Returns null when the
 * user has never rated the skill.
 */
export async function fetchCommunityUserRating(
  opts: FetchUserRatingOptions,
): Promise<FetchUserRatingResult> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(opts.communityId)}/rating`, {
      headers: { Authorization: `Bearer ${opts.sessionToken}` },
    });
  } catch (err: any) {
    return {
      ok: false,
      error: "unreachable",
      message: `Unable to reach community registry to fetch rating: ${err?.message ?? "network error"}`,
    };
  }

  if (!res.ok) {
    const body = await parseErrorBody(res);
    return {
      ok: false,
      error: (body.error as string) ?? `http_${res.status}`,
      message: (body.message as string) ?? `Fetching rating failed with HTTP ${res.status}`,
      status: res.status,
    };
  }

  try {
    const body = (await res.json()) as { your_rating?: number | null };
    const rating = typeof body.your_rating === "number" ? body.your_rating : null;
    return { ok: true, your_rating: rating };
  } catch (err: any) {
    return {
      ok: false,
      error: "invalid_response",
      message: `Community registry returned non-JSON on rating fetch: ${err?.message ?? "parse error"}`,
    };
  }
}

/**
 * Map internal outcome counts to a 1-5 star score using the rolling average
 * the user asked for. positive=5, average=3, negative=1.
 *
 * Returns null when there are no samples (nothing to submit).
 */
export function outcomeTallyToStars(tally: { positive: number; average: number; negative: number }): number | null {
  const samples = tally.positive + tally.average + tally.negative;
  if (samples <= 0) return null;
  const raw = (5 * tally.positive + 3 * tally.average + 1 * tally.negative) / samples;
  return Math.max(1, Math.min(5, Math.round(raw)));
}

/**
 * Thin wrapper used by the MCP tool — logs the attempt and result so
 * operators can trace what was sent upstream for which user/skill.
 */
export async function submitRatingForJob(params: {
  communityId: string;
  baseUrl: string;
  sessionToken: string;
  score: number;
  userId: string;
  jobId: string;
  skillSlug: string;
}): Promise<PushRatingResult> {
  const result = await pushCommunityRating({
    communityId: params.communityId,
    baseUrl: params.baseUrl,
    sessionToken: params.sessionToken,
    score: params.score,
  });
  if (result.ok) {
    logger.info(
      "community-rating",
      `Pushed ${params.score}★ for ${params.skillSlug} (communityId=${params.communityId}, user=${params.userId}, job=${params.jobId}) → avg=${result.avg_rating} n=${result.rating_count}`,
    );
  } else {
    logger.warn(
      "community-rating",
      `Failed to push ${params.score}★ for ${params.skillSlug} (communityId=${params.communityId}, user=${params.userId}, job=${params.jobId}): ${result.error} ${result.message}`,
    );
  }
  return result;
}
