const colorMap: Record<string, string> = {
  blender: "#ea7600",
  godot: "#478cbf",
  houdini: "#ff4713",
  unity: "#222",
  unreal: "#0d47a1",
  comfyui: "#8e24aa",
  global: "#006d77",
};

export function programColor(program: string): string {
  return colorMap[program.toLowerCase()] ?? "var(--text-muted)";
}
