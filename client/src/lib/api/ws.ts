import { Message } from "@arkestrator/protocol";
import { invoke } from "@tauri-apps/api/core";
import { connection } from "../stores/connection.svelte";
import { jobs } from "../stores/jobs.svelte";
import { agents } from "../stores/agents.svelte";
import { workersStore } from "../stores/workers.svelte";
import { bridgeContextStore } from "../stores/bridgeContext.svelte";
import { chatStore } from "../stores/chat.svelte";
import { clientCoordination } from "../stores/clientCoordination.svelte";
import { api } from "./rest";
import {
  setWsSend,
  handleJobDispatch,
  handleToolResult,
  handleJobCancel,
  handleDisconnect,
} from "../services/clientJobManager.js";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activeJobPollTimer: ReturnType<typeof setInterval> | null = null;
let statusReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalDisconnect = false;
let wsGeneration = 0;
const BASE_DELAY = 3000;
const MAX_DELAY = 30000;
let currentDelay = BASE_DELAY;
const API_KEY_PATTERN = /^ark_[a-f0-9]{48}$/i;

/** Cached machine identity (hostname + osUser + machineId) from Tauri. */
let cachedMachineIdentity: { hostname: string; osUser: string; machineId: string } | null = null;

function normalizeWorkerIdentity(value: string | undefined | null): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

/** Initialize machine identity from Tauri. Call once at app startup. */
export async function initMachineIdentity() {
  try {
    cachedMachineIdentity = await invoke<{ hostname: string; osUser: string; machineId: string }>("get_machine_identity");
  } catch (err) {
    console.warn("[ws] Failed to get machine identity:", err);
  }
}

export function isLocalWorker(workerName?: string | null, machineId?: string | null): boolean {
  const localMachineId = String(cachedMachineIdentity?.machineId ?? "").trim().toLowerCase();
  const remoteMachineId = String(machineId ?? "").trim().toLowerCase();
  if (localMachineId && remoteMachineId) {
    return localMachineId === remoteMachineId;
  }
  const local = normalizeWorkerIdentity(cachedMachineIdentity?.hostname);
  const remote = normalizeWorkerIdentity(workerName);
  return !!local && local === remote;
}

function isValidApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(String(value ?? "").trim());
}

function mergeOfflineBridgeHistory(onlineBridges: any[]): any[] {
  const online = Array.isArray(onlineBridges) ? onlineBridges : [];
  const byWorkerProgram = new Set<string>();
  for (const bridge of online) {
    const worker = String(bridge?.machineId ?? bridge?.workerName ?? "").trim().toLowerCase();
    const program = String(bridge?.program ?? "").trim().toLowerCase();
    if (!worker || !program) continue;
    byWorkerProgram.add(`${worker}:${program}`);
  }

  const offline: any[] = [];
  for (const worker of workersStore.workers) {
      const workerName = String(worker?.name ?? "").trim();
      if (!workerName) continue;
      const lowerWorker = String(worker?.machineId ?? workerName).trim().toLowerCase();
      const knownPrograms = Array.isArray(worker?.knownPrograms) ? worker.knownPrograms : [];
      for (const programRaw of knownPrograms) {
      const program = String(programRaw ?? "").trim();
      if (!program) continue;
      const key = `${lowerWorker}:${program.toLowerCase()}`;
      if (byWorkerProgram.has(key)) continue;
      offline.push({
        id: `offline:${workerName}:${program}`,
        name: `${program} (offline)`,
        type: "bridge",
        connected: false,
        lastSeen: worker.lastSeenAt,
        program,
        projectPath: worker.lastProjectPath,
        activeProjects: worker.lastProjectPath ? [worker.lastProjectPath] : [],
        machineId: worker.machineId,
        workerName,
        osUser: undefined,
      });
    }
  }

  return [...online, ...offline];
}

function applyBridgeStatus(payload: any) {
  const online = Array.isArray(payload?.bridges)
    ? payload.bridges.filter((b: any) => b?.connected !== false)
    : [];
  workersStore.bridges = mergeOfflineBridgeHistory(online);
}

