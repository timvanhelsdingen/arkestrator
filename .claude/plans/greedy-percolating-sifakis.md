# Skills as Knowledge Graph — Implementation Plan

## Context
Training produces rich analysis artifacts in the vault (`_learning/jobs/<program>/<slug>/analysis.json`) but this knowledge never reaches job agents. Skills currently embed the full analysis text as `content` (up to 6KB), which goes stale, bloats prompts, and contains hardcoded absolute file paths. The vault has the real data but nothing references it.

**Goal:** Redesign skills into lightweight index entries that *reference* vault playbooks. At job runtime, the spawner loads the referenced playbook files and injects their content into the agent's context.

---

## Step 1: DB Schema — Add `playbooks` and `related_skills` columns

**File:** `server/src/db/migrations.ts` — add to `COLUMN_ADDITIONS`
```sql
ALTER TABLE skills ADD COLUMN playbooks TEXT NOT NULL DEFAULT '[]'
ALTER TABLE skills ADD COLUMN related_skills TEXT NOT NULL DEFAULT '[]'
```

**File:** `server/src/db/skills.repo.ts`
- Add `playbooks: string[]` and `relatedSkills: string[]` to `Skill` interface
- Add `playbooks: string` and `related_skills: string` to `SkillRow` interface
- Parse both JSON arrays in `rowToSkill()`
- Add `playbooks?: string[]` and `relatedSkills?: string[]` to `CreateSkillInput` and `UpdateSkillInput`
- Update `insertStmt`, `upsertStmt` SQL to include `playbooks, related_skills` columns
- Update `update()` to handle `playbooks` and `relatedSkills` fields
- Update `upsertBySlugAndProgram()` to pass `playbooks` and `related_skills`

---

## Step 2: Training — Create lightweight index skills with playbook references

**File:** `server/src/agents/coordinator-training.ts` (lines 1360-1505)

Replace the current skill creation block. After training writes the vault artifact via `writeCoordinatorTrainingArtifact()`, the skill should be:

- **content**: Short 1-2 paragraph summary only (NOT the full analysis text)
- **playbooks**: `["_learning/jobs/<program>/<folder>/analysis.json"]` — relative path to vault artifact
- **keywords**: Already extracted via `extractProjectKeywords()` — keep as-is
- **description**: Short summary — keep as-is
- **No absolute paths** in content — remove `**Path:** ${project.projectPath}` line

The vault artifact path is already computed in `writeCoordinatorTrainingArtifact()` which returns `jsonVaultPath` (relative to `coordinatorPlaybooksDir`). We need to capture that return value and pass it to the skill creation.

Key change: The `contentParts` array currently builds a multi-section markdown document (Summary, Analysis, Conventions, Scene Files, Agent Analysis Output). Replace with just the summary + a note that the full analysis is in the referenced playbook.

---

## Step 3: Spawner — Load referenced playbooks at runtime

**File:** `server/src/agents/spawner.ts` (lines 1451-1485)

Current code injects `skill.content` as raw text. Change to:

1. For each matched skill, check if `skill.playbooks.length > 0`
2. For each playbook path in `skill.playbooks`:
   - Resolve: `join(deps.config.coordinatorPlaybooksDir, playbookPath)`
   - Read the file (JSON or Markdown)
   - For `.json` files: extract the key fields (summaries, projects, notes) — don't dump the entire artifact
   - For `.md` files: read as-is
3. Inject the loaded playbook content under the skill header (replacing `skill.content`)
4. If playbook file doesn't exist, fall back to `skill.content` (graceful degradation)
5. Cap total injected skill content to prevent prompt bloat (e.g. 30KB total across all skills)

The spawner already has access to `deps.config.coordinatorPlaybooksDir` (line 1377).

---

## Step 4: Housekeeping — Create skills with playbook references, link related skills

**File:** `server/src/agents/housekeeping.ts`

Update the housekeeping prompt (lines 155-200) to instruct the agent to:
- Include `playbooks:` and `related_skills:` in the frontmatter of `\`\`\`skill` blocks
- Reference vault artifact paths (relative to coordinator-playbooks dir)

