import type { WebSocketHub } from "../ws/hub.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { hostname } from "node:os";

const POLL_INTERVAL_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;
const COMFYUI_DEFAULT_PORT = 8188;

/**
 * Polls ComfyUI HTTP endpoints on every known worker and registers
 * a virtual bridge per worker. Supports any number of machines.
 *
 * - Server-local: polls config.comfyuiUrl (default http://127.0.0.1:8188)
 * - Remote workers: polls http://{worker.lastIp}:8188/system_stats
 * - Each worker gets its own virtual bridge ID: virtual:comfyui:{workerName}
 */
export class ComfyUiHealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly serverHostname = hostname().toLowerCase();

  constructor(
    private hub: WebSocketHub,
    private config: Config,
    private workersRepo?: WorkersRepo,
  ) {}

  async start() {
    if (this.timer) return;
    await this.check();
    this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
    logger.info("comfyui-health", `Health checker started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Remove all comfyui virtual bridges
    for (const vb of this.hub.getVirtualBridges()) {
      if (vb.program === "comfyui") {
        this.hub.removeVirtualBridge(vb.id);
      }
    }
    this.hub.broadcastBridgeStatus();
    logger.info("comfyui-health", "Health checker stopped");
  }

  private async check() {
    if (this.running) return;
    this.running = true;
    try {
      // Build list of endpoints to poll: local + every online worker with a known IP
      const endpoints: Array<{ workerName: string; url: string; machineId?: string; ip: string }> = [];

      // Local server endpoint
      const localUrl = String(this.config.comfyuiUrl || `http://127.0.0.1:${COMFYUI_DEFAULT_PORT}`).replace(/\/+$/, "");
      endpoints.push({ workerName: this.serverHostname, url: localUrl, ip: "127.0.0.1" });

      // Remote workers — poll their IP on the default ComfyUI port
      if (this.workersRepo) {
        const workers = this.workersRepo.list();
        for (const w of workers) {
          if (w.status !== "online") continue;
          if (w.name.toLowerCase() === this.serverHostname) continue; // already covered by local
          const ip = w.lastIp;
          if (!ip || ip === "127.0.0.1" || ip === "::1") continue; // skip loopback (that's us)
          endpoints.push({
            workerName: w.name,
            url: `http://${ip}:${COMFYUI_DEFAULT_PORT}`,
            machineId: w.machineId,
            ip,
          });
        }
      }

      // Poll all endpoints concurrently
      const results = await Promise.allSettled(
        endpoints.map((ep) => this.probe(ep)),
      );

      // Track which virtual bridges are still alive
      const aliveIds = new Set<string>();
      let changed = false;

      for (let i = 0; i < endpoints.length; i++) {
        const ep = endpoints[i];
        const result = results[i];
        const bridgeId = `virtual:comfyui:${ep.workerName}`;

        if (result.status === "fulfilled" && result.value) {
          aliveIds.add(bridgeId);
          const isNew = this.hub.registerVirtualBridge({
            id: bridgeId,
            program: "comfyui",
            programVersion: result.value.version,
            connectedAt: new Date().toISOString(),
            url: ep.url,
            workerName: ep.workerName,
            machineId: ep.machineId,
            ip: ep.ip,
          });
          if (isNew) {
            logger.info("comfyui-health", `ComfyUI detected on ${ep.workerName} at ${ep.url} (v${result.value.version ?? "unknown"})`);
            changed = true;
          }
        }
      }

      // Remove stale virtual bridges for workers that went offline
      for (const vb of this.hub.getVirtualBridges()) {
        if (vb.program === "comfyui" && !aliveIds.has(vb.id)) {
          logger.info("comfyui-health", `ComfyUI went offline on ${vb.workerName ?? vb.id}`);
          this.hub.removeVirtualBridge(vb.id);
          changed = true;
        }
      }

      if (changed) this.hub.broadcastBridgeStatus();
    } finally {
      this.running = false;
    }
  }

  private async probe(ep: { url: string }): Promise<{ version?: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${ep.url}/system_stats`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      let version: string | undefined;
      try {
        const data = await res.json() as { system?: { comfyui_version?: string } };
        version = data?.system?.comfyui_version;
      } catch { /* version is optional */ }
      return { version };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }
}
