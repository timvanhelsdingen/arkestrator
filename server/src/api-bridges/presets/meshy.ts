import type {
  ApiBridgeAction,
  ApiBridgeConfig,
  ApiBridgeResult,
  ApiBridgeOutputFile,
} from "@arkestrator/protocol";
import type { ApiBridgeExecContext, ApiBridgeHandler } from "../handler.js";
import { buildAuthHeaders, buildUrl, sleep } from "../handler.js";

const DEFAULT_BASE_URL = "https://api.meshy.ai";

const ACTIONS: ApiBridgeAction[] = [
  {
    name: "text_to_3d_preview",
    description:
      "Generate a 3D model preview from a text prompt. Returns a preview-quality model. Use text_to_3d_refine on the result for production quality.",
    parameters: {
      prompt: {
        type: "string",
        description: "Describe the 3D object to generate (max 600 chars)",
        required: true,
      },
      ai_model: {
        type: "string",
        description: "AI model to use",
        enum: ["meshy-5", "meshy-6", "latest"],
        default: "latest",
      },
      topology: {
        type: "string",
        description: "Mesh topology type",
        enum: ["quad", "triangle"],
        default: "triangle",
      },
      target_polycount: {
        type: "number",
        description: "Target polygon count (100-300000)",
        default: 30000,
      },
      target_formats: {
        type: "array",
        description: 'Output formats (e.g. ["glb", "fbx", "obj"])',
        default: ["glb"],
      },
    },
  },
  {
    name: "text_to_3d_refine",
    description:
      "Refine a completed preview task into a production-quality textured 3D model with optional PBR maps.",
    parameters: {
      preview_task_id: {
        type: "string",
        description: "ID of a completed text_to_3d_preview task",
        required: true,
      },
      enable_pbr: {
        type: "boolean",
        description: "Generate PBR maps (metallic, roughness, normal)",
        default: false,
      },
      texture_prompt: {
        type: "string",
        description: "Optional texture description (max 600 chars)",
      },
    },
  },
  {
    name: "image_to_3d",
    description:
      "Generate a 3D model from an image URL. The image should show the object clearly.",
    parameters: {
      image_url: {
        type: "string",
        description: "Public URL or base64 data URI of the source image (.jpg, .png)",
        required: true,
      },
      ai_model: {
        type: "string",
        description: "AI model to use",
        enum: ["meshy-5", "meshy-6", "latest"],
        default: "latest",
      },
      topology: {
        type: "string",
        description: "Mesh topology type",
        enum: ["quad", "triangle"],
        default: "triangle",
      },
      target_polycount: {
        type: "number",
        description: "Target polygon count (100-300000)",
        default: 30000,
      },
      enable_pbr: {
        type: "boolean",
        description: "Generate PBR maps",
        default: false,
      },
      target_formats: {
        type: "array",
        description: 'Output formats (e.g. ["glb", "fbx"])',
        default: ["glb"],
      },
    },
  },
  {
    name: "retexture",
    description:
      "Re-texture an existing 3D model from a previous task with a new style prompt or reference image.",
    parameters: {
      input_task_id: {
        type: "string",
        description: "ID of a completed 3D generation task to retexture",
        required: true,
      },
      text_style_prompt: {
        type: "string",
        description: "Text description of the desired texture style (max 600 chars)",
      },
      image_style_url: {
        type: "string",
        description: "URL of a reference style image",
      },
      enable_pbr: {
        type: "boolean",
        description: "Generate PBR maps",
        default: false,
      },
    },
  },
];

/**
 * Meshy API bridge handler.
 * Supports text-to-3D (preview + refine), image-to-3D, and retexture actions.
 * All actions follow the same pattern: submit task -> poll status -> return results.
 */
export class MeshyHandler implements ApiBridgeHandler {
  readonly presetId = "meshy";
  readonly displayName = "Meshy (3D Generation)";
  readonly defaultBaseUrl = DEFAULT_BASE_URL;

