import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "fs";
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
  return backupPath;
}

export function openDatabase(dbPath: string): Database {
  // Ensure the directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    logger.info("database", `Opened database at ${dbPath}`);
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
