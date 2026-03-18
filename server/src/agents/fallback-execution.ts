import type { CommandResult } from "@arkestrator/protocol";
import type { HeadlessProgramsRepo } from "../db/headless-programs.repo.js";
import type { Config } from "../config.js";
import { executeComfyUiHeadless } from "./comfyui-headless.js";
import { executeHeadless } from "./headless-executor.js";

export interface BridgeFallbackRequest {
  program: string;
  commands: CommandResult[];
  config: Config;
  headlessProgramsRepo?: HeadlessProgramsRepo;
  timeoutMs: number;
  projectPath?: string;
}

export interface BridgeFallbackResponse {
  handled: boolean;
  success: boolean;
  program: string;
  result?: unknown;
  summary?: string;
  error?: string;
}

const PROGRAM_EXECUTORS: Record<string, (request: BridgeFallbackRequest) => Promise<BridgeFallbackResponse>> = {
  comfyui: async (request) => {
    const comfyResult = await executeComfyUiHeadless(
      request.commands,
      request.config.comfyuiUrl,
      { timeoutMs: request.timeoutMs },
    );

    if (!comfyResult.success) {
      return {
        handled: true,
        success: false,
        program: "comfyui",
        result: comfyResult,
        error: `No online comfyui bridge and fallback execution failed: ${comfyResult.errors.join("; ")}`,
      };
    }

    const artifactCount = Array.isArray(comfyResult.outputs) ? comfyResult.outputs.length : 0;
    const summary = comfyResult.stdout || `ComfyUI fallback executed ${comfyResult.executed} command(s)`;
    return {
      handled: true,
      success: true,
      program: "comfyui",
      result: comfyResult,
      summary: `${summary} (artifacts=${artifactCount})`,
    };
  },
};

export async function executeBridgeFallback(
  request: BridgeFallbackRequest,
): Promise<BridgeFallbackResponse> {
  const program = String(request.program ?? "").trim().toLowerCase();
  if (!program) {
    return { handled: false, success: false, program: "" };
  }

  const programExecutor = PROGRAM_EXECUTORS[program];
  if (programExecutor) {
    return programExecutor(request);
  }

  const headlessProgram = request.headlessProgramsRepo?.getByProgram(program);
  if (!headlessProgram || !headlessProgram.enabled) {
    return { handled: false, success: false, program };
  }

  const headlessResult = await executeHeadless(
    headlessProgram,
    request.commands,
    request.config,
    {
      timeoutMs: request.timeoutMs,
      projectPath: request.projectPath,
    },
  );
  if (!headlessResult.success) {
    return {
      handled: true,
      success: false,
      program,
      result: headlessResult,
      error: `No online ${program} bridge and fallback execution failed: ${headlessResult.errors.join("; ")}`,
    };
  }

  const summary = headlessResult.stdout || `${program} headless fallback succeeded`;
  return {
    handled: true,
    success: true,
    program,
    result: headlessResult,
    summary,
  };
}
