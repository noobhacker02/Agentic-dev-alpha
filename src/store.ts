import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { PhaseName, PhaseRecord, PhaseVerdict, RunRecord, TrustedDecision } from "./types.js";

/**
 * The whole point of this store: the Overseer and a human can both look up
 * "what did phase X do and why" from short indexed rows, without either of
 * them ever having to hold a full agent transcript in context. No vector
 * search — FTS5 full-text over structured rows is enough for "find the log
 * entry about the auth module" and avoids the RAG/embedding machinery the
 * project explicitly doesn't need.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS phases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        verdict_json TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        phase TEXT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS log_index USING fts5(
        run_id UNINDEXED,
        phase UNINDEXED,
        kind UNINDEXED,
        content
      );

      -- Controller-owned record of decisions a human actually approved through the approval UI.
      -- Never written to by a worker phase (they can only propose, via DECISIONS.md) -- this is
      -- what the Overseer is allowed to treat as settled. See docs/STRESS-TEST-REPORT.md's finding
      -- on a worker being able to write "pre-approved by the user" into a file and have it believed.
      CREATE TABLE IF NOT EXISTS trusted_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        text TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
  }

  createRun(task: string, workDir: string): RunRecord {
    const run: RunRecord = {
      id: randomUUID(),
      task,
      workDir,
      createdAt: new Date().toISOString(),
      status: "running",
    };
    this.db
      .prepare(
        "INSERT INTO runs (id, task, work_dir, created_at, status) VALUES (?, ?, ?, ?, ?)"
      )
      .run(run.id, run.task, run.workDir, run.createdAt, run.status);
    return run;
  }

  finishRun(runId: string, status: RunRecord["status"]) {
    this.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
  }

  startPhase(runId: string, name: PhaseName, attempt: number): PhaseRecord {
    const phase: PhaseRecord = {
      id: randomUUID(),
      runId,
      name,
      attempt,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      summary: null,
      verdict: null,
    };
    this.db
      .prepare(
        "INSERT INTO phases (id, run_id, name, attempt, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(phase.id, phase.runId, phase.name, phase.attempt, phase.status, phase.startedAt);
    return phase;
  }

  finishPhase(phaseId: string, verdict: PhaseVerdict) {
    this.db
      .prepare(
        "UPDATE phases SET status = ?, finished_at = ?, summary = ?, verdict_json = ? WHERE id = ?"
      )
      .run(
        verdict.outcome === "pass" ? "ok" : "failed",
        new Date().toISOString(),
        verdict.headline,
        JSON.stringify(verdict),
        phaseId
      );
    this.indexLog(phaseId, "phase-verdict", `${verdict.headline}\n${verdict.details}`);
  }

  /** Record a decision a human actually approved. Only call this from the controller-mediated
   * approval path (server.ts's WS handler) -- never from anything a worker phase can trigger. */
  recordTrustedDecision(runId: string, text: string): TrustedDecision {
    const decision: TrustedDecision = { id: randomUUID(), runId, text, recordedAt: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO trusted_decisions (id, run_id, text, recorded_at) VALUES (?, ?, ?, ?)")
      .run(decision.id, decision.runId, decision.text, decision.recordedAt);
    return decision;
  }

  getTrustedDecisions(runId: string): TrustedDecision[] {
    const rows = this.db
      .prepare("SELECT id, run_id as runId, text, recorded_at as recordedAt FROM trusted_decisions WHERE run_id = ? ORDER BY recorded_at ASC")
      .all(runId) as unknown as TrustedDecision[];
    return rows;
  }

  /** Short indexed summaries only — this is what the Overseer reads, never full transcripts. */
  getPhaseSummaries(runId: string): Array<{ name: PhaseName; attempt: number; status: string; summary: string | null }> {
    const rows = this.db
      .prepare(
        "SELECT name, attempt, status, summary FROM phases WHERE run_id = ? ORDER BY started_at ASC"
      )
      .all(runId) as Array<{ name: PhaseName; attempt: number; status: string; summary: string | null }>;
    return rows;
  }

  logEvent(runId: string, phase: string | null, type: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO events (run_id, phase, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(runId, phase, new Date().toISOString(), type, JSON.stringify(payload));
  }

  /** Add a chunk of free text to the searchable index (tool summaries, phase notes, etc). */
  indexLog(refId: string, kind: string, content: string) {
    // refId doubles as a loose foreign key (phase id, tool-use id, ...) kept in `phase` column position
    this.db
      .prepare("INSERT INTO log_index (run_id, phase, kind, content) VALUES (?, ?, ?, ?)")
      .run(refId, kind, kind, content);
  }

  searchLogs(query: string, limit = 20): Array<{ kind: string; content: string }> {
    return this.db
      .prepare(
        "SELECT kind, content FROM log_index WHERE log_index MATCH ? ORDER BY rank LIMIT ?"
      )
      .all(query, limit) as Array<{ kind: string; content: string }>;
  }

  close() {
    this.db.close();
  }
}
