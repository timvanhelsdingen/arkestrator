# Next Session: Self-Improving Knowledge System

## What Was Done (v0.1.78 → current)

### Skills as Knowledge Graph (completed)
- Skills are now lightweight index entries with `playbooks[]` referencing vault artifacts
- Spawner loads playbook JSON at job runtime, extracts summaries/notes/conventions into agent context
- `relatedSkills[]` field for linking skills together
- DB migration adds `playbooks` and `related_skills` columns
- Admin UI: playbook content preview, related skills navigation, wider modal, delete for all skills

### Phase 1: Smart Skill Matching (completed)
- `SkillIndex.rankForJob()` — hybrid lexical (50%) + semantic (30%) + effectiveness (20%) scoring
- Spawner now injects top-N most relevant skills instead of all enabled skills for a program
- AutoFetch skills (coordinators, bridge scripts) always inject regardless of score
- Skills with <20% success rate over 10+ uses are auto-excluded from injection
- `SkillEffectivenessRepo.getStatsForSkills()` — batch effectiveness lookup (single SQL query)
- `SkillIndex` wired through index.ts → WorkerLoop → SpawnerDeps for job-time ranking
- Structured logging (`skill-ranking`) shows which skills were selected and why
- Falls back to old program-only filter when SkillIndex unavailable

### Phase 2: Outcome-Weighted Learning (core — completed)
- Effectiveness scores from `skill_effectiveness` table are now factored into ranking
- Skills with `successRate < 0.2` over 10+ uses are auto-excluded from injection
- Skills with `totalUsed >= 3` get their actual success rate as the effectiveness score
- New skills (< 3 uses) get a neutral 0.5 effectiveness score (benefit of the doubt)
- Remaining: admin UI stats display, manual review surface for flagged skills

### Training Consolidation (completed)
- Eliminated orchestrator wrapper job (was 4-5 jobs per training run, now 2-3)
- Training routes through `queueCoordinatorTrainingJob` directly
- Agent auto-detects program from content (no more hardcoded houdini from file signatures)
- Global/filesystem mode for non-DCC content (PBR textures, docs, etc.)
- Combined Self-Learning UI (training + housekeeping in one panel)
- Schedules enabled by default (daily)
- Housekeeping chains directly from training via `chainHousekeeping` option

## The Problem: Current System Is Storage, Not Intelligence

The self-improvement loop has the right foundation but shallow intelligence:

### What Works
1. Training analyzes projects → creates vault artifacts with real data (node graphs, params, VEX code)
2. Skills point to those artifacts via `playbooks[]`
3. Spawner loads playbooks at job time → agent gets reference material
4. Housekeeping reviews jobs → generates skills from patterns

### What's Weak

**1. Keyword matching is crude**
- Skills match jobs by exact keyword overlap (e.g. "FLIP" in prompt matches "FLIP" in skill keywords)
- "make water splash" won't match a FLIP simulation skill even though it's the same thing
- No semantic understanding of what a skill covers
- Location: `server/src/agents/spawner.ts` lines 1451-1530 (skill filtering is just `program` match, no keyword matching at all currently — ALL enabled skills for the program get injected)

**2. No outcome-based learning**
- `skill_effectiveness` table exists and records which skills were used in which jobs
- But NOTHING reads this data to influence future behavior
- A skill that correlates with 90% failed jobs still gets injected every time
- A skill that correlates with 100% success never gets prioritized
- Location: `server/src/db/skill-effectiveness.repo.ts`, written in `spawner.ts` line 1523

**3. Housekeeping generates mediocre skills**
- Looks at job log summaries (truncated text), not actual commands/code the agent used
- Produces generic advice like "verify output exists" instead of actionable techniques
- No access to the actual successful tool calls, file changes, or bridge commands
- Location: `server/src/agents/housekeeping.ts` — the prompt at `buildHousekeepingPrompt()`

**4. No learning from success**
- When a job gets rated "positive" by the user, nothing happens with that signal
- The specific technique that worked (exact commands, node setup, parameter values) isn't extracted
- The `outcome_rating` field on jobs is recorded but never fed back into training
- Location: job outcome fields in `server/src/db/jobs.repo.ts`

**5. Skills don't evolve**
- Once created, a skill's content and playbook references never change
- Playbook artifacts are snapshots from training time — they go stale as projects evolve
- No mechanism to re-analyze when source projects change
- `skill_versions` table exists for rollback but there's no auto-refinement

## What Needs To Be Built

### Phase 1: Smart Skill Matching (highest impact)

**Goal:** When a job arrives, find the most relevant skills using semantic similarity, not just program filtering.