Update the parsing logic (lines 229-285) to:
- Extract `playbooks:` frontmatter → JSON array of paths
- Extract `related_skills:` frontmatter → JSON array of slugs
- Pass both to `upsertBySlugAndProgram()`

---

## Step 5: Skills API — Expose new fields + playbook content endpoint

**File:** `server/src/routes/skills.ts`

- Ensure `playbooks` and `relatedSkills` are serialized in GET responses
- Add a `GET /api/skills/:slug/:program/playbook-content` endpoint that:
  - Reads the skill's playbook references
  - Returns the content of each referenced file
  - Used by the admin UI for inline preview

---

## Step 6: Admin UI — Show playbook references and related skills

**File:** `admin/src/pages/Skills.svelte`

- **Skills table**: Add "Playbooks" column showing count badge (e.g. "2 playbooks")
- **Detail modal**: Show playbook paths as clickable items that load content inline
- **Detail modal**: Show related skills as clickable links that navigate to those skills
- **Create modal**: Add `playbooks` textarea (JSON array) and `relatedSkills` multi-select

**File:** `client/src/pages/Coordinator.svelte` (Server Skills section)

- Show playbook count badge in skills table
- Skill view modal: show referenced playbooks with content preview

---

## Step 7: Tests

**File:** `server/src/__tests__/coordinator-training.test.ts`
- Update existing skill creation tests to verify `playbooks` field is populated
- Verify `content` is short (not embedded analysis)

**File:** `server/src/__tests__/` — add spawner skill injection test
- Mock skill with `playbooks: ["_learning/jobs/houdini/test/analysis.json"]`
- Verify spawner reads the file and injects playbook content

---

## Implementation Order

1. **DB schema + repo** (Step 1) — foundation, everything depends on this
2. **Training skill creation** (Step 2) — produces the new-format skills
3. **Spawner playbook loading** (Step 3) — the critical knowledge-flow fix
4. **Housekeeping** (Step 4) — secondary, builds on Steps 1-3
5. **API routes** (Step 5) — expose data for UI
6. **Admin/Client UI** (Step 6) — display the new fields
7. **Tests** (Step 7) — verify end-to-end

---

## Key Files Modified
- `server/src/db/migrations.ts` — 2 ALTER TABLE additions
- `server/src/db/skills.repo.ts` — Skill interfaces, rowToSkill, CRUD methods
- `server/src/agents/coordinator-training.ts` — Skill creation block (lines 1360-1505)
- `server/src/agents/spawner.ts` — Skill injection (lines 1451-1485)
- `server/src/agents/housekeeping.ts` — Prompt + parsing
- `server/src/routes/skills.ts` — API endpoints
- `admin/src/pages/Skills.svelte` — Detail modal, table columns
- `client/src/pages/Coordinator.svelte` — Skills section

## Existing Functions to Reuse
- `extractProjectKeywords()` in `training-extraction.ts` — keyword extraction (already works)
- `writeCoordinatorTrainingArtifact()` in `training-vault.ts` — returns `jsonVaultPath` relative path
- `loadCoordinatorPlaybookContextDetailed()` in `coordinator-playbooks.ts` — pattern for reading vault files
- `upsertBySlugAndProgram()` in `skills.repo.ts` — already handles insert/update

## Verification
1. Run `bun test server/src/__tests__/` — all tests pass
2. Build: `pnpm --filter @arkestrator/protocol build && pnpm --filter @arkestrator/admin build`
3. Manual test: Run training on `W:\AGENT_REPO\Houdini` → verify skills created with playbook references (not embedded text)
4. Check DB: `SELECT slug, playbooks, length(content) FROM skills WHERE source='training'` — content should be short, playbooks should have paths
5. Submit job: "Create a FLIP fluid sim" → check agent logs for injected playbook content
6. Admin UI: Skills page shows playbook count, detail modal shows playbook content preview
