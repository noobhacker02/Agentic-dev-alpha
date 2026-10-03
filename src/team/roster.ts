// The roster: who can be on a team, what each role may do, and where role definitions may come from (docs/TEAM-COMPOSITION.md).
// A role is data: tools are enforced from this definition by the hook chain, never from the role's own text (V7). Roles from the user's own config directory are
// loaded; roles from inside the project directory are ignored until the user trusts them (V13, threat G10), and nothing can redefine a built-in role.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type RoleKind = "meta" | "read" | "plan" | "advise" | "build" | "check" | "gate" | "monitor";
export type ModelAlias = "haiku" | "sonnet" | "opus";
/** Where a role may write: nowhere, the tests directory, the docs paths, its own slice, or the shared files only the integrator owns. */
export type WriteScope = "none" | "tests" | "docs" | "slice" | "shared";
export type ToolClassBase = "read" | "run" | "web" | "browser-read" | "browser" | "desktop";
export type Skippable = "no" | "yes" | "tiny";

export interface RoleDef {
  id: string;
  kind: RoleKind;
  model: ModelAlias;
  tools: ToolClassBase[];
  writeScope: WriteScope;
  skippable: Skippable;
  /** At most this many steps of the role in one plan (V5). */
  max: number;
  /** The reason the role exists, shown next to every step that uses it. */
  when: string;
  /** Signals that make the role part of the team. */
  signals?: string[];
  /** The signal that makes the role mandatory: the composer cannot drop it (V4). */
  mandatoryOnSignal?: string;
  builtin: boolean;
  instructions?: string;
}

const role = (r: Omit<RoleDef, "builtin">): RoleDef => ({ ...r, builtin: true });

export const BUILTIN_ROSTER: RoleDef[] = [
  role({ id: "composer", kind: "meta", model: "haiku", tools: [], writeScope: "none", skippable: "no", max: 1, when: "Always, first: proposes the team (offline heuristic when no model is available)." }),
  role({ id: "researcher", kind: "read", model: "sonnet", tools: ["read"], writeScope: "none", skippable: "yes", max: 2, signals: ["unfamiliar", "unclear-cause", "find-out"], when: "An unfamiliar library or API, an unclear root cause, or a find-out task." }),
  role({ id: "planner", kind: "plan", model: "sonnet", tools: ["read"], writeScope: "none", skippable: "tiny", max: 1, when: "Anything above a one-file change." }),
  role({ id: "advisor", kind: "advise", model: "opus", tools: ["read"], writeScope: "none", skippable: "yes", max: 3, signals: ["irreversible", "risky"], when: "Before an irreversible class of action, at plan time for large or risky teams, once before done." }),
  role({ id: "test-designer", kind: "plan", model: "sonnet", tools: ["read"], writeScope: "tests", skippable: "yes", max: 2, signals: ["behaviour-change"], when: "Behaviour changes with no existing tests." }),
  role({ id: "builder", kind: "build", model: "haiku", tools: ["read", "run"], writeScope: "slice", skippable: "no", max: 6, when: "Always, one per slice: does the work inside its own paths." }),
  role({ id: "verifier", kind: "check", model: "sonnet", tools: ["read", "run", "browser-read"], writeScope: "none", skippable: "no", max: 6, when: "After every builder slice: an independent check in a different session." }),
  role({ id: "integrator", kind: "build", model: "sonnet", tools: ["read", "run"], writeScope: "shared", skippable: "yes", max: 1, signals: ["multi-slice"], when: "More than one slice: joins the slices, owns the shared files, runs the whole suite." }),
  role({ id: "security-reviewer", kind: "check", model: "sonnet", tools: ["read"], writeScope: "none", skippable: "yes", max: 1, mandatoryOnSignal: "security", when: "Auth, crypto, secrets, input handling, shell or SQL, dependency changes, network." }),
  role({ id: "migration-reviewer", kind: "check", model: "sonnet", tools: ["read"], writeScope: "none", skippable: "yes", max: 1, mandatoryOnSignal: "migration", when: "Schema or data migrations, deletes, anything irreversible on data." }),
  role({ id: "a11y-reviewer", kind: "check", model: "haiku", tools: ["read", "browser-read"], writeScope: "none", skippable: "yes", max: 1, signals: ["ui"], when: "UI files changed." }),
  role({ id: "perf-reviewer", kind: "check", model: "sonnet", tools: ["read", "run"], writeScope: "none", skippable: "yes", max: 1, signals: ["performance"], when: "Hot paths, large data, or a stated performance goal." }),
  role({ id: "ui-tester", kind: "check", model: "sonnet", tools: ["browser"], writeScope: "none", skippable: "yes", max: 1, signals: ["ui"], when: "UI files changed: drives the page and reads what it reports." }),
  role({ id: "desktop-tester", kind: "check", model: "sonnet", tools: ["desktop"], writeScope: "none", skippable: "yes", max: 1, signals: ["desktop"], when: "Desktop app tasks; every input asks." }),
  role({ id: "docs-writer", kind: "build", model: "haiku", tools: ["read"], writeScope: "docs", skippable: "yes", max: 1, signals: ["public-behaviour"], when: "Public behaviour changed: README, changelog, usage docs." }),
  role({ id: "gatekeeper", kind: "gate", model: "sonnet", tools: ["read"], writeScope: "none", skippable: "no", max: 1, when: "Always, last, for any task that writes or acts: the final scope and safety gate." }),
  role({ id: "adversary", kind: "check", model: "opus", tools: ["read", "run"], writeScope: "none", skippable: "yes", max: 1, when: "After a stage: tries to break what was built (one per round)." }),
  role({ id: "watchdog", kind: "monitor", model: "haiku", tools: [], writeScope: "none", skippable: "no", max: 1, when: "LIVE web flows: runs beside the team and stops it on a challenge or a ban." }),
  role({ id: "learner", kind: "meta", model: "haiku", tools: [], writeScope: "none", skippable: "yes", max: 1, when: "At the end of a goal: proposes what to remember; never activates it." }),
];

