# Task: Align Training Pipeline with Skills System

## Problem

The training pipeline creates empty skill stubs instead of useful, searchable skills. Analysis of 77 skills shows:
- 6 project-reference skills are empty stubs ("No project references discovered yet")
- `related_skills` field: 0 of 77 skills use it
- `playbooks` field: 6 skills reference vault artifacts but the actual content is never loaded into the skill
- The vault artifacts (`analysis.json`, `analysis.md`) contain rich analysis data that's just sitting on disk, not accessible to agents via skill search

## Root Cause

In `server/src/agents/coordinator-training.ts`:

1. **Lines 564-571**: When no projects are discovered, placeholder summaries are created with static "No project references discovered yet" text. This stub text becomes the skill content.

2. **Lines 1469-1527**: Skills are created from summary text only (~115 chars), not from the full vault artifact content. The `playbooks` field stores a reference path but the artifact content is never embedded in the skill.

3. **Lines 1337-1370**: The vault artifact (`CoordinatorTrainingArtifact`) contains rich data: full project inventory, configurations, notes, analysis — but this never flows into the skill content.

4. In `training-extraction.ts` **lines 274-311**: When agentic analysis doesn't emit structured JSON, the system falls back to synthetic seeds with minimal content.

## What Needs to Change

### 1. Richer skill content from training (coordinator-training.ts ~L1469-1527)

When creating skills from training artifacts, embed the actual useful content:
- Full project inventory (scene files, scripts, assets)
- Discovered configurations and settings
- Notes and documentation excerpts from the project
- The agent's actual analysis reasoning (from logs)
- Key patterns, techniques, and conventions discovered

Don't just store a path reference — put the knowledge IN the skill content so it's searchable and auto-injectable.

### 2. Stop creating empty stubs (coordinator-training.ts ~L564-571)

If no useful content was discovered, don't create a skill at all. An empty "No project references discovered yet" skill adds noise to search results. Either:
- Skip skill creation when summary is a placeholder
- Or gate with: `if (summaryText.includes("No project references discovered yet")) continue;`

### 3. Populate related_skills (create_skill MCP tool + training)

Add `relatedSkills` parameter to the `create_skill` MCP tool (server/src/mcp/tool-server.ts ~L1207-1216) so agents can link skills together. When training creates multiple skills for the same program, automatically set them as related.

### 4. Load playbook content into skills on fetch (optional)

When `get_skill` is called and the skill has a `playbooks` reference, optionally load and append the artifact content. This way old stubs become useful when their artifacts have real data. Location: `server/src/mcp/tool-server.ts` get_skill handler (~L1126-1165).

### 5. Better training prompts for structured output

The training agent should be prompted to emit structured JSON with specific fields (patterns, techniques, gotchas, code examples) rather than free-form analysis that's hard to extract. This is in `coordinator-training.ts` where the training prompt is built.

## Key Files

| File | Lines | What |
|------|-------|------|
| `server/src/agents/coordinator-training.ts` | 564-571 | Placeholder stub creation |
| `server/src/agents/coordinator-training.ts` | 1337-1370 | Artifact building (has rich data) |
| `server/src/agents/coordinator-training.ts` | 1469-1527 | Phase 1: skill creation from summaries |
| `server/src/agents/coordinator-training.ts` | 1530-1575 | Phase 2: skill creation from filesystem |
| `server/src/agents/training-vault.ts` | 299-494 | Writes artifact to disk |
| `server/src/agents/training-extraction.ts` | 216-364 | Extracts seeds from agent output |
| `server/src/mcp/tool-server.ts` | 1126-1165 | get_skill handler |
| `server/src/mcp/tool-server.ts` | 1203-1242 | create_skill handler (missing relatedSkills param) |
| `server/src/db/skills.repo.ts` | 8-29 | Skill schema (has related_skills, playbooks fields) |

## Current Skill Stats (for reference)

- 77 total skills, 0 disabled
- Sources: agent (32), bridge-repo (36), builtin (1), training (6), user (2)
- Categories: bridge (37), custom (24), training (9), project-reference (6), coordinator (1)
- 21 auto-fetch skills
- 0 skills use related_skills
- 6 skills reference playbooks (all empty stubs)

## Verification

After changes:
1. Run a training job and verify the created skills have actual content (not stubs)
2. Verify empty stubs are no longer created
3. Verify `create_skill` MCP tool accepts `relatedSkills` parameter
4. Verify training-created skills include project inventory, patterns, and analysis
5. Check that existing skills aren't broken by the changes
