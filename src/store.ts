import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { PHASES } from "./types.js";
import type { AgentEvent, PhaseName, PhaseRecord, PhaseVerdict, RunRecord, TrustedDecision } from "./types.js";
import { emptyHabits, QUICK_MS, type Habits } from "./habits.js";

/** A stored payload as an object, or `{}` when the row is not JSON or not an object: a report over the audit log must not die on one bad row. */
function payload<T extends object>(raw: string): Partial<T> {
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<T>) : {}; } catch { return {}; }
}

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

  /** Every event stored for a run, oldest first, as the objects that were emitted. */
  getRunEvents(runId: string): AgentEvent[] {
    const rows = this.db.prepare("SELECT payload_json AS p FROM events WHERE run_id = ? ORDER BY id").all(runId) as Array<{ p: string }>;
    const out: AgentEvent[] = [];
    for (const r of rows) {
      try {
        const e = JSON.parse(r.p);
        if (e && typeof e === "object" && typeof e.type === "string") out.push(e as AgentEvent);
      } catch {
        /* a row that isn't JSON is skipped, not fatal */
      }
    }
    return out;
  }

  /** The runs recorded here, newest first. */
  listRuns(limit = 20): RunRecord[] {
    return this.db.prepare("SELECT id, task, work_dir AS workDir, created_at AS createdAt, status FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as unknown as RunRecord[];
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

  /**
   * `agent-loop insights`: a self-analysis report over this data dir's own run history, built
   * entirely from data already recorded for other reasons (phase attempts, verdicts, usage events,
   * auto-allow events) -- no new instrumentation, so it reflects every run ever made against this
   * data dir, not just ones run after some new tracking was added.
   */
  getInsights(): Insights {
    const totalRuns = (this.db.prepare("SELECT COUNT(*) as n FROM runs").get() as { n: number }).n;
    const statusRows = this.db.prepare("SELECT status, COUNT(*) as n FROM runs GROUP BY status").all() as Array<{ status: string; n: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.n;

    // A phase's attempt count for one run is the highest `attempt` row written for it; >1 means it
    // was repaired at least once. Aggregated across every run, not just the latest.
    const phaseRows = this.db
      .prepare(
        `SELECT name, MAX(attempt) as maxAttempt FROM phases GROUP BY run_id, name`
      )
      .all() as Array<{ name: PhaseName; maxAttempt: number }>;
    const phaseStats = new Map<string, { runs: number; repaired: number; totalAttempts: number }>();
    for (const row of phaseRows) {
      const s = phaseStats.get(row.name) ?? { runs: 0, repaired: 0, totalAttempts: 0 };
      s.runs++;
      s.totalAttempts += row.maxAttempt;
      if (row.maxAttempt > 1) s.repaired++;
      phaseStats.set(row.name, s);
    }
    const byPhase = [...phaseStats.entries()]
      .map(([name, s]) => ({ name: name as PhaseName, runs: s.runs, repairedRuns: s.repaired, avgAttempts: s.totalAttempts / s.runs }))
      .sort((a, b) => b.repairedRuns - a.repairedRuns);

    // Cost and rule-reuse both live inside events' free-form payload_json, not their own columns --
    // parsed in JS rather than via SQLite's JSON1 functions, which this embedded build isn't
    // guaranteed to have compiled in, for a report that only ever runs as an occasional CLI command.
    const usageRows = this.db.prepare("SELECT phase, payload_json as p FROM events WHERE type = 'usage'").all() as Array<{ phase: string | null; p: string }>;
    let totalCost = 0;
    const costByPhase = new Map<string, number>();
    for (const row of usageRows) {
      const c = payload<{ costUsd?: number }>(row.p).costUsd;
      const cost = typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
      totalCost += cost;
      if (row.phase) costByPhase.set(row.phase, (costByPhase.get(row.phase) ?? 0) + cost);
    }

    const autoAllowRows = this.db.prepare("SELECT payload_json as p FROM events WHERE type = 'approval-auto-allowed'").all() as Array<{ p: string }>;
    const ruleUseCounts = new Map<string, number>();
    for (const row of autoAllowRows) {
      const rule = payload<{ rule?: string }>(row.p).rule;
      if (typeof rule === "string" && rule) ruleUseCounts.set(rule, (ruleUseCounts.get(rule) ?? 0) + 1);
    }
    const createdRuleRows = this.db.prepare("SELECT payload_json as p FROM events WHERE type = 'approval-resolved'").all() as Array<{ p: string }>;
    const rulesCreated = new Set<string>();
    for (const row of createdRuleRows) {
      const rule = payload<{ rememberedRule?: string }>(row.p).rememberedRule;
      if (typeof rule === "string" && rule) rulesCreated.add(rule);
    }
    const neverReusedRules = [...rulesCreated].filter((r) => !ruleUseCounts.has(r));
    const topRules = [...ruleUseCounts.entries()].sort((a, b) => b[1] - a[1]).map(([rule, count]) => ({ rule, count }));

    return {
      totalRuns, byStatus, byPhase, totalCost, costByPhase: Object.fromEntries(costByPhase), topRules, neverReusedRules,
      desktop: this.desktopInsights(),
    };
  }

  /**
   * How this data dir has actually been used, as numbers (src/roast.ts: `Habits`). Built from rows that already
   * exist, like getInsights(); a row that is not valid JSON is skipped, because a report about your habits
   * should never be the thing that crashes on one bad row. Nothing a person typed is returned: tasks are only
   * compared with each other to count repeats, tool inputs only to notice the same call being asked twice.
   */
  getHabits(): Habits {
    const h = emptyHabits();
    const ms = (iso: unknown) => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : undefined; };

    const runs = this.db.prepare("SELECT id, task, created_at AS createdAt, status FROM runs").all() as Array<{ id: string; task: string; createdAt: string; status: string }>;
    const statusOf = new Map<string, string>();
    const sameTask = new Map<string, number>();
    for (const r of runs) {
      h.runs++;
      statusOf.set(r.id, r.status);
      if (r.status === "done") h.done++;
      else if (r.status === "failed") h.failed++;
      else if (r.status === "stopped") h.stopped++;
      const t = ms(r.createdAt);
      if (t !== undefined && new Date(t).getHours() < 5) h.nightRuns++;
      const key = r.task.trim().toLowerCase().replace(/\s+/g, " ");
      sameTask.set(key, (sameTask.get(key) ?? 0) + 1);
    }
    h.repeatedTaskMax = Math.max(0, ...sameTask.values());

    const costByRun = new Map<string, number>();
    const rows = this.db.prepare(
      "SELECT run_id AS runId, type, ts, payload_json AS p FROM events WHERE type IN ('usage','approval-request','approval-resolved','approval-auto-allowed','run-start','run-end') ORDER BY id"
    ).all() as Array<{ runId: string; type: string; ts: string; p: string }>;

    const asked = new Map<string, { at: number | undefined; call: string; runId: string }>();
    const denied = new Set<string>();
    const counted = new Set<string>();
    const answerRules = new Set<string>();
    const reusedRules = new Set<string>();
    const starts = new Map<string, number>();
    for (const row of rows) {
      const ev = payload<Record<string, unknown>>(row.p);
      switch (row.type) {
        case "usage": {
          const c = typeof ev.costUsd === "number" && Number.isFinite(ev.costUsd) && ev.costUsd > 0 ? ev.costUsd : 0;
          costByRun.set(row.runId, (costByRun.get(row.runId) ?? 0) + c);
          break;
        }
        case "run-start": { const t = ms(row.ts); if (t !== undefined) starts.set(row.runId, t); break; }
        case "run-end": {
          const a = starts.get(row.runId), b = ms(row.ts);
          if (a !== undefined && b !== undefined && b >= a) h.longestRunMin = Math.max(h.longestRunMin, (b - a) / 60_000);
          break;
        }
        case "approval-auto-allowed": h.approvals.auto++; if (typeof ev.rule === "string") reusedRules.add(ev.rule); break;
        case "approval-request": {
          if (typeof ev.requestId !== "string") break;
          h.approvals.asked++;
          asked.set(ev.requestId, { at: ms(row.ts), call: `${row.runId}\0${String(ev.toolName)}\0${JSON.stringify(ev.toolInput ?? null)}`, runId: row.runId });
          break;
        }
        case "approval-resolved": {
          if (typeof ev.rememberedRule === "string") answerRules.add(ev.rememberedRule);
          const q = typeof ev.requestId === "string" ? asked.get(ev.requestId) : undefined;
          if (ev.decision === "deny") {
            h.approvals.denied++;
            if (q) denied.add(q.call);
          } else if (ev.decision === "allow") {
            h.approvals.approved++;
            const took = q?.at !== undefined && ms(row.ts) !== undefined ? ms(row.ts)! - q.at : undefined;
            if (took !== undefined && took >= 0) {
              if (took < QUICK_MS) h.quickYes++;
              h.slowestAnswerMin = Math.max(h.slowestAnswerMin, took / 60_000);
            }
            if (q && denied.has(q.call) && !counted.has(q.call)) { counted.add(q.call); h.deniedThenAllowed++; }
          }
          break;
        }
      }
    }
    for (const [runId, cost] of costByRun) {
      h.totalCostUsd += cost;
      const st = statusOf.get(runId);
      if (st === "failed" || st === "stopped") h.wastedUsd += cost;
      if (cost > h.priciestRunUsd) h.priciestRunUsd = cost;
    }
    h.rulesCreated = answerRules.size;
    h.rulesNeverReused = [...answerRules].filter((r) => !reusedRules.has(r)).length;

    const phaseRows = this.db.prepare("SELECT name, MAX(attempt) AS maxAttempt FROM phases GROUP BY run_id, name").all() as Array<{ name: string; maxAttempt: number }>;
    for (const p of phaseRows) if (p.maxAttempt > 1 && (PHASES as readonly string[]).includes(p.name)) h.repairedRunsByPhase[p.name as PhaseName] = (h.repairedRunsByPhase[p.name as PhaseName] ?? 0) + 1;

    const dk = this.desktopInsights();
    for (const a of Object.values(dk.actions)) { h.desktop.sent += a.sent; h.desktop.stopped += a.refused; }
    h.desktop.approved = dk.humanApproved;
    h.desktop.denied = dk.humanDenied;
    return h;
  }

  /**
   * Desktop computer use, from events already recorded (src/desktop-tools.ts): how much of it happened,
   * how often the tools' own checks said no, and how often a human did. "Input" means click, type_text
   * and key -- the tools that can change something.
   */
  private desktopInsights(): DesktopInsights {
    const count = (type: string) => (this.db.prepare("SELECT COUNT(*) as n FROM events WHERE type = ?").get(type) as { n: number }).n;
    const input = new Set(["click", "type_text", "key"]);
    const actions: Record<string, { sent: number; refused: number }> = {};
    const doneRows = this.db.prepare("SELECT payload_json as p FROM events WHERE type = 'desktop-action-completed'").all() as Array<{ p: string }>;
    for (const row of doneRows) {
      const ev = payload<{ toolName?: string; isError?: boolean }>(row.p);
      if (!ev.toolName || !input.has(ev.toolName)) continue;
      const a = (actions[ev.toolName] ??= { sent: 0, refused: 0 });
      if (ev.isError) a.refused++;
      else a.sent++;
    }
    // A human's answer is on an approval-resolved event; which tool it was about is on the matching
    // approval-request (same requestId), so join the two.
    const desktopRequests = new Set<string>();
    const reqRows = this.db.prepare("SELECT payload_json as p FROM events WHERE type = 'approval-request'").all() as Array<{ p: string }>;
    for (const row of reqRows) {
      const ev = payload<{ requestId?: string; toolName?: string }>(row.p);
      if (typeof ev.requestId === "string" && typeof ev.toolName === "string" && ev.toolName.startsWith("mcp__desktop__")) desktopRequests.add(ev.requestId);
    }
    let humanApproved = 0;
    let humanDenied = 0;
    const resRows = this.db.prepare("SELECT payload_json as p FROM events WHERE type = 'approval-resolved'").all() as Array<{ p: string }>;
    for (const row of resRows) {
      const ev = payload<{ requestId?: string; decision?: string }>(row.p);
      if (!ev.requestId || !desktopRequests.has(ev.requestId)) continue;
      if (ev.decision === "deny") humanDenied++;
      else humanApproved++;
    }
    return { sessions: count("desktop-session-started"), captures: count("desktop-snapshot"), actions, humanApproved, humanDenied };
  }

  close() {
    this.db.close();
  }
}

export interface Insights {
  totalRuns: number;
  byStatus: Record<string, number>;
  byPhase: Array<{ name: PhaseName; runs: number; repairedRuns: number; avgAttempts: number }>;
  totalCost: number;
  costByPhase: Record<string, number>;
  topRules: Array<{ rule: string; count: number }>;
  neverReusedRules: string[];
  desktop: DesktopInsights;
}

export interface DesktopInsights {
  sessions: number;
  captures: number;
  /** Input tools only. `sent` reached the driver; `refused` were stopped by the tools' own checks
   * (a stale capture, a swapped window, a denied key...) or the driver. */
  actions: Record<string, { sent: number; refused: number }>;
  /** Human answers to desktop approval requests. */
  humanApproved: number;
  humanDenied: number;
}