**Approach:**
- Embed skill descriptions + keywords into vectors (already have `buildSemanticVector()` in `skill-index.ts`)
- Embed the job prompt into a vector
- Score skills by cosine similarity to the job prompt
- Inject top-N most relevant skills (not ALL enabled skills)
- Weight by effectiveness score (success rate from `skill_effectiveness` table)

**Key files:**
- `server/src/agents/spawner.ts` — replace the "all enabled skills for program" filter with semantic ranking
- `server/src/skills/skill-index.ts` — already has TF-IDF + semantic vectors, just needs a `rankForPrompt(prompt, program)` method
- `server/src/db/skill-effectiveness.repo.ts` — add `getSuccessRate(skillId)` method

**Expected impact:** Agents get 3-5 highly relevant skills instead of 15+ loosely related ones. Less prompt bloat, better guidance.

### Phase 2: Outcome-Weighted Learning

**Goal:** Skills that help succeed get prioritized. Skills that correlate with failure get deprioritized or flagged for revision.

**Approach:**
- After job completion, update `skill_effectiveness` with the outcome rating
- Compute per-skill success rate: `positive_outcomes / total_uses`
- Factor success rate into the skill ranking from Phase 1
- Auto-disable skills below a threshold (e.g. < 20% success over 10+ uses)
- Surface low-performing skills in admin UI for manual review

**Key files:**
- `server/src/db/skill-effectiveness.repo.ts` — add aggregation queries
- `server/src/agents/spawner.ts` — wire effectiveness scores into skill ranking
- Job completion handler (wherever `outcome_rating` is set) — trigger effectiveness update
- `admin/src/pages/Skills.svelte` — show effectiveness stats, flag poor performers

**Expected impact:** System naturally prunes bad advice and amplifies good advice over time.

### Phase 3: Success Extraction

**Goal:** When a job succeeds and gets rated positive, extract the specific techniques used and feed them back into skills.

**Approach:**
- On positive job rating, analyze the job's logs for:
  - Bridge commands that succeeded (node creation, parameter setting, VEX code)
  - File changes produced
  - Tool call patterns that worked
- Create or update a skill with these concrete techniques
- Link the skill to the playbook artifact if one was used

**Key files:**
- New: `server/src/agents/success-extractor.ts` — parses job logs for actionable patterns
- `server/src/agents/housekeeping.ts` — incorporate success extraction into housekeeping flow
- `server/src/db/skills.repo.ts` — upsert skills with extracted techniques

**Expected impact:** System learns from what actually worked, not from generic analysis.

### Phase 4: Active Skill Refinement

**Goal:** Periodically re-evaluate and improve existing skills based on accumulated evidence.

**Approach:**
- Scheduled refinement job that:
  1. Finds skills with 10+ uses and mixed outcomes
  2. Loads all job logs where the skill was used
  3. Asks the AI to compare successful vs failed executions
  4. Rewrites the skill to emphasize what worked and warn about what failed
- Merge duplicate skills covering the same topic
- Prune stale skills whose playbook references no longer exist on disk

**Key files:**
- New: `server/src/agents/skill-refinement.ts`
- `server/src/agents/housekeeping.ts` — add refinement phase after standard housekeeping

**Expected impact:** Skills get better with use, not just with training.

## Architecture Notes

### Skill Matching Flow (target state)
```
Job prompt: "Create a FLIP sim with viscosity"
  → Embed prompt → semantic vector
  → Score all enabled skills by:
      1. Cosine similarity to prompt (0.0 - 1.0)
      2. Program match bonus (+0.2 if program matches)
      3. Effectiveness weight (success_rate * 0.3)
  → Top 5 skills by combined score
  → For each: load playbook artifacts from disk
  → Inject into agent context (capped at 30KB total)
```

### Effectiveness Tracking Flow (target state)
```
Job completes → outcome_rating set by user
  → For each skill used in this job:
      Update skill_effectiveness with outcome
  → Compute running success_rate
  → If success_rate < 0.2 over 10+ uses:
      Flag skill for review, auto-disable
  → If success_rate > 0.8 over 10+ uses:
      Boost priority
```

### Success Extraction Flow (target state)
```
Job rated "positive"
  → Parse job logs for:
      - Bridge commands (scene manipulation)
      - File changes (created/modified)
      - Tool call sequences
  → Create/update skill with extracted patterns
  → Link to source job's playbook if applicable
  → Tag with detected programs from job metadata
```

