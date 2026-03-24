/**
 * training-vault.ts — Vault/artifact writing and learning collection for coordinator training.
 *
 * Extracted from coordinator-training.ts as a pure structural refactor.
 */
import { basename, join, relative } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import type { FileChange } from "@arkestrator/protocol";
import type { SettingsRepo } from "../db/settings.repo.js";
import {
  PROJECT_CONFIG_FILES,
  PROJECT_NOTES_FILES,
  SKIP_SCAN_DIRS,
  type CoordinatorTrainingSummary,
  type CoordinatorTrainingProjectDetail,
} from "./training-discovery.js";
import { parsePromptSummary } from "./training-extraction.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const LEARNING_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
export const MAX_LEARNING_SUMMARIES = 160;
export const MAX_LEARNING_DISCOVERY_FILES = 1200;
export const TRAINING_VAULT_METADATA_SETTING = "coordinator_training_vault_metadata_v1";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoordinatorTrainingArtifact {
  version: 1;
  source: "coordinator_training_job";
  job: {
    id: string;
    program: string;
    trigger: "manual" | "scheduled";
    apply: boolean;
    createdAt: string;
    generatedAt: string;
    analysisJobId?: string;
    analysisStatus?: string;
  };
  objective?: string;
  projectCount: number;
  sourcePaths: string[];
  summaries: CoordinatorTrainingSummary[];
  projects: CoordinatorTrainingProjectDetail[];
  outputs: {
    scriptPath: string;
    scriptUpdated: boolean;
    playbookPath: string;
    playbookUpdated: boolean;
  };
  notes: string[];
}

interface TrainingVaultMetadataActor {
  id: string | null;
  username: string | null;
  ipAddress: string | null;
  workerName: string | null;
}

// ── Learning vault helpers ───────────────────────────────────────────────────

export function isLikelyLearningVaultPath(pathValue: string): boolean {
  const normalized = String(pathValue ?? "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/_learning/") || normalized.endsWith("/_learning")
    || normalized.includes("/learning/") || normalized.endsWith("/learning");
}

export function listFilesForLearningDiscovery(root: string, maxFiles = MAX_LEARNING_DISCOVERY_FILES): string[] {
  const out: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.shift() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    entries.sort();
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(name)) continue;
        queue.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

export function extractLearningJsonSummary(
  program: string,
  filePath: string,
  parsed: Record<string, unknown>,
): CoordinatorTrainingSummary | null {
  const parsedJob = (parsed.job ?? {}) as Record<string, unknown>;
  const parsedMetadata = (parsed.metadata ?? {}) as Record<string, unknown>;
  const programHint = String(parsed.program ?? parsedJob.bridgeProgram ?? "").trim().toLowerCase();
  if (programHint && programHint !== program) return null;

  const name = String(
    parsed.projectName
      ?? parsed.name
      ?? parsedJob.name
      ?? parsedMetadata.jobName
      ?? basename(filePath),
  ).trim();

  const signal = String(parsed.signal ?? "").trim().toLowerCase();
  const prompt = String(
    parsed.prompt
      ?? parsedJob.prompt
      ?? parsed.summary
      ?? "",
  ).trim();
  const outcome = String(parsed.outcome ?? "").trim();
  const notes = String(parsed.notes ?? "").trim();
  const summary = parsePromptSummary(
    [
      signal ? `Signal: ${signal}` : "",
      prompt,
      outcome,
      notes,
    ].filter(Boolean).join(" | "),
    220,
  );
  if (!summary) return null;

  return {
    name: name || basename(filePath),
    path: filePath,
    summary,
  };
}

