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
- **Verification helper skills** (slug `verification` or category `verification`) — *skipped* when the job has `runtimeOptions.verificationMode === "disabled"`, since the skill has no chance to help and agents will only end up rating it `not_useful`
- Any custom skill explicitly marked as auto-fetch

Auto-fetch skills appear under a `## Coordinator Knowledge` section in the system prompt, sorted by `priority` DESC so coordinators (90) come before bridges (70) before custom auto-fetch skills. Duplicate slugs (e.g. a `global` skill colliding with a program-specific override) collapse into whichever has the higher priority. Each skill gets a `### Title [program]` header followed by its content, capped at 4,000 characters per skill and 15,000 characters for the whole section. Truncation is markdown-aware — it never cuts inside a code fence and will close any open ``` block before the cut, so agents never see half-written code. The "Job & Skill Feedback" prompt lists the slugs that were actually injected (after verification-disabled filtering and content-budget truncation), so the agent can't be asked to rate a slug that never made it into the prompt.

### Tier 2: On-Demand (MCP tool search)

All other enabled skills are available through MCP tools — `search_skills` and `get_skill`. The agent is given a mandatory instruction to search skills before starting bridge work:

> MANDATORY: Before starting bridge work, call search_skills with a query describing your task type to find relevant execution patterns, known pitfalls, and project-specific guidance.

This keeps the base system prompt lean while giving agents access to the full skill library on demand. Both auto-fetch and on-demand skills are tracked for effectiveness — agents are instructed to rate all skills they used before finishing their job.

### Ranking Algorithm

The `SkillIndex.rankForJob()` method scores each skill using a weighted combination:

| Component       | Weight | Description                                           |
|-----------------|--------|-------------------------------------------------------|
| Lexical score   | 50%    | Field-weighted BM25-flavoured score with IDF          |
| Semantic score  | 30%    | Cosine similarity of 48-dimensional hash vectors      |
| Effectiveness   | 20%    | Success rate adjusted by graduated-confidence phase   |

**Lexical scoring** is not "fraction of query tokens hit" — it's a BM25 variant with per-field weights and inverse-document-frequency:

- Title tokens count 3.5×, keywords 3.0×, description 2.0×, content 1.0×.
- Each matched term contributes `idf(term) × tf_saturation(term, doc)` where `tf_saturation` uses `k1 = 1.2`, `b = 0.6` with the skill's weighted token length normalised against the corpus average.
- The total is divided by the query's best-case contribution so the score is comparable across queries of different lengths.
- Short DCC terms (`ui`, `api`, `2d`, `rgb`, `fx`, `hdr`, `pbr`, `sss`, etc.) are allowlisted through the 3-character minimum so they stay rankable.

**Semantic scoring** uses a locality-sensitive hash vector: tokens and 4-character n-grams are hashed into a 48-dim vector and cosine similarity measures overlap. It's correlated with lexical but catches near-synonyms and substring overlaps that the BM25 term match misses.

**Effectiveness** uses the graduated-confidence model below. It is driven by a dedicated SQL aggregate (`getRankingInfoForAllSkills()`) that counts only rows with a non-null outcome as "rated". Pending rows — e.g. from `search_skills` touches the agent never fetched — do **not** advance the phase counter. Before this, `ratedCount` was never populated and every skill stayed locked in exploration at a constant 0.6 regardless of history.

**Priority + program bonuses.** On top of the weighted combination, the scorer adds up to ±0.05 from the skill's `priority` field (so admin-curated skills tie-break correctly) and +0.03 for any skill whose program matches the job's bridge (so a `blender`-specific skill edges out an equivalent `global` one on Blender jobs).

**Shared scorer.** Both the MCP `search_skills` tool (on-demand search) and the spawner's auto-fetch ranker go through the same `scoreSkill()` pipeline and read the same ranking config from `server_settings`, so the admin "Ranking Tuning" sliders actually take effect at the agent level. Previously `search()` hardcoded `0.65 / 0.35` weights and ignored effectiveness entirely — the agent and the admin UI saw two different ranking systems.

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

Usage is recorded whenever an agent actually loads a skill's content during a job:

- `get_skill` MCP tool — records usage on fetch
- Auto-fetch at spawn time — records usage for every skill whose content was actually injected into the Coordinator Knowledge section (not the full filter list — verification-disabled skills and content-budget overflow are filtered out first)
- `GET /api/skills/:slug` REST route with an `X-Job-Id` header — the `am` CLI path
- `retarget_job` MCP tool — records usage for newly-loaded skills after a mid-job program retarget

**`search_skills` deliberately does NOT record usage for its returned results.** Previously it stamped every result as "seen" on the assumption the agent might act on title+description alone, but that inflated effectiveness counts and — worse — let the `rate_job` fallback stamp an outcome onto skills the agent never actually opened. Usage is now only recorded when the agent commits to inspecting the content.

All paths use `recordUsageOnce(skillId, jobId)`, which is an `INSERT OR IGNORE` against a `UNIQUE(skill_id, job_id)` index — safe under concurrent MCP calls from parallel agents. Before this release, idempotency depended on a racy SELECT-then-INSERT that could double-insert under load.

`rate_skill` is an **UPSERT**: if an agent rates a skill but no usage row exists yet (e.g. rated after only `search_skills` on an older code path, or via `am skills rate` CLI), `recordSkillOutcome` creates a new row with the outcome so the rating is never silently dropped.

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

**Verification skills on verification-disabled jobs are a special case.** When a job has `runtimeOptions.verificationMode === "disabled"`, verification helper skills are (a) filtered out of auto-fetch injection in `spawner.ts`, (b) hidden from `search_skills` results, (c) skipped by `get_skill` usage tracking, and (d) rejected by `rate_skill` (with any stray usage row deleted via `deleteForSkillAndJob`). This prevents ratings from jobs where the skill was structurally incapable of helping from polluting its effectiveness stats. The same filter runs in `retarget_job` so re-loading coordinator knowledge for a new program doesn't reintroduce verification skills the user explicitly opted out of.

### `retarget_job` — Fix a Mis-tagged Job

Agents call this when they discover the job was tagged with the wrong `bridgeProgram` (e.g. tagged `houdini` but the actual work is in Blender). The tool:

1. Updates `jobs.bridge_program` in the database
2. Reloads all matching auto-fetch coordinator/bridge skills for the new program
3. Returns the reloaded skill content inline so the agent can use it without another round-trip
4. Records usage rows under the current job id so effectiveness stats follow the real program
5. Broadcasts the updated job to clients so the UI reflects the corrected tag

MCP: `retarget_job(program, reason)`

This is critical because without it, a mis-tagged job:
- Gets the wrong bridge coordinator auto-fetched at spawn time
- Ranks skills against the wrong program
- Inflates stats for the wrong program and leaves the real program's skills invisible

Agents are instructed in the global coordinator prompt to call this the moment they notice the mismatch — before writing any execution code.

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

## Community Skills for Agents (BETA)

Agents can autonomously search and install skills from the **Arkestrator community registry** on arkestrator.com as a fallback when `search_skills` returns no relevant local skills for their task. This closes the loop: local skills are always tried first, and if nothing matches, agents reach out to the public catalog, install the best match, and immediately use it — all within a single job.

**Beta status:** this feature is **currently free** for everyone with a GitHub-authenticated arkestrator.com account. It will become a paid feature later (billed via Lemon Squeezy, not GitHub Sponsors), at which point beta users will get advance notice and preferential pricing. Usage is tracked via minimal counters (total install count, last-active timestamp) on the arkestrator.com side so pricing decisions can be grounded in real data rather than guesswork.

### Prerequisites

Before an agent can use this feature, the user running the local Arkestrator server must:

1. Open the desktop client → **Settings → Community tab**
2. Click **Connect with GitHub** and complete OAuth on arkestrator.com
3. Paste the returned token back into the client

When they save the token, the client automatically pushes it to the local Arkestrator server (`PUT /api/settings/community-session`), which stores it per-user in the `users.community_session_token` column. The MCP tools then forward it as a `Bearer` token on upstream calls to arkestrator.com.

The admin panel includes a **Community Skills** section under System Settings that shows which users on the server have active community sessions, lets admins disable the feature with a kill switch, override the community base URL (for self-hosted or local testing), and clear individual users' sessions if tokens are leaked or users leave the team.

### MCP Tools

Two new tools are available to agents during jobs:

**`search_community_skills(query, program?, limit?)`** — Free for everyone, no gating. Searches the public community registry via `GET arkestrator.com/api/skills`. Returns summaries (id, slug, title, description, program, category, keywords) plus an **`alreadyInstalledLocally`** flag per result so agents skip re-installing skills they already have. On network failure, returns `{ skills: [], unreachable: true }` for graceful degradation.

**`install_community_skill(communityId)`** — Requires the user's community session token. Hits `POST arkestrator.com/api/skills/:id/agent-install` which enforces authentication and records telemetry. Downloads the SKILL.md, installs it locally with `source: "community"` (handling slug collisions with a `-community` suffix), records usage for effectiveness tracking tied to the current job, and returns the local slug so the agent can immediately call `get_skill`.

Agents are instructed in the "Available Skills" section of the spawner prompt to:
1. Call `search_skills` first (local)
2. If nothing relevant, call `search_community_skills` as a fallback
3. If a promising result is not `alreadyInstalledLocally`, call `install_community_skill`
4. Read the resulting skill via `get_skill` and use it

### Forward-compatible error handling

The MCP tool's error handling is deliberately forward-compatible: any non-2xx response from arkestrator.com has its JSON body passed through verbatim (with `error` + `message` fields). This means that when the paywall is eventually flipped on and the arkestrator.com endpoint starts returning new error shapes (`subscription_required`, `slots_exhausted`, `rate_limited`, etc.), old beta builds of Arkestrator will automatically relay those messages to users without any client update. The client is a pass-through, not a translator.

### Admin kill switch

This feature is **disabled by default**. Operators must explicitly enable it at `Admin → System → Community Skills → Enable agent community auto-install` because it sends per-user bearer tokens to an external origin and installs third-party content into agent prompts. The kill switch now gates **both** the MCP tools AND the `POST /install-community` REST route used by the client UI — when disabled, every install path (agent or human) is blocked with `error: "community_disabled"` until re-enabled.

### Hardening

The community install pipeline (client UI + agent MCP) enforces:

- **Size cap:** 256 KB hard limit on the downloaded SKILL.md body. Oversized payloads are rejected with `error: "content_too_large"`.
- **Semantic validation:** every install runs through `validateSkill()` before touching the DB. Empty content, invalid regex keywords, and other error-severity issues are rejected with `error: "invalid_content"` instead of being silently written.
- **HTTPS only:** the community base URL must be `https://` (loopback `http://localhost` and `http://127.0.0.1` are allowed for local dev). Non-HTTPS overrides are rejected at the admin PUT endpoint and ignored by `resolveCommunityBaseUrl()`.
- **No caller-supplied base URL:** `POST /install-community` no longer accepts `communityBaseUrl` in the request body — the server always resolves it from config. This closes an authenticated SSRF vector where any user with write access could force the server to fetch from an arbitrary host.
- **Resolution priority:** `server_settings community.baseUrl` > `ARKESTRATOR_COMMUNITY_BASE_URL` env var > default. The admin UI is authoritative over the env var.

