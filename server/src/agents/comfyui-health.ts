import type { WebSocketHub } from "../ws/hub.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

const VIRTUAL_BRIDGE_ID = "virtual:comfyui";
const POLL_INTERVAL_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;

export class ComfyUiHealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private hub: WebSocketHub,
    private config: Config,
  ) {}

  start() {
    if (this.timer) return;
    // Run immediately, then on interval
    this.check();
    this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
    logger.info("comfyui-health", `Health checker started (polling ${this.config.comfyuiUrl} every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hub.removeVirtualBridge(VIRTUAL_BRIDGE_ID);
    this.hub.broadcastBridgeStatus();
    logger.info("comfyui-health", "Health checker stopped");
  }

  private async check() {
    if (this.running) return;
    this.running = true;
    try {
      const baseUrl = String(this.config.comfyuiUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${baseUrl}/system_stats`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          let version: string | undefined;
          try {
            const data = await res.json() as { system?: { comfyui_version?: string } };
            version = data?.system?.comfyui_version;
          } catch { /* version is optional */ }

          const isNew = this.hub.registerVirtualBridge({
            id: VIRTUAL_BRIDGE_ID,
            program: "comfyui",
            programVersion: version,
            connectedAt: new Date().toISOString(),
            url: baseUrl,
          });
          if (isNew) {
            this.hub.broadcastBridgeStatus();
          }
        } else {
          this.markOffline();
        }
      } catch {
        clearTimeout(timeout);
        this.markOffline();
      }
    } finally {
      this.running = false;
    }
  }

  private markOffline() {
    if (this.hub.getVirtualBridge(VIRTUAL_BRIDGE_ID)) {
      this.hub.removeVirtualBridge(VIRTUAL_BRIDGE_ID);
      this.hub.broadcastBridgeStatus();
    }
  }
}
