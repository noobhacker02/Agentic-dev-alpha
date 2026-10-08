// Step 9 of the reel flow: the `ideas` table (docs/REEL-FLOW.md). One row per source key (a canonical link or a content hash), so the same reel sent twice is one idea. SQLite, 0600, in the agent-loop directory.
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface IdeaRow { id: number; source: string; about: string; idea: string; scores: string; verdict: string; reason: string; decision: string; createdAt: number }

export class Ideas {
  private db: DatabaseSync;
  constructor(path: string, private clock: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* not a file system with modes */ }
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE, about TEXT NOT NULL, idea TEXT NOT NULL, scores TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`);
  }
  get(source: string): IdeaRow | undefined {
    const r = this.db.prepare("SELECT id, source, about, idea, scores, verdict, reason, decision, created_at AS createdAt FROM ideas WHERE source = ?").get(source) as IdeaRow | undefined;
    return r ? { ...r } : undefined;
  }
  /** Adds the idea; false if this source is already remembered (nothing is overwritten). */
  add(r: Omit<IdeaRow, "id" | "decision" | "createdAt">): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO ideas (source, about, idea, scores, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.source, r.about, r.idea, r.scores, r.verdict, r.reason, this.clock()).changes) === 1;
  }
  decide(id: number, decision: "yes" | "no"): boolean {
    return Number(this.db.prepare("UPDATE ideas SET decision = ? WHERE id = ? AND decision = 'pending'").run(decision, id).changes) === 1;
  }
  list(): IdeaRow[] {
    return (this.db.prepare("SELECT id, source, about, idea, scores, verdict, reason, decision, created_at AS createdAt FROM ideas ORDER BY id").all() as unknown as IdeaRow[]).map((r) => ({ ...r }));
  }
  /** Rows older than `days` go (the user's `ideas purge`). */
  purge(days: number): number { return Number(this.db.prepare("DELETE FROM ideas WHERE created_at < ?").run(this.clock() - days * 86_400_000).changes); }
  close(): void { this.db.close(); }
}
