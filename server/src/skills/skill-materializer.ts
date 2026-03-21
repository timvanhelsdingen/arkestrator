/**
 * Skill Materializer — converts existing data sources into Skill[] for indexing.
 *
 * Reads from:
 * - Coordinator scripts on disk (*.md files)
 * - Custom skills from the DB (via SkillsRepo)
 * - Playbook task manifests (via collectPlaybooks)
 * - Training repository records (via loadTrainingRepositoryIndex)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import type { Skill } from "../db/skills.repo.js";
import type { SkillsRepo } from "../db/skills.repo.js";
import type { CoordinatorPlaybookManifest } from "../agents/coordinator-playbooks.js";
import {
  loadTrainingRepositoryIndex,
  type TrainingRepositoryIndex,
} from "../agents/training-repository.js";

/** Configuration for the materializer. */
export interface SkillMaterializerConfig {
  /** Path to coordinator scripts directory (e.g. data/coordinator-scripts). */
  coordinatorScriptsDir: string;
  /** Path to coordinator playbooks directory (e.g. data/coordinator-playbooks). */
  coordinatorPlaybooksDir: string;
  /** Optional playbook source paths. */
  coordinatorPlaybookSourcePaths?: string[];
  /** Custom skills repo instance. */
  skillsRepo: SkillsRepo;
}

/**
 * Materialize all skills from disk and DB into a flat Skill[].
 * Runs synchronously — intended for startup and periodic refresh.
 */
export function materializeSkills(config: SkillMaterializerConfig): Skill[] {
  const skills: Skill[] = [];
  const now = new Date().toISOString();

  // Discover programs from coordinator scripts directory
  const knownPrograms = discoverPrograms(config.coordinatorScriptsDir, config.coordinatorPlaybooksDir);

  // 1. Coordinator scripts from disk
  skills.push(...materializeCoordinatorScripts(config.coordinatorScriptsDir, now));

  // 2. Custom skills from DB
  skills.push(...config.skillsRepo.list());

  // 3. Playbook tasks from manifests
  skills.push(...materializePlaybooks(config.coordinatorPlaybooksDir, knownPrograms, config.coordinatorPlaybookSourcePaths ?? [], now));

  // 4. Training records
  skills.push(...materializeTrainingRecords(config.coordinatorPlaybooksDir, knownPrograms, now));

  // 5. Built-in bridge skills (always available, supplement coordinator scripts)
  skills.push(...materializeBuiltinBridgeSkills(now));

  return skills;
}

