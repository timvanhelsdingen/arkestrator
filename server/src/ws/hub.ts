import type { ServerWebSocket } from "bun";
import type { ContextItem, EditorContext } from "@arkestrator/protocol";
import type { ApiKeyRole } from "../db/apikeys.repo.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/id.js";
import { enrichWorkersWithLivePresence } from "../utils/worker-status.js";
import { ensureLiveWorkersPersisted } from "../utils/live-workers.js";

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
  lastPongAt?: number;
  /** Set to true when a ping is sent; cleared when a pong is received. */
  awaitingPong?: boolean;
  /** Timestamp of the last application-level message received from this connection. */
  lastMessageAt?: number;
}

export interface BridgeContextState {
  items: ContextItem[];
  nextIndex: number;
  editorContext?: EditorContext;
  files: Array<{ path: string; content: string }>;
}

export class WebSocketHub {
  private connections = new Map<string, ServerWebSocket<WsData>>();
  private pendingCommands = new Map<string, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private bridgeContexts = new Map<string, BridgeContextState>();
  // Tracks last replacement time per "program/workerName/projectPath" key for rapid-reconnect detection
  private lastReplacementTime = new Map<string, number>();
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

  register(ws: ServerWebSocket<WsData>) {
    const workerKey = String(ws.data.machineId ?? ws.data.workerName ?? "").trim().toLowerCase();
    // Kick stale duplicates only when they map to the same session identity:
    // (program, workerName, projectPath). This allows multiple concurrent sessions
    // of the same program on one worker (different project paths).
    if (ws.data.type === "bridge" && ws.data.program && workerKey) {
      const prog = ws.data.program.toLowerCase();
      const incomingProject = this.normalizeProjectPath(ws.data.projectPath);
      const stale: string[] = [];
      for (const [id, existing] of this.connections) {
        const existingProject = this.normalizeProjectPath(existing.data.projectPath);
        const sameProject = !!incomingProject && incomingProject === existingProject;
        const existingWorkerKey = String(existing.data.machineId ?? existing.data.workerName ?? "").trim().toLowerCase();
        if (
          id !== ws.data.id &&
          existing.data.type === "bridge" &&
          existing.data.program?.toLowerCase() === prog &&
          existingWorkerKey === workerKey &&
          sameProject
        ) {
          stale.push(id);
        }
      }
      const rapidKey = `${prog}/${workerKey}/${incomingProject ?? "<none>"}`;
      for (const id of stale) {
        const old = this.connections.get(id);
        if (old) {
          const now = Date.now();
          const lastReplaced = this.lastReplacementTime.get(rapidKey) ?? 0;
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
              `Replacing stale bridge ${id} (${old.data.program}/${old.data.workerName}/${incomingProject ?? "<none>"})`,
            );
          }
          this.lastReplacementTime.set(rapidKey, now);
          this.connections.delete(id);
          this.bridgeContexts.delete(id);
          // Use code 4001 (app-specific) so the bridge knows it was replaced
          // and should NOT trigger its reconnect logic.
          try { old.close(4001, "Replaced by new connection"); } catch {}
        }
      }
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

  unregister(ws: ServerWebSocket<WsData>) {
    this.connections.delete(ws.data.id);
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
    const results: ServerWebSocket<WsData>[] = [];
    for (const ws of this.connections.values()) {
      if (ws.data.type === "bridge" && ws.data.program === program) {
        results.push(ws);
      }
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
  pingAll() {
    const now = Date.now();
    const messageStaleMs = 120_000; // 2 minutes with zero messages = dead
    let removedAny = false;
    for (const [id, ws] of this.connections) {
      // Check 1: No pong received since last ping cycle — connection is dead.
      if (ws.data.awaitingPong) {
        const lastPong = ws.data.lastPongAt;
        const age = lastPong ? Math.round((now - lastPong) / 1000) : "never";
        logger.warn("ws-hub", `Stale connection (no pong, last pong ${age}s ago): ${ws.data.type} ${id} (${ws.data.program ?? "client"}/${ws.data.workerName ?? "?"}), removing`);
        try { ws.close(1001, "Stale connection"); } catch {}
        this.connections.delete(id);
        if (ws.data.type === "bridge") {
          this.bridgeContexts.delete(id);
        }
        removedAny = true;
        continue;
      }
      // Check 2: No activity for 2+ minutes (no messages AND no pongs).
      // This catches half-open connections where the OS or runtime auto-replies
      // to WebSocket pings but the remote endpoint is actually unreachable.
      const lastActivity = Math.max(ws.data.lastMessageAt ?? 0, ws.data.lastPongAt ?? 0) || now;
      if (now - lastActivity > messageStaleMs) {
        logger.warn("ws-hub", `Stale connection (no messages for ${Math.round((now - lastActivity) / 1000)}s): ${ws.data.type} ${id} (${ws.data.program ?? "client"}/${ws.data.workerName ?? "?"}), removing`);
        try { ws.close(1001, "Stale connection — no messages"); } catch {}
        this.connections.delete(id);
        if (ws.data.type === "bridge") {
          this.bridgeContexts.delete(id);
        }
        removedAny = true;
        continue;
      }
      try {
        ws.data.awaitingPong = true;
        ws.ping();
      } catch {
        // Connection is dead — clean it up
        logger.warn("ws-hub", `Ping failed for ${ws.data.type} ${id} (${ws.data.program ?? "client"}/${ws.data.workerName ?? "?"}), removing`);
        try { ws.close(1001, "Ping failed"); } catch {}
        this.connections.delete(id);
        if (ws.data.type === "bridge") {
          this.bridgeContexts.delete(id);
        }
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

  private buildBridgeList() {
    return this.getBridges().map((b) => ({
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
    }));
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

  /** Register a pending bridge command from the REST API. Returns a Promise that resolves with the result. */
  registerPendingCommand(correlationId: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(correlationId);
        reject(new Error("Bridge command timed out"));
      }, timeoutMs);
      this.pendingCommands.set(correlationId, { resolve, timer });
    });
  }

  /** Try to resolve a pending REST bridge command. Returns true if matched. */
  resolvePendingCommand(correlationId: string, result: any): boolean {
    const pending = this.pendingCommands.get(correlationId);
    if (!pending) return false;
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
    return enrichWorkersWithLivePresence(allWorkers, bridges, clients);
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

  // --- Bridge Context Management ---

  addBridgeContextItem(bridgeId: string, item: ContextItem): ContextItem {
    let ctx = this.bridgeContexts.get(bridgeId);
    if (!ctx) {
      ctx = { items: [], nextIndex: 1, files: [] };
      this.bridgeContexts.set(bridgeId, ctx);
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
