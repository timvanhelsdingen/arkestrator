import type { ServerWebSocket } from "bun";
import type { CommandResult } from "@arkestrator/protocol";
import type { WebSocketHub, WsData } from "../ws/hub.js";

export type HeavyResourceClass = "gpu_vram_heavy";

export interface WorkerResourceLeaseOwner {
  ownerId: string;
  ownerLabel: string;
  program: string;
}

export interface WorkerResourceLeaseConflict {
  workerKey: string;
  resource: HeavyResourceClass;
  holder: WorkerResourceLeaseOwner & { acquiredAt: string };
}

interface HeldLease extends WorkerResourceLeaseOwner {
  acquiredAt: string;
}

export interface WorkerResourceLease {
  release(): void;
}

export interface BridgeTargetResolution {
  targets: ServerWebSocket<WsData>[];
  workerKeys: string[];
  error?: string;
}

export function normalizeWorkerKey(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

export function workerKeyFromWsData(data: Pick<WsData, "machineId" | "workerName">): string {
  return normalizeWorkerKey(data.machineId) || normalizeWorkerKey(data.workerName);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function commandText(commands: Array<Pick<CommandResult, "language" | "script" | "description">>): string {
  return commands
    .flatMap((command) => [command.language, command.description, command.script])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function isBlenderGpuHeavy(text: string): boolean {
  return /(bpy\.ops\.render\.render|render\.animation|write_still|bpy\.ops\.object\.bake|bpy\.ops\.ptcache\.bake|bpy\.ops\.fluid\.bake|cycles|eevee|compositor)/i
    .test(text);
}

function isHoudiniGpuHeavy(text: string): boolean {
  return /(karma|mantra|husk|render\(|\.render\(|hou\.RopNode|usd_rop|usdrender|pyro|flip|vellum|simulation|cache|rop)/i
    .test(text);
}

function isComfyGpuHeavy(commands: Array<Pick<CommandResult, "language" | "script" | "description">>, text: string): boolean {
  if (commands.some((command) => {
    const language = String(command.language ?? "").trim().toLowerCase();
    return language === "workflow" || language === "comfyui";
  })) {
    return true;
  }
  return /(queue_prompt|\/prompt|ksampler|sampler|latent|checkpoint|save_image|saveimage|comfyui|workflow)/i.test(text);
}

export function inferBridgeCommandHeavyResources(
  program: string,
  commands: Array<Pick<CommandResult, "language" | "script" | "description">>,
): HeavyResourceClass[] {
  const normalizedProgram = String(program ?? "").trim().toLowerCase();
  if (!normalizedProgram || commands.length === 0) return [];
  const text = commandText(commands);
  if (!text) return [];

  if (normalizedProgram === "comfyui" && isComfyGpuHeavy(commands, text)) {
    return ["gpu_vram_heavy"];
  }
  if (normalizedProgram === "blender" && isBlenderGpuHeavy(text)) {
    return ["gpu_vram_heavy"];
  }
  if (normalizedProgram === "houdini" && isHoudiniGpuHeavy(text)) {
    return ["gpu_vram_heavy"];
  }
  return [];
}

export function inferHeadlessArgsHeavyResources(program: string, args: string[]): HeavyResourceClass[] {
  const normalizedProgram = String(program ?? "").trim().toLowerCase();
  const normalizedArgs = args.map((arg) => String(arg ?? "").trim().toLowerCase()).filter(Boolean);
  if (!normalizedProgram || normalizedArgs.length === 0) return [];

  if (normalizedProgram === "blender") {
    const heavy = normalizedArgs.some((arg) => (
      arg === "-a"
      || arg === "--render-anim"
      || arg === "-f"
      || arg === "--render-frame"
      || arg === "--render-output"
      || arg.includes("render")
    ));
    return heavy ? ["gpu_vram_heavy"] : [];
  }

  if (normalizedProgram === "houdini") {
    const heavy = normalizedArgs.some((arg) => (
      arg.includes("karma")
      || arg.includes("mantra")
      || arg.includes("husk")
      || arg.includes("hrender")
      || arg.includes("render")
    ));
    return heavy ? ["gpu_vram_heavy"] : [];
  }

  return [];
}

export function resolveBridgeTargets(
  hub: WebSocketHub,
  target: string,
  targetType: "program" | "id" = "program",
  targetWorkerName?: string,
  submitterWorkerName?: string,
): BridgeTargetResolution {
  const normalizedWorker = normalizeWorkerKey(targetWorkerName);
  let targets: ServerWebSocket<WsData>[] = [];

  if (targetType === "id") {
    const direct = hub.getConnection(target);
    if (direct && direct.data.type === "bridge") {
      targets = [direct];
    }
  } else {
    targets = hub.getBridgesByProgram(target);
    if (normalizedWorker) {
      targets = targets.filter((ws) => {
        const workerKey = workerKeyFromWsData(ws.data);
        return workerKey === normalizedWorker || normalizeWorkerKey(ws.data.workerName) === normalizedWorker;
      });
    }
  }

  // Filter out bridges belonging to workers with workerMode disabled,
  // unless the job submitter is on the same machine (self-routing).
  const normalizedSubmitterWorker = String(submitterWorkerName ?? "").trim().toLowerCase();
  const disabledClients = hub.getClients().filter((c) => c.workerMode === false);
  if (disabledClients.length > 0) {
    targets = targets.filter((ws) => {
      const bridgeMachine = String(ws.data.machineId ?? "").trim().toLowerCase();
      const bridgeWorker = String(ws.data.workerName ?? "").trim().toLowerCase();
      // Self-routing: allow if submitter's worker matches bridge's worker/machine
      if (normalizedSubmitterWorker && bridgeWorker && normalizedSubmitterWorker === bridgeWorker) return true;
      // Check if any disabled client owns this bridge
      for (const c of disabledClients) {
        const clientMachine = String(c.machineId ?? "").trim().toLowerCase();
        const clientWorker = String(c.workerName ?? "").trim().toLowerCase();
        if (clientMachine && bridgeMachine && clientMachine === bridgeMachine) return false;
        if (clientWorker && bridgeWorker && clientWorker === bridgeWorker) return false;
      }
      return true;
    });
  }

  const workerKeys = uniq(targets.map((ws) => workerKeyFromWsData(ws.data)).filter(Boolean));
  if (normalizedWorker && targetType === "id" && targets.length === 1) {
    const workerKey = workerKeyFromWsData(targets[0].data);
    if (workerKey !== normalizedWorker && normalizeWorkerKey(targets[0].data.workerName) !== normalizedWorker) {
      return {
        targets: [],
        workerKeys: [],
        error: `Bridge "${target}" is not connected on worker "${normalizedWorker}"`,
      };
    }
  }

  if (targets.length === 0) {
    return {
      targets,
      workerKeys,
      error: normalizedWorker
        ? `No connected bridge found for target: ${target} on worker "${normalizedWorker}"`
        : `No connected bridge found for target: ${target}`,
    };
  }

  return { targets, workerKeys };
}

export function formatHeavyResourceConflictError(
  conflict: WorkerResourceLeaseConflict,
  requestedProgram: string,
): string {
  const holderProgram = String(conflict.holder.program ?? "").trim() || "unknown-program";
  const holderLabel = String(conflict.holder.ownerLabel ?? "").trim() || conflict.holder.ownerId;
  return `Worker "${conflict.workerKey}" is already running a conflicting ${conflict.resource} task on ${holderProgram} (${holderLabel}); refusing to overlap it with ${requestedProgram}. Wait for it to finish or target a different worker.`;
}

export class WorkerResourceLeaseManager {
  private leases = new Map<string, HeldLease>();

  acquire(
    workerKeys: string[],
    resources: HeavyResourceClass[],
    owner: WorkerResourceLeaseOwner,
  ): { ok: true; lease: WorkerResourceLease } | { ok: false; conflict: WorkerResourceLeaseConflict } {
    const uniqueWorkers = uniq(workerKeys.map((value) => normalizeWorkerKey(value)));
    const uniqueResources = uniq(resources.map((value) => String(value ?? "").trim().toLowerCase()))
      .filter((value): value is HeavyResourceClass => value === "gpu_vram_heavy");

    if (uniqueWorkers.length === 0 || uniqueResources.length === 0) {
      return {
        ok: true,
        lease: { release() {} },
      };
    }

    for (const workerKey of uniqueWorkers) {
      for (const resource of uniqueResources) {
        const key = `${workerKey}:${resource}`;
        const held = this.leases.get(key);
        if (held) {
          return {
            ok: false,
            conflict: {
              workerKey,
              resource,
              holder: held,
            },
          };
        }
      }
    }

    const now = new Date().toISOString();
    const ownedKeys: string[] = [];
    for (const workerKey of uniqueWorkers) {
      for (const resource of uniqueResources) {
        const key = `${workerKey}:${resource}`;
        this.leases.set(key, {
          ...owner,
          acquiredAt: now,
        });
        ownedKeys.push(key);
      }
    }

    let released = false;
    return {
      ok: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          for (const key of ownedKeys) {
            const held = this.leases.get(key);
            if (held?.ownerId === owner.ownerId) {
              this.leases.delete(key);
            }
          }
        },
      },
    };
  }
}
