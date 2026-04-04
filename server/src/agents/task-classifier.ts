/**
 * Classifies job prompts into coarse task patterns for routing outcome tracking.
 * Patterns are intentionally broad (10-20 total) to accumulate useful sample sizes.
 */

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  rendering: ["render", "exr", "multilayer", "cycles", "eevee", "karma", "mantra", "husk", "flipbook", "preview"],
  compositing: ["composite", "comp", "grade", "shuffle", "merge", "keying", "roto", "aov", "beauty rebuild"],
  modeling: ["mesh", "geometry", "sculpt", "modifier", "topology", "retopo", "uv", "unwrap", "vertex", "edge", "face", "poly"],
  materials: ["material", "shader", "texture", "pbr", "bsdf", "roughness", "metallic", "sss", "subsurface", "ior"],
  lighting: ["light", "lighting", "hdri", "environment", "lamp", "sun", "spot", "area light"],
  animation: ["animation", "keyframe", "timeline", "armature", "rig", "bone", "pose", "motion", "animate"],
  simulation: ["simulation", "particle", "fluid", "cloth", "softbody", "rigid body", "pyro", "flip", "vellum", "dop"],
  scripting: ["script", "gdscript", "code", "function", "class", "node", "signal", "export", "autoload"],
  scene: ["scene", "level", "prefab", "gameobject", "blueprint", "actor", "component"],
  generation: ["workflow", "generate", "checkpoint", "lora", "controlnet", "sampler", "denoise", "prompt", "comfyui"],
  export: ["export", "glb", "gltf", "fbx", "obj", "alembic", "abc", "usd"],
};

/**
 * Classify a job prompt into a coarse task pattern like "blender:rendering".
 * Used to group routing outcomes so the system can learn which agent configs
 * work best for which task types.
 */
export function classifyTaskPattern(
  prompt: string,
  bridgeProgram?: string,
): string {
  const text = prompt.toLowerCase();
  const program = (bridgeProgram ?? "").trim().toLowerCase() || "general";

  // Score each category by keyword matches
  let bestCategory = "general";
  let bestScore = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  // Check for multi-bridge orchestration
  const bridgePrograms = ["blender", "nuke", "houdini", "godot", "comfyui", "unreal", "unity", "fusion"];
  const mentionedBridges = bridgePrograms.filter((b) => text.includes(b));
  if (mentionedBridges.length >= 2) {
    return "global:orchestration";
  }

  return `${program}:${bestCategory}`;
}

/**
 * Extract the complexity score from a prompt (reused from auto-routing logic).
 * Exported so routing outcomes can store it alongside the task pattern.
 */
export function promptComplexityScore(prompt: string): number {
  const text = prompt.toLowerCase();
  let score = 0;
  if (prompt.length > 900) score += 2;
  if ((prompt.match(/\n/g)?.length ?? 0) > 8) score += 1;
  const keywords = [
    "architecture", "refactor", "multi-file", "migration", "performance",
    "optimize", "root cause", "security", "concurrency", "database",
    "integration", "test plan",
  ];
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}
