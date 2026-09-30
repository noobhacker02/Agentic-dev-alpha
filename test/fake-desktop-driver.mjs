// A scripted stand-in for the desktop driver, at the `DesktopDriver` interface the tools use
// (src/desktop-tools.ts). Tests cost nothing, run anywhere (no display, no native library), and can
// simulate what a real desktop does to a careless tool: a window swapped out from under an approval,
// a process id reused, a missing accessibility tree, hostile text on screen, other windows whose
// titles must never leak.
//
// What this fake does NOT exercise -- and what covers it instead: the real native driver (test/
// desktop-real.mjs, under Xvfb + a window manager) and the adapter's own call discipline against a
// stand-in SDK (test/desktop-adapter.mjs). Keeping that list explicit is the lesson from the fake SDK
// that never emitted cost data: a fake is only as good as the behavior it admits it leaves out.

/** A valid 1x1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

export const TARGET = { pid: 4242, windowId: "8388611" };

export function makeWindow(over = {}) {
  return { pid: TARGET.pid, windowId: TARGET.windowId, appName: "Tk", title: "AgentLoop Test App", bounds: { x: 60, y: 80, width: 420, height: 260 }, ...over };
}

export class FakeDesktopDriver {
  constructor(opts = {}) {
    this.version = opts.version ?? "0.30.4";
    this.windows = opts.windows ?? [makeWindow()];
    this.identities = new Map(
      Object.entries(opts.identities ?? { [TARGET.pid]: { name: "python3.12", exe: "/usr/bin/python3.12", argv0: "/usr/bin/python3.12", script: "/opt/app/app.py" } }).map(
        ([pid, id]) => [Number(pid), id]
      )
    );
    /** Every call the tools make, in order: [method, ...args]. */
    this.calls = [];
    this.elements = opts.elements ?? [
      { index: 0, role: "window", label: "AgentLoop Test App", token: "s1:0", depth: 0 },
      { index: 1, role: "push button", label: "Increment", token: "s1:1", depth: 1, enabled: true },
      { index: 2, role: "text", label: "Name", value: "alice", token: "s1:2", depth: 1 },
    ];
    this.degraded = opts.degraded ?? false;
    this.inputResult = opts.inputResult ?? { ok: true, summary: "done" };
    /** Hooks a test sets to do something to the world at a precise moment. */
    this.onCapture = undefined;
    this.onInput = undefined;
    /** When true, input calls never answer: a hung native driver. */
    this.hang = false;
    /** Rewrite a capture before it's returned, to simulate a misbehaving native driver. */
    this.mutateCapture = undefined;
    this.closeError = undefined;
    this.snapshotN = 0;
    this.capWidth = opts.capWidth ?? 420;
    this.capHeight = opts.capHeight ?? 260;
  }

  async listWindows(pid) {
    this.calls.push(["listWindows", pid]);
    return this.windows.filter((w) => pid === undefined || w.pid === pid).map((w) => ({ ...w, bounds: { ...w.bounds } }));
  }

  async processIdentity(pid) {
    this.calls.push(["processIdentity", pid]);
    return this.identities.get(pid);
  }

  async capture(w) {
    this.calls.push(["capture", { ...w }]);
    await this.onCapture?.(this);
    const win = this.windows.find((x) => x.pid === w.pid && x.windowId === w.windowId);
    if (!win) throw new Error("no such window");
    const cap = {
      snapshotId: `s${String(++this.snapshotN).padStart(8, "0")}`,
      bounds: { ...win.bounds },
      width: this.capWidth,
      height: this.capHeight,
      png: TINY_PNG,
      elements: this.degraded ? [this.elements[0]] : this.elements,
      degraded: this.degraded,
      degradedReason: this.degraded ? "atspi_walk_failed: fake" : undefined,
      truncated: false,
    };
    return this.mutateCapture ? this.mutateCapture(cap) : cap;
  }

  async #input(name, ...args) {
    this.calls.push([name, ...args]);
    if (this.hang) await new Promise(() => {}); // never answers
    await this.onInput?.(this, name);
    return this.inputResult;
  }

  click(w, p) {
    return this.#input("click", { ...w }, { ...p });
  }
  clickElement(w, token) {
    return this.#input("clickElement", { ...w }, token);
  }
  typeText(w, text) {
    return this.#input("typeText", { ...w }, text);
  }
  pressKey(w, key, modifiers) {
    return this.#input("pressKey", { ...w }, key, [...modifiers]);
  }

  async close() {
    this.calls.push(["close"]);
    if (this.closeError) throw this.closeError;
  }

  /** Calls of one kind. */
  of(name) {
    return this.calls.filter((c) => c[0] === name);
  }
  /** Input calls only -- what actually reached the "desktop". */
  get inputs() {
    return this.calls.filter((c) => ["click", "clickElement", "typeText", "pressKey"].includes(c[0]));
  }
}