### Star rating feedback loop

Community skills have a 1-5 star rating on arkestrator.com (`avg_rating` + `rating_count` per skill). Ratings flow in two ways:

**Agent-driven (rolling average).** When an agent calls `rate_skill` on a community-sourced skill, the server:

1. Records the internal `useful | partial | not_useful` outcome as usual.
2. Looks up the acting user's community session token from `users.community_session_token`.
3. Computes a per-user rolling tally for that skill via `SkillEffectivenessRepo.getUserOutcomeTally`, which joins `skill_effectiveness` with `jobs` on `submitted_by` so other users' ratings on the same server don't leak into your public score.
4. Maps outcomes to stars (`positive=5`, `average=3`, `negative=1`), computes the mean, rounds, clamps to `[1,5]`.
5. POSTs to `arkestrator.com/api/skills/:communityId/rate` with a Bearer token. The upstream endpoint is upsert-per-user, so a later job's rating replaces the previous one — this is what "adjust rating with new jobs" means.

The local internal rating is the source of truth — any upstream push failure is logged but never fails `rate_skill`. Non-community skills skip the push entirely. The upstream `communityId` is stored in the new `skills.community_id` column at install time; community skills installed before this column existed carry a null and will silently skip the upstream push.

**Manual (client UI).** The skill detail modal in the desktop client includes a StarRating widget under the description. When the user has an active community auth token in `Settings → Community`, they can click to submit a 1-5 star rating directly to arkestrator.com via `communityApi.rateSkill`; the same `GET /api/skills/:id/rating` endpoint pre-populates their previous choice when the modal opens. The aggregate (`avg_rating` + `rating_count`) renders in both the SkillCard and the modal header.

A parallel server proxy route exists at `GET/POST /api/skills/community/:communityId/rating` (and `/rate`) for `am` CLI users or other headless clients that prefer to forward through the local server rather than hit arkestrator.com directly.

### Server files

- `server/src/skills/community-install.ts` — shared install helper with forward-compatible error handling (used by both `POST /install-community` HTTP route and the `install_community_skill` MCP tool)
- `server/src/skills/community-rating.ts` — `pushCommunityRating` / `fetchCommunityUserRating` helpers used by the `rate_skill` MCP hook and the manual-rating HTTP routes
- `server/src/mcp/tool-server.ts` — MCP tool registration for `search_community_skills` and `install_community_skill`
- `server/src/routes/settings-general.ts` — `PUT /api/settings/community-session` (per-user), admin community kill-switch/base-url endpoints
- `server/src/db/users.repo.ts` — `setCommunitySessionToken`, `getCommunitySessionToken`, `listWithCommunitySession`
- `server/src/agents/spawner.ts` — Available Skills instruction block with community fallback wording

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
