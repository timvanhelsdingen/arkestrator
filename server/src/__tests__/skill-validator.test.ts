import { describe, expect, it } from "bun:test";
import { validateSkill, previewSkillInjection } from "../skills/skill-validator.js";
import type { Skill } from "../db/skills.repo.js";

describe("skill-validator", () => {
  describe("validateSkill", () => {
    it("passes a valid skill", () => {
      const result = validateSkill({
        title: "Pyro Effects",
        slug: "pyro-effects",
        category: "houdini",
        content: "Use the pyro solver for fire and smoke effects. Set voxel size based on scene scale.",
        keywords: ["pyro", "fire", "smoke"],
      });
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("flags empty content as error", () => {
      const result = validateSkill({
        title: "Empty",
        slug: "empty",
        category: "test",
        content: "",
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.field === "content" && i.severity === "error")).toBe(true);
    });

    it("flags very short content as warning", () => {
      const result = validateSkill({
        title: "Short",
        slug: "short",
        category: "test",
        content: "Hi",
      });
      expect(result.valid).toBe(true); // warning, not error
      expect(result.issues.some((i) => i.field === "content" && i.severity === "warning")).toBe(true);
    });

    it("flags empty title as error", () => {
      const result = validateSkill({
        title: "",
        slug: "test",
        category: "test",
        content: "Some valid content here",
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.field === "title")).toBe(true);
    });

    it("catches invalid regex in keywords", () => {
      const result = validateSkill({
        title: "Test",
        slug: "test",
        category: "test",
        content: "Valid content here enough chars",
        keywords: ["valid", "[unclosed(bracket"],
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.field === "keywords" && i.severity === "error")).toBe(true);
    });

    it("accepts valid regex in keywords", () => {
      const result = validateSkill({
        title: "Test",
        slug: "test",
        category: "test",
        content: "Valid content here enough chars",
        keywords: ["pyro|fire", "sim.*effect", "\\brender\\b"],
      });
      expect(result.valid).toBe(true);
    });

    it("detects always/never contradiction", () => {
      const result = validateSkill({
        title: "Contradictory",
        slug: "test",
        category: "test",
        content: "Always use the pyro solver. Never use the pyro solver for simple effects.",
      });
      expect(result.issues.some((i) => i.message.includes("contradiction"))).toBe(true);
    });
  });

  describe("previewSkillInjection", () => {
    const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
      id: "test-id",
      name: "test",
      slug: "test",
      program: "houdini",
      category: "general",
      title: "Pyro Effects Guide",
      description: "How to use pyro in Houdini",
      keywords: ["pyro"],
      content: "Use the pyro solver with XPU for faster sims.",
      playbooks: [],
      relatedSkills: [],
      source: "training",
      sourcePath: null,
      priority: 50,
      autoFetch: false,
      enabled: true,
      version: 1,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      ...overrides,
    });

    it("injects for matching program", () => {
      const result = previewSkillInjection(makeSkill(), "houdini");
      expect(result.injected).toBe(true);
      expect(result.preview).toContain("Pyro Effects Guide");
      expect(result.preview).toContain("XPU");
    });

    it("injects global skills for any program", () => {
      const result = previewSkillInjection(makeSkill({ program: "global" }), "blender");
      expect(result.injected).toBe(true);
    });

    it("rejects mismatched program", () => {
      const result = previewSkillInjection(makeSkill({ program: "blender" }), "houdini");
      expect(result.injected).toBe(false);
      expect(result.reason).toContain("does not match");
    });

    it("rejects disabled skill", () => {
      const result = previewSkillInjection(makeSkill({ enabled: false }), "houdini");
      expect(result.injected).toBe(false);
      expect(result.reason).toContain("disabled");
    });
  });
});
