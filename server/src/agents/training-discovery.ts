/**
 * training-discovery.ts — Project discovery and source path resolution for coordinator training.
 *
 * Extracted from coordinator-training.ts as a pure structural refactor.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import type { SettingsRepo } from "../db/settings.repo.js";
import {
  filterCoordinatorSourcePathsByProgram,
  inferCoordinatorSourceProgramsFromPath,
  parseCoordinatorReferencePaths,
  parseCoordinatorSourcePrograms,
} from "./coordinator-playbooks.js";
// ── Types (shared across training sub-modules) ──────────────────────────────

export interface CoordinatorTrainingSummary {
  name: string;
  path: string;
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const PROJECT_CONFIG_FILES = [
  "arkestrator.coordinator.json",
  "agent-manager.coordinator.json",
];
export const PROJECT_NOTES_FILES = [
  "arkestrator.coordinator.md",
  "agent-manager.coordinator.md",
];
export const DOC_FILE_CANDIDATES = [
  "README.md",
  "README.txt",
  "ABOUT.md",
  "NOTES.md",
  "DESCRIPTION.md",
  "docs.md",
];
export const SKIP_SCAN_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
  "__pycache__",
  ".venv",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "bin",
]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoordinatorTrainingProjectDetail {
  projectPath: string;
  sourcePath: string;
  projectName: string;
  configPath: string;
  notesPath: string;
  config?: Record<string, unknown>;
  notesExcerpt?: string;
  inventory: {
    files: string[];
    sceneFiles: string[];
  };
}

export interface TrainingProjectFileBaseline {
  path: string;
  existed: boolean;
  content?: string;
}

// ── Path resolution helpers ──────────────────────────────────────────────────

export function isSafeProgramName(program: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(program);
}

export function isWindowsAbsolutePath(pathValue: string): boolean {
  const input = String(pathValue ?? "").trim();
  if (!input) return false;
  return /^[a-zA-Z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input);
}

export function resolveWithin(baseDir: string, pathValue: string): string | null {
  const input = String(pathValue ?? "").trim();
  if (!input) return null;
  const absoluteInput = isAbsolute(input) || isWindowsAbsolutePath(input);
  const out = absoluteInput ? input : join(baseDir, input);
  if (absoluteInput) return out;
  const rel = relative(baseDir, out);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return out;
}

export function resolveProgramDir(playbooksDir: string, program: string): string {
  if (!isSafeProgramName(program)) throw new Error(`Invalid coordinator program: ${program}`);
  const full = join(playbooksDir, program);
  const rel = relative(playbooksDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid coordinator program: ${program}`);
  return full;
}

export function resolveProjectConfigPath(projectDir: string): string | null {
  for (const file of PROJECT_CONFIG_FILES) {
    const candidate = join(projectDir, file);
    if (existsSync(candidate)) return candidate;
  }
  return join(projectDir, PROJECT_CONFIG_FILES[0]);
}

function resolveProjectNotesPath(projectDir: string): string | null {
  for (const file of PROJECT_NOTES_FILES) {
    const candidate = join(projectDir, file);
    if (existsSync(candidate)) return candidate;
  }
  return join(projectDir, PROJECT_NOTES_FILES[0]);
}

export function resolveScriptPath(scriptsDir: string, program: string): string {
  if (!isSafeProgramName(program)) throw new Error(`Invalid coordinator program: ${program}`);
  const full = join(scriptsDir, `${program}.md`);
  const rel = relative(scriptsDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Invalid coordinator program: ${program}`);
  return full;
}

export function resolvePlaybookPath(playbooksDir: string, program: string): string {
  const programDir = resolveProgramDir(playbooksDir, program);
  return join(programDir, "playbook.json");
}

// ── Project inspection helpers ───────────────────────────────────────────────

export function readProjectConfig(path: string): any | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseProjectConfigFromNotesMarkdown(program: string, projectDir: string, markdown: string): any | null {
  const content = String(markdown ?? "");
  if (!content.trim()) return null;

  const jsonCodeBlockRegex = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = jsonCodeBlockRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          ...parsed,
          program,
          projectPath: projectDir,
        };
      }
    } catch {
      // try next block
    }
  }

  const purposeMatch = content.match(/^##\s+Purpose Summary\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/im);
  const prompt = String(purposeMatch?.[1] ?? "").trim();
  if (!prompt) return null;
  return {
    version: 1,
    program,
    projectName: basename(projectDir),
    projectPath: projectDir,
    prompt,
  };
}

export function readProjectConfigFromNotes(program: string, projectDir: string): any | null {
  const notesPath = resolveProjectNotesPath(projectDir);
  if (!notesPath || !existsSync(notesPath)) return null;
  try {
    const markdown = readFileSync(notesPath, "utf-8");
    return parseProjectConfigFromNotesMarkdown(program, projectDir, markdown);
  } catch {
    return null;
  }
}

export function readDocSnippet(projectDir: string, maxChars = 500): string {
  for (const fileName of DOC_FILE_CANDIDATES) {
    const full = join(projectDir, fileName);
    if (!existsSync(full)) continue;
    try {
      if (!statSync(full).isFile()) continue;
      const text = readFileSync(full, "utf-8").trim();
      if (text) return text.slice(0, maxChars);
    } catch {
      // ignore unreadable docs
    }
  }
  return "";
}

export function looksLikeProjectDir(program: string, entries: string[]): boolean {
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  const hasDoc = DOC_FILE_CANDIDATES.some((f) => lower.has(f.toLowerCase()));
  const hasFileWithExt = (extRegex: RegExp) => entries.some((e) => extRegex.test(e));

  if (program === "godot") return lower.has("project.godot");
  if (program === "unity") return lower.has("assets") && lower.has("projectsettings");
  if (program === "unreal") return hasFileWithExt(/\.uproject$/i);
  if (program === "blender") return hasFileWithExt(/\.blend$/i);
  if (program === "houdini") return hasFileWithExt(/\.hip(?:lc|nc)?$/i);
  if (program === "comfyui") return lower.has("workflow_api.json") || (hasDoc && hasFileWithExt(/\.json$/i));
  if (program === "fusion" || program === "davinci" || program === "resolve") {
    return hasFileWithExt(/\.comp$/i) || hasFileWithExt(/\.setting$/i) || lower.has("fuses");
  }
  if (program === "nuke") return hasFileWithExt(/\.nk$/i) || hasFileWithExt(/\.nknc$/i);
  // Unknown programs: don't match on just a README — require program-specific file signatures
  return false;
}

/**
 * Auto-detect which programs (houdini, blender, godot, etc.) are present
 * in the given source paths. Performs a shallow BFS (default depth 2) using
 * `looksLikeProjectDir` file-signature matching, with a path-string heuristic
 * fallback. Stops checking a program once one match is found for speed.
 */
