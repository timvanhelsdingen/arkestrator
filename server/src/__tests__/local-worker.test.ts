import { describe, expect, it } from "bun:test";
import {
  findStaleLoopbackWorkerIds,
  isLoopbackIp,
  resolveCanonicalLoopbackWorkerName,
} from "../utils/local-worker.js";

describe("local worker helpers", () => {
  it("prefers the client-owned shared workerName for loopback sockets", () => {
    expect(resolveCanonicalLoopbackWorkerName({
      socketWorkerName: "e01b7729-0c8f-4c77-877a-d9a9191a675b.fritz.box",
      sharedWorkerName: "Tim’s MacBook Pro",
      ip: "127.0.0.1",
    })).toBe("Tim’s MacBook Pro");
  });

  it("keeps the socket workerName for non-loopback sockets", () => {
    expect(resolveCanonicalLoopbackWorkerName({
      socketWorkerName: "render-node-01",
      sharedWorkerName: "artist-mbp",
      ip: "10.0.0.12",
    })).toBe("render-node-01");
  });

  it("finds stale loopback aliases once a canonical local worker exists", () => {
    expect(findStaleLoopbackWorkerIds(
      [
        { id: "w1", name: "tim’s-macbook-pro", lastIp: "127.0.0.1" },
        { id: "w2", name: "host-127.0.0.1", lastIp: "127.0.0.1" },
        { id: "w3", name: "e01b7729-0c8f-4c77-877a-d9a9191a675b.fritz.box", lastIp: "127.0.0.1" },
        { id: "w4", name: "remote-workstation", lastIp: "10.0.0.12" },
      ],
      "tim’s-macbook-pro",
      "127.0.0.1",
    )).toEqual(["w2", "w3"]);
  });

  it("recognizes loopback IPv4 and IPv6 addresses", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("10.0.0.5")).toBe(false);
  });
});
