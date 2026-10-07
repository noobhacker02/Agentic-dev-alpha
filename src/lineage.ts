/**
 * The run's lineage: a git-log-like tree of every phase attempt, who handed what to whom, which agent
 * wrote which files, and what each cost. It answers "who made this, in what order, and why was it redone"
 * from events the run already emits; it is read-only and adds nothing the agents can write to, which is
 * the point: coordinating agents through a shared mutable log invites races, while a tree derived from
 * what happened cannot disagree with it (docs/LINEAGE.md, docs/RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md).
 *
 *  - `buildLineage(events)` is a pure function. The CLI rebuilds it from a past run's stored events, the
 *    tracker rebuilds it live and publishes it as a `lineage-updated` event, and a saved report carries the
 *    last one.
 *  - Everything model- or page-written (headlines, reasons, file paths, tool names) is cleaned of control
 *    characters and capped here, so a consumer that forgets to escape still can't be handed an escape
 *    sequence; the page and the terminal escape anyway.
 *  - Files are attributed only when the write really happened: a Write/Edit call counts once its result
 *    arrives and isn't an error. A denied or failed write is counted as failed, not as the agent's work.
 *    Files changed through Bash can't be attributed to a path, so Bash calls are counted but not listed.
 */
import type { EventBus } from "./bus.js";
import type { AgentEvent, PhaseName, PhaseOutcome } from "./types.js";
import { PHASES, PHASE_OUTCOMES } from "./types.js";

export const MAX_NODES = 400;
export const MAX_FILES_PER_NODE = 200;
export const MAX_FILES_TOTAL = 300;
export const MAX_DECISIONS = 100;
export const MAX_TOOL_NAMES = 20;

export type NodeKind = "root" | "handoff" | "repair" | "retry";
export type NodeOutcome = "running" | "skipped" | "incomplete" | PhaseOutcome | "unknown";

export interface LineageFile {
  path: string;
  op: "write" | "edit";
  count: number;
}

export interface LineageNode {
  /** `(item, stepId, attempt)` as one string: `s3#1`, or `job-17:s3#1` in an item flow. Runs from before the team was composed have no step and read `builder#1`. */
  id: string;
  /** The role the step runs as (for the five built-ins, the phase name). */
  phase: PhaseName;
  /** The plan's id for the step (adversary A3): two steps of one role differ here. Absent on runs from before the team was composed. */
  stepId?: string;
  /** The job id or queue key of an item flow; absent for the dev flow. */
  item?: string;
  attempt: number;
  /** 0 = moving forward; 1 = a phase being run again after the Overseer sent it back. */
  lane: 0 | 1;
  kind: NodeKind;
  parent?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: NodeOutcome;
  /** What this phase reported, which is what the next phase was handed. */
  headline?: string;
  details?: string;
  concerns: string[];
  blocking: string[];
  costUsd: number;
  approvals: { asked: number; approved: number; denied: number; auto: number; rulesSaved: number };
  toolCalls: number;
  tools: Record<string, number>;
  files: LineageFile[];
  filesMore: number;
  failedWrites: number;
  browserActions: number;
  desktopActions: { sent: number; refused: number };
  /** The Overseer's call after this node. */
  decision?: { action: "continue" | "repair" | "stop"; repairTarget?: PhaseName; reasoning?: string; feedback?: string };
  /** Decisions a human recorded in the approval UI while this was the latest attempt of its phase. */
  recorded: string[];
}

export interface Lineage {
  runId: string;
  task?: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  nodes: LineageNode[];
  edges: Array<{ from: string; to: string; kind: NodeKind }>;
  decisions: Array<{ ts: string; phase: PhaseName; text: string }>;
  totals: {
    costUsd: number;
    /** Cost from sessions that couldn't be tied to a phase attempt. */
    unattributedCostUsd: number;
    approvals: { asked: number; approved: number; denied: number; auto: number };
    toolCalls: number;
    repairs: number;
    files: number;
  };
  /** "Made by": one row per agent. */
  agents: Array<{ phase: PhaseName; stepId?: string; item?: string; attempts: number; outcomes: string[]; costUsd: number; files: number; toolCalls: number; approvalsAsked: number }>;
  /** Blame-style: for each file, which attempts touched it, in order. */
  files: Array<{ path: string; touches: Array<{ node: string; op: "write" | "edit" }> }>;
  truncated: boolean;
}

