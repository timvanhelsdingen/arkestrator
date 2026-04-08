import type {
  ApiBridgeAction,
  ApiBridgeConfig,
  ApiBridgeResult,
  ApiBridgeOutputFile,
} from "@arkestrator/protocol";
import type { ApiBridgeExecContext, ApiBridgeHandler } from "../handler.js";
import { buildUrl, sleep } from "../handler.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8188";

const ACTIONS: ApiBridgeAction[] = [
  {
    name: "queue_workflow",
    description:
      "Submit a ComfyUI workflow JSON for execution. Polls until complete and returns output artifacts (images, videos, etc.).",
    parameters: {
      workflow: {
        type: "object",
        description: "ComfyUI workflow JSON (the API format, not the UI format)",
        required: true,
      },
      timeout_ms: {
        type: "number",
        description: "Maximum time to wait for completion (default: 120000ms)",
        default: 120000,
      },
    },
  },
  {
    name: "get_object_info",
    description: "List all available ComfyUI nodes and their input/output schemas.",
    parameters: {},
  },
  {
    name: "get_queue",
    description: "Get the current ComfyUI queue status (running and pending prompts).",
    parameters: {},
  },
  {
    name: "interrupt",
    description: "Interrupt the currently running workflow.",
    parameters: {},
  },
];

type ComfyHistoryEntry = {
  outputs?: Record<string, Record<string, any>>;
  status?: {
    completed?: boolean;
    status_str?: string;
  };
};

/**
 * ComfyUI API bridge handler.
 * Talks directly to ComfyUI's HTTP REST API to submit workflows and retrieve results.
 */
export class ComfyUiHandler implements ApiBridgeHandler {
  readonly presetId = "comfyui";
  readonly displayName = "ComfyUI (Image/Video Generation)";
  readonly defaultBaseUrl = DEFAULT_BASE_URL;

  getActions(): ApiBridgeAction[] {
    return ACTIONS;
  }

  async execute(
    config: ApiBridgeConfig,
    _apiKey: string,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    try {
      switch (action) {
        case "queue_workflow":
          return this.queueWorkflow(config, params, context);
        case "get_object_info":
          return this.simpleGet(config, "/object_info", action);
        case "get_queue":
          return this.simpleGet(config, "/queue", action);
        case "interrupt":
          return this.simplePost(config, "/interrupt", action);
        default:
          return {
            bridgeName: config.name,
            action,
            success: false,
            error: `Unknown action "${action}". Available: ${ACTIONS.map((a) => a.name).join(", ")}`,
          };
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { bridgeName: config.name, action, success: false, error: "Request cancelled" };
      }
      return { bridgeName: config.name, action, success: false, error: err.message ?? String(err) };
    }
  }

  private async queueWorkflow(
    config: ApiBridgeConfig,
    params: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const workflow = params.workflow;
    if (!workflow || typeof workflow !== "object") {
      return {
        bridgeName: config.name,
        action: "queue_workflow",
        success: false,
        error: "workflow parameter must be a JSON object",
      };
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 120_000;
    const pollIntervalMs = 800;
    const clientId = `arkestrator-${Math.random().toString(16).slice(2)}`;

    ctx.onProgress?.(0, "Submitting workflow...");
    ctx.onLog?.(`POST ${baseUrl}/prompt`);

    // Submit workflow
    const submitRes = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: ctx.signal,
    });

    if (!submitRes.ok) {
      const text = await submitRes.text();
      return {
        bridgeName: config.name,
        action: "queue_workflow",
        success: false,
        error: `HTTP ${submitRes.status}: ${text}`,
      };
    }

    const submitData = (await submitRes.json()) as Record<string, unknown>;
    const promptId = String(submitData.prompt_id ?? "").trim();
    if (!promptId) {
      return {
        bridgeName: config.name,
        action: "queue_workflow",
        success: false,
        error: "ComfyUI returned no prompt_id",
        data: submitData,
      };
    }

    ctx.onLog?.(`Workflow queued: ${promptId}`);

