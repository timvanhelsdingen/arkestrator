# Next Session: Skills as Knowledge Graph

## The Problem
Training currently produces three disconnected things:
1. Coordinator scripts (markdown injected into prompts) — contains hardcoded paths
2. Playbook JSON artifacts (in `_learning/` vault) — rich analysis data but never loaded by jobs
3. Skills (DB entries) — either empty boilerplate or bloated with embedded analysis text that goes stale

None of them reference each other. Skills have hardcoded file paths that break when projects move. The vault has the real knowledge but nothing points to it.

## The Vision: Skills as a Knowledge Graph

Skills should be **lightweight index entries that point to knowledge**, not contain it:

```
User: "Create a FLIP sim with a falling object"
  → Keyword match: flip, sim, fluid, particles
  → Finds skill: "FLIP Fluid Simulation" (houdini)
  → Skill references:
      - playbook: learning/jobs/houdini/flip-drop-object/analysis.json
      - related skills: ["particle-systems", "viscosity-setup"]
      - related playbooks: ["sop-flip-workflow"]
  → Agent loads referenced playbook at runtime
  → Agent has full node graph, parameters, VEX code
  → Agent builds user's scene using this as reference
```

### Skill Structure (redesigned)
```typescript
interface Skill {
  slug: string;           // "flip-fluid-simulation"
  name: string;           // "FLIP Fluid Simulation"
  program: string;        // "houdini" or "global"
  keywords: string[];     // ["flip", "fluid", "sim", "particles", "viscosity"]
  description: string;    // Short human-readable summary

  // References (the key change)
  playbooks: string[];    // paths to vault artifacts (relative to coordinator-playbooks dir)
  relatedSkills: string[];// slugs of related skills

  // NOT embedded analysis text — just enough for discovery
  content: string;        // Short summary for prompt injection (1-2 paragraphs max)
}
```

### How Training Should Work
1. Agent analyzes source project (via bridge/headless/filesystem)
2. Rich analysis goes into vault artifact (already happens): `_learning/jobs/houdini/flip-drop-object/analysis.json`
3. Skill created as **index entry** pointing to the artifact:
   - Keywords extracted from analysis (FLIP, fluid, particles, viscosity, etc.)
   - Playbook reference: `_learning/jobs/houdini/flip-drop-object/analysis.json`
   - Short description: "SOP-level FLIP fluid sim with object drop, varying viscosity, and Cd color transfer"
   - NO hardcoded absolute paths — all relative to coordinator-playbooks dir

### How Job Execution Should Work
1. Job prompt arrives: "Create a FLIP sim"
2. Skills matched by keywords: finds "FLIP Fluid Simulation"
3. Skill's `playbooks` references are loaded from vault
4. Loaded playbook content injected into agent's context
5. Agent has full reference material to work from

### How Housekeeping Should Work
1. Reviews recent jobs and existing skills
2. Identifies patterns → creates NEW skills pointing to successful job artifacts
3. Links related skills together (e.g. "FLIP sim" ↔ "particle systems" ↔ "viscosity")
4. Consolidates duplicate/overlapping skills
5. Prunes stale skills whose playbook references no longer exist

### Admin UI
- Skills page shows the knowledge graph visually
- Click a skill → see its playbook references, related skills
- Navigate between skills via relationship links
- Preview playbook content inline
- Training vault browser integrated into skills view

## Key Files
- `server/src/agents/coordinator-training.ts` — training orchestrator + skill creation
- `server/src/agents/training-vault.ts` — vault artifact writing
- `server/src/agents/spawner.ts` — skill injection into job prompts
- `server/src/db/skills.repo.ts` — skills CRUD
- `server/src/agents/housekeeping.ts` — housekeeping analysis
- `server/src/routes/skills.ts` — skills API
- `admin/src/pages/CoordinatorTraining.svelte` — admin training UI
- `client/src/pages/Coordinator.svelte` — client training UI

## What Already Works (v0.1.78)
- Training orchestrator (single parent → per-program children → housekeeping)
- Program auto-detection from source paths
- Vault artifacts with rich analysis data
- Global training for non-DCC content
- Keyword extraction from project analysis
- Port fallback for ghost sockets
- Job re-guide endpoint

## What Needs Redesign
1. **Skill content** → short summary only, not embedded analysis
2. **Skill references** → add `playbooks[]` and `relatedSkills[]` fields
3. **Skill loading at runtime** → spawner loads referenced playbooks when injecting skills
4. **Housekeeping** → creates skills from job patterns, links related skills
5. **Admin/Client UI** → navigable knowledge graph, not flat list
6. **No hardcoded paths** → all vault references relative to coordinator-playbooks dir

## Test Sources
- `W:\AGENT_REPO\Houdini\FLIP drop object` — Houdini FLIP sim
- `W:\AGENT_REPO\Houdini\simplefireball_XPU` — Houdini pyro
- `Z:\ASSETS\Megascans\Downloaded\surface` — PBR textures (global/program-agnostic)

## Build & Run
```bash
cd "C:\Users\timvanhelsdingen\Documents\Github\arkestrator\.claude\worktrees\admiring-hawking"
pnpm --filter @arkestrator/protocol build
pnpm --filter @arkestrator/admin build
xcopy /E /Y admin\dist\* client\resources\admin-dist\
pnpm --filter @arkestrator/client tauri dev
```
