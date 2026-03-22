import { logger } from "../utils/logger.js";
import type { JobsRepo } from "../db/jobs.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import type { WebSocketHub } from "../ws/hub.js";

export interface HousekeepingDeps {
  jobsRepo: JobsRepo;
  skillsRepo: SkillsRepo;
  agentsRepo: AgentsRepo;
  settingsRepo: SettingsRepo;
  hub: WebSocketHub;
}

export interface HousekeepingSchedule {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
}

export function getHousekeepingSchedule(settingsRepo: SettingsRepo): HousekeepingSchedule {
  const raw = settingsRepo.get("housekeeping_schedule");
  if (!raw) return { enabled: false, intervalMinutes: 1440 }; // default: disabled, daily
  try {
    return JSON.parse(raw);
  } catch {
    return { enabled: false, intervalMinutes: 1440 };
  }
}

export function setHousekeepingSchedule(settingsRepo: SettingsRepo, schedule: HousekeepingSchedule): void {
  settingsRepo.set("housekeeping_schedule", JSON.stringify(schedule));
}

/**
 * Queue a housekeeping job. This spawns an AI agent that:
 * 1. Reviews recent job history (completed, failed, rated)
 * 2. Analyzes patterns across all bridges
 * 3. Suggests new skills or updates to existing ones
 * 4. Outputs a structured report
 */
export function queueHousekeepingJob(deps: HousekeepingDeps): { jobId: string } | null {
  // Find a suitable agent config (prefer claude-code, fall back to any)
  const agents = deps.agentsRepo.list();
  const agent = agents.find(a => a.engine === "claude-code") ?? agents[0];
  if (!agent) {
    logger.warn("housekeeping", "No agent config available for housekeeping job");
    return null;
  }

  // Gather job history summary
  const recentJobs = deps.jobsRepo.list(["completed", "failed", "cancelled"], 100);
  const jobSummary = buildJobSummary(recentJobs.jobs);

  // Gather current skills
  const skills = deps.skillsRepo.listAll();
  const skillsSummary = skills.map(s => `- [${s.category}] ${s.slug} (${s.program}): ${s.title}`).join("\n");

  // Build the housekeeping prompt
  const prompt = buildHousekeepingPrompt(jobSummary, skillsSummary, skills.length);

  // Create the job
  const job = deps.jobsRepo.create(
    {
      prompt,
      agentConfigId: agent.id,
      priority: "low",
      name: `[Housekeeping] System Review`,
      editorContext: {
        metadata: {
          housekeeping: true,
          trigger: "manual",
        },
      },
      files: [],
      contextItems: [],
    },
  );

  // Update last run timestamp
  const schedule = getHousekeepingSchedule(deps.settingsRepo);
  schedule.lastRunAt = new Date().toISOString();
  setHousekeepingSchedule(deps.settingsRepo, schedule);

  logger.info("housekeeping", `Queued housekeeping job: ${job.id}`);
  return { jobId: job.id };
}

function buildJobSummary(jobs: any[]): string {
  if (jobs.length === 0) return "No recent jobs found.";

  const byStatus: Record<string, number> = {};
  const byBridge: Record<string, { total: number; failed: number; positive: number; negative: number }> = {};
  const failures: Array<{ bridge: string; error: string; prompt: string }> = [];
  const positiveJobs: Array<{ bridge: string; prompt: string; notes?: string }> = [];

  for (const job of jobs) {
    // Count by status
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;

    // Count by bridge
    const bridge = job.bridgeProgram || job.usedBridges?.[0] || "unknown";
    if (!byBridge[bridge]) byBridge[bridge] = { total: 0, failed: 0, positive: 0, negative: 0 };
    byBridge[bridge].total++;
    if (job.status === "failed") {
      byBridge[bridge].failed++;
      if (job.error) failures.push({ bridge, error: job.error.slice(0, 200), prompt: (job.prompt || "").slice(0, 100) });
    }
    if (job.outcomeRating === "positive") {
      byBridge[bridge].positive++;
      positiveJobs.push({ bridge, prompt: (job.prompt || "").slice(0, 100), notes: job.outcomeNotes });
    }
    if (job.outcomeRating === "negative") byBridge[bridge].negative++;
  }

  let summary = `## Job History Summary (last ${jobs.length} jobs)\n\n`;
  summary += `### By Status\n`;
  for (const [status, count] of Object.entries(byStatus)) {
    summary += `- ${status}: ${count}\n`;
  }

  summary += `\n### By Bridge\n`;
  for (const [bridge, stats] of Object.entries(byBridge)) {
    const failRate = stats.total > 0 ? Math.round((stats.failed / stats.total) * 100) : 0;
    summary += `- **${bridge}**: ${stats.total} jobs, ${stats.failed} failed (${failRate}%), ${stats.positive} positive, ${stats.negative} negative\n`;
  }

  if (failures.length > 0) {
    summary += `\n### Recent Failures (${failures.length})\n`;
    for (const f of failures.slice(0, 10)) {
      summary += `- [${f.bridge}] "${f.prompt}..." → ${f.error}\n`;
    }
  }

  if (positiveJobs.length > 0) {
    summary += `\n### Positively Rated Jobs (${positiveJobs.length})\n`;
    for (const j of positiveJobs.slice(0, 10)) {
      summary += `- [${j.bridge}] "${j.prompt}..."${j.notes ? ` (notes: ${j.notes})` : ""}\n`;
    }
  }

  return summary;
}

