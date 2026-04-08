<script lang="ts">
  import { open } from "@tauri-apps/plugin-shell";
  import { getVersion } from "@tauri-apps/api/app";
  import { api } from "../../api/rest";
  import { jobs } from "../../stores/jobs.svelte";
  import type { Job } from "@arkestrator/protocol";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let description = $state("");
  let jobIdInput = $state("");
  let attachedJob = $state<Job | null>(null);
  let jobError = $state("");
  let jobLoading = $state(false);
  let opening = $state(false);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  async function attachJob() {
    const id = jobIdInput.trim().replace(/^#/, "");
    if (!id) return;
    jobError = "";
    jobLoading = true;
    try {
      const job = (await api.jobs.get(id)) as Job;
      attachedJob = job;
    } catch {
      jobError = "Could not find job with that ID.";
      attachedJob = null;
    } finally {
      jobLoading = false;
    }
  }

  function removeJob() {
    attachedJob = null;
    jobIdInput = "";
    jobError = "";
  }

  function getJobLogs(job: Job): string {
    // Try the in-memory store first (has live streamed logs), fall back to job.logs
    const storeLogs = jobs.getLogText(job.id);
    const logs = storeLogs || job.logs || "";
    // Truncate to last 200 lines
    const lines = logs.split("\n");
    if (lines.length > 200) {
      return `... (${lines.length - 200} lines truncated)\n` + lines.slice(-200).join("\n");
    }
    return logs;
  }

  async function openIssue() {
    opening = true;
    try {
      const appVersion = await getVersion();
      const os = navigator.platform || "Unknown";
      const userAgent = navigator.userAgent || "";

      let body = "";

      // Description
      body += `## Description\n${description.trim() || "_No description provided_"}\n\n`;
      body += `## Steps to Reproduce\n1. \n2. \n3. \n\n`;

      // System info
      body += `<details>\n<summary>System Info</summary>\n\n`;
      body += `- **App Version:** ${appVersion}\n`;
      body += `- **Platform:** ${os}\n`;
      body += `- **User Agent:** ${userAgent}\n`;
      body += `</details>\n`;

      // Attached job
      if (attachedJob) {
        const j = attachedJob;
        body += `\n<details>\n<summary>Job Report: #${j.id.slice(0, 8)}</summary>\n\n`;
        body += `- **Status:** ${j.status}\n`;
        body += `- **Mode:** ${j.mode}\n`;
        if (j.actualModel) body += `- **Model:** ${j.actualModel}\n`;
        if (j.workerName) body += `- **Worker:** ${j.workerName}\n`;
        if (j.error) body += `- **Error:** ${j.error}\n`;
        if (j.tokenUsage) {
          body += `- **Tokens:** ${j.tokenUsage.inputTokens} in / ${j.tokenUsage.outputTokens} out\n`;
          if (j.tokenUsage.durationMs) body += `- **Duration:** ${(j.tokenUsage.durationMs / 1000).toFixed(1)}s\n`;
        }
        if (j.usedBridges?.length) body += `- **Bridges:** ${j.usedBridges.join(", ")}\n`;

        const logs = getJobLogs(j);
        if (logs.trim()) {
          body += `\n<details>\n<summary>Logs (last 200 lines)</summary>\n\n\`\`\`\n${logs}\n\`\`\`\n</details>\n`;
        }
        body += `</details>\n`;
      }

      // GitHub has a URL limit (~8192 chars). If body is too long, truncate logs.
      const maxBodyLength = 6000;
      if (body.length > maxBodyLength) {
        // Rebuild without logs
        body = body.replace(/\n<details>\n<summary>Logs \(last 200 lines\)<\/summary>[\s\S]*?<\/details>\n/, "\n_Logs too large for URL — please paste manually._\n");
      }

      const title = description.trim()
        ? `Bug: ${description.trim().slice(0, 60)}${description.trim().length > 60 ? "..." : ""}`
        : "Bug Report";

      const url = `https://github.com/timvanhelsdingen/arkestrator/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

      try {
        await open(url);
      } catch {
        window.open(url, "_blank");
      }

      onclose();
    } finally {
      opening = false;
    }
  }

  function formatJobStatus(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onclose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <h3>Report a Bug</h3>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>

    <div class="dialog-body">
      <label class="field-label">
        What went wrong?
        <textarea
          placeholder="Describe the issue..."
          rows="4"
          bind:value={description}
        ></textarea>
      </label>

      <div class="job-section">
        <label class="field-label">Attach a Job (optional)</label>
        {#if attachedJob}
          <div class="attached-job">
            <div class="job-preview">
              <span class="job-id">#{attachedJob.id.slice(0, 8)}</span>
              <span class="job-status" class:failed={attachedJob.status === "failed"} class:completed={attachedJob.status === "completed"}>
                {formatJobStatus(attachedJob.status)}
              </span>
              {#if attachedJob.actualModel}
                <span class="job-meta">{attachedJob.actualModel}</span>
              {/if}
              {#if attachedJob.error}
                <span class="job-error">{attachedJob.error.slice(0, 100)}{attachedJob.error.length > 100 ? "..." : ""}</span>
              {/if}
            </div>
            <button class="btn-remove" onclick={removeJob}>&times;</button>
          </div>
        {:else}
          <div class="job-input-row">
            <input
              type="text"
              placeholder="Paste job ID..."
              bind:value={jobIdInput}
              onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); attachJob(); } }}
            />
            <button class="btn secondary" onclick={attachJob} disabled={jobLoading || !jobIdInput.trim()}>
              {jobLoading ? "Loading..." : "Attach"}
            </button>
          </div>
          {#if jobError}
            <span class="error-text">{jobError}</span>
          {/if}
        {/if}
      </div>

      <p class="info-note">System info (app version, OS) will be included automatically. No credentials or private data are sent.</p>
    </div>

    <div class="dialog-footer">
      <button class="btn secondary" onclick={onclose}>Cancel</button>
      <button class="btn" onclick={openIssue} disabled={opening}>
        {opening ? "Opening..." : "Open GitHub Issue"}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
  }
  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
  }
  .dialog-header h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin: 0;
  }
  .close-btn {
    background: none;
    border: none;
    font-size: 18px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .close-btn:hover {
    color: var(--text-primary);
  }
  .dialog-body {
    padding: 16px 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .dialog-footer {
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .field-label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    resize: vertical;
    font-family: inherit;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .job-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .job-input-row {
    display: flex;
    gap: 8px;
  }
  .job-input-row input {
    flex: 1;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
  }
  .job-input-row input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .attached-job {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
  }
  .job-preview {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
    font-size: var(--font-size-sm);
  }
  .job-id {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-primary);
  }
  .job-status {
    font-size: var(--font-size-xs);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
  .job-status.failed {
    background: color-mix(in srgb, var(--status-failed) 15%, transparent);
    color: var(--status-failed);
  }
  .job-status.completed {
    background: color-mix(in srgb, var(--status-completed) 15%, transparent);
    color: var(--status-completed);
  }
  .job-meta {
    font-size: var(--font-size-xs);
    color: var(--text-tertiary);
  }
  .job-error {
    width: 100%;
    font-size: var(--font-size-xs);
    color: var(--status-failed);
    line-height: 1.4;
  }
  .btn-remove {
    background: none;
    border: none;
    font-size: 16px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
    flex-shrink: 0;
  }
  .btn-remove:hover {
    color: var(--text-primary);
  }
  .error-text {
    font-size: var(--font-size-xs);
    color: var(--status-failed);
  }
  .info-note {
    font-size: var(--font-size-xs);
    color: var(--text-tertiary);
    line-height: 1.4;
    margin: 0;
  }
</style>
