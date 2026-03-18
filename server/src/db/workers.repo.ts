import { Database } from "bun:sqlite";
import type { Worker } from "@arkestrator/protocol";
import { newId } from "../utils/id.js";

interface WorkerRow {
  id: string;
  machine_id: string | null;
  name: string;
  last_program: string | null;
  last_project_path: string | null;
  last_ip: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface WorkerBridgeRow {
  id: string;
  worker_name: string;
  worker_machine_id: string | null;
  program: string;
  program_version: string | null;
  bridge_version: string | null;
  project_path: string | null;
  last_seen_at: string;
}

function rowToWorker(row: WorkerRow, knownPrograms: string[] = []): Worker {
  return {
    id: row.id,
    machineId: row.machine_id ?? undefined,
    name: row.name,
    status: "offline", // Caller enriches from live WS data
    lastProgram: row.last_program ?? undefined,
    lastProjectPath: row.last_project_path ?? undefined,
    lastIp: row.last_ip ?? undefined,
    activeBridgeCount: 0, // Caller enriches from live WS data
    knownPrograms,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class WorkersRepo {
  private insertStmt;
  private updateStmt;
  private getByIdStmt;
  private getByMachineIdStmt;
  private getByNameStmt;
  private listStmt;
  private listWithBridgesStmt;
  private touchByIdStmt;
  private deleteStmt;
  private deleteDuplicateMachineIdStmt;
  private migrateBridgeIdentityStmt;
  private upsertBridgeByNameStmt;
  private upsertBridgeStmt;
  private getBridgeByMachineStmt;
  private updateBridgeByIdStmt;
  private insertBridgeByMachineStmt;
  private getBridgesForWorkerStmt;
  private deleteBridgesForWorkerStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO workers (id, machine_id, name, last_program, last_project_path, last_ip, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE workers
       SET machine_id = COALESCE(?, machine_id),
           name = ?,
           last_program = COALESCE(?, last_program),
           last_project_path = COALESCE(?, last_project_path),
           last_ip = COALESCE(?, last_ip),
           last_seen_at = ?
       WHERE id = ?`,
    );
    this.getByIdStmt = db.prepare(`SELECT * FROM workers WHERE id = ?`);
    this.getByMachineIdStmt = db.prepare(`SELECT * FROM workers WHERE machine_id = ?`);
    this.getByNameStmt = db.prepare(`SELECT * FROM workers WHERE name = ?`);
    this.listStmt = db.prepare(
      `SELECT * FROM workers ORDER BY last_seen_at DESC`,
    );
    this.listWithBridgesStmt = db.prepare(
      `SELECT w.*, GROUP_CONCAT(wb.program, ',') as known_programs
       FROM workers w
       LEFT JOIN worker_bridges wb
         ON (w.machine_id IS NOT NULL AND wb.worker_machine_id = w.machine_id)
         OR (w.machine_id IS NULL AND wb.worker_machine_id IS NULL AND wb.worker_name = w.name)
       GROUP BY w.id
       ORDER BY w.last_seen_at DESC`,
    );
    this.touchByIdStmt = db.prepare(
      `UPDATE workers SET last_seen_at = ? WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM workers WHERE id = ?`);
    this.deleteDuplicateMachineIdStmt = db.prepare(
      `DELETE FROM workers WHERE machine_id = ? AND id != ?`,
    );
    this.migrateBridgeIdentityStmt = db.prepare(
      `UPDATE worker_bridges
       SET worker_name = ?,
           worker_machine_id = COALESCE(?, worker_machine_id)
       WHERE worker_name = ?
          OR (? IS NOT NULL AND worker_machine_id = ?)`,
    );

    // Worker bridges (program history per worker)
    this.upsertBridgeByNameStmt = db.prepare(
      `INSERT INTO worker_bridges (id, worker_name, program, program_version, bridge_version, project_path, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worker_name, program) DO UPDATE SET
         program_version = COALESCE(excluded.program_version, worker_bridges.program_version),
         bridge_version = COALESCE(excluded.bridge_version, worker_bridges.bridge_version),
         project_path = COALESCE(excluded.project_path, worker_bridges.project_path),
         last_seen_at = excluded.last_seen_at`,
    );
    this.upsertBridgeStmt = this.upsertBridgeByNameStmt;
    this.getBridgeByMachineStmt = db.prepare(
      `SELECT * FROM worker_bridges WHERE worker_machine_id = ? AND program = ?`,
    );
    this.updateBridgeByIdStmt = db.prepare(
      `UPDATE worker_bridges
       SET worker_name = ?,
           worker_machine_id = ?,
           program_version = COALESCE(?, program_version),
           bridge_version = COALESCE(?, bridge_version),
           project_path = COALESCE(?, project_path),
           last_seen_at = ?
       WHERE id = ?`,
    );
    this.insertBridgeByMachineStmt = db.prepare(
      `INSERT INTO worker_bridges (id, worker_name, worker_machine_id, program, program_version, bridge_version, project_path, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getBridgesForWorkerStmt = db.prepare(
      `SELECT * FROM worker_bridges
       WHERE (? IS NOT NULL AND worker_machine_id = ?)
          OR (? IS NULL AND worker_machine_id IS NULL AND worker_name = ?)
       ORDER BY program`,
    );
    this.deleteBridgesForWorkerStmt = db.prepare(
      `DELETE FROM worker_bridges
       WHERE worker_name = (SELECT name FROM workers WHERE id = ?)
          OR worker_machine_id = (SELECT machine_id FROM workers WHERE id = ?)`,
    );
  }

  private normalizeName(name: string): string {
    return name.toLowerCase();
  }

  private normalizeMachineId(machineId?: string): string | undefined {
    const trimmed = String(machineId ?? "").trim().toLowerCase();
    return trimmed || undefined;
  }

  upsert(
    name: string,
    program?: string,
    projectPath?: string,
    ip?: string,
    machineId?: string,
  ): Worker {
    const normalizedName = this.normalizeName(name);
    const normalizedMachineId = this.normalizeMachineId(machineId);
    const now = new Date().toISOString();
    const existing = normalizedMachineId
      ? (this.getByMachineId(normalizedMachineId) ?? this.getByName(normalizedName))
      : this.getByName(normalizedName);

    if (existing) {
      // If we matched by machineId but the incoming name differs, another
      // worker record may already own that name.  Merge by deleting the
      // name-holder first so the UPDATE doesn't violate the UNIQUE constraint.
      if (existing.name !== normalizedName) {
        const nameHolder = this.getByName(normalizedName);
        if (nameHolder && nameHolder.id !== existing.id) {
          // Delete bridge records from the name-holder that would conflict
          // (same machine_id + program already exists on the surviving worker)
          try {
            this.migrateBridgeIdentityStmt.run(
              normalizedName,
              normalizedMachineId ?? existing.machineId ?? null,
              nameHolder.name,
              nameHolder.machineId ?? null,
              nameHolder.machineId ?? null,
            );
          } catch {
            // If migration fails due to UNIQUE on worker_bridges, just
            // delete the name-holder's bridges — the surviving worker
            // already has the correct bridge records.
            this.deleteBridgesForWorkerStmt.run(nameHolder.id, nameHolder.id);
          }
          this.deleteStmt.run(nameHolder.id);
        }
      }

      this.updateStmt.run(
        normalizedMachineId ?? null,
        normalizedName,
        program ?? null,
        projectPath ?? null,
        ip ?? null,
        now,
        existing.id,
      );
      try {
        this.migrateBridgeIdentityStmt.run(
          normalizedName,
          normalizedMachineId ?? existing.machineId ?? null,
          existing.name,
          normalizedMachineId ?? existing.machineId ?? null,
          normalizedMachineId ?? existing.machineId ?? null,
        );
      } catch {
        // If migration fails due to UNIQUE on worker_bridges (e.g. two bridge
        // records for the same program being merged), silently ignore — the
        // correct bridge records already exist for this worker.
      }
      // Remove any duplicate worker records that share the same machineId
      // (e.g. IP-derived fallback names from localhost, LAN, or IPv6)
      const effectiveMachineId = normalizedMachineId ?? existing.machineId;
      if (effectiveMachineId) {
        this.deleteDuplicateMachineIdStmt.run(effectiveMachineId, existing.id);
      }
      return this.getById(existing.id)!;
    }

    const id = newId();
    this.insertStmt.run(
      id,
      normalizedMachineId ?? null,
      normalizedName,
      program ?? null,
      projectPath ?? null,
      ip ?? null,
      now,
      now,
    );
    // Remove any duplicate worker records that share the same machineId
    if (normalizedMachineId) {
      this.deleteDuplicateMachineIdStmt.run(normalizedMachineId, id);
    }
    return this.getById(id)!;
  }

  getById(id: string): Worker | null {
    const row = this.getByIdStmt.get(id) as WorkerRow | null;
    if (!row) return null;
    const programs = this.getBridgesForWorker(row.name, row.machine_id ?? undefined).map((b) => b.program);
    return rowToWorker(row, programs);
  }

  getByMachineId(machineId: string): Worker | null {
    const normalizedMachineId = this.normalizeMachineId(machineId);
    if (!normalizedMachineId) return null;
    const row = this.getByMachineIdStmt.get(normalizedMachineId) as WorkerRow | null;
    if (!row) return null;
    const programs = this.getBridgesForWorker(row.name, row.machine_id ?? undefined).map((b) => b.program);
    return rowToWorker(row, programs);
  }

  getByName(name: string): Worker | null {
    const normalizedName = this.normalizeName(name);
    const row = this.getByNameStmt.get(normalizedName) as WorkerRow | null;
    if (!row) return null;
    const programs = this.getBridgesForWorker(normalizedName, row.machine_id ?? undefined).map((b) => b.program);
    return rowToWorker(row, programs);
  }

  list(): Worker[] {
    const rows = this.listWithBridgesStmt.all() as (WorkerRow & { known_programs: string | null })[];
    return rows.map((row) => {
      const programs = row.known_programs ? row.known_programs.split(",") : [];
      return rowToWorker(row, programs);
    });
  }

  touchLastSeen(name: string, machineId?: string) {
    const now = new Date().toISOString();
    const worker = this.normalizeMachineId(machineId)
      ? this.getByMachineId(machineId!)
      : this.getByName(name);
    if (!worker) return;
    this.touchByIdStmt.run(now, worker.id);
  }

  delete(id: string): boolean {
    // Also delete associated bridge records
    this.deleteBridgesForWorkerStmt.run(id, id);
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  // --- Worker bridge history ---

  upsertBridge(
    workerName: string,
    program: string,
    programVersion?: string,
    bridgeVersion?: string,
    projectPath?: string,
    machineId?: string,
  ) {
    const normalizedWorkerName = this.normalizeName(workerName);
    const normalizedMachineId = this.normalizeMachineId(machineId);
    const now = new Date().toISOString();
    if (normalizedMachineId) {
      const existing = this.getBridgeByMachineStmt.get(
        normalizedMachineId,
        program,
      ) as WorkerBridgeRow | null;
      if (existing) {
        // If updating the worker_name on this record would conflict with
        // another bridge record that has the same (worker_name, program),
        // delete the conflicting record first.
        if (existing.worker_name !== normalizedWorkerName) {
          this.db.run(
            `DELETE FROM worker_bridges WHERE worker_name = ? AND program = ? AND id != ?`,
            [normalizedWorkerName, program, existing.id],
          );
        }
        this.updateBridgeByIdStmt.run(
          normalizedWorkerName,
          normalizedMachineId,
          programVersion ?? null,
          bridgeVersion ?? null,
          projectPath ?? null,
          now,
          existing.id,
        );
      } else {
        // Delete any existing record with the same (worker_name, program)
        // to avoid UNIQUE constraint violation when inserting with a new machineId.
        this.db.run(
          `DELETE FROM worker_bridges WHERE worker_name = ? AND program = ?`,
          [normalizedWorkerName, program],
        );
        this.insertBridgeByMachineStmt.run(
          newId(),
          normalizedWorkerName,
          normalizedMachineId,
          program,
          programVersion ?? null,
          bridgeVersion ?? null,
          projectPath ?? null,
          now,
        );
      }
      return;
    }
    this.upsertBridgeStmt.run(
      newId(),
      normalizedWorkerName,
      program,
      programVersion ?? null,
      bridgeVersion ?? null,
      projectPath ?? null,
      now,
    );
  }

  getBridgesForWorker(workerName: string, machineId?: string): WorkerBridgeRow[] {
    const normalizedWorkerName = this.normalizeName(workerName);
    const normalizedMachineId = this.normalizeMachineId(machineId) ?? null;
    return this.getBridgesForWorkerStmt.all(
      normalizedMachineId,
      normalizedMachineId,
      normalizedMachineId,
      normalizedWorkerName,
    ) as WorkerBridgeRow[];
  }
}
