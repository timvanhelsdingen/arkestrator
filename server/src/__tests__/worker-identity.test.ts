import { describe, expect, it } from "bun:test";
import { deriveWorkerIdentity, normalizeQuotes } from "../utils/worker-identity.js";

describe("normalizeQuotes", () => {
  it("converts smart single quotes to ASCII", () => {
    expect(normalizeQuotes("tim\u2019s-macbook-pro")).toBe("tim's-macbook-pro");
    expect(normalizeQuotes("tim\u2018s-macbook-pro")).toBe("tim's-macbook-pro");
  });

  it("converts smart double quotes to ASCII", () => {
    expect(normalizeQuotes("say \u201Chello\u201D")).toBe('say "hello"');
  });

  it("leaves ASCII quotes unchanged", () => {
    expect(normalizeQuotes("tim's-macbook-pro")).toBe("tim's-macbook-pro");
  });
});

describe("deriveWorkerIdentity", () => {
  it("prefers explicit workerName", () => {
    const result = deriveWorkerIdentity({
      workerName: "  Fedora.Workstation  ",
      osUser: "tim",
      ip: "127.0.0.1",
      program: "blender",
    });
    expect(result).toBe("fedora.workstation");
  });

  it("falls back to osUser@ip when workerName missing", () => {
    const result = deriveWorkerIdentity({
      workerName: "   ",
      osUser: "Tim",
      ip: "192.168.1.10",
      program: "houdini",
    });
    expect(result).toBe("tim@192.168.1.10");
  });

  it("falls back to host-ip, then name, then program", () => {
    expect(deriveWorkerIdentity({ ip: "10.0.0.5" })).toBe("host-10.0.0.5");
    expect(deriveWorkerIdentity({ name: "My Bridge Instance" })).toBe("my-bridge-instance");
    expect(deriveWorkerIdentity({ program: "comfyui" })).toBe("comfyui-bridge");
  });

  it("normalizes Unicode smart quotes in worker names", () => {
    // macOS hostnames use U+2019 (RIGHT SINGLE QUOTATION MARK) instead of ASCII apostrophe
    const result = deriveWorkerIdentity({
      workerName: "tim\u2019s-macbook-pro",
    });
    expect(result).toBe("tim's-macbook-pro");
  });
});