## Key Files Reference
- `server/src/agents/spawner.ts` — skill injection into job prompts (lines 1451-1530)
- `server/src/skills/skill-index.ts` — search index with TF-IDF + semantic vectors
- `server/src/db/skill-effectiveness.repo.ts` — usage/outcome tracking (exists, underused)
- `server/src/db/skills.repo.ts` — skills CRUD with playbooks/relatedSkills
- `server/src/agents/housekeeping.ts` — job review and skill generation
- `server/src/agents/coordinator-training.ts` — training flow, skill creation from analysis
- `server/src/agents/training-vault.ts` — vault artifact writing
- `admin/src/pages/Skills.svelte` — admin skills UI

## What Was Done (this session — UI/UX layer)

### Skill Effectiveness Stats (admin + client)
- New `POST /api/skills/batch-effectiveness` route — batch fetch stats for all skills in one call
- Admin Skills table: "Uses" and "Success" columns with color-coded badges (green/yellow/red)
- Client Coordinator skills table: same effectiveness columns
- `SkillSummary` now includes `id` field for effectiveness lookups

### Client Skill "View" Popup — Rich Detail
- Replaced bare `<pre>` content block with full detail modal matching admin
- Shows: metadata grid (slug, program, category, source, priority, enabled), effectiveness stats, description, related skills (clickable), playbook content preview, full content
- Added `getPlaybookContent()` and `getEffectiveness()` to client REST API

### Delete Any Skill
- Removed `source === "user" || source === "registry"` restriction from both admin and client
- All skills can now be deleted regardless of source (training, bridge-repo, coordinator, etc.)

### Clear Pending Guidance
- New `DELETE /api/jobs/:id/interventions/pending` route — rejects all pending interventions for a job
- "Clear Pending" button in Jobs page intervention section, visible when pending guidance exists

### Bridge Execution Mode in Job Settings
- New "Execution Mode" dropdown in ChatJobConfig: Auto (default), Live Bridge, CLI/Headless
- `setBridgeExecutionMode()` method added to chat store
- Users can now explicitly force headless/CLI mode instead of relying on auto-detection

### Per-Bridge Best Practices (coordinator scripts)
- Added "Best Practices — File & Project Organization" sections to all 7 bridge coordinator.md files
- Covers: Houdini ($HIP-relative paths, geo/usd/vex/cache folders), Blender (textures/renders/exports), ComfyUI (workflows/models structure), Godot (res:// paths, scenes/scripts/assets), Unity (Assets/ subfolders, PascalCase), Unreal (/Game/ structure, prefix conventions), Fusion (comps/renders/footage)
- Pushed to arkestrator-bridges repo

### Config Page Assessment
- No separate "Config" page exists in the client to remove
- Settings.svelte handles auth/bridges/LLM, Coordinator handles scripts/training, ChatJobConfig handles runtime options

## Remaining Work

### First-Time Startup Wizard (next session — priority)
- **Two modes based on connection type:**
  - **Local server**: Welcome → Agent setup (AI providers, API keys) → Bridge plugin installer (detect DCCs, one-click install) → Quick preferences → Done
  - **Remote server**: Welcome → Connect (URL + auth) → Bridge plugin installer → Done
- **Bridge plugin installer**: Detect installed DCC apps by scanning known install paths per platform, offer one-click bridge plugin installation
- **`setupComplete` flag** in client local storage to skip wizard on subsequent launches
- **Extend or replace `Setup.svelte`** with multi-step wizard flow

### Future Improvements
- **Success extraction (Phase 3)**: When a job gets rated positive, extract specific techniques and feed back into skills
- **Active skill refinement (Phase 4)**: Periodically re-evaluate skills based on accumulated evidence
- **Job collapsing UI**: Implemented — verify in production

## Test Sources
- `W:\AGENT_REPO\Houdini\FLIP drop object` — Houdini FLIP sim
- `W:\AGENT_REPO\Houdini\simplefireball_XPU` — Houdini pyro
- `Z:\ASSETS\Megascans\Downloaded\surface` — PBR textures (global)

## Build & Run
```bash
cd C:\Users\timvanhelsdingen\Documents\Github\arkestrator
pnpm --filter @arkestrator/protocol build
pnpm --filter @arkestrator/admin build
xcopy /E /Y admin\dist\* client\resources\admin-dist\
pnpm --filter @arkestrator/client tauri dev
```

## Verification
1. Run `bun test server/src/__tests__/` — all pass
2. Train on `W:\AGENT_REPO\Houdini` → skills have playbook refs, short content
3. Submit "Create a FLIP sim" → check agent context for loaded playbook content
4. Rate a job positive → verify effectiveness tracking records it
5. After Phase 1: submit "make water splash" → should match FLIP skill via semantics
