import type { ServerWebSocket } from "bun";
import type { ContextItem, EditorContext } from "@arkestrator/protocol";
import type { ApiKeyRole } from "../db/apikeys.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { ApiBridgesRepo } from "../db/api-bridges.repo.js";
import type { SettingsRepo } from "../db/settings.repo.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/id.js";
import { enrichWorkersWithLivePresence } from "../utils/worker-status.js";
import { ensureLiveWorkersPersisted } from "../utils/live-workers.js";
import { buildServerWorkerAndBridges } from "../utils/server-worker-bridges.js";
import { hostname } from "node:os";

export interface WsData {
  id: string;
  role: ApiKeyRole;
  type: "bridge" | "client";
  name?: string;
  connectedAt: string;
  program?: string;
  programVersion?: string;
  bridgeVersion?: string;
  projectPath?: string;
  activeProjects?: string[];
  machineId?: string;
  workerName?: string;
  ip?: string;
  osUser?: string;
  workerMode?: boolean;
  localLlmEnabled?: boolean;
  lastPongAt?: number;
  /** Set to true when a ping is sent; cleared when a pong is received. */
  awaitingPong?: boolean;
  /** Timestamp of the last application-level message received from this connection. */
  lastMessageAt?: number;
}

export interface WorkerHeadlessCapability {
  program: string;
  executable: string;
  argsTemplate: string[];
  language: string;
  version?: string;
}

export interface BridgeContextState {
  items: ContextItem[];
  nextIndex: number;
  editorContext?: EditorContext;
  files: Array<{ path: string; content: string }>;
}

export interface VirtualBridgeData {
  id: string;
  program: string;
  programVersion?: string;
  connectedAt: string;
  url: string;
  workerName?: string;
  machineId?: string;
  ip?: string;
}

/**
 * Unified bridge view used by agent-facing tools (list_bridges, get_bridge_context, etc.).
 * Covers all three kinds of bridges so agents always see the complete set:
 *  - "ws":       real WebSocket bridge (Godot / Blender / Houdini / Fusion / ...)
 *  - "virtual":  HTTP-polled service (e.g. ComfyUI) registered via registerVirtualBridge
 *  - "api":      enabled API bridge on the synthetic "Arkestrator Server" worker (e.g. Meshy)
 *
 * Virtual and API bridges have no editor context — callers must handle `hasEditorContext: false`.
 * Virtual and API bridges cannot execute arbitrary scripts via bridge_command — callers must
 * route through the appropriate MCP tool (comfyui_*, invoke_api_bridge, etc.).
 */
export interface AgentBridgeView {
  id: string;
  kind: "ws" | "virtual" | "api";
  program: string;
  programVersion?: string;
  bridgeVersion?: string;
  workerName?: string;
  machineId?: string;
  ip?: string;
  projectPath?: string;
  activeProjects?: string[];
  connectedAt?: string;
  /** Virtual bridges expose their HTTP endpoint here (e.g. http://192.168.1.5:8188). */
  url?: string;
  /** API bridges expose their available actions (e.g. ["text_to_3d", "image_to_3d"]). */
  apiActions?: string[];
  /** True only for real WS bridges that report editor context. */
  hasEditorContext: boolean;
  /** True for real WS bridges — can receive bridge_command. Virtual/API cannot. */
  canExecuteBridgeCommands: boolean;
  /** Human-readable hint about how to use this bridge when canExecuteBridgeCommands is false. */
  usageHint?: string;
}

/** Pending bridge command registered via registerPendingCommand. */
interface PendingCommandEntry {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** Connection ID of the bridge the command was sent to, for cancel on timeout. */
  targetBridgeId?: string;
}

/** Circuit breaker state for bridges that reconnect too frequently. */
interface FlapState {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

/** Metrics counters for observability. Opaque integers reset by reader. */
export interface HubMetrics {
  broadcastsSent: number;
  broadcastsDropped: number;
  backpressureEvents: number;
  pendingCommandsTimedOut: number;
  pendingCommandsCancelled: number;
  bridgesFlapBlocked: number;
  virtualBridgesExpired: number;
  messagesRejectedOversize: number;
  staleConnectionsRemoved: number;
}

export class WebSocketHub {
  private connections = new Map<string, ServerWebSocket<WsData>>();
  private pendingCommands = new Map<string, PendingCommandEntry>();
  private bridgeContexts = new Map<string, BridgeContextState>();
  /** Job log subscriptions: jobId → Set of connection IDs actively viewing that job */
  private logSubscriptions = new Map<string, Set<string>>();
  // Tracks last replacement time per "program/workerName/projectPath" key for rapid-reconnect detection
  private lastReplacementTime = new Map<string, number>();
  /** Circuit breaker: reconnect frequency per identity key. */
  private flapStates = new Map<string, FlapState>();
  /** Virtual bridges' last heartbeat timestamps (ms). Expired on sweep. */
  private virtualBridgeHeartbeats = new Map<string, number>();
  /** Aggregated metrics counters. */
  private metrics: HubMetrics = {
    broadcastsSent: 0,
    broadcastsDropped: 0,
    backpressureEvents: 0,
    pendingCommandsTimedOut: 0,
    pendingCommandsCancelled: 0,
    bridgesFlapBlocked: 0,
    virtualBridgesExpired: 0,
    messagesRejectedOversize: 0,
    staleConnectionsRemoved: 0,
  };
  /** Max reconnects allowed per identity in FLAP_WINDOW_MS before blocking. */
  private static readonly FLAP_MAX_RECONNECTS = 5;
  private static readonly FLAP_WINDOW_MS = 60_000;
  private static readonly FLAP_BLOCK_MS = 5 * 60_000;
  /** Virtual bridge TTL — expire heartbeats older than this. */
  private static readonly VIRTUAL_BRIDGE_TTL_MS = 5 * 60_000;
  /** Per-worker headless capabilities reported by desktop clients. Keyed by normalized workerKey. */
  private workerHeadlessCapabilities = new Map<string, WorkerHeadlessCapability[]>();
  /** Virtual bridges: HTTP-based services (e.g. ComfyUI) that appear in bridge status without WebSocket. */
  private virtualBridges = new Map<string, VirtualBridgeData>();
  /** Server's own hostname, resolved once at startup for stable virtual bridge identity. */
  private readonly serverHostname = hostname().toLowerCase();
  /**
   * Optional refs used to synthesize the "Arkestrator Server" virtual worker
   * and its api-bridge entries in broadcasts. Wired up from index.ts after
   * construction so WS `bridge_status` / `worker_status` stay consistent with
   * the REST `/api/workers` response (previously WS omitted these, causing
   * the server bridge to flicker in/out of the client UI).
   */
  private apiBridgesRepo?: ApiBridgesRepo;
  private settingsRepo?: SettingsRepo;

