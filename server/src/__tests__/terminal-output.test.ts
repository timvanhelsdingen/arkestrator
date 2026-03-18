import { describe, expect, it } from "bun:test";
import { sanitizeTerminalChunk } from "../utils/terminal-output.js";

describe("sanitizeTerminalChunk", () => {
  it("removes ansi escape sequences", () => {
    const raw = "\u001b[?2026h\u001b[?25l\u001b[1G⠙ \u001b[K\u001b[?25hhello";
    const out = sanitizeTerminalChunk(raw);
    expect(out).toBe("⠙ hello");
  });

  it("removes carriage-return progress rewrites", () => {
    const raw = "step 1\rstep 2\rfinal line\n";
    const out = sanitizeTerminalChunk(raw);
    expect(out).toBe("step 1step 2final line\n");
  });
});

