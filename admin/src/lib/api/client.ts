function getToken(): string | null {
  return localStorage.getItem("admin_session_token");
}

export interface AdminUserPermissions {
  manageUsers?: boolean;
  manageAgents?: boolean;
  manageProjects: boolean;
  managePolicies?: boolean;
  manageApiKeys?: boolean;
  manageConnections: boolean;
  manageWorkers?: boolean;
  manageSecurity?: boolean;
  viewAuditLog?: boolean;
  viewUsage?: boolean;
  editCoordinator?: boolean;
  useMcp: boolean;
  interveneJobs: boolean;
  executeCommands?: boolean;
  deliverFiles?: boolean;
  submitJobs?: boolean;
}

export interface UserInsightsUsageTotals {
  totalInput: number;
  totalOutput: number;
  jobCount: number;
}

export interface UserInsightsRecentJob {
  id: string;
  name: string | null;
  prompt: string;
  status: string;
  priority: string;
  bridgeProgram: string | null;
  workerName: string | null;
  workspaceMode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  } | null;
}

export interface UserInsightsResponse {
  user: {
    id: string;
    username: string;
    role: string;
    require2fa: boolean;
    clientCoordinationEnabled: boolean;
    tokenLimitInput: number | null;
    tokenLimitOutput: number | null;
    tokenLimitPeriod: string;
    createdAt: string;
  };
  usage: {
    daily: UserInsightsUsageTotals;
    monthly: UserInsightsUsageTotals;
    allTime: UserInsightsUsageTotals;
  };
  jobs: {
    counts: {
      total: number;
      queued: number;
      paused: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
    };
    recent: UserInsightsRecentJob[];
  };
}

export interface AdminApiKey {
  id: string;
  name: string;
  role: "bridge" | "client" | "admin" | "mcp";
  permissions: AdminUserPermissions;
  createdAt: string;
  revokedAt: string | null;
}

export interface AdminApiKeyCreateResponse extends AdminApiKey {
  key: string;
}

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

export interface LocalModelPullProgressEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  progressPercent?: number;
}

export type CliAuthProvider = "claude-code" | "codex";
export type CliAuthState = "authenticated" | "unauthenticated" | "unknown" | "missing";
export type CliAuthSessionStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CliAuthStatusProvider {
  provider: CliAuthProvider;
  label: string;
  command: string;
  commandSource: "agent_config" | "default";
  available: boolean;
  authenticated: boolean | null;
  state: CliAuthState;
  details: string;
  docsUrl: string;
  statusCommand: string[];
  outputPreview: string[];
  lastCheckedAt: string;
}

export interface CliAuthStatusResponse {
  serverUser: string | null;
  homeDir: string | null;
  providers: CliAuthStatusProvider[];
}

export interface CliAuthSession {
  id: string;
  provider: CliAuthProvider;
  label: string;
  command: string;
  args: string[];
  status: CliAuthSessionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  urls: string[];
  codes: string[];
  output: string[];
  docsUrl: string;
}

export interface CliAuthSessionEnvelope {
  session: CliAuthSession | null;
}

export interface CoordinatorTrainingVaultEntry {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  updatedAt: string | null;
  root: "scripts" | "playbooks" | "learning" | "imports";
  rootLabel: string;
  isRoot: boolean;
  program: string | null;
  metadata: CoordinatorTrainingVaultMetadata | null;
}

export interface CoordinatorTrainingVaultMetadataActor {
  id: string | null;
  username: string | null;
  ipAddress: string | null;
  workerName: string | null;
}

export interface CoordinatorTrainingVaultMetadata {
  path: string;
  kind: "file" | "directory";
  createdAt: string;
  updatedAt: string;
  createdBy: CoordinatorTrainingVaultMetadataActor;
  updatedBy: CoordinatorTrainingVaultMetadataActor;
  projectPaths: string[];
  sourcePaths: string[];
  remarks: string | null;
}

export interface CoordinatorTrainingVaultResponse {
  baseFolder: string;
  subfolders: Array<{
    name: "scripts" | "playbooks" | "learning" | "imports";
    label: string;
    sourcePath: string;
  }>;
  entries: CoordinatorTrainingVaultEntry[];
}

export type TrainingJobSignal = "positive" | "average" | "negative" | "unknown";
export type TrainingJobTransport = "mcp" | "cli_rest" | "mixed" | "unknown";

