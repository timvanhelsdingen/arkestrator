# Post-mortem: SQLite corruption from agent cwd pointing at user home dir

**Date:** 2026-04-11
**Severity:** High — `server/data/db/arkestrator.db` corrupted on every multi-agent parallel job run, `database disk image is malformed` thrown from skills/housekeeping/jobs routes, reproducible.
**Resolution:** Root-caused + fixed in `server/src/workspace/resolver.ts` (see **Real root cause** and **Fix** below). Wipe-and-restart is no longer needed — the server now refuses to put agents into a cwd that contains the live DB.
**Impact:** Local dev only. No production data touched.

> **Note on v1 of this doc:** An earlier version of this post-mortem blamed the corruption on a Windows `taskkill /F` + cross-process WAL race during a worktree cutover. That theory was **wrong**. The cutover accelerated the incident but the real root cause is entirely inside the server code — the resolver was handing agents a cwd that contained the live SQLite file, and parallel `claude` CLI subprocesses indexing that tree corrupted it. Sections below are rewritten against that finding.

## Symptoms

Two independent symptoms surfaced during a live validation run:

1. `POST /api/settings/housekeeping/run-now` → HTTP 500, server log:
   ```
   [ERROR] [http] Unhandled error on POST /api/settings/housekeeping/run-now: database disk image is malformed
   ```
2. Out-of-process reads via the Python `sqlite3` module returned:
   ```
   sqlite3.OperationalError: disk I/O error
   sqlite3.OperationalError: database disk image is malformed
   sqlite3.OperationalError: file is not a database
   ```

With the server stopped, `PRAGMA integrity_check` reported:

```
*** in database main ***
Tree 40 page 40: btreeInitPage() returns error code 11
Tree 47 page 47: btreeInitPage() returns error code 11
... (19 tree pages with btreeInitPage error 11)
Tree 4 page 125 cell 0: overflow list length is 1 but should be 14
Tree 4 page 123 cell 1: overflow list length is 1 but should be 48
wrong # of entries in index sqlite_autoindex_worker_bridges_1
wrong # of entries in index sqlite_autoindex_skills_2
wrong # of entries in index sqlite_autoindex_skills_1
wrong # of entries in index sqlite_autoindex_workers_1
Page 99: never used
... (80+ orphaned pages marked "never used")
```

The db file itself was still identified as a valid SQLite header by `file(1)` — 225 total pages, page size 4096, WAL mode — so the damage was internal btree corruption, not header truncation.

## Timeline (local time, 2026-04-11)

1. **~09:15** — Main repo's desktop `pnpm dev` is running. A single `concurrently` process tree owns both the Tauri client and a `bun --watch src/index.ts` server (PIDs 49012 parent, 21488 child, both inside `C:/Users/timvanhelsdingen/Documents/Github/arkestrator/server`).
2. **~10:05** — As part of a validation sweep I needed the server to run **my worktree's code** (with the locked-flag fix applied), but pointed at main's data directory so live bridges / workers / skills carried over. I killed PID 21488 with `taskkill /F` (parent 49012 had already exited by the time I checked, possibly auto-dropped).
3. **~10:05** — Started a second `bun --watch src/index.ts` from `.claude/worktrees/nifty-allen/server/` with `DATA_DIR="C:/.../server/data"`. Desktop Tauri client (still alive) reconnected its bridges to the new server on port 7800.
4. **~10:13** — `bun --watch` reloaded after I edited `server/src/mcp/tool-server.ts` for the `create_skill` lock guard. The reloaded server wrote new WAL frames during a series of REST and MCP write calls (skill lock/unlock, create/update, agent job runs, effectiveness rows).
5. **~10:21** — `POST /api/settings/housekeeping/run-now` returned the first `database disk image is malformed` error. Every subsequent call returned the same.
6. **~12:21** — The DB file was last written to by the server (`.db` mtime) but subsequent out-of-process Python reads alternated between `disk I/O error`, `database disk image is malformed`, and `file is not a database`.
7. **~13:07** — Server stopped for post-mortem. `PRAGMA integrity_check` executed cleanly against the file and returned the btree-error output shown above.

## Real root cause (v2 — reproduced and patched)

The incident reproduced cleanly on a **freshly wiped DB with a single `bun` process and no out-of-process readers**, which falsified the v1 "two writers" theory. The real chain is entirely inside the server code:

