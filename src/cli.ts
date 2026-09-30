import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
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

// Flags that never take a value. Without this, `--no-approval "<task>"` swallows the task string
// as --no-approval's value (found by test/stress/pipeline_logic.sh case F) — a bare boolean flag
// must never consume the next token just because that token doesn't start with "--".
const BOOLEAN_FLAGS = new Set(["no-approval", "browser", "strict-approval"]);

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

function printInsights(insights: Insights) {
  console.log(`Runs recorded: ${insights.totalRuns}`);
  if (insights.totalRuns === 0) {
    console.log("No runs recorded against this data dir yet.");
    return;
  }
  console.log("By outcome: " + Object.entries(insights.byStatus).map(([s, n]) => `${s}=${n}`).join(", "));
  console.log(`\nTotal cost: $${insights.totalCost.toFixed(2)}`);
  for (const p of insights.byPhase) {
    const cost = insights.costByPhase[p.name];
    console.log(
      `  ${p.name.padEnd(14)} ${p.runs} run(s), repaired in ${p.repairedRuns} ` +
      `(avg ${p.avgAttempts.toFixed(1)} attempt(s))` + (cost ? `, $${cost.toFixed(2)}` : "")
    );
  }
  if (insights.topRules.length) {
    console.log(`\nMost-reused "don't ask again" rules:`);
    for (const r of insights.topRules.slice(0, 10)) console.log(`  ${r.count}x  ${stripTerminalControlBytes(r.rule)}`);
  }
  if (insights.neverReusedRules.length) {
    console.log(`\nCreated but never reused (consider whether these are worth "don't ask again" at all):`);
    for (const r of insights.neverReusedRules) console.log(`  ${stripTerminalControlBytes(r)}`);
  }
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
    const store = new Store(dbPath);
    printInsights(store.getInsights());
    store.close();
    return;
  }

  if (cmd !== "run") {
    console.log(`agent-loop — multi-agent dev-loop orchestrator

Usage:
  agent-loop run "<task description>" [--dir <workDir>] [--port 4173] [--no-approval] [--max-retries 2] [--max-repairs 8] [--data-dir <path>] [--browser] [--desktop-target "<app>"]
  agent-loop insights [--dir <workDir>] [--data-dir <path>]

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

  insights         Self-analysis over every run ever recorded against a --dir's audit database:
                   which phases get repaired most, total and per-phase cost, and which "don't ask
                   again" rules actually get reused vs. created and never touched again. Built
                   entirely from data already recorded for other reasons -- no separate tracking
                   to turn on first.
`);
    process.exit(cmd ? 1 : 0);
  }

  const args = parseArgs(argv.slice(1));
  const task = args._.join(" ").trim();
  if (!task) {
    console.error("Error: no task description given. Usage: agent-loop run \"<task>\"");
    process.exit(1);
  }

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

  const store = new Store(join(dataDir, "agent-loop.db"));
  const bus = new EventBus(store);

  let url: string, close: () => Promise<void>;
  try {
    ({ url, close } = await startServer(bus, port, { artifactRoot: browser || desktopTarget !== undefined ? browserArtifactDir : undefined }));
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
  const terminal = attachTerminal(bus, { interactive, workDir, uiUrl: url });

  let costUsd = 0;
  bus.on("event", (e) => {
    if (e.type === "usage") costUsd += e.costUsd;
  });
  const startedAt = Date.now();

  const run = await runPipeline(
    { task, workDir, requireApproval, strictApproval: !!args["strict-approval"], maxRetriesPerPhase, maxTotalRepairs, uiPort: port, browser, browserArtifactDir, desktop },
    bus,
    store
  );

  terminal.detach();
  console.log(`\nRun ${run.id} finished with status: ${run.status}`);
  console.log(`Cost: $${costUsd.toFixed(2)} · ${Math.round((Date.now() - startedAt) / 1000)}s`);
  try {
    const dir = join(browserArtifactDir, run.id);
    const reportPath = join(dir, "report.html");
    // Announced first, so the saved report itself also says where it lives, and a page still open
    // can show it before the live server goes away.
    bus.emitEvent({ type: "report-saved", runId: run.id, path: reportPath, ts: new Date().toISOString() });
    const report = writeRunReport(dir, bus.allEvents());
    console.log(`Report: file://${report}`);
    await new Promise((r) => setTimeout(r, 300)); // let open pages receive the last events
  } catch (err) {
    console.error(`Could not write the run report: ${err instanceof Error ? err.message : String(err)}`);
  }
  store.close();
  await close();
  process.exit(run.status === "done" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
