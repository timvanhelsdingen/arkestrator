<script lang="ts">
  import type { JobRuntimeOptions } from "@arkestrator/protocol";
  import { onMount } from "svelte";
  import { chatStore, type ChatMessage, type ChatProjectSelection } from "../lib/stores/chat.svelte";
  import { bridgeContextStore } from "../lib/stores/bridgeContext.svelte";
  import { connection } from "../lib/stores/connection.svelte";
  import { clientCoordination } from "../lib/stores/clientCoordination.svelte";
  import { workersStore } from "../lib/stores/workers.svelte";
  import { api } from "../lib/api/rest";
  import { toast } from "../lib/stores/toast.svelte";
  import ChatTabBar from "../lib/components/chat/ChatTabBar.svelte";
  import ChatMessageList from "../lib/components/chat/ChatMessageList.svelte";
  import ChatInput from "../lib/components/chat/ChatInput.svelte";
  import ChatContextPanel from "../lib/components/chat/ChatContextPanel.svelte";
  import ChatJobConfig from "../lib/components/chat/ChatJobConfig.svelte";

  const CLIENT_PROMPT_OVERRIDES_STORAGE_KEY = "arkestrator-coordinator-client-prompt-overrides-v1";
  const JOB_CHAT_CONTEXT_MESSAGE_LIMIT = 6;
  const JOB_CHAT_CONTEXT_CHAR_LIMIT = 700;

  let tab = $derived(chatStore.activeTab);
  let chatStreaming = $state(false);

  // Resizable sidebar
  let sidebarWidth = $state(280);
  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      sidebarWidth = Math.max(200, Math.min(500, startW - (ev.clientX - startX)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function handleChat(prompt: string, resolvedRuntimeOptions?: JobRuntimeOptions) {
    if (!tab || !prompt.trim()) return;

    if (!connection.isAuthenticated && !connection.apiKey) {
      toast.error("Log in or connect with an API key to chat");
      return;
    }

    if (!tab.agentConfigId) {
      toast.error("Please select an agent to chat");
      return;
    }

    // Build history from existing messages BEFORE adding the new ones
    const history = tab.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-20)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    chatStore.addMessage(userMsg);
    chatStore.setDraftPrompt("");

    // Don't add the assistant message yet — show the thinking indicator first.
    // The message card only appears once the first text chunk arrives.
    const responseMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    let responseMsgAdded = false;
    chatStreaming = true;

    const appendAssistantChunk = (text: string) => {
      if (!text) return;
      const currentTab = chatStore.activeTab;
      if (!currentTab) return;
      if (!responseMsgAdded) {
        chatStore.addMessage(responseMsg);
        responseMsgAdded = true;
      }
      const msg = currentTab.messages.find((m) => m.id === responseMsg.id);
      if (!msg) return;
      msg.content += text;
      chatStore.streamVersion++;
    };

    try {
      await api.chat.stream(
        {
          prompt,
          agentConfigId: tab.agentConfigId,
          history,
          conversationKey: tab.conversationKey,
          runtimeOptions: resolvedRuntimeOptions ?? tab.runtimeOptions,
          jobIds: tab.jobIds.slice(-20),
        },
        (chunk) => {
          appendAssistantChunk(chunk);
        },
      );
    } catch (err: any) {
      toast.error(`Chat error: ${err.message}`);
      const currentTab = chatStore.activeTab;
      if (currentTab) {
        if (!responseMsgAdded) {
          chatStore.addMessage(responseMsg);
          responseMsgAdded = true;
        }
        const msg = currentTab.messages.find((m) => m.id === responseMsg.id);
        if (msg && !msg.content) {
          msg.content = `Error: ${err.message}`;
          chatStore.tabs = [...chatStore.tabs];
        }
      }
    } finally {
      chatStreaming = false;
    }
  }

  function readClientBridgePromptOverrides(programs: string[]): {
    global: string;
    byProgram: Record<string, string>;
  } {
    const outByProgram: Record<string, string> = {};
    let global = "";

    try {
      const raw = localStorage.getItem(CLIENT_PROMPT_OVERRIDES_STORAGE_KEY);
      if (!raw) return { global: "", byProgram: {} };
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      global = String(parsed?.global ?? "").trim();
      const byProgramRaw = parsed?.byProgram;
      if (!byProgramRaw || typeof byProgramRaw !== "object" || Array.isArray(byProgramRaw)) {
        return { global, byProgram: {} };
      }

      for (const program of programs.map((p) => String(p ?? "").trim().toLowerCase()).filter(Boolean)) {
        const value = String((byProgramRaw as Record<string, unknown>)[program] ?? "").trim();
        if (!value) continue;
        outByProgram[program] = value;
      }
    } catch {
      return { global: "", byProgram: {} };
    }

    return { global, byProgram: outByProgram };
  }

  function resolveTargetBridgeIds(targetWorkerNames: string[]): string[] {
    if (targetWorkerNames.length === 0) {
      return [...bridgeContextStore.bridges.keys()];
    }

    const targetWorkers = new Set(
      targetWorkerNames.map((name) => String(name ?? "").trim().toLowerCase()).filter(Boolean),
    );

    const bridgeWorkers = new Map(
      workersStore.bridges.map((bridge) => [bridge.id, String(bridge.workerName ?? "").trim().toLowerCase()]),
    );

    return [...bridgeContextStore.bridges.keys()]
      .filter((bridgeId) => {
        const workerName = bridgeWorkers.get(bridgeId) ?? "";
        return workerName.length > 0 && targetWorkers.has(workerName);
      })
      .map((bridgeId) => bridgeId);
  }

  function resolveTargetPrograms(targetWorkerNames: string[], bridgeIds: string[]): string[] {
    const programs = new Set<string>();

    for (const bridgeId of bridgeIds) {
      const program = bridgeContextStore.bridges.get(bridgeId)?.program;
      if (program?.trim()) programs.add(program.trim());
    }

    if (targetWorkerNames.length > 0) {
      const targetWorkers = new Set(
        targetWorkerNames.map((name) => String(name ?? "").trim().toLowerCase()).filter(Boolean),
      );
      for (const worker of workersStore.workers) {
        const workerName = String(worker.name ?? "").trim().toLowerCase();
        if (!workerName || !targetWorkers.has(workerName)) continue;
        for (const program of worker.knownPrograms ?? []) {
          const trimmed = String(program ?? "").trim();
          if (trimmed) programs.add(trimmed);
        }
      }
    }

    return [...programs];
  }

  function truncateChatContext(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= JOB_CHAT_CONTEXT_CHAR_LIMIT) return normalized;
    return `${normalized.slice(0, JOB_CHAT_CONTEXT_CHAR_LIMIT - 3).trimEnd()}...`;
  }

  function buildJobPromptWithChatContext(prompt: string, messages: ChatMessage[]): string {
    const priorUserMessages = messages
      .filter((message) => message.role === "user" && !message.jobId)
      .map((message) => truncateChatContext(message.content))
      .filter(Boolean)
      .slice(-JOB_CHAT_CONTEXT_MESSAGE_LIMIT);

    if (priorUserMessages.length === 0) return prompt;

    return [
      "## Prior User Chat Context",
      "Treat these earlier user chat messages from this tab as soft planning guidance and constraints for this job.",
      "If anything conflicts, the current job request below takes precedence.",
      "",
      ...priorUserMessages.map((message, index) => `${index + 1}. ${message}`),
      "",
      "## Current Job Request",
      prompt,
    ].join("\n");
  }

  /** Build job payload from selected workers — gathers context from live bridges on those workers */
  function buildJobPayload(
    prompt: string,
    targetWorkerNames: string[],
    bridgeIds: string[],
    opts: {
      agentConfigId: string;
      priority: string;
      startPaused: boolean;
      coordinationMode: "server" | "client";
      projectSelection: ChatProjectSelection;
      projectId?: string;
      dependsOn?: string[];
      runtimeOptions?: JobRuntimeOptions;
      jobName?: string;
      uploadedFiles?: Array<{ path: string; content: string }>;
    },
  ) {
    let editorContext: any = undefined;
    let files: any[] = [];
    let contextItems: any[] = [];

    for (const bridgeId of bridgeIds) {
      const entry = bridgeContextStore.bridges.get(bridgeId);
      if (!entry) continue;

      if (!editorContext && entry.editorContext) {
        editorContext = {
          ...entry.editorContext,
          metadata: {
            ...entry.editorContext.metadata,
            source_bridge: entry.bridgeName,
          },
        };
      }

      files.push(...entry.files);
      contextItems.push(...bridgeContextStore.getItemsForJob(bridgeId));
    }

    // Include user-uploaded files (images, text) from chat attachments
    if (opts.uploadedFiles?.length) {
      files.push(...opts.uploadedFiles);
    }

    const uniquePrograms = resolveTargetPrograms(targetWorkerNames, bridgeIds);
    const clientPromptOverrides = readClientBridgePromptOverrides(uniquePrograms);
    const selectedProjectId =
      opts.projectSelection === "project" && typeof opts.projectId === "string" && opts.projectId.trim()
        ? opts.projectId
        : undefined;
    const hasExplicitWorkerTarget = targetWorkerNames.length > 0;
    const needsMetadataCarrier =
      hasExplicitWorkerTarget
      || Boolean(clientPromptOverrides.global)
      || Object.keys(clientPromptOverrides.byProgram).length > 0;

    if (!editorContext && needsMetadataCarrier) {
      editorContext = { projectRoot: "", metadata: {} };
    }

    if (editorContext) {
      editorContext.metadata = {
        ...editorContext.metadata,
        project_selection: opts.projectSelection,
        ...(hasExplicitWorkerTarget
          ? {
              target_workers: targetWorkerNames,
              worker_count: targetWorkerNames.length,
            }
          : {}),
        ...(uniquePrograms.length > 0
          ? {
              available_programs: uniquePrograms,
              available_program_count: uniquePrograms.length,
            }
          : {}),
        ...(clientPromptOverrides.global
          ? { coordinator_client_prompt_override_global: clientPromptOverrides.global }
          : {}),
        ...(Object.keys(clientPromptOverrides.byProgram).length > 0
          ? { coordinator_client_prompt_overrides_by_program: clientPromptOverrides.byProgram }
          : {}),
      };
    }

    return {
      prompt,
      agentConfigId: opts.agentConfigId,
      priority: opts.priority,
      startPaused: opts.startPaused,
      coordinationMode: opts.coordinationMode,
      ...(targetWorkerNames.length === 1 ? { targetWorkerName: targetWorkerNames[0] } : {}),
      ...(opts.coordinationMode === "client" && clientCoordination.capability
        ? { clientCoordinationCapability: clientCoordination.capability }
        : {}),
      ...(editorContext ? { editorContext } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(contextItems.length > 0 ? { contextItems } : {}),
      ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
      ...(opts.runtimeOptions ? { runtimeOptions: opts.runtimeOptions } : {}),
      ...(opts.jobName ? { name: opts.jobName } : {}),
    };
  }

  async function handleSubmit(prompt: string, resolvedRuntimeOptions?: JobRuntimeOptions, files?: Array<{ path: string; content: string }>) {
    if (!tab || !prompt.trim()) return;

    if (!connection.isAuthenticated && !connection.apiKey) {
      toast.error("Log in or connect with an API key to submit jobs");
      return;
    }

    if (!tab.agentConfigId) {
      toast.error("Please select an agent configuration");
      return;
    }

    const promptWithChatContext = buildJobPromptWithChatContext(prompt, tab.messages);

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    chatStore.addMessage(userMsg);

    const selectedWorkers = tab.selectedWorkerNames;
    const selectedBridges = resolveTargetBridgeIds(selectedWorkers);

    const clientCoordinationRequested =
      connection.allowClientCoordination && connection.clientCoordinationEnabled;

    if (
      clientCoordinationRequested
      && !clientCoordination.probing
      && (clientCoordination.isProbeStale() || !clientCoordination.capability)
    ) {
      try {
        await clientCoordination.probe();
      } catch {
        // Gracefully fall back to server coordination below
      }
    }

    const coordinationMode: "server" | "client" =
      clientCoordinationRequested && clientCoordination.isCapable ? "client" : "server";

    if (clientCoordinationRequested && coordinationMode === "server") {
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "Client-side coordination requested but local capability check failed. Falling back to server coordination.",
        timestamp: new Date().toISOString(),
      });
    }

    const payload = buildJobPayload(promptWithChatContext, selectedWorkers, selectedBridges, {
      agentConfigId: tab.agentConfigId,
      priority: tab.priority,
      startPaused: tab.startPaused,
      coordinationMode,
      projectSelection: tab.projectSelection,
      projectId: tab.projectId,
      runtimeOptions: resolvedRuntimeOptions ?? tab.runtimeOptions,
      jobName: tab.jobName,
      uploadedFiles: files,
      ...(tab.dependsOnJobId ? { dependsOn: [tab.dependsOnJobId] } : {}),
    });

    try {
      const job = await api.jobs.create(payload);
      chatStore.linkMessageToJob(userMsg.id, job.id);
      chatStore.trackJob(job.id);
      chatStore.setJobName(""); // Clear job name after submission
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Job submitted (#${job.id.slice(0, 8)}) \u2014 ${job.status}`,
        timestamp: new Date().toISOString(),
        jobId: job.id,
      });
    } catch (err: any) {
      toast.error(`Failed to submit job: ${err.message}`);
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Failed to submit: ${err.message}`,
        timestamp: new Date().toISOString(),
      });
    }

    chatStore.setDraftPrompt("");
  }

  /** Submit a job proposed by the chat agent via :::job-proposal block */
  async function submitProposedJob(prompt: string, bridges: string[]) {
    if (!tab || !prompt.trim()) return;

    if (!connection.isAuthenticated && !connection.apiKey) {
      toast.error("Log in or connect with an API key to submit jobs");
      return;
    }

    if (!tab.agentConfigId) {
      toast.error("Please select an agent configuration");
      return;
    }

    // Build a minimal job payload using the proposed prompt
    const coordinationMode: "server" | "client" =
      connection.allowClientCoordination && connection.clientCoordinationEnabled
      && clientCoordination.isCapable ? "client" : "server";

    const payload = buildJobPayload(prompt, [], [], {
      agentConfigId: tab.agentConfigId,
      priority: tab.priority,
      startPaused: false, // Agent-proposed jobs start immediately
      coordinationMode,
      projectSelection: tab.projectSelection,
      projectId: tab.projectId,
      runtimeOptions: tab.runtimeOptions,
    });

    // If bridges were specified, add them as metadata hint
    if (bridges.length > 0 && payload.contextItems === undefined) {
      // The bridge targeting is handled by the spawner based on connected bridges
    }

    try {
      const job = await api.jobs.create(payload);
      chatStore.trackJob(job.id);
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Job submitted (#${job.id.slice(0, 8)}) \u2014 ${job.status}`,
        timestamp: new Date().toISOString(),
        jobId: job.id,
      });
    } catch (err: any) {
      toast.error(`Failed to submit job: ${err.message}`);
      chatStore.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Failed to submit: ${err.message}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Auto-report job results in chat when a tracked job completes */
  async function reportJobCompletion(job: any) {
    const currentTab = chatStore.activeTab;
    if (!currentTab || !currentTab.agentConfigId) return;
    if (chatStreaming) return; // Don't interrupt active chat

    const label = job.name ?? `#${job.id.slice(0, 8)}`;
    const fileChanges = Array.isArray(job.result) ? job.result.length : 0;
    const commands = Array.isArray(job.commands) ? job.commands.length : 0;
    const errorText = job.error ? `Error: ${job.error}` : "No errors.";

    const summary = [
      `[JOB ${job.status.toUpperCase()}] Job ${label} just finished.`,
      `Status: ${job.status}.`,
      fileChanges > 0 ? `${fileChanges} file change${fileChanges !== 1 ? "s" : ""}.` : "No file changes.",
      commands > 0 ? `${commands} command${commands !== 1 ? "s" : ""} ran.` : "",
      errorText,
      "Briefly tell the user what was accomplished or what went wrong.",
    ].filter(Boolean).join(" ");

    chatStreaming = true;
    const responseMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    let responseMsgAdded = false;

    try {
      await api.chat.stream(
        {
          prompt: summary,
          agentConfigId: currentTab.agentConfigId,
          conversationKey: currentTab.conversationKey,
          runtimeOptions: currentTab.runtimeOptions,
          jobIds: currentTab.jobIds.slice(-20),
        },
        (chunk) => {
          if (!chunk) return;
          if (!responseMsgAdded) {
            chatStore.addMessage(responseMsg);
            responseMsgAdded = true;
          }
          const msg = currentTab.messages.find((m) => m.id === responseMsg.id);
          if (msg) {
            msg.content += chunk;
            chatStore.streamVersion++;
          }
        },
      );
    } catch {
      // Silently fail — the system message already shows the status
    } finally {
      chatStreaming = false;
    }
  }

  onMount(() => {
    function onJobCompleted(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.job && detail?.tabId === chatStore.activeTab?.id) {
        reportJobCompletion(detail.job);
      }
    }
    window.addEventListener("arkestrator:job-completed", onJobCompleted);
    return () => window.removeEventListener("arkestrator:job-completed", onJobCompleted);
  });

  let hasMessages = $derived((tab?.messages.length ?? 0) > 0);
