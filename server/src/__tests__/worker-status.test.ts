import { describe, expect, it } from "bun:test";
import type { Worker } from "@arkestrator/protocol";
import { enrichWorkersWithLivePresence } from "../utils/worker-status.js";

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: "machine-1",
    name: "tims-macbook-pro.local",
    status: "offline",
    lastProgram: "blender",
    lastProjectPath: "/Users/timvanhelsdingen",
    lastIp: "2a02:a46e:5217:1:103:396:a6e5:df53",
    activeBridgeCount: 0,
    knownPrograms: ["blender"],
    firstSeenAt: "2026-03-01T19:20:19.258Z",
    lastSeenAt: "2026-03-01T19:41:27.704Z",
    ...overrides,
  };
}

describe("enrichWorkersWithLivePresence", () => {
  it("marks only the named worker online when two workers share the same visible IP", () => {
    const macbook = makeWorker({
      name: "tims-mbp.fritz.box",
      lastIp: "2a02:a46e:5217:1:3420:36ea:c924:a788",
    });
    const desktop = makeWorker({
      id: "22222222-2222-4222-8222-222222222222",
      machineId: "machine-2",
      name: "tvh-13900k",
      lastIp: "2a02:a46e:5217:1:3420:36ea:c924:a788",
      lastSeenAt: "2026-03-01T19:45:27.704Z",
    });
    const out = enrichWorkersWithLivePresence(
      [macbook, desktop],
      [],
      [{ workerName: "tims-mbp.fritz.box", machineId: "machine-1", ip: "2a02:a46e:5217:1:3420:36ea:c924:a788" }],
    );

    expect(out[0].status).toBe("online");
    expect(out[1].status).toBe("offline");
  });

  it("marks worker online when client reports matching workerName", () => {
    const worker = makeWorker({ name: "TVH-13900K", lastIp: undefined });
    const out = enrichWorkersWithLivePresence(
      [worker],
      [],
      [{ workerName: "tvh-13900k", machineId: "machine-1" }],
    );

    expect(out[0].status).toBe("online");
    expect(out[0].activeBridgeCount).toBe(0);
  });

  it("keeps bridge count and offline status when no bridge/client presence exists", () => {
    const worker = makeWorker({ name: "orphan-worker", lastIp: "10.0.0.20" });
    const out = enrichWorkersWithLivePresence(
      [worker],
      [{ workerName: "another-worker", machineId: "machine-x" }, { workerName: "another-worker", machineId: "machine-x" }],
      [{ ip: "10.0.0.30" }],
    );

    expect(out[0].status).toBe("offline");
    expect(out[0].activeBridgeCount).toBe(0);
  });

  it("marks worker online and reports activeBridgeCount when bridges are connected", () => {
    const worker = makeWorker({ name: "tvh-13900k", lastIp: undefined });
    const out = enrichWorkersWithLivePresence(
      [worker],
      [{ workerName: "tvh-13900k", machineId: "machine-1" }, { workerName: "TVH-13900K", machineId: "machine-1" }],
      [],
    );

    expect(out[0].status).toBe("online");
    expect(out[0].activeBridgeCount).toBe(2);
  });

  it("matches renamed bridges to the same worker by machineId", () => {
    const worker = makeWorker({ name: "tim’s-macbook-pro", machineId: "machine-123" });
    const out = enrichWorkersWithLivePresence(
      [worker],
      [{ workerName: "e01b7729-0c8f-4c77-877a-d9a9191a675b.fritz.box", machineId: "machine-123" }],
      [],
    );

    expect(out[0].status).toBe("online");
    expect(out[0].activeBridgeCount).toBe(1);
  });
});