  // --- Secondary indexes for O(1) lookups at scale ---
  /** program (lowercase) → Set of connection IDs. Updated on register/unregister. */
  private bridgesByProgram = new Map<string, Set<string>>();
  /** "program/workerKey/project" → connection ID. For O(1) duplicate detection. */
  private bridgeIdentityIndex = new Map<string, string>();
  private static readonly MAX_ACTIVE_PROJECTS = 8;

  private normalizeProjectPath(projectPath?: string | null): string | undefined {
    if (typeof projectPath !== "string") return undefined;
    const trimmed = projectPath.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private upsertProjectPath(data: WsData, projectPath?: string): boolean {
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) return false;

    const currentPrimary = this.normalizeProjectPath(data.projectPath);
    const currentList = Array.isArray(data.activeProjects)
      ? data.activeProjects.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];

    let changed = false;
    if (currentPrimary !== normalized) {
      data.projectPath = normalized;
      changed = true;
    }

    const reordered = [normalized, ...currentList.filter((p) => p !== normalized)]
      .slice(0, WebSocketHub.MAX_ACTIVE_PROJECTS);

    if (
      currentList.length !== reordered.length
      || currentList.some((value, idx) => value !== reordered[idx])
      || !Array.isArray(data.activeProjects)
    ) {
      data.activeProjects = reordered;
      changed = true;
    }

    return changed;
  }

  /** Record a project path against one connected bridge (id). Returns true when changed. */
  recordBridgeProjectPath(bridgeId: string, projectPath?: string): boolean {
    const ws = this.connections.get(bridgeId);
    if (!ws || ws.data.type !== "bridge") return false;
    return this.upsertProjectPath(ws.data, projectPath);
  }

  /** Record a project path for all online bridges of the specified program. */
  recordProgramProjectPath(program: string, projectPath?: string): number {
    const normalizedProgram = String(program ?? "").trim().toLowerCase();
    if (!normalizedProgram) return 0;

    let changedCount = 0;
    for (const ws of this.connections.values()) {
      if (ws.data.type !== "bridge") continue;
      if (String(ws.data.program ?? "").toLowerCase() !== normalizedProgram) continue;
      if (this.upsertProjectPath(ws.data, projectPath)) {
        changedCount++;
      }
    }
    return changedCount;
  }

  private makeBridgeIdentityKey(prog: string, workerKey: string, project: string | undefined): string {
    return `${prog}/${workerKey}/${project ?? "<none>"}`;
  }

  /**
   * Circuit breaker check: returns false if this identity has reconnected
   * too frequently and is still in its cool-off window. Call BEFORE accepting
   * a new connection for an identity. Non-bridge connections are always allowed.
   */
  checkFlapAllowed(identityKey: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const state = this.flapStates.get(identityKey);
    if (!state) return { allowed: true };
    if (state.blockedUntil > now) {
      const secs = Math.ceil((state.blockedUntil - now) / 1000);
      return { allowed: false, reason: `Bridge ${identityKey} flapping — blocked for ${secs}s` };
    }
    return { allowed: true };
  }

  /** Record a reconnect attempt and trip the circuit if the rate is too high. */
  private recordReconnect(identityKey: string) {
    const now = Date.now();
    let state = this.flapStates.get(identityKey);
    if (!state || now - state.windowStart > WebSocketHub.FLAP_WINDOW_MS) {
      state = { count: 1, windowStart: now, blockedUntil: 0 };
      this.flapStates.set(identityKey, state);
      return;
    }
    state.count++;
    if (state.count >= WebSocketHub.FLAP_MAX_RECONNECTS) {
      state.blockedUntil = now + WebSocketHub.FLAP_BLOCK_MS;
      this.metrics.bridgesFlapBlocked++;
      logger.error(
        "ws-hub",
        `Circuit breaker tripped for ${identityKey}: ${state.count} reconnects in ${Math.round((now - state.windowStart) / 1000)}s — blocked for ${WebSocketHub.FLAP_BLOCK_MS / 1000}s`,
      );
    }
  }