</script>

<div class="chat-page">
  <ChatTabBar />
  <div class="chat-body">
    <div class="chat-main">
      {#if tab}
        <ChatMessageList messages={tab.messages} jobIds={tab.jobIds} streaming={chatStreaming} onSubmitJob={submitProposedJob} />
        {#if hasMessages}
          <div class="clear-bar">
            <button class="btn-clear" onclick={() => chatStore.clearChat()} title="Clear chat messages">
              Clear chat
            </button>
          </div>
        {/if}
        <ChatInput
          draftPrompt={tab.draftPrompt}
          agentConfigId={tab.agentConfigId}
          priority={tab.priority}
          selectedWorkerNames={tab.selectedWorkerNames}
          dependencyJobId={tab.dependsOnJobId ?? ""}
          runtimeOptions={tab.runtimeOptions}
          onsubmit={handleSubmit}
          onchat={handleChat}
        />
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-resize-handle"
      onmousedown={startSidebarResize}
    ></div>
    <div class="chat-sidebar" style="width: {sidebarWidth}px;">
      <ChatJobConfig />
      {#if chatStore.showContextPanel}
        <ChatContextPanel />
      {/if}
    </div>
  </div>
</div>

<style>
  .chat-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .chat-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  .sidebar-resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .sidebar-resize-handle:hover,
  .sidebar-resize-handle:active {
    background: var(--accent);
  }
  .chat-sidebar {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    overflow-y: auto;
    overflow-x: hidden;
    flex-shrink: 0;
  }
  .clear-bar {
    display: flex;
    padding: 4px 16px;
    flex-shrink: 0;
  }
  .btn-clear {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }
  .btn-clear:hover {
    color: var(--status-failed);
    background: var(--bg-hover);
  }
</style>
