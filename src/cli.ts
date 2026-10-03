import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EventBus } from "./bus.js";
import { Store, type Insights } from "./store.js";
import { startServer } from "./server.js";
import { runPipeline } from "./pipeline.js";
import { resolveDataDir } from "./data-dir.js";
import { writeRunReport } from "./report.js";
import { attachTerminal } from "./terminal.js";
import { PHASES } from "./types.js";
import { stripTerminalControlBytes } from "./text-safety.js";
import { resolveDesktopTarget, type ResolvedDesktop } from "./desktop-tools.js";
import { classifyDeniedTarget, deniedTargetMessage } from "./desktop-policy.js";
import { RunControl } from "./run-control.js";
import { diagnoseDesktop, doctorExitCode, realProbes, renderDoctor, runDoctor } from "./doctor.js";
import { LineageTracker, buildLineage, renderLineageMarkdown, renderLineageText } from "./lineage.js";
import { PersonaDirector, insightsLine, parseHumor, type HumorLevel } from "./persona.js";
import { roast, roastWithModel, type Habits } from "./roast.js";
import { rosterCommand, teamCommand, type CommandResult } from "./team/cli-commands.js";

// Flags that never take a value. Without this, `--no-approval "<task>"` swallows the task string
// as --no-approval's value (found by test/stress/pipeline_logic.sh case F) — a bare boolean flag
// must never consume the next token just because that token doesn't start with "--".
const BOOLEAN_FLAGS = new Set(["no-approval", "browser", "strict-approval", "plain", "desktop", "dry-run", "json", "trust-project"]);