// ---------- cleaning

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏]+/g;
/** Text from a model or a page, made safe to print anywhere: control/bidi characters become spaces, whitespace collapses, length is capped. */
export function cleanText(x: unknown, max: number): string {
  const t = String(x ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 1e6 ? x : 0);
/** A role id as the roster spells it (lowercase letters, digits, dashes). The five built-in names and every other role pass; anything else is not a step of this run. */
const isPhase = (x: unknown): x is PhaseName => typeof x === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(x);
const isStepId = (x: unknown): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9._-]{0,30}$/i.test(x);
const cleanItem = (x: unknown): string | undefined => (typeof x === "string" && x ? cleanText(x, 80) || undefined : undefined);
/** Which unit of work an event is about: the step when it names one, else the role (every event from before the team was composed). `explicit` says which. */
function stepRef(ev: { phase?: unknown; stepId?: unknown; item?: unknown }): { phase: PhaseName; key: string; explicit: boolean; known: boolean; stepId?: string; item?: string } | undefined {
  if (!isPhase(ev.phase)) return undefined;
  const stepId = isStepId(ev.stepId) ? ev.stepId : undefined;
  const item = cleanItem(ev.item);
  // A step can only be STARTED by a built-in role or by an event that names its step (every event of a team run does); a phase name with neither is not a step of this run.
  const known = stepId !== undefined || (PHASES as readonly string[]).includes(ev.phase);
  return { phase: ev.phase, key: `${item ?? ""}|${stepId ?? ev.phase}`, explicit: stepId !== undefined, known, stepId, item };
}
const isOutcome = (x: unknown): x is PhaseOutcome => typeof x === "string" && (PHASE_OUTCOMES as readonly string[]).includes(x);
const FILE_TOOLS: Record<string, "write" | "edit"> = { Write: "write", Edit: "edit", NotebookEdit: "edit" };

function newNode(phase: PhaseName, attempt: number, ts: string, kind: NodeKind, parent?: string, stepId?: string, item?: string): LineageNode {
  return {
    id: `${item ? item + ":" : ""}${stepId ?? phase}#${attempt}`, phase, ...(stepId ? { stepId } : {}), ...(item ? { item } : {}), attempt, lane: 0, kind, parent, startedAt: ts, outcome: "running", concerns: [], blocking: [], costUsd: 0,
    approvals: { asked: 0, approved: 0, denied: 0, auto: 0, rulesSaved: 0 }, toolCalls: 0, tools: Object.create(null), files: [], filesMore: 0, failedWrites: 0,
    browserActions: 0, desktopActions: { sent: 0, refused: 0 }, recorded: [],
  };
}