export interface TrainingJobSummary {
  jobId: string;
  name: string;
  program: string;
  signal: TrainingJobSignal;
  prompt: string;
  outcome: string;
  model: string | null;
  agentEngine: string | null;
  agentConfigId: string | null;
  actualAgentConfigId: string | null;
  workspaceMode: string | null;
  coordinationMode: string | null;
  transport: TrainingJobTransport;
  workerName: string | null;
  targetWorkerName: string | null;
  bridgeProgram: string | null;
  bridgeId: string | null;
  usedBridges: string[];
  submittedByUserId: string | null;
  submittedByUsername: string | null;
  outcomeMarkedByUserId: string | null;
  outcomeMarkedByUsername: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  storedAt: string | null;
  artifactCount: number;
  artifactPaths: string[];
}

export interface TrainingJobQueryFilters {
  programs: string[];
  jobId: string | null;
  q: string | null;
  signal: TrainingJobSignal | null;
  transport: TrainingJobTransport | null;
  dateFrom: string | null;
  dateTo: string | null;
  limit: number;
}

export interface TrainingJobExportPayload {
  format: "arkestrator-training-jobs-export";
  schemaVersion: 1;
  generatedAt: string;
  generatedBy: { id: string; username: string };
  scope: "all" | "filtered" | "program" | "job";
  filters: TrainingJobQueryFilters;
  summary: {
    total: number;
    countsByProgram: Record<string, number>;
    countsBySignal: Record<string, number>;
    countsByTransport: Record<string, number>;
  };
  items: TrainingJobSummary[];
}

export interface ConfigSnapshot {
  format: "arkestrator-config-snapshot";
  schemaVersion: number;
  generatedAt: string;
  generatedBy: {
    id: string;
    username: string;
  };
  includes: {
    training: true;
    serverFiles: boolean;
  };
  tables: Record<string, Record<string, unknown>[]>;
  training: {
    files: Array<{
      root: "scripts" | "playbooks" | "learning" | "imports";
      relPath: string;
      path: string;
      bytes: number;
      updatedAt: string;
      encoding: "utf8" | "base64";
      content: string;
    }>;
    skipped: Array<{ path: string; reason: string }>;
    metadata?: CoordinatorTrainingVaultMetadata[];
  };
  serverFiles: {
    files: Array<{
      path: string;
      bytes: number;
      updatedAt: string;
      encoding: "utf8" | "base64";
      content: string;
    }>;
    roots: string[];
    skipped: Array<{ path: string; reason: string }>;
  };
}

export type TrainingRepositorySourceKind =
  | "training_objective"
  | "job_outcome"
  | "experience"
  | "project_config"
  | "project_notes"
  | "playbook_snapshot"
  | "upload_file"
  | "scene_file";

export interface TrainingRepositoryPolicy {
  version: 1;
  retrieval: {
    lexicalWeight: number;
    semanticWeight: number;
    qualityWeight: number;
    minTrustScore: number;
    minScore: number;
    includeQuarantined: boolean;
    maxResults: number;
  };
  ingestion: {
    retentionDays: number;
    quarantineEnabled: boolean;
    quarantinePatterns: string[];
  };
  trustBySourceKind: Record<TrainingRepositorySourceKind, number>;
}

export type TrainingRepositoryPolicyPatch = Partial<{
  retrieval: Partial<TrainingRepositoryPolicy["retrieval"]>;
  ingestion: Partial<TrainingRepositoryPolicy["ingestion"]>;
  trustBySourceKind: Partial<TrainingRepositoryPolicy["trustBySourceKind"]>;
}>;

export type TrainingRepositoryOverrideMode = "allow" | "quarantine" | "suppress";

