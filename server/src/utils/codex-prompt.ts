/**
 * Windows CreateProcess argument handling can truncate multiline prompt args
 * for some CLIs. Encode newlines as literal "\n" for stable prompt passing.
 */
export function encodeCodexPromptArg(prompt: string): string {
  if (process.platform !== "win32") return prompt;
  return prompt.replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}