1. The Blender bridge on worker `tvh-13900k` was in an "Untitled" session with no `.blend` file loaded. When a bridge has no project, it reports `projectPath` as the best-guess fallback — in this case `C:/Users/timvanhelsdingen` (the user's Windows home directory).
2. The worker row in `workers` persists that `lastProjectPath`. Future job submissions with `targetWorkerName: tvh-13900k` and no `editorContext.projectRoot` get enriched by `server/src/queue/worker.ts:236-250`:
   ```ts
   enrichedJob = { ...job, editorContext: { ...job.editorContext, projectRoot: worker.lastProjectPath } };
   ```
   → the job now has `projectRoot = C:/Users/timvanhelsdingen`.
3. `server/src/workspace/resolver.ts` step 5 (`project_root_exists_locally`) unconditionally accepts any `projectRoot` that exists on the server filesystem. `C:/Users/timvanhelsdingen` exists, so the resolver returns:
   ```ts
   { mode: "repo", cwd: "C:/Users/timvanhelsdingen", ... }
   ```
4. `spawner.ts` launches `claude --dangerously-skip-permissions ...` with that cwd. Claude Code treats its cwd as the workspace root and indexes it (reads files to build context, possibly writes cache files). **The cwd `C:/Users/timvanhelsdingen` contains `C:/Users/timvanhelsdingen/Documents/Github/arkestrator/server/data/db/arkestrator.db`** — i.e. the live SQLite file the server is actively writing to.
5. When multiple parallel agent jobs run simultaneously (4 jobs in the first incident, 4 jobs in the reproducer including §4/§5/§7/§9), each `claude` subprocess walks the same home directory tree in parallel. The server's own writes to `arkestrator.db` race against the agents' incidental file-system activity on the same path. Windows file handles + `bun:sqlite`'s WAL shared-memory assumptions break under this race and the btree writes land on mis-linked pages.

### Evidence

- Server log for the reproducer (fresh-DB run 2):
  ```
  [worker] Injected projectRoot "C:/Users/timvanhelsdingen" from worker "tvh-13900k" for job cf8afecb-...
  [resolver] Job cf8afecb-...: projectRoot exists locally → repo mode (C:/Users/timvanhelsdingen)
  [spawner] Job cf8afecb-...: workspace mode = repo, cwd = C:/Users/timvanhelsdingen, step = 5 (project_root_exists_locally)
  [WARN] [spawner] Job cf8afecb-...: workspace resolution reached fallback step 5 (project_root_exists_locally). Validate project mapping/bridge metadata to avoid unintended mode selection.
  ```
  (That `[WARN]` was already there to flag this as "risky", but nothing actually blocked it.)
- 20 seconds after the four parallel jobs dispatched: `[ERROR] Unhandled error on GET /api/jobs/cf8afecb-...: database disk image is malformed` — 58 occurrences in the log.
- The housekeeping agent inside its own job output:
  > `database is consistently returning "database disk image is malformed"... 3 concurrent test jobs are currently running that appear to be stress-testing the skill system`
- The corruption pattern (19 tree pages with `btreeInitPage error 11`, wrong entry counts on exactly the tables the spawner was writing to) is consistent with multi-process contention on the same file, not with single-process WAL replay.

## What did **not** cause this

- **Not two writers / cross-process WAL race.** Reproducer used a single `bun` process on a freshly-wiped DB with no out-of-process sqlite3 readers. Still corrupted.
- **Not `taskkill /F`.** The reproducer had no taskkill, no cutover, no restart — clean `bun --watch` lifecycle.
- **Not Part A/B/C code.** All the locked-flag / picker / filter-bar edits only touch route/UI code; none of them widen the workspace resolver's trust boundary.

## Fix (v2 — lands the guard in code)

**File:** `server/src/workspace/resolver.ts`

Introduced `isUnsafeRepoCwd(candidate, serverDataDir)` and call it inside the step-5 branch. The guard refuses to return `mode: "repo"` if the candidate `cwd`:
1. resolves to the user's home directory (`os.homedir()`), OR
2. contains the server's `dataDir` as a descendant (i.e. the agent's filesystem access would include the live `arkestrator.db`).

When the guard fires it logs `[WARN] [resolver] Job <id>: refusing repo mode at <path> — <reason>. Falling through to sync/command mode.` and the resolver continues to step 6 (sync, if attached files) or step 7 (command mode in the server dir, the safe default).

**Regression tests:** `server/src/__tests__/resolver.test.ts` — three new cases:
- `refuses repo mode when projectRoot is the user home directory`
- `refuses repo mode when projectRoot contains the server data dir`
- `allows repo mode for a legitimate project directory`

All three pass. Full suite: 382 pass / 2 skip / 1 pre-existing unrelated fail.

**End-to-end verification:** after the fix, re-ran the exact scenario that corrupted the DB twice (4 parallel agent jobs under a worker whose `lastProjectPath` is still `C:/Users/timvanhelsdingen`). The resolver guard fires, every job drops to command mode in the server cwd, and the DB comes out clean — `grep -c "database disk image is malformed" /tmp/ark_server.log` = **0** (previously 58).

Also added (defense in depth — see `server/src/db/database.ts`):
- Boot-time `PRAGMA integrity_check` inside `openDatabase()`. If the check returns non-`ok` or throws, quarantine the file as `*.invalid-<timestamp>` (main + any `-wal`/`-shm` companions) and create a fresh db. This catches "openable but internally broken" files that the pre-existing format-only guard missed. Tested via `server/src/__tests__/database-integrity-quarantine.test.ts`.

