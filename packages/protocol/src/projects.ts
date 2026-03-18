import { z } from "zod";

// --- Workspace Mode ---

export const WorkspaceMode = z.enum(["command", "repo", "sync"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

// --- Command Result ---

export const CommandResult = z.object({
  /** The scripting language: "python", "gdscript", "javascript", etc. */
  language: z.string(),
  /** The script content to execute */
  script: z.string(),
  /** Optional description of what the script does */
  description: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

// --- Project Structured Data ---

export const PathMappingEntry = z.object({
  platform: z.string(),
  path: z.string(),
});
export type PathMappingEntry = z.infer<typeof PathMappingEntry>;

export const PathMapping = z.object({
  label: z.string(),
  entries: z.array(PathMappingEntry),
});
export type PathMapping = z.infer<typeof PathMapping>;

export const ProjectFolder = z.object({
  path: z.string(),
  description: z.string().optional(),
});
export type ProjectFolder = z.infer<typeof ProjectFolder>;

export const ProjectFile = z.object({
  path: z.string(),
  description: z.string().optional(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

export const GitHubRepo = z.object({
  url: z.string(),
  branch: z.string().optional(),
  description: z.string().optional(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

// --- Project ---

export const Project = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Per-project instructions injected into the agent's system prompt */
  prompt: z.string().optional(),
  /** Cross-platform path equivalences */
  pathMappings: z.array(PathMapping).default([]),
  /** Relevant project folders */
  folders: z.array(ProjectFolder).default([]),
  /** Relevant project files */
  files: z.array(ProjectFile).default([]),
  /** Linked GitHub repositories */
  githubRepos: z.array(GitHubRepo).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof Project>;

export const ProjectCreate = Project.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;