/** Roles that can never be skipped, by the composer or the Overseer (V12). */
export const NEVER_SKIPPABLE: readonly string[] = BUILTIN_ROSTER.filter((r) => r.skippable === "no").map((r) => r.id);

export const isReadOnly = (r: RoleDef): boolean => r.writeScope === "none";

/** What the hook chain lets a role use, from its definition. File writes carry their scope: `write:slice` means "inside the step's slice and nowhere else". */
export function toolClasses(r: RoleDef): string[] {
  return [...r.tools, ...(r.writeScope === "none" ? [] : [`write:${r.writeScope}`])];
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const USER_KINDS: RoleKind[] = ["read", "plan", "advise", "build", "check"];
const READ_ONLY_KINDS: RoleKind[] = ["read", "advise", "check"];
const USER_MODELS: ModelAlias[] = ["haiku", "sonnet", "opus"];
const USER_TOOLS: ToolClassBase[] = ["read", "run", "web", "browser-read"];
const USER_SCOPES: WriteScope[] = ["none", "tests", "docs", "slice"];
const USER_FIELDS = new Set(["kind", "model", "tools", "writeScope", "skippable", "max", "when", "description"]);
const MAX_FILE_BYTES = 20_000;
const MAX_USER_CAP = 6;

export interface RosterProblem {
  file: string;
  reason: string;
}
export interface LoadedRoster {
  roles: RoleDef[];
  /** Definitions that were read and refused, with the reason. */
  rejected: RosterProblem[];
  /** Definitions that were not read at all (a project roster nobody has trusted). */
  ignored: RosterProblem[];
}

function parseUserRole(id: string, raw: string, instructions: string | undefined, taken: Set<string>): RoleDef | string {
  if (!ID_RE.test(id)) return `invalid role id "${id.slice(0, 40)}": lowercase letters, digits and dashes, starting with a letter`;
  if (taken.has(id)) return BUILTIN_ROSTER.some((b) => b.id === id) ? `"${id}" is a built-in role and cannot be redefined` : `"${id}" is already defined`;
  let def: unknown;
  try {
    def = JSON.parse(raw);
  } catch {
    return "the definition is not valid JSON";
  }
  if (typeof def !== "object" || def === null || Array.isArray(def)) return "the definition must be a JSON object";
  const d = def as Record<string, unknown>;
  const unknown = Object.keys(d).filter((k) => !USER_FIELDS.has(k));
  if (unknown.length) return `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => k.slice(0, 30)).join(", ")}`;
  if (!USER_KINDS.includes(d.kind as RoleKind)) return `kind must be one of ${USER_KINDS.join(", ")} (gate, monitor and meta roles are built in)`;
  if (!USER_MODELS.includes(d.model as ModelAlias)) return `model must be one of ${USER_MODELS.join(", ")}`;
  const tools = d.tools ?? ["read"];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) return "tools must be a list of tool names";
  if (tools.includes("write")) return "a write tool needs a writeScope of tests, docs or slice, not a tool name";
  const badTool = (tools as string[]).find((t) => !USER_TOOLS.includes(t as ToolClassBase));
  if (badTool) return `unknown tool "${badTool.slice(0, 30)}" (allowed: ${USER_TOOLS.join(", ")})`;
  const scope = d.writeScope ?? "none";
  if (!USER_SCOPES.includes(scope as WriteScope)) return `writeScope must be one of ${USER_SCOPES.join(", ")}: a role that writes needs a path scope, and "shared" belongs to the integrator`;
  if (READ_ONLY_KINDS.includes(d.kind as RoleKind) && scope !== "none") return `a ${d.kind} role is read-only: it cannot have a write scope (V7)`;
  const max = d.max ?? 1;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_USER_CAP) return `max must be a whole number from 1 to ${MAX_USER_CAP}`;
  if (d.skippable !== undefined && typeof d.skippable !== "boolean") return "skippable must be true or false";
  const signals = d.when === undefined ? [] : d.when;
  if (!Array.isArray(signals) || !signals.every((s) => typeof s === "string" && s.length <= 40)) return "when must be a list of signal names";
  if (d.description !== undefined && (typeof d.description !== "string" || d.description.length > 200)) return "description must be text of at most 200 characters";
  if (instructions === undefined) return `missing instructions file ${id}.md`;
  if (instructions.length > MAX_FILE_BYTES) return `instructions file too large (${instructions.length} bytes; limit ${MAX_FILE_BYTES})`;
  return {
    id, kind: d.kind as RoleKind, model: d.model as ModelAlias, tools: tools as ToolClassBase[], writeScope: scope as WriteScope,
    skippable: d.skippable === false ? "no" : "yes", max: max as number, when: typeof d.description === "string" ? d.description : "A role from your own roster.",
    signals: signals as string[], builtin: false, instructions,
  };
}

