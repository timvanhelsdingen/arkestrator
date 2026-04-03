import type { ServerWebSocket } from "bun";
import type { ContextItem, EditorContext } from "@arkestrator/protocol";
import type { ApiKeyRole } from "../db/apikeys.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/id.js";
import { enrichWorkersWithLivePresence } from "../utils/worker-status.js";
import { ensureLiveWorkersPersisted } from "../utils/live-workers.js";
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

export class WebSocketHub {
  private connections = new Map<string, ServerWebSocket<WsData>>();
  private pendingCommands = new Map<string, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout>; settled: boolean }>();
  private bridgeContexts = new Map<string, BridgeContextState>();
  /** Job log subscriptions: jobId → Set of connection IDs actively viewing that job */
  private logSubscriptions = new Map<string, Set<string>>();
  // Tracks last replacement time per "program/workerName/projectPath" key for rapid-reconnect detection
  private lastReplacementTime = new Map<string, number>();
  /** Per-worker headless capabilities reported by desktop clients. Keyed by normalized workerKey. */
  private workerHeadlessCapabilities = new Map<string, WorkerHeadlessCapability[]>();
  /** Virtual bridges: HTTP-based services (e.g. ComfyUI) that appear in bridge status without WebSocket. */
  private virtualBridges = new Map<string, VirtualBridgeData>();
  /** Server's own hostname, resolved once at startup for stable virtual bridge identity. */
  private readonly serverHostname = hostname().toLowerCase();

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

  register(ws: ServerWebSocket<WsData>) {
    const workerKey = String(ws.data.machineId ?? ws.data.workerName ?? "").trim().toLowerCase();
    // Kick stale duplicates only when they map to the same session identity:
    // (program, workerName, projectPath). This allows multiple concurrent sessions
    // of the same program on one worker (different project paths).
    if (ws.data.type === "bridge" && ws.data.program && workerKey) {
      const prog = ws.data.program.toLowerCase();
      const incomingProject = this.normalizeProjectPath(ws.data.projectPath);
      const identityKey = this.makeBridgeIdentityKey(prog, workerKey, incomingProject);

      // O(1) lookup via identity index instead of iterating all connections
      const existingId = this.bridgeIdentityIndex.get(identityKey);
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

  send(id: string, message: object) {
    const ws = this.connections.get(id);
    if (ws) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(message: object) {
    const data = JSON.stringify(message);
    for (const ws of this.connections.values()) {
      try {
        ws.send(data);
      } catch {
        // Connection may already be closed
      }
    }
  }

  broadcastToType(type: "bridge" | "client", message: object) {
    const data = JSON.stringify(message);
    let sent = 0;
    for (const ws of this.connections.values()) {
      if (ws.data.type === type) {
        try {
          ws.send(data);
          sent++;
        } catch {
          // Connection may already be closed
        }
      }
    }
    const msgType = (message as { type?: string }).type ?? "unknown";
    if (msgType === "job_updated" || msgType === "job_complete" || msgType === "job_started") {
      logger.debug("ws-hub", `Broadcast ${msgType} to ${sent} ${type}(s)`);
    }
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
    // Include virtual bridges as synthetic WsData entries
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
    try { ws.close(1001, reason); } catch {}
    this.removeConnectionFromIndexes(id, ws);
    this.connections.delete(id);
    if (ws.data.type === "bridge") {
      this.bridgeContexts.delete(id);
    }
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
      return false;
    }
    this.virtualBridges.set(data.id, data);
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

  private buildBridgeList() {
    // For virtual bridges, find the worker whose name matches the server hostname.
    // This is stable regardless of connection order.
    const allBridges = this.getBridges();
    const allClients = this.getClients();
    const localConn = [...allBridges, ...allClients].find((c) =>
      c.workerName?.toLowerCase() === this.serverHostname,
    ) ?? allBridges.find((b) =>
      !b.id.startsWith("virtual:") && (b.ip === "127.0.0.1" || b.ip === "::1"),
    ) ?? allClients.find((c) =>
      c.ip === "127.0.0.1" || c.ip === "::1",
    );
    const localWorkerName = localConn?.workerName ?? this.serverHostname;
    const localMachineId = localConn?.machineId;
    const localIp = localConn?.ip ?? "127.0.0.1";

    return this.getBridges().map((b) => {
      const isVirtual = b.id.startsWith("virtual:");
      // Virtual bridges carry their own identity from the health checker
      const vb = isVirtual ? this.virtualBridges.get(b.id) : undefined;
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
        machineId: vb?.machineId ?? (isVirtual ? localMachineId : b.machineId),
        workerName: vb?.workerName ?? (isVirtual ? localWorkerName : b.workerName),
        ip: vb?.ip ?? (isVirtual ? localIp : b.ip),
        connectedAt: b.connectedAt,
        osUser: b.osUser,
      };
    });
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

  /** Register a pending bridge command from the REST API. Returns a Promise that resolves with the result. */
  registerPendingCommand(correlationId: string, timeoutMs: number): Promise<any> {
    if (this.pendingCommands.size >= WebSocketHub.MAX_PENDING_COMMANDS) {
      return Promise.reject(new Error("Too many pending bridge commands — server is overloaded"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(correlationId);
        reject(new Error("Bridge command timed out"));
      }, timeoutMs);
      this.pendingCommands.set(correlationId, { resolve, timer, settled: false });
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

  private buildEnrichedWorkers(workersRepo: WorkersRepo) {
    const bridges = this.getBridges();
    const clients = this.getClients();
    ensureLiveWorkersPersisted(workersRepo, bridges, clients);
    const allWorkers = workersRepo.list(); // Already includes knownPrograms

    // Assign each virtual bridge's program to its specific worker
    const enriched = enrichWorkersWithLivePresence(allWorkers, bridges, clients);
    for (const vb of this.getVirtualBridges()) {
      const targetWorker = vb.workerName?.toLowerCase() ?? this.serverHostname;
      for (const worker of enriched) {
        if (worker.name.toLowerCase() === targetWorker) {
          worker.knownPrograms = [...new Set([...(worker.knownPrograms ?? []), vb.program])];
        }
      }
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
