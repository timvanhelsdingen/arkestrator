import { z } from "zod";

export const JobInterventionSource = z.enum(["jobs", "chat", "mcp"]);
export type JobInterventionSource = z.infer<typeof JobInterventionSource>;

export const JobInterventionStatus = z.enum(["pending", "delivered", "superseded", "rejected"]);
export type JobInterventionStatus = z.infer<typeof JobInterventionStatus>;

export const JobIntervention = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  authorUserId: z.string().uuid().optional(),
  authorUsername: z.string().optional(),
  source: JobInterventionSource,
  status: JobInterventionStatus,
  text: z.string(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
  rejectedAt: z.string().datetime().optional(),
  statusReason: z.string().optional(),
  deliveryMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type JobIntervention = z.infer<typeof JobIntervention>;

export const JobInterventionCreate = z.object({
  text: z.string().min(1).max(4000),
  source: JobInterventionSource.default("jobs"),
});
export type JobInterventionCreate = z.infer<typeof JobInterventionCreate>;

export const JobInterventionSupport = z.object({
  acceptsQueuedNotes: z.boolean(),
  acceptsLiveNotes: z.boolean(),
  liveReason: z.string().optional(),
});
export type JobInterventionSupport = z.infer<typeof JobInterventionSupport>;
