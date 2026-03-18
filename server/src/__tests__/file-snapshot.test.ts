import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPaths, startWatching } from "../agents/file-snapshot.js";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

describe("file snapshot watcher", () => {
  test("reports text, binary, symlink and delete changes", async () => {
    const root = makeTempDir("arkestrator-snapshot-");
    const textPath = join(root, "note.txt");
    const deletedPath = join(root, "remove_me.txt");
    writeFileSync(textPath, "before", "utf-8");
    writeFileSync(deletedPath, "gone soon", "utf-8");

    const before = await collectPaths(root);
    const watcher = startWatching(root);

    writeFileSync(textPath, "after", "utf-8");
    writeFileSync(join(root, "sample.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    unlinkSync(deletedPath);

    const symlinkSupported = process.platform !== "win32";
    if (symlinkSupported) {
      symlinkSync("note.txt", join(root, "note_link"));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    watcher.stop();

    const changes = await watcher.getChanges(before);
    const byPath = new Map(changes.map((c) => [c.path, c]));

    expect(byPath.get("note.txt")?.action).toBe("modify");
    expect(byPath.get("note.txt")?.content).toBe("after");

    expect(byPath.get("sample.bin")?.action).toBe("create");
    expect(byPath.get("sample.bin")?.content).toContain("[binary]");

    expect(byPath.get("remove_me.txt")?.action).toBe("delete");

    if (symlinkSupported) {
      expect(byPath.get("note_link")?.action).toBe("create");
      expect(byPath.get("note_link")?.content).toContain("[symlink]");
    }
  });
});