/** Builds the lineage of one run from its events (any order of other runs' events is ignored). */
export function buildLineage(events: readonly AgentEvent[], runId?: string): Lineage {
  const id = runId ?? (events.find((e) => typeof (e as { runId?: unknown }).runId === "string") as { runId?: string } | undefined)?.runId ?? "unknown";
  const out: Lineage = {
    runId: cleanText(id, 80), status: "running", nodes: [], edges: [], decisions: [],
    totals: { costUsd: 0, unattributedCostUsd: 0, approvals: { asked: 0, approved: 0, denied: 0, auto: 0 }, toolCalls: 0, repairs: 0, files: 0 },
    agents: [], files: [], truncated: false,
  };
  const byId = new Map<string, LineageNode>();
  const latestOf = new Map<string, LineageNode>(); // by step key (item and step id, or the role for events from before the team was composed)
  const latestByRole = new Map<PhaseName, LineageNode>();
  const keyOfNode = new Map<LineageNode, string>();
  const pendingFile = new Map<string, { node: LineageNode; op: "write" | "edit"; path: string }>();
  const requestNode = new Map<string, LineageNode>();
  let current: LineageNode | undefined;
  let lastEnded: LineageNode | undefined;
  let pendingRepair: { from: LineageNode; target: string } | undefined;
  const fileTouches = new Map<string, Array<{ node: string; op: "write" | "edit" }>>();

  // Steps run one at a time, so an event that names no step (a tool call, an approval) belongs to the step in progress when it is of that role, else to the latest step of the role.
  const nodeFor = (ev: { phase?: unknown; stepId?: unknown; item?: unknown } | unknown): LineageNode | undefined => {
    const e = ev && typeof ev === "object" ? (ev as { phase?: unknown; stepId?: unknown; item?: unknown }) : { phase: ev };
    const ref = stepRef(e);
    if (!ref) return current;
    if (ref.explicit ? current && keyOfNode.get(current) === ref.key : current?.phase === ref.phase) return current;
    return latestOf.get(ref.key) ?? (ref.explicit ? undefined : latestByRole.get(ref.phase));
  };

  for (const ev of events) {
    if (!ev || typeof ev !== "object" || (ev as { runId?: unknown }).runId !== id) continue;
    const ts = typeof ev.ts === "string" ? ev.ts : "";
    switch (ev.type) {
      case "run-start":
        out.startedAt = ts;
        out.task = cleanText(ev.task, 200);
        break;
      case "phase-start": {
        const ref = stepRef(ev);
        if (!ref || !ref.known || !Number.isInteger(ev.attempt) || ev.attempt < 1 || ev.attempt > 999) break;
        const nid = `${ref.item ? ref.item + ":" : ""}${ref.stepId ?? ref.phase}#${ev.attempt}`;
        let node = byId.get(nid);
        if (!node) {
          if (out.nodes.length >= MAX_NODES) { out.truncated = true; break; }
          let kind: NodeKind, parent: string | undefined;
          if (pendingRepair) { kind = pendingRepair.target === ref.phase || pendingRepair.target === ref.stepId ? "repair" : "handoff"; parent = pendingRepair.from.id; }
          else if (lastEnded && keyOfNode.get(lastEnded) === ref.key) { kind = "retry"; parent = lastEnded.id; }
          else if (lastEnded) { kind = "handoff"; parent = lastEnded.id; }
          else { kind = "root"; }
          pendingRepair = undefined;
          node = newNode(ref.phase, ev.attempt, ts, kind, parent, ref.stepId, ref.item);
          keyOfNode.set(node, ref.key);
          byId.set(nid, node);
          out.nodes.push(node);
          if (parent) out.edges.push({ from: parent, to: nid, kind });
        }
        latestOf.set(ref.key, node);
        latestByRole.set(ref.phase, node);
        current = node;
        break;
      }
      case "phase-end": {
        const ref = stepRef(ev);
        if (!ref || !ref.known) break;
        const node = byId.get(`${ref.item ? ref.item + ":" : ""}${ref.stepId ?? ref.phase}#${ev.attempt}`) ?? nodeFor(ev);
        if (!node) break;
        node.endedAt = ts;
        const ms = Date.parse(ts) - Date.parse(node.startedAt);
        if (Number.isFinite(ms) && ms >= 0) node.durationMs = ms;
        const v = ev.verdict as { outcome?: unknown; headline?: unknown; details?: unknown; concerns?: unknown; blockingFindings?: unknown } | undefined;
        node.headline = cleanText(v?.headline, 200);
        node.details = cleanText(v?.details, 400);
        node.outcome = node.headline === "Skipped" ? "skipped" : isOutcome(v?.outcome) ? v.outcome : "unknown";
        node.concerns = (Array.isArray(v?.concerns) ? v.concerns : []).slice(0, 10).map((c) => cleanText(c, 200));
        node.blocking = (Array.isArray(v?.blockingFindings) ? v.blockingFindings : []).slice(0, 10).map((c) => cleanText(c, 200));
        lastEnded = node;
        if (current === node) current = undefined;
        break;
      }
      case "overseer-decision": {
        const node = nodeFor(ev);
        const d = ev.decision as { action?: unknown; repairTarget?: unknown; reasoning?: unknown; feedbackForRepair?: unknown } | undefined;
        if (!node || !d || (d.action !== "continue" && d.action !== "repair" && d.action !== "stop")) break;
        node.decision = {
          action: d.action,
          repairTarget: isPhase(d.repairTarget) || isStepId(d.repairTarget) ? (d.repairTarget as string) : undefined,
          reasoning: cleanText(d.reasoning, 300),
          feedback: d.feedbackForRepair === undefined ? undefined : cleanText(d.feedbackForRepair, 300),
        };
        if (d.action === "repair") {
          out.totals.repairs++;
          pendingRepair = { from: node, target: isPhase(d.repairTarget) || isStepId(d.repairTarget) ? (d.repairTarget as string) : (node.stepId ?? node.phase) };
        } else pendingRepair = undefined;
        break;
      }
      case "tool-call": {
        const node = nodeFor(ev);
        if (!node) break;
        out.totals.toolCalls++;
        node.toolCalls++;
        const name = cleanText(ev.toolName, 64) || "(unnamed)";
        // node.tools has no prototype, so a tool named "constructor" or "__proto__" is just a name.
        const key = name in node.tools || Object.keys(node.tools).length < MAX_TOOL_NAMES ? name : "(other)";
        node.tools[key] = (node.tools[key] ?? 0) + 1;
        const op = Object.hasOwn(FILE_TOOLS, ev.toolName) ? FILE_TOOLS[ev.toolName] : undefined;
        const input = ev.toolInput as { file_path?: unknown; notebook_path?: unknown } | undefined;
        const path = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : undefined;
        if (op && path && typeof ev.toolUseId === "string") pendingFile.set(ev.toolUseId, { node, op, path: cleanText(path, 300) });
        break;
      }
      case "tool-result": {
        const pending = typeof ev.toolUseId === "string" ? pendingFile.get(ev.toolUseId) : undefined;
        if (!pending) break;
        pendingFile.delete(ev.toolUseId);
        if (ev.isError === true) { pending.node.failedWrites++; break; }
        const f = pending.node.files.find((x) => x.path === pending.path && x.op === pending.op);
        if (f) f.count++;
        else if (pending.node.files.length < MAX_FILES_PER_NODE) pending.node.files.push({ path: pending.path, op: pending.op, count: 1 });
        else { pending.node.filesMore++; break; }
        const touches = fileTouches.get(pending.path) ?? (fileTouches.size < MAX_FILES_TOTAL ? fileTouches.set(pending.path, []).get(pending.path) : undefined);
        if (touches) touches.push({ node: pending.node.id, op: pending.op });
        break;
      }
      case "approval-request": {
        const node = nodeFor(ev);
        if (!node) break;
        node.approvals.asked++;
        out.totals.approvals.asked++;
        if (typeof ev.requestId === "string") requestNode.set(ev.requestId, node);
        break;
      }
      case "approval-resolved": {
        const node = requestNode.get(ev.requestId) ?? nodeFor(ev);
        requestNode.delete(ev.requestId);
        if (!node || ev.auto === true) break;
        if (ev.decision === "allow") { node.approvals.approved++; out.totals.approvals.approved++; }
        else { node.approvals.denied++; out.totals.approvals.denied++; }
        if (ev.rememberedRule) node.approvals.rulesSaved++;
        break;
      }
      case "approval-auto-allowed": {
        const node = nodeFor(ev);
        if (!node) break;
        node.approvals.auto++;
        out.totals.approvals.auto++;
        break;
      }
      case "usage": {
        const cost = num(ev.costUsd);
        out.totals.costUsd += cost;
        const node = isPhase(ev.phase) ? nodeFor(ev) : undefined;
        if (node) node.costUsd += cost;
        else out.totals.unattributedCostUsd += cost;
        break;
      }
      case "browser-action-started":
        if (current) current.browserActions++;
        break;
      case "desktop-action-completed":
        if (current) (ev.isError === true ? current.desktopActions.refused++ : current.desktopActions.sent++);
        break;
      case "trusted-decision-recorded": {
        const text = cleanText(ev.text, 300);
        if (out.decisions.length < MAX_DECISIONS) out.decisions.push({ ts, phase: isPhase(ev.phase) ? ev.phase : "planner", text });
        const node = nodeFor(ev);
        if (node && node.recorded.length < 10) node.recorded.push(text);
        break;
      }
      case "run-end": {
        out.status = ev.status === "done" || ev.status === "failed" || ev.status === "stopped" ? ev.status : "failed";
        out.endedAt = ts;
        for (const n of out.nodes) if (n.outcome === "running") n.outcome = "incomplete";
        break;
      }
    }
  }

  // Lanes: a phase that was already reached is being run again, so it sits in the repair lane until the
  // run gets past where it had got to.
  // The order a step was first reached in is its place in the plan, whatever the plan is (five built-ins, or any team).
  const place = new Map<string, number>();
  for (const n of out.nodes) { const k = keyOfNode.get(n) ?? n.id; if (!place.has(k)) place.set(k, place.size); }
  let frontier = -1;
  for (const n of out.nodes) {
    const idx = place.get(keyOfNode.get(n) ?? n.id) ?? 0;
    n.lane = idx <= frontier ? 1 : 0;
    frontier = Math.max(frontier, idx);
  }

  const start = out.startedAt ? Date.parse(out.startedAt) : NaN;
  const end = out.endedAt ? Date.parse(out.endedAt) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) out.durationMs = end - start;

  for (const key of place.keys()) {
    const mine = out.nodes.filter((n) => (keyOfNode.get(n) ?? n.id) === key);
    if (!mine.length) continue;
    out.agents.push({
      phase: mine[0].phase, ...(mine[0].stepId ? { stepId: mine[0].stepId } : {}), ...(mine[0].item ? { item: mine[0].item } : {}), attempts: mine.length, outcomes: mine.map((n) => n.outcome), costUsd: mine.reduce((s, n) => s + n.costUsd, 0),
      files: new Set(mine.flatMap((n) => n.files.map((f) => f.path))).size, toolCalls: mine.reduce((s, n) => s + n.toolCalls, 0),
      approvalsAsked: mine.reduce((s, n) => s + n.approvals.asked, 0),
    });
  }
  out.files = [...fileTouches.entries()].map(([path, touches]) => ({ path, touches }));
  out.totals.files = out.files.length;
  return out;
}

