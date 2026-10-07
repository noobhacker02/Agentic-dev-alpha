// Last-resort handlers for an error nothing caught (adversary round 2, A39 and A41): a rejected promise or a throw inside a callback that nobody awaits ends the whole process, and with it
// the browser (orphaned), the run's terminal state (left "running"), and the report. The first one stops the run the ordinary way so the pipeline's own cleanup runs; a second one, or the
// run not ending within the grace period, quits at once.
import { stripTerminalControlBytes } from "./text-safety.js";

export interface FatalOptions {
  /** Where the events come from: `process`, or anything with `on` and `off` in a test. */
  target: { on(event: string, fn: (err: unknown) => void): unknown; off(event: string, fn: (err: unknown) => void): unknown };
  /** Ends the run the ordinary way (the pipeline stops its sessions, records "stopped" with the reason, writes the report). */
  stop: (reason: string) => void;
  exit: (code: number) => void;
  log: (message: string) => void;
  /** How long the run gets to end after the first error. */
  graceMs?: number;
}

const describe = (err: unknown): string => stripTerminalControlBytes(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, " ").slice(0, 300);

/** Installs the two handlers and returns a function that removes them. */
export function installFatalHandlers(opts: FatalOptions): () => void {
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handle = (kind: string) => (err: unknown): void => {
    seen += 1;
    const what = describe(err);
    if (seen > 1) {
      opts.log(`\nAnother unexpected ${kind} (${what}): quitting now. The run is left unfinished in the audit database.`);
      opts.exit(1);
      return;
    }
    opts.log(`\nUnexpected ${kind}: ${what}\nStopping the run; it will be saved as stopped.`);
    opts.stop(`an unexpected ${kind} (${what})`);
    timer = setTimeout(() => {
      opts.log("\nThe run did not finish stopping in time: quitting now.");
      opts.exit(1);
    }, opts.graceMs ?? 15_000);
    (timer as { unref?: () => void }).unref?.();
  };
  const onError = handle("error");
  const onRejection = handle("rejection");
  opts.target.on("uncaughtException", onError);
  opts.target.on("unhandledRejection", onRejection);
  return () => {
    if (timer) clearTimeout(timer);
    opts.target.off("uncaughtException", onError);
    opts.target.off("unhandledRejection", onRejection);
  };
}
