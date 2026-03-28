# Coordinator

## Overview

The coordinator is the intelligence layer between raw user prompts and agent execution. It shapes how AI agents behave by injecting orchestration rules, task-specific playbooks, project references, and learned patterns into the agent's system prompt at job spawn time.

The coordinator operates at three levels:

1. **Coordinator Scripts** — Global and per-program instruction sets that define base agent behavior (transport rules, workspace management, verification policy).
2. **Playbooks** — Per-program task libraries that match against job prompts to inject relevant task instructions and reference material.
3. **Training Pipeline** — An automated system that analyzes source material (project files, scenes, workflows) and extracts reusable patterns into skills.

All three levels feed into the [skills system](skills.md), which is the unified storage and retrieval layer for coordinator knowledge.

## Coordinator Scripts

Coordinator scripts are markdown documents that form the base system prompt for every agent. They are the highest-priority skills in the system.

### Global Coordinator

The global coordinator script (`global-coordinator` skill, priority 90) is injected into every job. It defines:

- **Transport Gate** — Agents must probe MCP tool availability before execution. Fallback priority: MCP tools, then `am` CLI, then REST API.
- **Project Reference Priority** — Agents check playbook tasks, project docs, existing conventions, then official docs, in that order.
- **File & Workspace Rules** — Save location priority (active project > default project dir > ask user), temp file organization under `_arkestrator/{JOB_ID}/`.
- **Mandatory Start Gate** — Plan before executing. Classify steps, define success criteria, state scope boundaries.
- **Live Guidance Gate** — Check for operator interventions at safe checkpoints.
- **Execution Policy** — When to use direct `execute_command` vs `create_job` sub-jobs, resource contention rules for GPU/VRAM-heavy tasks.
- **Verification Policy** — Run deterministic checks before reporting completion. Fix and retry up to 3 attempts.
- **Cross-Machine Delivery** — Rules for transferring artifacts between workers on different machines.
- **Sub-Job Handover** — Required `handover_notes` structure for child jobs.

### Per-Program Scripts

