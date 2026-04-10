import type { WebSocketHub } from "../ws/hub.js";
import type { WorkersRepo } from "../db/workers.repo.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { hostname } from "node:os";

const POLL_INTERVAL_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;
const COMFYUI_DEFAULT_PORT = 8188;

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

function buildUrl(ip: string, port: number): string {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}

/**
 * Polls ComfyUI HTTP endpoints on every known worker and registers
 * a virtual bridge per worker. Supports any number of machines.
 *
 * - Server-local: polls config.comfyuiUrl (default http://127.0.0.1:8188)
 * - Remote workers: polls http://{bridge.ip}:8188 for every live bridge connection
 *   This uses live bridge IPs directly so it works regardless of worker DB status.
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
      const endpoints: Array<{ workerName: string; url: string; machineId?: string; ip: string }> = [];

      // Always probe local ComfyUI
      const localUrl = String(this.config.comfyuiUrl || `http://127.0.0.1:${COMFYUI_DEFAULT_PORT}`).replace(/\/+$/, "");
      const rawWorkers = this.workersRepo?.list() ?? [];
      const localWorker = rawWorkers.find((w) => w.name.toLowerCase() === this.serverHostname);
      endpoints.push({ workerName: this.serverHostname, url: localUrl, ip: "127.0.0.1", machineId: localWorker?.machineId });

      // Collect unique non-loopback IPs from all live bridge connections.
      // This works without needing enriched worker status — any machine with
      // an active bridge connection gets probed for ComfyUI.
      const seenIps = new Set<string>(["127.0.0.1", "::1"]);
      for (const bridge of this.hub.getBridges()) {
        const ip = bridge.ip;
        if (!ip || isLoopback(ip) || seenIps.has(ip)) continue;
        // Skip virtual bridges (already registered ComfyUI instances)
        if (bridge.id?.startsWith("virtual:")) continue;
        seenIps.add(ip);
        // Resolve worker identity from the bridge
        const workerName = bridge.workerName ?? bridge.machineId ?? ip;
        const machineId = bridge.machineId ?? undefined;
        endpoints.push({
          workerName,
          url: buildUrl(ip, COMFYUI_DEFAULT_PORT),
          machineId,
          ip,
        });
      }

      logger.info("comfyui-health", `Probing ${endpoints.length} endpoint(s): ${endpoints.map(e => e.url).join(", ")}`);

      const results = await Promise.allSettled(
        endpoints.map((ep) => this.probe(ep)),
      );

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

      // Remove stale virtual bridges
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
    for (const path of ["/system_stats", "/"]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${ep.url}${path}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) continue;
        let version: string | undefined;
        if (path === "/system_stats") {
          try {
            const data = await res.json() as { system?: { comfyui_version?: string } };
            version = data?.system?.comfyui_version;
          } catch { /* version is optional */ }
        }
        return { version };
      } catch {
        clearTimeout(timeout);
        continue;
      }
    }
    return null;
  }
}
