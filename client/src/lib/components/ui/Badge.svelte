<script lang="ts">
  let { text, variant = "default" }: { text: string; variant?: string } = $props();
</script>

<span class="badge {variant}">{text}</span>

<style>
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .queued { background: var(--status-queued); color: #1e1e1e; }
  .paused { background: #6b6b6b; color: white; }
  .running { background: var(--status-running); color: white; }
  .completed { background: var(--status-completed); color: #1e1e1e; }
  .failed { background: var(--status-failed); color: white; }
  .cancelled { background: var(--status-cancelled); color: white; }
  .critical { background: var(--priority-critical); color: white; }
  .high { background: var(--priority-high); color: #1e1e1e; }
  .normal { background: var(--bg-active); color: var(--text-primary); }
  .low { background: var(--bg-elevated); color: var(--text-muted); }
  .default { background: var(--bg-active); color: var(--text-primary); }
  .command { background: #3d3552; color: #b8a9c9; }
  .repo { background: #2f4038; color: #a9c9b8; }
  .sync { background: #40382f; color: #c9b8a9; }
  .godot { background: #478cbf22; color: #478cbf; }
  .blender { background: #ea722022; color: #ea7220; }
  .houdini { background: #ff450022; color: #ff4500; }
  .comfyui { background: #16a34a22; color: #16a34a; }
  .unity { background: #cbd5e122; color: #cbd5e1; }
  .unreal { background: #a78bfa22; color: #a78bfa; }
  .fusion { background: #e8b83222; color: #e8b832; }
  .blocked { background: #5c4a1e; color: #e8c23a; }
  .task { background: #a855f722; color: #c4a5ff; }
  .accent { background: rgba(78, 201, 176, 0.15); color: var(--accent, #4ec9b0); }
  .info { background: #3b82f622; color: #60a5fa; }
</style>