## Prevention (landed this incident)

1. **Worker-side sanitisation of `lastProjectPath`.** **Landed.** `WorkersRepo.upsert` now calls `sanitizeLastProjectPath()` from `utils/project-path.ts` before every INSERT/UPDATE. Rejected paths log a WARN (`Dropping unsafe lastProjectPath for worker <name>: <reason>`) and the existing row value is preserved via `COALESCE`, so a worker that once had a valid project doesn't silently regress to home when a bridge later reports garbage. Rules: home dir, filesystem roots, `/Users`, `/home`, `/root`, `/var`, `/etc`, `/tmp`, `C:\Users`, `C:\Program Files*`, `C:\ProgramData`, `C:\Windows`. Verified live: blender bridge heartbeats kept re-inserting home dir, sanitiser dropped every attempt, worker row stayed clean, next parallel agent run landed at step 3 (`missing_project_root`) instead of step 5 (`project_root_exists_locally`). Regression tests: `src/__tests__/project-path.test.ts`, `src/__tests__/workers-repo-project-path.test.ts`.
2. **Resolver step 5 requires a project marker file.** **Landed.** `resolver.ts` now calls `hasProjectMarker()` after the `isUnsafeRepoCwd` guard. A candidate directory must contain at least one of: `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`, `CMakeLists.txt`, `Makefile`, `project.godot`, `arkestrator.coordinator.json`, `.arkestrator/`, `.vscode/`, `.idea/`, or any file ending in `.blend`, `.hip`, `.hiplc`, `.hipnc`, `.ma`, `.mb`, `.max`, `.c4d`, `.unity`, `.uproject`. Bare directories fall through to sync/command mode. Regression tests: 3 new cases in `src/__tests__/resolver.test.ts` (bare dir rejected, DCC `.blend` accepted, `package.json` accepted).
3. **Boot-time `PRAGMA integrity_check`.** **Landed.** `openDatabase()` now runs `PRAGMA integrity_check` after opening and before migrations. Non-`ok` (or thrown) results quarantine the main file + `-wal`/`-shm` companions as `*.invalid-<timestamp>` and create a fresh DB. Regression tests: `src/__tests__/database-integrity-quarantine.test.ts`. This catches any future "openable but broken" failures that slip past the other two layers.
4. **Spawner should sandbox the agent process's filesystem scope.** Not landed. Long-term — Bun has no built-in sandbox so this would be Windows-AppContainer / Unix-bind-mount territory. Tracked in `PROJECT_PLAN.md → Pending`.
5. **Premium tier: automatic cloud backups with point-in-time restore.** Tracked in `PROJECT_PLAN.md → Pending`. Makes any future corruption incident recoverable instead of forcing a wipe.

### End-to-end validation after the fix

Three parallel complex agent jobs (blender + houdini + comfyui), each targeting worker `tvh-13900k` whose old `lastProjectPath` was the home directory:

- Round 1 (resolver guard only): `refusing repo mode at C:/Users/timvanhelsdingen` fired, jobs dropped to step 4 `bridge_program_command_default`, all 3 completed, malformed count = 0.
- Round 2 (sanitiser active, legacy row cleared): `workspace mode = command, step = 3 (missing_project_root)` — sanitiser prevented re-injection entirely, all 3 completed, `PRAGMA integrity_check: ok`, malformed count = 0.

Both runs created per-bridge skills with correct `program` fields. Zero DB corruption across both runs (previously 58+ malformed errors inside a single run).

## Operator instructions (if this recurs on an older server without the fix)

1. Stop the server.
2. `cp server/data/db/arkestrator.db* /tmp/ark_db_corrupt_backup/` to preserve the evidence.
3. `rm server/data/db/arkestrator.db*`.
4. Restart. The db will re-seed; 21 default skills reload from `server/data/skills/`; default admin is `admin` / `admin`.
5. Log in, create your agent configs from templates, re-connect bridges. Worker rules + non-seeded settings are lost.
6. Update the server to a revision that contains the resolver guard so it cannot happen again.

## Appendix: commands used for diagnosis

```bash
# File-level sanity
file server/data/db/arkestrator.db
ls -la server/data/db/arkestrator.db*

# Structural integrity (server MUST be stopped first)
python3 -c "
import sqlite3
c = sqlite3.connect('server/data/db/arkestrator.db', timeout=10)
print(c.execute('PRAGMA integrity_check').fetchall())
"

# Backup before wipe
cp server/data/db/arkestrator.db* /tmp/ark_db_corrupt_backup/

# Wipe
rm server/data/db/arkestrator.db server/data/db/arkestrator.db-shm server/data/db/arkestrator.db-wal
```
