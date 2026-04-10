import { connection } from "../stores/connection.svelte";
import type {
  AgentEngine,
  JobIntervention,
  JobInterventionCreate,
  JobInterventionSupport,
  JobRuntimeOptions,
} from "@arkestrator/protocol";

export interface LocalModelInfo {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
}

export interface LocalModelCatalogEntry extends LocalModelInfo {
  allowed: boolean;
  downloaded: boolean;
  recommended: boolean;
  parameterBillions?: number;
}

export interface LocalModelsResponse {
  runtime: "ollama";
  models: LocalModelInfo[];
  allowedModels: string[];
  catalog: LocalModelCatalogEntry[];
  source?: "server" | "worker";
  targetWorkerName?: string | null;
}

export interface ProviderModelCatalog {
  engine: AgentEngine;
  models: string[];
  reasoningLevels: string[];
  source: string;
  preferredDefaultModel?: string;
}

export interface ProviderModelCatalogsResponse {
  catalogs: Record<string, ProviderModelCatalog>;
}

export interface JobInterventionsResponse {
  jobId: string;
  interventions: JobIntervention[];
  support: JobInterventionSupport;
}

export interface LocalModelPullProgressEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  progressPercent?: number;
}

/**
 * In-flight request deduplication for GET requests.
 * If the same GET URL is already pending, return the same Promise
 * instead of firing a duplicate network request. This prevents
 * concurrent model catalog / bridge list fetches when components re-render.
 */
const inflightGets = new Map<string, Promise<any>>();

