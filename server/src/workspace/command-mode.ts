import type { CommandResult } from "@arkestrator/protocol";

export interface ParseCommandOutputOptions {
  expectedLanguage?: string;
}

/** Map bridge type to scripting language */
function getLanguageForBridge(
  bridgeType: string,
  metadata?: Record<string, unknown>,
): string {
  const explicit = typeof metadata?.bridge_script_language === "string"
    ? metadata.bridge_script_language.trim().toLowerCase()
    : "";
  if (explicit) return explicit;

  const byProgram = metadata?.bridge_script_languages;
  if (byProgram && typeof byProgram === "object" && !Array.isArray(byProgram)) {
    const override = (byProgram as Record<string, unknown>)[bridgeType];
    if (typeof override === "string" && override.trim()) {
      return override.trim().toLowerCase();
    }
  }

  switch (bridgeType) {
    case "godot":
      return "gdscript";
    case "blender":
    case "houdini":
      return "python";
    case "unity":
      return "unity_json";
    default:
      return "python";
  }
}

/** Map bridge type to application name for the prompt */
function getAppName(
  bridgeType: string,
  metadata?: Record<string, unknown>,
): string {
  const explicit = typeof metadata?.bridge_display_name === "string"
    ? metadata.bridge_display_name.trim()
    : "";
  if (explicit) return explicit;

  const byProgram = metadata?.bridge_display_names;
  if (byProgram && typeof byProgram === "object" && !Array.isArray(byProgram)) {
    const override = (byProgram as Record<string, unknown>)[bridgeType];
    if (typeof override === "string" && override.trim()) {
      return override.trim();
    }
  }

  switch (bridgeType) {
    case "godot":
      return "Godot Engine";
    case "blender":
      return "Blender";
    case "houdini":
      return "Houdini";
    case "unity":
      return "Unity Editor";
    default:
      return bridgeType;
  }
}

/**
 * Build a system prompt addition for command mode.
 * Tells the agent to output executable scripts instead of editing files.
 */
export function buildCommandModePrompt(
  bridgeType: string,
  metadata?: Record<string, unknown>,
): string {
  const language = getLanguageForBridge(bridgeType, metadata);
  const appName = getAppName(bridgeType, metadata);

  if (bridgeType === "comfyui") {
    return `
You are generating ${language} code to be executed inside ${appName}.
Output your solution as a single executable ${language} script wrapped in a code fence:

\`\`\`${language}
# your code here
\`\`\`

The script will be executed directly in the ${appName} application by the bridge plugin.
The script has full access to the ${appName} scripting API.

For ComfyUI tasks, filesystem operations are allowed when required to complete the request:
- Saving generated outputs to requested destinations
- Reading/writing ComfyUI workflow/model metadata
- Downloading required weights and placing them in the correct ComfyUI model folders

Important machine-boundary rule:
- Filesystem paths are local to the ComfyUI worker machine.
- If the user asks for delivery to another machine's path, do not treat that path as local.
- Return transferable artifact data and delegate the final write/verification to a bridge running on the destination worker.

Do NOT use Bash/Write/Edit tools for this. Use only the generated ${language} script via bridge execution.
`.trim();
  }

  return `
You are generating ${language} code to be executed inside ${appName}.
DO NOT attempt to read, write, or edit any files on disk.
Instead, output your solution as a single executable ${language} script wrapped in a code fence:

\`\`\`${language}
# your code here
\`\`\`

The script will be executed directly in the ${appName} application by the bridge plugin.
The script has full access to the ${appName} scripting API.

Context about the current project state is provided in the user's prompt.
Base your code only on that context — do not assume access to the filesystem.
`.trim();
}

function isCommandHelperExample(language: string, script: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  const compact = script.replace(/\s+/g, " ").trim().toLowerCase();

  if (!compact) return true;
  if (compact === "# your code here") return true;
  if (compact.includes("am exec <program> --lang <language> --script")) return true;
  if (compact.includes("invoke-restmethod -method post -uri \"$env:arkestrator_url/api/bridge-command\"")) {
    return true;
  }
  if (compact.includes("curl -s -x post \"$arkestrator_url/api/bridge-command\"")) return true;
  if (compact.includes("curl -ss -x post \"$arkestrator_url/api/bridge-command\"")) return true;
  if (compact.includes("/api/bridge-command") && compact.includes("<program>")) return true;
  if (
    ["bash", "sh", "zsh", "shell", "powershell", "pwsh", "ps1"].includes(normalizedLanguage) &&
    (compact.includes("am exec ") || compact.includes("/api/bridge-command"))
  ) {
    return true;
  }

  return false;
}

/**
 * Parse agent stdout to extract command/script code blocks.
 * Looks for fenced code blocks with language tags.
 */
export function parseCommandOutput(
  stdout: string,
  options: ParseCommandOutputOptions = {},
): CommandResult[] {
  const results: CommandResult[] = [];
  const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(stdout)) !== null) {
    const language = match[1].toLowerCase();
    const script = match[2].trim();

    if (script.length > 0) {
      results.push({ language, script });
    }
  }

  const executable = results.filter((cmd) => !isCommandHelperExample(cmd.language, cmd.script));
  const expectedLanguage = options.expectedLanguage?.trim().toLowerCase();
  if (expectedLanguage) {
    const matching = executable.filter((cmd) => cmd.language === expectedLanguage);
    if (matching.length > 0) return matching;
  }

  return executable;
}

/**
 * Determine the bridge type from job metadata or editor context.
 * Falls back to bridgeProgram (from WS query params) if metadata doesn't identify it.
 */
export function detectBridgeType(
  metadata?: Record<string, unknown>,
  bridgeProgram?: string,
): string {
  if (metadata) {
    // Check for Godot-specific fields
    if (metadata.active_scene && metadata.selected_nodes) {
      return "godot";
    }

    // Check target_bridges array (canonical, set by client for single-program jobs)
    if (Array.isArray(metadata.target_bridges) && metadata.target_bridges.length === 1) {
      return metadata.target_bridges[0] as string;
    }

    // Check explicit bridge_type field (legacy / set by bridges)
    if (typeof metadata.bridge_type === "string") {
      return metadata.bridge_type;
    }
  }

  // Fallback to the program field from WS connection params
  if (bridgeProgram) {
    return bridgeProgram;
  }

  return "unknown";
}

export function resolveExpectedCommandLanguage(
  metadata?: Record<string, unknown>,
  bridgeProgram?: string,
): string | undefined {
  const bridgeType = detectBridgeType(metadata, bridgeProgram);
  if (!bridgeType || bridgeType === "unknown") return undefined;
  return getLanguageForBridge(bridgeType, metadata);
}