  getActions(): ApiBridgeAction[] {
    return ACTIONS;
  }

  async execute(
    config: ApiBridgeConfig,
    apiKey: string,
    action: string,
    params: Record<string, unknown>,
    context: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const actionDef = ACTIONS.find((a) => a.name === action);
    if (!actionDef) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: `Unknown action "${action}". Available: ${ACTIONS.map((a) => a.name).join(", ")}`,
      };
    }

    try {
      switch (action) {
        case "text_to_3d_preview":
          return this.textTo3dPreview(config, apiKey, params, context);
        case "text_to_3d_refine":
          return this.textTo3dRefine(config, apiKey, params, context);
        case "image_to_3d":
          return this.imageTo3d(config, apiKey, params, context);
        case "retexture":
          return this.retexture(config, apiKey, params, context);
        default:
          return { bridgeName: config.name, action, success: false, error: `Unhandled action: ${action}` };
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { bridgeName: config.name, action, success: false, error: "Request cancelled" };
      }
      return { bridgeName: config.name, action, success: false, error: err.message ?? String(err) };
    }
  }

  // --- Actions ---

  private async textTo3dPreview(
    config: ApiBridgeConfig,
    apiKey: string,
    params: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const body: Record<string, unknown> = {
      mode: "preview",
      prompt: params.prompt,
    };
    if (params.ai_model) body.ai_model = params.ai_model;
    if (params.topology) body.topology = params.topology;
    if (params.target_polycount) body.target_polycount = params.target_polycount;
    if (params.target_formats) body.target_formats = params.target_formats;

    return this.submitAndPoll(config, apiKey, "text_to_3d_preview", "/openapi/v2/text-to-3d", body, ctx);
  }

  private async textTo3dRefine(
    config: ApiBridgeConfig,
    apiKey: string,
    params: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const body: Record<string, unknown> = {
      mode: "refine",
      preview_task_id: params.preview_task_id,
    };
    if (params.enable_pbr !== undefined) body.enable_pbr = params.enable_pbr;
    if (params.texture_prompt) body.texture_prompt = params.texture_prompt;

    return this.submitAndPoll(config, apiKey, "text_to_3d_refine", "/openapi/v2/text-to-3d", body, ctx);
  }

  private async imageTo3d(
    config: ApiBridgeConfig,
    apiKey: string,
    params: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const body: Record<string, unknown> = {
      image_url: params.image_url,
    };
    if (params.ai_model) body.ai_model = params.ai_model;
    if (params.topology) body.topology = params.topology;
    if (params.target_polycount) body.target_polycount = params.target_polycount;
    if (params.enable_pbr !== undefined) body.enable_pbr = params.enable_pbr;
    if (params.target_formats) body.target_formats = params.target_formats;

    return this.submitAndPoll(config, apiKey, "image_to_3d", "/openapi/v1/image-to-3d", body, ctx);
  }

  private async retexture(
    config: ApiBridgeConfig,
    apiKey: string,
    params: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const body: Record<string, unknown> = {
      input_task_id: params.input_task_id,
    };
    if (params.text_style_prompt) body.text_style_prompt = params.text_style_prompt;
    if (params.image_style_url) body.image_style_url = params.image_style_url;
    if (params.enable_pbr !== undefined) body.enable_pbr = params.enable_pbr;

    return this.submitAndPoll(config, apiKey, "retexture", "/openapi/v1/retexture", body, ctx);
  }

  // --- Core submit + poll loop ---

  private async submitAndPoll(
    config: ApiBridgeConfig,
    apiKey: string,
    action: string,
    endpoint: string,
    body: Record<string, unknown>,
    ctx: ApiBridgeExecContext,
  ): Promise<ApiBridgeResult> {
    const headers = buildAuthHeaders(config, apiKey);
    const url = buildUrl(config, endpoint);

    ctx.onLog?.(`POST ${endpoint}`);
    ctx.onProgress?.(0, "Submitting task...");

    // Submit
    const submitRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });

    const submitData = (await submitRes.json()) as Record<string, unknown>;

    if (!submitRes.ok) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: `HTTP ${submitRes.status}: ${JSON.stringify(submitData)}`,
        data: submitData,
      };
    }

    const taskId = submitData.result as string;
    if (!taskId) {
      return {
        bridgeName: config.name,
        action,
        success: false,
        error: "No task ID returned from API",
        data: submitData,
      };
    }

    ctx.onLog?.(`Task created: ${taskId}`);

    // Derive the GET endpoint from the POST endpoint
    const pollUrl = buildUrl(config, `${endpoint}/${taskId}`);
    const pollIntervalMs = 3000;
    const maxPollMs = 600_000; // 10 minutes
    const startTime = Date.now();

    // Poll
    while (Date.now() - startTime < maxPollMs) {
      await sleep(pollIntervalMs, ctx.signal);

      const pollRes = await fetch(pollUrl, { headers, signal: ctx.signal });
      const pollData = (await pollRes.json()) as Record<string, unknown>;

      if (!pollRes.ok) {
        ctx.onLog?.(`Poll error: HTTP ${pollRes.status}`);
        continue;
      }

      const status = String(pollData.status ?? "");
      const progress = typeof pollData.progress === "number" ? pollData.progress : null;
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      ctx.onProgress?.(progress, `${status} (${elapsed}s)`);
      ctx.onLog?.(`Status: ${status}, progress: ${progress ?? "?"}% (${elapsed}s)`);

      if (status === "SUCCEEDED") {
        const outputFiles = this.extractOutputFiles(pollData);
        return {
          bridgeName: config.name,
          action,
          success: true,
          data: pollData,
          externalTaskId: taskId,
          externalStatus: status,
          outputFiles,
        };
      }

      if (status === "FAILED" || status === "CANCELED") {
        const taskError = pollData.task_error as Record<string, unknown> | undefined;
        return {
          bridgeName: config.name,
          action,
          success: false,
          data: pollData,
          externalTaskId: taskId,
          externalStatus: status,
          error: taskError?.message
            ? String(taskError.message)
            : `Task ${status.toLowerCase()}`,
        };
      }
    }

    return {
      bridgeName: config.name,
      action,
      success: false,
      externalTaskId: taskId,
      error: `Polling timed out after ${maxPollMs / 1000}s`,
    };
  }

  /** Extract downloadable output files from a completed task response. */
  private extractOutputFiles(data: Record<string, unknown>): ApiBridgeOutputFile[] {
    const files: ApiBridgeOutputFile[] = [];

    // Model URLs (glb, fbx, obj, etc.)
    const modelUrls = data.model_urls as Record<string, string> | undefined;
    if (modelUrls) {
      for (const [format, url] of Object.entries(modelUrls)) {
        if (url) {
          files.push({
            url,
            filename: `model.${format}`,
            mimeType: getMimeType(format),
          });
        }
      }
    }

    // Thumbnail
    if (typeof data.thumbnail_url === "string" && data.thumbnail_url) {
      files.push({
        url: data.thumbnail_url,
        filename: "thumbnail.png",
        mimeType: "image/png",
      });
    }

    // Texture URLs (PBR maps)
    const textureUrls = data.texture_urls as Array<Record<string, string>> | undefined;
    if (Array.isArray(textureUrls)) {
      for (let i = 0; i < textureUrls.length; i++) {
        const tex = textureUrls[i];
        for (const [mapType, url] of Object.entries(tex)) {
          if (url) {
            files.push({
              url,
              filename: `texture_${i}_${mapType}.png`,
              mimeType: "image/png",
            });
          }
        }
      }
    }

    return files;
  }
}

function getMimeType(format: string): string {
  switch (format) {
    case "glb": return "model/gltf-binary";
    case "obj": return "text/plain";
    case "fbx": return "application/octet-stream";
    case "stl": return "model/stl";
    case "usdz": return "model/vnd.usdz+zip";
    case "3mf": return "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
    default: return "application/octet-stream";
  }
}
