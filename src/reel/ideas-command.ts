// `agent-loop ideas [list | decide <id> yes|no | purge [--days N]]`: the user's side of the ideas table (docs/REEL-FLOW.md, step 9).
// Nothing here builds anything: a yes is only recorded; the dev-flow hand-off is a later stage. Each printed field is one line of printable ASCII (A141).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentLoopHome } from "../data-dir.js";
import { stripTerminalControlBytes } from "../text-safety.js";
import type { CommandResult, ParsedArgs } from "../team/cli-commands.js";
import { Ideas } from "./ideas.js";

const clean = (s: unknown, n = 400): string => stripTerminalControlBytes(String(s ?? "")).replace(/\s+/g, " ").trim().replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const shown = (v: unknown): string => (typeof v === "string" ? `"${clean(v, 20)}"` : "nothing");
const USAGE = "Usage: agent-loop ideas [list] | agent-loop ideas decide <id> yes|no | agent-loop ideas purge [--days <n>]\n";
const SUBCOMMANDS = new Set(["list", "decide", "purge"]);

/** `isTTY`: whether stdin is a terminal (the CLI passes `process.stdin.isTTY === true`). `decide` needs a person there; unset means not a terminal (A158). */
export interface IdeasDeps { home?: string; clock?: () => number; isTTY?: boolean }
/** the flag a person gives to say they are at the keyboard when stdin is not a terminal (A158) */
const YES_HERE = "yes-i-am-here";

export function ideasCommand(args: ParsedArgs, deps: IdeasDeps): CommandResult {
  // any exception (a foreign or damaged ideas.db, a disk error) becomes one printable line and exit 1, never a stack trace
  try { return runIdeas(args, deps); } catch (e) {
    return { out: "", err: `Error: ${clean(`the ideas file cannot be used: ${String((e as Error)?.message ?? e)}`)}\n`, code: 1 };
  }
}

function runIdeas(args: ParsedArgs, deps: IdeasDeps): CommandResult {
  const fail = (message: string): CommandResult => ({ out: "", err: `Error: ${clean(message)}\n`, code: 1 });
  const sub = args._[0] ?? "list";
  if (!SUBCOMMANDS.has(sub)) return { out: "", err: USAGE, code: 1 };
  const flags = Object.keys(args).filter((k) => k !== "_");
  if (sub === "list") {
    if (args._.length > 1) return fail(`list takes no words after it (got ${shown(args._[1])}).`);
    if (flags.length) return fail(`list takes no flags (got --${clean(flags[0], 20)}).`);
  }
  if (sub === "purge") {
    if (args._.length > 1) return fail(`purge takes --days <n>, not a bare number (got ${shown(args._[1])}).`);
    const other = flags.find((k) => k !== "days");
    if (other !== undefined) return fail(`purge takes only --days (got --${clean(other, 20)}).`);
  }

  let days = 30;
  if (sub === "purge" && args.days !== undefined) {
    const n = typeof args.days === "string" && /^\d+$/.test(args.days) ? Number(args.days) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) return fail(`--days needs a positive whole number (got ${shown(args.days)}).`);
    days = n;
  }
  const idArg = args._[1];
  const word = args._[2];
  if (sub === "decide") {
    const n = typeof idArg === "string" && /^\d+$/.test(idArg) ? Number(idArg) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) return fail(`an idea is a whole number from the list, such as 3 (got ${shown(idArg)}).`);
    if (word !== "yes" && word !== "no") return fail(`say yes or no (got ${shown(word)}).`);
    if (args._.length !== 3) return fail("decide takes exactly an id and yes or no.");
    const other = flags.find((k) => k !== YES_HERE);
    if (other !== undefined) return fail(`decide takes no flags (got --${clean(other, 20)}).`);
    if (deps.isTTY !== true && args[YES_HERE] !== true) return fail("decide needs a person at a terminal (stdin is not a terminal). Run it in one, or add --yes-i-am-here if you are the person deciding.");
  }

  const home = deps.home ?? agentLoopHome();
  try { mkdirSync(home, { recursive: true, mode: 0o700 }); } catch (e) { return fail(`the agent-loop directory cannot be made: ${String((e as NodeJS.ErrnoException).code ?? e)}`); }
  const ideas = new Ideas(join(home, "ideas.db"), deps.clock);
  try {
    if (sub === "list") {
      const rows = ideas.list();
      if (rows.length === 0) return { out: "No ideas yet.\n", err: "", code: 0 };
      // the verdict and the code's reason, then the reader's summary: one line each (A158)
      const lines = rows.map((r) => `#${r.id} [${clean(r.decision, 20)}] ${clean(r.verdict, 40)} (${clean(r.reason, 70)}) - ${clean(r.about, 100)}`);
      return { out: lines.join("\n") + "\n", err: "", code: 0 };
    }
    if (sub === "decide") {
      const id = Number(idArg);
      const row = ideas.getById(id);
      if (!row) return fail(`there is no idea #${id}.`);
      // the program's refusal is final for a yes: the user can decline it, not approve it (A158)
      if (word === "yes" && row.verdict === "refuse") return fail(`idea #${id} was refused by the program (${clean(row.reason, 200)}); it cannot be approved`);
      if (!ideas.decide(id, word as "yes" | "no")) return fail(`idea #${id} is already decided (${clean(row.decision, 20)}); it stays that way.`);
      return { out: word === "yes" ? "Recorded. Nothing has been built; the dev-flow hand-off is a later stage.\n" : "Recorded. Nothing will be built.\n", err: "", code: 0 };
    }
    const n = ideas.purge(days);
    return { out: `Purged ${n} idea${n === 1 ? "" : "s"}.\n`, err: "", code: 0 };
  } finally { ideas.close(); }
}