export function collectLearningVaultSummaries(program: string, sourcePath: string): CoordinatorTrainingSummary[] {
  const files = (() => {
    let st;
    try {
      st = statSync(sourcePath);
    } catch {
      return [];
    }
    if (st.isFile()) return [sourcePath];
    if (st.isDirectory()) return listFilesForLearningDiscovery(sourcePath, MAX_LEARNING_DISCOVERY_FILES);
    return [];
  })();

  const out: CoordinatorTrainingSummary[] = [];
  const seen = new Set<string>();
  for (const filePath of files) {
    if (out.length >= MAX_LEARNING_SUMMARIES) break;
    const ext = basename(filePath).includes(".")
      ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
      : "";
    if (!LEARNING_TEXT_EXTENSIONS.has(ext)) continue;

    if (ext === ".json") {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const summary = extractLearningJsonSummary(program, filePath, parsed);
        if (!summary) continue;
        const key = `${summary.name}::${summary.summary}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(summary);
      } catch {
        // ignore invalid JSON
      }
      continue;
    }

    try {
      const text = readFileSync(filePath, "utf-8");
      const summary = parsePromptSummary(text, 220);
      if (!summary) continue;
      const item: CoordinatorTrainingSummary = {
        name: basename(filePath),
        path: filePath,
        summary,
      };
      const key = `${item.name}::${item.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    } catch {
      // ignore unreadable text files
    }
  }

  return out;
}

// ── Vault metadata ──────────────────────────────────────────────────────────

export function normalizeTrainingVaultMetadataPath(pathValue: string): string {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

export function parseTrainingVaultMetadataMap(raw: string | null | undefined): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const normalizedPath = normalizeTrainingVaultMetadataPath(
        String((value as Record<string, unknown>).path ?? key),
      );
      if (!normalizedPath) continue;
      out[normalizedPath] = {
        ...(value as Record<string, unknown>),
        path: normalizedPath,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function upsertTrainingVaultMetadata(
  settingsRepo: SettingsRepo,
  options: {
    path: string;
    kind: "file" | "directory";
    actor?: Partial<TrainingVaultMetadataActor>;
    projectPaths?: string[];
    sourcePaths?: string[];
    remarks?: string;
  },
): void {
  const normalizedPath = normalizeTrainingVaultMetadataPath(options.path);
  if (!normalizedPath) return;

  const map = parseTrainingVaultMetadataMap(settingsRepo.get(TRAINING_VAULT_METADATA_SETTING));
  const now = new Date().toISOString();
  const previous = map[normalizedPath];
  const fallbackActor: TrainingVaultMetadataActor = {
    id: null,
    username: null,
    ipAddress: null,
    workerName: null,
  };
  const actor: TrainingVaultMetadataActor = {
    id: String(options.actor?.id ?? "").trim() || null,
    username: String(options.actor?.username ?? "").trim() || null,
    ipAddress: String(options.actor?.ipAddress ?? "").trim() || null,
    workerName: String(options.actor?.workerName ?? "").trim() || null,
  };
  const hasActor = Boolean(actor.id || actor.username || actor.ipAddress || actor.workerName);
  const sanitizePaths = (values: string[] | undefined): string[] =>
    [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 300);
  const remarks = String(options.remarks ?? "").trim().slice(0, 4_000);
  const previousProjectPaths = Array.isArray(previous?.projectPaths)
    ? previous.projectPaths.map((value) => String(value ?? "")).filter(Boolean)
    : [];
  const previousSourcePaths = Array.isArray(previous?.sourcePaths)
    ? previous.sourcePaths.map((value) => String(value ?? "")).filter(Boolean)
    : [];

  map[normalizedPath] = {
    path: normalizedPath,
    kind: options.kind,
    createdAt: String(previous?.createdAt ?? now),
    updatedAt: now,
    createdBy: previous?.createdBy ?? (hasActor ? actor : fallbackActor),
    updatedBy: hasActor ? actor : previous?.updatedBy ?? previous?.createdBy ?? fallbackActor,
    projectPaths: options.projectPaths ? sanitizePaths(options.projectPaths) : previousProjectPaths,
    sourcePaths: options.sourcePaths ? sanitizePaths(options.sourcePaths) : previousSourcePaths,
    remarks: remarks || previous?.remarks || null,
  };
  settingsRepo.set(TRAINING_VAULT_METADATA_SETTING, JSON.stringify(map));
}

// ── Artifact writing ─────────────────────────────────────────────────────────

export function writeTrainingArtifact(
  options: {
    coordinatorPlaybooksDir: string;
    settingsRepo: SettingsRepo;
    jobId: string;
    artifact: CoordinatorTrainingArtifact;
    metadataActor?: Partial<TrainingVaultMetadataActor>;
  },
): {
  jsonPath: string;
  markdownPath: string;
  jsonVaultPath: string;
  markdownVaultPath: string;
  mirroredProjectFiles: Array<{
    fullPath: string;
    vaultPath: string;
    projectPath: string;
    sourcePath: string;
  }>;
} {
  const { coordinatorPlaybooksDir, settingsRepo, jobId, artifact, metadataActor } = options;
  const slugifyFolderPart = (value: string, fallback: string): string => {
    const cleaned = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  };
  const objectiveSlug = slugifyFolderPart(
    parsePromptSummary(String(artifact.objective ?? ""), 64),
    "",
  );
  const summarySlug = slugifyFolderPart(String(artifact.summaries[0]?.name ?? ""), "");
  const baseFolderSlug = objectiveSlug || summarySlug || `${artifact.job.program}_training`;
  const folderName = `${baseFolderSlug}--${slugifyFolderPart(jobId, "job")}`;
  const folder = join(coordinatorPlaybooksDir, "_learning", "jobs", artifact.job.program, folderName);
  mkdirSync(folder, { recursive: true });

  const jsonPath = join(folder, "analysis.json");
  const markdownPath = join(folder, "analysis.md");
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");

  const mdLines: string[] = [];
  mdLines.push(`# ${artifact.job.program} Training Analysis`);
  mdLines.push("");
  mdLines.push(`- Job: ${artifact.job.id}`);
  mdLines.push(`- Trigger: ${artifact.job.trigger}`);
  mdLines.push(`- Generated: ${artifact.job.generatedAt}`);
  mdLines.push(`- Projects: ${artifact.projectCount}`);
  if (artifact.objective) mdLines.push(`- Objective: ${artifact.objective}`);
  if (artifact.job.analysisJobId) mdLines.push(`- Analysis Job: ${artifact.job.analysisJobId} (${artifact.job.analysisStatus ?? "unknown"})`);
  mdLines.push("");
  mdLines.push("## Summaries");
  for (const summary of artifact.summaries) {
    mdLines.push(`- **${summary.name}** (${summary.path})`);
    mdLines.push(`  - ${summary.summary}`);
  }
  mdLines.push("");
  mdLines.push("## Project Details");
  for (const project of artifact.projects) {
    mdLines.push(`### ${project.projectName}`);
    mdLines.push(`- Project Path: ${project.projectPath}`);
    mdLines.push(`- Config: ${project.configPath}`);
    mdLines.push(`- Notes: ${project.notesPath}`);
    if (project.inventory.sceneFiles.length > 0) {
      mdLines.push(`- Scene Files: ${project.inventory.sceneFiles.join(", ")}`);
    }
    if (project.config?.prompt != null) {
      mdLines.push("- Prompt Guidance:");
      mdLines.push(`  ${String(project.config.prompt).replace(/\s+/g, " ").trim().slice(0, 2_000)}`);
    }
    if (project.notesExcerpt) {
      mdLines.push("- Notes Excerpt:");
      mdLines.push("```md");
      mdLines.push(project.notesExcerpt);
      mdLines.push("```");
    }
    if (project.inventory.files.length > 0) {
      mdLines.push(`- Indexed Files (${project.inventory.files.length}): ${project.inventory.files.slice(0, 50).join(", ")}`);
    }
    mdLines.push("");
  }
  if (artifact.notes.length > 0) {
    mdLines.push("## Pipeline Notes");
    for (const line of artifact.notes) mdLines.push(`- ${line}`);
    mdLines.push("");
  }
  writeFileSync(markdownPath, `${mdLines.join("\n").trim()}\n`, "utf-8");

  const toVaultPath = (fullPath: string): string => {
    const rel = normalizeTrainingVaultMetadataPath(
      relative(coordinatorPlaybooksDir, fullPath).replace(/\\/g, "/"),
    );
    const withoutLearningPrefix = rel.replace(/^_learning\/?/i, "");
    return normalizeTrainingVaultMetadataPath(`learning/${withoutLearningPrefix}`);
  };
  const jsonVaultPath = toVaultPath(jsonPath);
  const markdownVaultPath = toVaultPath(markdownPath);
  const mirroredProjectFiles: Array<{
    fullPath: string;
    vaultPath: string;
    projectPath: string;
    sourcePath: string;
  }> = [];
  const remarks = parsePromptSummary(
    [
      artifact.objective ? `Objective: ${artifact.objective}` : "",
      ...artifact.summaries.slice(0, 3).map((item) => item.summary),
    ].filter(Boolean).join(" | "),
    1_100,
  );
  upsertTrainingVaultMetadata(settingsRepo, {
    path: jsonVaultPath,
    kind: "file",
    actor: metadataActor,
    projectPaths: artifact.projects.map((project) => project.projectPath),
    sourcePaths: artifact.sourcePaths,
    remarks,
  });
  upsertTrainingVaultMetadata(settingsRepo, {
    path: markdownVaultPath,
    kind: "file",
    actor: metadataActor,
    projectPaths: artifact.projects.map((project) => project.projectPath),
    sourcePaths: artifact.sourcePaths,
    remarks,
  });

  const safeSlug = (value: string, fallback: string): string => {
    const cleaned = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  };
  const mirrorProjectFile = (
    sourceFile: string,
    project: CoordinatorTrainingProjectDetail,
    relativeName: string,
    projectIndex: number,
  ): void => {
    if (!sourceFile || !existsSync(sourceFile)) return;
    let st;
    try {
      st = statSync(sourceFile);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (st.size > 2_000_000) return;
    let content = "";
    try {
      content = readFileSync(sourceFile, "utf-8");
    } catch {
      return;
    }
    if (!content.trim()) return;
    const projectSlug = safeSlug(
      `${projectIndex + 1}_${project.projectName || basename(project.projectPath)}`,
      `project_${projectIndex + 1}`,
    );
    const outDir = join(folder, "projects", projectSlug);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, relativeName);
    writeFileSync(outPath, content, "utf-8");
    const vaultPath = toVaultPath(outPath);
    upsertTrainingVaultMetadata(settingsRepo, {
      path: vaultPath,
      kind: "file",
      actor: metadataActor,
      projectPaths: [project.projectPath],
      sourcePaths: [project.sourcePath],
      remarks,
    });
    mirroredProjectFiles.push({
      fullPath: outPath,
      vaultPath,
      projectPath: project.projectPath,
      sourcePath: project.sourcePath,
    });
  };
  for (let i = 0; i < artifact.projects.length; i += 1) {
    const project = artifact.projects[i];
    mirrorProjectFile(project.configPath, project, PROJECT_CONFIG_FILES[0], i);
    mirrorProjectFile(project.notesPath, project, PROJECT_NOTES_FILES[0], i);
  }
  return {
    jsonPath,
    markdownPath,
    jsonVaultPath,
    markdownVaultPath,
    mirroredProjectFiles,
  };
}

export function buildTrainingCompletionFiles(
  result: {
    scriptUpdated: boolean;
    scriptPath: string;
    playbookUpdated: boolean;
    playbookPath: string;
  },
  artifactPaths: {
    jsonPath: string;
    markdownPath: string;
    mirroredProjectFiles?: Array<{ fullPath: string }>;
  },
): FileChange[] {
  const out: FileChange[] = [
    {
      path: artifactPaths.jsonPath,
      action: "modify",
      content: "Training artifact JSON persisted.",
    },
    {
      path: artifactPaths.markdownPath,
      action: "modify",
      content: "Training artifact markdown persisted.",
    },
  ];
  if (result.scriptUpdated) {
    out.push({
      path: result.scriptPath,
      action: "modify",
      content: "Coordinator training block updated.",
    });
  }
  if (result.playbookUpdated) {
    out.push({
      path: result.playbookPath,
      action: "modify",
      content: "Playbook training snapshot updated.",
    });
  }
  for (const file of artifactPaths.mirroredProjectFiles ?? []) {
    out.push({
      path: file.fullPath,
      action: "modify",
      content: "Mirrored project analysis artifact persisted to training vault.",
    });
  }
  return out;
}
