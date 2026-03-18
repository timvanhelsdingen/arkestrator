/**
 * Resolve local/OSS CLI args with lightweight placeholders.
 * - {{MODEL}} -> resolved model string
 * - {{PROMPT}} -> prompt text
 * If no {{PROMPT}} placeholder is present, prompt is appended as final arg.
 */
export function buildLocalCliArgs(
  rawArgs: string[] | undefined,
  prompt: string,
  model?: string,
): string[] {
  const resolvedModel = (model ?? "").trim();
  const args: string[] = [];
  let promptProvidedInArgs = false;

  for (const rawArg of rawArgs ?? []) {
    if (rawArg.includes("{{PROMPT}}")) promptProvidedInArgs = true;
    const resolved = rawArg
      .replaceAll("{{PROMPT}}", prompt)
      .replaceAll("{{MODEL}}", resolvedModel)
      .trim();
    if (!resolved) continue;
    args.push(resolved);
  }

  if (!promptProvidedInArgs) {
    args.push(prompt);
  }

  return args;
}
