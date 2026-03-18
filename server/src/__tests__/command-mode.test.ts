import { describe, expect, test } from "bun:test";
import { parseCommandOutput, resolveExpectedCommandLanguage } from "../workspace/command-mode.js";
import {
  preferHeadlessBridgeExecution,
  shouldCompleteCommandModeFromBridgeExecution,
} from "../agents/spawner.js";

describe("command-mode parsing", () => {
  test("prefers the expected bridge language and drops echoed helper examples", () => {
    const stdout = [
      "```bash",
      "am exec <program> --lang <language> --script '<code>'",
      "```",
      "```powershell",
      "Invoke-RestMethod -Method Post -Uri \"$env:ARKESTRATOR_URL/api/bridge-command\" -Headers $headers -Body $body",
      "```",
      "```python",
      "import bpy",
      "bpy.ops.mesh.primitive_torus_add()",
      "```",
    ].join("\n");

    expect(parseCommandOutput(stdout, { expectedLanguage: "python" })).toEqual([
      {
        language: "python",
        script: "import bpy\nbpy.ops.mesh.primitive_torus_add()",
      },
    ]);
  });

  test("returns no commands when output only contains prompt templates/helpers", () => {
    const stdout = [
      "```python",
      "# your code here",
      "```",
      "```bash",
      "curl -s -X POST \"$ARKESTRATOR_URL/api/bridge-command\" -d '{\"target\":\"<program>\"}'",
      "```",
    ].join("\n");

    expect(parseCommandOutput(stdout, { expectedLanguage: "python" })).toEqual([]);
  });

  test("keeps multiple executable blocks when no expected language is known", () => {
    const stdout = [
      "```python",
      "print('blender')",
      "```",
      "```gdscript",
      "print('godot')",
      "```",
    ].join("\n");

    expect(parseCommandOutput(stdout)).toEqual([
      { language: "python", script: "print('blender')" },
      { language: "gdscript", script: "print('godot')" },
    ]);
  });

  test("derives the executable language from bridge metadata", () => {
    expect(resolveExpectedCommandLanguage({ bridge_type: "blender" }, undefined)).toBe("python");
    expect(resolveExpectedCommandLanguage({ target_bridges: ["godot"] }, undefined)).toBe("gdscript");
    expect(resolveExpectedCommandLanguage(undefined, "unity")).toBe("unity_json");
  });

  test("treats command-mode runs with successful bridge execution as complete without fenced output", () => {
    expect(shouldCompleteCommandModeFromBridgeExecution({ usedBridges: ["blender"] } as any)).toBe(true);
    expect(shouldCompleteCommandModeFromBridgeExecution({ usedBridges: [] } as any)).toBe(false);
    expect(shouldCompleteCommandModeFromBridgeExecution(null)).toBe(false);
  });

  test("detects jobs that require headless bridge execution", () => {
    expect(preferHeadlessBridgeExecution({ runtimeOptions: { bridgeExecutionMode: "headless" } } as any)).toBe(true);
    expect(preferHeadlessBridgeExecution({ runtimeOptions: { bridgeExecutionMode: "live" } } as any)).toBe(false);
    expect(preferHeadlessBridgeExecution(null)).toBe(false);
  });
});