function buildHousekeepingPrompt(jobSummary: string, skillsSummary: string, skillCount: number): string {
  return `You are the Arkestrator Housekeeping Agent — a system-level manager that reviews all recent work and improves the system.

## Your Role
You are NOT executing a task for a user. You are reviewing the performance of the AI agent system and making adjustments to improve future operations. Think of yourself as a team manager reviewing your team's work and updating their playbooks.

## Current System State

### Current Skills (${skillCount} total)
${skillsSummary || "No skills loaded yet."}

${jobSummary}

## Your Tasks

1. **Analyze Patterns**: Look at the job history above. Identify:
   - Common failure patterns — what keeps going wrong?
   - Success patterns — what techniques work well?
   - Bridge-specific issues — any bridge with unusually high failure rates?
   - Missing knowledge — areas where skills could help prevent failures?

2. **Generate Skill Recommendations**: For each pattern you identify, create a skill suggestion using this EXACT format:

\`\`\`skill
slug: descriptive-slug-name
program: bridge-name-or-global
category: training|verification|playbook|bridge
title: Short descriptive title
---
The skill content here. Be specific and actionable.
Include concrete code patterns, API calls, or verification steps.
\`\`\`

3. **Write a Report**: After your analysis, write a brief summary of:
   - Key findings
   - Skills created/suggested
   - Recommendations for the system operator

## Guidelines
- Only create skills that address REAL patterns from the job data above
- If there are no clear patterns, say so — don't generate useless skills
- Focus on ACTIONABLE instructions, not vague advice
- Use "global" program for skills that apply across all bridges
- Keep each skill focused on ONE specific pattern or technique
- If a skill already exists that covers a pattern, don't duplicate it`;
}

/**
 * Scheduled housekeeping tick — runs periodically to check if housekeeping is due.
 */
export function runHousekeepingScheduleTick(deps: HousekeepingDeps): { jobId: string } | null {
  const schedule = getHousekeepingSchedule(deps.settingsRepo);
  if (!schedule.enabled) return null;

  const now = Date.now();
  const lastMs = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : 0;
  const dueMs = Number.isFinite(lastMs) ? lastMs + schedule.intervalMinutes * 60_000 : 0;

  if (Number.isFinite(lastMs) && now < dueMs) return null;

  // Check if a housekeeping job is already running
  const running = deps.jobsRepo.list(["queued", "running"]).jobs;
  const hasRunning = running.some(j => {
    const meta = j.editorContext?.metadata as any;
    return meta?.housekeeping === true;
  });
  if (hasRunning) return null;

  return queueHousekeepingJob(deps);
}

/**
 * Parse housekeeping job output to extract skill suggestions and create them.
 */
export function processHousekeepingOutput(
  output: string,
  skillsRepo: SkillsRepo,
  program?: string,
): { created: number; updated: number } {
  const skillBlocks = output.match(/```skill\n([\s\S]*?)```/g) || [];
  let created = 0;
  let updated = 0;

  for (const block of skillBlocks) {
    const content = block.replace(/```skill\n/, "").replace(/```$/, "").trim();
    const frontmatterEnd = content.indexOf("---");
    if (frontmatterEnd === -1) continue;

    const frontmatter = content.slice(0, frontmatterEnd).trim();
    const body = content.slice(frontmatterEnd + 3).trim();

    // Parse frontmatter
    const props: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      props[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }

    if (!props.slug || !body) continue;

    const slug = props.slug;
    const skillProgram = props.program || program || "global";
    const category = props.category || "training";
    const title = props.title || slug;

    try {
      const existing = skillsRepo.get(slug, skillProgram);
      if (existing) {
        skillsRepo.update(slug, { content: body, title }, skillProgram);
        updated++;
      } else {
        skillsRepo.create({
          name: title,
          slug,
          program: skillProgram,
          category,
          title,
          description: `Auto-generated by housekeeping agent`,
          content: body,
          source: "housekeeping",
        });
        created++;
      }
    } catch (err) {
      logger.warn("housekeeping", `Failed to save skill ${slug}: ${err}`);
    }
  }

  return { created, updated };
}