/** Discover program names from coordinator scripts and playbooks directories. */
function discoverPrograms(scriptsDir: string, playbooksDir: string): string[] {
  const programs = new Set<string>();
  // From coordinator scripts (*.md files, excluding global)
  try {
    for (const f of readdirSync(scriptsDir)) {
      if (f.startsWith(".") || !f.endsWith(".md") || f === "global.md") continue;
      programs.add(basename(f, ".md").toLowerCase());
    }
  } catch {}
  // From playbook subdirectories (excluding _learning, global)
  try {
    for (const d of readdirSync(playbooksDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_") || d.name === "global") continue;
      programs.add(d.name.toLowerCase());
    }
  } catch {}
  return [...programs].sort();
}

/**
 * Read *.md files from the coordinator scripts directory.
 * global.md -> category 'coordinator', others -> category 'bridge'.
 * Skips hidden/hash files.
 */
function materializeCoordinatorScripts(dir: string, now: string): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip hidden files and hash files
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    const name = basename(entry, extname(entry));

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const isGlobal = name === "global";
    const category = isGlobal ? "coordinator" : "bridge";
    const program = isGlobal ? "global" : name;
    const slug = `${program}-${category}`;

    // Extract title from first heading or use filename
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : `${name} coordinator script`;

    // Extract keywords from content (simple: first few meaningful words)
    const keywords = extractKeywords(content);

    skills.push({
      id: `script:${slug}`,
      name,
      slug,
      program,
      category,
      title,
      description: isGlobal
        ? "Global coordinator instructions for all programs"
        : `Coordinator instructions for ${name}`,
      keywords,
      content,
      source: "coordinator-script",
      sourcePath: filePath,
      priority: isGlobal ? 90 : 70,
      autoFetch: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return skills;
}

/**
 * Read playbook manifests from the playbooks directory.
 * Each task in a playbook becomes a separate skill.
 */
function materializePlaybooks(
  playbooksDir: string,
  programs: string[],
  playbookSourcePaths: string[],
  now: string,
): Skill[] {
  if (!existsSync(playbooksDir)) return [];

  const skills: Skill[] = [];

  for (const program of programs) {
    const manifestPath = join(playbooksDir, program, "playbook.json");
    const manifest = loadPlaybookManifest(manifestPath);
    if (!manifest) continue;

    for (const task of manifest.tasks) {
      const slug = `playbook-${program}-${task.id}`;
      skills.push({
        id: `playbook:${slug}`,
        name: task.id,
        slug,
        program,
        category: "playbook",
        title: task.title,
        description: task.description ?? "",
        keywords: task.keywords ?? [],
        content: task.instruction,
        source: "playbook",
        sourcePath: manifestPath,
        priority: 50,
        autoFetch: false,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Also check external playbook source paths
  for (const sourcePath of playbookSourcePaths) {
    if (!sourcePath.trim() || !existsSync(sourcePath.trim())) continue;

    for (const program of programs) {
      const candidates = [
        join(sourcePath.trim(), program, "playbook.json"),
        join(sourcePath.trim(), `${program}.playbook.json`),
        join(sourcePath.trim(), `${program}.json`),
      ];

      for (const candidate of candidates) {
        const manifest = loadPlaybookManifest(candidate);
        if (!manifest) continue;

        for (const task of manifest.tasks) {
          const slug = `playbook-${program}-${task.id}`;
          // Skip if already added (primary takes precedence)
          if (skills.some((s) => s.slug === slug && s.program === program)) continue;

          skills.push({
            id: `playbook:${slug}`,
            name: task.id,
            slug,
            program,
            category: "playbook",
            title: task.title,
            description: task.description ?? "",
            keywords: task.keywords ?? [],
            content: task.instruction,
            source: "playbook",
            sourcePath: candidate,
            priority: 45,
            autoFetch: false,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }

  return skills;
}

/**
 * Read training repository indexes for known programs.
 * Each training record becomes a skill.
 */
function materializeTrainingRecords(
  playbooksDir: string,
  programs: string[],
  now: string,
): Skill[] {
  const skills: Skill[] = [];

  for (const program of programs) {
    let index: TrainingRepositoryIndex;
    try {
      index = loadTrainingRepositoryIndex({ dir: playbooksDir, program });
    } catch {
      continue;
    }

    if (!index || index.records.length === 0) continue;

    for (const record of index.records) {
      if (record.quarantined) continue;

      const slug = `training-${record.id}`;
      const content = [
        record.summary,
        record.prompt ? `\nPrompt: ${record.prompt}` : "",
        record.outcome ? `\nOutcome: ${record.outcome}` : "",
      ].join("");

      skills.push({
        id: `training:${record.id}`,
        name: record.id,
        slug,
        program: record.program || program,
        category: "training",
        title: record.title,
        description: record.summary,
        keywords: record.keywords ?? [],
        content,
        source: "training",
        sourcePath: record.sourcePath,
        priority: qualityToPriority(record.qualityRating),
        autoFetch: false,
        enabled: true,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      });
    }
  }

  return skills;
}

/** Load and validate a playbook manifest from a JSON file path. */
function loadPlaybookManifest(path: string): CoordinatorPlaybookManifest | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CoordinatorPlaybookManifest;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Convert training quality rating to a priority number. */
function qualityToPriority(rating: string): number {
  if (rating === "good") return 60;
  if (rating === "average") return 40;
  return 25;
}

/** Built-in bridge skills that are always available. These provide common
 *  patterns and capabilities that supplement the coordinator scripts. */
function materializeBuiltinBridgeSkills(now: string): Skill[] {
  const builtins: Array<{ slug: string; program: string; title: string; description: string; keywords: string[]; content: string }> = [
    {
      slug: "blender-python-patterns",
      program: "blender",
      title: "Blender Python Scripting Patterns",
      description: "Common bpy scripting patterns for scene manipulation, mesh creation, materials, rendering, and file I/O.",
      keywords: ["blender", "bpy", "python", "mesh", "material", "render", "scene", "object", "node", "shader", "geometry", "export"],
      content: [
        "# Blender Python Scripting Patterns",
        "",
        "## Scene Management",
        "- Use `bpy.context.scene` for the active scene",
        "- Use `bpy.data.objects` to access all objects",
        "- Always call `bpy.context.view_layer.update()` after transformations",
        "",
        "## Mesh Creation",
        "- Use `bpy.ops.mesh.primitive_*_add()` for basic shapes",
        "- For custom meshes: create mesh data, add vertices/faces, link to object",
        "- Use bmesh for complex procedural geometry",
        "",
        "## Materials & Shaders",
        "- Create materials with `bpy.data.materials.new()`",
        "- Use `material.use_nodes = True` for node-based shaders",
        "- Access node tree via `material.node_tree.nodes`",
        "",
        "## Rendering",
        "- Set render engine: `bpy.context.scene.render.engine = 'CYCLES'` or `'BLENDER_EEVEE_NEXT'`",
        "- Set output: `bpy.context.scene.render.filepath`",
        "- Render: `bpy.ops.render.render(write_still=True)`",
        "",
        "## Verification",
        "- After creating objects, verify they exist in `bpy.data.objects`",
        "- After rendering, check output file exists and has non-zero size",
        "- Use `bpy.ops.wm.save_mainfile()` to save the .blend file",
      ].join("\n"),
    },
    {
      slug: "godot-gdscript-patterns",
      program: "godot",
      title: "Godot GDScript Patterns",
      description: "Common GDScript patterns for scene management, node creation, physics, UI, and project structure.",
      keywords: ["godot", "gdscript", "scene", "node", "physics", "rigidbody", "collision", "signal", "export", "resource"],
      content: [
        "# Godot GDScript Patterns",
        "",
        "## Scene Structure",
        "- Root node types: Node2D (2D), Node3D (3D), Control (UI)",
        "- Use `.tscn` for scenes, `.tres` for resources, `.gd` for scripts",
        "- Organize: scenes/, scripts/, assets/, resources/ directories",
        "",
        "## Node Management",
        "- `get_tree().root` for scene tree root",
        "- `add_child()`, `remove_child()`, `queue_free()` for lifecycle",
        "- `@onready` for node references, `@export` for inspector properties",
        "",
        "## Physics",
        "- RigidBody3D for dynamic physics objects",
        "- StaticBody3D + CollisionShape3D for static collision",
        "- CharacterBody3D + `move_and_slide()` for controllable characters",
        "- Always add CollisionShape3D children to physics bodies",
        "",
        "## Signals",
        "- `signal my_signal(arg)` to declare, `.emit()` to fire",
        "- `node.connect('signal_name', callable)` to listen",
        "",
        "## Verification",
        "- Test with `godot --headless --path <project> --script <test_script>`",
        "- Check scene tree structure, node counts, and collision layers",
      ].join("\n"),
    },
    {
      slug: "houdini-python-patterns",
      program: "houdini",
      title: "Houdini Python/VEX Patterns",
      description: "Common patterns for Houdini node graphs, geometry manipulation, simulations, and rendering via hython.",
      keywords: ["houdini", "hython", "vex", "sop", "geometry", "simulation", "render", "node", "parameter", "cache"],
      content: [
        "# Houdini Python/VEX Patterns",
        "",
        "## Node Graph",
        "- `hou.node('/obj')` for object context",
        "- `node.createNode('type')` to add nodes",
        "- `node.parm('name').set(value)` to set parameters",
        "- Always set display/render flags: `node.setDisplayFlag(True)`",
        "",
        "## Geometry",
        "- SOPs for surface operations: box, sphere, transform, merge",
        "- Use VEX wrangles (`attribwrangle`) for attribute manipulation",
        "- `hou.Geometry()` for procedural geometry in Python",
        "",
        "## Simulations",
        "- DOPs for dynamics: RBD, FLIP, Pyro, Vellum",
        "- Always cache simulations to disk (File Cache SOP or .bgeo sequences)",
        "- Set frame range before running simulation",
        "",
        "## Rendering",
        "- Use Karma or Mantra ROPs for rendering",
        "- Set output path in ROP node parameters",
        "- `hou.hipFile.save()` to save the .hip file",
        "",
        "## Verification",
        "- Check node errors: `node.errors()`, `node.warnings()`",
        "- Verify geometry: `node.geometry().points()`, `.prims()`",
        "- Verify cache files exist after simulation",
      ].join("\n"),
    },
    {
      slug: "comfyui-workflow-patterns",
      program: "comfyui",
      title: "ComfyUI Workflow Patterns",
      description: "Common patterns for building and executing ComfyUI image generation workflows.",
      keywords: ["comfyui", "workflow", "image", "generation", "diffusion", "checkpoint", "sampler", "lora", "controlnet", "prompt"],
      content: [
        "# ComfyUI Workflow Patterns",
        "",
        "## Workflow Structure",
        "- Workflows are JSON node graphs with numbered node IDs",
        "- Each node has: class_type, inputs (connected or literal values)",
        "- Output nodes (SaveImage, PreviewImage) trigger execution",
        "",
        "## Common Nodes",
        "- CheckpointLoaderSimple: loads .safetensors model files",
        "- CLIPTextEncode: converts text prompts to conditioning",
        "- KSampler: core sampling node (model, positive, negative, latent)",
        "- VAEDecode: converts latents to pixel images",
        "- SaveImage: saves output to ComfyUI output directory",
        "",
        "## Best Practices",
        "- Use queue_prompt API to submit workflows",
        "- Poll history API for completion status",
        "- Verify output images exist and have expected dimensions",
        "- Use seed values for reproducibility",
      ].join("\n"),
    },
  ];

  return builtins.map((b) => ({
    id: `builtin:${b.slug}`,
    name: b.slug,
    slug: b.slug,
    program: b.program,
    category: "bridge" as const,
    title: b.title,
    description: b.description,
    keywords: b.keywords,
    content: b.content,
    source: "builtin",
    sourcePath: null,
    priority: 40,
    autoFetch: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
}

/** Extract simple keywords from content text. */
function extractKeywords(content: string): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]+/g, " ")
    .split(/[\s/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  // Deduplicate and take top keywords
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 30) break;
  }
  return out;
}
