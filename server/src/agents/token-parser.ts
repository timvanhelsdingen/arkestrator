/**
 * Parse token usage from agent CLI output.
 * Each engine has different output formats — we match known patterns.
 */
export function parseTokenUsage(
  logBuffer: string,
  engine: string,
): { inputTokens: number; outputTokens: number } | null {
  switch (engine) {
    case "claude-code":
      return parseClaudeTokens(logBuffer);
    case "codex":
      return parseCodexTokens(logBuffer);
    case "gemini":
      return parseGeminiTokens(logBuffer);
    default:
      return null;
  }
}

function parseClaudeTokens(
  log: string,
): { inputTokens: number; outputTokens: number } | null {
  // Claude Code prints a summary at the end like:
  // "Total tokens: 12345 input, 6789 output"
  // or "Input tokens: 12345" and "Output tokens: 6789" on separate lines
  // or cost summary with token counts

  // Pattern 1: "X input tokens" and "Y output tokens"
  const inputMatch = log.match(/(\d[\d,]*)\s*input\s*tokens?/i);
  const outputMatch = log.match(/(\d[\d,]*)\s*output\s*tokens?/i);

  if (inputMatch && outputMatch) {
    return {
      inputTokens: parseInt(inputMatch[1].replace(/,/g, ""), 10),
      outputTokens: parseInt(outputMatch[1].replace(/,/g, ""), 10),
    };
  }

  // Pattern 2: "total_tokens: X" or "Total tokens: X"
  const totalMatch = log.match(/total.tokens?[:\s]+(\d[\d,]*)/i);
  if (totalMatch) {
    const total = parseInt(totalMatch[1].replace(/,/g, ""), 10);
    // Can't split input/output, approximate 70/30
    return {
      inputTokens: Math.round(total * 0.7),
      outputTokens: Math.round(total * 0.3),
    };
  }

  return null;
}

function parseCodexTokens(
  log: string,
): { inputTokens: number; outputTokens: number } | null {
  // Codex CLI token patterns (extend as needed)
  const inputMatch = log.match(/input.tokens?[:\s]+(\d[\d,]*)/i);
  const outputMatch = log.match(/output.tokens?[:\s]+(\d[\d,]*)/i);

  if (inputMatch && outputMatch) {
    return {
      inputTokens: parseInt(inputMatch[1].replace(/,/g, ""), 10),
      outputTokens: parseInt(outputMatch[1].replace(/,/g, ""), 10),
    };
  }

  return null;
}

function parseGeminiTokens(
  log: string,
): { inputTokens: number; outputTokens: number } | null {
  // Gemini CLI token patterns (extend as needed)
  const inputMatch = log.match(/input.tokens?[:\s]+(\d[\d,]*)/i);
  const outputMatch = log.match(/output.tokens?[:\s]+(\d[\d,]*)/i);

  if (inputMatch && outputMatch) {
    return {
      inputTokens: parseInt(inputMatch[1].replace(/,/g, ""), 10),
      outputTokens: parseInt(outputMatch[1].replace(/,/g, ""), 10),
    };
  }

  return null;
}