function applyWorkerStatus(payload: any) {
  if (!Array.isArray(payload?.workers)) return;
  workersStore.workers = payload.workers;
  // Rebuild offline history against current online bridge snapshot so worker
  // additions appear immediately even if bridge_status is delayed/missed.
  const onlineNow = workersStore.bridges.filter((b) => b?.connected !== false);
  workersStore.bridges = mergeOfflineBridgeHistory(onlineNow);
  scheduleStatusReconcile(150);
}

function scheduleStatusReconcile(delayMs = 250) {
  if (statusReconcileTimer) return;
  statusReconcileTimer = setTimeout(() => {
    statusReconcileTimer = null;
    if (connection.status === "connected") {
      requestStatus();
    }
  }, delayMs);
}

function dispatchStatusFallback(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (raw.type === "bridge_status" && Array.isArray(raw?.payload?.bridges)) {
    applyBridgeStatus(raw.payload);
    return true;
  }
  if (raw.type === "worker_status" && Array.isArray(raw?.payload?.workers)) {
    applyWorkerStatus(raw.payload);
    return true;
  }
  return false;
}

export async function connect(url: string, apiKey: string) {
  // Close an existing socket without allowing its late onclose callback
  // to schedule reconnects for a newer connection.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeJobPollTimer) {
    clearInterval(activeJobPollTimer);
    activeJobPollTimer = null;
  }
  if (statusReconcileTimer) {
    clearTimeout(statusReconcileTimer);
    statusReconcileTimer = null;
  }
  if (ws) {
    intentionalDisconnect = true;
    const old = ws;
    ws = null;
    old.close();
  }

  intentionalDisconnect = false;
  wsGeneration++;
  const generation = wsGeneration;
  connection.status = "connecting";
  connection.url = url;
  connection.apiKey = apiKey;
  connection.save();

  // Ensure machine identity is available before connecting.
  // initMachineIdentity() is normally called at app startup, but if we race
  // the connect call we retry synchronously here then build the URL.
  if (!cachedMachineIdentity) {
    try {
      cachedMachineIdentity = await invoke<{ hostname: string; osUser: string; machineId: string }>("get_machine_identity");
    } catch { /* best effort */ }
  }

  // Build WS URL with machine identity so the server can register this
  // client as a worker (bridges from the same machine inherit this identity)
  let wsUrl = `${url.replace(/^http/, "ws")}/ws?type=client`;
  if (cachedMachineIdentity) {
    if (cachedMachineIdentity.machineId) wsUrl += `&machineId=${encodeURIComponent(cachedMachineIdentity.machineId)}`;
    if (cachedMachineIdentity.hostname) wsUrl += `&workerName=${encodeURIComponent(cachedMachineIdentity.hostname)}`;
    if (cachedMachineIdentity.osUser) wsUrl += `&osUser=${encodeURIComponent(cachedMachineIdentity.osUser)}`;
  }
  wsUrl += `&workerMode=${connection.workerModeEnabled ? "true" : "false"}`;
  const authProtocol = `arkestrator.auth.${apiKey}`;
  const socket = new WebSocket(wsUrl, [authProtocol]);
  ws = socket;

  socket.onopen = () => {
    if (socket !== ws || generation !== wsGeneration) return;
    connection.status = "connected";
    connection.lastError = "";
    currentDelay = BASE_DELAY;
    // Wire up client job manager WS send
    setWsSend(sendMessage);
    requestInitialData();
    // Write API key to local shared config (~/.arkestrator/config.json, with legacy mirror)
    writeLocalConfig(url, apiKey);
    // Poll job list every 10s while there are active jobs (catches missed job_updated messages)
    if (activeJobPollTimer) clearInterval(activeJobPollTimer);
    activeJobPollTimer = setInterval(() => {
      if (jobs.all.some((j) => j.status === "running" || j.status === "queued")) {
        sendMessage({ type: "job_list", id: crypto.randomUUID(), payload: {} });
      }
    }, 10_000);
  };

  socket.onmessage = (event) => {
    if (socket !== ws || generation !== wsGeneration) return;
    try {
      const raw = JSON.parse(event.data);
      const parsed = Message.safeParse(raw);
      if (parsed.success) {
        dispatch(parsed.data);
      } else if (dispatchStatusFallback(raw)) {
        console.warn(
          "[ws] Applied status fallback dispatch after schema validation failure:",
          raw?.type,
          parsed.error.issues,
        );
      } else {
        console.warn("[ws] Message failed schema validation for type:", raw?.type, parsed.error.issues, raw);
      }
    } catch (err) {
      console.warn("[ws] Failed to parse WS message:", err);
    }
  };

  socket.onclose = () => {
    if (socket !== ws || generation !== wsGeneration) return;
    connection.status = "disconnected";
    ws = null;
    handleDisconnect(); // Fail any running client-dispatched jobs
    if (activeJobPollTimer) {
      clearInterval(activeJobPollTimer);
      activeJobPollTimer = null;
    }
    if (statusReconcileTimer) {
      clearTimeout(statusReconcileTimer);
      statusReconcileTimer = null;
    }
    if (!intentionalDisconnect) {
      scheduleReconnect();
    }
  };

  socket.onerror = () => {
    if (socket !== ws || generation !== wsGeneration) return;
    connection.status = "error";
    connection.lastError = "WebSocket connection error";
  };
}

