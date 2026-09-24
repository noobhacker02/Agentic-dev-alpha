import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { startServer } from "./server.js";
import { runPipeline } from "./pipeline.js";

function parseArgs(argv: string[]) {
  const args = { _: [] as string[] } as Record<string, string | boolean> & { _: string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
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

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd !== "run") {
    console.log(`agent-loop — multi-agent dev-loop orchestrator

Usage:
  agent-loop run "<task description>" [--dir <workDir>] [--port 4173] [--no-approval] [--max-retries 2]

  --dir            Working directory the agents operate in (default: ./agent-loop-workspace, created if missing)
  --port           Port for the live event/approval UI (default: 4173)
  --no-approval    Skip the human-approval UI; only the built-in safety-pattern hook applies
  --max-retries    Max Overseer-triggered retries per phase before forcing a stop (default: 2)
`);
    process.exit(cmd ? 1 : 0);
  }

  const args = parseArgs(argv.slice(1));
  const task = args._.join(" ").trim();
  if (!task) {
    console.error("Error: no task description given. Usage: agent-loop run \"<task>\"");
    process.exit(1);
  }

  const workDir = resolve(String(args.dir ?? "./agent-loop-workspace"));
  mkdirSync(workDir, { recursive: true });
  const dataDir = join(workDir, ".agent-loop");
  mkdirSync(dataDir, { recursive: true });

  const port = Number(args.port ?? 4173);
  const requireApproval = !args["no-approval"];
  const maxRetriesPerPhase = Number(args["max-retries"] ?? 2);

  const store = new Store(join(dataDir, "agent-loop.db"));
  const bus = new EventBus(store);

  const { url, close } = await startServer(bus, port);
  console.log(`agent-loop UI: ${url}`);
  console.log("  (open this exact URL: the #token part is what lets the page approve tool calls)");
  console.log(`Working directory: ${workDir}`);
  console.log(`Approval UI: ${requireApproval ? "ON — every non-read tool call waits for you" : "OFF"}`);
  console.log(`Task: ${task}\n`);

  const run = await runPipeline({ task, workDir, requireApproval, maxRetriesPerPhase, uiPort: port }, bus, store);

  console.log(`\nRun ${run.id} finished with status: ${run.status}`);
  store.close();
  await close();
  process.exit(run.status === "done" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