async function request(path: string, options: RequestInit = {}) {
  const method = (options.method ?? "GET").toUpperCase();

  // Deduplicate concurrent GET requests to the same path
  if (method === "GET") {
    const existing = inflightGets.get(path);
    if (existing) return existing;
  }

  const headers: Record<string, string> = {};
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (connection.sessionToken) {
    headers["Authorization"] = `Bearer ${connection.sessionToken}`;
  } else if (connection.apiKey) {
    headers["Authorization"] = `Bearer ${connection.apiKey}`;
  }

  const promise = fetch(`${connection.url}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (method === "GET") {
    const deduped = promise.then(processResponse).finally(() => inflightGets.delete(path));
    inflightGets.set(path, deduped);
    return deduped;
  }

  const res = await promise;
  return processResponse(res);
}

async function processResponse(res: Response) {
  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const msg = String(parsed?.error ?? parsed?.message ?? text).trim();
      const code = String(parsed?.code ?? "").trim();
      throw new Error(code ? `${res.status}: ${msg} (${code})` : `${res.status}: ${msg}`);
    } catch {
      throw new Error(`${res.status}: ${text}`);
    }
  }

  // Handle empty responses (204 No Content, or empty body)
  const contentLength = res.headers.get("content-length");
  if (res.status === 204 || contentLength === "0") {
    return null;
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildErrorMessage(status: number, statusText: string, bodyText: string): string {
  try {
    const body = JSON.parse(bodyText);
    return String(body?.error || `${status}: ${statusText}`);
  } catch {
    return `${status}: ${statusText}`;
  }
}

async function streamSsePost(
  path: string,
  body: unknown,
  onEvent: (event: string, data: string) => void | Promise<void>,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (connection.sessionToken) {
    headers.Authorization = `Bearer ${connection.sessionToken}`;
  } else if (connection.apiKey) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  }

  const res = await fetch(`${connection.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(buildErrorMessage(res.status, res.statusText, text));
  }
  if (!res.body) throw new Error("Stream response body was empty");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  async function flush() {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    await onEvent(eventName, payload);
    eventName = "message";
    dataLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (!line.trim()) {
        await flush();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }

      nl = buffer.indexOf("\n");
    }
  }

  if (buffer.trim()) {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  await flush();
}

export const api = {
  health: () => request("/health"),

  auth: {
    login: (username: string, password: string) =>
      request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    verifyTotp: (challengeToken: string, code: string) =>
      request("/api/auth/verify-totp", {
        method: "POST",
        body: JSON.stringify({ challengeToken, code }),
      }),
    setClientCoordination: (enabled: boolean, capability?: any) =>
      request("/api/auth/client-coordination", {
        method: "PUT",
        body: JSON.stringify({ enabled, capability }),
      }),
    changePassword: (
      currentPassword: string,
      newPassword: string,
      confirmNewPassword: string,
    ) =>
      request("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword, confirmNewPassword }),
      }),
    totpSetup: () =>
      request("/api/auth/totp/setup", { method: "POST" }),
    totpVerifySetup: (code: string) =>
      request("/api/auth/totp/verify-setup", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    totpDisable: (password: string, code?: string) =>
      request("/api/auth/totp/disable", {
        method: "POST",
        body: JSON.stringify({ password, code }),
      }),
    verifyPassword: (password: string) =>
      request("/api/auth/verify-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    me: () => request("/api/auth/me"),
    logout: () => request("/api/auth/logout", { method: "POST" }),
    getChatPersonality: () => request("/api/auth/chat-personality"),
    getChatPersonalityPresets: () => request("/api/auth/chat-personality/presets"),
    setChatPersonality: (personality: string, customPrompt?: string) =>
      request("/api/auth/chat-personality", {
        method: "PUT",
        body: JSON.stringify({ personality, customPrompt }),
      }),
  },

  jobs: {
    create: (data: any) =>
      request("/api/jobs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    list: (status?: string[]) =>
      request(
        `/api/jobs${status ? `?status=${status.join(",")}` : ""}`,
      ),
    get: (id: string) => request(`/api/jobs/${id}`),
    cancel: (id: string) =>
      request(`/api/jobs/${id}/cancel`, { method: "POST" }),
    reprioritize: (id: string, priority: string) =>
      request(`/api/jobs/${id}/reprioritize`, {
        method: "POST",
        body: JSON.stringify({ priority }),
      }),
    setOutcome: (
      id: string,
      rating: "good" | "average" | "poor" | "positive" | "negative",
      notes?: string,
    ) =>
      request(`/api/jobs/${id}/outcome`, {
        method: "POST",
        body: JSON.stringify({ rating, notes }),
      }),
    requeue: (id: string, targetWorkerName?: string) =>
      request(`/api/jobs/${id}/requeue`, {
        method: "POST",
        body: JSON.stringify({ targetWorkerName }),
      }),
    pause: (id: string) =>
      request(`/api/jobs/${id}/pause`, { method: "POST" }),
    resume: (id: string) =>
      request(`/api/jobs/${id}/resume`, { method: "POST" }),
    dispatch: (id: string) =>
      request(`/api/jobs/${id}/dispatch`, { method: "POST" }),
    interventions: (id: string) =>
      request(`/api/jobs/${id}/interventions`) as Promise<JobInterventionsResponse>,
    clearPendingInterventions: (id: string, reason?: string) =>
      request(`/api/jobs/${id}/interventions/pending`, {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      }) as Promise<{ ok: boolean; rejectedCount: number }>,
    intervene: (id: string, intervention: JobInterventionCreate) =>
      request(`/api/jobs/${id}/interventions`, {
        method: "POST",
        body: JSON.stringify(intervention),
      }) as Promise<{ intervention: JobIntervention; support: JobInterventionSupport }>,
    delete: (id: string) =>
      request(`/api/jobs/${id}`, { method: "DELETE" }),
    bulkDelete: (jobIds: string[]) =>
      request("/api/jobs/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ jobIds }),
      }),
    dependencies: (id: string) => request(`/api/jobs/${id}/dependencies`),
    addDependency: (id: string, depId: string) =>
      request(`/api/jobs/${id}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnJobId: depId }),
      }),
    removeDependency: (id: string, depJobId: string) =>
      request(`/api/jobs/${id}/dependencies/${depJobId}`, {
        method: "DELETE",
      }),
    listArchived: (limit?: number, offset?: number) =>
      request(`/api/jobs/archived${limit ? `?limit=${limit}&offset=${offset ?? 0}` : ""}`),
    listTrashed: (limit?: number, offset?: number) =>
      request(`/api/jobs/trash${limit ? `?limit=${limit}&offset=${offset ?? 0}` : ""}`),
    archive: (id: string) =>
      request(`/api/jobs/${id}/archive`, { method: "POST" }),
    restore: (id: string) =>
      request(`/api/jobs/${id}/restore`, { method: "POST" }),
    permanentDelete: (id: string) =>
      request(`/api/jobs/${id}/permanent`, { method: "DELETE" }),
  },

  agents: {
    list: () => request("/api/agent-configs"),
    templates: () => request("/api/agent-configs/templates"),
    cliAuthStatus: () => request("/api/agent-configs/cli-auth/status"),
    modelCatalogs: () =>
      request("/api/agent-configs/model-catalogs") as Promise<ProviderModelCatalogsResponse>,
    localModels: (runtime: "ollama" = "ollama", targetWorkerName?: string, host?: "server" | "client") => {
      const params = new URLSearchParams({ runtime });
      const worker = String(targetWorkerName ?? "").trim();
      if (worker) params.set("targetWorkerName", worker);
      if (host) params.set("host", host);
      return request(`/api/agent-configs/local-models?${params.toString()}`) as Promise<LocalModelsResponse>;
    },
    pullLocalModel: (model: string, runtime: "ollama" = "ollama", targetWorkerName?: string) =>
      request("/api/agent-configs/local-models/pull", {
        method: "POST",
        body: JSON.stringify({
          runtime,
          model,
          targetWorkerName: String(targetWorkerName ?? "").trim() || undefined,
        }),
      }),
    pullLocalModelStream: (
      model: string,
      onProgress: (event: LocalModelPullProgressEvent) => void | Promise<void>,
      runtime: "ollama" = "ollama",
      targetWorkerName?: string,
    ) =>
      streamSsePost(
        "/api/agent-configs/local-models/pull/stream",
        {
          runtime,
          model,
          targetWorkerName: String(targetWorkerName ?? "").trim() || undefined,
        },
        async (event, data) => {
          let parsed: any = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = {};
          }

          if (event === "progress") {
            await onProgress(parsed as LocalModelPullProgressEvent);
            return;
          }
          if (event === "done") {
            await onProgress({ progressPercent: 100, status: "success" });
            return;
          }
          if (event === "error") {
            throw new Error(String(parsed?.error ?? "Failed to pull local model"));
          }
        },
      ),
    setLocalModelAllowlist: (
      models: string[],
      runtime: "ollama" = "ollama",
      targetWorkerName?: string,
    ) =>
      request("/api/agent-configs/local-models/allowlist", {
        method: "PUT",
        body: JSON.stringify({
          runtime,
          models,
          targetWorkerName: String(targetWorkerName ?? "").trim() || undefined,
        }),
      }) as Promise<LocalModelsResponse>,
    create: (data: any) =>
      request("/api/agent-configs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request(`/api/agent-configs/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request(`/api/agent-configs/${id}`, { method: "DELETE" }),
  },

  keys: {
    list: () => request("/api/keys"),
    create: (name: string, role: string) =>
      request("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name, role }),
      }),
    revoke: (id: string) =>
      request(`/api/keys/${id}`, { method: "DELETE" }),
  },

  users: {
    list: () => request("/api/users"),
    create: (username: string, password: string, role: string) =>
      request("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role }),
      }),
    delete: (id: string) =>
      request(`/api/users/${id}`, { method: "DELETE" }),
  },

  workers: {
    list: () => request("/api/workers"),
    delete: (id: string) =>
      request(`/api/workers/${id}`, { method: "DELETE" }),
  },

  chat: {
    /** Stream a chat response via SSE. Calls onChunk for each text chunk, returns full response. */
    stream: async (
      data: {
        prompt: string;
        agentConfigId: string;
        history?: { role: string; content: string }[];
        improve?: boolean;
        bridgePrograms?: string[];
        conversationKey?: string;
        runtimeOptions?: JobRuntimeOptions;
        jobIds?: string[];
      },
      onChunk: (text: string) => void,
    ): Promise<string> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (connection.sessionToken) {
        headers["Authorization"] = `Bearer ${connection.sessionToken}`;
      } else if (connection.apiKey) {
        headers["Authorization"] = `Bearer ${connection.apiKey}`;
      }

      const res = await fetch(`${connection.url}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }

      let fullResponse = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const msg = JSON.parse(jsonStr);
              if (msg.type === "text") {
                fullResponse += msg.content;
                onChunk(msg.content);
              } else if (msg.type === "error") {
                throw new Error(msg.message);
              }
            } catch (e: any) {
              if (e.message && !e.message.includes("JSON")) throw e;
            }
          }
        }
      }

      return fullResponse;
    },
  },

  headlessPrograms: {
    list: () => request("/api/headless-programs"),
  },

  apiBridges: {
    list: () => request("/api/api-bridges"),
    presets: () => request("/api/api-bridges/presets"),
    get: (id: string) => request(`/api/api-bridges/${id}`),
    create: (data: Record<string, unknown>) =>
      request("/api/api-bridges", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request(`/api/api-bridges/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (id: string) =>
      request(`/api/api-bridges/${id}`, { method: "DELETE" }),
    test: (id: string) =>
      request(`/api/api-bridges/${id}/test`, { method: "POST" }),
    actions: (id: string) => request(`/api/api-bridges/${id}/actions`),
  },

  bridgeCommands: {
    listBridges: () => request("/api/bridge-command/bridges"),
    execute: (
      target: string,
      commands: Array<{ language: string; script: string; description?: string }>,
      targetType: "program" | "id" = "program",
      timeout?: number,
    ) =>
      request("/api/bridge-command", {
        method: "POST",
        body: JSON.stringify({ target, targetType, commands, timeout }),
      }),
    headlessCheck: (
      program: string,
      args: string[],
      projectPath?: string,
      timeout?: number,
    ) =>
      request("/api/bridge-command/headless-check", {
        method: "POST",
        body: JSON.stringify({ program, args, projectPath, timeout }),
      }),
  },

  stats: {
    usage: (userId?: string, since?: string) => {
      const params = new URLSearchParams();
      if (userId) params.set("userId", userId);
      if (since) params.set("since", since);
      const qs = params.toString();
      return request(`/api/stats/usage${qs ? `?${qs}` : ""}`);
    },
  },

  projects: {
    list: () => request("/api/projects"),
    get: (id: string) => request(`/api/projects/${id}`),
    create: (data: any) =>
      request("/api/projects", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request(`/api/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request(`/api/projects/${id}`, { method: "DELETE" }),
  },

  settings: {
    get: () =>
      request("/api/settings") as Promise<{
        enforce2fa: boolean;
        allowClientCoordination: boolean;
        serverLocalLlmBaseUrl?: string | null;
        serverLocalLlmEffectiveBaseUrl?: string;
        serverLocalLlmSource?: "setting" | "env" | "default";
      }>,
    setAllowClientCoordination: (enabled: boolean) =>
      request("/api/settings/allow-client-coordination", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    getDefaultProjectDir: () =>
      request("/api/settings/default-project-dir") as Promise<{
        path: string | null;
        defaultPath: string;
      }>,
    setDefaultProjectDir: (path: string | null) =>
      request("/api/settings/default-project-dir", {
        method: "PUT",
        body: JSON.stringify({ path }),
      }) as Promise<{ ok: boolean; path: string | null; defaultPath: string }>,
    getServerLocalLlm: () =>
      request("/api/settings/server-local-llm") as Promise<{
        baseUrl: string | null;
        effectiveBaseUrl: string;
        source: "setting" | "env" | "default";
        defaultBaseUrl: string;
      }>,
    setServerLocalLlm: (baseUrl: string | null) =>
      request("/api/settings/server-local-llm", {
        method: "PUT",
        body: JSON.stringify({ baseUrl }),
      }) as Promise<{
        ok: boolean;
        baseUrl: string | null;
        effectiveBaseUrl: string;
        source: "setting" | "env" | "default";
        defaultBaseUrl: string;
      }>,
    getComfyuiUrl: () =>
      request("/api/settings/comfyui-url") as Promise<{
        url: string | null;
        effectiveUrl: string;
        source: "setting" | "env" | "default";
        defaultUrl: string;
      }>,
    setComfyuiUrl: (url: string | null) =>
      request("/api/settings/comfyui-url", {
        method: "PUT",
        body: JSON.stringify({ url }),
      }) as Promise<{
        ok: boolean;
        url: string | null;
        effectiveUrl: string;
        source: "setting" | "env" | "default";
        defaultUrl: string;
      }>,
    testComfyuiUrl: () =>
      request("/api/settings/comfyui-url/test", {
        method: "POST",
      }) as Promise<{
        reachable: boolean;
        latencyMs: number;
        error?: string;
        systemStats?: any;
      }>,
    getComfyuiPath: () =>
      request("/api/settings/comfyui-path") as Promise<{ path: string | null }>,
    setComfyuiPath: (path: string | null) =>
      request("/api/settings/comfyui-path", {
        method: "PUT",
        body: JSON.stringify({ path }),
      }) as Promise<{ ok: boolean; path: string | null }>,
    exportConfigSnapshot: (includeServerFiles = false) =>
      request("/api/settings/config-snapshot/export", {
        method: "POST",
        body: JSON.stringify({ includeServerFiles }),
      }),
    importConfigSnapshot: (snapshot: any, includeServerFiles = false) =>
      request("/api/settings/config-snapshot/import", {
        method: "POST",
        body: JSON.stringify({ snapshot, includeServerFiles }),
      }),
    factoryReset: (password: string) =>
      request("/api/settings/factory-reset", {
        method: "POST",
        body: JSON.stringify({ password, confirmation: "RESET" }),
      }),
    getCoordinatorScripts: () => request("/api/settings/coordinator-scripts"),
    setCoordinatorScript: (program: string, content: string) =>
      request(`/api/settings/coordinator-scripts/${program}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    resetCoordinatorScript: (program: string) =>
      request(`/api/settings/coordinator-scripts/${program}`, { method: "DELETE" }),
    listCoordinatorScriptVersions: (program: string) =>
      request(`/api/settings/coordinator-scripts/${encodeURIComponent(program)}/versions`),
    rollbackCoordinatorScript: (program: string, version: number) =>
      request(`/api/settings/coordinator-scripts/${encodeURIComponent(program)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ version }),
      }),
    deleteCoordinatorScriptVersion: (program: string, version: number) =>
      request(`/api/settings/coordinator-scripts/${encodeURIComponent(program)}/versions/${version}`, {
        method: "DELETE",
      }),
    getCoordinatorReferencePaths: () =>
      request("/api/settings/coordinator-reference-paths"),
    setCoordinatorReferencePaths: (paths: string[]) =>
      request("/api/settings/coordinator-reference-paths", {
        method: "PUT",
        body: JSON.stringify({ paths }),
      }),
    getCoordinatorPlaybookSources: (program?: string) =>
      request(
        `/api/settings/coordinator-playbook-sources${program ? `?program=${encodeURIComponent(program)}` : ""}`,
      ),
    setCoordinatorPlaybookSources: (paths: string[]) =>
      request("/api/settings/coordinator-playbook-sources", {
        method: "PUT",
        body: JSON.stringify({ paths }),
      }),
    setCoordinatorPlaybookSourceEntries: (entries: Array<{ path: string; name?: string }>) =>
      request("/api/settings/coordinator-playbook-sources", {
        method: "PUT",
        body: JSON.stringify({ entries }),
      }),
    addCoordinatorPlaybookSource: (
      program: string,
      path: string,
      autoAnalyze = false,
      name?: string,
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/add-source`, {
        method: "POST",
        body: JSON.stringify({ path, autoAnalyze, name }),
      }),
    createAnalyzeCoordinatorSourceJob: (
      program: string,
      path: string,
      createIfMissing = true,
      overwritePrompt = false,
      mode: "fast" | "ai" = "fast",
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/analyze-source-job`, {
        method: "POST",
        body: JSON.stringify({ path, createIfMissing, overwritePrompt, mode }),
      }),
    getAnalyzeCoordinatorSourceJob: (program: string, jobId: string) =>
      request(`/api/settings/coordinator-playbooks/${program}/analyze-source-job/${jobId}`),
    listAnalyzeCoordinatorSourceJobs: (program: string, limit = 25) =>
      request(`/api/settings/coordinator-playbooks/${program}/analyze-source-jobs?limit=${encodeURIComponent(String(limit))}`),
    analyzeCoordinatorSource: (
      program: string,
      path: string,
      createIfMissing = true,
      overwritePrompt = false,
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/analyze-source`, {
        method: "POST",
        body: JSON.stringify({ path, createIfMissing, overwritePrompt }),
      }),
    getCoordinatorProjectConfig: (program: string, path: string) =>
      request(
        `/api/settings/coordinator-playbooks/${program}/project-config?path=${encodeURIComponent(path)}`,
      ),
    getCoordinatorProjectConfigRaw: (program: string, path: string) =>
      request(
        `/api/settings/coordinator-playbooks/${program}/project-config-raw?path=${encodeURIComponent(path)}`,
      ),
    setCoordinatorProjectConfig: (
      program: string,
      path: string,
      projectName: string,
      prompt: string,
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/project-config`, {
        method: "PUT",
        body: JSON.stringify({ path, projectName, prompt }),
      }),
    setCoordinatorProjectConfigRaw: (
      program: string,
      path: string,
      content: string,
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/project-config-raw`, {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      }),
    trainCoordinatorScript: (program: string, paths: string[], apply = false) =>
      request(`/api/settings/coordinator-playbooks/${program}/train-script`, {
        method: "POST",
        body: JSON.stringify({ paths, apply }),
      }),
    queueCoordinatorTrainingJob: (
      program: string,
      paths: string[] = [],
      apply = true,
      files: File[] = [],
      filePaths: string[] = [],
      agentConfigId = "",
      prompt = "",
      targetWorkerName = "",
      trainingLevel = "medium",
    ) => {
      const trimmedAgentConfigId = String(agentConfigId ?? "").trim();
      const trimmedPrompt = String(prompt ?? "").trim();
      const trimmedTargetWorkerName = String(targetWorkerName ?? "").trim();
      const trimmedTrainingLevel = String(trainingLevel ?? "medium").trim();
      const hasFiles = Array.isArray(files) && files.length > 0;
      if (!hasFiles) {
        return request(`/api/settings/coordinator-playbooks/${program}/train-script-job`, {
          method: "POST",
          body: JSON.stringify({
            paths,
            apply,
            agentConfigId: trimmedAgentConfigId || undefined,
            prompt: trimmedPrompt || undefined,
            targetWorkerName: trimmedTargetWorkerName || undefined,
            trainingLevel: trimmedTrainingLevel || undefined,
          }),
        });
      }

      const form = new FormData();
      form.set("apply", apply ? "true" : "false");
      if (trimmedAgentConfigId) form.set("agentConfigId", trimmedAgentConfigId);
      if (trimmedPrompt) form.set("prompt", trimmedPrompt);
      if (trimmedTargetWorkerName) form.set("targetWorkerName", trimmedTargetWorkerName);
      if (trimmedTrainingLevel) form.set("trainingLevel", trimmedTrainingLevel);
      for (const path of paths) {
        const value = String(path ?? "").trim();
        if (!value) continue;
        form.append("paths", value);
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        form.append("files", file);
        const relPath = String(filePaths[i] ?? "").trim();
        if (relPath) form.append("filePaths", relPath);
      }

      return request(`/api/settings/coordinator-playbooks/${program}/train-script-job`, {
        method: "POST",
        body: form,
      });
    },
    getCoordinatorTrainingSchedule: () =>
      request("/api/settings/coordinator-training-schedule"),
    setCoordinatorTrainingSchedule: (
      payload: {
        enabled?: boolean;
        intervalMinutes?: number;
        apply?: boolean;
        programs?: string[];
      },
    ) =>
      request("/api/settings/coordinator-training-schedule", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    runCoordinatorTrainingNow: (
      options?: {
        programs?: string[];
        sourcePaths?: string[];
        apply?: boolean;
        prompt?: string;
        targetWorkerName?: string;
        excludeWorker?: string;
        trainingLevel?: string;
      },
    ) =>
      request("/api/settings/coordinator-training/run-now", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }),
    runHousekeepingNow: () =>
      request("/api/settings/housekeeping/run-now", { method: "POST" }),
    getHousekeepingSchedule: () =>
      request("/api/settings/housekeeping-schedule") as Promise<{ enabled: boolean; intervalMinutes: number; lastRunAt?: string }>,
    setHousekeepingSchedule: (payload: { enabled?: boolean; intervalMinutes?: number }) =>
      request("/api/settings/housekeeping-schedule", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    getCoordinatorEditors: () => request("/api/settings/coordinator-editors"),
    setCoordinatorEditors: (userIds: string[]) =>
      request("/api/settings/coordinator-editors", {
        method: "PUT",
        body: JSON.stringify({ userIds }),
      }),
    getCoordinatorAnalyzeAgent: () => request("/api/settings/coordinator-analyze-agent"),
    setCoordinatorAnalyzeAgent: (agentConfigId: string | null) =>
      request("/api/settings/coordinator-analyze-agent", {
        method: "PUT",
        body: JSON.stringify({ agentConfigId }),
      }),
    getCoordinatorPlaybook: (program: string) =>
      request(`/api/settings/coordinator-playbooks/${program}`),
    getCoordinatorPlaybookFile: (program: string, path: string) =>
      request(
        `/api/settings/coordinator-playbooks/${program}/files?path=${encodeURIComponent(path)}`,
      ),
    setCoordinatorPlaybookManifest: (program: string, manifest: string) =>
      request(`/api/settings/coordinator-playbooks/${program}/manifest`, {
        method: "PUT",
        body: JSON.stringify({ manifest }),
      }),
    saveCoordinatorPlaybookFile: (program: string, path: string, content: string) =>
      request(`/api/settings/coordinator-playbooks/${program}/files`, {
        method: "POST",
        body: JSON.stringify({ path, content }),
      }),
    addCoordinatorReferenceFolder: (program: string, taskId: string, folderPath: string) =>
      request(`/api/settings/coordinator-playbooks/${program}/add-reference-folder`, {
        method: "POST",
        body: JSON.stringify({ taskId, folderPath }),
      }),
    addCoordinatorReferenceRepo: (
      program: string,
      taskId: string,
      repoUrl: string,
      branch?: string,
      subPath?: string,
    ) =>
      request(`/api/settings/coordinator-playbooks/${program}/add-reference-repo`, {
        method: "POST",
        body: JSON.stringify({ taskId, repoUrl, branch, subPath }),
      }),
    uploadCoordinatorPlaybookFiles: async (
      program: string,
      targetDir: string,
      files: File[],
      paths?: string[],
    ) => {
      const form = new FormData();
      if (targetDir?.trim()) form.set("targetDir", targetDir.trim());
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        form.append("files", f);
        const relPath = paths && typeof paths[i] === "string" ? paths[i].trim() : "";
        form.append("paths", relPath);
      }
      return request(`/api/settings/coordinator-playbooks/${program}/upload`, {
        method: "POST",
        body: form,
      });
    },
  },

  templates: {
    list: (type?: string, category?: string): Promise<any> => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (category) params.set("category", category);
      params.set("enabled", "1");
      const qs = params.toString();
      return request(`/api/templates${qs ? `?${qs}` : ""}`);
    },
    create: (data: any): Promise<any> =>
      request("/api/templates", { method: "POST", body: JSON.stringify(data) }),
    categories: (type?: string): Promise<any> =>
      request(`/api/templates/categories${type ? `?type=${encodeURIComponent(type)}` : ""}`),
  },

  skills: {
    list: (program?: string, category?: string, includeDisabled = true) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      if (category) params.set("category", category);
      if (includeDisabled) params.set("includeDisabled", "true");
      const qs = params.toString();
      return request(`/api/skills${qs ? `?${qs}` : ""}`);
    },
    get: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}${qs}`);
    },
    search: (query: string, program?: string, category?: string) =>
      request("/api/skills/search", {
        method: "POST",
        body: JSON.stringify({ query, program, category }),
      }),
    create: (skill: {
      name: string;
      slug: string;
      program?: string;
      category: string;
      title: string;
      description?: string;
      keywords?: string[];
      content: string;
      priority?: number;
      autoFetch?: boolean;
      enabled?: boolean;
    }) =>
      request("/api/skills", {
        method: "POST",
        body: JSON.stringify(skill),
      }),
    update: (slug: string, updates: Record<string, unknown>, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}${qs}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },
    delete: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}${qs}`, {
        method: "DELETE",
      });
    },
    installCommunity: (communityId: string, communityBaseUrl?: string) =>
      request("/api/skills/install-community", {
        method: "POST",
        body: JSON.stringify({ communityId, communityBaseUrl }),
      }) as Promise<{ skill: any; communityId: string; slug: string; program: string }>,
    registry: () => request("/api/skills/registry"),
    pullAll: () => request("/api/skills/pull-all", { method: "POST" }),
    pullProgram: (program: string) =>
      request(`/api/skills/pull/${encodeURIComponent(program)}`, { method: "POST" }),
    refreshFromSource: (slug: string, program?: string, opts?: { communityId?: string; communityBaseUrl?: string }) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/refresh/${encodeURIComponent(slug)}${qs}`, {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      });
    },
    refreshIndex: () => request("/api/skills/refresh-index", { method: "POST" }),
    wipeAll: () => request("/api/skills/wipe-all", { method: "POST" }),
    importFromGitHub: (repoUrl: string, program = "global", subPath?: string) =>
      request("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({ repoUrl, program, subPath }),
      }),
    batchEffectiveness: (skillIds: string[]) =>
      request("/api/skills/batch-effectiveness", {
        method: "POST",
        body: JSON.stringify({ skillIds }),
      }) as Promise<{ stats: Record<string, { totalUsed: number; goodOutcomes: number; averageOutcomes: number; poorOutcomes: number; pendingOutcomes: number; successRate: number }> }>,
    exportZip: async (slugs?: string[], includeDeps = true) => {
      const { saveFileWithDialog } = await import("../utils/format");
      const headers: Record<string, string> = {};
      if (connection.sessionToken) {
        headers["Authorization"] = `Bearer ${connection.sessionToken}`;
      } else if (connection.apiKey) {
        headers["Authorization"] = `Bearer ${connection.apiKey}`;
      }
      headers["Content-Type"] = "application/json";
      const bodyObj: Record<string, unknown> = { includeDeps };
      if (slugs?.length) bodyObj.slugs = slugs;
      const res = await fetch(`${connection.url}/api/skills/export-zip`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyObj),
      });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const defaultName = slugs?.length === 1
        ? `arkestrator_skill_${slugs[0]}_${new Date().toISOString().slice(0, 10)}.zip`
        : `arkestrator_skills_${new Date().toISOString().slice(0, 10)}.zip`;
      await saveFileWithDialog(defaultName, blob, [{ name: "ZIP Archive", extensions: ["zip"] }], "Export Skills");
    },
    importZip: async (file: File) => {
      const headers: Record<string, string> = {};
      if (connection.sessionToken) {
        headers["Authorization"] = `Bearer ${connection.sessionToken}`;
      } else if (connection.apiKey) {
        headers["Authorization"] = `Bearer ${connection.apiKey}`;
      }
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${connection.url}/api/skills/import-zip`, {
        method: "POST",
        headers,
        body: formData,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Import failed: ${res.status}: ${text}`);
      }
      return res.json();
    },
    getPlaybookContent: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/playbook-content${qs}`);
    },
    getEffectiveness: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/effectiveness${qs}`) as Promise<{
        stats: {
          totalUsed: number;
          successRate: number;
          pendingOutcomes: number;
          goodOutcomes: number;
          averageOutcomes: number;
          poorOutcomes: number;
        };
        records: any[];
      }>;
    },
    deleteEffectivenessRecord: (slug: string, recordId: string, program?: string, mode: "delete" | "clear" = "delete") => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      params.set("mode", mode);
      const qs = `?${params.toString()}`;
      return request(`/api/skills/${encodeURIComponent(slug)}/effectiveness/${encodeURIComponent(recordId)}${qs}`, {
        method: "DELETE",
      }) as Promise<{ ok: boolean; mode: string; stats: any; records: any[] }>;
    },
    wipeEffectivenessForSkill: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/effectiveness/wipe${qs}`, {
        method: "POST",
      }) as Promise<{ ok: boolean; deleted: number; stats: any; records: any[] }>;
    },
    wipeAllEffectiveness: () => {
      return request(`/api/skills/effectiveness/wipe-all`, {
        method: "POST",
      }) as Promise<{ ok: boolean; deleted: number }>;
    },
    listVersions: (slug: string, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/versions${qs}`);
    },
    rollback: (slug: string, version: number, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/rollback${qs}`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
    },
    deleteVersion: (slug: string, version: number, program?: string) => {
      const qs = program ? `?program=${encodeURIComponent(program)}` : "";
      return request(`/api/skills/${encodeURIComponent(slug)}/versions/${version}${qs}`, {
        method: "DELETE",
      });
    },
  },
};