export function autoConnect() {
  const saved = connection.loadSaved();
  if (saved.url && saved.apiKey) {
    connect(saved.url, saved.apiKey);
  }
}

export function disconnect() {
  intentionalDisconnect = true;
  wsGeneration++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeJobPollTimer) {
    clearInterval(activeJobPollTimer);
    activeJobPollTimer = null;
  }
  if (statusReconcileTimer) {
    clearTimeout(statusReconcileTimer);
    statusReconcileTimer = null;
  }
  const socket = ws;
  ws = null;
  socket?.close();
  connection.status = "disconnected";
}

export function sendMessage(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Request bridge and worker status from server via REST (fallback for WS push) */
export function requestStatus() {
  if (!connection.url) return;
  const headers: Record<string, string> = {};
  if (connection.sessionToken) {
    headers["Authorization"] = `Bearer ${connection.sessionToken}`;
  } else if (connection.apiKey) {
    headers["Authorization"] = `Bearer ${connection.apiKey}`;
  }
  // Workers REST endpoint returns { workers, bridges }
  fetch(`${connection.url}/api/workers`, { headers })
    .then((r) => r.ok ? r.json() : null)
    .then((data: any) => {
      if (!data) return;
      // Handle both new shape { workers, bridges } and legacy flat array
      if (data.workers && Array.isArray(data.workers)) {
        workersStore.workers = data.workers;
      } else if (Array.isArray(data)) {
        workersStore.workers = data;
      }
      if (data.bridges && Array.isArray(data.bridges)) {
        workersStore.bridges = mergeOfflineBridgeHistory(
          data.bridges.filter((b: any) => b?.connected !== false),
        );
      } else {
        // Keep offline history aligned with latest worker snapshot.
        workersStore.bridges = mergeOfflineBridgeHistory(
          workersStore.bridges.filter((b) => b?.connected !== false),
        );
      }
    })
    .catch(() => {});
}

async function requestInitialData() {
  sendMessage({
    type: "job_list",
    id: crypto.randomUUID(),
    payload: {},
  });
  sendMessage({
    type: "agent_config_list",
    id: crypto.randomUUID(),
    payload: {},
  });

  // Fetch workers via REST as fallback (server also pushes via WS on connect)
  requestStatus();

  // Validate saved session on reconnect
  if (connection.sessionToken) {
    try {
      const user = await api.auth.me();
      connection.username = user.username;
      connection.userRole = user.role;
      connection.allowClientCoordination = !!user.allowClientCoordination;
      connection.clientCoordinationEnabled = !!user.clientCoordinationEnabled;
      connection.canEditCoordinator = !!user.canEditCoordinator;
      connection.saveSession();
      if (connection.allowClientCoordination) {
        clientCoordination.probeIfStale();
      }
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      // Keep session on transient/network errors; only clear on auth failure.
      if (msg.startsWith("401:") || msg.startsWith("403:")) {
        connection.clearSession();
      }
    }
  }
}

async function handleWorkerHeadlessCommand(payload: any) {
  const correlationId = String(payload?.correlationId ?? "").trim();
  const program = String(payload?.program ?? "").trim();
  if (!correlationId || !program) {
    return;
  }

  try {
    const result = await invoke("run_worker_headless", { input: payload });
    sendMessage({
      type: "worker_headless_result",
      id: crypto.randomUUID(),
      payload: { ...(result as Record<string, unknown>), correlationId },
    });
  } catch (err: any) {
    sendMessage({
      type: "worker_headless_result",
      id: crypto.randomUUID(),
      payload: {
        correlationId,
        program,
        success: false,
        executed: 0,
        failed: 1,
        skipped: 0,
        errors: [String(err?.message ?? err ?? "Headless execution failed")],
        headless: true,
      },
    });
  }
}

function dispatch(msg: any) {
  switch (msg.type) {
    case "job_list_response":
      jobs.replaceAll(msg.payload.jobs);
      break;
    case "job_updated": {
      const job = msg.payload.job;
      // Capture previous status BEFORE upserting so we can detect transitions
      const prevJob = jobs.all.find((j) => j.id === job.id);
      const prevStatus = prevJob?.status;
      jobs.upsert(job);

      // A job is a sub-job if it has a parentJobId, regardless of how we find the tab.
      const isSubJob = !!job.parentJobId;

      // Find the chat tab that owns this job (direct or via parent)
      let ownerTab = chatStore.findTabByJobId(job.id);

      if (!ownerTab && job.parentJobId) {
        ownerTab = chatStore.findTabByJobId(job.parentJobId);
        if (ownerTab) {
          // Register the sub-job in the parent tab for future direct lookups
          chatStore.trackJobInTab(ownerTab.id, job.id);
        }
      }

      if (ownerTab) {
        const isTerminal = ["completed", "failed", "cancelled"].includes(job.status);
        const justReachedTerminal = isTerminal && prevStatus !== job.status;
        const label = job.name ?? `#${job.id.slice(0, 8)}`;
        const usedPrograms = Array.isArray(job.usedBridges)
          ? [...new Set(job.usedBridges.map((value: unknown) => String(value ?? "").trim()).filter(Boolean))]
          : [];
        const program = usedPrograms.length > 0 ? ` (${usedPrograms.join(", ")})` : "";
        // Only emit "running" on the transition, not on every update while already running
        const justStartedRunning = job.status === "running" && prevStatus !== "running";

        let content: string | null = null;
        if (isSubJob) {
          if (justReachedTerminal) {
            content = `Sub-job ${job.status}: ${label}${program}${job.error ? " \u2014 " + job.error : ""}`;
          } else if (justStartedRunning) {
            content = `Sub-job running: ${label}${program}`;
          }
        }

        if (content) {
          chatStore.addMessageToTabByJobId(job.id, {
            id: crypto.randomUUID(),
            role: "system",
            content,
            timestamp: new Date().toISOString(),
            jobId: job.id,
          });
        }
      }
      break;
    }
    case "job_log":
      jobs.appendLog(msg.payload.jobId, msg.payload.text);
      break;
    case "job_intervention_updated":
      jobs.upsertIntervention(msg.payload.jobId, msg.payload.intervention);
      {
        const ownerTab = chatStore.findTabByJobId(msg.payload.jobId);
        if (ownerTab) {
          const intervention = msg.payload.intervention;
          const state = intervention.status === "pending"
            ? "queued for next turn"
            : intervention.status;
          chatStore.addMessageToTabByJobId(msg.payload.jobId, {
            id: crypto.randomUUID(),
            role: "system",
            content: `Operator note ${state}: ${intervention.text}`,
            timestamp: new Date().toISOString(),
            jobId: msg.payload.jobId,
          });
        }
      }
      break;
    case "job_started":
    case "job_complete":
    case "job_accepted":
    case "job_dependency_blocked":
      // These events are now accompanied by job_updated, no re-fetch needed
      break;
    case "agent_config_list_response":
      agents.all = msg.payload.configs;
      break;
    case "bridge_status":
      applyBridgeStatus(msg.payload);
      break;
    case "worker_status":
      applyWorkerStatus(msg.payload);
      break;
    case "bridge_command_result":
      break;
    case "worker_headless_command":
      void handleWorkerHeadlessCommand(msg.payload);
      break;
    case "client_job_dispatch":
      handleJobDispatch(msg.payload);
      break;
    case "client_tool_result":
      handleToolResult(msg.payload);
      break;
    case "client_job_cancel":
      handleJobCancel(msg.payload);
      break;
    case "worker_headless_result":
      break;
    case "bridge_context_sync":
      bridgeContextStore.sync(msg.payload.bridges);
      break;
    case "bridge_context_item_add":
      bridgeContextStore.addItem(
        msg.payload.bridgeId,
        msg.payload.bridgeName,
        msg.payload.program,
        msg.payload.item,
      );
      break;
    case "bridge_context_clear":
      bridgeContextStore.clear(msg.payload.bridgeId);
      break;
    case "bridge_editor_context":
      bridgeContextStore.setEditorContext(
        msg.payload.bridgeId,
        msg.payload.bridgeName,
        msg.payload.program,
        msg.payload.editorContext,
        msg.payload.files ?? [],
      );
      break;
    case "file_deliver":
      void handleFileDeliver(msg.payload);
      break;
    case "error":
      connection.lastError = `${msg.payload.code}: ${msg.payload.message}`;
      break;
  }
}

/** Handle incoming file delivery from the server (cross-machine asset transfer). */
async function handleFileDeliver(payload: {
  files?: Array<{
    path: string;
    content?: string;
    binaryContent?: string;
    encoding?: string;
    action: string;
  }>;
  projectPath?: string;
}) {
  const files = payload.files;
  if (!Array.isArray(files) || files.length === 0) return;

  // If a projectPath is specified, resolve file paths relative to it.
  const resolvedFiles = files.map((f) => {
    if (payload.projectPath && !f.path.startsWith("/") && !f.path.match(/^[A-Za-z]:\\/)) {
      // Relative path — prepend projectPath
      const sep = payload.projectPath.includes("\\") ? "\\" : "/";
      return { ...f, path: `${payload.projectPath}${sep}${f.path}` };
    }
    return f;
  });

  try {
    const applied = await invoke<string[]>("fs_apply_file_changes", { changes: resolvedFiles });
    console.log(`[file_deliver] Applied ${applied.length} file change(s)`);
  } catch (err) {
    console.error("[file_deliver] Failed to apply file changes:", err);
  }
}

/** Write bridge-facing shared config for local bridge auto-discovery.
 *
 * In remote mode the Tauri side writes localhost relay URLs for bridges while
 * preserving the real remote server URLs in auxiliary config fields.
 */
async function writeLocalConfig(url: string, apiKey: string) {
  try {
    if (!isValidApiKey(apiKey)) {
      console.warn("[config] Refusing to overwrite shared config with malformed API key");
      return;
    }
    const serverUrl = url.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
    const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws";
    const workerName = String(cachedMachineIdentity?.hostname ?? "").trim();
    const machineId = String(cachedMachineIdentity?.machineId ?? "").trim();
    await invoke("write_shared_config", { serverUrl, wsUrl, apiKey, machineId, workerName });
  } catch (err) {
    console.warn("[config] Failed to write local shared config:", err);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  // Add jitter (0-25% of current delay) to prevent thundering herd
  const jitter = Math.random() * currentDelay * 0.25;
  const delay = currentDelay + jitter;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (connection.url && connection.apiKey) {
      connect(connection.url, connection.apiKey);
    }
    currentDelay = Math.min(currentDelay * 1.5, MAX_DELAY);
  }, delay);
}
