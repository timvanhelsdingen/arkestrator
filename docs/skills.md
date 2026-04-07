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
| `locked`       | boolean    | When true, prevents agent edits (housekeeping/training skip this skill) |
| `appVersion`   | string\|null | Arkestrator version that created/last updated the skill (for compatibility filtering) |

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

This keeps the base system prompt lean while giving agents access to the full skill library on demand. Both auto-fetch and on-demand skills are tracked for effectiveness — agents are instructed to rate all skills they used before finishing their job.

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

Each program (Houdini, Blender, Godot, etc.) has its own playbook directory containing a `playbook.json` manifest and individual task instruction files:

```
coordinator-playbooks/
  houdini/
    playbook.json          ← manifest: lists tasks, keywords, regex patterns
    tasks/explosion.md     ← instruction content for this task
    tasks/terrain.md
  blender/
    playbook.json
    tasks/donut.md
```

At startup, each task from these manifests is migrated into the skills DB as its own skill record, with the instruction file's markdown content as the skill body. Playbook skills are **not** auto-fetched — they are keyword- and regex-matched against the user's prompt at job time, so only relevant tasks get injected into agent context.

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

The ranking algorithm uses a three-phase confidence model for effectiveness scoring. All thresholds and weights are **configurable via the admin Skills page** (Ranking Tuning panel) or the `GET/PUT /api/skills/ranking-config` endpoints.

| Phase         | Default Usage Threshold | Behavior                                                |
|---------------|-------------------------|---------------------------------------------------------|
| Exploration   | < 8 uses                | Optimistic bonus (0.6) to encourage discovery           |
| Transition    | 8–25 uses               | Blends from neutral (0.5) toward actual success rate    |
| Established   | 25+ uses                | Full trust in success rate, floored at 0.10             |

| Setting                | Default | Description                                       |
|------------------------|---------|---------------------------------------------------|
| `explorationThreshold` | 8       | Uses below this = exploration phase               |
| `establishedThreshold` | 25      | Uses at/above this = established phase            |
| `explorationBonus`     | 0.6     | Effectiveness score during exploration            |
| `effectivenessFloor`   | 0.10    | Minimum score for established skills              |
| `weightLexical`        | 0.5     | Keyword matching weight in combined score         |
| `weightSemantic`       | 0.3     | Semantic similarity weight                        |
| `weightEffectiveness`  | 0.2     | Effectiveness weight                              |
| `minScoreThreshold`    | 0.05    | Minimum combined score to include in results      |

The floor at 0.10 ensures even poorly performing skills can still surface if the prompt match is strong enough. Skills are never hard-disabled by low effectiveness alone.

## Agent Rating Tools

Agents have two rating tools that drive the effectiveness feedback loop. Both are available as MCP tools and CLI commands.

### `rate_skill` — Rate a Skill After Using It

Agents call this to assess how useful a specific skill was for their current task.

| Input | Values | Maps To |
|-------|--------|---------|
| `rating` | `useful` | `positive` |
| `rating` | `not_useful` | `negative` |
| `rating` | `partial` | `average` |
| `notes` | Optional string | Stored with the rating |

MCP: `rate_skill(slug, rating, notes?)`
CLI: `am skills rate <slug> <useful|not_useful|partial>`

The `get_skill` response appends a reminder to rate the skill after use. Auto-fetched skills are also listed in the "Job & Skill Feedback" prompt section for agents to rate.

### `rate_job` — Self-Rate the Job Outcome

Agents call this once near the end of their work to self-assess the overall job quality.

| Input | Values | Maps To |
|-------|--------|---------|
| `rating` | `good` | `positive` |
| `rating` | `average` | `average` |
| `rating` | `poor` | `negative` |
| `notes` | Optional string (max 4000 chars) | Stored with the rating |

MCP: `rate_job(rating, notes?)`
CLI: `am jobs rate <good|average|poor> [notes]`

When `rate_job` is called:
1. The job's `outcomeRating` is set
2. Any skills used in the job that the agent didn't explicitly rate via `rate_skill` are updated with the job's outcome as a fallback
3. The updated job is broadcast to clients

### User Outcome Rating

Users can also rate jobs after completion via the UI or `POST /api/jobs/:id/outcome`. User ratings:
- Accept `good`/`average`/`poor` (legacy `positive`/`negative` also accepted)
- Propagate to all descendant sub-jobs
- Update skill effectiveness for unrated skills
- Feed into coordinator learning (experience entries with quality weights)