function readDir(dir: string, taken: Set<string>, into: LoadedRoster): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a missing directory is not an error
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue; // plain files only: no subdirectories, no links
    const id = e.name.slice(0, -5);
    const file = join(dir, e.name);
    let raw: string, instructions: string | undefined;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) { into.rejected.push({ file, reason: `the definition is too large (limit ${MAX_FILE_BYTES} bytes)` }); continue; }
      raw = readFileSync(file, "utf8");
    } catch {
      into.rejected.push({ file, reason: "the definition could not be read" });
      continue;
    }
    try {
      const md = join(dir, `${id}.md`);
      instructions = statSync(md).size > MAX_FILE_BYTES ? "x".repeat(MAX_FILE_BYTES + 1) : readFileSync(md, "utf8");
    } catch {
      instructions = undefined;
    }
    const parsed = parseUserRole(id, raw, instructions, taken);
    if (typeof parsed === "string") { into.rejected.push({ file, reason: parsed }); continue; }
    taken.add(id);
    into.roles.push(parsed);
  }
}

/** The built-in roles plus the user's own (`userDir`, normally `~/.agent-loop/roster`) and, only when trusted, the project's (`projectDir`). */
export function loadRoster(opts: { userDir?: string; projectDir?: string; trustProject?: boolean } = {}): LoadedRoster {
  const out: LoadedRoster = { roles: [...BUILTIN_ROSTER], rejected: [], ignored: [] };
  const taken = new Set(BUILTIN_ROSTER.map((r) => r.id));
  if (opts.userDir) readDir(opts.userDir, taken, out);
  if (opts.projectDir) {
    if (opts.trustProject) readDir(opts.projectDir, taken, out);
    else {
      try {
        for (const e of readdirSync(opts.projectDir, { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith(".json")) out.ignored.push({ file: join(opts.projectDir, e.name), reason: "a roster inside the project is ignored until you trust it (it could be written by an agent)" });
        }
      } catch { /* none */ }
    }
  }
  return out;
}
