/**
 * training-extraction.ts — JSON parsing and analysis extraction for coordinator training.
 *
 * Extracted from coordinator-training.ts as a pure structural refactor.
 */
import { basename, join } from "path";
import {
  PROJECT_CONFIG_FILES,
  PROJECT_NOTES_FILES,
  type CoordinatorTrainingSummary,
  type CoordinatorTrainingProjectDetail,
} from "./training-discovery.js";

export const TRAINING_CHILD_LOG_TAIL_CHARS = 12_000;

export interface AgenticTrainingSeed {
  summaries: CoordinatorTrainingSummary[];
  projects: CoordinatorTrainingProjectDetail[];
  notes: string[];
  blockedReason?: string;
}

export function parsePromptSummary(prompt: string, maxChars = 220): string {
  const cleaned = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

export function summarizeContextsPrompt(config: any): string {
  const contexts = Array.isArray(config?.contexts) ? config.contexts : [];
  if (contexts.length === 0) return "";
  const snippets = contexts
    .map((ctx: any) => String(ctx?.prompt ?? ctx?.summary ?? ctx?.description ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (snippets.length === 0) return "";
  return snippets.join(" | ");
}

export function extractAgenticNotesExcerpt(logs: string): string {
  const text = String(logs ?? "").trim();
  if (!text) return "";
  const markers = [
    "## Purpose Summary",
    "**Purpose Summary**",
    "Purpose Summary",
  ];
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) return text.slice(index).trim().slice(0, 12_000);
  }
  return text.slice(-12_000);
}

export function detectAgenticAnalysisBlocker(
  logs: string,
  selectedRecord: Record<string, unknown> | null,
): string | null {
  const text = String(logs ?? "");
  const checks: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /http\/1\.[01]\s+401\s+unauthorized/i,
      reason: "Bridge API returned HTTP 401 Unauthorized.",
    },
    {
      regex: /"error"\s*:\s*"unauthorized"/i,
      reason: "Bridge API returned Unauthorized.",
    },
    {
      regex: /missing\s+arkestrator_url\s+or\s+arkestrator_api_key/i,
      reason: "ARKESTRATOR_URL/ARKESTRATOR_API_KEY was missing in analysis environment.",
    },
    {
      regex: /\bkey:\s*0\b/i,
      reason: "ARKESTRATOR_API_KEY was empty in analysis environment.",
    },
    {
      regex: /no\s+such\s+file\s+or\s+directory/i,
      reason: "Analysis source paths were not accessible in the analysis workspace.",
    },
    {
      regex: /authentication_error|OAuth token has expired|Failed to authenticate.*API Error.*401/i,
      reason: "Claude API authentication failed (token expired or invalid). Re-authenticate before retrying.",
    },
    {
      regex: /API Error:\s*4\d\d\b/i,
      reason: "Claude API returned an error. Check API credentials and quota.",
    },
  ];
  for (const check of checks) {
    if (check.regex.test(text)) return check.reason;
  }

  const prompt = String(selectedRecord?.prompt ?? "").trim().toLowerCase();
  if (prompt.startsWith("blocked analysis run")) {
    return "Agentic analysis explicitly reported a blocked run.";
  }

  const contexts = Array.isArray(selectedRecord?.contexts) ? selectedRecord.contexts : [];
  for (const context of contexts) {
    if (!context || typeof context !== "object" || Array.isArray(context)) continue;
    const record = context as Record<string, unknown>;
    const name = String(record.name ?? "").trim().toLowerCase();
    if (name.includes("blocker")) {
      return `Agentic analysis returned blocker context "${name}".`;
    }
    const pattern = String(record.pattern ?? "").trim().toLowerCase();
    if (
      pattern.includes("unauthorized")
      || pattern.includes("api_key")
      || pattern.includes("401")
      || pattern.includes("no mounted source")
      || pattern.includes("source path")
    ) {
      return "Agentic analysis reported an access/source blocker in context output.";
    }
  }
  return null;
}

/**
 * Attempt to repair a truncated JSON object string.
 *
 * Agent output is frequently cut off by token limits, leaving JSON blocks
 * missing closing quotes, braces, or brackets.  This function strips any
 * trailing non-JSON noise (e.g. `[TodoWrite]`, `[done]`), then progressively
 * trims trailing characters and closes open structures until the string parses.
 */
export function repairTruncatedJson(raw: string): Record<string, unknown> | null {
  // Fast path: try stripping non-JSON noise after the last '}'
  const stripped = raw.replace(/\}[^}]*$/, "}");
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }

  // Strategy: walk character-by-character tracking brace depth.  Collect
  // every position where the top-level object closes (depth goes to 0) or
  // where it's still open.  Then try parsing at each candidate cut point.
  let body = raw;
  body = body.replace(/\n\[(?:TodoWrite|done|thinking|mcp_)[\s\S]*$/m, "");
  body = body.trim();

  // 1. Find candidate cut points where depth reaches 0 (complete object)
  //    or where depth is small and we can close remaining structures.
  const cutPoints: number[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) cutPoints.push(i + 1);
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
  }

  // 2. Try each cut point where depth reached 0 (complete JSON object)
  for (const cut of cutPoints) {
    try {
      const parsed = JSON.parse(body.slice(0, cut));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.program || parsed.projectName || parsed.projectPath || parsed.prompt) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch { /* try next cut point */ }
  }

  // 3. Fallback: object never closed — progressively trim and close.
  //    Use larger trim range to handle markdown noise appended after JSON.
  const maxTrim = Math.min(body.length, body.length - 40);
  for (let trim = 0; trim < maxTrim; trim++) {
    const candidate = body.slice(0, body.length - trim);
    let ob = 0;
    let obrk = 0;
    let inStr = false;
    let esc = false;
    for (let ci = 0; ci < candidate.length; ci++) {
      const c = candidate[ci];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") ob++;
      else if (c === "}") ob--;
      else if (c === "[") obrk++;
      else if (c === "]") obrk--;
    }
    if (ob <= 0) continue;
    let suffix = "";
    if (inStr) suffix += '"';
    for (let i = 0; i < obrk; i++) suffix += "]";
    for (let i = 0; i < ob; i++) suffix += "}";
    try {
      const parsed = JSON.parse(candidate + suffix);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.program || parsed.projectName || parsed.projectPath || parsed.prompt) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // continue trimming
    }
  }
  return null;
}

