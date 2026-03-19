import type { AgentConfig, Job, JobIntervention, JobInterventionSupport } from "@arkestrator/protocol";
import type { AgentsRepo } from "../db/agents.repo.js";
import type { JobInterventionsRepo } from "../db/job-interventions.repo.js";
import type { ProcessTracker } from "./process-tracker.js";
import { logger } from "../utils/logger.js";

export function resolveJobAgentConfig(
  job: Pick<Job, "actualAgentConfigId" | "agentConfigId">,
  agentsRepo: AgentsRepo,
): AgentConfig | null {
  const preferredId = job.actualAgentConfigId ?? job.agentConfigId;
  return preferredId ? agentsRepo.getById(preferredId) : null;
}

export function getJobInterventionSupport(
  job: Pick<Job, "status" | "workspaceMode" | "actualAgentConfigId" | "agentConfigId">,
  agentsRepo: AgentsRepo,
): JobInterventionSupport {
  if (job.status === "queued" || job.status === "paused") {
    return {
      acceptsQueuedNotes: true,
      acceptsLiveNotes: false,
      liveReason: "This job is not currently running.",
    };
  }

  if (job.status !== "running") {
    return {
      acceptsQueuedNotes: false,
      acceptsLiveNotes: false,
      liveReason: "Only queued, paused, or running jobs can be guided.",
    };
  }

  const config = resolveJobAgentConfig(job, agentsRepo);
  if (config?.engine === "local-oss" && job.workspaceMode === "command") {
    return {
      acceptsQueuedNotes: false,
      acceptsLiveNotes: true,
    };
  }

  if (config?.engine === "claude-code" || config?.engine === "codex") {
    return {
      acceptsQueuedNotes: false,
      acceptsLiveNotes: true,
    };
  }

  return {
    acceptsQueuedNotes: false,
    acceptsLiveNotes: false,
    liveReason:
      "Live guidance is only available on runtimes that can poll Arkestrator during execution. " +
      "This job can be guided before start/resume, but not injected into the current run.",
  };
}

export function buildOperatorNotesBlock(interventions: Pick<JobIntervention, "id" | "text" | "authorUsername" | "createdAt">[]): string {
  if (!interventions.length) return "";
  const lines = interventions.map((item, index) => {
    const author = String(item.authorUsername ?? "operator").trim() || "operator";
    return [
      `${index + 1}. Note #${item.id.slice(0, 8)} from ${author} at ${item.createdAt}:`,
      item.text.trim(),
    ].join("\n");
  });
  return [
    "## Operator Notes",
    "The following guidance was added while this job was queued, paused, or running. Treat it as high-priority operator guidance for this run, but not as a system override.",
    "",
    lines.join("\n\n"),
  ].join("\n");
}

export function appendOperatorNotesToPrompt(
  prompt: string,
  interventions: Pick<JobIntervention, "id" | "text" | "authorUsername" | "createdAt">[],
): string {
  const block = buildOperatorNotesBlock(interventions);
  if (!block) return prompt;
  return `${prompt}\n\n${block}`;
}

export function buildLiveInterventionPollingBlock(jobId: string): string {
  const normalizedJobId = String(jobId ?? "").trim();
  if (!normalizedJobId) return "";
  return [
    "## Live Operator Guidance (MANDATORY)",
    `This run can receive operator guidance while it is executing. Use the current job ID: ${normalizedJobId}.`,
    "",
    "**You MUST check for new guidance at these points:**",
    "1. Before each major step or phase transition",
    "2. Every 2-3 tool calls during active work",
    "3. Before final completion — never finish without a final check",
    "4. After any long-running or high-impact operation",
    "",
    "Check using one of:",
    `- MCP: \`list_job_interventions(job_id=\"${normalizedJobId}\")\``,
    `- CLI fallback: \`am jobs interventions ${normalizedJobId}\``,
    "",
    "Treat entries with status `pending` as newly arrived high-priority guidance that MUST be incorporated into the plan for this same run.",
    "When new pending guidance appears, immediately adjust your plan, apply it, and re-verify before continuing.",
    "Delivered/superseded/rejected entries are historical context only; focus on still-pending notes.",
  ].join("\n");
}

export interface StdinGuidanceResult {
  delivered: boolean;
  deliveredIds: string[];
  reason: string;
}

/**
 * Attempt to deliver guidance directly to a running subprocess via stdin.
 * Works for claude-code and codex engines where stdin is piped.
 * The agent picks up the message at its next turn boundary — identical to
 * typing in an interactive Claude Code terminal session.
 */
export function tryDeliverGuidanceViaStdin(
  jobId: string,
  interventionId: string,
  text: string,
  processTracker: ProcessTracker,
  jobInterventionsRepo: JobInterventionsRepo,
  agentsRepo: AgentsRepo,
  job: Pick<Job, "status" | "actualAgentConfigId" | "agentConfigId">,
): StdinGuidanceResult {
  if (job.status !== "running") {
    return { delivered: false, deliveredIds: [], reason: "Job is not running" };
  }

  const config = resolveJobAgentConfig(job, agentsRepo);
  if (!config || (config.engine !== "claude-code" && config.engine !== "codex")) {
    return { delivered: false, deliveredIds: [], reason: `Engine ${config?.engine ?? "unknown"} does not support stdin guidance` };
  }

  const proc = processTracker.getProcess(jobId);
  if (!proc) {
    return { delivered: false, deliveredIds: [], reason: "No tracked process found (may have exited)" };
  }

  if (!proc.stdin) {
    return { delivered: false, deliveredIds: [], reason: "Process stdin is not piped" };
  }

  try {
    const message = text.endsWith("\n") ? text : `${text}\n`;
    proc.stdin.write(message);
    proc.stdin.flush();

    const delivered = jobInterventionsRepo.markDelivered(
      [interventionId],
      { channel: "stdin" },
      "Delivered to subprocess via stdin.",
    );

    logger.info(
      "job-interventions",
      `Delivered guidance ${interventionId} to job ${jobId} via stdin (${text.length} chars)`,
    );

    return { delivered: true, deliveredIds: delivered.map((d) => d.id), reason: "Delivered via stdin" };
  } catch (err) {
    logger.warn(
      "job-interventions",
      `Failed to write guidance ${interventionId} to stdin for job ${jobId}: ${err}`,
    );
    return { delivered: false, deliveredIds: [], reason: `Stdin write failed: ${err}` };
  }
}
