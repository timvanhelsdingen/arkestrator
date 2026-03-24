import { describe, expect, it } from "bun:test";
import { ProcessTracker } from "../agents/process-tracker.js";

describe("ProcessTracker suspend/resume", () => {
  it("suspend removes from count, resume restores", () => {
    const tracker = new ProcessTracker(60_000);
    // Create a mock subprocess
    const mockProc = { kill: () => {}, pid: 1234 } as any;

    tracker.register("job-1", mockProc);
    expect(tracker.count).toBe(1);

    // Suspend should free the slot
    const suspended = tracker.suspend("job-1");
    expect(suspended).toBe(true);
    expect(tracker.count).toBe(0);

    // Resume should re-acquire the slot
    const resumed = tracker.resume("job-1");
    expect(resumed).toBe(true);
    expect(tracker.count).toBe(1);

    // Cleanup
    tracker.unregister("job-1");
    expect(tracker.count).toBe(0);
  });

  it("suspend returns false for unknown job", () => {
    const tracker = new ProcessTracker(60_000);
    expect(tracker.suspend("nonexistent")).toBe(false);
  });

  it("resume returns false for non-suspended job", () => {
    const tracker = new ProcessTracker(60_000);
    expect(tracker.resume("nonexistent")).toBe(false);
  });

  it("concurrent jobs with suspend", () => {
    const tracker = new ProcessTracker(60_000);
    const mock1 = { kill: () => {}, pid: 1 } as any;
    const mock2 = { kill: () => {}, pid: 2 } as any;

    tracker.register("job-1", mock1);
    tracker.register("job-2", mock2);
    expect(tracker.count).toBe(2);

    // Suspend job-1 (training parent)
    tracker.suspend("job-1");
    expect(tracker.count).toBe(1); // Only job-2 counted

    // Job-2 completes
    tracker.unregister("job-2");
    expect(tracker.count).toBe(0);

    // Resume job-1
    tracker.resume("job-1");
    expect(tracker.count).toBe(1);

    tracker.unregister("job-1");
  });

  it("stop cleans up suspended processes", () => {
    const tracker = new ProcessTracker(60_000);
    let killed = false;
    const mockProc = { kill: () => { killed = true; }, pid: 1 } as any;

    tracker.register("job-1", mockProc);
    tracker.suspend("job-1");
    expect(tracker.count).toBe(0);

    tracker.stop();
    expect(killed).toBe(true);
  });
});