export function extractAgenticTrainingSeed(
  program: string,
  sourcePaths: string[],
  logs: string,
  trainingPrompt: string,
): AgenticTrainingSeed {
  const text = String(logs ?? "");
  if (!text.trim()) {
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: "Agentic analysis returned empty output.",
    };
  }

  const candidates: Array<Record<string, unknown>> = [];
  const jsonCodeBlockRegex = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = jsonCodeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore invalid JSON blocks.
    }
  }

  // Fallback: agent output is often truncated at token limits, leaving a
  // ```json block without its closing fence.  Try to extract from unclosed
  // blocks when no complete ones were found.
  if (candidates.length === 0) {
    const unclosedRegex = /```json\s*(\{[\s\S]*)/gi;
    let unclosed: RegExpExecArray | null = null;
    while ((unclosed = unclosedRegex.exec(text)) !== null) {
      const raw = unclosed[1];
      const repaired = repairTruncatedJson(raw);
      if (repaired) candidates.push(repaired);
    }
  }

  const selected = [...candidates]
    .reverse()
    .find((candidate) => {
      const candidateProgram = String(candidate.program ?? "").trim().toLowerCase();
      return !candidateProgram || candidateProgram === program;
    });
  const blockerReason = detectAgenticAnalysisBlocker(text, selected ?? null);
  if (blockerReason) {
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: blockerReason,
    };
  }
  if (!selected) {
    // Agent completed analysis but didn't emit a JSON config block.
    // Synthesise a minimal seed from source paths and extract what we can
    // from the markdown so the training run isn't wasted.
    if (sourcePaths.length > 0 && text.includes("[done]")) {
      const syntheticPath = sourcePaths[0];
      const syntheticName = basename(syntheticPath) || `${program}-training-reference`;
      const notesExcerpt = extractAgenticNotesExcerpt(text);
      const syntheticPrompt = parsePromptSummary(
        notesExcerpt || trainingPrompt || "Use this as a reference for project structure and conventions.",
        500,
      );
      return {
        summaries: [{
          name: syntheticName,
          path: syntheticPath,
          summary: syntheticPrompt,
        }],
        projects: [{
          projectPath: syntheticPath,
          sourcePath: syntheticPath,
          projectName: syntheticName,
          configPath: join(syntheticPath, PROJECT_CONFIG_FILES[0]),
          notesPath: join(syntheticPath, PROJECT_NOTES_FILES[0]),
          notesExcerpt: notesExcerpt || undefined,
          inventory: { files: [], sceneFiles: [] },
        }],
        notes: [
          "Agent completed analysis in markdown but did not emit JSON config. Synthetic seed constructed from source paths.",
        ],
      };
    }
    return {
      summaries: [],
      projects: [],
      notes: [],
      blockedReason: "Agentic analysis did not emit a required structured JSON config block.",
    };
  }
  const selectedRecord = selected ?? {};
  const projectPath = String((selectedRecord as Record<string, unknown>).projectPath ?? sourcePaths[0] ?? "").trim();
  const sourcePath = String(sourcePaths[0] ?? projectPath).trim() || projectPath;
  const projectName = String(
    (selectedRecord as Record<string, unknown>).projectName
      ?? (selectedRecord as Record<string, unknown>).name
      ?? (projectPath ? basename(projectPath) : `${program}-training-reference`),
  ).trim() || `${program}-training-reference`;
  const prompt = String((selectedRecord as Record<string, unknown>).prompt ?? "").trim()
    || summarizeContextsPrompt(selectedRecord as Record<string, unknown>)
    || parsePromptSummary(trainingPrompt, 500)
    || "Bridge-analyzed coordinator training reference.";

  const notesExcerpt = extractAgenticNotesExcerpt(text);
  const summary: CoordinatorTrainingSummary = {
    name: projectName,
    path: projectPath || sourcePath || `bridge:${program}`,
    summary: parsePromptSummary(prompt, 220),
  };
  const project: CoordinatorTrainingProjectDetail = {
    projectPath: projectPath || sourcePath || `bridge:${program}`,
    sourcePath: sourcePath || projectPath || `bridge:${program}`,
    projectName,
    configPath: projectPath
      ? join(projectPath, PROJECT_CONFIG_FILES[0])
      : `${projectName}/${PROJECT_CONFIG_FILES[0]}`,
    notesPath: projectPath
      ? join(projectPath, PROJECT_NOTES_FILES[0])
      : `${projectName}/${PROJECT_NOTES_FILES[0]}`,
    config: Object.keys(selectedRecord).length > 0 ? (selectedRecord as Record<string, unknown>) : undefined,
    notesExcerpt: notesExcerpt || undefined,
    inventory: {
      files: [],
      sceneFiles: [],
    },
  };

  return {
    summaries: [summary],
    projects: [project],
    notes: [
      "Training summaries seeded from bridge-analysis artifact (no server filesystem scan required).",
    ],
  };
}
