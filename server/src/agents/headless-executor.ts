import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import type { HeadlessProgram } from "../db/headless-programs.repo.js";
import type { Config } from "../config.js";
import { newId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface HeadlessCommand {
  language: string;
  script: string;
  description?: string;
}

export interface HeadlessResult {
  success: boolean;
  executed: number;
  failed: number;
  skipped: number;
  errors: string[];
  stdout?: string;
  program?: string;
  headless?: boolean;
}

export async function executeHeadless(
  program: HeadlessProgram,
  commands: HeadlessCommand[],
  config: Config,
  options?: { timeoutMs?: number; projectPath?: string },
): Promise<HeadlessResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const projectPath = options?.projectPath ?? process.cwd();

  const rawScript = commands.map((c) => c.script).join("\n\n");
  const combinedScript = normalizeHeadlessScript(program.language, rawScript);

  // Determine if we need a temp file
  const templateStr = JSON.stringify(program.argsTemplate);
  const needsTempFile = templateStr.includes("{{SCRIPT_FILE}}");

  let tempFilePath: string | null = null;

  try {
    if (needsTempFile) {
      // Create temp dir if needed
      const tempDir = isAbsolute(config.headlessTempDir)
        ? config.headlessTempDir
        : resolve(process.cwd(), config.headlessTempDir);
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      // Write temp script file
      const ext = program.language === "gdscript" ? ".gd" : ".py";
      tempFilePath = join(tempDir, `headless_${newId()}${ext}`);
      writeFileSync(tempFilePath, combinedScript, "utf-8");
    }

    // Build final args by substituting placeholders
    const args = program.argsTemplate.map((arg) => {
      let result = arg;
      result = result.replace(/\{\{SCRIPT\}\}/g, combinedScript);
      if (tempFilePath) {
        result = result.replace(/\{\{SCRIPT_FILE\}\}/g, tempFilePath);
      }
      result = result.replace(/\{\{PROJECT_PATH\}\}/g, projectPath);
      return result;
    });

    logger.info(
      "headless",
      `Executing ${program.program} headless: ${program.executable} ${args.map((a) => a.length > 60 ? a.slice(0, 60) + "..." : a).join(" ")}`,
    );

    // Spawn process
    const proc = Bun.spawn([program.executable, ...args], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    // Set up timeout (clearable)
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        reject(new Error(`Headless execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Read stdout and stderr
    const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
      if (!stream) return "";
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let result = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          result += decoder.decode(value, { stream: true });
        }
      } catch {}
      return result;
    };

    // Race between execution and timeout
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]),
      timeoutPromise,
    ]) as [string, string, number];

    clearTimeout(timeoutTimer);

    if (exitCode === 0) {
      logger.info("headless", `${program.program} headless execution succeeded`);
      return {
        success: true,
        executed: commands.length,
        failed: 0,
        skipped: 0,
        errors: [],
        stdout: stdout.trim() || undefined,
        program: program.program,
        headless: true,
      };
    } else {
      const errorMsg = stderr.trim() || `Process exited with code ${exitCode}`;
      logger.warn("headless", `${program.program} headless execution failed: ${errorMsg}`);
      return {
        success: false,
        executed: 0,
        failed: commands.length,
        skipped: 0,
        errors: [errorMsg],
        stdout: stdout.trim() || undefined,
        program: program.program,
        headless: true,
      };
    }
  } catch (err: any) {
    logger.error("headless", `${program.program} headless execution error: ${err.message}`);
    return {
      success: false,
      executed: 0,
      failed: commands.length,
      skipped: 0,
      errors: [err.message],
      program: program.program,
      headless: true,
    };
  } finally {
    // Clean up temp file
    if (tempFilePath) {
      try {
        unlinkSync(tempFilePath);
      } catch {}
    }
  }
}

function normalizeHeadlessScript(language: string, script: string): string {
  if (String(language).toLowerCase() !== "gdscript") return script;
  const trimmed = script.trim();
  if (!trimmed) return script;

  // If caller already supplied a full script, keep it untouched.
  if (
    /(^|\n)\s*extends\s+/i.test(trimmed)
    || /(^|\n)\s*class_name\s+/i.test(trimmed)
    || /(^|\n)\s*func\s+_init\s*\(/i.test(trimmed)
  ) {
    return script;
  }

  // For bare snippets, wrap into a minimal SceneTree script so `--script` can execute it.
  const indented = script
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `extends SceneTree\n\nfunc _init():\n${indented}\n    quit()\n`;
}
