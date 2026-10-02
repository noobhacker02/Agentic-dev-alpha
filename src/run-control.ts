/**
 * The one switch that ends a run early. Whoever decides (the cost cap, Ctrl-C, the Stop button on the page) calls
 * `stop(reason)`; the pipeline owns what happens next: the controller's signal is handed to the model sessions so
 * they stop at once, waiting approvals are refused so nothing keeps asking, the run is recorded as "stopped" with
 * the reason, and the report is still written. The first reason wins; later calls change nothing.
 */
export class RunControl {
  private readonly ctl = new AbortController();
  private why?: string;

  get controller(): AbortController {
    return this.ctl;
  }
  get signal(): AbortSignal {
    return this.ctl.signal;
  }
  get stopped(): boolean {
    return this.ctl.signal.aborted;
  }
  get reason(): string | undefined {
    return this.why;
  }

  /** Returns true for the call that stopped the run, false if it was already stopping. */
  stop(reason: string): boolean {
    if (this.ctl.signal.aborted) return false;
    this.why = reason;
    this.ctl.abort();
    return true;
  }
}
