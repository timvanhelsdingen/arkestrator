import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "./migrations.js";
import { logger } from "../utils/logger.js";

function isRecoverableSqliteFormatError(error: unknown): boolean {
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? "").toLowerCase();
  return msg.includes("unsupported file format") || msg.includes("file is not a database");
}

function quarantineInvalidDatabase(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.invalid-${stamp}`;
  renameSync(dbPath, backupPath);
  // Also move any companion WAL/SHM files so the fresh DB doesn't replay
  // frames from the corrupted one.
  for (const suffix of ["-wal", "-shm"]) {
    const companion = `${dbPath}${suffix}`;
    if (existsSync(companion)) {
      try {
        renameSync(companion, `${backupPath}${suffix}`);
      } catch {
        // best-effort — a leftover wal/shm against a renamed main file is
        // already harmless because sqlite keys them by the main filename.
      }
    }
  }
  return backupPath;
}

/**
 * Structural integrity check.
 *
 * Plain `new Database(dbPath)` only traps obvious header corruption
 * ("file is not a database"). A database can open AND run migrations
 * AND still have mis-linked btree pages — e.g. when two bun processes
 * briefly write against the same WAL file on Windows during a
 * `taskkill /F` + restart sequence. That's exactly the incident on
 * 2026-04-11 (see `docs/reports/2026-04-11-db-corruption-postmortem.md`):
 * 19 tree pages with `btreeInitPage() returns error code 11`, wrong
 * entry counts on UNIQUE autoindexes, 80+ orphaned pages — and every
 * subsequent write threw "database disk image is malformed" at random
 * code paths like housekeeping, poisoning the server for hours.
 *
 * Running `PRAGMA integrity_check` at boot catches this early so the
 * server quarantines the bad file and starts fresh instead of limping
 * along with half-working routes.
 */
function runIntegrityCheck(db: Database): string | null {
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<Record<string, string>>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const first = rows[0];
    const value = first && typeof first === "object" ? Object.values(first)[0] : String(first);
    if (typeof value === "string" && value.toLowerCase() === "ok") return null;
    return rows
      .map((r) => {
        if (r && typeof r === "object") return String(Object.values(r)[0] ?? "");
        return String(r);
      })
      .filter(Boolean)
      .slice(0, 10)
      .join("; ");
  } catch (err) {
    return `integrity_check threw: ${String((err as { message?: unknown })?.message ?? err)}`;
  }
}

export function openDatabase(dbPath: string): Database {
  // Ensure the directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    logger.info("database", `Opened database at ${dbPath}`);

    const integrityError = runIntegrityCheck(db);
    if (integrityError) {
      // File is openable but structurally broken. Close, quarantine, and
      // fall through to the fresh-db path below.
      try { db.close(false); } catch { /* best-effort */ }
      db = null;
      const backupPath = quarantineInvalidDatabase(dbPath);
      logger.error(
        "database",
        `Structural corruption detected at ${dbPath} (integrity_check failed). Moved to ${backupPath} and starting fresh. Errors: ${integrityError}`,
      );
      const recovered = new Database(dbPath);
      logger.info("database", `Opened recovered database at ${dbPath}`);
      runMigrations(recovered);
      logger.info("database", "Migrations complete");
      return recovered;
    }

    runMigrations(db);
    logger.info("database", "Migrations complete");
    return db;
  } catch (error) {
    if (!isRecoverableSqliteFormatError(error)) throw error;
    try {
      db?.close(false);
    } catch {
      // best-effort close before moving corrupted file
    }
    const backupPath = quarantineInvalidDatabase(dbPath);
    logger.warn(
      "database",
      `Invalid SQLite format detected at ${dbPath}. Moved to ${backupPath} and creating a fresh database.`,
    );
    const recovered = new Database(dbPath);
    logger.info("database", `Opened recovered database at ${dbPath}`);
    runMigrations(recovered);
    logger.info("database", "Migrations complete");
    return recovered;
  }
}