export interface TrainingRepositoryOverrideRule {
  mode: TrainingRepositoryOverrideMode;
  trustDelta?: number;
  note?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TrainingRepositoryOverrides {
  version: 1;
  byId: Record<string, TrainingRepositoryOverrideRule>;
  bySourcePath: Record<string, TrainingRepositoryOverrideRule>;
}

export interface TrainingRepositoryRecord {
  id: string;
  program: string;
  sourceKind: TrainingRepositorySourceKind;
  sourcePath: string;
  title: string;
  summary: string;
  prompt?: string;
  outcome?: string;
  qualityRating: "good" | "average" | "poor";
  qualityWeight: number;
  sourceReliability: number;
  trustScore: number;
  quarantined: boolean;
  quarantineReasons: string[];
  score: number;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
  tags: string[];
  overrideMode?: TrainingRepositoryOverrideMode | null;
  metadata?: {
    jobId?: string;
    bridgeProgram?: string;
    usedBridges?: string[];
    trainingObjective?: string;
  };
}

export interface TrainingRepositoryRefreshStatus {
  program: string;
  running: boolean;
  pending: boolean;
  refreshCount: number;
  lastQueuedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  indexPath?: string;
  indexExists?: boolean;
}

export interface TrainingRepositoryMetrics {
  program: string;
  queryCount: number;
  queryCacheHits: number;
  queryCacheHitRate: number;
  avgQueryMs: number;
  refreshCount: number;
  avgRefreshMs: number;
  lastQueryAt?: string;
  lastRefreshAt?: string;
  lastRefreshError?: string;
}

async function request(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {};
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `${res.status}: ${res.statusText}`);
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

function parseFileNameFromContentDisposition(headerValue: string | null): string | null {
  const raw = String(headerValue ?? "");
  if (!raw) return null;
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = raw.match(/filename=\"?([^\";]+)\"?/i);
  if (!plain?.[1]) return null;
  return plain[1].trim() || null;
}

async function requestBinary(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  const headers: Record<string, string> = {};
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(buildErrorMessage(res.status, res.statusText, text));
  }

  const blob = await res.blob();
  const fileName = parseFileNameFromContentDisposition(res.headers.get("content-disposition"));
  return { blob, fileName };
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
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, {
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
    me: () => request("/api/auth/me"),
    logout: () => request("/api/auth/logout", { method: "POST" }),
  },

  users: {
    list: () => request("/api/users"),
    insights: (id: string, limit = 25) =>
      request(`/api/users/${id}/insights?limit=${encodeURIComponent(String(limit))}`) as Promise<UserInsightsResponse>,
    create: (
      username: string,
      password: string,
      role: string,
      permissions?: AdminUserPermissions,
      settings?: {
        require2fa?: boolean;
        clientCoordinationEnabled?: boolean;
      },
    ) =>
      request("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role, permissions, ...settings }),
      }),
    updateRole: (id: string, role: string) =>
      request(`/api/users/${id}/role`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      }),
    resetPassword: (
      id: string,
      oldPassword: string,
      newPassword: string,
      confirmNewPassword: string,
    ) =>
      request(`/api/users/${id}/password`, {
        method: "PUT",
        body: JSON.stringify({ oldPassword, newPassword, confirmNewPassword }),
      }),
    delete: (id: string, password: string) =>
      request(`/api/users/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ password }),
      }),
    setLimits: (id: string, limits: { inputLimit?: number | null; outputLimit?: number | null; period?: string }) =>
      request(`/api/users/${id}/limits`, {
        method: "PUT",
        body: JSON.stringify(limits),
      }),
    updatePermissions: (
      id: string,
      permissions: AdminUserPermissions,
    ) =>
      request(`/api/users/${id}/permissions`, {
        method: "PUT",
        body: JSON.stringify({ permissions }),
      }),
    updateSettings: (
      id: string,
      settings: {
        require2fa?: boolean;
        clientCoordinationEnabled?: boolean;
      },
    ) =>
      request(`/api/users/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
  },

