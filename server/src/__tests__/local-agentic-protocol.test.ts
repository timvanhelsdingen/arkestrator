import { describe, expect, test } from "bun:test";
import {
  parseLocalAgenticAction,
  type LocalAgenticAction,
} from "../agents/local-agentic-protocol.js";

function mustParse(raw: string): LocalAgenticAction {
  const parsed = parseLocalAgenticAction(raw);
  if (!parsed.action) {
    throw new Error(parsed.error ?? "failed to parse local action");
  }
  return parsed.action;
}

function mustParseToolCall(raw: string) {
  const action = mustParse(raw);
  if (action.type !== "tool_call") throw new Error(`expected tool_call, got ${action.type}`);
  return action;
}

describe("parseLocalAgenticAction", () => {
  test("parses plain JSON tool calls", () => {
    const action = mustParseToolCall(
      JSON.stringify({
        type: "tool_call",
        tool: "execute_command",
        args: { target: "godot", language: "gdscript", script: "print('x')" },
      }),
    );
    expect(action.tool).toBe("execute_command");
  });

  test("parses fenced JSON tool calls", () => {
    const action = mustParseToolCall(
      "```json\n" + JSON.stringify({ type: "tool_call", tool: "list_bridges", args: {} }) + "\n```",
    );
    expect(action.tool).toBe("list_bridges");
  });

  test("parses balanced JSON embedded in prose", () => {
    const action = mustParseToolCall(
      `I will call a tool now:\n{"type":"tool_call","tool":"list_jobs","args":{"limit":5}}`,
    );
    expect(action.tool).toBe("list_jobs");
  });

  test("parses final payload", () => {
    const action = mustParse(
      JSON.stringify({ type: "final", status: "completed", summary: "Task finished." }),
    );
    expect(action.type).toBe("final");
    if (action.type === "final") {
      expect(action.status).toBe("completed");
    }
  });

  test("accepts unknown tools (MCP server validates names)", () => {
    const parsed = parseLocalAgenticAction(
      JSON.stringify({ type: "tool_call", tool: "shell_exec", args: {} }),
    );
    expect(parsed.action).toBeDefined();
    expect(parsed.action!.type).toBe("tool_call");
    if (parsed.action!.type === "tool_call") {
      expect(parsed.action!.tool).toBe("shell_exec");
    }
  });

  test("recovers malformed list_bridges args payload", () => {
    const action = mustParseToolCall(
      '{"type":"tool_call","tool":"list_bridges","args":{"}}',
    );
    expect(action.tool).toBe("list_bridges");
    expect(action.args).toEqual({});
  });

  test("recovers malformed get_bridge_context payload with extra fields", () => {
    const action = mustParseToolCall(
      '{"type":"tool_call","tool":"get_bridge_context","args":{"target":"godot","command":["execute_command","x"]"}}',
    );
    expect(action.tool).toBe("get_bridge_context");
    expect(action.args.target).toBe("godot");
  });
});
