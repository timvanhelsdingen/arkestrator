import { z } from "zod";

export const WorkerStatus = z.enum(["online", "offline"]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const Worker = z.object({
  id: z.string().uuid(),
  machineId: z.string().optional().describe("Stable client-owned machine identity"),
  name: z.string().describe("Unique worker name (typically hostname)"),
  status: WorkerStatus,
  lastProgram: z.string().optional(),
  lastProjectPath: z.string().optional(),
  lastIp: z.string().optional(),
  /** Number of currently active bridge connections */
  activeBridgeCount: z.number().int().nonnegative().default(0),
  /** All programs this worker has historically provided (persisted across reboots) */
  knownPrograms: z.array(z.string()).default([]),
  /** Whether the client has worker mode enabled (accepts jobs from other machines) */
  workerModeEnabled: z.boolean().optional(),
  /** True when this worker represents the Arkestrator server itself (hosts API bridges) */
  isServerWorker: z.boolean().optional(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type Worker = z.infer<typeof Worker>;

export const BridgeInfo = z.object({
  id: z.string(),
  machineId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  connected: z.boolean(),
  lastSeen: z.string().datetime().optional(),
  program: z.string().optional(),
  programVersion: z.string().optional(),
  bridgeVersion: z.string().optional(),
  projectPath: z.string().optional(),
  activeProjects: z.array(z.string()).default([]),
  ip: z.string().optional(),
  workerName: z.string().optional(),
  connectedAt: z.string().datetime().optional(),
  osUser: z.string().optional(),
});
export type BridgeInfo = z.infer<typeof BridgeInfo>;