  register(ws: ServerWebSocket<WsData>) {
    const workerKey = String(ws.data.machineId ?? ws.data.workerName ?? "").trim().toLowerCase();
    // Kick stale duplicates only when they map to the same session identity:
    // (program, workerName, projectPath). This allows multiple concurrent sessions
    // of the same program on one worker (different project paths).
    if (ws.data.type === "bridge" && ws.data.program && workerKey) {
      const prog = ws.data.program.toLowerCase();
      const incomingProject = this.normalizeProjectPath(ws.data.projectPath);
      const identityKey = this.makeBridgeIdentityKey(prog, workerKey, incomingProject);

      // Only replace stale bridges when BOTH have a concrete project path.
      // When projectPath is empty/undefined (unsaved file), multiple instances
      // of the same program on one worker are allowed to coexist.
      const existingId = incomingProject ? this.bridgeIdentityIndex.get(identityKey) : undefined;
      if (existingId && existingId !== ws.data.id) {
        const old = this.connections.get(existingId);
        if (old) {
          const now = Date.now();
          const lastReplaced = this.lastReplacementTime.get(identityKey) ?? 0;
          const msSinceLastReplace = now - lastReplaced;
          if (lastReplaced > 0 && msSinceLastReplace < 30_000) {
            logger.warn(
              "ws-hub",
              `Rapid reconnect detected: ${old.data.program}/${old.data.workerName} ` +
              `replaced again after only ${(msSinceLastReplace / 1000).toFixed(1)}s. ` +
              `Bridge may be in a reconnect loop.`,
            );
            this.recordReconnect(identityKey);
          } else {
            logger.info(
              "ws-hub",
              `Replacing stale bridge ${existingId} (${old.data.program}/${old.data.workerName}/${incomingProject ?? "<none>"})`,
            );
          }
          this.lastReplacementTime.set(identityKey, now);
          this.removeConnectionFromIndexes(existingId, old);
          this.connections.delete(existingId);
          this.bridgeContexts.delete(existingId);
          // Use code 4001 (app-specific) so the bridge knows it was replaced
          // and should NOT trigger its reconnect logic.
          try { old.close(4001, "Replaced by new connection"); } catch {}
        }
      }

      // Update identity index
      this.bridgeIdentityIndex.set(identityKey, ws.data.id);

      // Update program index
      let progSet = this.bridgesByProgram.get(prog);
      if (!progSet) {
        progSet = new Set();
        this.bridgesByProgram.set(prog, progSet);
      }
      progSet.add(ws.data.id);
    }

    this.connections.set(ws.data.id, ws);
    if (ws.data.type === "bridge") {
      this.upsertProjectPath(ws.data, ws.data.projectPath);
    }
    logger.info(
      "ws-hub",
      `${ws.data.type} connected: ${ws.data.id} (role: ${ws.data.role})`,
    );
  }

  /** Remove a connection from secondary indexes. */
  private removeConnectionFromIndexes(id: string, ws: ServerWebSocket<WsData>) {
    if (ws.data.type === "bridge" && ws.data.program) {
      const prog = ws.data.program.toLowerCase();
      const progSet = this.bridgesByProgram.get(prog);
      if (progSet) {
        progSet.delete(id);
        if (progSet.size === 0) this.bridgesByProgram.delete(prog);
      }
      // Remove from identity index
      const wk = String(ws.data.machineId ?? ws.data.workerName ?? "").trim().toLowerCase();
      if (wk) {
        const project = this.normalizeProjectPath(ws.data.projectPath);
        const key = this.makeBridgeIdentityKey(prog, wk, project);
        if (this.bridgeIdentityIndex.get(key) === id) {
          this.bridgeIdentityIndex.delete(key);
        }
      }
    }
  }

  // -- Log subscription management ------------------------------------------

  subscribeJobLogs(connectionId: string, jobId: string) {
    let subs = this.logSubscriptions.get(jobId);
    if (!subs) {
      subs = new Set();
      this.logSubscriptions.set(jobId, subs);
    }
    subs.add(connectionId);
  }

  unsubscribeJobLogs(connectionId: string, jobId?: string) {
    if (jobId) {
      const subs = this.logSubscriptions.get(jobId);
      if (subs) {
        subs.delete(connectionId);
        if (subs.size === 0) this.logSubscriptions.delete(jobId);
      }
    } else {
      // Unsubscribe from all jobs, cleaning up empty Sets
      for (const [jid, subs] of this.logSubscriptions) {
        subs.delete(connectionId);
        if (subs.size === 0) this.logSubscriptions.delete(jid);
      }
    }
  }

  getLogSubscribers(jobId: string): string[] {
    const subs = this.logSubscriptions.get(jobId);
    return subs ? [...subs] : [];
  }

  // -------------------------------------------------------------------------

  unregister(ws: ServerWebSocket<WsData>) {
    this.removeConnectionFromIndexes(ws.data.id, ws);
    this.connections.delete(ws.data.id);
    // Clean up log subscriptions on disconnect
    this.unsubscribeJobLogs(ws.data.id);
    // Clean up bridge context when bridge disconnects
    if (ws.data.type === "bridge") {
      this.bridgeContexts.delete(ws.data.id);
      // Notify clients that this bridge's context is gone
      this.broadcastToType("client", {
        type: "bridge_context_clear",
        id: newId(),
        payload: {
          bridgeId: ws.data.id,
          program: ws.data.program,
        },
      });
    }
    // Clean up headless capabilities when a client disconnects
    if (ws.data.type === "client") {
      const workerKey = this.normalizeWorkerKey(ws.data.machineId ?? ws.data.workerName);
      if (workerKey) {
        this.workerHeadlessCapabilities.delete(workerKey);
      }
    }
    logger.info("ws-hub", `${ws.data.type} disconnected: ${ws.data.id}`);
  }