export function detectProgramsInPaths(
  sourcePaths: string[],
  knownPrograms: string[],
  maxDepth = 2,
): string[] {
  const detected = new Set<string>();
  const programs = knownPrograms
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== "global");

  for (const sourcePath of sourcePaths) {
    // Fast heuristic: infer from path string ("/houdini/" in path → houdini)
    for (const inferred of inferCoordinatorSourceProgramsFromPath(sourcePath)) {
      if (inferred !== "global" && programs.includes(inferred)) {
        detected.add(inferred);
      }
    }

    // BFS scan: check directory contents against file signatures
    const queue: Array<{ path: string; depth: number }> = [{ path: sourcePath, depth: 0 }];
    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        continue;
      }

      // Check each program's file signature against this directory
      for (const program of programs) {
        if (detected.has(program)) continue; // already found
        if (looksLikeProjectDir(program, entries)) {
          detected.add(program);
        }
      }

      // All programs found? Stop early
      if (detected.size >= programs.length) break;

      // Descend into subdirectories
      if (depth < maxDepth) {
        for (const name of entries) {
          if (SKIP_SCAN_DIRS.has(name)) continue;
          const full = join(path, name);
          try {
            if (statSync(full).isDirectory()) {
              queue.push({ path: full, depth: depth + 1 });
            }
          } catch {
            // skip unreadable
          }
        }
      }
    }
  }

  return [...detected].sort();
}

// ── Directory / project discovery ────────────────────────────────────────────

export function discoverProjectDirs(
  program: string,
  sourceRoot: string,
  maxDepth = 4,
  maxProjects = 400,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: sourceRoot, depth: 0 }];

  while (queue.length > 0 && out.length < maxProjects) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    let entries: string[] = [];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }

    if (looksLikeProjectDir(program, entries) && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
    if (depth >= maxDepth) continue;

    entries.sort();
    for (const name of entries) {
      const full = join(path, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (SKIP_SCAN_DIRS.has(name)) continue;
      queue.push({ path: full, depth: depth + 1 });
    }
  }

  if (out.length === 0) out.push(sourceRoot);
  return out;
}

export function resolveProjectDirFromSourceFile(program: string, sourceFile: string, maxParents = 5): string | null {
  let currentDir = dirname(sourceFile);
  for (let i = 0; i <= maxParents; i++) {
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      entries = [];
    }
    if (entries.length > 0 && looksLikeProjectDir(program, entries)) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (!parent || parent === currentDir) break;
    currentDir = parent;
  }
  return dirname(sourceFile);
}

export function listProjectFiles(projectDir: string, maxFiles = 200): { files: string[]; sceneFiles: string[] } {
  const files: string[] = [];
  const sceneFiles: string[] = [];
  const queue: string[] = [projectDir];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = join(current, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(name)) continue;
        queue.push(fullPath);
        continue;
      }
      if (!st.isFile()) continue;
      const relPath = relative(projectDir, fullPath).replace(/\\/g, "/");
      files.push(relPath);
      if (/\.(hip|hiplc|hipnc|blend|tscn|scn|uproject|unity)$/i.test(name)) {
        sceneFiles.push(relPath);
      }
    }
  }
  return { files, sceneFiles };
}

