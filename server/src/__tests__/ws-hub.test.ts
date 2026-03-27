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