  /**
   * Backpressure-safe send. Returns true if bytes were accepted, false if the
   * socket is closed, errored, or buffered too much (slow client). Bun's
   * ws.send() returns a negative value when backpressured; we treat that as
   * a drop signal for broadcasts so one slow client can't OOM the server.
   *
   * Threshold: drop if a single send would push > 8 MB of pending writes.
   */
  private static readonly BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
  private trySend(ws: ServerWebSocket<WsData>, data: string): boolean {
    try {
      // Bun exposes bufferedAmount on ServerWebSocket.
      const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered > WebSocketHub.BACKPRESSURE_LIMIT_BYTES) {
        this.metrics.backpressureEvents++;
        logger.warn(
          "ws-hub",
          `Backpressure: dropping message for ${ws.data.type}/${ws.data.id} (buffered ${Math.round(buffered / 1024)}KB)`,
        );
        return false;
      }
      const result = ws.send(data);
      // Bun returns a negative number on backpressure
      if (typeof result === "number" && result < 0) {
        this.metrics.backpressureEvents++;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  send(id: string, message: object) {
    const ws = this.connections.get(id);
    if (ws) {
      this.trySend(ws, JSON.stringify(message));
    }
  }

  broadcast(message: object) {
    const data = JSON.stringify(message);
    let sent = 0;
    let dropped = 0;
    for (const ws of this.connections.values()) {
      if (this.trySend(ws, data)) sent++;
      else dropped++;
    }
    this.metrics.broadcastsSent += sent;
    this.metrics.broadcastsDropped += dropped;
  }

  broadcastToType(type: "bridge" | "client", message: object) {
    const data = JSON.stringify(message);
    let sent = 0;
    let dropped = 0;
    for (const ws of this.connections.values()) {
      if (ws.data.type !== type) continue;
      if (this.trySend(ws, data)) sent++;
      else dropped++;
    }
    this.metrics.broadcastsSent += sent;
    this.metrics.broadcastsDropped += dropped;
    const msgType = (message as { type?: string }).type ?? "unknown";
    if (msgType === "job_updated" || msgType === "job_complete" || msgType === "job_started") {
      logger.debug("ws-hub", `Broadcast ${msgType} to ${sent} ${type}(s)${dropped ? ` (${dropped} dropped)` : ""}`);
    }
  }

  /** Snapshot current metrics (does not reset). */
  getMetrics(): Readonly<HubMetrics> & { connections: number; bridges: number; clients: number; pendingCommands: number } {
    let bridges = 0;
    let clients = 0;
    for (const ws of this.connections.values()) {
      if (ws.data.type === "bridge") bridges++;
      else if (ws.data.type === "client") clients++;
    }
    return {
      ...this.metrics,
      connections: this.connections.size,
      bridges,
      clients,
      pendingCommands: this.pendingCommands.size,
    };
  }

  getConnection(id: string): ServerWebSocket<WsData> | undefined {
    return this.connections.get(id);
  }

  getBridges(): WsData[] {
    const bridges: WsData[] = [];
    for (const ws of this.connections.values()) {
      if (ws.data.type === "bridge") {
        bridges.push(ws.data);
      }
    }
    // Include virtual bridges as synthetic WsData entries with full identity
    for (const vb of this.virtualBridges.values()) {
      bridges.push({
        id: vb.id,
        role: "bridge",
        type: "bridge",
        name: vb.program,
        connectedAt: vb.connectedAt,
        program: vb.program,
        programVersion: vb.programVersion,
        bridgeVersion: "http-standalone",
        workerName: vb.workerName,
        machineId: vb.machineId,
        ip: vb.ip,
      });
    }
    return bridges;
  }

  getClients(): WsData[] {
    const clients: WsData[] = [];
    for (const ws of this.connections.values()) {
      if (ws.data.type === "client") {
        clients.push(ws.data);
      }
    }
    return clients;
  }

  private normalizeWorkerKey(value?: string | null): string {
    return String(value ?? "").trim().toLowerCase();
  }

  getClientConnections(): ServerWebSocket<WsData>[] {
    const clients: ServerWebSocket<WsData>[] = [];
    for (const ws of this.connections.values()) {
      if (ws.data.type === "client") {
        clients.push(ws);
      }
    }
    return clients;
  }

  getClientConnectionsByWorker(workerKey: string): ServerWebSocket<WsData>[] {
    const normalized = this.normalizeWorkerKey(workerKey);
    if (!normalized) return [];

    const clients: ServerWebSocket<WsData>[] = [];
    for (const ws of this.connections.values()) {
      if (ws.data.type !== "client") continue;
      const machineKey = this.normalizeWorkerKey(ws.data.machineId);
      const workerNameKey = this.normalizeWorkerKey(ws.data.workerName);
      if (normalized === machineKey || normalized === workerNameKey) {
        clients.push(ws);
      }
    }
    return clients;
  }

  getBridgesByProgram(program: string): ServerWebSocket<WsData>[] {
    // O(k) via program index instead of O(n) full scan
    const ids = this.bridgesByProgram.get(program.toLowerCase());
    if (!ids || ids.size === 0) return [];
    const results: ServerWebSocket<WsData>[] = [];
    for (const id of ids) {
      const ws = this.connections.get(id);
      if (ws) results.push(ws);
    }
    return results;
  }

  getAll(): WsData[] {
    return Array.from(this.connections.values()).map((ws) => ws.data);
  }

  kick(id: string): boolean {
    const ws = this.connections.get(id);
    if (!ws) return false;
    ws.close(1000, "Kicked by admin");
    this.unregister(ws);
    return true;
  }

  get size(): number {
    return this.connections.size;
  }

  /** Send a WebSocket ping to all connected clients to keep connections alive.
   *  Terminates connections that didn't respond to the previous ping, OR that
   *  haven't sent any application-level message for 2+ minutes (catches cases
   *  where Bun auto-replies to pings on half-open connections). */
  /** Remove a stale connection during pingAll — cleans up all indexes. */
  private removeStale(id: string, ws: ServerWebSocket<WsData>, reason: string) {
    logger.warn("ws-hub", `${reason}: ${ws.data.type} ${id} (${ws.data.program ?? "client"}/${ws.data.workerName ?? "?"}), removing`);
    this.metrics.staleConnectionsRemoved++;
    try { ws.close(1001, reason); } catch {}
    this.removeConnectionFromIndexes(id, ws);
    this.connections.delete(id);
    if (ws.data.type === "bridge") {
      this.bridgeContexts.delete(id);
    }
  }

  /**
   * Expire virtual bridges that haven't heartbeated within VIRTUAL_BRIDGE_TTL_MS.
   * Returns the number expired. Should be called from pingAll or a periodic sweep.
   */
  expireStaleVirtualBridges(): number {
    const now = Date.now();
    let expired = 0;
    for (const [id] of this.virtualBridges) {
      const last = this.virtualBridgeHeartbeats.get(id) ?? 0;
      if (last === 0) continue; // never heartbeated — don't auto-expire initial entries
      if (now - last > WebSocketHub.VIRTUAL_BRIDGE_TTL_MS) {
        this.virtualBridges.delete(id);
        this.virtualBridgeHeartbeats.delete(id);
        expired++;
        this.metrics.virtualBridgesExpired++;
        logger.info("ws-hub", `Virtual bridge ${id} expired (no heartbeat for ${Math.round((now - last) / 1000)}s)`);
      }
    }
    return expired;
  }

  /** Record a heartbeat for a virtual bridge (resets its TTL). */
  heartbeatVirtualBridge(id: string): boolean {
    if (!this.virtualBridges.has(id)) return false;
    this.virtualBridgeHeartbeats.set(id, Date.now());
    return true;
  }

  pingAll() {
    const now = Date.now();
    const messageStaleMs = 120_000; // 2 minutes with zero messages = dead
    let removedAny = false;
    for (const [id, ws] of this.connections) {
      // Check 1: No pong received since last ping cycle — connection is dead.
      if (ws.data.awaitingPong) {
        const lastPong = ws.data.lastPongAt;
        const age = lastPong ? Math.round((now - lastPong) / 1000) : "never";
        this.removeStale(id, ws, `Stale connection (no pong, last pong ${age}s ago)`);
        removedAny = true;
        continue;
      }
      // Check 2: No activity for 2+ minutes (no messages AND no pongs).
      const lastActivity = Math.max(ws.data.lastMessageAt ?? 0, ws.data.lastPongAt ?? 0) || now;
      if (now - lastActivity > messageStaleMs) {
        this.removeStale(id, ws, `Stale connection (no messages for ${Math.round((now - lastActivity) / 1000)}s)`);
        removedAny = true;
        continue;
      }
      try {
        ws.data.awaitingPong = true;
        ws.ping();
      } catch {
        this.removeStale(id, ws, "Ping failed");
        removedAny = true;
      }
    }
    return removedAny;
  }

  /** Update the last pong timestamp for a connection */
  recordPong(id: string) {
    const ws = this.connections.get(id);
    if (ws) {
      ws.data.lastPongAt = Date.now();
      ws.data.awaitingPong = false;
    }
  }

  /** Record that an application-level message was received from this connection. */
  recordMessage(id: string) {
    const ws = this.connections.get(id);
    if (ws) {
      ws.data.lastMessageAt = Date.now();
      // A real message proves liveness — clear awaitingPong too.
      ws.data.awaitingPong = false;
    }
  }

  // --- Virtual bridge management (HTTP-based services like ComfyUI) ---

  registerVirtualBridge(data: VirtualBridgeData): boolean {
    const existing = this.virtualBridges.get(data.id);
    if (existing) {
      // Update version but preserve original connectedAt
      existing.programVersion = data.programVersion;
      existing.url = data.url;
      this.virtualBridgeHeartbeats.set(data.id, Date.now());
      return false;
    }
    this.virtualBridges.set(data.id, data);
    this.virtualBridgeHeartbeats.set(data.id, Date.now());
    logger.info("ws-hub", `Virtual bridge registered: ${data.program} (${data.url})`);
    return true;
  }

  removeVirtualBridge(id: string): boolean {
    const removed = this.virtualBridges.delete(id);
    if (removed) {
      logger.info("ws-hub", `Virtual bridge removed: ${id}`);
    }
    return removed;
  }

  getVirtualBridge(id: string): VirtualBridgeData | undefined {
    return this.virtualBridges.get(id);
  }

  getVirtualBridges(): VirtualBridgeData[] {
    return Array.from(this.virtualBridges.values());
  }

  hasVirtualBridgeForProgram(program: string): boolean {
    const normalized = program.toLowerCase();
    for (const vb of this.virtualBridges.values()) {
      if (vb.program.toLowerCase() === normalized) return true;
    }
    return false;
  }

  /** True when an enabled API bridge (e.g. Meshy) matches the given program name. */
  hasApiBridgeForProgram(program: string): boolean {
    if (!this.apiBridgesRepo) return false;
    const normalized = program.toLowerCase();
    for (const ab of this.apiBridgesRepo.listEnabled()) {
      if (ab.name.toLowerCase() === normalized) return true;
      if (String(ab.displayName ?? "").toLowerCase() === normalized) return true;
    }
    return false;
  }

  /**
   * True when ANY kind of bridge (ws, virtual, or api) is available for the given program.
   * Use this for agent-facing availability checks so virtual/api bridges are never
   * incorrectly reported as "not connected".
   */
  hasAnyBridgeForProgram(program: string): boolean {
    return (
      this.getBridgesByProgram(program).length > 0 ||
      this.hasVirtualBridgeForProgram(program) ||
      this.hasApiBridgeForProgram(program)
    );
  }

  /**
   * Unified bridge discovery for agent-facing tools. Returns real WS bridges,
   * virtual bridges, and enabled API bridges as a single `AgentBridgeView[]`.
   * Pass a program name to filter; omit to get everything.
   *
   * This is the canonical way for MCP tools and local-agentic handlers to answer
   * "what bridges can the agent see?" — do NOT use `getBridgesByProgram` directly
   * for that purpose, since it only returns real WebSocket connections.
   */
  findAgentBridges(program?: string): AgentBridgeView[] {
    const normalized = program ? program.toLowerCase() : null;
    const results: AgentBridgeView[] = [];

    // 1. Real WS bridges (via getBridges() — excludes virtual, which we add separately)
    for (const ws of this.connections.values()) {
      if (ws.data.type !== "bridge") continue;
      const p = String(ws.data.program ?? "").toLowerCase();
      if (normalized && p !== normalized) continue;
      results.push({
        id: ws.data.id,
        kind: "ws",
        program: ws.data.program ?? "",
        programVersion: ws.data.programVersion,
        bridgeVersion: ws.data.bridgeVersion,
        workerName: ws.data.workerName,
        machineId: ws.data.machineId,
        ip: ws.data.ip,
        projectPath: ws.data.projectPath,
        activeProjects: Array.isArray(ws.data.activeProjects)
          ? ws.data.activeProjects
          : (ws.data.projectPath ? [ws.data.projectPath] : []),
        connectedAt: ws.data.connectedAt,
        hasEditorContext: true,
        canExecuteBridgeCommands: true,
      });
    }

    // 2. Virtual bridges (HTTP-polled services like ComfyUI)
    for (const vb of this.virtualBridges.values()) {
      const p = vb.program.toLowerCase();
      if (normalized && p !== normalized) continue;
      results.push({
        id: vb.id,
        kind: "virtual",
        program: vb.program,
        programVersion: vb.programVersion,
        bridgeVersion: "http-standalone",
        workerName: vb.workerName,
        machineId: vb.machineId,
        ip: vb.ip,
        connectedAt: vb.connectedAt,
        url: vb.url,
        hasEditorContext: false,
        canExecuteBridgeCommands: false,
        usageHint:
          `${vb.program} is an HTTP-only virtual bridge — it cannot receive execute_command scripts. ` +
          `Use the dedicated MCP tools for ${vb.program} (e.g. comfyui_* tools) or call its HTTP API at ${vb.url} directly.`,
      });
    }

    // 3. Enabled API bridges (e.g. Meshy on the "Arkestrator Server" worker)
    if (this.apiBridgesRepo) {
      for (const ab of this.apiBridgesRepo.listEnabled()) {
        const name = String(ab.name ?? "").toLowerCase();
        const display = String(ab.displayName ?? "").toLowerCase();
        if (normalized && name !== normalized && display !== normalized) continue;
        const actions = Object.keys(ab.endpoints ?? {});
        results.push({
          id: `api-bridge:${ab.name}`,
          kind: "api",
          program: ab.displayName || ab.name,
          workerName: "Arkestrator Server",
          bridgeVersion: "api-bridge",
          apiActions: actions,
          hasEditorContext: false,
          canExecuteBridgeCommands: false,
          usageHint:
            `${ab.displayName || ab.name} is an API bridge — it cannot receive execute_command scripts. ` +
            `Use the invoke_api_bridge MCP tool with bridge="${ab.name}" to call it.`,
        });
      }
    }

    return results;
  }

  /**
   * Wire in the ApiBridgesRepo + SettingsRepo so broadcasts can include the
   * synthetic "Arkestrator Server" worker and its api-bridge entries.
   */
  setApiBridgesRepo(repo: ApiBridgesRepo) {
    this.apiBridgesRepo = repo;
  }
  setSettingsRepo(repo: SettingsRepo) {
    this.settingsRepo = repo;
  }

  private virtualBridgeProgramsSet(): Set<string> {
    return new Set(
      Array.from(this.virtualBridges.values()).map((vb) => vb.program.toLowerCase()),
    );
  }

  private buildBridgeList() {
    const list: any[] = this.getBridges().map((b) => {
      return {
        id: b.id,
        name: b.name ?? b.id,
        type: "bridge",
        connected: true,
        lastSeen: new Date().toISOString(),
        program: b.program,
        programVersion: b.programVersion,
        bridgeVersion: b.bridgeVersion,
        projectPath: b.projectPath,
        activeProjects: Array.isArray(b.activeProjects)
          ? b.activeProjects
          : (b.projectPath ? [b.projectPath] : []),
        machineId: b.machineId,
        workerName: b.workerName,
        ip: b.ip,
        connectedAt: b.connectedAt,
        osUser: b.osUser,
      };
    });

    // Append synthetic "Arkestrator Server" api-bridges so WS broadcasts
    // match the REST `/api/workers` shape.
    if (this.apiBridgesRepo) {
      const { bridges: apiBridges } = buildServerWorkerAndBridges({
        apiBridgesRepo: this.apiBridgesRepo,
        settingsRepo: this.settingsRepo,
        virtualBridgePrograms: this.virtualBridgeProgramsSet(),
      });
      for (const ab of apiBridges) list.push(ab);
    }

    return list;
  }

  broadcastBridgeStatus() {
    this.broadcastToType("client", {
      type: "bridge_status",
      id: newId(),
      payload: { bridges: this.buildBridgeList() },
    });
  }

  /** Send current bridge list to a single client */
  sendBridgeStatus(clientId: string) {
    this.send(clientId, {
      type: "bridge_status",
      id: newId(),
      payload: { bridges: this.buildBridgeList() },
    });
  }

  /** Max pending commands to prevent unbounded memory under sustained load. */
  private static readonly MAX_PENDING_COMMANDS = 5000;

  /**
   * Register a pending bridge command from the REST API. Returns a Promise
   * that resolves with the result. On timeout, sends a `bridge_command_cancel`
   * to the target bridge so it can abort execution instead of producing an
   * orphaned result.
   */
  registerPendingCommand(correlationId: string, timeoutMs: number, targetBridgeId?: string): Promise<any> {
    if (this.pendingCommands.size >= WebSocketHub.MAX_PENDING_COMMANDS) {
      return Promise.reject(new Error("Too many pending bridge commands — server is overloaded"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pendingCommands.get(correlationId);
        if (!entry || entry.settled) return;
        entry.settled = true;
        this.pendingCommands.delete(correlationId);
        this.metrics.pendingCommandsTimedOut++;
        // Best-effort cancel so the bridge can abort its in-flight work.
        this.sendBridgeCommandCancel(correlationId, targetBridgeId, "Bridge command timed out");
        reject(new Error("Bridge command timed out"));
      }, timeoutMs);
      this.pendingCommands.set(correlationId, { resolve, reject, timer, settled: false, targetBridgeId });
    });
  }

  /** Try to resolve a pending REST bridge command. Returns true if matched. */
  resolvePendingCommand(correlationId: string, result: any): boolean {
    const pending = this.pendingCommands.get(correlationId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(correlationId);
    pending.resolve(result);
    return true;
  }

  /**
   * Send a bridge_command_cancel to the given bridge (or broadcast to the
   * program if no bridge ID is known). Used on timeout and on explicit cancel.
   */
  sendBridgeCommandCancel(correlationId: string, targetBridgeId: string | undefined, reason?: string): void {
    const msg = {
      type: "bridge_command_cancel" as const,
      id: newId(),
      payload: { correlationId, reason },
    };
    const data = JSON.stringify(msg);
    if (targetBridgeId) {
      const ws = this.connections.get(targetBridgeId);
      if (ws && ws.data.type === "bridge") {
        this.trySend(ws, data);
      }
      return;
    }
    // Fallback: send to all bridges so the one holding the correlation can abort.
    for (const ws of this.connections.values()) {
      if (ws.data.type === "bridge") this.trySend(ws, data);
    }
  }

  /**
   * Explicit cancel of a pending command (not timeout). Sends a cancel to the
   * bridge and rejects the waiting promise so the caller knows.
   */
  cancelPendingCommand(correlationId: string, reason = "Cancelled"): boolean {
    const entry = this.pendingCommands.get(correlationId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pendingCommands.delete(correlationId);
    this.metrics.pendingCommandsCancelled++;
    this.sendBridgeCommandCancel(correlationId, entry.targetBridgeId, reason);
    entry.reject(new Error(reason));
    return true;
  }

  /** Clear all pending commands on shutdown — cancels timers and rejects. */
  clearAllPendingCommands(reason = "Server shutting down"): void {
    for (const [id, entry] of this.pendingCommands) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      try { entry.reject(new Error(reason)); } catch {}
      this.pendingCommands.delete(id);
    }
  }

  private buildEnrichedWorkers(workersRepo: WorkersRepo) {
    const bridges = this.getBridges();
    const clients = this.getClients();
    ensureLiveWorkersPersisted(workersRepo, bridges, clients);
    const allWorkers = workersRepo.list(); // Already includes knownPrograms

    // Assign each virtual bridge's program to its specific worker
    const enriched: any[] = enrichWorkersWithLivePresence(allWorkers, bridges, clients);
    for (const vb of this.getVirtualBridges()) {
      const targetWorker = vb.workerName?.toLowerCase() ?? this.serverHostname;
      for (const worker of enriched) {
        if (worker.name.toLowerCase() === targetWorker) {
          worker.knownPrograms = [...new Set([...(worker.knownPrograms ?? []), vb.program])];
        }
      }
    }

    // Append synthetic "Arkestrator Server" worker if there are enabled API bridges.
    if (this.apiBridgesRepo) {
      const { worker: serverWorker } = buildServerWorkerAndBridges({
        apiBridgesRepo: this.apiBridgesRepo,
        settingsRepo: this.settingsRepo,
        virtualBridgePrograms: this.virtualBridgeProgramsSet(),
      });
      if (serverWorker) enriched.push(serverWorker);
    }

    return enriched;
  }

  broadcastWorkerStatus(workersRepo: WorkersRepo) {
    this.broadcastToType("client", {
      type: "worker_status",
      id: newId(),
      payload: { workers: this.buildEnrichedWorkers(workersRepo) },
    });
  }

  /** Send current worker list to a single client */
  sendWorkerStatus(clientId: string, workersRepo: WorkersRepo) {
    this.send(clientId, {
      type: "worker_status",
      id: newId(),
      payload: { workers: this.buildEnrichedWorkers(workersRepo) },
    });
  }

  // --- Per-Worker Headless Capabilities ---

  setWorkerHeadlessCapabilities(workerKey: string, programs: WorkerHeadlessCapability[]) {
    const normalized = this.normalizeWorkerKey(workerKey);
    if (!normalized) return;
    this.workerHeadlessCapabilities.set(normalized, programs);
  }

  /** Get a specific headless program capability for a worker. */
  getWorkerHeadlessProgram(workerKey: string, program: string): WorkerHeadlessCapability | undefined {
    const normalized = this.normalizeWorkerKey(workerKey);
    if (!normalized) return undefined;
    const caps = this.workerHeadlessCapabilities.get(normalized);
    if (!caps) return undefined;
    const normalizedProgram = program.trim().toLowerCase();
    return caps.find((c) => c.program.toLowerCase() === normalizedProgram);
  }

  /** Get all headless capabilities for a worker. */
  getWorkerHeadlessCapabilities(workerKey: string): WorkerHeadlessCapability[] {
    const normalized = this.normalizeWorkerKey(workerKey);
    return this.workerHeadlessCapabilities.get(normalized) ?? [];
  }

  // --- Bridge Context Management ---

  /** Max context items per bridge to prevent unbounded memory growth. */
  private static readonly MAX_CONTEXT_ITEMS_PER_BRIDGE = 200;

  addBridgeContextItem(bridgeId: string, item: ContextItem): ContextItem {
    let ctx = this.bridgeContexts.get(bridgeId);
    if (!ctx) {
      ctx = { items: [], nextIndex: 1, files: [] };
      this.bridgeContexts.set(bridgeId, ctx);
    }
    // Evict oldest items if at capacity
    while (ctx.items.length >= WebSocketHub.MAX_CONTEXT_ITEMS_PER_BRIDGE) {
      ctx.items.shift();
    }
    // Server assigns the index so numbering stays sequential after removals.
    const serverItem = { ...item, index: ctx.nextIndex++ };
    ctx.items.push(serverItem);
    return serverItem;
  }

  /** Remove a single context item and re-index remaining items */
  removeBridgeContextItem(bridgeId: string, itemIndex: number): ContextItem[] | null {
    const ctx = this.bridgeContexts.get(bridgeId);
    if (!ctx) return null;
    ctx.items = ctx.items.filter((i) => i.index !== itemIndex);
    // Re-index remaining items sequentially
    for (let i = 0; i < ctx.items.length; i++) {
      ctx.items[i] = { ...ctx.items[i], index: i + 1 };
    }
    ctx.nextIndex = ctx.items.length + 1;
    return ctx.items;
  }

  /** Clear all context items for a bridge (keep editor context and files) */
  clearBridgeContextItems(bridgeId: string) {
    const ctx = this.bridgeContexts.get(bridgeId);
    if (ctx) {
      ctx.items = [];
      ctx.nextIndex = 1;
    }
  }

  clearBridgeContext(bridgeId: string) {
    this.bridgeContexts.delete(bridgeId);
  }

  setBridgeEditorContext(bridgeId: string, editorContext: EditorContext, files: Array<{ path: string; content: string }>) {
    let ctx = this.bridgeContexts.get(bridgeId);
    if (!ctx) {
      ctx = { items: [], nextIndex: 1, files: [] };
      this.bridgeContexts.set(bridgeId, ctx);
    }
    ctx.editorContext = editorContext;
    ctx.files = files;
  }

  getBridgeContext(bridgeId: string): BridgeContextState | undefined {
    return this.bridgeContexts.get(bridgeId);
  }

  /** Build the full context sync payload for a newly connected client */
  buildContextSyncPayload(): Array<{
    bridgeId: string;
    bridgeName: string;
    program: string;
    items: ContextItem[];
    editorContext?: EditorContext;
    files: Array<{ path: string; content: string }>;
  }> {
    const result: Array<{
      bridgeId: string;
      bridgeName: string;
      program: string;
      items: ContextItem[];
      editorContext?: EditorContext;
      files: Array<{ path: string; content: string }>;
    }> = [];

    for (const [bridgeId, ctx] of this.bridgeContexts) {
      const ws = this.connections.get(bridgeId);
      if (!ws || ws.data.type !== "bridge") continue;
      result.push({
        bridgeId,
        bridgeName: ws.data.name ?? bridgeId,
        program: ws.data.program ?? "unknown",
        items: ctx.items,
        editorContext: ctx.editorContext,
        files: ctx.files,
      });
    }

    return result;
  }

  /** Send full context sync to a specific client */
  sendContextSync(clientId: string) {
    const bridges = this.buildContextSyncPayload();
    if (bridges.length === 0) return;
    this.send(clientId, {
      type: "bridge_context_sync",
      id: newId(),
      payload: { bridges },
    });
  }
}