    // Poll for completion
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await sleep(pollIntervalMs, ctx.signal);

      const historyRes = await fetch(
        `${baseUrl}/history/${encodeURIComponent(promptId)}`,
        { signal: ctx.signal },
      );
      if (!historyRes.ok) {
        ctx.onLog?.(`Poll error: HTTP ${historyRes.status}`);
        continue;
      }

      const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];
      if (!entry) continue;

      const completed = !!entry.status?.completed || entry.status?.status_str === "success";
      const hasOutputs = !!entry.outputs && Object.keys(entry.outputs).length > 0;

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      ctx.onProgress?.(null, `${completed ? "Completed" : "Running"} (${elapsed}s)`);

      if (completed || hasOutputs) {
        // Collect output artifacts
        const outputFiles = this.collectOutputFiles(baseUrl, entry);

        ctx.onLog?.(`Workflow completed: ${outputFiles.length} artifact(s)`);
        return {
          bridgeName: config.name,
          action: "queue_workflow",
          success: true,
          data: entry,
          externalTaskId: promptId,
          externalStatus: "completed",
          outputFiles,
        };
      }
    }

    return {
      bridgeName: config.name,
      action: "queue_workflow",
      success: false,
      externalTaskId: promptId,
      error: `Workflow timed out after ${timeoutMs}ms`,
    };
  }

  private collectOutputFiles(baseUrl: string, entry: ComfyHistoryEntry): ApiBridgeOutputFile[] {
    const files: ApiBridgeOutputFile[] = [];
    const nodeOutputs = entry.outputs ?? {};

    for (const [_nodeId, nodeOutput] of Object.entries(nodeOutputs)) {
      const outputTypes: Array<{ key: string; mimePrefix: string }> = [
        { key: "images", mimePrefix: "image/" },
        { key: "gifs", mimePrefix: "image/gif" },
        { key: "videos", mimePrefix: "video/" },
        { key: "audio", mimePrefix: "audio/" },
        { key: "files", mimePrefix: "application/octet-stream" },
      ];

      for (const { key, mimePrefix } of outputTypes) {
        const items = (nodeOutput as Record<string, any>)?.[key];
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          const filename = String(item?.filename ?? "").trim();
          if (!filename) continue;

          const subfolder = String(item?.subfolder ?? "").trim() || undefined;
          const type = String(item?.type ?? "").trim() || "output";

          const params = new URLSearchParams();
          params.set("filename", filename);
          params.set("type", type);
          if (subfolder) params.set("subfolder", subfolder);

          files.push({
            url: `${baseUrl}/view?${params.toString()}`,
            filename,
            mimeType: inferMimeType(filename, mimePrefix),
          });
        }
      }
    }

    return files;
  }

  private async simpleGet(
    config: ApiBridgeConfig,
    path: string,
    action: string,
  ): Promise<ApiBridgeResult> {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}${path}`);
    const data = await res.json().catch(() => null);
    return {
      bridgeName: config.name,
      action,
      success: res.ok,
      data,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  }

  private async simplePost(
    config: ApiBridgeConfig,
    path: string,
    action: string,
  ): Promise<ApiBridgeResult> {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
    const data = await res.json().catch(() => null);
    return {
      bridgeName: config.name,
      action,
      success: res.ok,
      data,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  }
}

function inferMimeType(filename: string, defaultPrefix: string): string {
  const lower = filename.toLowerCase();
  if (/\.png$/.test(lower)) return "image/png";
  if (/\.jpe?g$/.test(lower)) return "image/jpeg";
  if (/\.webp$/.test(lower)) return "image/webp";
  if (/\.gif$/.test(lower)) return "image/gif";
  if (/\.mp4$/.test(lower)) return "video/mp4";
  if (/\.webm$/.test(lower)) return "video/webm";
  if (/\.wav$/.test(lower)) return "audio/wav";
  if (/\.mp3$/.test(lower)) return "audio/mpeg";
  return defaultPrefix.endsWith("/") ? `${defaultPrefix}octet-stream` : defaultPrefix;
}