// ---------- text and markdown

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
const money = (n: number) => `$${n.toFixed(2)}`;
const label = (o: NodeOutcome) => (o === "fail" ? "FAIL" : o === "pass" ? "pass" : o);

function nodeMeta(n: LineageNode): string {
  const bits: string[] = [];
  if (n.durationMs !== undefined) bits.push(fmtDuration(n.durationMs));
  if (n.costUsd > 0) bits.push(money(n.costUsd));
  if (n.approvals.asked) bits.push(`${n.approvals.asked} prompt${n.approvals.asked > 1 ? "s" : ""} (${n.approvals.approved} yes, ${n.approvals.denied} no)`);
  if (n.files.length || n.filesMore) bits.push(`${n.files.length + n.filesMore} file${n.files.length + n.filesMore > 1 ? "s" : ""}`);
  if (n.toolCalls) bits.push(`${n.toolCalls} tool call${n.toolCalls > 1 ? "s" : ""}`);
  return bits.join(" · ");
}

/** The tree as plain text: what `agent-loop lineage` prints and what lineage.md puts in a code fence. */
export function renderLineageText(l: Lineage): string {
  const lines: string[] = [];
  lines.push(`Run ${l.runId}  ${l.status}${l.durationMs !== undefined ? "  " + fmtDuration(l.durationMs) : ""}  ${money(l.totals.costUsd)}`);
  if (l.task) lines.push(`Task: ${l.task}`);
  lines.push("");
  let prevLane: 0 | 1 = 0;
  for (const n of l.nodes) {
    if (n.lane === 1 && prevLane === 0) lines.push("├─╮");
    if (n.lane === 0 && prevLane === 1) lines.push("├─╯");
    prevLane = n.lane;
    const rail = n.lane === 1 ? "│ ○" : "●";
    const tag = n.kind === "repair" ? "  (sent back)" : n.kind === "retry" ? "  (retry)" : "";
    lines.push(`${rail} ${n.id.padEnd(16)} ${label(n.outcome).padEnd(12)} ${nodeMeta(n)}${tag}`);
    const pad = n.lane === 1 ? "│    " : "│  ";
    if (n.headline) lines.push(`${pad}says: ${n.headline}`);
    for (const b of n.blocking) lines.push(`${pad}blocking: ${b}`);
    for (const f of n.files.slice(0, 8)) lines.push(`${pad}${f.op === "write" ? "+" : "~"} ${f.path}${f.count > 1 ? ` (x${f.count})` : ""}`);
    if (n.files.length > 8 || n.filesMore) lines.push(`${pad}… ${n.files.length - 8 + n.filesMore} more file(s)`);
    for (const r of n.recorded) lines.push(`${pad}human decision: ${r}`);
    if (n.decision) lines.push(`${pad}Overseer → ${n.decision.action.toUpperCase()}${n.decision.repairTarget ? " " + n.decision.repairTarget : ""}${n.decision.reasoning ? ": " + n.decision.reasoning : ""}`);
  }
  if (prevLane === 1) lines.push("├─╯");
  if (l.truncated) lines.push("(more attempts than are shown)");
  lines.push("");
  lines.push("Made by");
  for (const a of l.agents) lines.push(`  ${a.phase.padEnd(14)} ${a.attempts} attempt${a.attempts > 1 ? "s" : ""} (${a.outcomes.join(", ")})  ${money(a.costUsd)}  ${a.files} file${a.files === 1 ? "" : "s"}  ${a.toolCalls} tool calls`);
  if (l.files.length) {
    lines.push("");
    lines.push("Files, and who touched them");
    for (const f of l.files) lines.push(`  ${f.path}  ${f.touches.map((t) => `${t.node} (${t.op})`).join(", ")}`);
  }
  if (l.decisions.length) {
    lines.push("");
    lines.push("Decisions a human recorded");
    for (const d of l.decisions) lines.push(`  [${d.phase}] ${d.text}`);
  }
  return lines.join("\n");
}

