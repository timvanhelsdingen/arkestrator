/**
 * Tests for the skills-as-knowledge-graph feature:
 * - Skills store playbook references and related skill links
 * - Spawner loads playbook artifacts when injecting skills
 * - Housekeeping parses playbooks/related_skills from skill blocks
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrations.js";
import { SkillsRepo } from "../db/skills.repo.js";
import { processHousekeepingOutput } from "../agents/housekeeping.js";

describe("skills knowledge graph", () => {
  let db: Database;
  let skillsRepo: SkillsRepo;
  let playbooksDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    skillsRepo = new SkillsRepo(db);
    playbooksDir = mkdtempSync(join(tmpdir(), "am-skills-playbooks-"));
  });

  afterEach(() => {
    db.close();
    rmSync(playbooksDir, { recursive: true, force: true });
  });

  it("stores and retrieves playbook references on a skill", () => {
    const skill = skillsRepo.create({
      name: "FLIP Simulation",
      slug: "project-houdini-flip-sim",
      program: "houdini",
      category: "project-reference",
      title: "FLIP Simulation — houdini project reference",
      description: "SOP-level FLIP fluid sim with object drop",
      content: "# FLIP Simulation\n**Program:** houdini\nShort summary.",
      playbooks: ["_learning/jobs/houdini/flip-sim--abc/analysis.json"],
      relatedSkills: ["particle-systems", "viscosity-setup"],
      source: "training",
    });

    expect(skill.playbooks).toEqual(["_learning/jobs/houdini/flip-sim--abc/analysis.json"]);
    expect(skill.relatedSkills).toEqual(["particle-systems", "viscosity-setup"]);
    expect(skill.content.length).toBeLessThan(200); // Short, not embedded analysis
  });

  it("upserts preserve playbook references", () => {
    skillsRepo.upsertBySlugAndProgram({
      name: "Test Skill",
      slug: "test-skill",
      program: "houdini",
      category: "project-reference",
      title: "Test Skill",
      content: "Short summary v1",
      playbooks: ["_learning/jobs/houdini/test/analysis.json"],
      relatedSkills: ["other-skill"],
      source: "training",
    });

    // Upsert again with updated playbooks
    skillsRepo.upsertBySlugAndProgram({
      name: "Test Skill",
      slug: "test-skill",
      program: "houdini",
      category: "project-reference",
      title: "Test Skill v2",
      content: "Short summary v2",
      playbooks: [
        "_learning/jobs/houdini/test/analysis.json",
        "_learning/jobs/houdini/test2/analysis.json",
      ],
      relatedSkills: ["other-skill", "new-skill"],
      source: "training",
    });

    const skill = skillsRepo.get("test-skill", "houdini");
    expect(skill).not.toBeNull();
    expect(skill!.playbooks).toHaveLength(2);
    expect(skill!.relatedSkills).toEqual(["other-skill", "new-skill"]);
    expect(skill!.title).toBe("Test Skill v2");
  });

  it("update() sets playbooks and relatedSkills", () => {
    skillsRepo.create({
      name: "Base Skill",
      slug: "base-skill",
      program: "global",
      category: "custom",
      title: "Base Skill",
      content: "Some content",
    });

    const updated = skillsRepo.update("base-skill", {
      playbooks: ["_learning/jobs/global/test/analysis.json"],
      relatedSkills: ["linked-skill"],
    }, "global");

    expect(updated).not.toBeNull();
    expect(updated!.playbooks).toEqual(["_learning/jobs/global/test/analysis.json"]);
    expect(updated!.relatedSkills).toEqual(["linked-skill"]);
  });

  it("defaults to empty arrays when playbooks/relatedSkills not provided", () => {
    const skill = skillsRepo.create({
      name: "No Refs",
      slug: "no-refs",
      program: "global",
      category: "custom",
      title: "No Refs",
      content: "Content without references",
    });

    expect(skill.playbooks).toEqual([]);
    expect(skill.relatedSkills).toEqual([]);
  });

  it("housekeeping parses playbooks and related_skills from skill blocks", async () => {
    const output = `
## Analysis

Some analysis text here.

\`\`\`skill
slug: flip-fluid-guide
program: houdini
category: training
title: FLIP Fluid Simulation Guide
playbooks: _learning/jobs/houdini/flip-sim/analysis.json, _learning/jobs/houdini/flip-drop/analysis.json
related_skills: particle-systems, viscosity-setup
---
Short description of FLIP fluid workflows in Houdini.
\`\`\`

## Recommendations
Keep training on more FLIP examples.
`;

    const result = await processHousekeepingOutput(output, skillsRepo);
    expect(result.created).toBe(1);

    const skill = skillsRepo.get("flip-fluid-guide", "houdini");
    expect(skill).not.toBeNull();
    expect(skill!.playbooks).toEqual([
      "_learning/jobs/houdini/flip-sim/analysis.json",
      "_learning/jobs/houdini/flip-drop/analysis.json",
    ]);
    expect(skill!.relatedSkills).toEqual(["particle-systems", "viscosity-setup"]);
    expect(skill!.content).toContain("FLIP fluid workflows");
  });

  it("housekeeping updates existing skill with playbook refs", async () => {
    // Create existing skill without playbooks
    skillsRepo.create({
      name: "Existing",
      slug: "existing-skill",
      program: "houdini",
      category: "training",
      title: "Existing Skill",
      content: "Old content",
      source: "housekeeping",
    });

    const output = `
\`\`\`skill
slug: existing-skill
program: houdini
category: training
title: Updated Existing Skill
playbooks: _learning/jobs/houdini/new-analysis/analysis.json
related_skills: new-related-skill
---
Updated content with new analysis.
\`\`\`
`;

    const result = await processHousekeepingOutput(output, skillsRepo);
    expect(result.updated).toBe(1);

    const skill = skillsRepo.get("existing-skill", "houdini");
    expect(skill!.playbooks).toEqual(["_learning/jobs/houdini/new-analysis/analysis.json"]);
    expect(skill!.relatedSkills).toEqual(["new-related-skill"]);
    expect(skill!.content).toContain("Updated content");
  });

  it("spawner-style playbook loading reads JSON artifacts correctly", () => {
    // Simulate what the spawner does: resolve playbook path and read the artifact
    const artifactDir = join(playbooksDir, "_learning", "jobs", "houdini", "flip-sim--abc");
    mkdirSync(artifactDir, { recursive: true });

    const artifact = {
      version: 1,
      source: "coordinator_training_job",
      job: { id: "test-job", program: "houdini" },
      summaries: [
        { name: "FLIP drop object", path: "W:\\AGENT_REPO\\Houdini\\FLIP drop object", summary: "SOP-level FLIP fluid sim" },
      ],
      projects: [
        {
          projectName: "FLIP drop object",
          projectPath: "W:\\AGENT_REPO\\Houdini\\FLIP drop object",
          notesExcerpt: "## Node Graph\n- FLIP Solver: viscosity=0.5, substeps=3\n- Object Merge: /obj/falling_box\n- Particle Fluid Surface: adaptivity=0.2",
          config: { prompt: "Use Cd attribute for color transfer between fluids" },
        },
      ],
      notes: ["Viscosity range 0.1-1.0 gives good results for water-like fluids"],
    };

    writeFileSync(join(artifactDir, "analysis.json"), JSON.stringify(artifact, null, 2), "utf-8");

    // Create skill with playbook reference
    const skill = skillsRepo.create({
      name: "FLIP Sim",
      slug: "flip-sim",
      program: "houdini",
      category: "project-reference",
      title: "FLIP Simulation",
      description: "FLIP fluid sim",
      content: "Short summary only",
      playbooks: ["_learning/jobs/houdini/flip-sim--abc/analysis.json"],
      source: "training",
    });

    // Simulate spawner loading logic
    const { existsSync, readFileSync } = require("fs");
    const pbPath = skill.playbooks[0];
    const fullPath = join(playbooksDir, pbPath);
    expect(existsSync(fullPath)).toBe(true);

    const raw = readFileSync(fullPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Verify the spawner can extract useful content
    expect(parsed.summaries[0].summary).toContain("FLIP");
    expect(parsed.projects[0].notesExcerpt).toContain("Node Graph");
    expect(parsed.projects[0].notesExcerpt).toContain("FLIP Solver");
    expect(parsed.projects[0].config.prompt).toContain("Cd attribute");
    expect(parsed.notes[0]).toContain("Viscosity");
  });
});