export function collectTrainingProjectDetails(
  program: string,
  sourcePaths: string[],
  maxProjects = 120,
): CoordinatorTrainingProjectDetail[] {
  const out: CoordinatorTrainingProjectDetail[] = [];
  const seen = new Set<string>();
  for (const sourcePath of sourcePaths) {
    if (!existsSync(sourcePath)) continue;
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      continue;
    }
    const projectDirs = st.isDirectory()
      ? discoverProjectDirs(program, sourcePath, 4, maxProjects)
      : st.isFile()
      ? [resolveProjectDirFromSourceFile(program, sourcePath)].filter((value): value is string => !!value)
      : [];
    for (const projectDir of projectDirs) {
      if (out.length >= maxProjects) break;
      const key = projectDir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const configPath = resolveProjectConfigPath(projectDir) ?? join(projectDir, PROJECT_CONFIG_FILES[0]);
      const notesPath = resolveProjectNotesPath(projectDir) ?? join(projectDir, PROJECT_NOTES_FILES[0]);
      const config = existsSync(configPath) ? (readProjectConfig(configPath) ?? undefined) : undefined;
      const notesExcerpt = existsSync(notesPath)
        ? readFileSync(notesPath, "utf-8").slice(0, 12_000)
        : undefined;
      const inventory = listProjectFiles(projectDir, 280);
      const projectName = String(config?.projectName ?? basename(projectDir)).trim() || basename(projectDir);
      out.push({
        projectPath: projectDir,
        sourcePath,
        projectName,
        configPath,
        notesPath,
        config: config as Record<string, unknown> | undefined,
        notesExcerpt,
        inventory,
      });
    }
  }
  return out;
}

// ── File baselines (capture/restore) ─────────────────────────────────────────

export function captureTrainingProjectFileBaselines(
  program: string,
  sourcePaths: string[],
): TrainingProjectFileBaseline[] {
  const details = collectTrainingProjectDetails(program, sourcePaths, 120);
  const out: TrainingProjectFileBaseline[] = [];
  const seen = new Set<string>();

  for (const project of details) {
    const candidatePaths = [
      ...PROJECT_CONFIG_FILES.map((name) => join(project.projectPath, name)),
      ...PROJECT_NOTES_FILES.map((name) => join(project.projectPath, name)),
    ];
    for (const filePath of candidatePaths) {
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (!existsSync(filePath)) {
        out.push({ path: filePath, existed: false });
        continue;
      }

      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > 2_000_000) {
        out.push({ path: filePath, existed: true });
        continue;
      }
      try {
        out.push({
          path: filePath,
          existed: true,
          content: readFileSync(filePath, "utf-8"),
        });
      } catch {
        out.push({ path: filePath, existed: true });
      }
    }
  }

  return out;
}

export function restoreTrainingProjectFileBaselines(
  baselines: TrainingProjectFileBaseline[],
): { restored: number; removed: number; failed: number } {
  let restored = 0;
  let removed = 0;
  let failed = 0;

  for (const baseline of baselines) {
    try {
      if (baseline.existed) {
        if (typeof baseline.content === "string") {
          mkdirSync(dirname(baseline.path), { recursive: true });
          writeFileSync(baseline.path, baseline.content, "utf-8");
          restored += 1;
        }
        continue;
      }
      if (!existsSync(baseline.path)) continue;
      const st = statSync(baseline.path);
      if (!st.isFile()) continue;
      unlinkSync(baseline.path);
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return { restored, removed, failed };
}

// ── Source path resolution ────────────────────────────────────────────────────

export function resolveTrainingSourcePaths(
  settingsRepo: SettingsRepo,
  defaultCoordinatorPlaybookSourcePaths: string[],
  coordinatorPlaybooksDir: string,
  program: string,
  inputPaths?: string[],
): string[] {
  const programDir = resolveProgramDir(coordinatorPlaybooksDir, program);
  const provided = Array.isArray(inputPaths)
    ? [...new Set(inputPaths.map((p) => String(p ?? "").trim()).filter(Boolean))]
    : [];
  if (provided.length > 0) {
    return provided
      .map((path) => resolveWithin(programDir, path))
      .filter((path): path is string => !!path);
  }

  const configured = parseCoordinatorReferencePaths(settingsRepo.get("coordinator_playbook_sources"));
  const pathsByProgram = parseCoordinatorSourcePrograms(settingsRepo.get("coordinator_playbook_source_programs"));
  const combined = [...new Set([...defaultCoordinatorPlaybookSourcePaths, ...configured])];
  const scoped = filterCoordinatorSourcePathsByProgram(combined, pathsByProgram, program);
  return scoped
    .map((path) => resolveWithin(programDir, path))
    .filter((path): path is string => !!path);
}

export function resolveScheduledVaultSourcePaths(
  coordinatorPlaybooksDir: string,
  program: string,
): string[] {
  const learningRoot = join(coordinatorPlaybooksDir, "_learning");
  const candidates = [
    join(learningRoot, "jobs", program),
    join(learningRoot, "uploads", program),
    learningRoot,
  ];
  const existing = candidates.filter((candidate) => existsSync(candidate));
  return existing.length > 0 ? existing : [learningRoot];
}
