import type { Worker } from "@arkestrator/protocol";

function clean(value?: string | null): string {
  return String(value ?? "").trim();
}

export function isLoopbackIp(ip?: string | null): boolean {
  const normalized = clean(ip).replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function resolveCanonicalLoopbackWorkerName(input: {
  socketWorkerName?: string | null;
  sharedWorkerName?: string | null;
  ip?: string | null;
}): string | undefined {
  const sharedWorkerName = clean(input.sharedWorkerName);
  if (isLoopbackIp(input.ip) && sharedWorkerName) {
    return sharedWorkerName;
  }

  const socketWorkerName = clean(input.socketWorkerName);
  return socketWorkerName || undefined;
}

export function findStaleLoopbackWorkerIds(
  workers: Array<Pick<Worker, "id" | "name" | "lastIp">>,
  canonicalWorkerName?: string | null,
  ip?: string | null,
): string[] {
  if (!isLoopbackIp(ip)) return [];

  const canonical = clean(canonicalWorkerName).toLowerCase();
  if (!canonical) return [];

  return workers
    .filter((worker) => {
      const workerName = clean(worker.name).toLowerCase();
      return workerName.length > 0 && workerName !== canonical && isLoopbackIp(worker.lastIp);
    })
    .map((worker) => worker.id);
}
