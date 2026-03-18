<script lang="ts">
  import { chatStore, type ChatMessage } from "../../stores/chat.svelte";
  import { jobs } from "../../stores/jobs.svelte";
  import Badge from "../ui/Badge.svelte";
  import { timeAgo } from "../../utils/format";

  let { messages, jobIds }: { messages: ChatMessage[]; jobIds: string[] } = $props();

  // Subscribe to stream version for cheap re-renders during chat streaming
  let _streamVersion = $derived(chatStore.streamVersion);
  // Subscribe to log version so outer container auto-scrolls on new log lines
  let _logVersion = $derived(jobs.logVersion);

  let container: HTMLDivElement | undefined = $state();
  let isNearBottom = $state(true);

  function onScroll() {
    if (!container) return;
    const threshold = 100;
    isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  // Auto-scroll outer container on new messages AND new log lines
  $effect(() => {
    // Read reactive deps
    void messages.length;
    void _streamVersion;
    void _logVersion;
    if (container && isNearBottom) {
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight;
      });
    }
  });

  /** Svelte action: auto-scroll a <pre> element to the bottom when its content changes */
  function autoscroll(node: HTMLElement) {
    const observer = new MutationObserver(() => {
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    // Initial scroll
    node.scrollTop = node.scrollHeight;
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  function getJob(jobId: string) {
    return jobs.all.find((j) => j.id === jobId);
  }

  function getJobLogs(jobId: string): string {
    return jobs.getLogText(jobId);
  }

  // Show a pulsing "Working..." indicator when any tracked job is still active
  let hasActiveJob = $derived(
    jobIds.some((id) => {
      const j = jobs.all.find((j) => j.id === id);
      return j && (j.status === "running" || j.status === "queued");
    }),
  );
</script>

<div class="message-list" bind:this={container} onscroll={onScroll}>
  {#if messages.length === 0}
    <div class="empty-state">
      <div class="empty-title">Start a conversation</div>
      <div class="empty-hint">
        Type a prompt below to submit a job to an AI agent.<br />
        Connect bridges for editor context and multi-step workflows.
      </div>
    </div>
  {:else}
    {#each messages as msg (msg.id)}
      {#if msg.role === "system"}
        <!-- System messages: compact info lines for job status, split notifications -->
        <div class="system-line">
          <div class="system-content">
            <span class="system-text">{msg.content}</span>
            {#if msg.jobId}
              {@const job = getJob(msg.jobId)}
              {#if job}
                <div class="job-status-row">
                  <Badge text={job.status} variant={job.status} />
                  {#if job.usedBridges?.length}
                    {#each job.usedBridges as prog}
                      <span class="source-badge source-{prog}">{prog}</span>
                    {/each}
                  {/if}
                  {#if job.tokenUsage}
                    <span class="token-info">
                      {job.tokenUsage.inputTokens.toLocaleString()} in /
                      {job.tokenUsage.outputTokens.toLocaleString()} out
                      ({(job.tokenUsage.durationMs / 1000).toFixed(1)}s)
                    </span>
                  {/if}
                  {#if job.result && job.result.length > 0}
                    <span class="change-info">{job.result.length} file change{job.result.length !== 1 ? "s" : ""}</span>
                  {/if}
                  {#if job.commands && job.commands.length > 0}
                    <span class="change-info">{job.commands.length} command{job.commands.length !== 1 ? "s" : ""}</span>
                  {/if}
                </div>
                {#if job.status === "running"}
                  {@const logText = getJobLogs(job.id)}
                  {#if logText}
                    <pre class="log-stream" use:autoscroll>{logText}</pre>
                  {:else}
                    <span class="thinking">Working...</span>
                  {/if}
                {/if}
                {#if job.status === "completed" || job.status === "failed"}
                  {@const logText = getJobLogs(job.id) || job.logs}
                  {#if logText}
                    {@const lines = logText.split("\n")}
                    {@const tailLines = lines.slice(-10)}
                    <pre class="log-stream log-tail">{tailLines.join("\n")}</pre>
                    {#if lines.length > 10}
                      <details class="log-details">
                        <summary>Full output ({lines.length} lines)</summary>
                        <pre class="log-stream">{logText}</pre>
                      </details>
                    {/if}
                  {/if}
                  {#if job.error}
                    <div class="job-error">Error: {job.error}</div>
                  {/if}
                {/if}
              {/if}
            {/if}
          </div>
          <span class="system-time">{timeAgo(msg.timestamp)}</span>
        </div>
      {:else}
        <!-- User and assistant messages: full cards -->
        <div class="message message-{msg.role}">
          <div class="message-header">
            <span class="message-role">{msg.role === "user" ? "You" : "Assistant"}</span>
            <span class="message-time">{timeAgo(msg.timestamp)}</span>
          </div>
          <div class="message-content">
            {#if msg.role === "user"}
              <pre class="user-prompt">{msg.content}</pre>
            {:else}
              {#if !msg.content}
                <span class="thinking">Thinking...</span>
              {:else}
                <pre class="assistant-text">{msg.content}</pre>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    {/each}
    {#if hasActiveJob}
      <div class="thinking-row">
        <span class="thinking">Working...</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .message-list {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    gap: 8px;
  }
  .empty-title {
    font-size: var(--font-size-lg);
    color: var(--text-secondary);
  }
  .empty-hint {
    font-size: var(--font-size-sm);
    text-align: center;
    line-height: 1.5;
  }

  /* User & assistant message cards */
  .message {
    padding: 10px 12px;
    border-radius: var(--radius-md);
  }
  .message-user {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
  }
  .message-assistant {
    background: var(--bg-surface);
    border-left: 3px solid var(--accent);
  }
  .message-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .message-role {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .message-time {
    font-size: 11px;
    color: var(--text-muted);
  }
  .message-content {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .user-prompt {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-sans);
    font-size: var(--font-size-sm);
    margin: 0;
  }
  .assistant-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-sans);
    font-size: var(--font-size-sm);
    margin: 0;
    line-height: 1.5;
  }
  .thinking {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-style: italic;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* System info lines — compact, no card */
  .system-line {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 12px;
  }
  .system-content {
    flex: 1;
    min-width: 0;
  }
  .system-text {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    font-style: italic;
  }
  .system-time {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 2px;
  }

  /* Job status within system lines */
  .job-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: var(--font-size-sm);
  }
  .source-badge {
    display: inline-flex;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: capitalize;
  }
  .source-godot { background: #478cbf22; color: #478cbf; }
  .source-blender { background: #ea722022; color: #ea7220; }
  .source-houdini { background: #ff450022; color: #ff4500; }
  .token-info, .change-info {
    font-size: 11px;
    color: var(--text-muted);
  }
  .log-stream {
    background: var(--bg-base);
    padding: 8px;
    border-radius: var(--radius-sm);
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
    color: var(--text-secondary);
  }
  .log-tail {
    border-left: 2px solid var(--text-muted);
    opacity: 0.85;
  }
  .log-details {
    margin-top: 4px;
  }
  .log-details summary {
    font-size: var(--font-size-sm);
    color: var(--accent);
    cursor: pointer;
    user-select: none;
  }
  .log-details summary:hover {
    text-decoration: underline;
  }
  .job-error {
    color: var(--status-failed);
    font-size: var(--font-size-sm);
    margin-top: 6px;
  }
  .thinking-row {
    padding: 4px 12px;
  }
</style>