Each bridge program (Blender, Houdini, Godot, ComfyUI, Unity, Unreal) gets its own coordinator script. These are pulled from the [arkestrator-bridges repo](https://github.com/timvanhelsdingen/arkestrator-bridges) when a bridge first connects.

Per-program scripts have priority 70 and category `bridge`. They contain program-specific execution patterns, API conventions, and common pitfalls. For example, a Houdini coordinator might specify how to traverse node trees, while a Blender coordinator covers Python API patterns.

### Script Composition

At job spawn time, the spawner collects all auto-fetch skills for the job's program:

1. Global coordinator (program `global`, category `coordinator`)
2. Bridge coordinator (matching program, category `bridge`)
3. Verification skills (if verification mode is active)
4. Custom auto-fetch skills

These are concatenated under a `## Coordinator Knowledge` heading in the system prompt, sorted by priority descending.

### Script Management

Scripts are stored as skills in the DB. The admin panel provides:

- View/edit script content with live preview
- Reset to built-in default (`getCoordinatorScriptDefault()`)
- Track which programs have scripts (built-in + disk files + DB history + live bridges + headless configs)

On server startup, `seedCoordinatorScripts()` upserts the built-in global coordinator to the skills DB. The global script is also written to disk at `{COORDINATOR_SCRIPTS_DIR}/global.md` for backward compatibility, using a hash sidecar to detect user edits.

## Playbooks

Playbooks are per-program task libraries that provide targeted instructions for specific job types. Unlike coordinator scripts (always injected), playbooks are matched against the job prompt using semantic ranking.

### Structure

Each program's playbook lives in a directory under the playbooks root:

```
{COORDINATOR_PLAYBOOKS_DIR}/
  global/
    playbook.json        # Manifest
    tasks/
      cross_bridge_workflow.md
      execution_gate_enforcement.md
  blender/
    playbook.json
    tasks/
      scene_build_render.md
  houdini/
    playbook.json
    tasks/
      general_houdini_workflow.md
  ...
```

The `playbook.json` manifest defines tasks:

```json
{
  "version": 1,
  "program": "houdini",
  "description": "Task-focused guidance for Houdini bridge jobs.",
  "referencePaths": [],
  "tasks": [
    {
      "id": "general_houdini_workflow",
      "title": "General Houdini Workflow",
      "description": "Project-specific scripts first, then deterministic verification.",
      "instruction": "tasks/general_houdini_workflow.md",
      "keywords": [],
      "regex": [],
      "examples": []
    }
  ]
}
```

### Semantic Matching

When a job spawns, `loadCoordinatorPlaybookContextDetailed()` collects playbook tasks from the job's program and global playbooks, then ranks them against the job prompt using TF-IDF tokenization with stop-word filtering. The top tasks (default 2) are injected under a `## Task Playbooks (Auto-Selected)` section.

Each matched task includes:
- The instruction file content (capped at 8,000 chars)
- Example file excerpts from referenced paths (up to 4 per task, 1,200 chars each)
- Reference paths resolved from the manifest and configured source paths

### Project Guidance

Beyond playbook tasks, the context loader also ranks project documentation from configured source paths. Server-side and client-side source paths are searched for text files (`.md`, `.txt`, `.py`, `.gd`, `.json`, `.yaml`, etc.) and ranked against the prompt. The top matches (default 3) are injected as project guidance alongside the playbook tasks.

### Learning State

Playbook matching incorporates a learning state file that tracks success/failure counts per task. Tasks with higher success rates get a ranking boost, while consistently failing tasks are deprioritized. The learning state updates when job outcomes are recorded via `recordCoordinatorContextOutcome()`.

### Built-in Playbooks

The server ships with default playbooks for: `global`, `blender`, `godot`, `houdini`, `unity`, `unreal`, `comfyui`. These provide baseline task guidance that users can extend with project-specific tasks and references.

## Training Pipeline

The training pipeline analyzes source material and extracts patterns into skills. It can run manually (triggered from the admin panel) or on a configurable schedule.

### Training Flow

```
1. Trigger (manual or scheduled)
       |
       v
2. Resolve source paths
   - Configured playbook source paths
   - Default source paths from settings
   - Learning vault artifacts
       |
       v
3. Discover projects
   - Walk source dirs for project config files
   - Read existing project configs / notes
   - Collect learning vault summaries
       |
       v
4. Spawn analysis agent
   - Build analysis prompt with discovered projects
   - Agent inspects files via bridge or filesystem
   - Agent outputs structured JSON + markdown
       |
       v
5. Extract patterns
   - Parse agent output for training seeds
   - Extract project name, summary, keywords
   - Build skill content from analysis
       |
       v
6. Create/update skills
   - Upsert skills with source "training"
   - Update coordinator script training block
   - Update playbook manifest if applicable
       |
       v
7. Record completion
   - Store training artifact in learning vault
   - Update last-run timestamp per program
   - Auto-archive the training job
```

### Training Levels

Training intensity is configurable per run:

| Level    | Discovery Depth | Max Projects | Summary Limit | Timeout Multiplier | Approach                         |
|----------|-----------------|--------------|---------------|--------------------|---------------------------------|
| `low`    | 2               | 100          | 120 chars     | 0.5x               | Filesystem-only, quick scan     |
| `medium` | 3               | 300          | 220 chars     | 1x                 | Auto-detect (bridge/headless/fs)|
| `high`   | 5               | 600          | 400 chars     | 2x                 | Exhaustive deep analysis        |

Low-level training forces filesystem-only analysis and skips bridge/headless tools. High-level training inspects every node parameter, shader value, and render setting for maximum detail.

### Analysis Modes

The training agent adapts its approach based on available infrastructure:

- **Bridge mode** — A live DCC bridge is connected. The agent uses bridge tools to inspect scene internals (node trees, parameters, materials).
- **Headless mode** — No live bridge, but a headless CLI is configured. The agent runs program-specific commands for inspection.
- **Filesystem mode** — No bridge or headless available. The agent reads files and folder structure directly from disk.

### Agentic Analysis

For deeper analysis, training spawns a child agent job with a structured prompt. The child agent:

1. Receives the list of source paths and training objectives
2. Inspects project files using available tools (bridge, headless, or filesystem)
3. Outputs structured JSON with project metadata, patterns, and contexts
4. The parent training job parses the output and creates skills from the extracted data

The analysis agent is configurable via the `coordinator_analyze_agent_config_id` setting. Timeout defaults to 45 minutes with level-based multipliers.

## Training Repository

The training repository is a searchable index over the learning vault — the collection of training artifacts, job outcomes, and extracted patterns stored on disk.

### Source Paths

Source paths tell the training system where to find analyzable material. They are configured per-program through the admin panel:

- **Playbook source paths** — Directories containing project files, examples, and reference scenes
- **Import directories** — Additional reference material paths
- **Reference paths** — Read-only reference directories for playbook task matching
- **Client source paths** — Paths pushed from the desktop client for local project discovery

### Index and Search

The training repository maintains an in-memory search index with TF-IDF tokenization and 48-dimensional semantic vectors. Records are refreshable on a configurable schedule. The index supports:

- Full-text search over vault contents
- Semantic similarity matching
- Program and signal filtering
- Override modes for record inclusion/exclusion

### Policy

The training repository policy controls automatic behavior:

```json
{
  "autoRefreshIntervalMinutes": 60,
  "maxRecords": 10000,
  "retentionDays": 365
}
```

## Training Schedule

Training runs can be scheduled to execute automatically:

```json
{
  "enabled": true,
  "intervalMinutes": 1440,
  "apply": true,
  "programs": ["houdini", "blender", "godot"]
}
```

| Field             | Type       | Default | Description                                    |
|-------------------|------------|---------|------------------------------------------------|
| `enabled`         | boolean    | true    | Whether scheduled training is active           |
| `intervalMinutes` | number     | 1440    | Minutes between runs (min 5, max 10080)        |
| `apply`           | boolean    | true    | Auto-apply results to coordinator scripts      |
| `programs`        | string[]   | all     | Which programs to train (subset of known ones)  |

The scheduler tracks last-run timestamps per program and computes the next eligible run time. When a scheduled run triggers, it queues a training job for each eligible program.

## Client-Side Coordination

The desktop client can push source paths and project context to the server for training:

- **Client source paths** — Local project directories that the client registers for training discovery
- **Editor context** — Real-time scene/project state from connected bridges, used to enrich job prompts
- **Attachments** — Files attached to jobs that provide additional context

The client also runs local LLM agentic loops for chat-based interaction, using the server's coordinator knowledge to shape responses.

## Configuration Reference

### Environment Variables

| Variable                          | Default                              | Description                          |
|-----------------------------------|--------------------------------------|--------------------------------------|
| `COORDINATOR_SCRIPTS_DIR`         | `~/.arkestrator/coordinator-scripts` | Directory for coordinator script files |
| `COORDINATOR_PLAYBOOKS_DIR`       | `~/.arkestrator/playbooks`           | Directory for playbook manifests and tasks |
| `COORDINATOR_IMPORTS_DIR`         | `~/.arkestrator/imports`             | Additional reference material paths  |
| `DEFAULT_PROJECT_DIR`             | `~/Documents/Arkestrator`            | Default save location for new projects |

### Settings Keys

| Key                                          | Type    | Default | Description                                      |
|----------------------------------------------|---------|---------|--------------------------------------------------|
| `auto_pull_bridge_skills`                    | string  | `"true"`| Auto-pull coordinator scripts from bridge repo   |
| `coordinator_analyze_agent_config_id`        | string  | (first) | Agent config ID for training analysis jobs       |
| `coordinator_training_schedule`              | JSON    | (above) | Training schedule configuration                  |
| `coordinator_training_last_run_by_program`   | JSON    | `{}`    | Last training run ISO timestamps per program     |
| `training_repository_policy`                 | JSON    | (above) | Training repository auto-refresh and retention   |
| `training_repository_overrides`              | JSON    | `{}`    | Per-record include/exclude overrides             |

### API Endpoints

Training and coordinator management endpoints:

| Method   | Endpoint                                    | Purpose                                |
|----------|---------------------------------------------|----------------------------------------|
| `GET`    | `/api/settings/coordinator/scripts`         | List coordinator scripts               |
| `GET`    | `/api/settings/coordinator/scripts/:program`| Get script for program                 |
| `PUT`    | `/api/settings/coordinator/scripts/:program`| Update script content                  |
| `DELETE` | `/api/settings/coordinator/scripts/:program`| Delete script (reset to default)       |
| `GET`    | `/api/settings/coordinator/programs`        | List known programs                    |
| `GET`    | `/api/settings/training/schedule`           | Get training schedule                  |
| `PUT`    | `/api/settings/training/schedule`           | Update training schedule               |
| `POST`   | `/api/settings/training/run`               | Trigger manual training run            |
| `GET`    | `/api/settings/training/repository`         | List training repository records       |
| `GET`    | `/api/settings/training/repository/metrics` | Get repository index stats             |
| `POST`   | `/api/settings/training/repository/refresh` | Force repository index refresh         |