### Rating Flow Summary

```
Agent executes job
    |
    v
Agent calls rate_skill() for each skill used     <- explicit per-skill
    |
    v
Agent calls rate_job() before finishing           <- explicit per-job
    |                                                (also covers unrated skills)
    v
User optionally rates job via UI/API              <- overrides agent rating
    |                                                (propagates to descendants)
    v
Skill effectiveness scores updated
    |
    v
Coordinator learning records experience
    |
    v
Future jobs get better skill ranking
```

### Prompt Instructions

The spawner injects a "Job & Skill Feedback" section into every agent prompt that tells the agent:
1. To call `rate_job` with `good`, `average`, or `poor` before finishing
2. To call `rate_skill` for each skill it loaded or was auto-fetched
3. Lists the specific auto-fetched skill slugs to rate

This section is critical — without it, agents complete work without rating anything and the feedback loop breaks.

**Developer invariant:** The "Job & Skill Feedback" prompt section and the `rate_skill`/`rate_job` MCP tools must stay in sync. If you change the tool's accepted values, update the prompt instructions and the `get_skill` inline reminder to match. The enum values are:
- `rate_skill`: `useful` | `not_useful` | `partial`
- `rate_job`: `good` | `average` | `poor`

## Skill Locking

Skills can be **locked** to prevent modification by automated agents (housekeeping and training). When a skill is locked:

- Housekeeping and training agents skip it entirely
- Manual edits via the admin panel or API are still allowed
- The lock state is shown in the UI and toggleable per skill

This is useful for curated skills you don't want agents to modify, such as carefully tuned coordinator scripts or project-specific conventions.

## Skill Versioning

When a skill's content, keywords, or description change, the current state is snapshotted to `skill_versions` before the update:

```
skill_versions (id, skill_id, version, content, keywords, description, app_version, created_at)
```

The skill's `version` counter increments with each content change. Each update stamps the current Arkestrator `app_version` on both the skill and the version snapshot, enabling compatibility filtering if breaking changes are introduced in future versions. Previous versions can be listed and rolled back through the API or admin panel. Rollback creates a new version entry (the pre-rollback state) before restoring the target version's content. Individual versions can also be deleted.

The desktop client provides a **version dropdown selector** in the skill detail view for browsing and restoring previous versions.

## Agent Skills Open Standard (SKILL.md)

Skills are stored on disk as `SKILL.md` files following the [Agent Skills](https://agentskills.io) open standard, the same format used by Claude Code, Cursor, Gemini CLI, and other tools. SQLite serves as a search/effectiveness index cache rebuilt from disk on startup.

```
coordinator-playbooks/skills/<slug>/SKILL.md
```

Each SKILL.md file contains YAML frontmatter (metadata) and a markdown body (content):

```yaml
---
name: my-skill-slug
description: Short summary for search results
program: blender
category: training
keywords: [modeling, mesh, topology]
---

Skill content in markdown...
```

A file watcher detects external edits to SKILL.md files and auto-syncs changes to the database index.

### Import from GitHub

Pull skills from any public GitHub repository using the Agent Skills standard:

```
POST /api/skills/import
{ "repoUrl": "https://github.com/org/skills-repo", "program": "blender", "subPath": "blender/" }
```

The admin Skills page includes a registry browser for one-click installation of community skills.

## Managing Skills

### Admin Panel

The admin UI (Skills & Training section) provides:

- Skill list with filtering by program, category, source, and enabled state
- Compact view toggle for dense skill tables
- Full CRUD: create, edit, delete, toggle enabled/auto-fetch/locked
- Inline edit mode with version history and version dropdown
- Effectiveness stats per skill
- Registry browser for installing community skills
- Bulk operations: re-pull bridge skills, reset to defaults

### Desktop Client

The Coordinator (Skills & Training) page provides:

- Skill list with search, filtering, and compact view
- Skill detail overlay with metadata, playbooks, related skills, effectiveness stats
- Export/import with checkbox multi-select (JSON bundles)
- Single-skill export from the detail view
- Create skills with full field parity (description, keywords, priority, auto-fetch, enabled, category)

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
| `POST`   | `/api/skills/import`              | Import skills from GitHub repo |
| `GET`    | `/api/skills/ranking-config`      | Get ranking algorithm config   |
| `PUT`    | `/api/skills/ranking-config`      | Update ranking config          |

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
