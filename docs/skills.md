# Skills

## What Are Skills

Skills are learned patterns stored as reusable knowledge that the server injects into agent context at job time. Each skill is a markdown document with metadata — title, description, keywords, category, program affinity, priority — stored in SQLite and indexed in memory for fast retrieval.

A skill record looks like this:

| Field          | Type       | Purpose                                                |
|----------------|------------|--------------------------------------------------------|
| `id`           | UUID       | Primary key                                            |
| `slug`         | string     | URL-safe identifier, unique per (slug, program) pair   |
| `program`      | string     | Target bridge program or `"global"` for all            |
| `category`     | string     | Skill type (see categories below)                      |
| `title`        | string     | Human-readable name                                    |
| `description`  | string     | Short summary for search results                       |
| `keywords`     | string[]   | Additional search terms (stored as JSON)               |
| `content`      | string     | Full skill body (markdown instructions)                |
| `source`       | string     | Origin: `builtin`, `bridge-repo`, `coordinator`, `playbook`, `training`, `user` |
| `priority`     | number     | Injection order weight (higher = first)                |
| `autoFetch`    | boolean    | Always inject for matching program, regardless of score|
| `enabled`      | boolean    | Active/disabled toggle                                 |
| `version`      | number     | Incremented on content updates                         |

## How Skills Are Injected

When a job spawns, the spawner builds the agent's system prompt in two tiers:

### Tier 1: Auto-Fetch (always injected)

Skills marked `autoFetch: true` are unconditionally injected into every job that matches their program. These include:

- The **global coordinator script** (category `coordinator`, program `global`, priority 90)
- **Bridge-specific coordinator scripts** (category `bridge`, matching the job's program, priority 70)
- **Verification skills** when the job's verification mode is active
- Any custom skill explicitly marked as auto-fetch

Auto-fetch skills appear under a `## Coordinator Knowledge` section in the system prompt. Each skill gets a `### Title [program]` header followed by its content, capped at 4,000 characters per skill.

### Tier 2: On-Demand (MCP tool search)

All other enabled skills are available through MCP tools — `search_skills` and `get_skill`. The agent is given a mandatory instruction to search skills before starting bridge work:

> MANDATORY: Before starting bridge work, call search_skills with a query describing your task type to find relevant execution patterns, known pitfalls, and project-specific guidance.

This keeps the base system prompt lean while giving agents access to the full skill library on demand. Only MCP-loaded skills are tracked for effectiveness (auto-fetch skills are not, since their usage is forced and would pollute the signal).

### Ranking Algorithm

The `SkillIndex.rankForJob()` method scores each skill using a weighted combination:

| Component       | Weight | Description                                           |
|-----------------|--------|-------------------------------------------------------|
| Lexical score   | 50%    | Fraction of query tokens found in the skill's index   |
| Semantic score  | 30%    | Cosine similarity of 48-dimensional hash vectors      |
| Effectiveness   | 20%    | Success rate adjusted by usage confidence              |

The semantic vectors use a locality-sensitive hashing approach: tokens and 4-character n-grams are hashed into a fixed-size vector, then cosine similarity measures the overlap. This is fast (no external embedding model) and works well for DCC-specific terminology.

## Skill Categories

| Category             | Auto-Fetch | Purpose                                                    |
|----------------------|------------|------------------------------------------------------------|
| `coordinator`        | Yes        | Global orchestration rules (transport gates, workspace rules, verification policy) |
| `bridge`             | Yes        | Per-program bridge scripts (Blender, Houdini, Godot, etc.) |
| `training`           | No         | Patterns extracted from training pipeline analysis          |
| `playbook`           | No         | Task libraries with keyword-matched instructions            |
| `verification`       | Conditional| Quality checks injected when verification mode is active   |
| `project`            | No         | Project-specific knowledge from training discovery          |
| `project-reference`  | No         | Reference material from source paths and imports            |
| `housekeeping`       | No         | System maintenance patterns                                |
| `custom`             | Varies     | User-created skills with configurable auto-fetch            |

## Skill Sources

### Bridge Registry (`bridge-repo`)

When a bridge connects, the server pulls skills from the [arkestrator-bridges](https://github.com/timvanhelsdingen/arkestrator-bridges) GitHub repo. The flow:

1. `skill-registry.ts` fetches `registry.json` from the repo (cached 5 minutes).
2. For the connecting bridge's program, it fetches `{program}/coordinator.md` as the bridge coordinator skill.
3. Any additional skills listed in the registry's `skills[]` array are fetched and upserted.
4. All pulled skills get `source: "bridge-repo"`, `autoFetch: true`, priority 70.
5. User-edited skills (source `"user"`) are never overwritten by pulls.

Auto-pull is controlled by the `auto_pull_bridge_skills` setting (default: true). Skills are only fetched on first connect per program unless force-refreshed.

### Coordinator Scripts (`builtin`, `coordinator`)

At server startup, `seedCoordinatorScripts()` writes the built-in global coordinator prompt to the skills DB with `source: "builtin"`, priority 90. The global coordinator contains orchestration rules for transport probing, file workspace management, verification policy, sub-job handover, and cross-machine delivery.

Disk-based coordinator scripts (`.md` files in the scripts directory) are migrated to the DB on first run by `skill-migration.ts`.

### Playbooks (`playbook`)

Playbook tasks from `playbook.json` manifests in the playbooks directory are migrated as individual skills. Each task gets its own skill with the instruction file content as the skill body. These are keyword-matched at job time, not auto-fetched.

### Training Pipeline (`training`)

The training system analyzes source material (project files, example scenes, learning vault artifacts) and produces skills with extracted patterns. These have `source: "training"`, priority 30, and are ranked by relevance at query time.

### Manual (`user`)

Created through the admin panel or API. Users can set any category, priority, and auto-fetch behavior.

## Effectiveness Tracking

Every time an agent loads a skill through MCP tools (`search_skills`/`get_skill`), the `skill_effectiveness` table records the usage:

```
skill_effectiveness (id, skill_id, job_id, job_outcome, created_at)
```

When a job completes and receives an outcome signal (`positive`/`good`, `average`, `negative`/`poor`), the outcome propagates to all skill usage records for that job.

### Graduated Confidence Model

The ranking algorithm uses a three-phase confidence model for effectiveness scoring:

| Phase         | Usage Count | Behavior                                                |
|---------------|-------------|---------------------------------------------------------|
| Exploration   | < 20 uses   | Optimistic bonus (0.6) to encourage discovery           |
| Transition    | 20-60 uses  | Blends from neutral (0.5) toward actual success rate    |
| Established   | 60+ uses    | Full trust in success rate, floored at 0.10             |

The floor at 0.10 ensures even poorly performing skills can still surface if the prompt match is strong enough. Skills are never hard-disabled by low effectiveness alone.

## Skill Versioning

When a skill's content, keywords, or description change, the current state is snapshotted to `skill_versions` before the update:

```
skill_versions (id, skill_id, version, content, keywords, description, created_at)
```

The skill's `version` counter increments with each content change. Previous versions can be listed and rolled back through the API or admin panel. Rollback creates a new version entry (the pre-rollback state) before restoring the target version's content.

## Managing Skills

### Admin Panel

The admin UI (Coordinator section) provides:

- Skill list with filtering by program, category, source, and enabled state
- Full CRUD: create, edit, delete, toggle enabled/auto-fetch
- Version history with rollback
- Effectiveness stats per skill
- Bulk operations: re-pull bridge skills, reset to defaults

### API Endpoints

Skills are managed through the settings-coordinator routes:

| Method   | Endpoint                          | Purpose                        |
|----------|-----------------------------------|--------------------------------|
| `GET`    | `/api/settings/skills`            | List skills (filterable)       |
| `GET`    | `/api/settings/skills/:slug`      | Get skill by slug              |
| `POST`   | `/api/settings/skills`            | Create skill                   |
| `PATCH`  | `/api/settings/skills/:slug`      | Update skill                   |
| `DELETE` | `/api/settings/skills/:slug`      | Delete skill                   |
| `POST`   | `/api/settings/skills/pull`       | Force re-pull from bridge repo |

### Skill Validation

The `skill-validator.ts` module checks skills for common issues before save:

- **Errors**: empty content, empty title, empty slug, invalid regex in keywords
- **Warnings**: very short content (< 10 chars), empty category, contradictory instructions (e.g. "always use" + "never use" in the same content)

Validation returns `{ valid: boolean, issues: ValidationIssue[] }` where `valid` is false only if there are error-severity issues.

## The Self-Improvement Cycle

Skills are the storage layer for a continuous improvement loop:

```
Jobs execute
    |
    v
Outcomes recorded (positive / average / negative)
    |
    v
Effectiveness scores update per skill
    |
    v
Training pipeline analyzes source material + job history
    |
    v
New/updated skills created from extracted patterns
    |
    v
Better skill ranking for future jobs
    |
    v
Jobs execute with improved context
```

The training pipeline (manual or scheduled) scans configured source paths, discovers project references, and uses an agent to analyze them. The analysis output is parsed into skill records that capture reusable patterns, known pitfalls, and project-specific conventions.

Over time, skills with consistently positive outcomes rise in ranking while underperforming skills naturally sink. The graduated confidence model gives new skills a fair chance to prove themselves before their effectiveness score dominates the ranking.
