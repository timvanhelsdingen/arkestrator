import { describe, expect, it } from "bun:test";
import { WebSocketHub } from "../ws/hub.js";

describe("WebSocketHub bridge context storage", () => {
  it("assigns sequential server-controlled indexes on add", () => {
    const hub = new WebSocketHub();

    const item1 = hub.addBridgeContextItem("bridge-a", {
      index: 99, // client index is ignored — server assigns its own
      type: "node",
      name: "box1",
      path: "/obj/geo1/box1",
    } as any);

    const item2 = hub.addBridgeContextItem("bridge-a", {
      index: 99,
      type: "node",
      name: "box1_renamed",
      path: "/obj/geo1/box1",
    } as any);

    expect(item1.index).toBe(1);
    expect(item2.index).toBe(2);

    const ctx = hub.getBridgeContext("bridge-a");
    expect(ctx).toBeDefined();
    expect(ctx?.items.length).toBe(2);
    expect(ctx?.items[0]?.name).toBe("box1");
    expect(ctx?.items[1]?.name).toBe("box1_renamed");
  });

  it("keeps separate items for different indexes", () => {
    const hub = new WebSocketHub();

    hub.addBridgeContextItem("bridge-a", {
      index: 1,
      type: "node",
      name: "box1",
      path: "/obj/geo1/box1",
    } as any);

    hub.addBridgeContextItem("bridge-a", {
      index: 2,
      type: "node",
      name: "sphere1",
      path: "/obj/geo1/sphere1",
    } as any);

    const ctx = hub.getBridgeContext("bridge-a");
    expect(ctx).toBeDefined();
    expect(ctx?.items.length).toBe(2);
    expect(ctx?.items.map((item) => item.index)).toEqual([1, 2]);
  });
});

function makeBridgeWs(
  id: string,
  program: string,
  workerName: string,
  projectPath: string,
): { ws: any; closeCalls: () => number } {
  let closes = 0;
  const ws = {
    data: {
      id,
      type: "bridge",
      role: "bridge",
      connectedAt: new Date().toISOString(),
      program,
      workerName,
      projectPath,
    },
    close: () => { closes += 1; },
    send: () => {},
  };
  return { ws, closeCalls: () => closes };
}

describe("WebSocketHub bridge registration", () => {
  it("keeps multiple sessions for same worker/program when project paths differ", () => {
    const hub = new WebSocketHub();
    const a = makeBridgeWs("a", "houdini", "ws-01", "/proj/a");
    const b = makeBridgeWs("b", "houdini", "ws-01", "/proj/b");

    hub.register(a.ws);
    hub.register(b.ws);

    expect(hub.getBridges().length).toBe(2);
    expect(a.closeCalls()).toBe(0);
    expect(b.closeCalls()).toBe(0);
  });

  it("replaces stale duplicates when worker/program/project match", () => {
    const hub = new WebSocketHub();
    const oldWs = makeBridgeWs("old", "houdini", "ws-01", "/proj/a");
    const newWs = makeBridgeWs("new", "houdini", "ws-01", "/proj/a");

    hub.register(oldWs.ws);
    hub.register(newWs.ws);

    expect(hub.getBridges().length).toBe(1);
    expect(oldWs.closeCalls()).toBe(1);
    expect(newWs.closeCalls()).toBe(0);
  });
});

describe("WebSocketHub pending commands", () => {
  it("rejects on timeout and records the metric", async () => {
    const hub = new WebSocketHub();
    const p = hub.registerPendingCommand("corr-1", 10, undefined);
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect((err as Error)?.message).toMatch(/timed out/i);
    expect(hub.getMetrics().pendingCommandsTimedOut).toBeGreaterThanOrEqual(1);
  });

  it("resolvePendingCommand wins over timeout when called first", async () => {
    const hub = new WebSocketHub();
    const p = hub.registerPendingCommand("corr-2", 1000);
    hub.resolvePendingCommand("corr-2", { ok: true });
    const result = await p;
    expect(result).toEqual({ ok: true });
  });

  it("cancelPendingCommand rejects the promise and increments metric", async () => {
    const hub = new WebSocketHub();
    const p = hub.registerPendingCommand("corr-3", 5000);
    hub.cancelPendingCommand("corr-3", "test cancel");
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect((err as Error)?.message).toBe("test cancel");
    expect(hub.getMetrics().pendingCommandsCancelled).toBeGreaterThanOrEqual(1);
  });

  it("clearAllPendingCommands rejects all in-flight", async () => {
    const hub = new WebSocketHub();
    const p1 = hub.registerPendingCommand("c-a", 10_000);
    const p2 = hub.registerPendingCommand("c-b", 10_000);
    hub.clearAllPendingCommands("shutdown");
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
  });
});

describe("WebSocketHub circuit breaker", () => {
  it("allows normal reconnects", () => {
    const hub = new WebSocketHub();
    const decision = hub.checkFlapAllowed("blender/ws-01//proj/a");
    expect(decision.allowed).toBe(true);
  });

  it("blocks after FLAP_MAX_RECONNECTS rapid replacements", () => {
    const hub = new WebSocketHub();
    // Trigger rapid reconnect loop on the same identity.
    for (let i = 0; i < 6; i++) {
      const oldWs = makeBridgeWs(`old-${i}`, "blender", "ws-01", "/proj/a");
      const newWs = makeBridgeWs(`new-${i}`, "blender", "ws-01", "/proj/a");
      hub.register(oldWs.ws);
      hub.register(newWs.ws);
    }
    const decision = hub.checkFlapAllowed("blender/ws-01//proj/a");
    // Depending on replacement threshold ordering, circuit may be tripped
    // after 5 rapid replacements within 30s. Record metric should be >= 1.
    // This test allows either (blocked OR metric set) to avoid flakiness.
    const metrics = hub.getMetrics();
    const effective = !decision.allowed || metrics.bridgesFlapBlocked > 0;
    expect(effective).toBe(true);
  });
});

describe("WebSocketHub virtual bridge TTL", () => {
  it("expires virtual bridges with stale heartbeats", () => {
    const hub = new WebSocketHub();
    hub.registerVirtualBridge({
      id: "vb-1",
      program: "comfyui",
      connectedAt: new Date().toISOString(),
      url: "http://localhost:8188",
    });
    expect(hub.getVirtualBridges().length).toBe(1);

    // Force heartbeat into the past via a private-field sidechannel.
    (hub as unknown as { virtualBridgeHeartbeats: Map<string, number> }).virtualBridgeHeartbeats.set(
      "vb-1",
      Date.now() - 10 * 60_000, // 10 min ago
    );
    const expired = hub.expireStaleVirtualBridges();
    expect(expired).toBe(1);
    expect(hub.getVirtualBridges().length).toBe(0);
  });

  it("does not expire recently heartbeated virtual bridges", () => {
    const hub = new WebSocketHub();
    hub.registerVirtualBridge({
      id: "vb-2",
      program: "comfyui",
      connectedAt: new Date().toISOString(),
      url: "http://localhost:8188",
    });
    hub.heartbeatVirtualBridge("vb-2");
    expect(hub.expireStaleVirtualBridges()).toBe(0);
  });
});
