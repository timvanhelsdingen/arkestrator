/**
 * Tests for `utils/project-path.ts` — the sanitiser + marker check
 * added after the 2026-04-11 DB corruption incident (see
 * `docs/reports/2026-04-11-db-corruption-postmortem.md`).
 *
 * Together with the resolver step-5 guard (`isUnsafeRepoCwd`) these
 * close the "agent cwd contains the live DB" corruption vector at
 * two separate layers: the sanitiser refuses to *persist* sentinel
 * `lastProjectPath` values on worker rows, and `hasProjectMarker`
 * refuses to *accept* bare directories as project roots even if
 * they happen to exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, parse as parsePath } from "path";
import { hasProjectMarker, sanitizeLastProjectPath } from "../utils/project-path.js";

describe("sanitizeLastProjectPath", () => {
  it("rejects empty / null / undefined", () => {
    expect(sanitizeLastProjectPath(undefined).ok).toBe(false);
    expect(sanitizeLastProjectPath(null).ok).toBe(false);
    expect(sanitizeLastProjectPath("").ok).toBe(false);
    expect(sanitizeLastProjectPath("   ").ok).toBe(false);
  });

  it("rejects the user home directory", () => {
    const res = sanitizeLastProjectPath(homedir());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("home directory");
  });

  it("rejects a filesystem root", () => {
    // Use the platform-appropriate root by asking node.path.
    const root = parsePath(process.cwd()).root;
    const res = sanitizeLastProjectPath(root);
    expect(res.ok).toBe(false);
  });

  it("accepts a legitimate project path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-sanitize-accept-"));
    try {
      const res = sanitizeLastProjectPath(dir);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.path.length).toBeGreaterThan(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("trims whitespace before checking", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-sanitize-trim-"));
    try {
      const res = sanitizeLastProjectPath(`  ${dir}  `);
      expect(res.ok).toBe(true);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe("hasProjectMarker", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ark-marker-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns false for a bare directory with no markers", () => {
    expect(hasProjectMarker(dir)).toBe(false);
  });

  it("returns false for a non-existent path", () => {
    expect(hasProjectMarker(join(dir, "does-not-exist"))).toBe(false);
  });

  it("detects .git directory", () => {
    mkdirSync(join(dir, ".git"));
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("detects package.json", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("detects pyproject.toml", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]");
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("detects arkestrator.coordinator.json", () => {
    writeFileSync(join(dir, "arkestrator.coordinator.json"), "{}");
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("detects a .blend file (DCC project)", () => {
    writeFileSync(join(dir, "scene.blend"), "");
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("detects a .hip file (Houdini project)", () => {
    writeFileSync(join(dir, "untitled.hip"), "");
    expect(hasProjectMarker(dir)).toBe(true);
  });

  it("returns false when a file is present but it is not a marker", () => {
    writeFileSync(join(dir, "random.txt"), "hello");
    expect(hasProjectMarker(dir)).toBe(false);
  });
});
