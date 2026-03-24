import type { Database } from "bun:sqlite";

export class SettingsRepo {
  private getStmt;
  private setStmt;

  constructor(db: Database) {
    this.getStmt = db.prepare("SELECT value FROM server_settings WHERE key = ?");
    this.setStmt = db.prepare(
      "INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value);
  }

  getBool(key: string): boolean {
    return this.get(key) === "true";
  }

  setBool(key: string, value: boolean): void {
    this.set(key, value ? "true" : "false");
  }

  getNumber(key: string): number | null {
    const raw = this.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  setNumber(key: string, value: number): void {
    this.set(key, String(value));
  }
}
