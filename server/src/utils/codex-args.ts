/** Strip legacy/invalid Codex args from saved configs for forward compatibility. */
export function normalizeCodexArgs(rawArgs: string[]): string[] {
  const out: string[] = [];
  const approvalValues = new Set([
    "untrusted",
    "on-failure",
    "on-request",
    "never",
    "full-auto",
  ]);

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Legacy prompt flags from older templates
    if (arg === "-p" || arg === "--print") continue;

    // Old Codex CLI style: --approval-mode full-auto
    if (arg === "--approval-mode") {
      const next = rawArgs[i + 1];
      if (next && approvalValues.has(next)) i++;
      continue;
    }

    if (approvalValues.has(arg)) continue;

    out.push(arg);
  }

  return out;
}
