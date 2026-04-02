/**
 * Centralized retry policy for job failures.
 *
 * Only transient errors (rate limits, API timeouts, connection failures)
 * are eligible for retry. Permanent errors (auth failures, invalid config,
 * logic errors) should fail immediately.
 */

/** Patterns that indicate a transient/retriable error. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\b429\b/,                    // HTTP 429 Too Many Requests
  /\b503\b/,                    // HTTP 503 Service Unavailable
  /\b502\b/,                    // HTTP 502 Bad Gateway
  /\brate.?limit/i,             // Rate limit error messages
  /\boverloaded\b/i,            // API overloaded
  /\bECONNREFUSED\b/,           // Connection refused
  /\bETIMEDOUT\b/,              // Connection timeout
  /\bECONNRESET\b/,             // Connection reset
  /\bEPIPE\b/,                  // Broken pipe
  /\bsocket hang up\b/i,        // Node socket hang up
  /\btimeout\b.*\b(exceeded|expired)\b/i, // Generic timeout
  /\btemporarily unavailable\b/i,
  /\bservice unavailable\b/i,
  /\binternal server error\b/i, // 500 from upstream
  /\bgateway timeout\b/i,       // 504
  /\bstalled\b/i,               // Process idle timeout (no output)
  /\bno output for\b/i,         // Idle timeout message from process tracker
];

/** Patterns that indicate a permanent/non-retriable error. */
const PERMANENT_PATTERNS: RegExp[] = [
  /\b401\b.*\bunauthorized\b/i,
  /\b403\b.*\bforbidden\b/i,
  /\binvalid.*api.?key\b/i,
  /\binvalid.*config\b/i,
  /\bno.*agent.*config\b/i,
  /\btarget worker.*never connected\b/i,
  /\bexpired\b.*\bttl\b/i,
];

/**
 * Determine whether an error message indicates a transient failure
 * that may succeed on retry.
 */
export function isTransientError(error: string): boolean {
  const text = String(error ?? "").trim();
  if (!text) return false;

  // Check permanent patterns first — these override transient patterns
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Compute retry delay using exponential backoff with jitter.
 *
 * Formula: min(maxMs, baseMs * 2^retryCount) + random(0, baseMs * 0.5)
 *
 * Default: 30s base, 5min max
 * Retry 0: ~30-45s
 * Retry 1: ~60-75s
 * Retry 2: ~120-135s
 */
export function computeRetryDelay(
  retryCount: number,
  baseMs = 30_000,
  maxMs = 300_000,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, retryCount));
  const jitter = Math.random() * baseMs * 0.5;
  return Math.round(exponential + jitter);
}

/** Default max retries for regular jobs. */
export const DEFAULT_MAX_RETRIES = 2;

/** Default TTL for worker-targeted jobs (30 minutes). */
export const DEFAULT_TARGET_WORKER_TTL_MS = 30 * 60 * 1000;
