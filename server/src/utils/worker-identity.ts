export interface WorkerIdentityInput {
  workerName?: string | null;
  osUser?: string | null;
  ip?: string | null;
  name?: string | null;
  program?: string | null;
}

function clean(value?: string | null): string {
  return String(value ?? "").trim();
}

/**
 * Normalize Unicode smart quotes and curly apostrophes to their ASCII equivalents.
 * macOS hostnames often contain RIGHT SINGLE QUOTATION MARK (U+2019) instead of
 * ASCII apostrophe (U+0027), causing matching failures when users type the ASCII version.
 */
export function normalizeQuotes(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")  // Smart single quotes → ASCII apostrophe
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"');  // Smart double quotes → ASCII double quote
}

function slug(value: string): string {
  return normalizeQuotes(value).trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Resolve a stable worker identity for bridge connections.
 *
 * Priority:
 * 1) explicit workerName from bridge payload
 * 2) osUser@ip fallback
 * 3) host-<ip> fallback
 * 4) bridge display name
 * 5) <program>-bridge
 */
export function deriveWorkerIdentity(input: WorkerIdentityInput): string | undefined {
  const workerName = clean(input.workerName);
  if (workerName) return slug(workerName);

  const osUser = clean(input.osUser);
  const ip = clean(input.ip);
  if (osUser && ip) return slug(`${osUser}@${ip}`);
  if (ip) return slug(`host-${ip}`);

  const name = clean(input.name);
  if (name) return slug(name);

  const program = clean(input.program);
  if (program) return slug(`${program}-bridge`);

  return undefined;
}