/** The same, as a document to keep next to the run: lineage.md. */
export function renderLineageMarkdown(l: Lineage): string {
  const md = (s: string) => s.replace(/[`|\\]/g, " ");
  const rows = l.agents.map((a) => `| ${a.phase} | ${a.attempts} | ${md(a.outcomes.join(", "))} | ${money(a.costUsd)} | ${a.files} | ${a.toolCalls} | ${a.approvalsAsked} |`);
  const files = l.files.map((f) => `| \`${md(f.path)}\` | ${md(f.touches.map((t) => `${t.node} (${t.op})`).join(", "))} |`);
  return [
    `# Run ${md(l.runId)}: ${l.status}`,
    "",
    l.task ? `**Task:** ${md(l.task)}` : "",
    `**Time:** ${fmtDuration(l.durationMs) || "unknown"} · **Cost:** ${money(l.totals.costUsd)} · **Repairs:** ${l.totals.repairs} · **Prompts:** ${l.totals.approvals.asked} (${l.totals.approvals.approved} yes, ${l.totals.approvals.denied} no, ${l.totals.approvals.auto} by rule)`,
    "",
    "## Lineage",
    "",
    "Each line is one phase attempt. An agent run again after the Overseer sent it back sits on the indented rail.",
    "",
    "```",
    renderLineageText(l).split("\n\nMade by")[0].split("\n").slice(2).join("\n"),
    "```",
    "",
    "## Made by",
    "",
    "| Agent | Attempts | Outcomes | Cost | Files | Tool calls | Prompts |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    l.files.length ? "## Files, and who touched them\n\n| File | Attempts that touched it |\n|---|---|\n" + files.join("\n") + "\n" : "",
    l.decisions.length ? "## Decisions a human recorded\n\n" + l.decisions.map((d) => `- [${d.phase}] ${md(d.text)}`).join("\n") + "\n" : "",
    "_Derived from the run's events; nothing here was written by an agent. Files changed through Bash can't be attributed to a path, so only Write and Edit calls that succeeded are listed._",
    "",
  ].filter((x) => x !== "").join("\n");
}

// ---------- the tracker: publishes the tree live

const RELEVANT = new Set([
  "run-start", "run-end", "phase-start", "phase-end", "overseer-decision", "tool-call", "tool-result", "approval-request", "approval-resolved", "approval-auto-allowed",
  "usage", "browser-action-started", "desktop-action-completed", "trusted-decision-recorded",
]);
const PUBLISH_ON = new Set(["phase-start", "phase-end", "overseer-decision", "trusted-decision-recorded", "run-end"]);
const MAX_TRACKED_EVENTS = 50_000;

/** Listens to a bus and emits `lineage-updated` with the tree so far, after each moment that changes its shape. */
export class LineageTracker {
  private events = new Map<string, AgentEvent[]>();
  private listener = (ev: AgentEvent) => this.onEvent(ev);
  constructor(private bus: EventBus) {}

  attach() {
    this.bus.on("event", this.listener);
    return { detach: () => this.bus.off("event", this.listener) };
  }

  private onEvent(ev: AgentEvent) {
    const runId = (ev as { runId?: unknown }).runId;
    if (typeof runId !== "string" || !RELEVANT.has(ev.type)) return;
    let list = this.events.get(runId);
    if (!list) this.events.set(runId, (list = []));
    if (list.length < MAX_TRACKED_EVENTS) list.push(ev);
    if (!PUBLISH_ON.has(ev.type)) return;
    const snapshot = buildLineage(list, runId);
    if (ev.type === "run-end") this.events.delete(runId);
    // After the triggering event has reached every listener; a failure to publish never breaks a run.
    queueMicrotask(() => {
      try {
        this.bus.emitEvent({ type: "lineage-updated", runId, lineage: snapshot, ts: ev.ts });
      } catch {
        /* the store may already be closed */
      }
    });
  }
}