function parseArgs(argv: string[]) {
  const args = { _: [] as string[] } as Record<string, string | boolean> & { _: string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/** A finite, non-negative integer, or the CLI exits with a clear error rather than silently
 * producing NaN (found by pipeline_logic.sh case B: `--max-retries abc` made every retry-budget
 * comparison `x > NaN`, which is always false, so the pipeline could never stop retrying). */
function parseNonNegativeInt(raw: string | boolean | undefined, flagName: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") {
    console.error(`Error: --${flagName} requires a numeric value.`);
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Error: --${flagName} must be a non-negative integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
}

/** --max-cost <usd>: a positive number, or the CLI exits with a clear error. */
function parseMaxCost(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Error: --max-cost needs a positive amount in US dollars, e.g. --max-cost 5 (got ${typeof raw === "string" ? `"${raw}"` : "nothing"}).`);
    process.exit(1);
  }
  return n;
}

/** --humor (or $AGENT_LOOP_HUMOR): how much the agents joke around. Dark by default in the UI; the
 * terminal only shows it on a TTY unless it was asked for outright, so logs and CI stay plain. */
function readHumor(args: Record<string, string | boolean>): { level: HumorLevel; explicit: boolean } {
  const raw = args.humor ?? process.env.AGENT_LOOP_HUMOR;
  const level = parseHumor(raw, "dark");
  if (level === undefined) {
    console.error(`Error: --humor must be off, dry or dark, got "${String(raw)}".`);
    process.exit(1);
  }
  return { level, explicit: raw !== undefined };
}

function printInsights(insights: Insights) {
  console.log(`Runs recorded: ${insights.totalRuns}`);
  if (insights.totalRuns === 0) {
    console.log("No runs recorded against this data dir yet.");
    return;
  }
  console.log("By outcome: " + Object.entries(insights.byStatus).map(([s, n]) => `${s}=${n}`).join(", "));
  if (insights.byStatus.running) console.log(`  (running=${insights.byStatus.running}: still going, or the process was closed or force-quit before it could finish; Ctrl-C and the page's stop button do finish a run)`);
  console.log(`\nTotal cost: $${insights.totalCost.toFixed(2)}`);
  for (const p of insights.byPhase) {
    const cost = insights.costByPhase[p.name];
    console.log(
      `  ${stripTerminalControlBytes(String(p.name)).padEnd(14)} ${p.runs} run(s), repaired in ${p.repairedRuns} ` +
      `(avg ${p.avgAttempts.toFixed(1)} attempt(s))` + (cost ? `, $${cost.toFixed(2)}` : "")
    );
  }
  const dk = insights.desktop;
  if (dk.sessions > 0 || dk.captures > 0) {
    const sent = Object.values(dk.actions).reduce((n, a) => n + a.sent, 0);
    const refused = Object.values(dk.actions).reduce((n, a) => n + a.refused, 0);
    const byTool = Object.entries(dk.actions).filter(([, a]) => a.sent > 0).map(([t, a]) => `${t} ${a.sent}`).join(", ");
    console.log(`\nDesktop tools: ${dk.sessions} session(s), ${dk.captures} capture(s)`);
    console.log(`  input actions sent: ${sent}${byTool ? ` (${byTool})` : ""}; stopped by the tools' own checks or the driver: ${refused}`);
    console.log(`  human answers: ${dk.humanApproved} approved, ${dk.humanDenied} denied`);
  }
  if (insights.topRules.length) {
    console.log(`\nMost-reused "don't ask again" rules:`);
    for (const r of insights.topRules.slice(0, 10)) console.log(`  ${r.count}x  ${stripTerminalControlBytes(r.rule)}`);
  }
  if (insights.neverReusedRules.length) {
    console.log(`\nCreated but never reused (consider whether these are worth "don't ask again" at all):`);
    for (const r of insights.neverReusedRules.slice(0, 10)) console.log(`  ${stripTerminalControlBytes(r)}`);
    if (insights.neverReusedRules.length > 10) console.log(`  …and ${insights.neverReusedRules.length - 10} more`);
  }
}

type RoastMode = "off" | "offline" | "api";

/** --roast (or $AGENT_LOOP_ROAST): where `insights` gets its lines about your habits. --humor off turns it off whatever this says. */
function readRoastMode(args: Record<string, string | boolean>, humor: { level: HumorLevel }): RoastMode {
  const raw = args.roast ?? process.env.AGENT_LOOP_ROAST;
  if (raw !== undefined && raw !== "off" && raw !== "offline" && raw !== "api") {
    console.error(`Error: --roast must be off, offline or api, got "${String(raw)}".`);
    process.exit(1);
  }
  if (humor.level === "off" || raw === "off") return "off";
  return raw === "api" ? "api" : "offline";
}

/**
 * What `insights` says about you, after the numbers. Lines come from src/roast.ts (built in, free, the same every
 * time for the same numbers) or, with --roast api, from a model that is given the numbers and nothing else. Like the
 * rest of the persona it is shown on a TTY, or when asked for outright, so logs and CI stay plain.
 */
async function printVoice(insights: Insights, habits: Habits, humor: { level: HumorLevel; explicit: boolean }, mode: RoastMode, asked: boolean) {
  if (mode === "off" || !(humor.explicit || asked || process.stdout.isTTY)) return;
  const base = roast(habits, humor.level);
  let lines = base.lines;
  let note: string | undefined;
  if (mode === "api" && lines.length) {
    const { claudeGenerate, DEFAULT_ROAST_MODEL } = await import("./roast-api.js");
    const model = process.env.AGENT_LOOP_ROAST_MODEL || DEFAULT_ROAST_MODEL;
    const fresh = await roastWithModel(habits, humor.level, claudeGenerate(model));
    if (fresh.lines.length) {
      lines = fresh.lines;
      note = `written fresh by ${model} from the numbers above and nothing else, $${fresh.costUsd.toFixed(4)}`;
    } else note = fresh.note;
  }
  if (!lines.length) {
    const quip = insightsLine(insights, humor.level);
    if (quip) console.log(`\n  ◦ ${quip}`);
  } else {
    console.log("\n  How it has actually been going");
    for (const l of lines) console.log(`    ◦ ${l}`);
    for (const t of base.tips) console.log(`    → ${t}`);
  }
  if (habits.runs > 0) {
    console.log(`\n  Report card: ${base.grade}${base.gradeComment ? `   ${base.gradeComment}` : ""}`);
    console.log("  (for fun: a rough score made up from the numbers above, not a measure of your work)");
  }
  if (note) console.log(`  (${note})`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "insights") {
    const args = parseArgs(argv.slice(1));
    const workDir = resolve(String(args.dir ?? "./agent-loop-workspace"));
    const dataDirOverride = typeof args["data-dir"] === "string" ? args["data-dir"] : process.env.AGENT_LOOP_DATA_DIR;
    const dataDir = resolveDataDir(workDir, dataDirOverride);
    const dbPath = join(dataDir, "agent-loop.db");
    if (!existsSync(dbPath)) {
      console.error(`No audit database found at ${dbPath} -- has "agent-loop run" ever been used against this --dir?`);
      process.exit(1);
    }
    const humor = readHumor(args);
    const mode = readRoastMode(args, humor);
    const store = new Store(dbPath);
    const insights = store.getInsights();
    const habits = store.getHabits();
    store.close();
    printInsights(insights);
    await printVoice(insights, habits, humor, mode, args.roast !== undefined || process.env.AGENT_LOOP_ROAST !== undefined);
    return;
  }

  if (cmd === "doctor") {
    const args = parseArgs(argv.slice(1));
    const workDir = resolve(String(args.dir ?? "./agent-loop-workspace"));
    const dataDirOverride = typeof args["data-dir"] === "string" ? args["data-dir"] : process.env.AGENT_LOOP_DATA_DIR;
    const checks = await runDoctor(realProbes(), { dataDir: resolveDataDir(workDir, dataDirOverride), desktop: args.desktop === true });
    console.log(`agent-loop doctor\n\n${stripTerminalControlBytes(renderDoctor(checks))}`);
    process.exit(doctorExitCode(checks));
  }

  if (cmd === "lineage") {
    const args = parseArgs(argv.slice(1));
    const workDir = resolve(String(args.dir ?? "./agent-loop-workspace"));
    const dataDirOverride = typeof args["data-dir"] === "string" ? args["data-dir"] : process.env.AGENT_LOOP_DATA_DIR;
    const dbPath = join(resolveDataDir(workDir, dataDirOverride), "agent-loop.db");
    if (!existsSync(dbPath)) {
      console.error(`No audit database found at ${dbPath} -- has "agent-loop run" ever been used against this --dir?`);
      process.exit(1);
    }
    const store = new Store(dbPath);
    const wanted = typeof args.run === "string" ? args.run : "latest";
    const runs = store.listRuns(200);
    const byPrefix = runs.filter((r) => r.id.startsWith(wanted));
    const run = wanted === "latest" ? runs[0] : runs.find((r) => r.id === wanted) ?? (byPrefix.length === 1 ? byPrefix[0] : undefined);
    if (!run && byPrefix.length > 1) {
      console.error(`"${stripTerminalControlBytes(wanted)}" matches ${byPrefix.length} runs; give more of the id.`);
      store.close();
      process.exit(1);
    }
    if (!run) {
      console.error(runs.length ? `No run matches "${stripTerminalControlBytes(wanted)}". Recorded runs:\n${runs.slice(0, 10).map((r) => `  ${r.id}  ${r.status}  ${stripTerminalControlBytes(r.task).slice(0, 60)}`).join("\n")}` : "No runs recorded against this data dir yet.");
      store.close();
      process.exit(1);
    }
    const lineage = buildLineage(store.getRunEvents(run.id), run.id);
    store.close();
    console.log(args.json ? JSON.stringify(lineage, null, 2) : args.markdown ? renderLineageMarkdown(lineage) : renderLineageText(lineage));
    return;
  }

  if (cmd === "roster" || cmd === "team") {
    const args = parseArgs(argv.slice(1));
    const r: CommandResult = cmd === "roster" ? rosterCommand(args) : teamCommand(args);
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    process.exitCode = r.code;
    return;
  }

  if (cmd !== "run") {
    console.log(`agent-loop — multi-agent dev-loop orchestrator

Usage:
  agent-loop run "<task description>" [--dir <workDir>] [--port 4173] [--no-approval] [--max-retries 2] [--max-repairs 8] [--data-dir <path>] [--browser] [--desktop-target "<app>"] [--humor off|dry|dark] [--plain] [--max-cost <usd>]
  agent-loop insights [--dir <workDir>] [--data-dir <path>] [--humor off|dry|dark] [--roast off|offline|api]
  agent-loop doctor [--dir <workDir>] [--data-dir <path>] [--desktop]
  agent-loop lineage [--run <id|latest>] [--json|--markdown] [--dir <workDir>] [--data-dir <path>]
  agent-loop roster [--dir <workDir>] [--trust-project] [--json]
  agent-loop team "<task>" --dry-run [--dir <workDir>] [--cap <n>] [--trust-project] [--json]

  --dir            Working directory the agents operate in (default: ./agent-loop-workspace, created if missing)
  --port           Port for the live event/approval UI (default: 4173)
  --no-approval    Skip the human-approval UI; only the built-in safety-pattern hook applies
  --strict-approval  Ask about every shell command too, even ones that only read inside --dir
  --max-retries    Max same-phase retries before the pipeline gives up on that phase (default: 2)
  --max-repairs    Max total repairs across the whole run, including ones routed to an earlier
                   phase (default: 4x the phase count) — bounds builder<->verifier repair loops
  --data-dir       Where the audit database lives (default: ~/.agent-loop, or $AGENT_LOOP_HOME) —
                   always outside --dir, since the agents have Write/Edit/Bash access there
  --browser        Give builder and verifier real headless-Chromium browser tools (Stage 1:
                   http://localhost/127.0.0.1 URLs only). Off by default.
  --desktop-target Let builder and verifier see and operate exactly one already-running desktop
                   window, named here (matched against its title, app name or process). Every
                   action needs a human's approval, one at a time. Refused with --no-approval, and
                   refused for terminals, shells, IDEs, launchers, browsers, remote-desktop and
                   password-manager windows. Needs the optional @trycua/cua-driver package.

  --max-cost       Stop the run (saved as "stopped", report still written) once this many US dollars have been
                   spent. Checked after each phase attempt and Overseer call, so a single long step can pass it.
                   Ctrl-C and the page's Stop button end a run the same way; a second Ctrl-C quits at once.

  --plain          Start the page with every cartoon off: the cat, pixel icons and cursors, the dinosaur
                   game and sound (or $AGENT_LOOP_PLAIN=1). The page's "cartoons" button, the ? window
                   and ?plain=1 on its address do the same in the browser. Nothing else changes.

  --humor          How much the agents joke around: off, dry, or dark (default, or $AGENT_LOOP_HUMOR).
                   Display only: it never reaches a model and never appears inside an approval prompt.
                   The web page can turn it down; the terminal shows it only on a TTY unless this is
                   given explicitly. See docs/PERSONA.md.

  doctor           What is missing or broken on this machine, in plain words, before a run finds out: Node and
                   node:sqlite, the audit folder, credentials, Chromium, ffmpeg, and for --desktop-target the
                   display (none / set but dead), a locked screen, and the driver (missing / wrong version / not
                   answering). Desktop problems only block with --desktop. Exits 1 only when something blocking is found.

  lineage          The tree of a recorded run: every phase attempt, who handed what to whom, repairs as
                   branches, which agent wrote which files (only writes that succeeded), cost and prompts per
                   attempt. Read-only, rebuilt from the run's stored events; --run takes an id, a unique
                   prefix, or "latest". Every run also writes lineage.md and lineage.json next to its report.

  roster           Who can be on a team: the built-in roles (what each may use and write, how many, whether it can be
                   skipped), then your own roles from ~/.agent-loop/roster (or $AGENT_LOOP_HOME), then every definition
                   that was refused or ignored and why. A roster inside the project is ignored until --trust-project.

  team             Shows the team a task would get, without running anything: each member, why it is there, and why
                   the team is this size. Offline: no model, no network. Reads the PATHS in --dir, never the text inside
                   the files. Exits 2 when no team fits --cap (default 12). Running a composed team comes later.

  insights         Self-analysis over every run ever recorded against a --dir's audit database:
                   which phases get repaired most, total and per-phase cost, and which "don't ask
                   again" rules actually get reused vs. created and never touched again. Built
                   entirely from data already recorded for other reasons -- no separate tracking
                   to turn on first. Then a few lines about how you have actually been using it
                   (fast approvals, denied-then-allowed, money into failed runs...), a tip or two,
                   and a grade: --roast offline (default) is built in and free; --roast api has a
                   Claude model write fresh lines from the numbers only (a few cents at most, model
                   $AGENT_LOOP_ROAST_MODEL); --roast off, or --humor off, turns it off.
                   Nothing you typed (tasks, commands, rules, paths) is ever used or sent.
`);
    process.exit(cmd ? 1 : 0);
  }

  const args = parseArgs(argv.slice(1));
  const task = args._.join(" ").trim();
  if (!task) {
    console.error("Error: no task description given. Usage: agent-loop run \"<task>\"");
    process.exit(1);
  }

  const humor = readHumor(args);
  // --plain (or $AGENT_LOOP_PLAIN=1): the page starts with every cartoon off (and so does the saved report). A browser can still choose otherwise.
  const plain = args.plain === true || /^(1|on|true|yes)$/i.test(process.env.AGENT_LOOP_PLAIN ?? "");

  // Desktop control is checked before anything else starts -- no approval UI, no store, no driver --
  // for everything that can be decided from the command line alone.
  const desktopTargetArg = args["desktop-target"];
  if (desktopTargetArg !== undefined && (typeof desktopTargetArg !== "string" || !desktopTargetArg.trim())) {
    console.error('Error: --desktop-target needs the name of one app or window, e.g. --desktop-target "My App".');
    process.exit(1);
  }
  const desktopTarget = typeof desktopTargetArg === "string" ? desktopTargetArg.trim() : undefined;
  if (desktopTarget !== undefined) {
    if (args["no-approval"]) {
      console.error("Error: --desktop-target can't be used with --no-approval. Every desktop action needs a human to approve it.");
      process.exit(1);
    }
    const denied = classifyDeniedTarget([desktopTarget]);
    if (denied) {
      console.error(`Error: --desktop-target refused. ${stripTerminalControlBytes(deniedTargetMessage(denied))}`);
      process.exit(1);
    }
  }

  const workDir = resolve(String(args.dir ?? "./agent-loop-workspace"));
  mkdirSync(workDir, { recursive: true });
  const dataDirOverride = typeof args["data-dir"] === "string" ? args["data-dir"] : process.env.AGENT_LOOP_DATA_DIR;
  const dataDir = resolveDataDir(workDir, dataDirOverride);
  mkdirSync(dataDir, { recursive: true });

  const port = parseNonNegativeInt(args.port, "port", 4173);
  const requireApproval = !args["no-approval"];
  const maxRetriesPerPhase = parseNonNegativeInt(args["max-retries"], "max-retries", 2);
  const maxTotalRepairs = parseNonNegativeInt(args["max-repairs"], "max-repairs", PHASES.length * 4);
  const browser = !!args.browser;
  const browserArtifactDir = join(dataDir, "browser-artifacts");
  const maxCost = parseMaxCost(args["max-cost"]);

  const store = new Store(join(dataDir, "agent-loop.db"));
  const bus = new EventBus(store);

  // One switch ends the run early: the cost cap, Ctrl-C, SIGTERM, or the Stop button on the page. The pipeline does the rest
  // (stops the model sessions, refuses waiting approvals, records "stopped" with the reason, still writes the report).
  const control = new RunControl();
  let signalExit: number | undefined;
  let interrupts = 0;
  const onSignal = (name: "SIGINT" | "SIGTERM") => {
    const code = name === "SIGINT" ? 130 : 143;
    if (++interrupts > 1) {
      console.error("\nInterrupted again: quitting now. The run is left unfinished in the audit database.");
      process.exit(code);
    }
    signalExit = code;
    console.error(`\n${name === "SIGINT" ? "Ctrl-C" : "Terminated"}: stopping the run. It will be saved as stopped; interrupt again to quit at once.`);
    control.stop(name === "SIGINT" ? "you pressed Ctrl-C" : "the process was terminated");
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let url: string, close: () => Promise<void>;
  try {
    ({ url, close } = await startServer(bus, port, { artifactRoot: browser || desktopTarget !== undefined ? browserArtifactDir : undefined, humor: humor.level, plain, onStop: () => control.stop("you pressed Stop on the page") }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      msg.includes("EADDRINUSE")
        ? `Error: port ${port} is already in use. Pick another with --port <number>.`
        : `Error: failed to start the UI server: ${msg}`
    );
    store.close();
    process.exit(1);
  }
  const interactive = requireApproval && !!process.stdin.isTTY;
  console.log(`agent-loop UI: ${url}`);
  console.log("  (open this exact URL: the #token part is what lets the page approve tool calls)");
  console.log(`Working directory: ${workDir}`);
  console.log(`Audit database:    ${join(dataDir, "agent-loop.db")}`);
  console.log(
    `Approvals: ${!requireApproval ? "OFF" : interactive ? "ON — answer here (1/2/3) or in the web UI" : "ON — answer in the web UI"}`
  );
  if (maxCost !== undefined) console.log(`Cost cap: $${maxCost.toFixed(2)} (checked after each phase attempt and Overseer call, so one long step can pass it)`);
  console.log(`Browser tools: ${browser ? "ON — builder/verifier get real Chromium (localhost only)" : "OFF"}`);

  // The approval UI is up, so a human can be reached; now load the driver and pin down the one window.
  let desktop: ResolvedDesktop | undefined;
  if (desktopTarget !== undefined) {
    let driver: Awaited<ReturnType<typeof import("./desktop-driver-cua.js").openCuaDriver>> | undefined;
    try {
      const { openCuaDriver } = await import("./desktop-driver-cua.js");
      driver = await openCuaDriver();
      desktop = await resolveDesktopTarget({ target: desktopTarget, driver, requireApproval });
    } catch (err) {
      await driver?.close().catch(() => {});
      console.error(`Error: desktop target not available. ${stripTerminalControlBytes(err instanceof Error ? err.message : String(err))}`);
      // Say which kind of problem it is (no display, a locked screen, a driver that is missing or silent): the cause decides the fix.
      try {
        const found = (await diagnoseDesktop(realProbes())).filter((c) => c.level === "fail" || c.level === "warn");
        for (const c of found) console.error(stripTerminalControlBytes(`  ${c.title}: ${c.detail}${c.fix ? ` → ${c.fix}` : ""}`));
      } catch { /* the diagnosis is a courtesy */ }
      store.close();
      await close();
      process.exit(1);
    }
    console.log(`Desktop tools: ON — builder/verifier may see and operate ONLY ${stripTerminalControlBytes(desktop.describeTarget())}`);
    console.log(`  driver ${stripTerminalControlBytes(desktop.driverVersion)}; every input action asks, one at a time`);
  } else {
    console.log("Desktop tools: OFF");
  }
  console.log(`Task: ${task}`);
  const terminal = attachTerminal(bus, { interactive, workDir, uiUrl: url, persona: humor.level !== "off" && (humor.explicit || !!process.stdout.isTTY) });
  const persona = new PersonaDirector(bus, { level: humor.level }).attach();
  const lineageTracker = new LineageTracker(bus).attach();

  let costUsd = 0;
  bus.on("event", (e) => {
    if (e.type === "usage") costUsd += e.costUsd;
    if (maxCost !== undefined && costUsd >= maxCost) control.stop(`the cost cap of $${maxCost.toFixed(2)} was reached ($${costUsd.toFixed(2)} spent)`);
  });
  const startedAt = Date.now();

  const run = await runPipeline(
    { task, workDir, requireApproval, strictApproval: !!args["strict-approval"], maxRetriesPerPhase, maxTotalRepairs, uiPort: port, browser, browserArtifactDir, desktop, control },
    bus,
    store
  );

  terminal.detach();
  persona.detach();
  console.log(`\nRun ${run.id} finished with status: ${run.status}`);
  console.log(`Cost: $${costUsd.toFixed(2)} · ${Math.round((Date.now() - startedAt) / 1000)}s`);
  try {
    const dir = join(browserArtifactDir, run.id);
    const reportPath = join(dir, "report.html");
    // Announced first, so the saved report itself also says where it lives, and a page still open
    // can show it before the live server goes away.
    bus.emitEvent({ type: "report-saved", runId: run.id, path: reportPath, ts: new Date().toISOString() });
    // The run's tree, kept next to its report: lineage.md to read, lineage.json to process. Rebuilt from the
    // stored events, so it matches what `agent-loop lineage` prints later.
    const lineage = buildLineage(store.getRunEvents(run.id), run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lineage.md"), renderLineageMarkdown(lineage));
    writeFileSync(join(dir, "lineage.json"), JSON.stringify(lineage, null, 2));
    // A real file URL: `file://` + a Windows path is not one (backslashes, no third slash), and the terminal would not make it a link.
    console.log(`Lineage: ${pathToFileURL(join(dir, "lineage.md")).href}`);
    const report = writeRunReport(dir, bus.allEvents(), humor.level, plain);
    console.log(`Report: ${pathToFileURL(report).href}`);
    await new Promise((r) => setTimeout(r, 300)); // let open pages receive the last events
  } catch (err) {
    console.error(`Could not write the run report: ${err instanceof Error ? err.message : String(err)}`);
  }
  lineageTracker.detach();
  store.close();
  await close();
  process.exit(signalExit ?? (run.status === "done" ? 0 : 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