  keys: {
    list: () => request("/api/keys") as Promise<AdminApiKey[]>,
    create: (name: string, role: "bridge" | "client" | "admin" | "mcp", permissions?: AdminUserPermissions) =>
      request("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name, role, permissions }),
      }) as Promise<AdminApiKeyCreateResponse>,
    revoke: (id: string) =>
      request(`/api/keys/${id}`, { method: "DELETE" }) as Promise<{ ok: true }>,
    updatePermissions: (id: string, permissions: AdminUserPermissions) =>
      request(`/api/keys/${id}/permissions`, {
        method: "PUT",
        body: JSON.stringify({ permissions }),
      }) as Promise<{ ok: true }>,
  },

  agents: {
    list: () => request("/api/agent-configs"),
    get: (id: string) => request(`/api/agent-configs/${id}`),
    templates: () => request("/api/agent-configs/templates"),
    cliAuthStatus: () =>
      request("/api/agent-configs/cli-auth/status") as Promise<CliAuthStatusResponse>,
    cliAuthStartLogin: (provider: CliAuthProvider) =>
      request(`/api/agent-configs/cli-auth/${provider}/login/start`, { method: "POST" }) as Promise<CliAuthSessionEnvelope>,
    cliAuthLoginSession: (provider: CliAuthProvider) =>
      request(`/api/agent-configs/cli-auth/${provider}/login/session`) as Promise<CliAuthSessionEnvelope>,
    cliAuthCancelLogin: (provider: CliAuthProvider) =>
      request(`/api/agent-configs/cli-auth/${provider}/login/cancel`, { method: "POST" }) as Promise<CliAuthSessionEnvelope>,
    localModels: (runtime: "ollama" = "ollama", targetWorkerName?: string) => {
      const params = new URLSearchParams({ runtime });
      const worker = String(targetWorkerName ?? "").trim();
      if (worker) params.set("targetWorkerName", worker);
      return request(`/api/agent-configs/local-models?${params.toString()}`) as Promise<LocalModelsResponse>;
    },
    setLocalModelAllowlist: (models: string[], runtime: "ollama" = "ollama", targetWorkerName?: string) =>
      request("/api/agent-configs/local-models/allowlist", {
        method: "PUT",
        body: JSON.stringify({
          runtime,
          models,
          targetWorkerName: String(targetWorkerName ?? "").trim() || undefined,
        }),
      }) as Promise<LocalModelsResponse>,
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

  policies: {
    list: (filters?: Record<string, string>) => {
      const params = filters
        ? `?${new URLSearchParams(filters).toString()}`
        : "";
      return request(`/api/policies${params}`);
    },
    create: (data: any) =>
      request("/api/policies", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request(`/api/policies/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    toggle: (id: string, enabled: boolean) =>
      request(`/api/policies/${id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    delete: (id: string) =>
      request(`/api/policies/${id}`, { method: "DELETE" }),
  },

  connections: {
    list: () => request("/api/connections"),
    kick: (id: string) =>
      request(`/api/connections/${id}/kick`, { method: "POST" }) as Promise<{ ok: boolean }>,
  },

  workers: {
    list: () => request("/api/workers"),
    delete: (id: string) =>
      request(`/api/workers/${id}`, { method: "DELETE" }),
    updateRules: (
      id: string,
      rules: {
        banned?: boolean;
        clientCoordinationAllowed?: boolean;
        ipAllowlist?: string[];
        ipDenylist?: string[];
        localLlmEnabled?: boolean;
        localLlmBaseUrl?: string;
        note?: string;
      },
    ) =>
      request(`/api/workers/${id}/rules`, {
        method: "PUT",
        body: JSON.stringify(rules),
      }),
    deleteBridgesByProgram: (program: string) =>
      request(`/api/workers/bridges-by-program/${encodeURIComponent(program)}`, {
        method: "DELETE",
      }) as Promise<{ ok: boolean; program: string; deleted: number }>,
    checkLocalLlm: (id: string, timeoutMs = 4000) =>
      request(`/api/workers/${id}/local-llm-check?timeoutMs=${encodeURIComponent(String(timeoutMs))}`) as Promise<{
        ok: boolean;
        workerName: string;
        resolution: {
          workerName: string;
          enabled: boolean;
          baseUrl: string | null;
          source: "rule" | "worker-ip" | "none";
          workerIp: string | null;
          reason?: string;
        };
        health: {
          ok: boolean;
          baseUrl: string;
          latencyMs: number;
          modelCount: number;
          models: string[];
          error?: string;
        } | null;
      }>,
  },

  settings: {
    get: () =>
      request("/api/settings") as Promise<{
        enforce2fa: boolean;
        allowClientCoordination: boolean;
        trainingRepositoryPolicy?: TrainingRepositoryPolicy;
        trainingRepositoryOverridesSummary?: {
          byId: number;
          bySourcePath: number;
        };
        trainingRepositoryRefreshStatus?: TrainingRepositoryRefreshStatus[];
      }>,
    setAllowClientCoordination: (enabled: boolean) =>
      request("/api/settings/allow-client-coordination", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }) as Promise<{
        ok: boolean;
        allowClientCoordination: boolean;
      }>,
    getTrainingRepositoryPolicy: () =>
      request("/api/settings/training-repository-policy") as Promise<{
        policy: TrainingRepositoryPolicy;
        defaultPolicy: TrainingRepositoryPolicy;
      }>,
    updateTrainingRepositoryPolicy: (policy: TrainingRepositoryPolicyPatch | TrainingRepositoryPolicy) =>
      request("/api/settings/training-repository-policy", {
        method: "PUT",
        body: JSON.stringify({ policy }),
      }) as Promise<{
        ok: boolean;
        policy: TrainingRepositoryPolicy;
      }>,
    getTrainingRepositoryOverrides: () =>
      request("/api/settings/training-repository-overrides") as Promise<{
        overrides: TrainingRepositoryOverrides;
        summary: {
          byId: number;
          bySourcePath: number;
        };
      }>,
    updateTrainingRepositoryOverrides: (
      updates: Array<{
        id?: string;
        sourcePath?: string;
        mode?: TrainingRepositoryOverrideMode | "clear";
        trustDelta?: number;
        note?: string;
      }>,
      options?: {
        programs?: string[];
        immediate?: boolean;
      },
    ) =>
      request("/api/settings/training-repository-overrides", {
        method: "PUT",
        body: JSON.stringify({
          updates,
          programs: options?.programs ?? [],
          immediate: options?.immediate === true,
        }),
      }) as Promise<{
        ok: boolean;
        applied: number;
        programs: string[];
        overrides: TrainingRepositoryOverrides;
        summary: {
          byId: number;
          bySourcePath: number;
        };
      }>,
    listTrainingRepositoryRecords: (options: {
      program: string;
      query?: string;
      includeQuarantined?: boolean;
      includeSuppressed?: boolean;
      limit?: number;
    }) => {
      const params = new URLSearchParams();
      params.set("program", options.program);
      if (options.query) params.set("q", options.query);
      if (options.includeQuarantined) params.set("includeQuarantined", "true");
      if (options.includeSuppressed) params.set("includeSuppressed", "true");
      if (Number.isFinite(options.limit)) params.set("limit", String(options.limit));
      return request(`/api/settings/training-repository-records?${params.toString()}`) as Promise<{
        program: string;
        total: number;
        records: TrainingRepositoryRecord[];
      }>;
    },
    getTrainingRepositoryStatus: (program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/settings/training-repository-status${qs ? `?${qs}` : ""}`) as Promise<{
        statuses: TrainingRepositoryRefreshStatus[];
        total: number;
      }>;
    },
    getTrainingRepositoryMetrics: (program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/settings/training-repository-metrics${qs ? `?${qs}` : ""}`) as Promise<{
        metrics: TrainingRepositoryMetrics[];
        total: number;
      }>;
    },
    reindexTrainingRepository: (options: {
      programs?: string[];
      immediate?: boolean;
      sourcePaths?: string[];
      trainingObjective?: string;
    }) =>
      request("/api/settings/training-repository-reindex", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }) as Promise<{
        ok: boolean;
        queued: string[];
        immediate: boolean;
        status: TrainingRepositoryRefreshStatus[];
      }>,
  },

  coordinatorTraining: {
    list: (limit = 3000) =>
      request(`/api/settings/coordinator-training-files?limit=${encodeURIComponent(String(limit))}`) as Promise<CoordinatorTrainingVaultResponse>,
    readFile: (path: string) =>
      request(`/api/settings/coordinator-training-files/content?path=${encodeURIComponent(path)}`) as Promise<{
        path: string;
        root: "scripts" | "playbooks" | "learning" | "imports";
        bytes: number;
        updatedAt: string;
        content: string;
        metadata: CoordinatorTrainingVaultMetadata | null;
      }>,
    writeFile: (path: string, content: string) =>
      request("/api/settings/coordinator-training-files/content", {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      }),
    createFolder: (path: string) =>
      request("/api/settings/coordinator-training-files/folders", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    deleteFile: (path: string) =>
      request(`/api/settings/coordinator-training-files/content?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      }),
    deleteFolder: (path: string) =>
      request(`/api/settings/coordinator-training-files/folders?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      }),
    updateMetadata: (
      path: string,
      payload: {
        projectPaths?: string[];
        sourcePaths?: string[];
        remarks?: string | null;
      },
    ) =>
      request("/api/settings/coordinator-training-files/metadata", {
        method: "PUT",
        body: JSON.stringify({ path, ...payload }),
      }) as Promise<{
        ok: boolean;
        path: string;
        root: "scripts" | "playbooks" | "learning" | "imports";
        metadata: CoordinatorTrainingVaultMetadata | null;
      }>,
    listJobs: (options?: {
      program?: string;
      programs?: string[] | string;
      jobId?: string;
      q?: string;
      signal?: TrainingJobSignal;
      transport?: TrainingJobTransport;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) => {
      const params = new URLSearchParams();
      const program = String(options?.program ?? "").trim();
      if (program) params.set("program", program);
      const programs = options?.programs;
      if (Array.isArray(programs)) {
        const normalized = programs.map((value) => String(value ?? "").trim()).filter(Boolean);
        if (normalized.length > 0) params.set("programs", normalized.join(","));
      } else if (typeof programs === "string" && programs.trim()) {
        params.set("programs", programs.trim());
      }
      if (options?.jobId) params.set("jobId", options.jobId);
      if (options?.q) params.set("q", options.q);
      if (options?.signal) params.set("signal", options.signal);
      if (options?.transport) params.set("transport", options.transport);
      if (options?.dateFrom) params.set("dateFrom", options.dateFrom);
      if (options?.dateTo) params.set("dateTo", options.dateTo);
      if (Number.isFinite(options?.limit)) params.set("limit", String(options?.limit));
      const qs = params.toString();
      return request(`/api/settings/coordinator-training-jobs${qs ? `?${qs}` : ""}`) as Promise<{
        filters: TrainingJobQueryFilters;
        totalArtifacts: number;
        matched: number;
        returned: number;
        items: TrainingJobSummary[];
      }>;
    },
    exportJobs: (options?: {
      scope?: "all" | "filtered" | "program" | "job";
      program?: string;
      programs?: string[] | string;
      jobId?: string;
      q?: string;
      signal?: TrainingJobSignal;
      transport?: TrainingJobTransport;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) =>
      request("/api/settings/coordinator-training-jobs/export", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }) as Promise<{
        ok: boolean;
        suggestedFileName: string;
        export: TrainingJobExportPayload;
      }>,
    exportTrainingDataZip: (options?: {
      scope?: "all" | "filtered" | "program" | "job" | "selected";
      program?: string;
      programs?: string[] | string;
      jobId?: string;
      jobIds?: string[] | string;
      q?: string;
      signal?: TrainingJobSignal;
      transport?: TrainingJobTransport;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) =>
      requestBinary("/api/settings/coordinator-training-files/export", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }),
    importTrainingDataZip: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return request("/api/settings/coordinator-training-files/import", {
        method: "POST",
        body: form,
      }) as Promise<{
        ok: boolean;
        summary: {
          writtenCount: number;
          skippedCount: number;
          metadataImportedCount: number;
        };
      }>;
    },
    exportSnapshot: (includeServerFiles = false) =>
      request("/api/settings/config-snapshot/export", {
        method: "POST",
        body: JSON.stringify({ includeServerFiles }),
      }) as Promise<{
        ok: boolean;
        suggestedFileName: string;
        snapshot: ConfigSnapshot;
        summary: {
          tables: Record<string, number>;
          trainingFileCount: number;
          trainingSkippedCount: number;
          serverFileCount: number;
          serverSkippedCount: number;
        };
      }>,
    importSnapshot: (snapshot: ConfigSnapshot, includeServerFiles = false) =>
      request("/api/settings/config-snapshot/import", {
        method: "POST",
        body: JSON.stringify({ snapshot, includeServerFiles }),
      }) as Promise<{
        ok: boolean;
        summary: {
          importedTableCounts: Record<string, number>;
          trainingWriteCount: number;
          trainingWriteErrors: Array<{ path: string; reason: string }>;
          serverWriteCount: number;
          serverWriteErrors: Array<{ path: string; reason: string }>;
        };
      }>,
    exportSnapshotZip: (includeServerFiles = false) =>
      requestBinary("/api/settings/config-snapshot/export-zip", {
        method: "POST",
        body: JSON.stringify({ includeServerFiles }),
      }),
    listCoordinatorScripts: () =>
      request("/api/settings/coordinator-scripts") as Promise<{
        scripts: Array<{
          program: string;
          content: string;
          isDefault: boolean;
          defaultContent: string;
        }>;
      }>,
    updateCoordinatorScript: (program: string, content: string) =>
      request(`/api/settings/coordinator-scripts/${encodeURIComponent(program)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }) as Promise<{ ok: boolean }>,
    deleteCoordinatorScript: (program: string) =>
      request(`/api/settings/coordinator-scripts/${encodeURIComponent(program)}`, {
        method: "DELETE",
      }) as Promise<{ ok: boolean }>,
    getTrainingSchedule: () =>
      request("/api/settings/coordinator-training-schedule") as Promise<{
        schedule: {
          enabled: boolean;
          intervalMinutes: number;
          apply: boolean;
          programs: string[];
        };
        lastRunByProgram: Record<string, string>;
        nextRunByProgram: Record<string, string | null>;
      }>,
    setTrainingSchedule: (payload: {
      enabled?: boolean;
      intervalMinutes?: number;
      apply?: boolean;
      programs?: string[];
    }) =>
      request("/api/settings/coordinator-training-schedule", {
        method: "PUT",
        body: JSON.stringify(payload),
      }) as Promise<{
        schedule: {
          enabled: boolean;
          intervalMinutes: number;
          apply: boolean;
          programs: string[];
        };
        lastRunByProgram: Record<string, string>;
        nextRunByProgram: Record<string, string | null>;
      }>,
    runTraining: (options?: { programs?: string[]; sourcePaths?: string[] }) =>
      request("/api/settings/coordinator-training/run-now", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }) as Promise<{
        ok: boolean;
        orchestratorJobId?: string;
        job?: { id: string; status: string };
      }>,
    // Housekeeping
    getHousekeepingSchedule: () =>
      request("/api/settings/housekeeping-schedule") as Promise<{
        enabled: boolean;
        intervalMinutes: number;
        lastRunAt?: string;
      }>,
    setHousekeepingSchedule: (payload: { enabled?: boolean; intervalMinutes?: number }) =>
      request("/api/settings/housekeeping-schedule", {
        method: "PUT",
        body: JSON.stringify(payload),
      }) as Promise<{ ok: boolean }>,
    runHousekeeping: () =>
      request("/api/settings/housekeeping/run-now", { method: "POST" }) as Promise<{ jobId: string }>,
    importSnapshotZip: (file: File, includeServerFiles = false) => {
      const form = new FormData();
      form.append("file", file);
      form.append("includeServerFiles", includeServerFiles ? "true" : "false");
      return request("/api/settings/config-snapshot/import-zip", {
        method: "POST",
        body: form,
      }) as Promise<{
        ok: boolean;
        summary: {
          importedTableCounts: Record<string, number>;
          trainingWriteCount: number;
          trainingWriteErrors: Array<{ path: string; reason: string }>;
          serverWriteCount: number;
          serverWriteErrors: Array<{ path: string; reason: string }>;
        };
      }>;
    },
  },

  audit: {
    list: (opts?: {
      limit?: number;
      offset?: number;
      userId?: string;
      action?: string;
    }) => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      if (opts?.userId) params.set("userId", opts.userId);
      if (opts?.action) params.set("action", opts.action);
      const qs = params.toString();
      return request(`/api/audit-log${qs ? `?${qs}` : ""}`);
    },
  },

  skills: {
    list: (program?: string, category?: string, source?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      if (category) params.set("category", category);
      if (source) params.set("source", source);
      const qs = params.toString();
      return request(`/api/skills${qs ? `?${qs}` : ""}`) as Promise<any>;
    },
    get: (slug: string, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`) as Promise<any>;
    },
    search: (query: string, program?: string, category?: string) =>
      request("/api/skills/search", {
        method: "POST",
        body: JSON.stringify({ query, program, category }),
      }) as Promise<any>,
    create: (skill: { name: string; slug: string; program: string; category: string; title: string; description: string; keywords: string[]; content: string; priority?: number; autoFetch?: boolean; enabled?: boolean }) =>
      request("/api/skills", {
        method: "POST",
        body: JSON.stringify(skill),
      }) as Promise<any>,
    delete: (slug: string, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`, { method: "DELETE" }) as Promise<any>;
    },
    refreshIndex: () =>
      request("/api/skills/refresh-index", { method: "POST" }) as Promise<any>,
    registry: () =>
      request("/api/skills/registry") as Promise<any>,
    install: (skill: { slug: string; program: string; sourceUrl?: string }) =>
      request("/api/skills/install", { method: "POST", body: JSON.stringify(skill) }) as Promise<any>,
    pullProgram: (program: string) =>
      request(`/api/skills/pull/${encodeURIComponent(program)}`, { method: "POST" }) as Promise<any>,
    pullAll: () =>
      request("/api/skills/pull-all", { method: "POST" }) as Promise<any>,
    getPlaybookContent: (slug: string, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}/playbook-content${qs ? `?${qs}` : ""}`) as Promise<any>;
    },
    update: (slug: string, updates: Record<string, any>, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },
    listVersions: (slug: string, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}/versions${qs ? `?${qs}` : ""}`) as Promise<{ versions: Array<{ id: string; version: number; content: string; keywords: string[]; description: string; createdAt: string }>; currentVersion: number }>;
    },
    rollback: (slug: string, version: number, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}/rollback${qs ? `?${qs}` : ""}`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
    },
    deleteVersion: (slug: string, version: number, program?: string) => {
      const params = new URLSearchParams();
      if (program) params.set("program", program);
      const qs = params.toString();
      return request(`/api/skills/${encodeURIComponent(slug)}/versions/${version}${qs ? `?${qs}` : ""}`, {
        method: "DELETE",
      });
    },
    export: async (opts?: { program?: string; category?: string; source?: string; slugs?: string[] }) => {
      const body: Record<string, any> = {};
      if (opts?.program) body.program = opts.program;
      if (opts?.category) body.category = opts.category;
      if (opts?.source) body.source = opts.source;
      if (opts?.slugs && opts.slugs.length > 0) body.slugs = opts.slugs;
      return requestBinary("/api/skills/export-zip", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    importZip: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return request("/api/skills/import", { method: "POST", body: form }) as Promise<any>;
    },
    batchEffectiveness: (skillIds: string[]) =>
      request("/api/skills/batch-effectiveness", {
        method: "POST",
        body: JSON.stringify({ skillIds }),
      }) as Promise<{ stats: Record<string, { totalUsed: number; goodOutcomes: number; averageOutcomes: number; poorOutcomes: number; pendingOutcomes: number; successRate: number }> }>,
    getRankingConfig: () =>
      request("/api/skills/ranking-config") as Promise<{
        config: Record<string, number>;
        defaults: Record<string, number>;
      }>,
    updateRankingConfig: (updates: Record<string, number>) =>
      request("/api/skills/ranking-config", {
        method: "PUT",
        body: JSON.stringify(updates),
      }) as Promise<{ ok: boolean; updated: string[]; config: Record<string, number> }>,
    resetRankingConfig: () =>
      request("/api/skills/ranking-config/reset", { method: "POST" }) as Promise<{ ok: boolean; config: Record<string, number> }>,
  },

  templates: {
    list: (type?: string, category?: string) => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (category) params.set("category", category);
      const qs = params.toString();
      return request(`/api/templates${qs ? `?${qs}` : ""}`);
    },
    get: (id: string) => request(`/api/templates/${id}`),
    create: (data: any) =>
      request("/api/templates", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request(`/api/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request(`/api/templates/${id}`, { method: "DELETE" }),
    categories: (type?: string) => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      const qs = params.toString();
      return request(`/api/templates/categories${qs ? `?${qs}` : ""}`);
    },
    seed: () =>
      request("/api/templates/seed", { method: "POST" }),
  },

  system: {
    factoryReset: (password: string, confirmation: string, clearTrainingData = false) =>
      request("/api/settings/factory-reset", {
        method: "POST",
        body: JSON.stringify({ password, confirmation, clearTrainingData }),
      }),
    getConfig: () =>
      request("/api/settings/system-config") as Promise<{
        jobTimeoutMs: number;
        maxConcurrentAgents: number;
        logLevel: string;
        workerPollMs: number;
        defaultWorkspaceMode: string;
        wsMaxPayloadMb: number;
      }>,
    updateConfig: (updates: Record<string, string | number>) =>
      request("/api/settings/system-config", {
        method: "PUT",
        body: JSON.stringify(updates),
      }) as Promise<{ ok: boolean; updated: string[]; config: Record<string, string | number> }>,
  },
};
