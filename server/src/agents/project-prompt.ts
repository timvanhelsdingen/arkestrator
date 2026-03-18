import type { Project } from "../db/projects.repo.js";

/**
 * Formats a project's structured data into a text block for agent system prompt injection.
 * Returns null if the project has no meaningful content.
 */
export function formatProjectPrompt(project: Project | undefined): string | null {
  if (!project) return null;

  const sections: string[] = [];

  if (project.prompt?.trim()) {
    sections.push(project.prompt.trim());
  }

  if (project.pathMappings.length > 0) {
    const lines = ["## Path Mappings"];
    for (const mapping of project.pathMappings as any[]) {
      const entries = (mapping.entries ?? [])
        .map((e: any) => `${e.platform}: ${e.path}`)
        .join(" | ");
      if (entries) {
        lines.push(`- **${mapping.label || "Unnamed"}**: ${entries}`);
      }
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  if (project.folders.length > 0) {
    const lines = ["## Project Folders"];
    for (const folder of project.folders as any[]) {
      const desc = folder.description ? ` - ${folder.description}` : "";
      lines.push(`- ${folder.path}${desc}`);
    }
    sections.push(lines.join("\n"));
  }

  if (project.files.length > 0) {
    const lines = ["## Project Files"];
    for (const file of project.files as any[]) {
      const desc = file.description ? ` - ${file.description}` : "";
      lines.push(`- ${file.path}${desc}`);
    }
    sections.push(lines.join("\n"));
  }

  if (project.githubRepos.length > 0) {
    const lines = ["## GitHub Repositories"];
    for (const repo of project.githubRepos as any[]) {
      const branch = repo.branch ? ` (branch: ${repo.branch})` : "";
      const desc = repo.description ? ` - ${repo.description}` : "";
      lines.push(`- ${repo.url}${branch}${desc}`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;

  const body = sections.join("\n\n");
  return `<project context for "${project.name}">\n${body}\n</project>`;
}
